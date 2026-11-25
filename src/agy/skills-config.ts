/**
 * Idempotent bootstrap for AGY's user-global skills entry point.
 *
 * AGY discovers user skills from `~/.gemini/config/skills.json`. This module
 * makes sure that file exists and contains one entry pointing at
 * `~/.agents/skills`, without ever discarding configuration the user already
 * has. It is intentionally dependency-free (only node builtins) and returns a
 * warning string instead of throwing so the caller can log and continue.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The literal entry AGY needs to see DSH's user-level skills directory. */
const ENTRY_PATH = '~/.agents/skills'

/** Narrow an unknown JSON value to a plain object (no arrays, no null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Canonicalize a skills.json `path` for equality comparison.
 *
 * Only `~/` (home-relative) and absolute paths are considered equivalent to
 * the bootstrap target; repository-relative paths are deliberately ignored so
 * a same-named directory in some other root cannot suppress the global entry.
 * Windows separators and trailing slashes are normalized first, then the path
 * is resolved to collapse `.`/`..` segments. On win32 the result is lowercased
 * because drive letters and directory names are case-insensitive there.
 */
function normalizeSkillPath(raw: unknown, homeDir: string): string | undefined {
  if (typeof raw !== 'string') return undefined
  let path = raw.trim()
  if (path === '') return undefined
  // Both doubled and single backslashes occur in hand-edited Windows configs.
  path = path.replaceAll('\\\\', '/').replaceAll('\\', '/')
  while (path.endsWith('/') && path !== '/' && path !== '~/') {
    path = path.slice(0, -1)
  }
  let expanded: string
  if (path.startsWith('~/')) {
    expanded = join(homeDir, path.slice(2))
  } else if (path.startsWith('/')) {
    expanded = path
  } else {
    return undefined
  }
  expanded = resolve(expanded)
  return process.platform === 'win32' ? expanded.toLowerCase() : expanded
}

/**
 * Ensure `~/.gemini/config/skills.json` contains the DSH user-skills entry.
 *
 * Returns `undefined` on success (file created, entry appended, or already
 * present) and a non-empty error string when the config could not be read,
 * parsed, or written. A config that already includes the target entry is left
 * byte-for-byte untouched: no reordering, reformatting, or overwriting of the
 * user's `inherits`/`entries` fields. On any failure the function only reports
 * the error; the caller is expected to warn and carry on.
 */
export function ensureAgyGlobalSkills(options: { homeDir?: string } = {}): string | undefined {
  const homeDir = options.homeDir ?? homedir()
  const target = join(homeDir, '.gemini', 'config', 'skills.json')
  let temporary: string | undefined
  try {
    let current: Record<string, unknown> = {}
    let text: string | undefined
    try {
      text = readFileSync(target, 'utf8')
    } catch (error) {
      // A missing file is the normal first-run case; start from an empty object.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        text = undefined
      } else {
        throw error
      }
    }

    if (text !== undefined) {
      const parsed: unknown = JSON.parse(text)
      if (!isRecord(parsed)) {
        return 'skills.json root is not an object'
      }
      const entries: unknown = parsed['entries']
      if (!Array.isArray(entries)) {
        return 'skills.json entries is not an array'
      }
      const targetPath = normalizeSkillPath(ENTRY_PATH, homeDir)
      const hasEntry = entries.some((entry: unknown) => isRecord(entry)
        && normalizeSkillPath(entry['path'], homeDir) === targetPath)
      if (hasEntry) return undefined
      current = parsed
    }

    const previous: unknown = current['entries'] ?? []
    const entries = Array.isArray(previous) ? previous : []
    const next: Record<string, unknown> = {
      ...current,
      entries: [...entries, { path: ENTRY_PATH }],
    }

    mkdirSync(dirname(target), { recursive: true })
    temporary = `${target}.tmp-${process.pid}-${Date.now().toString(36)}`
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temporary, target)
    return undefined
  } catch (error) {
    // Cleanup is best-effort; never let it mask the original failure.
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Nothing to clean up, or the cleanup itself failed.
      }
    }
    return error instanceof Error ? error.message : String(error)
  }
}
