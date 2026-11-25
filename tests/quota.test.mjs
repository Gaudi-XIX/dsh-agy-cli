import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverCsrfToken, extractCsrfToken, parseLogPorts, readLogPorts } from '../lib/quota/discovery.js'
import {
  formatCountdown,
  parseDelimitedJson,
  parseModelRows,
  parseSummaryBuckets,
  renderReport,
} from '../lib/quota/summary.js'
import { CLI_LOG_SAMPLE, GET_USER_STATUS_SAMPLE, QUOTA_SUMMARY_SAMPLE } from './fixtures/quota-samples.mjs'

test('parseLogPorts reads only HTTP listening lines and dedupes', () => {
  assert.deepEqual(parseLogPorts(CLI_LOG_SAMPLE), [52236, 52388, 53245])
  assert.deepEqual(parseLogPorts('no ports here'), [])
  assert.deepEqual(parseLogPorts(''), [])
})

test('readLogPorts returns empty result for a missing directory', () => {
  const missing = path.join(os.tmpdir(), `quota-test-missing-${Date.now()}`)
  const { ports, newestLogMtimeMs } = readLogPorts(missing)
  assert.deepEqual(ports, [])
  assert.equal(newestLogMtimeMs, null)
})

test('readLogPorts reads real fixture files, newest first, and dedupes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-test-'))
  try {
    fs.writeFileSync(path.join(dir, 'cli-20261124_000000.log'), CLI_LOG_SAMPLE)
    fs.writeFileSync(path.join(dir, 'cli-20261125_000000.log'), 'Language server listening on random port at 60000 for HTTP\n')
    fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'Language server listening on random port at 12345 for HTTP\n')
    // Pin both fixtures to the exact same millisecond: the flake under repair
    // only fired when mtimes were equal and readdir order decided the winner.
    const sameMs = new Date(1_700_000_000_000)
    fs.utimesSync(path.join(dir, 'cli-20261124_000000.log'), sameMs, sameMs)
    fs.utimesSync(path.join(dir, 'cli-20261125_000000.log'), sameMs, sameMs)
    const { ports } = readLogPorts(dir)
    assert.equal(ports[0], 60000)
    assert.ok(ports.includes(52236))
    assert.ok(!ports.includes(12345))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('extractCsrfToken picks the token from a command line', () => {
  assert.equal(extractCsrfToken('server --csrf_token=abcdef1234567890 --port 5000'), 'abcdef1234567890')
  assert.equal(extractCsrfToken('server --no-token'), null)
})

test('discoverCsrfToken never throws off-platform', async () => {
  if (process.platform !== 'win32') {
    assert.equal(await discoverCsrfToken(), null)
  }
})

test('parseDelimitedJson accepts single documents and newline-delimited fragments', () => {
  assert.deepEqual(parseDelimitedJson('{"a":1}'), [{ a: 1 }])
  assert.deepEqual(parseDelimitedJson('frame\n{"a":1}\nnoise\n{"b":2}'), [{ a: 1 }, { b: 2 }])
  assert.deepEqual(parseDelimitedJson(''), [])
})

test('parseModelRows keeps quota rows and skips disabled or empty ones', () => {
  const rows = parseModelRows(parseDelimitedJson(GET_USER_STATUS_SAMPLE))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].label, 'Gemini 3.8 Flash')
  assert.equal(rows[0].remainingFraction, 0.75)
  assert.equal(rows[0].resetTime, '2026-11-25T06:00:00Z')
  assert.equal(rows[1].modelId, 'MODEL_PLACEHOLDER_M400')
  assert.deepEqual(parseModelRows([]), [])
})

test('parseSummaryBuckets reads groups[].buckets[] and skips amount-only buckets', () => {
  const buckets = parseSummaryBuckets(parseDelimitedJson(QUOTA_SUMMARY_SAMPLE))
  assert.equal(buckets.length, 2)
  assert.equal(buckets[0].bucketId, 'gemini-weekly')
  assert.equal(buckets[0].remainingFraction, 0.8)
  assert.equal(buckets[1].bucketId, 'gemini-5h')
  assert.deepEqual(parseSummaryBuckets([]), [])
})

test('formatCountdown renders readable countdowns and tolerant fallbacks', () => {
  const now = Date.parse('2026-11-25T00:00:00.000Z')
  assert.equal(formatCountdown('2026-11-25T06:00:00.000Z', now), '6h0m')
  assert.equal(formatCountdown('2026-11-27T00:00:00.000Z', now), '2d0h0m')
  assert.equal(formatCountdown('2026-11-24T00:00:00.000Z', now), '已重置')
  assert.equal(formatCountdown(null, now), '重置时间未知')
  assert.ok(formatCountdown('not-a-date', now).includes('无法解析'))
})

test('renderReport lists per-model percentage and countdown, and handles empty input', () => {
  const now = Date.parse('2026-11-25T00:00:00.000Z')
  const models = parseModelRows(parseDelimitedJson(GET_USER_STATUS_SAMPLE))
  const buckets = parseSummaryBuckets(parseDelimitedJson(QUOTA_SUMMARY_SAMPLE))
  const report = renderReport(models, buckets, now)
  assert.ok(report.includes('Gemini 3.8 Flash: 剩余 75%,重置倒计时 6h0m'))
  assert.ok(report.includes('Gemini 3.8 Pro: 剩余 33.3%'))
  assert.ok(report.includes('gemini-weekly: 剩余 80%'))
  assert.ok(!report.includes('Argon'))
  assert.ok(renderReport([], [], now).includes('没有可解析的模型配额行'))
})
