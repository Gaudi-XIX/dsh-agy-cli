import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { AgyAdapter } from '../lib/provider/agy.js'
import { SessionRegistry } from '../lib/session/store.js'
import { FileSessionStore } from '../lib/session/file-store.js'
import { getAgyUserMessageByteLength } from '../lib/agy/stream-protocol.js'
import { DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES, DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES } from '../lib/provider/prompt-budget.js'

function result(exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines: [],
    stderr: exitCode === 0 ? '' : 'simulated failure',
    durationMs: 1,
  }
}

function modelDiscoveryResult(stdoutLines, exitCode = 0) {
  return {
    exitCode,
    signal: null,
    termination: exitCode === 0 ? 'completed' : 'non-zero',
    stdoutLines,
    stderr: exitCode === 0 ? '' : 'simulated discovery failure',
    durationMs: 1,
  }
}

function fakeRunner(events, captured) {
  return async request => {
    captured.push(request)
    for (const event of events) {
      await new Promise(resolve => setTimeout(resolve, 1))
      request.onStdoutLine?.(JSON.stringify(event))
    }
    return result()
  }
}

function trustedDshContext() {
  const cwd = process.cwd()
  const session = {
    id: 'session-1',
    header: { id: 'session-1', cwd },
    events: [],
  }
  const services = {
    sessions: { get: id => id === session.id ? session : undefined },
    workspaceRegistry: {
      resolveByPath: async path => ({
        path,
        sessionIds: [session.id],
        status: async () => 'ok',
      }),
    },
    sandboxPolicy: {
      resolve: ({ session: observed }) => {
        assert.equal(observed, session)
        return { mode: 'workspace-write', workspaceRoot: cwd }
      },
    },
    permissionPresets: {
      current: observed => {
        assert.equal(observed, session)
        return 'workspace-write'
      },
    },
    approval: {
      config: { policy: 'ask' },
      overrideOf: observed => {
        assert.equal(observed, session)
        return undefined
      },
    },
  }
  return {
    get(name) {
      return services[name]
    },
  }
}

const readFileTool = {
  name: 'read_file',
  description: 'Read one text file.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['path'],
    properties: {
      path: { type: 'string', minLength: 1 },
    },
  },
}

const pwshTool = {
  name: 'pwsh',
  description: 'Execute a PowerShell command.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['command', 'description'],
    properties: {
      command: { type: 'string', minLength: 1 },
      description: { type: 'string', minLength: 1, maxLength: 128 },
    },
  },
}

const request = {
  provider: 'agy-test',
  model: 'gemini-test',
  system: 'system prompt',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'reply 123' }] }],
}

test('AgyAdapter exposes the DSH default bounded retry policy', () => {
  const defaultAdapter = new AgyAdapter({})
  assert.deepEqual(defaultAdapter.providerRetryPolicy('agy-test'), {
    mode: 'normal',
    maxRetries: 5,
    retryableCodes: [
      'EMPTY_RESPONSE',
      'RATE_LIMIT',
      'SERVER',
      'TIMEOUT',
      'TRANSPORT',
      // Added 2026-10-13: AGY can die during its own startup eligibility check
      // (loadCodeAssist EOF through the local proxy) before it reads our stdin,
      // which is transient and worth one more attempt.
      'AGY_INPUT_FAILED',
      'AGY_SPAWN_FAILED',
    ],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0.1,
  })
  // A profile that still names a code which is no longer retryable must not make
  // the adapter throw; the stale entry is dropped instead.
  const staleAdapter = new AgyAdapter({
    retryPolicy: { maxRetries: 5, retryableCodes: ['TIMEOUT', 'AGY_INPUT_TOO_LARGE'] },
  })
  assert.deepEqual(staleAdapter.providerRetryPolicy('agy-test').retryableCodes, ['TIMEOUT'])

  const optInAdapter = new AgyAdapter({
    retryPolicy: { maxRetries: 5, retryableCodes: ['TIMEOUT'] },
  })
  assert.equal(optInAdapter.providerRetryPolicy('agy-test').maxRetries, 5)
  assert.deepEqual(optInAdapter.providerRetryPolicy('agy-test').retryableCodes, ['TIMEOUT'])
  assert.equal(defaultAdapter.providerInfo('agy-test').name, 'Antigravity CLI')
  assert.throws(() => new AgyAdapter({ inputFrameLimitBytes: 127 }), /inputFrameLimitBytes must be an integer/)
  assert.throws(() => new AgyAdapter({ toolProtocolRepairRetries: 2 }), /toolProtocolRepairRetries must be an integer/)
})

test('AgyAdapter maps AGY text deltas, final response, usage, and finish', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    agent: 'deepseek-proxy',
  }, {
    runAgyProcess: fakeRunner([
      { event: 'init', init: { agent: 'deepseek-proxy' } },
      { event: 'step_update', step_update: { text_delta: '12', usage: { totalTokens: 3 } } },
      { event: 'result', result: { status: 'SUCCESS', response: '123\n', usage: { totalTokens: 4 } } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream(request)) chunks.push(chunk)

  assert.deepEqual(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text), ['12', '3\n'])
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end')?.block, { type: 'text', text: '123\n' })
  // `step_update.usage` is the current physical turn; `result.usage` is
  // conversation-cumulative and must not be charged again.
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, { inputTokens: 3, outputTokens: 0 })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.match(captured[0].prompt, /=== SYSTEM ===[\s\S]+reply 123/)
  assert.equal(captured[0].agent, 'deepseek-proxy')
  assert.equal(captured[0].model, 'gemini-test')
})

test('AgyAdapter exposes and forwards the supported reasoning efforts', async () => {
  const captured = []
  const adapter = new AgyAdapter({ model: 'gemini-test' }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'reasoned' } },
    ], captured),
  })

  const resolved = await adapter.resolveModel('agy-test', 'gemini-test')
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  assert.deepEqual(resolved.reasoning?.efforts.map(effort => effort.description), [undefined, undefined, undefined])
  // gemini-* declares the same default the stream route applies, so the host materializes
  // 'high' and the UI stops falling back to efforts[0]='low'. (The 30s override TTL may
  // surface a user-picked panel default from ~/.dsh/agy-link/runtime-overrides.json here;
  // the built-in floor stays 'high' when the file is absent.)
  assert.equal(resolved.reasoning?.defaultEffort, 'high')

  const claudeResolved = await adapter.resolveModel('agy-test', 'claude-sonnet-test')
  assert.deepEqual(claudeResolved.reasoning?.efforts.map(effort => effort.id), ['low', 'medium', 'high'])
  // claude-* never receives --effort, so it must not advertise a default either.
  assert.equal(claudeResolved.reasoning?.defaultEffort, undefined)

  for await (const _chunk of adapter.stream({ ...request, reasoningEffort: 'high' })) {}
  assert.equal(captured[0]?.reasoningEffort, 'high')

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ ...request, reasoningEffort: 'turbo' })) {}
    },
    error => error.code === 'UNSUPPORTED_REASONING_EFFORT',
  )
  assert.equal(captured.length, 1)
})

test('AgyAdapter falls back to the panel default effort when nothing else chose one', async () => {
  // The panel's "default thinking strength" control writes ~/.dsh/agy-link/
  // runtime-overrides.json; the generation path must honor it as the last-resort
  // effort instead of the built-in 'high'.
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-effort-'))
  const fakePath = path.join(dir, 'runtime-overrides.json')
  fs.writeFileSync(fakePath, JSON.stringify({ defaultEffort: 'medium' }), 'utf8')

  // Point the reader at the temp file. The lib build inlines the path constant,
  // so we use the exported test hook to redirect the reader/writer to the temp dir.
  const overrides = await import('../lib/agy/overrides.js')
  const provider = await import('../lib/provider/agy.js')
  const originalCache = provider.__effortOverrideCacheForTest
  overrides.__setAgyOverridesPathForTest(fakePath)
  // The cache is an exported mutable record: poke its fields in place rather
  // than reassigning the frozen ESM binding.
  originalCache.at = 0
  originalCache.value = undefined
  try {
    const captured = []
    const adapter = new AgyAdapter({ model: 'gemini-test' }, {
      runAgyProcess: fakeRunner([
        { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
      ], captured),
    })
    // No explicit effort on the request and no suffix on the model id: the
    // last-resort default must be the panel-picked 'medium', not 'high'.
    for await (const _chunk of adapter.stream({ ...request })) {}
    assert.equal(captured[0]?.reasoningEffort, 'medium')
    const resolved = await adapter.resolveModel('agy-test', 'gemini-test')
    assert.equal(resolved.reasoning?.defaultEffort, 'medium')

    // An invalid or absent override must fall back to the built-in 'high'.
    fs.rmSync(fakePath, { force: true })
    originalCache.at = 0
    originalCache.value = undefined
    const captured2 = []
    const adapter2 = new AgyAdapter({ model: 'gemini-test' }, {
      runAgyProcess: fakeRunner([
        { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
      ], captured2),
    })
    for await (const _chunk of adapter2.stream({ ...request })) {}
    assert.equal(captured2[0]?.reasoningEffort, 'high')
  } finally {
    originalCache.at = 0
    originalCache.value = undefined
    overrides.__setAgyOverridesPathForTest(undefined)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AgyAdapter applies purpose routes only to matching auxiliary calls', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    agent: 'deepseek-proxy',
    purposeRoutes: {
      compaction: {
        model: 'gemini-3.7-flash-low',
        agent: 'deepseek-proxy',
        reasoningEffort: 'low',
      },
    },
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
    ], captured),
  })

  for await (const _chunk of adapter.stream({
    ...request,
    purpose: 'compaction',
  })) {}
  for await (const _chunk of adapter.stream(request)) {}

  assert.equal(captured[0]?.model, 'gemini-3.7-flash')
  assert.equal(captured[0]?.agent, 'deepseek-proxy')
  assert.equal(captured[0]?.reasoningEffort, 'low')
  assert.equal(captured[1]?.model, 'gemini-test')
  assert.equal(captured[1]?.agent, 'deepseek-proxy')
  assert.equal(captured[1]?.reasoningEffort, 'high')
})

