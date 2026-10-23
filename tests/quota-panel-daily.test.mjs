// Verifies the panel reads the *daily* host (the one agy.exe actually spends
// against) with the full CLI identity, and that a window upstream does not
// report surfaces as unknown rather than as a fake "100% remaining".
//
// Why this test exists: with the old code the status endpoint asked
// `cloudcode-pa.googleapis.com` with the terse UA `antigravity/1.3.2 (windows;
// amd64)`. prod answers 200 but keeps reporting remainingFraction=1 with a
// resetTime that drifts to "now + window" on every call, and the terse UA makes
// daily omit the Gemini group entirely. Net effect: the panel showed Gemini at
// 100% while the account was at 1% and every generation returned 429.
//
// The HTTP layer is intercepted here so the assertions are about which host and
// which identity we ask, not about the live account's numbers.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import tls from 'node:tls'
import { setupWebRoutes } from '../lib/web/router.js'

const seenRequests = []
// The summary normally carries `groups`, which is the path live traffic takes.
// Flipping this makes the fixture answer without them so the catalog fallback
// (the only remaining consumer of the 133 KB model list) can be exercised.
let summaryWithoutGroups = false

function interceptHttps() {
  const originalRequest = https.request
  const originalConnect = tls.connect
  https.request = (options, callback) => {
    const req = new EventEmitter()
    req.write = () => {}
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter()
        res.statusCode = 200
        callback(res)
        res.emit('data', Buffer.from(JSON.stringify(payloadFor(options))))
        res.emit('end')
      })
    }
    req.destroy = () => {}
    req.on = EventEmitter.prototype.on.bind(req)
    return req
  }
  tls.connect = (options, callback) => {
    const socket = new EventEmitter()
    socket.destroy = () => {}
    if (callback) setImmediate(callback)
    return socket
  }
  return () => {
    https.request = originalRequest
    tls.connect = originalConnect
  }
}

function payloadFor(options) {
  seenRequests.push({
    host: options.host,
    path: options.path,
    userAgent: options.headers?.['User-Agent'],
    apiClient: options.headers?.['X-Goog-Api-Client'],
  })
  if (options.path.includes('retrieveUserQuotaSummary')) {
    if (summaryWithoutGroups) return {}
    return {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Gemini models',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.008289657533168793, resetTime: '2026-10-23T22:00:21Z' },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.9950103163719177, resetTime: '2026-10-20T06:05:46Z' },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Third-party models',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0, resetTime: '2026-10-23T19:08:49Z' },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-20T03:04:04Z', disabled: true },
          ],
        },
      ],
    }
  }
  return {
    models: {
      'gemini-3.8-flash-high': { displayName: 'Gemini 3.8 Flash (High)', quotaInfo: { remainingFraction: 0.008289657533168793, resetTime: '2026-10-23T22:00:21Z' } },
      // Carries a resetTime but no fraction: the shape that used to be filled
      // in as "100% remaining". Same id as the live model so it survives the
      // catalog filter, which keeps only the ids the panel actually lists.
      'gemini-3.8-flash': { displayName: 'Gemini 3.8 Flash', quotaInfo: { resetTime: '2026-10-23T19:08:49Z' } },
      // Not in the shown catalog: the panel drops it, so it must not appear.
      'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6', quotaInfo: { remainingFraction: 0.5, resetTime: '2026-10-23T19:08:49Z' } },
    },
  }
}

