// Env-probe worker: same NDJSON frame protocol as persistent-worker.mjs, but
// each request is answered with the child process's telemetry env values so
// tests can assert what the transport actually injected.
import { createInterface } from 'node:readline'

const sessionId = process.env.DSH_AGY_EXPERIMENTAL_SESSION ?? 'unknown-session'

const ENV_KEYS = [
  'DO_NOT_TRACK',
  'ANTIGRAVITY_DISABLE_TELEMETRY',
  'GOOGLE_CLOUD_DISABLE_TELEMETRY',
  'DISABLE_TELEMETRY',
]

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

emit({ kind: 'ready', sessionId, workerPid: process.pid })

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    process.exit(21)
  }
  if (frame?.kind === 'shutdown') {
    input.close()
    process.exit(0)
  }
  if (frame?.kind !== 'request') return
  emit({
    kind: 'event',
    requestId: frame.requestId,
    sessionId,
    payload: { requestId: frame.requestId, sessionId, text: ENV_KEYS.map(key => process.env[key]).join('|') },
  })
  emit({ kind: 'complete', requestId: frame.requestId, sessionId })
})