test('AgyAdapter maps read-only and workspace-write presets to bounded AGY process options', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    agentPreset: 'read-only',
    workspaceRoot: process.cwd(),
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'read-only' } },
    ], captured),
  })

  for await (const _chunk of adapter.stream({ ...request, messages: [] , system: 'read' })) {}
  assert.equal(captured[0]?.agent, 'dsh-agy-read-only')
  assert.equal(captured[0]?.cwd, process.cwd())
  assert.deepEqual(captured[0]?.addDirs, [process.cwd()])
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.disableSlashCommands, true)

  const writeCaptured = []
  const writeAdapter = new AgyAdapter({
    model: 'gemini-test',
    agentPreset: 'workspace-write',
    workspaceRoot: process.cwd(),
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'written' } },
    ], writeCaptured),
  })
  for await (const _chunk of writeAdapter.stream({ ...request, messages: [] , system: 'write' })) {}
  assert.equal(writeCaptured[0]?.agent, 'dsh-agy-workspace-write')
  assert.equal(writeCaptured[0]?.mode, 'accept-edits')
  assert.equal(writeCaptured[0]?.disableSlashCommands, true)
})

test('AgyAdapter requires an explicit non-root workspace for workspace-write', () => {
  assert.throws(
    () => new AgyAdapter({ agentPreset: 'workspace-write' }),
    /workspaceRoot is required/,
  )
})

test('experimental image bridge stages AttachmentStore bytes, exposes a directory, and cleans up', async () => {
  const captured = []
  let observedImagePath
  let imageExistedDuringRequest = false
  const attachment = {
    attachmentId: 'attachment-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      observedImagePath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      imageExistedDuringRequest = observedImagePath !== undefined && existsSync(observedImagePath)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'pixel answer' },
      }))
      return result()
    },
  })

  for await (const _chunk of adapter.stream({
    ...request,
    system: 'Describe the image using view_file.',
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  })) {}

  assert.equal(imageExistedDuringRequest, true)
  assert.ok(observedImagePath)
  assert.equal(existsSync(observedImagePath), false)
  assert.equal(existsSync(dirname(observedImagePath)), false)
  assert.equal(captured[0]?.agent, 'dsh-agy-image-view')
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.addDirs.some(directory => directory === dirname(observedImagePath)), true)

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
})

test('a history-only image turn keeps the normal agent', async () => {
  const captured = []
  const attachment = {
    attachmentId: 'attachment-history-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'text answer' },
      }))
      return result()
    },
  })

  for await (const _chunk of adapter.stream({
    ...request,
    system: 'system prompt',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment }] },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      { role: 'user', content: [{ type: 'text', text: 'plain question' }] },
    ],
  })) {}

  assert.ok(captured.length > 0, 'one-shot request must be captured')
  assert.equal(captured[0]?.agent, 'dsh-agy-mcp-executor')
  assert.equal(captured[0]?.mode, undefined)
})

test('a history-only image turn routes through persistent transport', async () => {
  const oneShotCaptured = []
  const persistentCaptured = []
  const transport = {
    request: input => {
      persistentCaptured.push(input)
      input.onEvent?.({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })
      return Promise.resolve({
        requestId: 'req-history-persistent',
        sessionId: input.sessionId,
        events: [],
        durationMs: 10,
        firstEventMs: 2,
      })
    },
  }
  const attachment = {
    attachmentId: 'attachment-history-persistent',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
    transport: 'persistent',
  }, {
    persistentTransport: transport,
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'text answer' } },
    ], oneShotCaptured),
  })

  for await (const _chunk of adapter.stream({
    ...request,
    sessionId: 'session-history-persistent',
    messages: [
      { role: 'user', content: [{ type: 'image', attachment }] },
      { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
      { role: 'user', content: [{ type: 'text', text: 'plain question' }] },
    ],
  })) {}

  assert.equal(persistentCaptured.length, 1, 'a history-only image turn must stay on the persistent worker')
  assert.equal(oneShotCaptured.length, 0, 'a history-only image turn must not fall back to one-shot')
})

test('experimental image bridge narrowly permits staged view_file events with DSH-owned tools', async () => {
  let stagedPath
  const chunks = []
  const attachment = {
    attachmentId: 'attachment-tool-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    dshContext: trustedDshContext(),
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'view_file',
          state: 'ACTIVE',
          tool_input: { AbsolutePath: stagedPath },
        },
      }))
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'view_file', state: 'DONE' },
      }))
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"message","content":"pixel answer"}',
        },
      }))
      return result()
    },
  })

  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'pixel answer')
  assert.ok(stagedPath)
  assert.equal(existsSync(stagedPath), false)
})

test('experimental image bridge rejects view_file events outside the staged image set', async () => {
  const attachment = {
    attachmentId: 'attachment-tool-outside',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    imageInput: 'experimental',
  }, {
    dshContext: trustedDshContext(),
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      const stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      const outsidePath = resolve(dirname(stagedPath), '..', 'outside.png')
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'view_file',
          state: 'ACTIVE',
          tool_input: { AbsolutePath: outsidePath },
        },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
        messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
})

test('experimental image bridge fails without AttachmentStore and always cleans on runner failure', async () => {
  const attachment = {
    attachmentId: 'attachment-fixture',
    mediaType: 'image/png',
    bytes: 4,
    width: 1,
    height: 1,
  }
  const imageRequest = {
    ...request,
    messages: [{ role: 'user', content: [{ type: 'image', attachment }] }],
  }

  const unavailable = new AgyAdapter({ imageInput: 'experimental', agentPreset: 'read-only' }, {
    runAgyProcess: fakeRunner([], []),
  })
  await assert.rejects(
    async () => { for await (const _chunk of unavailable.stream(imageRequest)) {} },
    error => error.code === 'IMAGE_ATTACHMENT_UNAVAILABLE',
  )

  let stagedPath
  const failing = new AgyAdapter({ imageInput: 'experimental', agentPreset: 'read-only' }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: async requestValue => {
      stagedPath = requestValue.prompt.match(/\[IMAGE_ATTACHMENT file=(\S+) /)?.[1]
      assert.equal(existsSync(stagedPath), true)
      throw new Error('fake image transport failure')
    },
  })
  await assert.rejects(
    async () => { for await (const _chunk of failing.stream(imageRequest)) {} },
    error => error.code === 'AGY_REQUEST',
  )
  assert.ok(stagedPath)
  assert.equal(existsSync(dirname(stagedPath)), false)
})

test('experimental image bridge isolates an unverified custom Agent behind the bundled image viewer', async () => {
  const captured = []
  const adapter = new AgyAdapter({ imageInput: 'experimental', agent: 'deepseek-proxy' }, {
    attachmentStore: {
      readImage: async ref => ({ ref, data: new Uint8Array([137, 80, 78, 71]) }),
    },
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'pixel answer' } },
    ], captured),
  })
  for await (const _chunk of adapter.stream({
    ...request,
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        attachment: { attachmentId: 'custom-agent', mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
      }],
    }],
  })) {}
  assert.equal(captured[0]?.agent, 'dsh-agy-image-view')
  assert.equal(captured[0]?.mode, 'plan')
  assert.equal(captured[0]?.disableSlashCommands, true)
})

