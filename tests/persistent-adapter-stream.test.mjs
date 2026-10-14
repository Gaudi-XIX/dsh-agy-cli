import assert from 'node:assert/strict'
import test from 'node:test'

import { AgyAdapter } from '../lib/provider/agy.js'

/**
 * Pins the two properties the persistent path was rewritten for:
 *   1. chunks are yielded while the worker is still running (a text delta
 *      arrives before `request()` resolves, so the host types it out instead
 *      of printing the whole turn at once), and
 *   2. the resume + MCP-bridge turn is allowed on the persistent transport at
 *      all — both gates used to force it back to one-shot, where closing
 *      stdin mid-stream makes AGY cancel its own response.
 */

const STEP = (step_update) => JSON.stringify({ event: 'step_update', step_update })

const NARRATION_A = STEP({
  conversation_id: 'conv-persistent-1',
  step_index: 3,
  state: 'DONE',
  step_type: 'agent_response',
  text_delta: 'first slice.',
  usage: { input_tokens: 100, output_tokens: 4 },
})

const NARRATION_B = STEP({
  conversation_id: 'conv-persistent-1',
  step_index: 4,
  state: 'DONE',
  step_type: 'agent_response',
  text_delta: ' second slice.',
  usage: { input_tokens: 100, output_tokens: 8 },
})

const MCP_DONE = STEP({
  conversation_id: 'conv-persistent-1',
  step_index: 5,
  state: 'DONE',
  step_type: 'tool',
  tool_name: 'call_mcp_tool',
  tool_info: {
    name: 'call_mcp_tool',
    parameters: { Arguments: { path: 'README.md' }, ServerName: 'dsh', ToolName: 'read' },
  },
})

const RESULT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-persistent-1',
    status: 'SUCCESS',
    response: 'first slice. second slice.',
    usage: { input_tokens: 120, output_tokens: 12 },
  },
})

const RESULT_EVENT = {
  event: 'result',
  result: {
    conversation_id: 'conv-persistent-1',
    status: 'SUCCESS',
    response: 'first slice. second slice.',
    usage: { input_tokens: 120, output_tokens: 12 },
  },
}

/**
 * A transport double that keeps the request pending so the adapter must yield
 * from the event callback. `release()` resolves it, which is what the worker
 * does when AGY prints its `result` line.
 */
function pendingTransport(lines, { capture } = {}) {
  const events = lines
    .map(line => JSON.parse(line))
    .filter(payload => payload.event === 'step_update' || payload.event === 'result')
  let release = () => {}
  let reject = () => {}
  const promise = new Promise((resolve, onError) => {
    release = resolve
    reject = onError
  })
  const transport = {
    request: input => {
      capture?.(input)
      // Deliver events on a later tick: the adapter must already be awaiting.
      queueMicrotask(() => {
        for (const payload of events) input.onEvent?.(payload)
        release({
          requestId: 'req-persistent-1',
          sessionId: input.sessionId,
          events,
          durationMs: 10,
          firstEventMs: 2,
        })
      })
      return promise
    },
  }
  return { transport, release, reject }
}

function neverResolvingTransport(capture) {
  return {
    transport: {
      request: input => {
        capture?.(input)
        return new Promise(() => {})
      },
    },
  }
}

function trustedDshContext() {
  const cwd = process.cwd()
  const sessions = new Map()
  const sessionFor = id => {
    if (!sessions.has(id)) sessions.set(id, { id, header: { id, cwd }, events: [] })
    return sessions.get(id)
  }
  const services = {
    sessions: { get: id => (id === undefined ? undefined : sessionFor(id)) },
    workspaceRegistry: {
      resolveByPath: async path => ({ path, sessionIds: [], status: async () => 'ok' }),
    },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }) },
    permissionPresets: { current: () => 'danger-full-access' },
    approval: { config: { policy: 'never' }, overrideOf: () => undefined },
  }
  return {
    get(name) {
      return services[name]
    },
    root: undefined,
  }
}

const liveBridge = () => ({
  active: true,
  inactiveReason: undefined,
  url: 'http://127.0.0.1:9/mcp',
  setSession: () => {},
})

const baseRequest = (extra = {}) => ({
  provider: 'agy',
  model: 'gemini-3.8-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
  sessionId: 'session-persistent-1',
  tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  ...extra,
})

