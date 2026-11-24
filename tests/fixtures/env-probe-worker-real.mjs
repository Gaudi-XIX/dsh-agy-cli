// Persistent-protocol env probe: emits {event:'init'} at start like the real
// CLI, then answers every user turn with a result whose response is the child
// process's telemetry env values joined by '|'.
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'

const ENV_KEYS = [
  'DO_NOT_TRACK',
  'ANTIGRAVITY_DISABLE_TELEMETRY',
  'GOOGLE_CLOUD_DISABLE_TELEMETRY',
  'DISABLE_TELEMETRY',
]

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

emit({
  event: 'init',
  conversation_id: randomUUID(),
  init: { model: 'probe', cwd: process.cwd(), agent: 'probe', tools: [], permission_mode: 'request-review' },
})

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let turn = 0
input.on('line', line => {
  let msg
  try {
    msg = JSON.parse(line.trim())
  } catch {
    process.exit(21)
  }
  if (!msg || msg.event !== 'user' || !msg.message) return
  turn += 1
  const response = ENV_KEYS.map(key => process.env[key]).join('|')
  emit({
    event: 'step_update',
    step_update: { conversation_id: msg.conversation_id, step_index: turn * 2, state: 'DONE', step_type: 'agent_response', text_delta: response, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  emit({
    event: 'result',
    result: { conversation_id: msg.conversation_id, status: 'SUCCESS', response, duration_seconds: 0, num_turns: turn, usage: { input_tokens: 1, output_tokens: 1 } },
  })
})
