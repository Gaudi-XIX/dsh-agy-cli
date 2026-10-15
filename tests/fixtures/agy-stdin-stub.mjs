/**
 * Stands in for AGY's print mode while a request pipe is open.
 *
 * The behaviour being reproduced is the one measured on the real binary: AGY
 * treats an EOF on the request pipe as "there is no next turn". If that EOF
 * arrives while a turn is still generating, AGY shuts its store manager down
 * and cancels the turn (`Print mode: stream input closed after 1 turn(s)` +
 * `CORTEX_STEP_STATUS_CANCELED`); if it arrives once the turn is finished, it
 * is simply the shutdown cue. This stub reports which of the two happened so a
 * test can tell a held pipe from a closed one.
 */
const nl = String.fromCharCode(10)
const emit = value => process.stdout.write(JSON.stringify(value) + nl)

let cancelled = false
let completed = false

// `end` only fires once the readable is flowing, so consume the request frames.
process.stdin.resume()
process.stdin.on('data', () => undefined)
process.stdin.on('end', () => {
  if (!completed) {
    cancelled = true
    return
  }
  process.exit(0)
})

emit({ event: 'init', init: { conversation_id: 'conv-stdin-stub' } })

let n = 0
const tick = () => {
  n += 1
  if (cancelled) {
    emit({
      event: 'result',
      result: { status: 'ERROR', error: 'turn cancelled after stream input closed' },
    })
    process.exit(0)
    return
  }
  emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'slice-' + n } })
  if (n < 3) {
    setTimeout(tick, 250)
    return
  }
  completed = true
  emit({ event: 'result', result: { status: 'SUCCESS', response: 'done' } })
}

setTimeout(tick, 250)
// Safety net: a run that is never signalled must not outlive the test.
setTimeout(() => process.exit(0), 15_000)