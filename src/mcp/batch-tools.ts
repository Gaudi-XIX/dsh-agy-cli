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

/**
 * Transactional multi-file edit: read every file once, apply every edit in
 * memory, run optional verification, and only then write anything to disk.
 * Any failure (missing file, invalid regex, zero matches, failed verify)
 * throws before a single byte is written.
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
  const contents = new Map<string, string>()
  await Promise.all(files.map(async (file) => {
    try {
      contents.set(file, await readFile(file, 'utf8'))
    } catch (error) {
      fail(`cannot read "${file}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }))

  // Apply every edit in memory, in order; edits for the same file chain.
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
    const original = contents.get(file) as string
    let count = 0
    if (regex.global) {
      let match: RegExpExecArray | null
      while ((match = regex.exec(original)) !== null) {
        count++
        if (match[0] === '') regex.lastIndex++
      }
    } else if (regex.test(original)) {
      count = 1
      regex.lastIndex = 0
    }
    if (count === 0) fail(`pattern "${pattern}" matched 0 times in "${file}"`)
    const updated = original.replace(regex, replacement)
    regex.lastIndex = 0
    contents.set(file, updated)
    replacedCounts[file] = (replacedCounts[file] ?? 0) + count
  }

  // Optional inline verification against the in-memory result.
  for (const check of args.verify ?? []) {
    if (typeof check?.file !== 'string') fail('every verify entry needs a file')
    const content = contents.get(check.file)
    if (content === undefined) fail(`verify targets "${check.file}" which no edit touches`)
    if (check.mustContain !== undefined && !content.includes(check.mustContain)) {
      fail(`verify failed for "${check.file}": mustContain "${check.mustContain}" not found`)
    }
    if (check.mustNotContain !== undefined && content.includes(check.mustNotContain)) {
      fail(`verify failed for "${check.file}": mustNotContain "${check.mustNotContain}" still present`)
    }
  }

  // All checks passed: write every file.
  await Promise.all(files.map((file) => writeFile(file, contents.get(file) as string, 'utf8')))
  return { files, replacedCounts }
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
