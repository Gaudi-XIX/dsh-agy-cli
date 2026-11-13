import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgyModelDiscovery,
  mergeModelCatalog,
  parseAgyModels,
} from '../lib/agy/models.js'

function result(stdoutLines, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines,
    stderr: exitCode === 0 ? '' : 'discovery failed',
    durationMs: 1,
  }
}

test('parseAgyModels accepts tab-separated ids and ignores unsafe/duplicate rows', () => {
  assert.deepEqual(parseAgyModels([
    'gemini-3.7-flash-high\tGemini 3.7 Flash High',
    'gemini-3.7-flash-high\tDuplicate',
    'bad model\tInvalid',
    'id\tDisplay Name',
    'claude-sonnet-4-6',
    'unsafe\u0000label\tInvalid',
  ].join('\n')), [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'claude-sonnet-4-6' },
  ])
})

test('mergeModelCatalog preserves configured order and metadata precedence', () => {
  assert.deepEqual(mergeModelCatalog([
    { id: 'configured', name: 'Configured Name' },
    { id: 'fallback' },
  ], [
    { id: 'configured', name: 'AGY Name', description: 'AGY Description' },
    { id: 'discovered', name: 'Discovered Name' },
  ]), [
    { id: 'configured', name: 'Configured Name', description: 'AGY Description' },
    { id: 'fallback' },
    { id: 'discovered', name: 'Discovered Name' },
  ])
})

test('AgyModelDiscovery uses TTL cache and single-flight refreshes', async () => {
  let now = 0
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const discovery = new AgyModelDiscovery({
    ttlMs: 1_000,
    timeoutMs: 100,
    now: () => now,
    runCommand: async request => {
      calls += 1
      assert.deepEqual(request.args, ['models'])
      await gate
      return result(['gemini-live\tGemini Live'])
    },
  })

  const first = discovery.discover([{ id: 'configured' }])
  const second = discovery.discover([{ id: 'configured' }])
  assert.equal(calls, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.source, 'merged')
  assert.equal(secondResult.source, 'merged')

  const discoveredOnly = new AgyModelDiscovery({
    runCommand: async () => result(['gemini-live\tGemini Live']),
  })
  assert.equal((await discoveredOnly.discover([])).source, 'discovered')

  now = 500
  const cached = await discovery.discover([{ id: 'configured' }])
  assert.equal(cached.source, 'cache')
  assert.equal(calls, 1)
})

test('AgyModelDiscovery fails open to static catalog and stale cache', async () => {
  let now = 0
  let calls = 0
  const discovery = new AgyModelDiscovery({
    ttlMs: 100,
    timeoutMs: 100,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return calls === 1
        ? result(['gemini-live\tGemini Live'])
        : result([], 1)
    },
  })
  const configured = [{ id: 'configured' }]

  const discovered = await discovery.discover(configured)
  assert.equal(discovered.source, 'merged')
  now = 101
  const stale = await discovery.discover(configured)
  assert.equal(stale.source, 'cache')
  assert.equal(stale.stale, true)
  assert.equal(stale.warning, 'AGY model discovery command failed')
  assert.equal(stale.warningCode, 'MODEL_DISCOVERY_FAILED')
  assert.deepEqual(stale.models.map(model => model.id), ['configured', 'gemini-live'])

  const fallback = new AgyModelDiscovery({
    runCommand: async () => result([], 1),
  })
  const fallbackResult = await fallback.discover(configured)
  assert.equal(fallbackResult.source, 'fallback')
  assert.equal(fallbackResult.stale, true)
  assert.equal(fallbackResult.warningCode, 'MODEL_DISCOVERY_FAILED')
  assert.deepEqual(fallbackResult.models, configured)
})

