import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setupWebRoutes } from '../lib/web/router.js'
import { apply } from '../lib/index.js'
import { AgyModelDiscovery } from '../lib/agy/models.js'
import { AgyAdapter } from '../lib/provider/agy.js'
import { __setAgyOverridesPathForTest } from '../lib/agy/overrides.js'

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

test('web router: status exposes the real discovery source and newly discovered ids', async () => {
  const ws = fakeWebServer()
  const ctx = fakeContext(ws)
  const discovery = new AgyModelDiscovery({
    runCommand: async () => ({
      exitCode: 0,
      signal: null,
      termination: 'completed',
      stdoutLines: [
        'claude-sonnet-4-6\tClaude Sonnet 4.6',
        'claude-opus-4-6-thinking\tClaude Opus 4.6 Thinking',
        'gpt-oss-120b\tGPT OSS 120B',
      ],
      stderr: '',
      durationMs: 1,
    }),
  })
  const dispose = setupWebRoutes(ctx, { enabled: true, model: 'gemini-3.8-flash' }, discovery)
  const route = ws.routes.get('/plugins/agy-cli/status')
  assert.ok(route)
  const resp = fakeResponse()
  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(fakeRequest('GET', '/plugins/agy-cli/status'), resp.res)
  })
  assert.equal(resp.status, 200)
  // Negative guard: the old hardcoded 'agy models' must never come back.
  assert.notEqual(resp.json.catalog.source, 'agy models')
  assert.equal(resp.json.catalog.source, 'merged')
  assert.equal(resp.json.catalog.lastError, null)
  assert.equal(resp.json.catalog.count, resp.json.catalogModels.length)
  const ids = resp.json.catalogModels.map(m => m.id)
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b']) {
    assert.ok(ids.includes(id), id + ' must reach the catalog without code or YAML edits')
  }
  dispose()
})

test('web router: status reports static for off and unavailable with lastError on failure', async () => {
  const ws = fakeWebServer()
  const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' }, undefined)
  const route = ws.routes.get('/plugins/agy-cli/status')
  const offResp = fakeResponse()
  await new Promise((resolve) => {
    offResp.res.on('finish', resolve)
    route.handler(fakeRequest('GET', '/plugins/agy-cli/status'), offResp.res)
  })
  assert.equal(offResp.json.catalog.source, 'static')
  assert.notEqual(offResp.json.catalog.source, 'agy models')
  assert.equal(offResp.json.catalog.lastError, null)
  dispose()

  const ws2 = fakeWebServer()
  const broken = { discover: async () => { throw new Error('discovery exploded') } }
  const dispose2 = setupWebRoutes(fakeContext(ws2), { enabled: true, model: 'gemini-3.8-flash' }, broken)
  const route2 = ws2.routes.get('/plugins/agy-cli/status')
  const brokenResp = fakeResponse()
  await new Promise((resolve) => {
    brokenResp.res.on('finish', resolve)
    route2.handler(fakeRequest('GET', '/plugins/agy-cli/status'), brokenResp.res)
  })
  assert.equal(brokenResp.json.catalog.source, 'unavailable')
  assert.ok(brokenResp.json.catalog.lastError, 'a broken discovery must not masquerade as success')
  assert.notEqual(brokenResp.json.catalog.source, 'agy models')
  dispose2()
})

test('web router: POST hiddenModels drives one catalog across panel, dropdown and generation', async () => {
  const ws = fakeWebServer()
  const captured = {}
  const ctx = fakeContext(ws, {
    llm: {
      registerConfigurableProviders() {},
      registerModelDiscovery(name, cb) { captured.name = name; captured.cb = cb },
      registerAdapter() {},
    },
    effect() { return () => {} },
  })
  const tmpPath = join(process.cwd(), '_agy_overrides_web_' + process.pid + '.json')
  const hostPatch = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  // Guard: updateCordisPatch() writes to this exact host path when it exists.
  // Refuse to run rather than ever touching a real running-state file.
  assert.equal(existsSync(hostPatch), false, 'refuse to run when a real host cordis.patch.yml exists')
  __setAgyOverridesPathForTest(tmpPath)
  try {
    // A deliberately narrow visibleModels shows the old whitelist is no longer
    // authoritative: claude-sonnet-4-6 is absent from it yet must stay visible.
    const config = {
      enabled: false,
      model: 'gemini-3.8-flash',
      modelDiscovery: 'off',
      visibleModels: ['gemini-3.8-flash'],
      models: [
        { id: 'gemini-3.8-flash' },
        { id: 'gemini-3.1-pro' },
        { id: 'claude-sonnet-4-6' },
      ],
    }
    // apply() registers both the dropdown callback and the status route; an off
    // config returns before mounting the adapter, so no process is spawned.
    apply(ctx, config)
    assert.equal(captured.name, 'dsh-agy-cli')
    assert.equal(typeof captured.cb, 'function')
    const adapter = new AgyAdapter(config)

    const postRoute = ws.routes.get('/plugins/agy-cli/config')
    assert.ok(postRoute)
    const postResp = fakeResponse()
    await new Promise((resolve) => {
      postResp.res.on('finish', resolve)
      postRoute.handler(fakeRequest('POST', '/plugins/agy-cli/config', {
        key: 'hiddenModels',
        value: ['gemini-3.1-pro', 'claude-opus-4-6-thinking'],
      }), postResp.res)
    })
    assert.equal(postResp.status, 200)
    assert.equal(postResp.json.ok, true)

    const statusRoute = ws.routes.get('/plugins/agy-cli/status')
    assert.ok(statusRoute)
    const statusResp = fakeResponse()
    await new Promise((resolve) => {
      statusResp.res.on('finish', resolve)
      statusRoute.handler(fakeRequest('GET', '/plugins/agy-cli/status'), statusResp.res)
    })
    assert.equal(statusResp.status, 200)

    const catalogIds = statusResp.json.catalogModels.map(m => m.id)
    const hidden = statusResp.json.hiddenModels
    const statusVisible = catalogIds.filter(id => !hidden.includes(id.toLowerCase()))
    const dropdownIds = (await captured.cb({ provider: 'agy' })).map(m => m.id)
    const generatedIds = (await adapter.listModels('agy')).map(m => m.id)
    const sorted = ids => [...new Set(ids)].sort()

    assert.deepEqual(sorted(hidden), ['claude-opus-4-6-thinking', 'gemini-3.1-pro'])
    assert.deepEqual(sorted(dropdownIds), sorted(statusVisible))
    assert.deepEqual(sorted(generatedIds), sorted(statusVisible))
    assert.ok(dropdownIds.includes('claude-sonnet-4-6'), 'whitelist must not gate new ids')
    assert.ok(generatedIds.includes('claude-sonnet-4-6'), 'whitelist must not gate new ids')
    // The panel still reports the full catalog, but hidden models are not offered.
    assert.ok(catalogIds.includes('gemini-3.1-pro'))
    assert.ok(!statusVisible.includes('gemini-3.1-pro'))
    assert.ok(!dropdownIds.includes('gemini-3.1-pro'))
    assert.ok(!generatedIds.includes('gemini-3.1-pro'))
    assert.notEqual(statusResp.json.catalog.source, 'agy models')
  } finally {
    __setAgyOverridesPathForTest(undefined)
    console.log('[test cleanup] ' + tmpPath)
    rmSync(tmpPath, { force: true })
  }
})
