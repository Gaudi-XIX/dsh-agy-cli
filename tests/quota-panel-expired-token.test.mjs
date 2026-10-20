// Verifies the panel reports *why* the quota card is empty.
//
// Why this test exists: a lapsed OAuth token in the Windows keyring makes both
// quota RPCs answer 401 UNAUTHENTICATED. The old code swallowed that into a
// catch and returned an empty quota card with no hint, which is indistinguishable
// from "no data yet" — the user read it as a broken panel (2026-10-20, after a
// host restart). The status payload now carries `quotaError` and an expired auth
// phase so the panel can say so out loud.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import tls from 'node:tls'
import { setupWebRoutes } from '../lib/web/router.js'

function interceptUnauthorized() {
  const originalRequest = https.request
  const originalConnect = tls.connect
  https.request = (options, callback) => {
    const req = new EventEmitter()
    req.write = () => {}
    req.end = () => {
      setImmediate(() => {
        const res = new EventEmitter()
        // Google answers 401 with an error body; the RPC wrapper keeps the code.
        res.statusCode = 401
        callback(res)
        res.emit('data', Buffer.from(JSON.stringify({ error: { code: 401, message: 'Unauthenticated', status: 'UNAUTHENTICATED' } })))
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

function fakeWebServer() {
  const routes = new Map()
  return {
    port: 43118,
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
  let body = ''
  res.writeHead = (status) => {
    statusCode = status
  }
  res.end = (chunk) => {
    if (chunk) body += chunk.toString()
    res.emit('finish')
  }
  return { res, get status() { return statusCode }, get json() { return JSON.parse(body) } }
}

async function call(ws, path, method) {
  const route = ws.routes.get(path)
  assert.ok(route, `route ${path} registered`)
  const resp = fakeResponse()
  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(fakeRequest(method, path), resp.res)
  })
  return resp
}

test('a 401 from the quota RPCs surfaces as quotaError=unauthorized, not a silent empty card', async () => {
  const restore = interceptUnauthorized()
  try {
    const ws = fakeWebServer()
    const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' })

    await call(ws, '/plugins/agy-link/pool/refresh-quota', 'POST')
    const resp = await call(ws, '/plugins/agy-link/status', 'GET')

    assert.equal(resp.json.quotaError, 'unauthorized')
    // The badge keys off the auth phase, so it must not claim "signed in".
    assert.equal(resp.json.auth.phase, 'expired')
    assert.match(resp.json.auth.message, /过期/)

    dispose()
  } finally {
    restore()
  }
})
