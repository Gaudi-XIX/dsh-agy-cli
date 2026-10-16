import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { setupWebRoutes } from '../lib/web/router.js'

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
      if (deps.includes('webServer')) {
        cb({ webServer })
      }
    },
  }
}

function fakeRequest(method, path, body = null) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = {}
  setImmediate(() => {
    if (body) {
      req.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    }
    req.emit('end')
  })
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

  return {
    res,
    get status() { return statusCode },
    get json() { return JSON.parse(body) },
    get body() { return body },
  }
}

test('web router: registers required /plugins/agy-link/* routes', () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true, model: 'gemini-3.8-flash' })

  assert.ok(ws.routes.has('/plugins/agy-link/status'), 'status route registered')
  assert.ok(ws.routes.has('/plugins/agy-link/config'), 'config route registered')
  assert.ok(ws.routes.has('/plugins/agy-link/pool/refresh-quota'), 'refresh-quota route registered')
  assert.ok(ws.routes.has('/plugins/agy-link/auth'), 'auth route registered')

  dispose()
})

test('web router: GET /plugins/agy-link/status returns valid payload for GUI', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true, model: 'gemini-3.8-flash' })

  const route = ws.routes.get('/plugins/agy-link/status')
  assert.ok(route)

  const req = fakeRequest('GET', '/plugins/agy-link/status')
  const resp = fakeResponse()

  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(req, resp.res)
  })

  assert.equal(resp.status, 200)
  assert.equal(resp.json.plugin, 'dsh-agy-provider')
  assert.equal(resp.json.enabled, true)
  assert.equal(resp.json.permissionMode, 'dsh-owned')
  assert.ok(Array.isArray(resp.json.catalogModels))
  assert.ok(Array.isArray(resp.json.hiddenModels))
  assert.ok(resp.json.pool?.accounts?.length > 0)
  assert.equal(resp.json.pool.accounts[0].id, 'primary')

  dispose()
})

test('web router: POST /plugins/agy-link/config updates settings', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true })

  const route = ws.routes.get('/plugins/agy-link/config')
  assert.ok(route)

  const req = fakeRequest('POST', '/plugins/agy-link/config', {
    key: 'defaultEffort',
    value: 'high',
  })
  const resp = fakeResponse()

  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(req, resp.res)
  })

  assert.equal(resp.status, 200)
  assert.equal(resp.json.ok, true)
  assert.equal(resp.json.key, 'defaultEffort')
  assert.equal(resp.json.value, 'high')

  dispose()
})
