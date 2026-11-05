import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AgyPromptBudgetError,
  boundAgyPrompt,
  stableAgyPromptPrefix,
} from '../lib/provider/prompt-budget.js'
import {
  encodeAgyUserMessage,
  getAgyUserMessageByteLength,
} from '../lib/agy/stream-protocol.js'

test('AGY user frame byte measurement matches the encoded NDJSON frame', () => {
  const prompt = '中文 😀\nframe probe'
  assert.equal(
    getAgyUserMessageByteLength(prompt),
    Buffer.byteLength(encodeAgyUserMessage(prompt), 'utf8'),
  )
})

test('prompt budget truncates oversized DSH tool results before the frame limit', () => {
  const prompt = [
    '=== SYSTEM ===\nKeep the answer concise.',
    `=== USER ===\n[DSH TOOL RESULT]\n${JSON.stringify({ content: [{ type: 'text', text: '😀'.repeat(5_000) }] })}`,
    '=== USER ===\nSummarize the result.',
  ].join('\n\n')

  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 8 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 4 * 1024,
  })

  assert.ok(bounded.frameBytes <= 8 * 1024)
  assert.equal(bounded.toolResultCount, 1)
  assert.equal(bounded.truncatedToolResultCount, 1)
  assert.match(bounded.prompt, /\[DSH TOOL RESULT TRUNCATED\]/)
})

test('prompt budget caps the combined historical DSH tool results', () => {
  const prompt = [
    `=== USER ===\n[DSH TOOL RESULT]\n${'a'.repeat(4_000)}`,
    `=== USER ===\n[DSH TOOL RESULT]\n${'b'.repeat(4_000)}`,
    '=== USER ===\nContinue.',
  ].join('\n\n')

  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 32 * 1024,
    maxSingleToolResultBytes: 8 * 1024,
    maxHistoricalToolResultBytes: 5 * 1024,
  })

  assert.equal(bounded.toolResultCount, 2)
  assert.ok(bounded.truncatedToolResultCount >= 1)
  const resultBytes = [...bounded.prompt.matchAll(/\[DSH TOOL RESULT\][\s\S]*?(?=\n=== |$)/g)]
    .reduce((total, match) => total + Buffer.byteLength(match[0], 'utf8'), 0)
  assert.ok(resultBytes <= 5 * 1024)
})

test('prompt budget evicts whole oldest tool-result sections without rewriting newer ones', () => {
  const prompt = results => [
    '=== SYSTEM ===\nStable system prefix.',
    ...results.map(([name, body]) => `=== USER ===\n[DSH TOOL RESULT]\n${name}\n${body}`),
    '=== USER ===\nCURRENT_REQUEST',
  ].join('\n\n')
  const body = 'x'.repeat(1_200)
  const two = boundAgyPrompt(prompt([['A', body], ['B', body]]), {
    maxFrameBytes: 32 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 3_000,
  })
  const three = boundAgyPrompt(prompt([['A', body], ['B', body], ['C', body]]), {
    maxFrameBytes: 32 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 3_000,
  })
  const section = value => value.match(/\[DSH TOOL RESULT\]\nB\nx+[\s\S]*?(?=\n=== |$)/)?.[0]
  assert.equal(section(two.prompt), section(three.prompt))
  assert.match(three.prompt, /\[DSH TOOL RESULT\]\n\[DSH TOOL RESULT OMITTED FROM HISTORY BUDGET\]/)
  assert.doesNotMatch(three.prompt, /\nA\n/)
  assert.equal(stableAgyPromptPrefix(two.prompt), '=== SYSTEM ===\nStable system prefix.')
  assert.equal(stableAgyPromptPrefix(three.prompt), stableAgyPromptPrefix(two.prompt))
})

test('prompt budget still enforces a small aggregate result cap after all sections are evicted', () => {
  const prompt = Array.from({ length: 40 }, (_, index) => (
    `=== USER ===\n[DSH TOOL RESULT]\nR${index}\n${'x'.repeat(1_200)}`
  )).join('\n\n')
  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 32 * 1024,
    maxPromptBytes: 180 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 1_024,
  })
  const resultBytes = [...bounded.prompt.matchAll(/\[DSH TOOL RESULT\][\s\S]*?(?=\n=== |$)/g)]
    .reduce((total, match) => total + Buffer.byteLength(match[0], 'utf8'), 0)
  assert.ok(resultBytes <= 1_024)
})

test('prompt budget compacts old history while preserving the latest request and protocol', () => {
  const prompt = [
    '=== SYSTEM ===\nKeep the workspace rules in effect.',
    '=== USER ===\nInitial request: inspect the project.',
    ...Array.from({ length: 24 }, (_, index) => `=== ASSISTANT ===\nOld assistant turn ${index}\n${'history '.repeat(900)}`),
    '=== USER ===\nCURRENT_REQUEST_MUST_SURVIVE_COMPACTION',
    '=== DSH TOOL PROTOCOL V1 ===\nPROTOCOL_SENTINEL_MUST_SURVIVE_COMPACTION',
  ].join('\n\n')

  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 256 * 1024,
    maxPromptBytes: 12 * 1024,
  })

  assert.ok(bounded.promptBytes <= 12 * 1024)
  assert.equal(bounded.historyCompacted, true)
  assert.ok(bounded.omittedMessageCount > 0)
  assert.match(bounded.prompt, /CURRENT_REQUEST_MUST_SURVIVE_COMPACTION/)
  assert.match(bounded.prompt, /PROTOCOL_SENTINEL_MUST_SURVIVE_COMPACTION/)
  assert.ok(
    bounded.prompt.indexOf('DSH HISTORY COMPACTED')
      < bounded.prompt.indexOf('CURRENT_REQUEST_MUST_SURVIVE_COMPACTION'),
  )
})