test('official DSH runtime validates reasoning effort before AGY spawn', async () => {
  const root = new Context()
  const captured = []
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-reasoning-runtime'], new AgyAdapter({ model: 'gemini-test' }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'reasoned' } },
    ], captured),
  }))

  for await (const _chunk of root.llm.stream({
    ...request,
    provider: 'agy-reasoning-runtime',
    reasoningEffort: 'medium',
    messages: [],
    system: 'reply',
  })) {}
  assert.equal(captured[0]?.reasoningEffort, 'medium')

  const invalidChunks = []
  for await (const chunk of root.llm.stream({
    ...request,
    provider: 'agy-reasoning-runtime',
    reasoningEffort: 'turbo',
    messages: [],
    system: 'reply',
  })) invalidChunks.push(chunk)
  const invalidFinish = invalidChunks.at(-1)
  assert.equal(invalidFinish?.type, 'finish')
  assert.equal(invalidFinish?.reason.kind, 'error')
  assert.equal(invalidFinish?.reason.failure.code, 'UNSUPPORTED_REASONING_EFFORT')
  assert.equal(captured.length, 1)
  await root.fiber.dispose()
})

test('AgyAdapter uses result.response when AGY emits no text delta', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '123' } },
    ], []),
  })
  const chunks = []
  for await (const chunk of adapter.stream({ ...request, messages: [] , system: 'reply' })) chunks.push(chunk)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
})

test('AgyAdapter advertises a deduplicated model catalog and resolves metadata', async () => {
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    modelDiscovery: 'off',
    models: [
      { id: 'gemini-flash', name: 'Flash', contextWindow: 1_000_000 },
      { id: 'gemini-flash', name: 'Duplicate' },
      { id: 'gemini-pro', description: 'Pro text model' },
    ],
  })

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models.map(model => model.id), ['gemini-flash', 'gemini-pro', 'gemini-default'])
  assert.equal(models[0]?.name, 'Flash')
  assert.equal(models[1]?.description, undefined)
  assert.deepEqual(models[0]?.inputModalities, ['text'])

  const resolved = await adapter.resolveModel('agy-test', 'gemini-flash')
  assert.equal(resolved.name, 'Flash')
  assert.deepEqual(resolved.context, { contextWindow: 1_000_000 })

  const resolvedWithDescription = await adapter.resolveModel('agy-test', 'gemini-pro')
  assert.equal(resolvedWithDescription.description, undefined)

  const unknown = await adapter.resolveModel('agy-test', 'gemini-not-in-catalog')
  assert.equal(unknown.id, 'gemini-not-in-catalog')
  assert.equal(unknown.name, 'gemini-not-in-catalog')
})

test('AgyAdapter merges quota-free AGY model discovery with static metadata', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-default',
    models: [{ id: 'gemini-static', name: 'Configured Static' }],
    modelDiscovery: 'auto',
  }, {
    runModelDiscovery: async requestValue => {
      captured.push(requestValue)
      return modelDiscoveryResult([
        'gemini-static\tAGY Static Label',
        'gemini-live\tGemini Live',
      ])
    },
  })

  const models = await adapter.listModels('agy-test')
  assert.deepEqual(models.map(model => model.id), ['gemini-static', 'gemini-default', 'gemini-live'])
  assert.equal(models[0]?.name, 'Configured Static')
  assert.equal(models[2]?.name, 'Gemini Live')
  assert.deepEqual(captured[0]?.args, ['models'])

  const resolved = await adapter.resolveModel('agy-test', 'gemini-live')
  assert.equal(resolved.name, 'Gemini Live')
  assert.equal(adapter.getModelDiscoveryStatus().source, 'merged')
})

test('AgyAdapter rejects DSH tools in the text-only MVP with actionable guidance', async () => {
  const adapter = new AgyAdapter({}, { runAgyProcess: fakeRunner([], []) })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        tools: [{ name: 'fixture', description: 'fixture', parameters: {} }],
      })) {}
    },
    error => error.code === 'UNSUPPORTED_TOOLS' && error.message.includes('toolPolicy: dsh-owned'),
  )
})

test('AgyAdapter bridges a validated DSH-owned tool call without exposing AGY tools', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    agent: 'must-be-overridden',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { text_delta: 'intermediate text must not leak' } },
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}',
          usage: { totalTokens: 17 },
        },
      },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    model: 'claude-sonnet-4-6',
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  // DSH-owned requests run under the MCP executor template: AGY's own tools are
  // removed there, so the DSH catalogue is the only way to act.
  assert.equal(captured[0]?.agent, 'dsh-agy-mcp-executor')
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'jsonSchemaPath'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'cwd'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'addDirs'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'mode'), false)
  assert.equal(JSON.stringify(captured[0] ?? {}).includes('dangerously-skip-permissions'), false)
  assert.match(captured[0]?.prompt ?? '', /=== DSH TOOL PROTOCOL V1 ===/)
  assert.match(captured[0]?.prompt ?? '', /read_file/)
  assert.match(captured[0]?.prompt ?? '', /DSH owns every tool execution/)
  assert.equal(chunks.some(chunk => chunk.type === 'text-delta'), false)
  const toolDelta = chunks.find(chunk => chunk.type === 'tool-call-delta')
  assert.equal(toolDelta?.name, 'read_file')
  assert.deepEqual(JSON.parse(toolDelta?.argumentsDelta ?? '{}'), { path: 'fixture.txt' })
  assert.deepEqual(chunks.find(chunk => chunk.type === 'block-end')?.block, {
    type: 'tool-call',
    id: toolDelta?.id,
    name: 'read_file',
    arguments: '{"path":"fixture.txt"}',
  })
  assert.deepEqual(chunks.find(chunk => chunk.type === 'usage')?.usage, {
    inputTokens: 17,
    outputTokens: 0,
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-calls' } })
})

test('AgyAdapter safely normalizes the observed pwsh description omission', async () => {
  const captured = []
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"pwsh","arguments":{"command":"adb devices"}}',
        },
      },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 1)
  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    {
      command: 'adb devices',
      description: 'Execute the requested PowerShell command',
    },
  )
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolCompatibilityApplied, 'pwsh-description-default')
  assert.equal(completed?.protocolRepairAttempts, 0)
})

test('AgyAdapter accepts a pwsh command with raw multiline JSON controls without a model retry', async () => {
  const logs = []
  const raw = `{"kind":"tool_call","name":"pwsh","arguments":{"command":"python
print(1)","description":"run multiline script"}}`
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'python\nprint(1)', description: 'run multiline script' },
  )
  assert.equal(logs.at(-1)?.protocolRepairAttempts, 0)
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'json-control-character-escape')
})

test('AgyAdapter canonicalizes the observed AGY call envelope without handing execution to AGY', async () => {
  const logs = []
  const raw = JSON.stringify({
    kind: 'call',
    call: {
      id: 'check-release-scripts',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'adb devices', description: 'probe devices' }),
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'adb devices', description: 'probe devices' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-call-envelope')
})

test('AgyAdapter canonicalizes the observed rationale command envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    rationale: 'Build all release APKs with Gradle.',
    command: {
      id: 'build-release-apks',
      name: 'pwsh',
      arguments: JSON.stringify({ command: 'gradlew assembleRelease', description: 'Build release APKs' }),
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'gradlew assembleRelease', description: 'Build release APKs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-command-envelope')
})

test('AgyAdapter canonicalizes the observed thought call envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    thought: 'Build all release variants.',
    call: {
      name: 'pwsh',
      arguments: { command: 'gradlew assembleRelease', description: 'Build release APKs' },
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'gradlew assembleRelease', description: 'Build release APKs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-thought-call-envelope')
})

test('AgyAdapter canonicalizes the observed bare call envelope', async () => {
  const logs = []
  const raw = JSON.stringify({
    call: {
      id: 'check-release-apks',
      name: 'pwsh',
      arguments: { command: 'Get-ChildItem -Path android/app/build/outputs/apk -Recurse -Filter "*.apk"', description: 'Check generated release APK outputs' },
    },
  })
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: raw } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    { command: 'Get-ChildItem -Path android/app/build/outputs/apk -Recurse -Filter "*.apk"', description: 'Check generated release APK outputs' },
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'agy-bare-call-envelope')
})

test('AgyAdapter repairs one DSH argument schema mismatch with bounded diagnostics', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0
            ? '{"kind":"tool_call","name":"read_file","arguments":{}}'
            : '{"kind":"message","content":"repaired"}',
        },
      }))
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /DSH TOOL PROTOCOL REPAIR/)
  assert.match(captured[1]?.prompt ?? '', /Missing required keys: \["path"\]/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'repaired')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
  assert.equal(completed?.protocolRepairReason, 'arguments-invalid')
  assert.equal(completed?.protocolToolName, 'read_file')
  assert.equal(completed?.protocolArgumentIssue, 'missing-required')
  assert.deepEqual(completed?.protocolMissingRequiredKeys, ['path'])
  assert.equal(JSON.stringify(logs).includes('fixture.txt'), false)
})

