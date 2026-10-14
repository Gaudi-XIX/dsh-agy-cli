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

test('resolveSessionStorePath accepts a file, a directory, or the DSH default', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join('tmp-root', 'dsh')
    assert.equal(resolveSessionStorePath(join('x', 'map.json')), join('x', 'map.json'))
    assert.equal(resolveSessionStorePath('scratch'), join('scratch', 'sessions.json'))
    assert.equal(resolveSessionStorePath(undefined), join('tmp-root', 'dsh', 'agy-provider', 'sessions.json'))
    assert.equal(resolveSessionStorePath('   '), join('tmp-root', 'dsh', 'agy-provider', 'sessions.json'))
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