async function collect(gen) {
  const chunks = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

const adapterFor = (transport, config = {}) => new AgyAdapter(
  {
    enabled: true,
    provider: 'agy',
    model: 'gemini-3.8-flash',
    toolPolicy: 'dsh-owned',
    sessionMode: 'resume',
    transport: 'persistent',
    imageInput: undefined,
    ...config,
  },
  {
    dshContext: trustedDshContext(),
    resolveToolBridge: () => liveBridge(),
    persistentTransport: transport,
  },
)

test('persistent dispatch streams text deltas before the turn resolves', async () => {
  let input
  let release
  const transport = {
    request: argument => {
      input = argument
      // Deliver every event *without* resolving the request: any chunk the
      // adapter yields from here can only come from the event callback, which
      // is exactly the streaming property under test. The queue buffers these
      // because the generator has not started consuming yet.
      argument.onEvent?.(JSON.parse(NARRATION_A))
      argument.onEvent?.(JSON.parse(NARRATION_B))
      return new Promise(resolve => {
        release = resolve
      })
    },
  }
  const adapter = adapterFor(transport)
  const gen = adapter.stream(baseRequest())

  // Exactly three pulls: block-start then two deltas. A fourth pull would
  // block on the still-open queue, which is the point — the turn has not
  // resolved yet.
  const deltas = []
  const early = []
  for (let pulls = 0; pulls < 3; pulls += 1) {
    const next = await gen.next()
    early.push(next.value?.type)
    if (next.value?.type === 'text-delta') deltas.push(next.value.text)
  }
  assert.deepEqual(deltas, ['first slice.', ' second slice.'])
  assert.deepEqual(early, ['block-start', 'text-delta', 'text-delta'])
  assert.equal(release === undefined, false, 'the turn is still in flight while deltas streamed')

  release({
    requestId: 'req-persistent-1',
    sessionId: 'session-persistent-1',
    events: [],
    durationMs: 10,
    firstEventMs: 2,
  })
  const rest = []
  for await (const chunk of gen) rest.push(chunk)

  const finish = rest.find(chunk => chunk.type === 'finish')
  assert.equal(finish?.reason.kind, 'stop', 'MCP-bridge turns finish as an ordinary stop')
  assert.equal(typeof input.text, 'string')
  assert.ok(input.text.length > 0, 'the serialized prompt is handed to the worker')
  assert.equal(typeof input.timeoutMs, 'number')
  assert.equal(typeof input.idleTimeoutMs, 'number')
  assert.ok(input.idleTimeoutMs <= input.timeoutMs, 'idle budget must be reachable under the wall clock')
  assert.equal(
    [...deltas, ...rest.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)].join(''),
    'first slice. second slice.',
  )
})

test('persistent dispatch turns a bridged MCP step into a real DSH tool call', async () => {
  const { transport } = pendingTransport([NARRATION_A, MCP_DONE, RESULT])
  const adapter = adapterFor(transport)
  const chunks = await collect(adapter.stream(baseRequest()))

  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].block.name, 'read', 'the real tool name is unwrapped from ToolName')
  assert.equal(typeof calls[0].block.arguments, 'string', 'arguments must be a JSON string')
  assert.deepEqual(JSON.parse(calls[0].block.arguments), { path: 'README.md' })
  assert.match(String(calls[0].block.id), /^agy-mcp-/)
  assert.equal(chunks.find(chunk => chunk.type === 'finish').reason.kind, 'stop')
})

test('resume with a live MCP bridge dispatches on the persistent transport', async () => {
  let used = 'none'
  const transport = {
    request: input => {
      used = 'persistent'
      input.onEvent?.(RESULT_EVENT)
      return Promise.resolve({
        requestId: 'req-persistent-1',
        sessionId: input.sessionId,
        events: [RESULT_EVENT],
        durationMs: 5,
        firstEventMs: 1,
      })
    },
  }
  const runnerCalls = []
  const adapter = new AgyAdapter(
    {
      enabled: true,
      provider: 'agy',
      model: 'gemini-3.8-flash',
      toolPolicy: 'dsh-owned',
      sessionMode: 'resume',
      transport: 'persistent',
    },
    {
      dshContext: trustedDshContext(),
      resolveToolBridge: () => liveBridge(),
      persistentTransport: transport,
      runAgyProcess: async () => {
        runnerCalls.push(1)
        return {
          exitCode: 0,
          signal: null,
          termination: 'completed',
          stdoutLines: [],
          stderr: '',
          durationMs: 1,
        }
      },
    },
  )
  await collect(adapter.stream(baseRequest()))
  assert.equal(used, 'persistent', 'the resume + bridge gate no longer forces one-shot')
  assert.deepEqual(runnerCalls, [], 'no one-shot process was spawned')
})

test('one-shot stays in force when the bridge is inactive', async () => {
  const { transport } = neverResolvingTransport(() => {})
  const runnerCalls = []
  const adapter = new AgyAdapter(
    {
      enabled: true,
      provider: 'agy',
      model: 'gemini-3.8-flash',
      toolPolicy: 'dsh-owned',
      sessionMode: 'resume',
      transport: 'persistent',
    },
    {
      dshContext: trustedDshContext(),
      resolveToolBridge: () => ({
        active: false,
        inactiveReason: 'no host webServer',
        setSession: () => {},
        url: undefined,
      }),
      persistentTransport: transport,
      runAgyProcess: async request => {
        runnerCalls.push(1)
        // The one-shot path consumes events through `onStdoutLine`, not the
        // resolved `stdoutLines`, so the double must push them the same way.
        for (const line of [
          JSON.stringify({ event: 'init', conversation_id: 'conv-one-shot' }),
          JSON.stringify({
            event: 'result',
            result: {
              conversation_id: 'conv-one-shot',
              status: 'SUCCESS',
              response: '{"kind":"message","content":"via one-shot"}',
              usage: { input_tokens: 10, output_tokens: 2 },
            },
          }),
        ]) request.onStdoutLine(line)
        return {
          exitCode: 0,
          signal: null,
          termination: 'completed',
          stdoutLines: [],
          stderr: '',
          durationMs: 1,
        }
      },
    },
  )
  const chunks = await collect(adapter.stream(baseRequest()))
  assert.deepEqual(runnerCalls, [1], 'without a bridge the prompt contract path still runs one-shot')
  assert.equal(
    chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
    'via one-shot',
  )
})
