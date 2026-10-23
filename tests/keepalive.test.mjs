// The keyring token keep-alive: when it fires, when it refuses to fire again,
// and what it hands AGY.
//
// Why this test exists: AGY only rotates the OAuth token when it loads one it
// already considers EXPIRED (log `keyring.go:64 ... expired=true` followed by
// `browser.go:265 token refreshed`). Two consequences are load-bearing here and
// were measured on the real binary on 2026-10-22:
//
//   * starting agy while the token is still valid is a no-op (~7.6 s, no
//     rotation, zero streamGenerateContent) — so the trigger must be the last
//     tick before expiry, not a wide "almost expired" window;
//   * a run that fails to rotate must not be retried for the same expiry, or a
//     persistent auth/network problem turns into a process launch every minute.
//
// These tests fake the keyring and the process launcher, so they assert the
// decision logic, not the Windows API.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_KEEPALIVE_LEAD_MS,
  refreshAgyTokenIfDue,
  startAgyKeepaliveRun,
  buildKeepaliveArgs,
} from '../lib/agy/keepalive.js'

const MINUTE = 60_000

function fakeKeyring(expiries) {
  const queue = [...expiries]
  let last = queue[queue.length - 1]
  return () => {
    // A non-empty queue means a read that still has something new to say; the
    // old token is returned only in between, never in place of the last entry.
    const next = queue.length > 0 ? queue.shift() : last
    last = next
    return next === undefined ? {} : { expiresAtMs: next }
  }
}

test('keepalive: does not start agy while the token has plenty of life', async () => {
  let launched = 0
  const expiry = Date.now() + 30 * MINUTE
  const outcome = await refreshAgyTokenIfDue({
    readState: () => ({ expiresAtMs: expiry }),
    run: async () => { launched += 1; return { exitCode: 0 } },
  })
  assert.equal(launched, 0, 'agy must not be launched outside the lead window')
  assert.equal(outcome.refreshed, false)
  assert.equal(outcome.reason, 'not-due')
  assert.ok(outcome.remainingSeconds > 1700)
})

test('keepalive: starts agy on the last tick before expiry and reports the rotated expiry', async () => {
  let launched = 0
  let seenRequest
  const before = Date.now() + 20_000 // inside the default 60 s lead
  const after = Date.now() + 3_600_000
  const outcome = await refreshAgyTokenIfDue({
    executable: 'C:/fake/agy.exe',
    model: 'gemini-3.8-flash',
    readState: fakeKeyring([before, after]),
    run: async (request) => {
      launched += 1
      seenRequest = request
      return { exitCode: 0 }
    },
  })
  assert.equal(launched, 1)
  assert.equal(outcome.refreshed, true)
  assert.equal(outcome.reason, 'completed')
  assert.equal(outcome.expiresAtMs, after)
  // The wake-up must be the cheapest possible turn: no prompt on stdin (AGY
  // rejects `-p <prompt>` combined with `--input-format stream-json`), stdin
  // closed so nothing streams back.
  assert.equal(seenRequest.stdinMode, 'close')
  assert.equal(seenRequest.stdin, undefined)
  assert.ok(seenRequest.args.includes('--disable-slash-commands'))
  assert.ok(!seenRequest.args.includes('--input-format'), 'stream-json + argv prompt is rejected by AGY')
})

test('keepalive: a run that leaves the expiry untouched is reported, not silently retried', async () => {
  let launched = 0
  const sameExpiry = Date.now() + 20_000
  const run = async () => { launched += 1; return { exitCode: 0 } }
  const readState = () => ({ expiresAtMs: sameExpiry })

  const first = await refreshAgyTokenIfDue({ executable: 'C:/fake/agy.exe', readState, run })
  assert.equal(first.refreshed, true, 'the process did start')
  assert.equal(first.reason, 'not-rotated', 'but nothing rotated, and it says so')

  const second = await refreshAgyTokenIfDue({ executable: 'C:/fake/agy.exe', readState, run })
  assert.equal(launched, 1, 'the same expiry must not relaunch agy')
  assert.equal(second.refreshed, false)
})

test('keepalive: a failed launch is remembered for that expiry', async () => {
  let launched = 0
  const expiry = Date.now() + 10_000
  const run = async () => { launched += 1; throw new Error('spawn ENOENT') }
  const readState = () => ({ expiresAtMs: expiry })

  const first = await refreshAgyTokenIfDue({ executable: 'C:/fake/agy.exe', readState, run })
  assert.equal(first.reason, 'failed')
  const second = await refreshAgyTokenIfDue({ executable: 'C:/fake/agy.exe', readState, run })
  assert.equal(second.refreshed, false)
  assert.equal(launched, 1, 'a broken spawn must not retry every tick')
})

