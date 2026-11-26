/**
 * Composite batch tools for AGY: `apply_edits` (multi-file, all-or-nothing
 * regex edits) and `read_slices` (multi-range line slices + heuristic outline).
 *
 * Pure logic module: Node built-ins plus a type-only import from ./protocol.js;
 * no imports from the parallel-line files (process.ts / errors.ts /
 * output-filter.ts / bridge.ts).
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { McpToolDescriptor } from './protocol.js'

type Eol = '\r\n' | '\n'

/** One edit: replace every match of `pattern` in `file` with `replacement`. */
export interface BatchEdit {
  readonly file: string
  readonly pattern: string
  readonly flags?: string
  readonly replacement: string
}

export interface ApplyEditsArgs {
  readonly edits: readonly BatchEdit[]
  /** Inline assertion against the in-memory result; non-empty string = failure. */
  readonly verify?: ReadonlyArray<{
    readonly file: string
    readonly mustContain?: string
    readonly mustNotContain?: string
  }>
}

export interface ApplyEditsResult {
  readonly files: readonly string[]
  readonly replacedCounts: Readonly<Record<string, number>>
  /** Files whose content was unchanged after all edits; nothing was written for them. */
  readonly isNoopFiles?: readonly string[] | undefined
}

export interface ReadSlicesArgs {
  readonly file: string
  /** 1-based, inclusive; start > end = empty slice; clamped to the file's line count. */
  readonly slices: ReadonlyArray<{ readonly start: number; readonly end: number }>
  readonly outline?: boolean
}

export interface ReadSlicesResult {
  readonly slices: ReadonlyArray<{ readonly start: number; readonly end: number; readonly text: string }>
  readonly outline?: ReadonlyArray<{ readonly line: number; readonly text: string }>
}

function fail(message: string): never {
  throw new Error(`apply_edits: ${message}`)
}

interface DecodedFile {
  /** Decoded text without the BOM. */
  readonly text: string
  /** BOM character to write back as a prefix, or '' when the file had none. */
  readonly bom: string
  /** Encoding used for the write-back. */
  readonly encoding: 'utf8' | 'utf16le'
}

function decodeFile(buf: Buffer, file: string): DecodedFile {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), bom: '\uFEFF', encoding: 'utf8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.toString('utf16le', 2), bom: '\uFEFF', encoding: 'utf16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf)
    swapped.swap16()
    return { text: swapped.toString('utf16le', 2), bom: '\uFEFF', encoding: 'utf16le' }
  }
  if (buf.includes(0)) fail(`looks like a binary file, skipping "${file}"`)
  return { text: buf.toString('utf8'), bom: '', encoding: 'utf8' }
}

/** Map each normalized (CRLF folded to LF) index to the original string index. */
function normalizeWithMap(s: string): { text: string; map: number[] } {
  const map: number[] = []
  let text = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\r' && s[i + 1] === '\n') {
      map.push(i)
      text += '\n'
      i++
      continue
    }
    map.push(i)
    text += s[i]
  }
  map.push(s.length)
  return { text, map }
}

function countTerminators(region: string): { crlf: number; lf: number } {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < region.length; i++) {
    if (region[i] === '\r' && region[i + 1] === '\n') {
      crlf++
      i++
    } else if (region[i] === '\n') {
      lf++
    }
  }
  return { crlf, lf }
}

function majorityEol(region: string): Eol | null {
  const { crlf, lf } = countTerminators(region)
  if (crlf === 0 && lf === 0) return null
  if (crlf === lf) return null
  return crlf > lf ? '\r\n' : '\n'
}

/** EOL of the line containing `pos`; falls back to the previous line, then `fallback`. */
function lineEol(s: string, pos: number, fallback: Eol): Eol {
  const next = s.indexOf('\n', pos)
  if (next !== -1) return next > 0 && s[next - 1] === '\r' ? '\r\n' : '\n'
  const prev = pos > 0 ? s.lastIndexOf('\n', pos - 1) : -1
  if (prev !== -1) return prev > 0 && s[prev - 1] === '\r' ? '\r\n' : '\n'
  return fallback
}

function fileFallbackEol(s: string): Eol {
  return majorityEol(s) ?? '\n'
}

