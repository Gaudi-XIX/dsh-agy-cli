/**
 * Mechanism 5 — offline corroboration that the AGY thought channel carries no
 * content in this checkout and that DSH-owned text deltas are never filtered.
 *
 * Scope: static + fixture level only, no live AGY session (quota not
 * authorized). The three conclusions are recorded in handoff/apply-implementer-1.md.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { AGY_STREAM_JSON_REAL_FIXTURE } from './fixtures/agy-stream-json-real.mjs'
import { textDeltaOf } from '../lib/agy/parser.js'

test('fixture carries no thought chunk and only token counts for thinking', () => {
  const events = AGY_STREAM_JSON_REAL_FIXTURE
  for (const event of events) {
    assert.notEqual(event.event, 'agent_thought_chunk')
  }

  const stepTypes = new Set()
  for (const event of events) {
    const update = event.step_update
    if (event.event !== 'step_update' || update === undefined) continue
    assert.equal(typeof update.step_type, 'string')
    stepTypes.add(update.step_type)
  }
  for (const stepType of stepTypes) {
    assert.ok(
      ['agent_response', 'checkpoint', 'user_input'].includes(stepType),
      `unexpected step_type ${stepType}`,
    )
  }

  let thinkingSeen = false
  for (const event of events) {
    const usage = event.step_update?.usage ?? event.result?.usage
    if (usage === undefined) continue
    if (!Object.hasOwn(usage, 'thinking_tokens')) continue
    thinkingSeen = true
    assert.equal(typeof usage.thinking_tokens, 'number')
  }
  assert.equal(thinkingSeen, true)
})

test('textDeltaOf passes a thinking-prefixed delta through verbatim', () => {
  const text = 'Thinking Process:\nI should inspect the schema before answering.'
  const event = {
    event: 'step_update',
    step_update: {
      conversation_id: '<string:36>',
      step_index: 0,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
    },
  }
  assert.equal(textDeltaOf(event), text)
})