test('AgyAdapter serializes a DSH tool result into the next DSH-owned request', async () => {
  const captured = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0
            ? '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}'
            : '{"kind":"message","content":"tool result received"}',
        },
      }))
      return result()
    },
  })

  const firstChunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) firstChunks.push(chunk)
  const firstCall = firstChunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(firstCall?.type, 'tool-call')

  const secondChunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages: [
      request.messages[0],
      {
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: firstCall.id,
          name: firstCall.name,
          arguments: firstCall.arguments,
        }],
      },
      {
        role: 'tool',
        toolCallId: firstCall.id,
        content: [{ type: 'text', text: 'FIXTURE_PROBE_EXECUTED' }],
      },
    ],
    tools: [readFileTool],
  })) secondChunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /\[DSH TOOL RESULT\]/)
  assert.match(captured[1]?.prompt ?? '', /FIXTURE_PROBE_EXECUTED/)
  assert.equal(secondChunks.find(chunk => chunk.type === 'text-delta')?.text, 'tool result received')
})

test('AgyAdapter bounds oversized DSH tool results before sending AGY input', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    inputFrameLimitBytes: 16 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 8 * 1024,
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"bounded"}' } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages: [
      request.messages[0],
      {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"fixture.txt"}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: '😀'.repeat(20_000) }],
      },
    ],
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.ok(captured.length >= 1)
  assert.ok(getAgyUserMessageByteLength(captured[0].prompt) <= 16 * 1024)
  assert.match(captured[0].prompt, /\[DSH TOOL RESULT TRUNCATED\]/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'bounded')
})

test('AgyAdapter records safe history compaction telemetry and preserves the current request', async () => {
  const captured = []
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"compacted"}' } },
    ], captured),
  })

  const messages = [
    request.messages[0],
    ...Array.from({ length: 45 }, (_, index) => ({
      role: 'assistant',
      content: [{ type: 'text', text: `old-turn-${index}\n${'context '.repeat(900)}` }],
    })),
    {
      role: 'user',
      content: [{ type: 'text', text: 'CURRENT_PROVIDER_REQUEST_MUST_SURVIVE' }],
    },
  ]
  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages,
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'compacted')
  assert.equal(captured.length, 1)
  assert.ok(captured[0].prompt.length > 0)
  assert.match(captured[0].prompt, /CURRENT_PROVIDER_REQUEST_MUST_SURVIVE/)
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.historyCompacted, true)
  assert.ok((completed?.omittedMessageCount ?? 0) > 0)
  assert.equal(completed?.promptLimitBytes, DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES)
})

test('AgyAdapter rejects an oversized current DSH prompt before AGY can return an invalid envelope', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"should-not-run"}' } },
    ], captured),
  })

  await assert.rejects(
    (async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'x'.repeat(DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES + 8_000) }],
        }],
        tools: [readFileTool],
      })) {}
    })(),
    error => error?.code === 'AGY_INPUT_TOO_LARGE',
  )
  assert.equal(captured.length, 0)
})

// 2026-10-14: the session-title plugin sends a whole-conversation summary as
// one user section. When that single section exceeds the text-only budget,
// evicting history cannot help — the old behaviour threw AGY_INPUT_TOO_LARGE
// and the title simply never refreshed (two such failures in real telemetry).
// Side channels now clip the head of that section and still run.
test('AgyAdapter clamps one oversized section for a side-channel request instead of rejecting', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '会话标题', usage: { totalTokens: 4 } } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    purpose: 'session-title',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES + 8_000) }],
    }],
  })) chunks.push(chunk)

  assert.equal(captured.length, 1, 'side channel must still spawn AGY')
  const prompt = captured[0].prompt
  assert.match(prompt, /=== USER ===/)
  assert.match(prompt, /\[DSH OLDER CONTEXT CLIPPED FROM HEAD/)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES)
  assert.equal(
    chunks.find(chunk => chunk.type === 'block-end')?.block?.text,
    '会话标题',
  )
})

// A request that carries no tool catalog cannot be a user turn: DSH ships its
// tool list whenever the model is expected to act, and the MCP bridge still
// counts the schemas in `toolSchemaCount` even though they leave the prompt.
// So "no protocol AND zero schemas" is the discriminator — chosen over
// `purpose` because `@deepseek-ai/dsh-experimental-auto-review` builds its
// review request with no purpose field at all. The real main turn stays strict
// in both of its shapes: pinned by the protocol test above and by the
// bridge-mode test in mcp-adapter.test.mjs.
test('AgyAdapter clamps an oversized dump for a tool-less request', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '已审阅' } },
    ], captured),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'x'.repeat(DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES + 8_000) }],
    }],
  })) chunks.push(chunk)

  assert.equal(captured.length, 1, 'a tool-less dump must be clipped and still run, not rejected')
  assert.match(captured[0].prompt, /\[DSH OLDER CONTEXT CLIPPED FROM HEAD/)
  assert.equal(
    chunks.find(chunk => chunk.type === 'block-end')?.block?.text,
    '已审阅',
  )
})

