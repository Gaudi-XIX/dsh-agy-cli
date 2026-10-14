import assert from 'node:assert/strict'
import test from 'node:test'

import { AgyAdapter } from '../lib/provider/agy.js'
import { DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES } from '../lib/provider/prompt-budget.js'

/**
 * Drive the adapter with a scripted AGY stream. The runner seam lets us assert
 * what the adapter *emits* without spawning a process, which is the only way to
 * pin the two behaviours the MCP bridge changes:
 *   1. live text deltas are no longer suppressed, and
 *   2. every bridged tool step becomes a real DSH tool call.
 */
function scriptedRunner(lines, { exitCode = 0 } = {}) {
  return async request => {
    for (const line of lines) request.onStdoutLine(line)
    return {
      exitCode,
      signal: null,
      termination: exitCode === 0 ? 'completed' : 'non-zero',
      stdoutLines: lines,
      stderr: exitCode === 0 ? '' : 'simulated failure',
      durationMs: 5,
    }
  }
}

const INIT = JSON.stringify({
  event: 'init',
  conversation_id: 'conv-mcp-1',
  tools: ['call_mcp_tool'],
})

const MCP_CALL_ACTIVE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-mcp-1',
    step_index: 4,
    state: 'ACTIVE',
    step_type: 'tool',
    tool_name: 'call_mcp_tool',
    tool_info: {
      name: 'call_mcp_tool',
      parameters: {
        Arguments: { path: 'README.md' },
        ServerName: 'dsh',
        ToolName: 'read',
      },
    },
  },
})

const MCP_CALL_DONE = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-mcp-1',
    step_index: 4,
    state: 'DONE',
    step_type: 'tool',
    tool_name: 'call_mcp_tool',
    duration_seconds: 0.2,
    tool_info: {
      name: 'call_mcp_tool',
      parameters: {
        Arguments: { path: 'README.md' },
        ServerName: 'dsh',
        ToolName: 'read',
      },
    },
  },
})

const NARRATION = JSON.stringify({
  event: 'step_update',
  step_update: {
    conversation_id: 'conv-mcp-1',
    step_index: 7,
    state: 'DONE',
    step_type: 'agent_response',
    text_delta: 'Reading the file now.',
    usage: { input_tokens: 100, output_tokens: 8 },
  },
})

const RESULT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-mcp-1',
    status: 'SUCCESS',
    response: 'Reading the file now. Done.',
    usage: { input_tokens: 120, output_tokens: 12 },
  },
})

/** Minimal trusted DSH capability context, mirroring the provider suite. */
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
    sandboxPolicy: {
      resolve: () => ({ mode: 'danger-full-access', workspaceRoot: cwd }),
    },
    permissionPresets: {
      current: () => 'danger-full-access',
    },
    approval: {
      config: { policy: 'never' },
      overrideOf: () => undefined,
    },
  }
  return {
    get(name) {
      return services[name]
    },
    root: undefined,
  }
}

/** A bridge handle that is live and records the session it was pointed at. */
function liveBridge() {
  const seen = []
  return {
    seen,
    handle: {
      active: true,
      inactiveReason: undefined,
      url: 'http://127.0.0.1:9/mcp',
      setSession: sessionId => { seen.push(sessionId) },
    },
  }
}

function adapterOptions(runner, extra = {}) {
  return {
    runAgyProcess: runner,
    resolveToolBridge: () => undefined,
    dshContext: trustedDshContext(),
    ...extra,
  }
}

test('bridge mode streams narration deltas instead of swallowing them', async () => {
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(scriptedRunner([INIT, NARRATION, RESULT]), {
      resolveToolBridge: () => handle,
    }),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  const deltas = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text)
  assert.ok(deltas.length > 0, 'at least one text delta reached the caller')
  assert.equal(deltas.join(''), 'Reading the file now. Done.')
})

test('bridge mode turns each MCP step into a real DSH tool call', async () => {
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(scriptedRunner([INIT, MCP_CALL_ACTIVE, MCP_CALL_DONE, RESULT]), {
      resolveToolBridge: () => handle,
    }),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(calls.length, 1, 'exactly one tool call is emitted for the completed step')
  assert.equal(calls[0].block.name, 'read', 'the real tool name is unwrapped from ToolName')
  // The content-block contract types `arguments` as a JSON string, and the
  // session format validator compares the advertised block against the later
  // tool/call event by reference — an object here is rejected at restore time.
  assert.equal(typeof calls[0].block.arguments, 'string', 'arguments must be a JSON string')
  assert.deepEqual(JSON.parse(calls[0].block.arguments), { path: 'README.md' })
  assert.match(String(calls[0].block.id), /^agy-mcp-/)

  // The host already executed the call through the bridge, so the emitted
  // block is informational and the turn finishes as an ordinary stop.
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('bridge mode points the bridge at the DSH session before the turn runs', async () => {
  const bridge = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(scriptedRunner([INIT, RESULT]), { resolveToolBridge: () => bridge.handle }),
  )

  for await (const _chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: 'session-xyz',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) { /* drain */ }

  assert.deepEqual(bridge.seen, ['session-xyz'])
})

test('an inactive bridge falls back to the prompt contract instead of failing', async () => {
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(scriptedRunner([
      INIT,
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-mcp-1',
          status: 'SUCCESS',
          response: '{"kind":"message","content":"no bridge"}',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
    ]), {
      resolveToolBridge: () => ({
        active: false,
        inactiveReason: 'webServer missing',
        url: undefined,
        setSession: () => {},
      }),
    }),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'no bridge')
})

