import assert from 'node:assert/strict'
import test from 'node:test'

import { mapAgyUsage } from '../lib/provider/agy.js'
import { usageOf } from '../lib/agy/parser.js'
import { AGY_STREAM_JSON_REAL_FIXTURE } from './fixtures/agy-stream-json-real.mjs'

test('thinking token counts reach TokenUsage.reasoningTokens', () => {
  assert.deepEqual(mapAgyUsage({ thinking_tokens: 42 }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 42 })
  assert.deepEqual(mapAgyUsage({ thinkingTokens: 42 }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 42 })
})

test('reasoning aliases stay ahead of thinking aliases', () => {
  assert.equal(mapAgyUsage({ reasoningTokens: 7, thinking_tokens: 42 }).reasoningTokens, 7)
  assert.equal(mapAgyUsage({ reasoning_tokens: 7, thinkingTokens: 42 }).reasoningTokens, 7)
  assert.equal(Object.hasOwn(mapAgyUsage({ input_tokens: 1, output_tokens: 2 }), 'reasoningTokens'), false)
})

test('real fixture usage blocks map their thinking count', () => {
  const usages = AGY_STREAM_JSON_REAL_FIXTURE
    .map(event => usageOf(event))
    .filter(usage => usage !== undefined && Object.hasOwn(usage, 'thinking_tokens'))
  assert.equal(usages.length, 3)
  for (const usage of usages) {
    assert.equal(mapAgyUsage(usage).reasoningTokens, 0)
  }
})