/** EOL for a rewritten span: region majority, else the edited line, previous line, then the file. */
function spanEol(s: string, start: number, end: number, fallback: Eol): Eol {
  const lineStart = start > 0 ? s.lastIndexOf('\n', start - 1) + 1 : 0
  const lineEndRaw = s.indexOf('\n', end)
  const regionEnd = lineEndRaw === -1 ? s.length : lineEndRaw + 1
  return majorityEol(s.slice(lineStart, regionEnd)) ?? lineEol(s, start, fallback)
}

function convertEol(text: string, eol: Eol): string {
  return text.replace(/\r?\n/g, '\n').replace(/\n/g, eol)
}

/**
 * Transactional multi-file edit: read every file once, apply every edit in
 * memory, run optional verification, and only then write anything to disk.
 * Any failure (missing file, invalid regex, zero matches, failed verify)
 * throws before a single byte is written.
 *
 * Matching runs on a CRLF-normalized view, but only the matched spans are
 * rewritten back into the original string: every byte outside a match —
 * including mixed CRLF/LF line endings — is preserved. The EOL used inside a
 * rewritten span follows the file's own majority around the edit.
 */
export async function applyEdits(args: ApplyEditsArgs): Promise<ApplyEditsResult> {
  const edits = args?.edits ?? []
  if (!Array.isArray(edits) || edits.length === 0) fail('edits must be a non-empty array')

  // Deduplicate files, read each once (concurrently).
  const files: string[] = []
  for (const edit of edits) {
    if (typeof edit?.file !== 'string' || edit.file.length === 0) fail('every edit needs a file')
    if (!files.includes(edit.file)) files.push(edit.file)
  }
  const decoded = new Map<string, DecodedFile>()
  const originals = new Map<string, string>()
  await Promise.all(files.map(async (file) => {
    let buf: Buffer
    try {
      buf = await readFile(file)
    } catch (error) {
      fail(`cannot read "${file}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const data = decodeFile(buf, file)
    decoded.set(file, data)
    originals.set(file, data.text)
  }))

  // Apply every edit in memory, in order; edits for the same file chain.
  // Only matched spans are rewritten; everything else keeps its original bytes.
  const replacedCounts: Record<string, number> = {}
  for (const edit of edits) {
    const { file, pattern, replacement } = edit
    const flags = edit.flags ?? 'g'
    let regex: RegExp
    try {
      regex = new RegExp(pattern, flags)
    } catch (error) {
      fail(`invalid pattern "${pattern}" for "${file}": ${error instanceof Error ? error.message : String(error)}`)
    }
    const original = (decoded.get(file) as DecodedFile).text
    const { text: normalized, map } = normalizeWithMap(original)
    const fallback = fileFallbackEol(original)
    const localFlags = flags.replace('g', '')
    const perMatch = new RegExp(pattern, localFlags)

    let count = 0
    // Collect spans on the normalized view first, then splice right-to-left
    // on the original string so earlier offsets stay valid.
    const spans: Array<{ start: number; end: number; text: string }> = []
    const pushSpan = (match: RegExpExecArray): void => {
      const start = map[match.index]
      const end = map[match.index + match[0].length]
      if (start === undefined || end === undefined) return
      count++
      spans.push({
        start,
        end,
        text: convertEol(match[0].replace(perMatch, replacement), spanEol(original, start, end, fallback)),
      })
    }
    if (regex.global) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(normalized)) !== null) {
        pushSpan(match)
        if (match[0] === '') regex.lastIndex++
      }
    } else {
      const match = regex.exec(normalized)
      if (match !== null) pushSpan(match)
    }
    if (count === 0) fail(`pattern "${pattern}" matched 0 times in "${file}"`)
    let updated = original
    for (let i = spans.length - 1; i >= 0; i--) {
      const span = spans[i]
      if (span === undefined) continue
      updated = updated.slice(0, span.start) + span.text + updated.slice(span.end)
    }
    regex.lastIndex = 0
    decoded.set(file, { ...(decoded.get(file) as DecodedFile), text: updated })
    replacedCounts[file] = (replacedCounts[file] ?? 0) + count
  }

  // Optional inline verification against the in-memory result.
  for (const check of args.verify ?? []) {
    if (typeof check?.file !== 'string') fail('every verify entry needs a file')
    const content = decoded.get(check.file)
    if (content === undefined) fail(`verify targets "${check.file}" which no edit touches`)
    if (check.mustContain !== undefined && !content.text.includes(check.mustContain)) {
      fail(`verify failed for "${check.file}": mustContain "${check.mustContain}" not found`)
    }
    if (check.mustNotContain !== undefined && content.text.includes(check.mustNotContain)) {
      fail(`verify failed for "${check.file}": mustNotContain "${check.mustNotContain}" still present`)
    }
  }

  // All checks passed: write every file whose content actually changed; mark no-ops.
  const isNoopFiles: string[] = []
  await Promise.all(files.map((file) => {
    const data = decoded.get(file) as DecodedFile
    if (data.text === originals.get(file)) {
      isNoopFiles.push(file)
      return undefined
    }
    return writeFile(file, data.bom + data.text, data.encoding)
  }))
  return { files, replacedCounts, isNoopFiles: isNoopFiles.length > 0 ? Object.freeze(isNoopFiles) : undefined }
}

const OUTLINE_KEYWORDS = /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:class|function|def|interface|type|const)\b/

/**
 * Multi-range 1-based inclusive line slicing plus a heuristic outline: a line
 * is listed when its first non-space token chain is a declaration keyword, so
 * `import type { X }` and statements mentioning a keyword mid-line stay out.
 * No parser dependency.
 */
export async function readSlices(args: ReadSlicesArgs): Promise<ReadSlicesResult> {
  let raw: string
  try {
    raw = await readFile(args.file, 'utf8')
  } catch (error) {
    throw new Error(`read_slices: cannot read "${args.file}": ${error instanceof Error ? error.message : String(error)}`)
  }
  const lines = raw.split('\n')
  // A trailing newline is a terminator, not an extra line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const slices = (args.slices ?? []).map(({ start, end }) => {
    const s = Math.max(1, Math.min(start, total))
    const e = Math.max(s, Math.min(end, total))
    return { start, end, text: start > end ? '' : lines.slice(s - 1, e).join('\n') }
  })
  let outline: Array<{ line: number; text: string }> | undefined
  if (args.outline === true) {
    outline = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''
      if (OUTLINE_KEYWORDS.test(line)) outline.push({ line: i + 1, text: line.trim() })
    }
  }
  if (outline === undefined) return { slices }
  return { slices, outline }
}

function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties, additionalProperties: false }
}

const EDIT_ITEM_SCHEMA: Record<string, unknown> = objectSchema({
  file: { type: 'string', description: 'Path of the file to edit.' },
  pattern: { type: 'string', description: 'Regular expression source text.' },
  flags: { type: 'string', description: "RegExp flags; default 'g'." },
  replacement: { type: 'string', description: 'Replacement text.' },
})

const VERIFY_ITEM_SCHEMA: Record<string, unknown> = objectSchema({
  file: { type: 'string' },
  mustContain: { type: 'string' },
  mustNotContain: { type: 'string' },
})

export const BATCH_TOOL_DESCRIPTORS: readonly McpToolDescriptor[] = Object.freeze([
  {
    name: 'apply_edits',
    description: 'Apply multiple regex edits across files transactionally: all edits run in memory and files are written only if every edit and optional verify succeeds; any failure writes nothing.',
    inputSchema: objectSchema({
      edits: { type: 'array', items: EDIT_ITEM_SCHEMA, description: 'Edits applied in order; same-file edits chain in memory.' },
      verify: { type: 'array', items: VERIFY_ITEM_SCHEMA, description: 'Optional assertions checked against the in-memory result before writing.' },
    }),
  },
  {
    name: 'read_slices',
    description: 'Read one file as multiple 1-based inclusive line ranges in a single call, optionally with a heuristic outline of declaration lines.',
    inputSchema: objectSchema({
      file: { type: 'string', description: 'Path of the file to read.' },
      slices: {
        type: 'array',
        items: objectSchema({
          start: { type: 'number', description: 'First line (1-based, inclusive).' },
          end: { type: 'number', description: 'Last line (inclusive); start > end yields an empty slice.' },
        }),
        description: 'Line ranges; each is independent and may overlap.',
      },
      outline: { type: 'boolean', description: 'Also return a heuristic outline (class/function/def/interface/type/const lines).' },
    }),
  },
])

/** Single contract entry point used by the bridge layer. */
export async function dispatchBatchTool(name: string, args: unknown): Promise<unknown> {
  if (name === 'apply_edits') return applyEdits(args as ApplyEditsArgs)
  if (name === 'read_slices') return readSlices(args as ReadSlicesArgs)
  throw new Error(`unknown batch tool "${name}"`)
}
