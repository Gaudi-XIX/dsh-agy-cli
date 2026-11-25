/**
 * Regression coverage for the AGY global-skills bootstrap.
 *
 * Every case isolates HOME in a fresh temp directory so the real user config at
 * ~/.gemini/config/skills.json is never read or modified. The module under test
 * is imported from lib/ (built by `npm test` before node --test runs) because
 * the repository keeps TypeScript sources in src/ and compiles them to lib/.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureAgyGlobalSkills } from '../lib/agy/skills-config.js'

/** Each case gets its own throwaway home; finally removes it unconditionally. */
function withHome(body) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-agy-skills-'))
  try {
    return body(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** skills.json path below an isolated home. */
function skillsPath(home) {
  return join(home, '.gemini', 'config', 'skills.json')
}

/**
 * Mirror of the module's path normalization, used only to count how many
 * entries resolve to the bootstrap target. Kept local so the test does not
 * reach into a private export.
 */
function normalizedEntryPath(entry) {
  let path = String(entry?.path ?? '').trim().replace(/\\/g, '/')
  while (path.endsWith('/') && path !== '/' && path !== '~/') path = path.slice(0, -1)
  return path.startsWith('~/') ? path.slice(2) : path
}

test('creates skills.json with the single global entry when absent', () => {
  withHome(home => {
    const target = skillsPath(home)
    const warning = ensureAgyGlobalSkills({ homeDir: home })
    assert.equal(warning, undefined)

    const data = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(data.entries.length, 1)
    assert.equal(data.entries[0].path, '~/.agents/skills')
    assert.deepEqual(Object.keys(data), ['entries'])
  })
})

test('leaves an existing config byte-for-byte untouched when the entry is present', () => {
  withHome(home => {
    const target = skillsPath(home)
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    const original = '{"inherits":["~/other"],"entries":[{"path":"~/.agents/skills/"},{"path":"~/mine"}]}'
    writeFileSync(target, original, 'utf8')

    const warning = ensureAgyGlobalSkills({ homeDir: home })
    assert.equal(warning, undefined)
    assert.equal(readFileSync(target, 'utf8'), original)
  })
})

test('appends the entry while preserving inherits and existing entries', () => {
  withHome(home => {
    const target = skillsPath(home)
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    const original = { inherits: ['~/keep'], entries: [{ path: '~/other' }] }
    writeFileSync(target, JSON.stringify(original, null, 2), 'utf8')

    const warning = ensureAgyGlobalSkills({ homeDir: home })
    assert.equal(warning, undefined)

    const data = JSON.parse(readFileSync(target, 'utf8'))
    assert.deepEqual(data.inherits, ['~/keep'])
    assert.deepEqual(data.entries[0], { path: '~/other' })
    assert.equal(data.entries.length, 2)
    assert.deepEqual(data.entries[1], { path: '~/.agents/skills' })

    const hits = data.entries.filter(entry => normalizedEntryPath(entry) === '.agents/skills').length
    assert.equal(hits, 1)
  })
})

test('reports a write failure as a warning without throwing or replacing the path', () => {
  withHome(home => {
    const target = skillsPath(home)
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    // Making skills.json itself a directory makes readFileSync throw EISDIR.
    mkdirSync(target)

    let warning
    assert.doesNotThrow(() => { warning = ensureAgyGlobalSkills({ homeDir: home }) })
    assert.equal(typeof warning, 'string')
    assert.notEqual(warning, '')
    assert.equal(statSync(target).isDirectory(), true)
  })
})

test('returns a non-empty error string and keeps malformed JSON untouched', () => {
  withHome(home => {
    const target = skillsPath(home)
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true })
    const broken = '{oops'
    writeFileSync(target, broken, 'utf8')

    const warning = ensureAgyGlobalSkills({ homeDir: home })
    assert.equal(typeof warning, 'string')
    assert.notEqual(warning, '')
    assert.equal(readFileSync(target, 'utf8'), broken)
  })
})
