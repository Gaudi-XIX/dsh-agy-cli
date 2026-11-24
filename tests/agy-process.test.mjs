import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runProcess } from '../lib/agy/process.js'
import { spawnStderrDetail } from '../lib/agy/errors.js'

// 遥测禁用注入：AGY 的 Clearcut 遥测在断网时每 5s 无退避重试、Send-Q 积压。
// 4 个禁用变量在 runProcess 的 env 组装点强制放在最后，任何调用方 env 都不能
// 重新打开。这里钉住源码注入值，并用真实子进程验证它们确实进了 child env。

const TELEMETRY_ENV = {
  DO_NOT_TRACK: '1',
  ANTIGRAVITY_DISABLE_TELEMETRY: 'true',
  GOOGLE_CLOUD_DISABLE_TELEMETRY: 'true',
  DISABLE_TELEMETRY: 'true',
}

test('process.ts 注入 4 个遥测禁用 env 变量', async () => {
  const srcPath = fileURLToPath(new URL('../src/agy/process.ts', import.meta.url))
  const source = await readFile(srcPath, 'utf8')
  for (const [key, value] of Object.entries(TELEMETRY_ENV)) {
    assert.ok(
      source.includes(`${key}: '${value}'`),
      `process.ts 缺少 ${key}: '${value}' 注入`,
    )
  }
})

test('runProcess 把 4 个遥测禁用变量传给子进程', async () => {
  const script = `console.log(['DO_NOT_TRACK','ANTIGRAVITY_DISABLE_TELEMETRY','GOOGLE_CLOUD_DISABLE_TELEMETRY','DISABLE_TELEMETRY'].map(k => process.env[k]).join('|'))`
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', script],
  })
  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdoutLines, ['1|true|true|true'])
})

test('调用方传入相反值仍被强制为禁用', async () => {
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log(process.env.DO_NOT_TRACK, process.env.DISABLE_TELEMETRY)'],
    env: { DO_NOT_TRACK: '0', DISABLE_TELEMETRY: 'false' },
  })
  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdoutLines, ['1 true'])
})

// 拉起失败 stderr 附着：spawn 失败错误对象要带上定位信息而不是退出码黑盒。
// spawn 'error' 事件先于任何 stderr 字节，因此 ENOENT 场景下摘要为空——此时
// 错误仍须是 SPAWN_FAILED 且带定位；摘要本身由 spawnStderrDetail 单测覆盖。

test('spawn 失败返回 SPAWN_FAILED 且不吞错', async () => {
  await assert.rejects(
    runProcess({ executable: 'definitely-not-a-real-agy-exe-xyz' }),
    error => {
      assert.equal(error.code, 'SPAWN_FAILED')
      assert.match(error.message, /Unable to start AGY executable/)
      return true
    },
  )
})

test('spawnStderrDetail 取最后非空行并截断', () => {
  assert.equal(spawnStderrDetail(''), undefined)
  assert.equal(spawnStderrDetail('   \n  \n'), undefined)
  assert.equal(spawnStderrDetail('progress: 1/9\nfatal: bad model'), 'fatal: bad model')
  assert.equal(spawnStderrDetail('a'.repeat(500)).length, 200)
})
