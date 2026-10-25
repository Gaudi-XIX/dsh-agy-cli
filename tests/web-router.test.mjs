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

// The diagnose handler reads `ctx.llm` on the *outer* context (the one that
// owns `inject`), not on the injected inner context, so the service has to be
// placed there to reproduce either state.
function fakeContext(webServer, extra = {}) {
  return {
    ...extra,
    inject(deps, cb) {
      if (deps.includes('webServer')) {
        cb({ webServer })
      }
    },
  }
}

function throwingLlmContext(webServer) {
  const ctx = fakeContext(webServer)
  Object.defineProperty(ctx, 'llm', {
    get() {
      throw new Error('cannot access service "llm" before it is available')
    },
  })
  return ctx
}

function fakeRequest(method, path, body = null) {
  const req = new EventEmitter()
  req.method = method
  req.url = path
  req.headers = {}
  req.socket = { remoteAddress: "127.0.0.1" }
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

test('web router: registers required /plugins/agy-cli/* routes', () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true, model: 'gemini-3.8-flash' })

  assert.ok(ws.routes.has('/plugins/agy-cli/status'), 'status route registered')
  assert.ok(ws.routes.has('/plugins/agy-cli/config'), 'config route registered')
  assert.ok(ws.routes.has('/plugins/agy-cli/pool/refresh-quota'), 'refresh-quota route registered')
  assert.ok(ws.routes.has('/plugins/agy-cli/auth'), 'auth route registered')

  dispose()
})

test('web router: GET /plugins/agy-cli/status returns valid payload for GUI', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true, model: 'gemini-3.8-flash' })

  const route = ws.routes.get('/plugins/agy-cli/status')
  assert.ok(route)

  const req = fakeRequest('GET', '/plugins/agy-cli/status')
  const resp = fakeResponse()

  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(req, resp.res)
  })

  assert.equal(resp.status, 200)
  assert.equal(resp.json.plugin, 'dsh-agy-cli')
  assert.equal(resp.json.enabled, true)
  assert.equal(resp.json.permissionMode, 'dsh-owned')
  assert.ok(Array.isArray(resp.json.catalogModels))
  assert.ok(Array.isArray(resp.json.hiddenModels))
  assert.ok(resp.json.pool?.accounts?.length > 0)
  assert.equal(resp.json.pool.accounts[0].id, 'primary')

  dispose()
})

test('web router: POST /plugins/agy-cli/config updates settings', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true })

  const route = ws.routes.get('/plugins/agy-cli/config')
  assert.ok(route)

  const req = fakeRequest('POST', '/plugins/agy-cli/config', {
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

test('web router: GET /plugins/agy-cli/diagnose answers 200 even when llm is unavailable', async () => {
  const ws = fakeWebServer()
  const ctx = throwingLlmContext(ws)
  const dispose = setupWebRoutes(ctx, { enabled: true })

  const route = ws.routes.get('/plugins/agy-cli/diagnose')
  assert.ok(route, 'diagnose route registered')

  const req = fakeRequest('GET', '/plugins/agy-cli/diagnose')
  const resp = fakeResponse()

  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(req, resp.res)
  })

  assert.equal(resp.status, 200, 'a diagnostic route must never fail closed as a bare 400')
  assert.equal(resp.json.cardSlot, 'settings.models.provider-card')
  assert.equal(resp.json.cardKey, 'dsh-agy-cli')
  assert.equal(
    resp.json.llmError,
    'cannot access service "llm" before it is available',
    'the reason has to be readable in the payload, not only in a host log',
  )
  assert.match(resp.json.providers, /^unavailable: /)
  assert.match(resp.json.configurable, /^unavailable: /)

  dispose()
})

test('web router: GET /plugins/agy-cli/diagnose reports llmError null when llm is mounted', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws, {
    llm: {
      listProviders: () => [{ id: 'agy' }],
      listConfigurableProviders: () => [
        { provider: 'agy', displayName: 'Antigravity CLI', settingsNs: 'dsh-agy-cli', settingsPath: [] },
      ],
    },
  })
  const dispose = setupWebRoutes(ctx, { enabled: true })

  const route = ws.routes.get('/plugins/agy-cli/diagnose')
  const req = fakeRequest('GET', '/plugins/agy-cli/diagnose')
  const resp = fakeResponse()

  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(req, resp.res)
  })

  assert.equal(resp.status, 200)
  assert.equal(resp.json.llmError, null)
  assert.deepEqual(resp.json.providers, ['agy'])
  assert.equal(resp.json.rowCarriesCardKey, true)

  dispose()
})
