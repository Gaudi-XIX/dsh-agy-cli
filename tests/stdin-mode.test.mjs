import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * AGY's print mode reads an immediate EOF on the request pipe as "there is no
 * next turn": it shuts its own store manager down and cancels the turn it is
 * still generating. That reached the user as text appearing and then being
 * rolled back. The fixture emulates that reading; these tests pin both halves
 * of the fix — the default keeps the pipe open until AGY's closing `result`
 * line, and `close` restores the historical EOF-on-write behaviour.
 */

const fixture = fileURLToPath(new URL('./fixtures/agy-stdin-stub.mjs', import.meta.url))

function writeStub(dir) {
  const isWin = process.platform === 'win32'
  const script = isWin
    ? `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${fixture}"\n`
  const path = join(dir, isWin ? 'agy.cmd' : 'agy.sh')
  writeFileSync(path, script)
  if (!isWin) chmodSync(path, 0o755)
  return path
}

test('holding the request pipe lets a turn finish instead of cancelling it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stdin-hold-'))
  try {
    const { runAgyProcess } = await import('../lib/agy/process.js')
    const result = await runAgyProcess({
      executable: writeStub(dir),
      prompt: 'answer me',
      stdinMode: 'hold',
      timeoutMs: 30_000,
      idleTimeoutMs: 10_000,
    })
    assert.equal(result.termination, 'completed')
    const lines = result.stdoutLines.map(line => JSON.parse(line))
    const deltas = lines.filter(line => line.event === 'step_update')
    assert.equal(deltas.length, 3, 'all three deltas must arrive before the closing result')
    const final = lines.find(line => line.event === 'result')
    assert.equal(final.result.status, 'SUCCESS', 'an early EOF must not cancel the turn')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ending the request pipe as soon as the frame is written cancels the turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-stdin-close-'))
  try {
    const { runAgyProcess } = await import('../lib/agy/process.js')
    const result = await runAgyProcess({
      executable: writeStub(dir),
      prompt: 'answer me',
      stdinMode: 'close',
      timeoutMs: 30_000,
      idleTimeoutMs: 10_000,
    })
    const lines = result.stdoutLines.map(line => JSON.parse(line))
    const deltas = lines.filter(line => line.event === 'step_update')
    assert.equal(deltas.length, 0, 'the stub must observe the EOF before producing any slice')
    const final = lines.find(line => line.event === 'result')
    assert.equal(final.result.status, 'ERROR', 'the stub must report the cancellation the old default caused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})