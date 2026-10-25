import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.js'
import { isAgyReasoningEffort, type AgyReasoningEffort } from './process.js'

export interface AgyRuntimeOverrides {
  hiddenModels: string[]
  defaultEffort?: AgyReasoningEffort
  defaultModel?: string
}

const RUNTIME_OVERRIDES_PATH = join(dshHome(), 'agy-link', 'runtime-overrides.json')
// Indirection so tests (and the panel, if it ever runs in-process) can point the
// reader at a different location without touching the user's real file.
let _overridesPathOverride: string | undefined

// The panel and the generation path are two processes that must agree on the
// default effort, so both read this one file (the panel writes it, see
// src/web/router.ts). If the file is absent or unreadable the caller falls back
// to its built-in default.
export function readAgyRuntimeOverrides(): AgyRuntimeOverrides | undefined {
  const p = _overridesPathOverride ?? RUNTIME_OVERRIDES_PATH
  if (!existsSync(p)) return undefined
  let data: unknown
  try {
    data = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
  const record = data as Record<string, unknown> | null
  if (record === null || typeof record !== 'object') return undefined
  const hiddenModels = Array.isArray(record.hiddenModels)
    ? record.hiddenModels.filter((value): value is string => typeof value === 'string')
    : []
  const parsed: AgyRuntimeOverrides = { hiddenModels }
  if (isAgyReasoningEffort(record.defaultEffort)) parsed.defaultEffort = record.defaultEffort
  if (typeof record.defaultModel === 'string' && record.defaultModel !== '') parsed.defaultModel = record.defaultModel
  return parsed
}

// Write half of the same file. Preserves the keys the caller did not touch
// (the panel updates one field at a time; a plain overwrite would wipe
// sibling keys) and atomically-ish replaces the whole file so a reader never
// sees a half-written document. Effort is re-validated on write because the
// panel posts a raw string; an unknown value must not persist.
export function saveAgyRuntimeOverrides(
  updates: { hiddenModels?: string[]; defaultEffort?: string; defaultModel?: string },
): void {
  const p = _overridesPathOverride ?? RUNTIME_OVERRIDES_PATH
  const current = readAgyRuntimeOverrides() ?? { hiddenModels: [] }
  const merged: AgyRuntimeOverrides = { ...current }
  if (updates.hiddenModels !== undefined) merged.hiddenModels = updates.hiddenModels.filter((value): value is string => typeof value === 'string')
  if (updates.defaultEffort !== undefined) {
    if (isAgyReasoningEffort(updates.defaultEffort)) merged.defaultEffort = updates.defaultEffort
  }
  if (updates.defaultModel !== undefined) merged.defaultModel = updates.defaultModel
  const dir = dirname(p)
  mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(merged, null, 2) + '\n', 'utf8')
}

export function agyRuntimeOverridesPath(): string {
  return _overridesPathOverride ?? RUNTIME_OVERRIDES_PATH
}

/** Test-only: point the reader/writer at an alternate file. */
export function __setAgyOverridesPathForTest(path: string | undefined): void {
  _overridesPathOverride = path
}

export function agyRuntimeOverridesMtimeMs(): number | undefined {
  try {
    return statSync(RUNTIME_OVERRIDES_PATH).mtimeMs
  } catch {
    return undefined
  }
}