test('AgyModelDiscovery exposes stable timeout and output-limit warning codes', async () => {
  const timeout = new AgyModelDiscovery({
    runCommand: async () => ({
      exitCode: null,
      signal: null,
      termination: 'timeout',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })
  const outputLimit = new AgyModelDiscovery({
    runCommand: async () => ({
      exitCode: null,
      signal: null,
      termination: 'output-limit',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })

  assert.equal((await timeout.discover([])).warningCode, 'MODEL_DISCOVERY_TIMEOUT')
  assert.equal((await outputLimit.discover([])).warningCode, 'MODEL_DISCOVERY_OUTPUT_LIMIT')
})

test('AgyModelDiscovery backs off across rounds instead of re-spawning every round', async () => {
  let now = 0
  let calls = 0
  const configured = [{ id: 'configured' }]
  const discovery = new AgyModelDiscovery({
    cooldownBaseMs: 30_000,
    cooldownMaxMs: 300_000,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return result([], 1)
    },
  })
  const codes = new Set()
  const sources = new Set()
  // Simulate 20 polling rounds five seconds apart: without a failure state
  // every one of them would spawn `agy models` again.
  for (let round = 0; round < 20; round += 1) {
    const snapshot = await discovery.discover(configured)
    assert.equal(snapshot.stale, true)
    codes.add(snapshot.warningCode)
    sources.add(snapshot.source)
    now += 5_000
  }
  assert.ok(calls < 20, 'expected bounded spawns, got ' + calls)
  assert.ok(calls <= 3, 'cooldown must cap respawns, got ' + calls)
  assert.deepEqual([...codes], ['MODEL_DISCOVERY_FAILED'])
  assert.ok([...sources].every(source => source === 'fallback' || source === 'cache'))
})

test('AgyModelDiscovery keeps the timeout mapping inside the negative-cache snapshot', async () => {
  let now = 0
  let calls = 0
  const discovery = new AgyModelDiscovery({
    cooldownBaseMs: 1_000,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return {
        exitCode: null,
        signal: null,
        termination: 'timeout',
        stdoutLines: [],
        stderr: '',
        durationMs: 1,
      }
    },
  })
  const configured = [{ id: 'static' }]
  const first = await discovery.discover(configured)
  assert.equal(first.warningCode, 'MODEL_DISCOVERY_TIMEOUT')
  assert.equal(first.stale, true)
  for (let round = 0; round < 5; round += 1) {
    now += 100
    const snapshot = await discovery.discover(configured)
    assert.equal(snapshot.warningCode, 'MODEL_DISCOVERY_TIMEOUT')
    assert.equal(snapshot.stale, true)
  }
  assert.equal(calls, 1, 'a timeout failure must be served from the negative cache')
})

test('AgyModelDiscovery negative cache expires with the cooldown, leaving no spawn gap', async () => {
  let now = 0
  let calls = 0
  const discovery = new AgyModelDiscovery({
    cooldownBaseMs: 1_000,
    negativeTtlMs: 50,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return result([], 1)
    },
  })
  const configured = [{ id: 'static' }]
  const first = await discovery.discover(configured)
  assert.equal(first.stale, true)
  assert.equal(calls, 1)
  now = 49
  assert.equal((await discovery.discover(configured)).source, 'fallback')
  assert.equal(calls, 1)
  now = 50
  await discovery.discover(configured)
  assert.equal(calls, 2, 'cooldown and snapshot TTL share one clock; no gap re-spawns early')
})

test('AgyModelDiscovery clears failure state after a success', async () => {
  let now = 0
  let calls = 0
  let mode = 'fail'
  const configured = [{ id: 'configured' }]
  const discovery = new AgyModelDiscovery({
    ttlMs: 1,
    cooldownBaseMs: 100,
    cooldownMaxMs: 800,
    now: () => now,
    runCommand: async () => {
      calls += 1
      return mode === 'fail' ? result([], 1) : result(['gemini-live\tGemini Live'])
    },
  })
  const first = await discovery.discover(configured)
  assert.equal(first.source, 'fallback')
  assert.equal(first.stale, true)
  assert.equal(calls, 1)

  now = 100
  mode = 'success'
  const recovered = await discovery.discover(configured)
  assert.equal(recovered.source, 'merged')
  assert.equal(recovered.stale, false)
  assert.equal(recovered.warningCode, undefined)
  assert.equal(calls, 2)
  assert.ok(recovered.models.some(model => model.id === 'gemini-live'))

  // A failure after recovery must restart at the base cooldown (100ms), not the
  // doubled 200ms: that is the proof consecutiveFailures was cleared.
  mode = 'fail'
  now = 101
  const failedAgain = await discovery.discover(configured)
  assert.equal(failedAgain.stale, true)
  assert.equal(calls, 3)
  now = 150
  await discovery.discover(configured)
  assert.equal(calls, 3, 'a fresh failure must start at the base cooldown')
  now = 201
  await discovery.discover(configured)
  assert.equal(calls, 4, 'base cooldown proves consecutiveFailures reset to 1')
})
