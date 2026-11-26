import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { InMemorySessionStore, SessionRegistry } from '../lib/session/store.js'
import { FileSessionStore, MAX_SESSION_RECORDS, resolveSessionStorePath } from '../lib/session/file-store.js'

test('InMemorySessionStore creates detached records and supports deletion', () => {
  const store = new InMemorySessionStore()
  const record = store.set('session-a', 'conversation-a')
  assert.equal(record.conversationId, 'conversation-a')
  assert.deepEqual(store.get('session-a')?.conversationId, 'conversation-a')
  assert.equal(store.delete('session-a'), true)
  assert.equal(store.get('session-a'), undefined)
  assert.equal(store.delete('session-a'), false)
})

test('SessionRegistry serializes one session but permits different sessions concurrently', async () => {
  const registry = new SessionRegistry()
  const events = []
  const first = await registry.acquire('same')
  const waiting = registry.acquire('same').then(release => {
    events.push('second-acquired')
    release()
  })
  const other = await registry.acquire('other')
  events.push('other-acquired')
  other()
  assert.deepEqual(events, ['other-acquired'])
  first()
  await waiting
  assert.deepEqual(events, ['other-acquired', 'second-acquired'])
})

// The whole point of the durable store: `sessionMode: resume` must survive a
// host restart, otherwise every long session re-sends its full DSH history on
// the first turn after boot and gets pinned at the input limit.
test('FileSessionStore keeps the conversation binding across instances', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    new FileSessionStore({ path }).set('session-a', 'conversation-a')

    const reopened = new FileSessionStore({ path })
    assert.equal(reopened.get('session-a')?.conversationId, 'conversation-a')
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).sessions[0].sessionId, 'session-a')

    reopened.delete('session-a')
    assert.equal(new FileSessionStore({ path }).get('session-a'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A resumed turn needs the tail anchor the provider stored alongside the chain
// hash; if the record drops it on the way out the next compaction bootstraps a
// conversation that was already intact. Exercise the file round-trip directly.
test('FileSessionStore persists and restores the tail anchor of a fingerprint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    const fingerprint = {
      chainHash: 'a'.repeat(16),
      messageCount: 5,
      tailHashes: ['b'.repeat(16), 'c'.repeat(16), 'd'.repeat(16)],
    }
    new FileSessionStore({ path }).set('session-tail', 'conversation-tail', fingerprint)

    const reopened = new FileSessionStore({ path })
    assert.deepEqual(reopened.get('session-tail')?.tailHashes, fingerprint.tailHashes)
    assert.equal(reopened.get('session-tail')?.chainHash, fingerprint.chainHash)
    assert.equal(reopened.get('session-tail')?.messageCount, fingerprint.messageCount)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The read-back guard must reject a malformed tail: a non-array or a non-string
// element is not a usable anchor, so the record falls back to the pre-anchor
// shape instead of feeding the provider a poisoned comparison.
test('FileSessionStore drops a malformed tail hash while keeping the chain fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    writeFileSync(path, JSON.stringify({
      sessions: [
        {
          sessionId: 'session-bad',
          conversationId: 'conversation-bad',
          updatedAt: Date.now(),
          chainHash: 'a'.repeat(16),
          messageCount: 5,
          tailHashes: 'not-an-array',
        },
        {
          sessionId: 'session-mixed',
          conversationId: 'conversation-mixed',
          updatedAt: Date.now(),
          chainHash: 'e'.repeat(16),
          messageCount: 2,
          tailHashes: ['f'.repeat(16), 42],
        },
      ],
    }), 'utf8')

    const store = new FileSessionStore({ path })
    assert.equal(store.get('session-bad')?.tailHashes, undefined)
    assert.equal(store.get('session-bad')?.chainHash, 'a'.repeat(16))
    assert.equal(store.get('session-bad')?.messageCount, 5)
    assert.equal(store.get('session-mixed')?.tailHashes, undefined)
    assert.equal(store.get('session-mixed')?.chainHash, 'e'.repeat(16))
    assert.equal(store.get('session-mixed')?.messageCount, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore degrades to memory when the file is corrupt or unwritable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{ this is not json', 'utf8')
    const store = new FileSessionStore({ path: corrupt })
    // A broken map must not throw and must not lose a fresh binding.
    assert.equal(store.get('anything'), undefined)
    assert.equal(store.set('session-b', 'conversation-b').conversationId, 'conversation-b')

    // A path whose parent cannot hold a file: writes fail silently, reads work.
    const blockedPath = join(dir, 'corrupt.json', 'nested.json')
    const blocked = new FileSessionStore({ path: blockedPath })
    assert.equal(blocked.set('session-c', 'conversation-c').conversationId, 'conversation-c')
    assert.equal(blocked.get('session-c')?.conversationId, 'conversation-c')
    assert.equal(new FileSessionStore({ path: blockedPath }).get('session-c'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore prunes aged records on load and evicts past the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    let clock = 1_000
    const store = new FileSessionStore({ path, now: () => clock, maxAgeMs: 500 })
    store.set('old', 'conversation-old')
    clock = 2_000
    store.set('recent', 'conversation-recent')

    assert.equal(new FileSessionStore({ path, now: () => 2_000, maxAgeMs: 500 }).get('old'), undefined)
    assert.equal(new FileSessionStore({ path, now: () => 2_000, maxAgeMs: 500 }).get('recent')
      ?.conversationId, 'conversation-recent')

    const capped = new FileSessionStore({ path: join(dir, 'capped.json'), now: () => 5_000, maxRecords: 2 })
    capped.set('s1', 'c1')
    capped.set('s2', 'c2')
    capped.set('s3', 'c3')
    assert.deepEqual(capped.list().map(record => record.sessionId), ['s2', 's3'])
    assert.equal(MAX_SESSION_RECORDS, 2_000)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// markCancelled is update-only: it must keep the binding and the fingerprint,
// flag cancelled, and never resurrect a deliberately deleted record.
test('markCancelled keeps the conversation and fingerprint and flags the record', () => {
  const store = new InMemorySessionStore()
  const fingerprint = {
    chainHash: 'a'.repeat(16),
    messageCount: 7,
    tailHashes: ['b'.repeat(16), 'c'.repeat(16)],
  }
  store.set('session-a', 'conversation-a', fingerprint)

  assert.equal(store.markCancelled('session-a'), true)
  const record = store.get('session-a')
  assert.equal(record?.conversationId, 'conversation-a')
  assert.equal(record?.cancelled, true)
  assert.equal(record?.chainHash, fingerprint.chainHash)
  assert.equal(record?.messageCount, fingerprint.messageCount)
  assert.deepEqual(record?.tailHashes, fingerprint.tailHashes)

  // Update-only: an unknown id is a no-op, not a creation.
  assert.equal(store.markCancelled('missing'), false)
  assert.equal(store.get('missing'), undefined)

  // A passed-in fingerprint is rewritten alongside the flag.
  const next = { chainHash: 'e'.repeat(16), messageCount: 9 }
  store.markCancelled('session-a', next)
  const rewritten = store.get('session-a')
  assert.equal(rewritten?.chainHash, next.chainHash)
  assert.equal(rewritten?.messageCount, next.messageCount)
  assert.equal(rewritten?.cancelled, true)
})

test('FileSessionStore.markCancelled persists so a new instance reads the flag back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    const fingerprint = {
      chainHash: 'a'.repeat(16),
      messageCount: 5,
      tailHashes: ['b'.repeat(16), 'c'.repeat(16), 'd'.repeat(16)],
    }
    const store = new FileSessionStore({ path })
    store.set('session-cancel', 'conversation-cancel', fingerprint)
    assert.equal(store.markCancelled('session-cancel'), true)

    const reopened = new FileSessionStore({ path })
    const record = reopened.get('session-cancel')
    assert.equal(record?.cancelled, true)
    assert.equal(record?.conversationId, 'conversation-cancel')
    assert.equal(record?.chainHash, fingerprint.chainHash)
    assert.equal(record?.messageCount, fingerprint.messageCount)
    assert.deepEqual(record?.tailHashes, fingerprint.tailHashes)

    // parsePersisted only trusts an exact `true`; anything else stays absent.
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw.sessions[0].cancelled = false
    writeFileSync(path, JSON.stringify(raw), 'utf8')
    assert.equal(new FileSessionStore({ path }).get('session-cancel')?.cancelled, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSessionStorePath accepts a file, a directory, or the DSH default', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join('tmp-root', 'dsh')
    assert.equal(resolveSessionStorePath(join('x', 'map.json')), join('x', 'map.json'))
    assert.equal(resolveSessionStorePath('scratch'), join('scratch', 'sessions.json'))
    assert.equal(resolveSessionStorePath(undefined), join('tmp-root', 'dsh', 'agy-cli', 'sessions.json'))
    assert.equal(resolveSessionStorePath('   '), join('tmp-root', 'dsh', 'agy-cli', 'sessions.json'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('SessionRegistry reads through a FileSessionStore so resume survives restarts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-session-store-'))
  try {
    const path = join(dir, 'sessions.json')
    const before = new SessionRegistry(new FileSessionStore({ path }))
    before.set('session-d', 'conversation-d')
    const after = new SessionRegistry(new FileSessionStore({ path }))
    assert.equal(after.get('session-d')?.conversationId, 'conversation-d')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
