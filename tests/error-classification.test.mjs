import assert from 'node:assert/strict'
import test from 'node:test'
import { AgyAdapter } from '../lib/provider/agy.js'
import { classifyAgyFailure } from '../lib/agy/errors.js'

function processResult(stderr = '', exitCode = 0, termination = exitCode === 0 ? 'completed' : 'non-zero') {
  return {
    exitCode,
    signal: null,
    termination,
    stdoutLines: [],
    stderr,
    durationMs: 1,
  }
}

function request() {
  return {
    provider: 'agy-test',
    model: 'gemini-test',
    system: 'reply',
    messages: [],
  }
}

test('classifyAgyFailure maps authentication, quota, model, and context details', () => {
  const cases = [
    ['authentication required', 'AUTH'],
    ['quota exceeded', 'QUOTA'],
    ['HTTP 429: too many requests', 'RATE_LIMIT'],
    ['model gemini-test not found', 'MODEL_NOT_FOUND'],
    ['agent deepseek-proxy not found', 'AGY_AGENT_MISSING'],
    ['context window exceeded', 'CONTEXT_WINDOW_EXCEEDED'],
    ['unclassified provider failure', 'AGY_EXIT'],
    ['request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF', 'TRANSPORT'],
    ['read tcp 127.0.0.1:4891->127.0.0.1:12450: wsarecv: An existing connection was forcibly closed by the remote host.', 'TRANSPORT'],
    ['AGY_ERROR: {"short_error":"request failed","retryable":true}', 'TRANSPORT'],
  ]
  for (const [detail, expected] of cases) assert.equal(classifyAgyFailure(detail, 'AGY_EXIT'), expected)
})

test('AgyAdapter maps an AGY error event to a stable auth code', async () => {
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'error_message',
        error_message: { code: 'AUTH_REQUIRED', message: 'authentication required' },
      }))
      return processResult()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream(request())) {}
    },
    error => error.code === 'AUTH',
  )
})

test('AgyAdapter maps status and stderr details without exposing raw classification to logs', async () => {
  const statusAdapter = new AgyAdapter({}, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'QUOTA_EXCEEDED' } }))
      return processResult()
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of statusAdapter.stream(request())) {}
    },
    error => error.code === 'QUOTA',
  )

  const logs = []
  const stderrAdapter = new AgyAdapter({}, {
    logger: record => logs.push(record),
    runAgyProcess: async () => processResult('model gemini-test not found\n', 1),
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of stderrAdapter.stream(request())) {}
    },
    error => error.code === 'MODEL_NOT_FOUND',
  )
  assert.equal(logs.at(-1)?.errorCode, 'MODEL_NOT_FOUND')
  assert.equal(Object.hasOwn(logs.at(-1) ?? {}, 'stderr'), false)
})

test('AgyAdapter classifies a result-carried AGY_ERROR trailer as a retryable transport flake', async () => {
  // Real shape from session-efbe73bb turn 9: AGY puts the proxy-cut reason
  // under result.error, self-labelled retryable. When the process exits 3
  // with that text on stderr, processFailure classifies it first; this case
  // pins the result-event path (exit 0, status ERROR, reason under result.error).
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async requestValue => {
      requestValue.onStdoutLine?.(JSON.stringify({
        event: 'result',
        result: {
          status: 'ERROR',
          error: 'error: API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": EOF\nAGY_ERROR: {"short_error":"API error (attempt 1): request failed","retryable":true,"error_id":"458a609b-3"}',
        },
      }))
      return processResult('', 0)
    },
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream(request())) {}
    },
    error => error.code === 'TRANSPORT',
  )
})

test('AgyAdapter classifies exit-3 stderr with a proxy-cut reason as a retryable transport flake', async () => {
  // session-efbe73bb turn 10: read tcp ->127.0.0.1:12450 wsarecv forcibly closed.
  const adapter = new AgyAdapter({}, {
    runAgyProcess: async () => processResult('error: API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": read tcp 127.0.0.1:4891->127.0.0.1:12450: wsarecv: An existing connection was forcibly closed by the remote host.\n', 3),
  })
  await assert.rejects(
    async () => {
      for await (const _chunk of adapter.stream(request())) {}
    },
    error => error.code === 'TRANSPORT',
  )
})

test('AgyAdapter keeps process, parser, status, and empty-response codes stable', async () => {
  const cases = [
    {
      expected: 'TIMEOUT',
      run: async () => processResult('', null, 'timeout'),
    },
    {
      expected: 'ABORTED',
      run: async () => processResult('', null, 'aborted'),
    },
    {
      expected: 'AGY_PARSE',
      run: async requestValue => {
        requestValue.onStdoutLine?.('not-json')
        return processResult()
      },
    },
    {
      expected: 'AGY_STATUS',
      run: async requestValue => {
        requestValue.onStdoutLine?.(JSON.stringify({ event: 'result', result: { status: 'FAILED' } }))
        return processResult()
      },
    },
    {
      expected: 'EMPTY_RESPONSE',
      run: async () => processResult(),
    },
  ]
  for (const item of cases) {
    const adapter = new AgyAdapter({}, { runAgyProcess: item.run })
    await assert.rejects(
      async () => {
        for await (const _chunk of adapter.stream(request())) {}
      },
      error => error.code === item.expected,
    )
  }
})