/**
 * AGY sometimes finishes a bridged turn with no `agent_response` step at all:
 * the whole turn goes into MCP tool steps and `result.response` carries either
 * the answer or the empty string. Neither case may surface as EMPTY_RESPONSE —
 * the tool call is the turn's real output.
 */
const RESULT_WITHOUT_STREAMED_TEXT = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-mcp-1',
    status: 'SUCCESS',
    response: 'Read README.md and found the deployment notes.',
    usage: { input_tokens: 120, output_tokens: 12 },
  },
})

const RESULT_EMPTY_RESPONSE = JSON.stringify({
  event: 'result',
  result: {
    conversation_id: 'conv-mcp-1',
    status: 'SUCCESS',
    response: '',
    usage: { input_tokens: 120, output_tokens: 12 },
  },
})

test('bridge mode recovers a final response that never streamed as a delta', async () => {
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(
      scriptedRunner([INIT, MCP_CALL_ACTIVE, MCP_CALL_DONE, RESULT_WITHOUT_STREAMED_TEXT]),
      { resolveToolBridge: () => handle },
    ),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'Read README.md and found the deployment notes.')
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('bridge mode reports a turn that only made tool calls instead of failing empty', async () => {
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(
      scriptedRunner([INIT, MCP_CALL_ACTIVE, MCP_CALL_DONE, RESULT_EMPTY_RESPONSE]),
      { resolveToolBridge: () => handle },
    ),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(calls.length, 1)
  // AGY narrated nothing this turn, so the tool-call block is the whole record.
  // The turn must still close instead of throwing EMPTY_RESPONSE: the tool calls
  // already ran, and retrying would repeat them. It must NOT emit an empty text
  // block either — that lands in the transcript as a blank assistant message,
  // and the host refuses to `session/follow` a session holding one.
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, '')
  const textBlock = chunks.find(chunk => chunk.type === 'block-end' && chunk.block?.type === 'text')
  assert.equal(textBlock, undefined)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
})

test('bridge mode still rejects an oversized user message instead of clipping it', async () => {
  // 2026-10-14: the oversized-section clamp is allowed ONLY for requests with no
  // tool catalog (side channels: session title, compaction, auto-review). A
  // bridge-mode main turn ships tools while the schemas leave the prompt, so
  // `toolProtocol === undefined` alone would misclassify it as a side channel and
  // silently clip the start of the user's message. `toolSchemaCount` is what
  // keeps it strict.
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash' },
    adapterOptions(scriptedRunner([INIT, RESULT]), {
      resolveToolBridge: () => handle,
    }),
  )

  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        provider: 'agy',
        model: 'gemini-3.8-flash',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'x'.repeat(DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES + 8_000) }],
        }],
        sessionId: 'session-1',
        tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
      })) {}
    })(),
    error => error?.code === 'AGY_INPUT_TOO_LARGE',
  )
})

test('mcpBridge:false keeps the prompt-contract path even with a live bridge', async () => {
  const { handle } = liveBridge()
  const adapter = new AgyAdapter(
    { enabled: true, toolPolicy: 'dsh-owned', model: 'gemini-3.8-flash', mcpBridge: false },
    adapterOptions(scriptedRunner([
      INIT,
      JSON.stringify({
        event: 'result',
        result: {
          conversation_id: 'conv-mcp-1',
          status: 'SUCCESS',
          response: '{"kind":"message","content":"contract path"}',
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      }),
    ]), {
      resolveToolBridge: () => handle,
    }),
  )

  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'agy',
    model: 'gemini-3.8-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
    sessionId: 'session-1',
    tools: [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
  })) chunks.push(chunk)

  // The bridge is never consulted, and the turn resolves through the
  // structured envelope rather than through bridged tool steps.
  assert.deepEqual(handle.seen ?? [], [])
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  assert.equal(text, 'contract path')
  const calls = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  assert.equal(calls.length, 0)
})