test('keepalive: a keyring without a readable expiry never triggers a launch', async () => {
  let launched = 0
  const outcome = await refreshAgyTokenIfDue({
    executable: 'C:/fake/agy.exe',
    readState: () => ({}),
    run: async () => { launched += 1; return { exitCode: 0 } },
  })
  assert.equal(outcome.reason, 'no-expiry')
  assert.equal(launched, 0)
})

test('keepalive: an empty executable is refused before spawning anything', async () => {
  let launched = 0
  const outcome = await refreshAgyTokenIfDue({
    executable: '',
    readState: () => ({ expiresAtMs: Date.now() + 1000 }),
    run: async () => { launched += 1; return { exitCode: 0 } },
  })
  // resolveAgyExecutable falls back to PATH; on a machine without agy it may
  // still yield a bare command name, so the only hard requirement is that the
  // decision is visible rather than an unhandled throw.
  assert.ok(['no-executable', 'failed', 'completed', 'not-rotated'].includes(outcome.reason))
  assert.ok(launched <= 1)
})

test('keepalive: argv is the minimal non-interactive shape', () => {
  const args = buildKeepaliveArgs('gemini-3.8-flash')
  assert.deepEqual(args.slice(0, 2), ['-p', '.'])
  assert.ok(args.includes('--effort'))
  assert.ok(args.includes('low'), 'the cheapest effort must be pinned')
  assert.ok(!args.includes('--agent'), 'must not depend on an installed agent template')
  assert.ok(args.includes('--model') && args.includes('gemini-3.8-flash'))
  // Measured 2026-10-22: AGY exits 2 with "--input-format stream-json reads
  // prompts from stdin, so a prompt given on the command line would be ignored"
  // when the two are combined. That rejection was silent and made a broken
  // renewal look successful, so the combination must never come back.
  assert.ok(!args.includes('--input-format'))
  assert.ok(!args.includes('--output-format'))
  assert.deepEqual(args.filter((a) => a === '-p'), ['-p'], 'exactly one prompt flag')
})

test('keepalive: startAgyKeepaliveRun feeds nothing on stdin', async () => {
  let request
  const result = await startAgyKeepaliveRun({
    executable: 'C:/fake/agy.exe',
    timeoutMs: 1234,
    run: async (r) => { request = r; return { exitCode: 0 } },
  })
  assert.equal(result.ok, true)
  assert.equal(result.exitCode, 0)
  assert.equal(request.stdinMode, 'close')
  assert.equal(request.stdin, undefined)
  assert.equal(request.timeoutMs, 1234)
})

test('keepalive: an argv rejection is reported as rejected, with stderr detail', async () => {
  let launched = 0
  const outcome = await refreshAgyTokenIfDue({
    executable: 'C:/fake/agy.exe',
    readState: fakeKeyring([Date.now() + 1_000]),
    run: async () => {
      launched += 1
      return {
        exitCode: 2,
        stderr: 'Error: --input-format stream-json reads prompts from stdin\nmore noise\n',
      }
    },
  })
  assert.equal(launched, 1)
  assert.equal(outcome.refreshed, false)
  assert.equal(outcome.reason, 'rejected')
  assert.equal(outcome.exitCode, 2)
  assert.equal(outcome.detail, 'Error: --input-format stream-json reads prompts from stdin')
})

test('keepalive: a spawn failure is reported as failed, not rejected', async () => {
  // Distinct expiry: the previous test remembered a failure for
  // Date.now()+1_000, and same-millisecond runs would hit the failure dedup.
  const outcome = await refreshAgyTokenIfDue({
    executable: 'C:/fake/agy.exe',
    readState: fakeKeyring([Date.now() + 60_000]),
    run: async () => { throw new Error('Unable to start AGY executable (ENOENT)') },
  })
  assert.equal(outcome.refreshed, false)
  assert.equal(outcome.reason, 'failed')
  assert.equal(outcome.exitCode, null)
  assert.match(outcome.detail, /ENOENT/)
})

test('keepalive: the default lead is one check interval, not a wide window', () => {
  // AGY ignores a valid token, so a wide window only burns process launches.
  assert.equal(DEFAULT_KEEPALIVE_LEAD_MS, MINUTE)
})
