import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 180s 优雅超时看门狗：调用方未传 timeoutMs 时 runProcess 兜底 180s 墙钟；
// 超时先取消（关 stdin + 对直接子进程发信号），宽限期满未退出才树状强杀。

test('未传 timeoutMs 时默认 180s 看门狗在位（源码锚）', async () => {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(new URL('../src/agy/process.ts', import.meta.url)), 'utf8')
  assert.ok(src.includes('export const DEFAULT_WATCHDOG_MS = 180_000'), '默认看门狗常量必须为 180s')
  assert.ok(src.includes('export const WATCHDOG_GRACEFUL_MS = 3_000'), '优雅宽限默认必须为 3s')
})

test('挂起进程树被超时阶梯终止且无残留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-watchdog-'))
  try {
    const pidFile = join(dir, 'grandchild.pid').replace(/\\/g, '/')
    // 子进程 spawn 一个孙进程（写 pid 落盘）后自身挂起：
    // 超时树杀后孙进程也必须消失，不留孤儿。
    const grandchildPath = join(dir, 'grandchild.mjs')
    writeFileSync(grandchildPath, 'setInterval(() => {}, 1000)\n')
    const childPath = join(dir, 'child.mjs')
    writeFileSync(childPath, `
      import { spawn } from 'node:child_process'
      import { writeFileSync } from 'node:fs'
      const gc = spawn(process.execPath, ['${grandchildPath.replace(/\\/g, '/')}'], { stdio: 'ignore' })
      writeFileSync('${pidFile}', String(gc.pid))
      gc.unref()
      process.stdin.resume()
      setInterval(() => {}, 1000)
    `)
    const { runProcess } = await import('../lib/agy/process.js')
    const started = Date.now()
    const result = await runProcess({
      executable: process.execPath,
      args: [childPath],
      timeoutMs: 500,
      gracefulKillMs: 200,
    })
    assert.equal(result.termination, 'timeout')
    assert.ok(Date.now() - started < 30_000, 'ladder must not hang the run')
    const { readFileSync, existsSync } = await import('node:fs')
    assert.ok(existsSync(pidFile), 'grandchild pid must have been written')
    const gcPid = Number(readFileSync(pidFile, 'utf8').trim())
    assert.ok(Number.isInteger(gcPid) && gcPid > 0)
    // 轮询确认孙进程已死（树杀清掉整个进程组）
    let alive = true
    for (let i = 0; i < 50 && alive; i += 1) {
      alive = isAlive(gcPid)
      if (alive) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.equal(alive, false, 'grandchild must be killed with the tree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('宽限期内自行退出则优雅路径收尾', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-graceful-'))
  try {
    // hold 模式下取消信号 = stdin 关闭；子进程在 stdin end 后即退出，
    // 应在宽限期（此处故意拉长）耗尽前优雅收尾。
    const childPath = join(dir, 'child.mjs')
    writeFileSync(childPath, `
      process.stdin.resume()
      process.stdin.on('end', () => process.exit(0))
      setInterval(() => {}, 1000)
    `)
    const { runProcess } = await import('../lib/agy/process.js')
    const started = Date.now()
    const result = await runProcess({
      executable: process.execPath,
      args: [childPath],
      stdin: '{"event":"cancel-cue"}',
      stdinMode: 'hold',
      timeoutMs: 500,
      gracefulKillMs: 30_000,
    })
    assert.equal(result.termination, 'timeout')
    assert.equal(result.exitCode, 0)
    assert.ok(Date.now() - started < 20_000, 'graceful exit must not wait out the grace period')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正常完成不受看门狗影响', async () => {
  const { runProcess } = await import('../lib/agy/process.js')
  const result = await runProcess({
    executable: process.execPath,
    args: ['-e', 'console.log("done")'],
  })
  assert.equal(result.termination, 'completed')
  assert.equal(result.exitCode, 0)
  assert.deepEqual(result.stdoutLines, ['done'])
})