function fakeWebServer() {
  const routes = new Map()
  return {
    port: 43117,
    host: '127.0.0.1',
    routes,
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

function fakeContext(webServer) {
  return {
    inject(deps, cb) {
      if (deps.includes('webServer')) cb({ webServer })
    },
  }
}

function fakeRequest(method, path) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = {}
  setImmediate(() => req.emit('end'))
  return req
}

function fakeResponse() {
  const res = new EventEmitter()
  let statusCode = 200
  const headers = {}
  let body = ''
  res.writeHead = (status, h) => {
    statusCode = status
    if (h) Object.assign(headers, h)
  }
  res.end = (chunk) => {
    if (chunk) body += chunk.toString()
    res.emit('finish')
  }
  return { res, get status() { return statusCode }, get json() { return JSON.parse(body) }, get body() { return body } }
}

test('quota panel reads the daily host with the CLI identity and keeps unknown windows unknown', async () => {
  seenRequests.length = 0
  const restore = interceptHttps()
  try {
    const ws = fakeWebServer()
    const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' })

    const refresh = ws.routes.get('/plugins/agy-link/pool/refresh-quota')
    assert.ok(refresh)
    await new Promise((resolve) => {
      const req = fakeRequest('POST', '/plugins/agy-link/pool/refresh-quota')
      const resp = fakeResponse()
      resp.res.on('finish', resolve)
      refresh.handler(req, resp.res)
    })

    const status = ws.routes.get('/plugins/agy-link/status')
    const resp = fakeResponse()
    await new Promise((resolve) => {
      resp.res.on('finish', resolve)
      status.handler(fakeRequest('GET', '/plugins/agy-link/status'), resp.res)
    })

    // 1. The quota RPCs must go to daily, the host agy.exe spends against.
    const quotaHosts = seenRequests.filter((r) => r.path.includes('retrieveUserQuotaSummary') || r.path.includes('fetchAvailableModels'))
    assert.ok(quotaHosts.length > 0, 'quota RPCs were issued')
    for (const r of quotaHosts) {
      assert.equal(r.host, 'daily-cloudcode-pa.googleapis.com', `unexpected quota host for ${r.path}`)
    }

    // 2. The full CLI identity, so daily returns the Gemini group at all.
    for (const r of quotaHosts) {
      assert.match(r.userAgent, /antigravity\/cli\/1\.4\.2/, `terse UA would drop the Gemini group: ${r.userAgent}`)
      assert.match(r.apiClient, /antigravity\/cli/, 'X-Goog-Api-Client must identify the CLI')
    }

    // 3. Real numbers survive, including a 1% weekly bucket.
    const quotas = resp.json.pool.accounts[0].quotas
    assert.equal(quotas.google.weeklyFraction, 0.008289657533168793)
    assert.equal(quotas.google.weeklyResetTime, '2026-10-23T22:00:21Z')
    assert.equal(quotas.google.remainingFraction, 0.9950103163719177)
    assert.equal(quotas.google.weeklyUnknown, false)
    assert.equal(quotas.anthropic.weeklyFraction, 0)

    dispose()
  } finally {
    restore()
  }
})

test('a disabled 5-hour bucket does not masquerade as a full 5-hour bucket', async () => {
  seenRequests.length = 0
  const restore = interceptHttps()
  try {
    const ws = fakeWebServer()
    const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' })

    const refresh = ws.routes.get('/plugins/agy-link/pool/refresh-quota')
    await new Promise((resolve) => {
      const resp = fakeResponse()
      resp.res.on('finish', resolve)
      refresh.handler(fakeRequest('POST', '/plugins/agy-link/pool/refresh-quota'), resp.res)
    })

    const status = ws.routes.get('/plugins/agy-link/status')
    const resp = fakeResponse()
    await new Promise((resolve) => {
      resp.res.on('finish', resolve)
      status.handler(fakeRequest('GET', '/plugins/agy-link/status'), resp.res)
    })

    const quotas = resp.json.pool.accounts[0].quotas
    // daily reports 3p-5h as disabled with remainingFraction 1. Showing "100%"
    // there would be a lie: the window does not apply while the weekly one is drained.
    assert.equal(quotas.anthropic.fiveHourUnknown, true)
    assert.equal(quotas.anthropic.remainingFraction, undefined)

    dispose()
  } finally {
    restore()
  }
})

test('a model with no reported fraction is unknown, not full', async () => {
  seenRequests.length = 0
  // The catalog fallback is the only consumer of the model list: with a summary
  // that reports groups, the list is not fetched at all and per-model rows are
  // absent by design. This test covers the case that does fetch it.
  summaryWithoutGroups = true
  const restore = interceptHttps()
  try {
    const ws = fakeWebServer()
    const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' })

    const refresh = ws.routes.get('/plugins/agy-link/pool/refresh-quota')
    await new Promise((resolve) => {
      const resp = fakeResponse()
      resp.res.on('finish', resolve)
      refresh.handler(fakeRequest('POST', '/plugins/agy-link/pool/refresh-quota'), resp.res)
    })

    const status = ws.routes.get('/plugins/agy-link/status')
    const resp = fakeResponse()
    await new Promise((resolve) => {
      resp.res.on('finish', resolve)
      status.handler(fakeRequest('GET', '/plugins/agy-link/status'), resp.res)
    })

    // gemini-3.8-flash carries only a resetTime, so its per-model fraction is
    // unknown rather than a filled-in 1.
    const flash = resp.json.pool.accounts[0].quotas.google.models.find((m) => m.modelId === 'gemini-3.8-flash')
    assert.ok(flash)
    assert.equal(flash.remainingFraction, undefined)
    assert.equal(flash.resetTime, '2026-10-23T19:08:49Z')

    // The panel lists one model, so models outside that catalog are dropped
    // instead of being shipped to the client on every status poll.
    const ids = resp.json.pool.accounts[0].quotas.anthropic.models.map((m) => m.modelId)
    assert.deepEqual(ids, [])

    dispose()
  } finally {
    summaryWithoutGroups = false
    restore()
  }
})

// Regression guard for the cold-open cost: the catalog call is 132,811 B and
// ~2.1 s (measured 2026-10-23) and, while the summary reports groups, nothing
// on the panel reads its result — it was pure latency on every cold open.
test('a summary that reports groups is answered without fetching the model catalog', async () => {
  seenRequests.length = 0
  const restore = interceptHttps()
  try {
    const ws = fakeWebServer()
    const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' })

    const refresh = ws.routes.get('/plugins/agy-link/pool/refresh-quota')
    await new Promise((resolve) => {
      const resp = fakeResponse()
      resp.res.on('finish', resolve)
      refresh.handler(fakeRequest('POST', '/plugins/agy-link/pool/refresh-quota'), resp.res)
    })

    const status = ws.routes.get('/plugins/agy-link/status')
    const resp = fakeResponse()
    await new Promise((resolve) => {
      resp.res.on('finish', resolve)
      status.handler(fakeRequest('GET', '/plugins/agy-link/status'), resp.res)
    })

    const paths = seenRequests.map((r) => r.path)
    assert.ok(
      paths.some((p) => p.includes('retrieveUserQuotaSummary')),
      'the summary must still be fetched',
    )
    assert.ok(
      !paths.some((p) => p.includes('fetchAvailableModels')),
      `the 133 KB catalog must not be fetched when the summary answers: ${paths.join(', ')}`,
    )

    // Family totals still come from the summary's buckets.
    const quotas = resp.json.pool.accounts[0].quotas
    assert.equal(quotas.google.weeklyFraction, 0.008289657533168793)
    assert.equal(quotas.google.remainingFraction, 0.9950103163719177)

    dispose()
  } finally {
    restore()
  }
})
