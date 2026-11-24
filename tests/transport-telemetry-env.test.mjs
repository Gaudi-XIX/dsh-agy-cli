import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { ExperimentalAgyTransport as Experimental } from '../lib/agy/experimental-transport.js'
import { ExperimentalAgyTransport as Persistent } from '../lib/agy/persistent-transport.js'

// 与 src/agy/process.ts:392-395 已合入写法逐字对齐（DO_NOT_TRACK='1'，其余 'true'）。
const TELEMETRY_ENV = {
  DO_NOT_TRACK: '1',
  ANTIGRAVITY_DISABLE_TELEMETRY: 'true',
  GOOGLE_CLOUD_DISABLE_TELEMETRY: 'true',
  DISABLE_TELEMETRY: 'true',
}

const SPAWN_SOURCES = ['experimental-transport.ts', 'persistent-transport.ts']

test('两处 transport spawn env 源码注入 4 个遥测禁用变量且在调用方 env 之后', async () => {
  for (const name of SPAWN_SOURCES) {
    const source = await readFile(fileURLToPath(new URL(`../src/agy/${name}`, import.meta.url)), 'utf8')
    const callerEnvIndex = source.indexOf('...this.options.env')
    assert.ok(callerEnvIndex >= 0, `${name} 缺少 ...this.options.env 展开`)
    for (const [key, value] of Object.entries(TELEMETRY_ENV)) {
      const injected = `${key}: '${value}'`
      assert.ok(source.includes(injected), `${name} 缺少 ${injected} 注入`)
      assert.ok(source.indexOf(injected) > callerEnvIndex, `${name} 的 ${key} 必须在调用方 env 之后（force-last）`)
    }
  }
})

const COMMON_OPTIONS = {
  maxWorkers: 8,
  maxFrameBytes: 32 * 1024,
  maxOutputBytes: 256 * 1024,
  maxStderrBytes: 8 * 1024,
  idleTtlMs: 5_000,
  readyTimeoutMs: 2_000,
  shutdownTimeoutMs: 500,
  defaultRequestTimeoutMs: 2_000,
  env: {
    DO_NOT_TRACK: '0',
    ANTIGRAVITY_DISABLE_TELEMETRY: '0',
    GOOGLE_CLOUD_DISABLE_TELEMETRY: 'false',
    DISABLE_TELEMETRY: 'false',
  },
}

test('experimental-transport 把 4 个遥测禁用变量传给子进程且调用方相反值被强制', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/env-probe-worker.mjs', import.meta.url))
  const transport = new Experimental({ executable: process.execPath, args: [fixture], ...COMMON_OPTIONS })
  try {
    const result = await transport.request({ sessionId: 'telemetry-env-session', payload: { mode: 'env' } })
    assert.equal(result.events[0]?.text, '1|true|true|true')
  } finally {
    await transport.dispose()
  }
})

test('persistent-transport 把 4 个遥测禁用变量传给子进程且调用方相反值被强制', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/env-probe-worker-real.mjs', import.meta.url))
  const transport = new Persistent({ executable: process.execPath, args: [fixture], ...COMMON_OPTIONS })
  try {
    const result = await transport.request({ sessionId: 'telemetry-env-session', text: 'mode:env' })
    const response = result.events.find(event => event.event === 'result')?.result?.response ?? ''
    assert.equal(response, '1|true|true|true')
  } finally {
    await transport.dispose()
  }
})