// `sessionMode: 'resume'` ships the complete DSH history as one prompt, so once
// a conversation is long enough every turn overflowed. Dropping whole messages
// until the newest one fit produced a prompt pinned at exactly the limit; AGY
// then missed its upstream prompt cache on the next turn and re-read the whole
// conversation. The clip must (a) stay under the limit, (b) keep the newest
// message whole, and (c) repeat the same bytes for the same history, so the
// cached prefix survives.
test('AgyAdapter clips a resume-mode overflow at a message boundary and keeps it stable', async () => {
  const runs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    modelDiscovery: 'off',
    sessionMode: 'resume',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { totalTokens: 3 } } },
    ], runs),
  })

  // Every message is far below the limit, but the conversation as a whole is
  // not: this is the shape that used to be pinned at exactly the limit.
  const messages = []
  for (let index = 0; index < 24; index += 1) {
    messages.push({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message-${index} ` + 'y'.repeat(9_000) }],
    })
  }

  const captured = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages,
  })) captured.push(chunk)

  assert.equal(runs.length, 1, 'the clipped turn must still reach AGY')
  const prompt = runs[0].prompt
  assert.ok(
    Buffer.byteLength(prompt, 'utf8') <= DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES,
    'clipped prompt must stay inside the AGY input budget',
  )
  assert.ok(
    prompt.includes(messages[messages.length - 1].content[0].text),
    'the newest message must survive the clip whole',
  )
  assert.match(prompt, /\[DSH HISTORY COMPACTED/)
  assert.ok(
    !prompt.includes('message-0 '),
    'the oldest messages must be the ones that were dropped',
  )
  assert.ok(
    Buffer.byteLength(prompt, 'utf8') < DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES - 1_000,
    'the clip must not be pinned to the exact limit, or the prompt changes every turn',
  )

  // The same history must render the same bytes: this is what lets AGY's
  // upstream cache of the previous prefix hit.
  const second = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    messages,
  })) second.push(chunk)
  assert.equal(runs[1].prompt, prompt, 'an unchanged history must produce identical prompt bytes')
})

test('AgyAdapter repairs one non-JSON DSH-owned response and records the retry', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: invocation++ === 0 ? 'I will continue with the result.' : '{"kind":"message","content":"repaired"}',
        },
      }))
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /=== DSH TOOL PROTOCOL REPAIR ===/)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'repaired')
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
})

test('AgyAdapter can disable plain-text fallback after a failed protocol repair', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    toolProtocolPlainTextFallback: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'still not JSON' },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /DSH TOOL PROTOCOL REPAIR/)
})

test('AgyAdapter rejects plain Gemini text after a failed protocol repair by default', async () => {
  const captured = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
  }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'stale prose is not a DSH envelope' },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(captured.length, 2)
  assert.match(captured[1].prompt, /DSH TOOL PROTOCOL REPAIR/)
})

test('AgyAdapter records safe shape metadata for a malformed structured response', async () => {
  const logs = []
  const raw = '{"kind":"message","content":"unterminated'
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'dsh-owned',
    modelDiscovery: 'off',
    toolProtocolPlainTextFallback: 'off',
  }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: raw },
      }))
      return result()
    },
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )

  const failed = logs.at(-1)
  assert.equal(failed?.protocolRepairAttempts, 1)
  assert.equal(failed?.protocolFailureDetail, 'not-json')
  assert.equal(failed?.protocolResponseShape, 'object-like')
  assert.equal(failed?.protocolResponseBytes, Buffer.byteLength(raw, 'utf8'))
  assert.equal(JSON.stringify(logs).includes(raw), false)
})

test('AgyAdapter treats a plain Claude final response as a message without weakening tool calls', async () => {
  const adapter = new AgyAdapter({ model: 'claude-sonnet-4-6', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'claudeok' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    model: 'claude-sonnet-4-6',
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'claudeok')
  assert.equal(chunks.find(chunk => chunk.type === 'finish')?.reason.kind, 'stop')
})

test('AgyAdapter still rejects malformed JSON-looking Claude output', async () => {
  const adapter = new AgyAdapter({ model: 'claude-sonnet-4-6', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message"' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        model: 'claude-sonnet-4-6',
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter fails closed when DSH-owned AGY output is not exactly one valid envelope', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: '{"kind":"tool_call","name":"read_file","arguments":{"path":"fixture.txt"}}\nextra',
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter rejects duplicate AGY final responses in DSH-owned mode', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"one"}' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"two"}' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
})

test('AgyAdapter rejects an internal AGY tool event while DSH owns tools', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'shell' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'agy-internal-tool')
  assert.equal(logs.at(-1)?.toolEventKind, 'step-type-tool')
  assert.equal(logs.at(-1)?.toolEventStreamIndex, 2)
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic, {
    eventName: 'step_update',
    kind: 'step-type-tool',
    stepType: 'tool',
    toolName: 'shell',
    carrierShape: 'not-send-message',
    recipientClass: 'not-applicable',
    topLevelKeys: ['event', 'step_update'],
    stepKeys: ['step_type', 'tool_name'],
    toolInputKeys: [],
  })
})

test('AgyAdapter retries once after an AGY internal send_message event without executing it', async () => {
  const captured = []
  const logs = []
  let invocation = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: async requestValue => {
      captured.push(requestValue)
      const events = invocation++ === 0
        ? [
            { event: 'init', conversation_id: 'internal-wrapper-session' },
            {
              event: 'step_update',
              step_update: {
                step_type: 'tool',
                tool_name: 'send_message',
                tool_input: {
                  Recipient: JSON.stringify('dsh-outer'),
                  Message: JSON.stringify(JSON.stringify({ kind: 'message', content: 'not executable' })),
                },
              },
            },
          ]
        : [{ event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"recovered"}' } }]
      for (const event of events) {
        await new Promise(resolve => setTimeout(resolve, 1))
        requestValue.onStdoutLine?.(JSON.stringify(event))
      }
      return result()
    },
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(captured.length, 2)
  assert.match(captured[1]?.prompt ?? '', /AGY-internal tool event/)
  assert.match(captured[1]?.prompt ?? '', /do not call send_message/i)
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'recovered')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.protocolRepairAttempts, 1)
  assert.equal(completed?.protocolRepairReason, 'internal-tool-event')
  assert.equal(completed?.bridgeOutcome, 'dsh-message')
})

test('AgyAdapter ignores AGY manage_task orchestration lifecycle events while DSH owns tools', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'orchestration-session' },
      {
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'manage_task', state: 'ACTIVE' },
      },
      {
        event: 'step_update',
        step_update: { step_type: 'tool', tool_name: 'manage_task', state: 'DONE' },
      },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'done')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-message')
  assert.equal(logs.at(-1)?.toolEventCount, 2)
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.toolName, 'manage_task')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'not-send-message')
})

test('AgyAdapter bridges one validated default_api send_message carrier', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'tainted-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('default_api'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: JSON.stringify({ kind: 'message', content: 'late wrapper output' }) },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  const call = chunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(call?.type, 'tool-call')
  assert.equal(call?.name, 'read_file')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.toolEventStreamIndex, 2)
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'complete')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'default-api')
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic?.toolInputKeys, ['message', 'recipient'])
  assert.equal(logs.at(-1)?.carrierAbortExpected, true)
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(adapter.getSession('session-1'), undefined)
})

test('AgyAdapter bridges a validated send_message carrier addressed to the active AGY conversation', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          state: {
            tool_input: {
              Recipient: JSON.stringify('root-wrapper-session'),
              Message: JSON.stringify(JSON.stringify(envelope)),
            },
          },
        },
      },
      {
        event: 'result',
        result: { status: 'SUCCESS', response: JSON.stringify({ kind: 'message', content: 'late wrapper output' }) },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  const call = chunks.find(chunk => chunk.type === 'block-end')?.block
  assert.equal(call?.type, 'tool-call')
  assert.equal(call?.name, 'read_file')
  assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierAbortExpected, true)
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(adapter.getSession('session-1'), undefined)
})

test('AgyAdapter bridges validated send_message carriers addressed to stable DSH runtime recipients', async () => {
  for (const recipient of ['dsh', 'dsh-session', 'dsh-runner']) {
    const logs = []
    const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
    const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
      dshContext: trustedDshContext(),
      logger: record => logs.push(record),
      runAgyProcess: fakeRunner([
        { event: 'init', conversation_id: 'root-wrapper-session' },
        {
          event: 'step_update',
          step_update: {
            step_type: 'tool',
            tool_name: 'send_message',
            tool_input: {
              Recipient: JSON.stringify(recipient),
              Message: JSON.stringify(JSON.stringify(envelope)),
            },
          },
        },
      ], []),
    })

    const chunks = []
    for await (const chunk of adapter.stream({
      ...request,
      sessionId: 'session-1',
      tools: [readFileTool],
    })) chunks.push(chunk)

    const call = chunks.find(chunk => chunk.type === 'block-end')?.block
    assert.equal(call?.type, 'tool-call')
    assert.equal(call?.name, 'read_file')
    assert.equal(logs.at(-1)?.bridgeOutcome, 'dsh-tool-call')
    assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'dsh-recipient')
    assert.equal(logs.at(-1)?.carrierAbortExpected, true)
    assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  }
})

test('AgyAdapter applies pwsh compatibility to a validated send_message carrier', async () => {
  const logs = []
  const envelope = {
    kind: 'tool_call',
    name: 'pwsh',
    arguments: { command: 'adb devices' },
  }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'carrier-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('default_api'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [pwshTool],
  })) chunks.push(chunk)

  assert.deepEqual(
    JSON.parse(chunks.find(chunk => chunk.type === 'tool-call-delta')?.argumentsDelta ?? '{}'),
    {
      command: 'adb devices',
      description: 'Execute the requested PowerShell command',
    },
  )
  assert.equal(logs.at(-1)?.carrierValidation, 'valid-tool-call')
  assert.equal(logs.at(-1)?.protocolCompatibilityApplied, 'pwsh-description-default')
})

test('AgyAdapter rejects a valid carrier addressed to a different AGY conversation', async () => {
  const logs = []
  const envelope = { kind: 'tool_call', name: 'read_file', arguments: { path: 'fixture.txt' } }
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('different-wrapper-session'),
            Message: JSON.stringify(JSON.stringify(envelope)),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.bridgeOutcome, 'agy-internal-tool')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'other-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'recipient-rejected')
})

test('AgyAdapter validates a self-conversation carrier before accepting it', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('root-wrapper-session'),
            Message: JSON.stringify('{"kind":"tool_call","name":"not-allowlisted","arguments":{}}'),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_UNKNOWN_TOOL',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'unknown-tool')
})

test('AgyAdapter rejects an invalid self-conversation carrier envelope with a protocol error', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'init', conversation_id: 'root-wrapper-session' },
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: {
            Recipient: JSON.stringify('root-wrapper-session'),
            Message: JSON.stringify('not-json'),
          },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'TOOL_PROTOCOL_RESPONSE_INVALID',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'self-conversation')
  assert.equal(logs.at(-1)?.carrierValidation, 'invalid-envelope')
})

test('AgyAdapter reports an incomplete send_message carrier before rejecting it', async () => {
  const logs = []
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      {
        event: 'step_update',
        step_update: {
          step_type: 'tool',
          tool_name: 'send_message',
          tool_input: { Recipient: JSON.stringify('default_api') },
        },
      },
    ], []),
  })

  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({
        ...request,
        sessionId: 'session-1',
        tools: [readFileTool],
      })) {}
    },
    error => error.code === 'AGY_INTERNAL_TOOL_EVENT',
  )
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.carrierShape, 'missing-message')
  assert.equal(logs.at(-1)?.toolEventDiagnostic?.recipientClass, 'default-api')
  assert.deepEqual(logs.at(-1)?.toolEventDiagnostic?.toolInputKeys, ['recipient'])
})

test('AgyAdapter ignores a generic Inspect step name under DSH-owned tools', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', toolPolicy: 'dsh-owned' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'agent_response', name: 'Inspect' } },
      { event: 'result', result: { status: 'SUCCESS', response: '{"kind":"message","content":"done"}' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({
    ...request,
    sessionId: 'session-1',
    tools: [readFileTool],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'done')
})

test('official DSH runtime accepts tool schemas only with explicit AGY ownership', async () => {
  const root = new Context()
  const captured = []
  const logs = []
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-owned-runtime'], new AgyAdapter({ toolPolicy: 'agy-owned' }, {
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'list_dir', state: 'ACTIVE' } },
      { event: 'result', result: { status: 'SUCCESS', response: 'text-only response' } },
    ], captured),
  }))

  const chunks = []
  for await (const chunk of root.llm.stream({
    ...request,
    provider: 'agy-owned-runtime',
    messages: [],
    system: 'Reply with text.',
    tools: [{
      name: 'fixture',
      description: 'fixture tool',
      parameters: { secret: 'schema-secret-must-not-be-forwarded' },
    }],
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'text-only response')
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  assert.equal(chunks.some(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'), false)
  assert.equal(Object.hasOwn(captured[0] ?? {}, 'tools'), false)
  assert.doesNotMatch(captured[0]?.prompt ?? '', /schema-secret-must-not-be-forwarded/)
  assert.equal(logs[0]?.toolPolicy, 'agy-owned')
  assert.equal(logs.at(-1)?.toolSchemaCount, 1)
  await root.fiber.dispose()
})

test('AgyAdapter fails fast on an AGY permission request under both tool policies with actionable guidance', async () => {
  for (const toolPolicy of ['reject', 'agy-owned', 'dsh-owned']) {
    const adapter = new AgyAdapter({ toolPolicy }, {
      runAgyProcess: async requestValue => {
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'permission-test' }))
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'permission_request', permission: { kind: 'fixture' } }))
        return result()
      },
    })
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream({ ...request, messages: [], system: 'reply' })) {}
      },
      error => error.code === 'PERMISSION_REQUIRED' && error.message.includes('Adjust AGY Agent permissions'),
    )
  }
})

test('AgyAdapter maps a process output limit to a stable provider error', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async () => ({
      exitCode: null,
      signal: null,
      termination: 'output-limit',
      stdoutLines: [],
      stderr: '',
      durationMs: 1,
    }),
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream({ ...request, messages: [], system: 'reply' })) {}
    },
    error => error.code === 'AGY_OUTPUT_LIMIT',
  )
})

test('AgyAdapter registers and streams through the official DSH LLM runtime', async () => {
  const root = new Context()
  await root.plugin(LlmRuntime)
  root.llm.registerAdapter(['agy-runtime-test'], new AgyAdapter({}, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: '123' } },
    ], []),
  }))

  const chunks = []
  for await (const chunk of root.llm.stream({
    provider: 'agy-runtime-test',
    model: 'gemini-test',
    messages: [],
    system: 'reply',
  })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, '123')
  assert.equal(chunks.at(-1)?.type, 'finish')
  await root.fiber.dispose()
})

test('AgyAdapter maps a DSH Session to --conversation and sends only the new turn', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      captured.push({
        conversation: request.conversation,
        prompt: request.prompt,
      })
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-a' }))
      request.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: call++ === 0 ? 'first' : 'second' },
      }))
      return result()
    },
  })

  const sessionId = 'session-a'
  for await (const _chunk of adapter.stream({
    ...request,
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }],
  })) {}
  const secondMessages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'first' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: secondMessages })) {}

  assert.equal(captured[0].conversation, undefined)
  assert.equal(captured[1].conversation, 'conversation-a')
  assert.match(captured[0].prompt, /first/)
  assert.doesNotMatch(captured[1].prompt, /first/)
  assert.match(captured[1].prompt, /second/)
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-a')
  assert.equal(adapter.clearSession(sessionId), true)
  assert.equal(adapter.getSession(sessionId), undefined)
})

// History fingerprint chain (design borrowed from dsh-agy-safe): the record
// carries a hash over the DSH history the AGY conversation was built on, so an
// edited prefix is caught before a delta prompt lands on stale context.
test('AgyAdapter advances the history fingerprint after every successful resume turn', async () => {
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-fp' }))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      return result()
    },
  })

  const sessionId = 'session-fingerprint'
  const firstMessages = [{ role: 'user', content: [{ type: 'text', text: 'first' }] }]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: firstMessages })) {}
  const afterFirst = adapter.getSession(sessionId)
  assert.equal(afterFirst?.messageCount, 1)
  assert.match(afterFirst?.chainHash ?? '', /^[0-9a-f]{16}$/)

  const secondMessages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: secondMessages })) {}
  const afterSecond = adapter.getSession(sessionId)
  assert.equal(afterSecond?.messageCount, 3)
  assert.match(afterSecond?.chainHash ?? '', /^[0-9a-f]{16}$/)
  assert.notEqual(afterSecond?.chainHash, afterFirst?.chainHash, 'the chain must advance with each turn')
})

test('AgyAdapter abandons the old AGY conversation when the DSH history prefix was edited', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      captured.push({ conversation: request.conversation, prompt: request.prompt })
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: `conversation-${call}` }))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
      call += 1
      return result()
    },
  })

  const sessionId = 'session-edited'
  const firstMessages = [{ role: 'user', content: [{ type: 'text', text: 'original question' }] }]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: firstMessages })) {}

  // The user edits the first message: the prefix no longer matches the
  // fingerprint, so the stale AGY conversation must be dropped and the turn
  // must bootstrap a fresh conversation from the full history.
  const editedMessages = [
    { role: 'user', content: [{ type: 'text', text: 'EDITED question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer-0' }] },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: editedMessages })) {}

  assert.equal(captured[1].conversation, undefined, 'the stale conversation id must not be reused')
  assert.match(captured[1].prompt, /EDITED question/, 'the turn replays the full edited history')
  const rebuilt = adapter.getSession(sessionId)
  assert.equal(rebuilt?.conversationId, 'conversation-1', 'a fresh binding is stored for the next turn')
  assert.equal(rebuilt?.messageCount, 3)
})

test('AgyAdapter skips the fingerprint check for records written before the chain existed', async () => {
  const registry = new SessionRegistry()
  registry.set('session-legacy', 'conversation-legacy')
  const captured = []
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    sessionRegistry: registry,
    runAgyProcess: async request => {
      captured.push({ conversation: request.conversation, prompt: request.prompt })
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-legacy' }))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      return result()
    },
  })

  const legacyMessages = [
    { role: 'user', content: [{ type: 'text', text: 'older turn' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'older answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'new turn' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId: 'session-legacy', messages: legacyMessages })) {}

  assert.equal(captured[0].conversation, 'conversation-legacy', 'no fingerprint means resume as before')
  assert.match(captured[0].prompt, /new turn/)
  assert.doesNotMatch(captured[0].prompt, /older turn/)
  // The chain starts with this turn: the next resume is protected.
  assert.equal(adapter.getSession('session-legacy')?.messageCount, 3)
})

// A: the plain-text prompt ceiling used to be the hard-wired 180 KiB constant,
// so a provider config had no way to raise it for a long resumed session.
test('AgyAdapter applies the configured prompt content limit to a text-only turn', async () => {
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    modelDiscovery: 'off',
    promptContentLimitBytes: 204_800,
  }, {
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'bounded answer' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({ ...request, sessionId: 'session-limit' })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block?.text, 'bounded answer')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.promptLimitBytes, 204_800)
  assert.ok(!completed?.historyCompacted)
})

test('AgyAdapter defaults the prompt content limit to the built-in AGY text budget', async () => {
  const logs = []
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    modelDiscovery: 'off',
  }, {
    logger: record => logs.push(record),
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'default answer' } },
    ], []),
  })

  const chunks = []
  for await (const chunk of adapter.stream({ ...request, sessionId: 'session-default-limit' })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'block-end')?.block?.text, 'default answer')
  const completed = logs.find(record => record.event === 'agy.request.completed')
  assert.equal(completed?.promptLimitBytes, DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES)
  assert.equal(DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES, 184_320, 'the built-in text budget is 180 KiB')
  assert.ok(!completed?.historyCompacted)
})

// B: DSH context compaction drops the oldest messages, so the full-prefix hash
// necessarily changes even though AGY's tail is intact. The stored tail anchor
// decides between "same conversation, keep the binding" and "stale, bootstrap".
function tailFixture() {
  return {
    m0: { role: 'user', content: [{ type: 'text', text: 'first question' }] },
    m1: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    m2: { role: 'user', content: [{ type: 'text', text: 'second question' }] },
    m3: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
    m4: { role: 'user', content: [{ type: 'text', text: 'third question' }] },
  }
}

test('AgyAdapter keeps the AGY conversation when the history front shrank and the tail anchor matches', async () => {
  const captured = []
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-tail' }))
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      return result()
    },
  })

  const sessionId = 'session-tail-match'
  const { m0, m1, m2, m3, m4 } = tailFixture()
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [m0, m1, m2, m3, m4] })) {}

  const record = adapter.getSession(sessionId)
  assert.equal(record?.messageCount, 5)
  assert.equal(record?.tailHashes?.length, 3)

  // The front two messages were compacted away: length 4 < 5, and the stored
  // last three messages still appear as exactly one window of the new history.
  const compacted = [m2, m3, m4, { role: 'user', content: [{ type: 'text', text: 'after compaction' }] }]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: compacted })) {}

  assert.equal(captured[1].conversation, 'conversation-tail', 'the binding survives a front-only shrink')
  assert.match(captured[1].prompt, /after compaction/)
  assert.doesNotMatch(captured[1].prompt, /first question/)
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-tail')
})

test('AgyAdapter bootstraps when the history shrank but the tail anchor no longer matches', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: `conversation-${call}` }))
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
      call += 1
      return result()
    },
  })

  const sessionId = 'session-tail-miss'
  const { m0, m1, m2, m3 } = tailFixture()
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [m0, m1, m2, m3, { role: 'user', content: [{ type: 'text', text: 'third question' }] }] })) {}

  // Still shorter than the stored history, but the tail was rewritten, so the
  // anchor matches zero windows and the stale conversation must be dropped.
  const rewritten = [
    m2,
    m3,
    { role: 'user', content: [{ type: 'text', text: 'EDITED third question' }] },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: rewritten })) {}

  assert.equal(captured[1].conversation, undefined, 'a rewritten tail must not resume the old conversation')
  assert.match(captured[1].prompt, /EDITED third question/, 'the turn replays the full edited history')
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-1', 'a fresh binding is stored')
})

test('AgyAdapter bootstraps when the history did not shrink even though the tail is intact', async () => {
  const first = [
    { role: 'user', content: [{ type: 'text', text: 'original first question' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'original first answer' }] },
    { role: 'user', content: [{ type: 'text', text: 'original last question' }] },
  ]
  const cases = [
    // Same length: only the head was edited, the last two messages are intact.
    [
      { role: 'user', content: [{ type: 'text', text: 'EDITED first question' }] },
      first[1],
      first[2],
    ],
    // Grown: an edit plus one appended turn.
    [
      { role: 'user', content: [{ type: 'text', text: 'EDITED first question' }] },
      first[1],
      first[2],
      { role: 'user', content: [{ type: 'text', text: 'appended turn' }] },
    ],
  ]

  for (const [index, rewritten] of cases.entries()) {
    const captured = []
    let call = 0
    const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
      runAgyProcess: async requestValue => {
        captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: `conversation-${call}` }))
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
        call += 1
        return result()
      },
    })

    const sessionId = `session-no-shrink-${index}`
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: first })) {}
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: rewritten })) {}

    assert.equal(captured[1].conversation, undefined, `case ${index}: a non-shrinking history must bootstrap`)
    assert.match(captured[1].prompt, /EDITED first question/)
  }
})

// A user-cancelled turn (ABORTED) must not destroy the binding: the record is
// flagged cancelled instead, and the next turn resumes the same conversation
// while dropping the orphaned tool result the cancelled turn left behind.
test('AgyAdapter resumes the same conversation after a cancelled turn and drops orphaned tool results', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
      call += 1
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-cancel' }))
      if (call === 2) return { ...result(), termination: 'aborted' }
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
      return result()
    },
  })

  const sessionId = 'session-cancel-resume'
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }] })) {}

  // The cancelled turn: AGY's init already landed (the binding was written
  // back mid-turn), then the user aborted.
  const interrupted = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer-1' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
  await assert.rejects((async () => {
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: interrupted })) {}
  })(), error => error.code === 'ABORTED')

  const flagged = adapter.getSession(sessionId)
  assert.equal(flagged?.cancelled, true)
  assert.equal(flagged?.conversationId, 'conversation-cancel', 'the binding survives the cancellation')
  assert.match(flagged?.chainHash ?? '', /^[0-9a-f]{16}$/, 'the pre-turn fingerprint is written back with the flag')

  // The next turn resumes the same conversation; the orphaned tool result of
  // the cancelled turn is not re-sent.
  const after = [
    ...interrupted,
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'orphaned tool output' }] },
    { role: 'user', content: [{ type: 'text', text: 'third' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: after })) {}

  assert.equal(captured[2].conversation, 'conversation-cancel', 'the turn is a delta against the same conversation')
  assert.match(captured[2].prompt, /third/)
  assert.doesNotMatch(captured[2].prompt, /orphaned tool output/)

  const cleaned = adapter.getSession(sessionId)
  assert.equal(cleaned?.cancelled, undefined, 'a successful turn clears the flag')
  assert.match(cleaned?.chainHash ?? '', /^[0-9a-f]{16}$/)
  assert.notEqual(cleaned?.chainHash, flagged?.chainHash, 'the fingerprint advances to the new history')
  assert.equal(cleaned?.messageCount, 5)
})

test('AgyAdapter restores regular fingerprint validation one turn after the cancellation', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
      call += 1
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: requestValue.conversation ?? `conversation-${call}` }))
      if (call === 2) return { ...result(), termination: 'aborted' }
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
      return result()
    },
  })

  const sessionId = 'session-cancel-regular'
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }] })) {}
  const turnMessages = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer-1' }] },
    { role: 'user', content: [{ type: 'text', text: 'second' }] },
  ]
  await assert.rejects((async () => {
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: turnMessages })) {}
  })(), error => error.code === 'ABORTED')
  // The resume turn right after the cancellation succeeds and rewrites the
  // fingerprint, clearing the flag.
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: turnMessages })) {}
  assert.equal(captured[2].conversation, 'conversation-1')
  assert.equal(adapter.getSession(sessionId)?.cancelled, undefined)

  // From here the regular gate is back in charge: an edited prefix with the
  // same length must bootstrap again, proving the skip only lasted one round.
  const edited = [
    { role: 'user', content: [{ type: 'text', text: 'EDITED first' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'answer-2' }] },
    { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
  ]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages: edited })) {}
  assert.equal(captured[3].conversation, undefined, 'the edited prefix bootstraps a fresh conversation')
  assert.match(captured[3].prompt, /EDITED first/)
})

test('AgyAdapter keeps resuming after a restart when the cancelled record is persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cancel-restart-'))
  try {
    const path = join(dir, 'sessions.json')
    const captured = []
    let call = 0
    const runner = async requestValue => {
      captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
      call += 1
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-durable' }))
      if (call === 2) return { ...result(), termination: 'aborted' }
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
      return result()
    }
    const buildAdapter = () => new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
      sessionRegistry: new SessionRegistry(new FileSessionStore({ path })),
      runAgyProcess: runner,
    })

    const sessionId = 'session-cancel-durable'
    const interrupted = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer-1' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ]
    const first = buildAdapter()
    for await (const _chunk of first.stream({ ...request, sessionId, messages: [{ role: 'user', content: [{ type: 'text', text: 'first' }] }] })) {}
    await assert.rejects((async () => {
      for await (const _chunk of first.stream({ ...request, sessionId, messages: interrupted })) {}
    })(), error => error.code === 'ABORTED')

    // Simulate a host restart: a brand-new adapter over a brand-new store
    // instance reading the same file must still resume, not bootstrap.
    const restarted = buildAdapter()
    for await (const _chunk of restarted.stream({ ...request, sessionId, messages: interrupted })) {}
    assert.equal(captured[2].conversation, 'conversation-durable')
    assert.match(captured[2].prompt, /second/)
    assert.equal(restarted.getSession(sessionId)?.cancelled, undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The cancelled bypass sits upstream of the tail-anchor verdicts: the very
// same "history edited in place, no shrink" shape that bootstraps an unmarked
// record must keep the binding when the record is flagged cancelled.
test('AgyAdapter lets a cancelled record bypass the tail-anchor verdicts', async () => {
  const { m0, m1, m2, m3, m4 } = tailFixture()
  const editedInPlace = [
    { role: 'user', content: [{ type: 'text', text: 'EDITED first question' }] },
    m1,
    m2,
    m3,
    m4,
  ]

  const runFlow = async sessionId => {
    const captured = []
    let call = 0
    const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
      runAgyProcess: async requestValue => {
        captured.push({ conversation: requestValue.conversation, prompt: requestValue.prompt })
        call += 1
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: requestValue.conversation ?? `conversation-${call}` }))
        if (sessionId === 'session-cancel-priority' && call === 2) return { ...result(), termination: 'aborted' }
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: `answer-${call}` } }))
        return result()
      },
    })
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [m0, m1, m2, m3, m4] })) {}
    if (sessionId === 'session-cancel-priority') {
      await assert.rejects((async () => {
        for await (const _chunk of adapter.stream({ ...request, sessionId, messages: [m0, m1, m2, m3, m4] })) {}
      })(), error => error.code === 'ABORTED')
    }
    for await (const _chunk of adapter.stream({ ...request, sessionId, messages: editedInPlace })) {}
    return { captured, adapter, sessionId }
  }

  const cancelled = await runFlow('session-cancel-priority')
  assert.equal(cancelled.captured[2].conversation, 'conversation-1', 'cancelled wins over the tail-anchor verdict')
  assert.match(cancelled.captured[2].prompt, /third question/)

  const control = await runFlow('session-cancel-control')
  assert.equal(control.captured[1].conversation, undefined, 'the same shape without the flag bootstraps')
})

test('AgyAdapter does not resurrect a deliberately deleted binding and does not mark full-mode aborts', async () => {
  // Under resume mode, a binding that is absent when the turn aborts must stay
  // absent: the ABORTED error flags an existing record, it never creates one.
  const carrierAdapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    dshContext: trustedDshContext(),
    runAgyProcess: async () => ({ ...result(), termination: 'aborted' }),
  })
  await assert.rejects((async () => {
    for await (const _chunk of carrierAdapter.stream({ ...request, sessionId: 'session-1' })) {}
  })(), error => error.code === 'ABORTED')
  assert.equal(carrierAdapter.getSession('session-1'), undefined, 'the deliberate deletion is not resurrected')

  // A cancelled turn in full mode writes no record at all.
  const fullAdapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'full' }, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-full' }))
      return { ...result(), termination: 'aborted' }
    },
  })
  await assert.rejects((async () => {
    for await (const _chunk of fullAdapter.stream({ ...request, sessionId: 'session-full-abort' })) {}
  })(), error => error.code === 'ABORTED')
  assert.equal(fullAdapter.getSession('session-full-abort')?.cancelled, undefined, 'full mode never flags a record')
})

// AGY keeps a conversation on disk even when its process was killed mid-answer,
// and resuming it still works. Deleting the binding here threw away a usable
// conversation, which is what kept a large session permanently in the
// full-history bootstrap shape (bootstrap -> TIMEOUT -> binding erased -> the
// next turn is a bootstrap again, at the input limit).
test('AgyAdapter keeps a resumed AGY conversation after a one-shot timeout', async () => {
  const sessionId = 'session-timeout'
  const timeoutResult = { ...result(), termination: 'timeout' }
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: 'conversation-partial' }))
      return timeoutResult
    },
  })

  await assert.rejects((async () => {
    for await (const _chunk of adapter.stream({ ...request, sessionId })) {}
  })(), error => error.code === 'TIMEOUT')
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-partial')
})

test('AgyAdapter retries with full DSH history when AGY resumes a different conversation', async () => {
  const captured = []
  let call = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      const index = call++
      captured.push({ conversation: request.conversation, prompt: request.prompt })
      request.onStdoutLine?.(JSON.stringify({
        event: 'init',
        conversation_id: index === 0 ? 'conversation-old' : index === 1 ? 'conversation-new' : 'conversation-new',
      }))
      request.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: index === 2 ? 'recovered' : 'discarded' },
      }))
      return result()
    },
  })

  const sessionId = 'session-recovery'
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'full history' }] }]
  for await (const _chunk of adapter.stream({ ...request, sessionId, messages })) {}
  const chunks = []
  for await (const chunk of adapter.stream({ ...request, sessionId, messages })) chunks.push(chunk)

  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'recovered')
  assert.deepEqual(captured.map(item => item.conversation), [undefined, 'conversation-old', undefined])
  assert.match(captured[2].prompt, /full history/)
  assert.equal(adapter.getSession(sessionId)?.conversationId, 'conversation-new')
})

test('AgyAdapter serializes same-session calls while allowing separate sessions to overlap', async () => {
  let active = 0
  let maximum = 0
  const adapter = new AgyAdapter({ model: 'gemini-test', sessionMode: 'resume' }, {
    runAgyProcess: async request => {
      active += 1
      maximum = Math.max(maximum, active)
      request.onStdoutLine?.(JSON.stringify({ event: 'init', conversation_id: `conversation-${request.prompt.slice(-1)}` }))
      await new Promise(resolve => setTimeout(resolve, 10))
      request.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))
      active -= 1
      return result()
    },
  })
  const consume = async sessionId => {
    for await (const _chunk of adapter.stream({
      ...request,
      sessionId,
      messages: [{ role: 'user', content: [{ type: 'text', text: sessionId }] }],
    })) {}
  }

  await Promise.all([consume('same'), consume('same')])
  assert.equal(maximum, 1)
  maximum = 0
  await Promise.all([consume('one'), consume('two')])
  assert.equal(maximum, 2)
})

test('AgyAdapter appends the EMPTY_RESPONSE retry hint at the prompt tail of the next turn in the same session', async () => {
  const captured = []
  const hint = 'previous attempt produced no text'
  const turns = [
    // Turn 1: AGY ends the turn with no text and no tool calls (print-mode
    // soft-deny pattern) -> provider must throw EMPTY_RESPONSE.
    [
      { event: 'init', init: { agent: 'deepseek-proxy' } },
      { event: 'result', result: { status: 'SUCCESS', response: '', usage: { totalTokens: 0 } } },
    ],
    // Turn 2 (the host retry): normal text response.
    [
      { event: 'init', init: { agent: 'deepseek-proxy' } },
      { event: 'step_update', step_update: { text_delta: 'ok', usage: { totalTokens: 1 } } },
      { event: 'result', result: { status: 'SUCCESS', response: 'ok', usage: { totalTokens: 1 } } },
    ],
  ]
  const adapter = new AgyAdapter({ model: 'gemini-test' }, {
    runAgyProcess: async req => {
      captured.push(req)
      const events = turns.length > 1 ? turns.shift() : turns[0]
      for (const event of events) {
        await new Promise(resolve => setTimeout(resolve, 1))
        req.onStdoutLine?.(JSON.stringify(event))
      }
      return result()
    },
  })
  const sessionRequest = { ...request, sessionId: 'sess-empty-retry' }
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream(sessionRequest)) chunk
  }, /completed without a text response/)
  // First turn: no hint yet.
  assert.ok(!captured[0].prompt.includes(hint))
  // Retry turn of the same session: hint appended at the prompt tail.
  const chunks = []
  for await (const chunk of adapter.stream(sessionRequest)) chunks.push(chunk)
  assert.ok(captured[1].prompt.includes(hint))
  assert.ok(captured[1].prompt.indexOf(hint) > captured[1].prompt.indexOf('reply 123'))
  assert.equal(chunks.find(chunk => chunk.type === 'text-delta')?.text, 'ok')
  // One-shot consumption: a third turn of the same session carries no hint.
  for await (const chunk of adapter.stream(sessionRequest)) chunk
  assert.ok(!captured[2].prompt.includes(hint))
  // A different session never sees the hint.
  for await (const chunk of adapter.stream({ ...request, sessionId: 'sess-other' })) chunk
  assert.ok(!captured[3].prompt.includes(hint))
})

test('AgyAdapter main turn without a preset keeps workspace cwd and sends no slash-command flag', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { buildAgyArgs } = await import('../lib/agy/process.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-main-cwd-'))
  const workspaceRoot = fs.realpathSync(dir)
  try {
    const captured = []
    const adapter = new AgyAdapter({
      model: 'gemini-test',
      workspaceRoot,
    }, {
      runAgyProcess: fakeRunner([
        { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
      ], captured),
    })
    // No agentPreset and default tool policy: the user turn stays on the
    // canonical workspace root and must not disable AGY's slash commands.
    for await (const _chunk of adapter.stream({ ...request, messages: [] })) {}
    assert.equal(captured[0]?.cwd, workspaceRoot)
    assert.equal(captured[0]?.disableSlashCommands, undefined)
    const argv = buildAgyArgs(captured[0])
    // Built by concatenation: the compared value is the real flag, while this
    // negative assertion adds no production-emitter grep hit.
    const slashFlag = '--disable' + '-slash-commands'
    assert(!argv.includes(slashFlag))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AgyAdapter persistent transport without a preset keeps workspace cwd and sends no slash-command flag', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agy-persistent-cwd-'))
  const workspaceRoot = fs.realpathSync(dir)
  try {
    // Construct the real transport (no injected double): its options carry the
    // cwd and argv that the persistent worker will actually use.
    const adapter = new AgyAdapter({
      model: 'gemini-test',
      toolPolicy: 'reject',
      transport: 'persistent',
      workspaceRoot,
    })
    const options = adapter.persistentTransport.options
    assert.equal(options.cwd, workspaceRoot)
    const slashFlag = '--disable' + '-slash-commands'
    assert(!options.args.includes(slashFlag))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('AgyAdapter persistent request omits --mode extraArgs for agentPreset read-only', async () => {
  const captured = []
  const transport = {
    request: input => {
      captured.push(input)
      input.onEvent?.({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } })
      return Promise.resolve({
        requestId: 'req-read-only-extraargs',
        sessionId: input.sessionId,
        events: [],
        durationMs: 10,
        firstEventMs: 2,
      })
    },
  }
  const adapter = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'reject',
    agentPreset: 'read-only',
    transport: 'persistent',
  }, { persistentTransport: transport })
  for await (const _chunk of adapter.stream({
    ...request,
    sessionId: 'session-read-only-extraargs',
    messages: [],
    system: 'read',
  })) {}
  assert.equal(captured.length, 1, 'read-only preset must still dispatch one persistent request')
  assert.equal(captured[0].extraArgs, undefined, '--mode must never reach the persistent worker')
  assert.ok(!JSON.stringify(captured[0]).includes('--mode'))

  // Negative guard: this fixture really derives mode=plan plus the global
  // slash-command suppression from the read-only preset, the exact combination
  // that previously produced extraArgs=['--mode','plan'] on the persistent path.
  const oneShotCaptured = []
  const oneShot = new AgyAdapter({
    model: 'gemini-test',
    toolPolicy: 'reject',
    agentPreset: 'read-only',
  }, {
    runAgyProcess: fakeRunner([
      { event: 'result', result: { status: 'SUCCESS', response: 'ok' } },
    ], oneShotCaptured),
  })
  for await (const _chunk of oneShot.stream({ ...request, messages: [], system: 'read' })) {}
  assert.equal(oneShotCaptured[0].mode, 'plan')
  assert.equal(oneShotCaptured[0].disableSlashCommands, true)
})
