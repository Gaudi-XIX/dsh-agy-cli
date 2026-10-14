import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import type { SessionRecord, SessionStore } from './store.js'

/**
 * How many conversation bindings to keep. Each DSH session leaves one AGY
 * conversation database on disk, so the map must not grow without bound; past
 * this cap the oldest-touched records are dropped and those sessions fall back
 * to the full DSH history on their next turn.
 */
export const MAX_SESSION_RECORDS = 2_000

export interface FileSessionStoreOptions {
  readonly path: string
  /** Injectable for tests; production uses `Date.now`. */
  readonly now?: () => number
  /** Records older than this are dropped on load. Default 30 days. */
  readonly maxAgeMs?: number
  /** Injectable cap; production uses `MAX_SESSION_RECORDS`. */
  readonly maxRecords?: number
}

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface PersistedRecord {
  readonly sessionId: string
  readonly conversationId: string
  readonly updatedAt: number
}

function resolveDshHome(): string {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/** Default location for the durable `sessionId -> AGY conversationId` map. */
export function defaultSessionStorePath(): string {
  return join(resolveDshHome(), 'agy-provider', 'sessions.json')
}

/**
 * The default on-disk location is used verbatim; anything else is taken as a
 * directory so a test or a profile can point the store at a scratch folder.
 */
export function resolveSessionStorePath(configured: string | undefined): string {
  const trimmed = configured?.trim()
  if (trimmed === undefined || trimmed.length === 0) return defaultSessionStorePath()
  return trimmed.toLowerCase().endsWith('.json') ? trimmed : join(trimmed, 'sessions.json')
}

function isRecord(value: unknown): value is PersistedRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.sessionId === 'string'
    && record.sessionId.length > 0
    && typeof record.conversationId === 'string'
    && record.conversationId.length > 0
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt)
}

function parsePersisted(text: string): Map<string, SessionRecord> {
  const records = new Map<string, SessionRecord>()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A truncated or hand-edited file must not break the provider: an empty map
    // means every session bootstraps from the full DSH history, which is the
    // behaviour before this store existed.
    return records
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? (parsed as { sessions: unknown[] }).sessions
      : []
  for (const entry of list) {
    if (!isRecord(entry)) continue
    records.set(entry.sessionId, {
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      updatedAt: entry.updatedAt,
    })
  }
  return records
}

/**
 * Durable `DSH sessionId -> AGY conversationId` map.
 *
 * The in-memory store was the reason a long conversation re-sent its entire
 * history: AGY keeps every conversation on disk (`--conversation <id>` resumes
 * across process boundaries, verified), but the mapping lived only in the
 * adapter. After a host restart the map was empty, so the first turn of every
 * pre-existing session went back to `requestMode: 'bootstrap'` and serialized
 * the whole DSH history into one prompt — pinned at the input limit, missing the
 * upstream prompt cache, and timing out on long sessions.
 *
 * Writes are best-effort and coalesced: a failed write only costs the binding,
 * and the next turn re-bootstraps that session. Reads never throw.
 */
export class FileSessionStore implements SessionStore {
  private readonly path: string
  private readonly now: () => number
  private readonly maxAgeMs: number
  private readonly maxRecords: number
  private records: Map<string, SessionRecord> | undefined
  private dirty = false

  constructor(options: FileSessionStoreOptions) {
    this.path = options.path
    this.now = options.now ?? Date.now
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.maxRecords = options.maxRecords ?? MAX_SESSION_RECORDS
  }

  private load(): Map<string, SessionRecord> {
    if (this.records !== undefined) return this.records
    let loaded = new Map<string, SessionRecord>()
    try {
      loaded = parsePersisted(readFileSync(this.path, 'utf8'))
    } catch {
      loaded = new Map()
    }
    // Drop bindings AGY itself may have pruned: an attempt against a stale id is
    // harmless (AGY starts a fresh conversation and the provider detects the id
    // mismatch and retries with the full history), but keeping dead ids wastes
    // the cap.
    const cutoff = this.now() - this.maxAgeMs
    for (const [key, record] of loaded) {
      if (record.updatedAt < cutoff) loaded.delete(key)
    }
    this.records = loaded
    return loaded
  }

  private persist(): void {
    if (!this.dirty) return
    const list = [...(this.records ?? []).values()]
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      // Temp file plus rename: a crash mid-write leaves the previous map intact.
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify({ sessions: list }, null, 2), 'utf8')
      renameSync(temporary, this.path)
      this.dirty = false
    } catch {
      // A read-only or unwritable location degrades to in-memory behaviour only.
      this.dirty = false
    }
  }

  get(sessionId: string): SessionRecord | undefined {
    const record = this.load().get(sessionId)
    return record === undefined ? undefined : { ...record }
  }

  set(sessionId: string, conversationId: string): SessionRecord {
    const records = this.load()
    const record: SessionRecord = { sessionId, conversationId, updatedAt: this.now() }
    records.set(sessionId, record)
    if (records.size > this.maxRecords) {
      const sorted = [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt)
      for (const stale of sorted.slice(0, records.size - this.maxRecords)) {
        records.delete(stale.sessionId)
      }
    }
    this.dirty = true
    this.persist()
    return { ...record }
  }

  delete(sessionId: string): boolean {
    const removed = this.load().delete(sessionId)
    if (removed) {
      this.dirty = true
      this.persist()
    }
    return removed
  }

  clear(): void {
    this.load().clear()
    this.dirty = true
    this.persist()
  }

  /** Test/diagnostic view of the in-memory projection. */
  list(): readonly SessionRecord[] {
    return [...this.load().values()]
  }
}