test('prompt budget keeps the latest tool result when older turns are removed', () => {
  const prompt = [
    '=== SYSTEM ===\nUse DSH-owned tools.',
    ...Array.from({ length: 12 }, (_, index) => `=== USER ===\n[DSH TOOL RESULT]\nold-${index}\n${'x'.repeat(2_000)}`),
    '=== USER ===\n[DSH TOOL RESULT]\nLATEST_TOOL_RESULT_MUST_SURVIVE\ncurrent-file-content',
    '=== DSH TOOL PROTOCOL V1 ===\nLATEST_PROTOCOL_MUST_SURVIVE',
  ].join('\n\n')

  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 64 * 1024,
    maxPromptBytes: 8 * 1024,
    maxSingleToolResultBytes: 4 * 1024,
    maxHistoricalToolResultBytes: 32 * 1024,
  })

  assert.ok(bounded.promptBytes <= 8 * 1024)
  assert.match(bounded.prompt, /LATEST_TOOL_RESULT_MUST_SURVIVE/)
  assert.match(bounded.prompt, /LATEST_PROTOCOL_MUST_SURVIVE/)
})

// A real DSH turn is serialized as four sections: a plugin relay message, the
// user's own request, the runtime context, and the time-context section that
// closes the turn. So the turn's request is NEVER the last section of the
// prompt — the trailer is — and a budget pass whose only protected section is
// `sections[length - 1]` protects a timestamp over the question it belongs to.
// The bodies are incompressible filler so each turn has a predictable byte cost.
function dshTurnPrompt({ turns, relayBytes, requestBytes, runtimeBytes, timeBytes }) {
  const sections = []
  for (let index = 0; index < turns; index += 1) {
    sections.push(`=== USER ===\n[relevant memories for turn ${index}]\n${'m'.repeat(relayBytes)}`)
    sections.push(`=== USER ===\nREQUEST_SENTINEL_${index}\n${'r'.repeat(requestBytes)}`)
    sections.push(`=== USER ===\nruntime context for turn ${index}\n${'c'.repeat(runtimeBytes)}`)
    sections.push(`=== USER ===\nTime sampled while preparing turn ${index}, step 1\n${'t'.repeat(timeBytes)}`)
  }
  return sections.join('\n\n')
}

function retainedSentinelIndexes(prompt) {
  return [...prompt.matchAll(/REQUEST_SENTINEL_(\d+)(?!\d)/g)].map(match => Number(match[1]))
}

test('prompt budget keeps the current turn request when the clip window start snaps back', () => {
  const turns = 20
  const prompt = dshTurnPrompt({
    turns,
    relayBytes: 3_000,
    requestBytes: 400,
    runtimeBytes: 7_000,
    timeBytes: 300,
  })
  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 256 * 1024,
    maxPromptBytes: 180 * 1024,
  })

  assert.equal(bounded.historyCompacted, true)
  assert.ok(bounded.promptBytes <= 180 * 1024)
  // The question being asked about is the newest turn's, and it must be there
  // rather than an older turn's request standing in for it.
  assert.match(bounded.prompt, new RegExp(`REQUEST_SENTINEL_${turns - 1}(?!\\d)`))
  // The retained turns are one contiguous run ending at the newest turn: a gap
  // is a run of messages silently cut out of the middle of the conversation.
  const retained = retainedSentinelIndexes(bounded.prompt)
  assert.equal(retained[retained.length - 1], turns - 1)
  assert.deepEqual(retained, Array.from({ length: retained.length }, (_, index) => retained[0] + index))
  // The prompt is the clamped shape: the omission marker heads it and the
  // newest turn's own trailer closes it, so the turn being asked about is the
  // one whose timestamp the model reads.
  assert.match(bounded.prompt, /^=== USER ===\n\[DSH HISTORY COMPACTED: this message was omitted/)
  assert.ok(
    bounded.prompt.lastIndexOf(`Time sampled while preparing turn ${turns - 1}, step 1`)
      > bounded.prompt.lastIndexOf('REQUEST_SENTINEL_'),
  )
})

test('prompt budget keeps the whole newest turn group under a second history shape', () => {
  const turns = 80
  const prompt = dshTurnPrompt({
    turns,
    relayBytes: 500,
    requestBytes: 300,
    runtimeBytes: 2_000,
    timeBytes: 300,
  })
  const bounded = boundAgyPrompt(prompt, {
    maxFrameBytes: 256 * 1024,
    maxPromptBytes: 180 * 1024,
  })

  assert.equal(bounded.historyCompacted, true)
  assert.match(bounded.prompt, new RegExp(`REQUEST_SENTINEL_${turns - 1}(?!\\d)`))
  // The newest turn's own trailer must not be the only surviving piece of it.
  assert.match(bounded.prompt, new RegExp(`runtime context for turn ${turns - 1}\\b`))
  assert.match(bounded.prompt, new RegExp(`Time sampled while preparing turn ${turns - 1}, step 1\\b`))
  const retained = retainedSentinelIndexes(bounded.prompt)
  assert.equal(retained[retained.length - 1], turns - 1)
  assert.deepEqual(retained, Array.from({ length: retained.length }, (_, index) => retained[0] + index))
})

test('prompt budget reports a stable error when non-tool prompt content cannot fit', () => {
  assert.throws(
    () => boundAgyPrompt('x'.repeat(5_000), { maxFrameBytes: 1_024 }),
    error => error instanceof AgyPromptBudgetError
      && error.code === 'AGY_INPUT_TOO_LARGE'
      && error.actualBytes > error.limitBytes
      && error.message.includes('bytes'),
  )
})
