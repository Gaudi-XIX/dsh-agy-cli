import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Write a stub AGY: a `.cmd` on Windows (no console prompt), a `.sh` elsewhere. */
function writeStub(dir, body) {
  const isWin = process.platform === 'win32'
  const stub = join(dir, 'stub.mjs')
  writeFileSync(stub, body)
  const script = isWin
    ? `@echo off\r\n"${process.execPath}" "${stub}"\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${stub}"\n`
  const path = join(dir, isWin ? 'agy.cmd' : 'agy.sh')
  writeFileSync(path, script)
  if (!isWin) chmodSync(path, 0o755)
  return path
}

test('the idle watchdog kills a silent AGY run even under a long wall clock', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-idle-'))
  try {
    const executable = writeStub(dir, `
      process.stdout.write('{"event":"init"}\\n')
      setTimeout(() => {}, 600_000)
    `)
    const { runAgyProcess } = await import('../lib/agy/process.js')
    const started = Date.now()
    const result = await runAgyProcess({
      executable,
      prompt: 'stay quiet',
      timeoutMs: 600_000,
      idleTimeoutMs: 1_500,
    })
    assert.equal(result.termination, 'idle-timeout')
    assert.ok(Date.now() - started < 30_000, 'idle budget must not wait for the wall clock')
    assert.equal(result.stdoutLines.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a turn that keeps producing output outlives its idle budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-busy-'))
  try {
    const executable = writeStub(dir, `
      let n = 0
      const tick = () => {
        n += 1
        process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { text_delta: 'x'.repeat(64) } }) + '\\n')
        if (n < 12) setTimeout(tick, 300)
        else process.exit(0)
      }
      setTimeout(tick, 100)
    `)
    const { runAgyProcess } = await import('../lib/agy/process.js')
    const result = await runAgyProcess({
      executable,
      prompt: 'keep talking',
      timeoutMs: 600_000,
      idleTimeoutMs: 1_500,
    })
    assert.equal(result.termination, 'completed')
    assert.equal(result.stdoutLines.length, 12)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the wall clock still fires when output never stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wall-'))
  try {
    const executable = writeStub(dir, `
      setInterval(() => process.stdout.write(JSON.stringify({ event: 'step_update' }) + '\\n'), 100)
      setTimeout(() => {}, 600_000)
    `)
    const { runAgyProcess } = await import('../lib/agy/process.js')
    const result = await runAgyProcess({
      executable,
      prompt: 'never stop',
      timeoutMs: 2_000,
      idleTimeoutMs: 600_000,
    })
    assert.equal(result.termination, 'timeout')
    assert.ok(result.stdoutLines.length > 1, 'output arrived before the wall clock fired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
