import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, rmSync } from 'node:fs'
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
  // Negative guard: the payload carries no hide list any more.
  assert.equal('hiddenModels' in resp.json, false)
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
  let discoverCalls = 0
  // A complete modelDiscovery stub: peekCatalog must exist (the status path
  // probes the cache first) and a cold peek has to reach a real discover().
  // Without peekCatalog the TypeError was swallowed by the same catch and this
  // test only proved "an incomplete stub does not crash the router".
  const broken = {
    peekCatalog: () => undefined,
    discover: async () => {
      discoverCalls += 1
      throw new Error('discovery exploded')
    },
  }
  const dispose2 = setupWebRoutes(fakeContext(ws2), { enabled: true, model: 'gemini-3.8-flash' }, broken)
  const route2 = ws2.routes.get('/plugins/agy-cli/status')
  const brokenResp = fakeResponse()
  await new Promise((resolve) => {
    brokenResp.res.on('finish', resolve)
    route2.handler(fakeRequest('GET', '/plugins/agy-cli/status'), brokenResp.res)
  })
  assert.equal(discoverCalls, 1, 'a cold peek must fall through to discover()')
  assert.equal(brokenResp.json.catalog.source, 'unavailable')
  // The status path awaits discover() through withDeadline, which folds a
  // rejection into `undefined`, so the panel reports the bounded-wait wording
  // rather than the original message. The rejection's own text stays visible on
  // the refresh-quota path (bare await), asserted in the test above.
  assert.equal(brokenResp.json.catalog.lastError, 'model discovery timed out')
  assert.ok(brokenResp.json.catalog.lastError, 'a broken discovery must not masquerade as success')
  assert.notEqual(brokenResp.json.catalog.source, 'agy models')
  dispose2()
})

test('web router: POST /plugins/agy-cli/pool/refresh-quota returns merged catalog from discovery', async () => {
  const ws = fakeWebServer()
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
  const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' }, discovery)
  const route = ws.routes.get('/plugins/agy-cli/pool/refresh-quota')
  assert.ok(route)
  const resp = fakeResponse()
  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(fakeRequest('POST', '/plugins/agy-cli/pool/refresh-quota'), resp.res)
  })
  assert.equal(resp.status, 200)
  assert.equal(resp.json.ok, true)
  assert.ok(resp.json.pool)
  assert.equal(resp.json.catalog.source, 'merged')
  assert.equal(resp.json.catalog.count, resp.json.catalogModels.length)
  assert.equal(resp.json.catalog.lastError, null)
  const ids = resp.json.catalogModels.map(m => m.id)
  for (const id of ['claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b']) {
    assert.ok(ids.includes(id), id + ' must reach the refresh-quota catalog')
  }
  dispose()
})

test('web router: refresh-quota discovery failure degrades to static catalog without failing quota', async () => {
  const ws = fakeWebServer()
  const broken = { discover: () => { throw new Error('discovery exploded') } }
  const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' }, broken)
  const route = ws.routes.get('/plugins/agy-cli/pool/refresh-quota')
  assert.ok(route)
  const resp = fakeResponse()
  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(fakeRequest('POST', '/plugins/agy-cli/pool/refresh-quota'), resp.res)
  })
  assert.equal(resp.status, 200)
  assert.equal(resp.json.ok, true)
  assert.ok(resp.json.pool)
  assert.equal(resp.json.catalog.source, 'unavailable')
  assert.match(resp.json.catalog.lastError, /discovery exploded/)
  assert.ok(Array.isArray(resp.json.catalogModels))
  assert.ok(resp.json.catalogModels.length > 0, 'configured models must survive a failed discovery')
  assert.equal('hiddenModels' in resp.json, false)
  dispose()
})

test('web router: the hide list is gone, so one full catalog reaches panel, dropdown and generation', async () => {
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
    // The old hide list is gone: claude-sonnet-4-6 was absent from it yet must
    // stay visible.
    const config = {
      enabled: false,
      model: 'gemini-3.8-flash',
      modelDiscovery: 'off',
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
    // Negative guard: the key is not a setting any more, so nothing is persisted.
    assert.equal(existsSync(tmpPath), false, 'POST hiddenModels must not write the overrides file')

    const statusRoute = ws.routes.get('/plugins/agy-cli/status')
    assert.ok(statusRoute)
    const statusResp = fakeResponse()
    await new Promise((resolve) => {
      statusResp.res.on('finish', resolve)
      statusRoute.handler(fakeRequest('GET', '/plugins/agy-cli/status'), statusResp.res)
    })
    assert.equal(statusResp.status, 200)

    const catalogIds = statusResp.json.catalogModels.map(m => m.id)
    const dropdownIds = (await captured.cb({ provider: 'agy' })).map(m => m.id)
    const generatedIds = (await adapter.listModels('agy')).map(m => m.id)
    const sorted = ids => [...new Set(ids)].sort()

    // No payload carries a hide list, and every surface offers the same ids —
    // including the one the POST named and the one the whitelist omitted.
    assert.equal('hiddenModels' in statusResp.json, false)
    assert.deepEqual(sorted(dropdownIds), sorted(catalogIds))
    assert.deepEqual(sorted(generatedIds), sorted(catalogIds))
    assert.deepEqual(sorted(catalogIds), ['claude-sonnet-4-6', 'gemini-3.1-pro', 'gemini-3.8-flash'])
    assert.ok(catalogIds.includes('gemini-3.1-pro'), 'a named id must not be hidden by a POST')
    assert.ok(catalogIds.includes('claude-sonnet-4-6'), 'whitelist must not gate new ids')
    assert.notEqual(statusResp.json.catalog.source, 'agy models')
  } finally {
    __setAgyOverridesPathForTest(undefined)
    console.log('[test cleanup] ' + tmpPath)
    rmSync(tmpPath, { force: true })
  }
})

test('web router: refresh-quota forces discovery past a /status warmed TTL cache', async () => {
  const ws = fakeWebServer()
  let spawns = 0
  const discovery = new AgyModelDiscovery({
    runCommand: async (request) => {
      spawns += 1
      assert.deepEqual(request.args, ['models'])
      return {
        exitCode: 0,
        signal: null,
        termination: 'completed',
        stdoutLines: spawns === 1
          ? ['claude-sonnet-4-6\tClaude Sonnet 4.6']
          : ['claude-sonnet-4-6\tClaude Sonnet 4.6', 'm-new\tNew Model'],
        stderr: '',
        durationMs: 1,
      }
    },
  })
  const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' }, discovery)

  // Mount warm-up: `/status` runs a plain discover and fills the 5-minute TTL.
  const statusRoute = ws.routes.get('/plugins/agy-cli/status')
  assert.ok(statusRoute)
  const statusResp = fakeResponse()
  await new Promise((resolve) => {
    statusResp.res.on('finish', resolve)
    statusRoute.handler(fakeRequest('GET', '/plugins/agy-cli/status'), statusResp.res)
  })
  assert.equal(spawns, 1)
  const warmedIds = statusResp.json.catalogModels.map(m => m.id)
  assert.ok(!warmedIds.includes('m-new'), 'the warm-up must not already carry the new id')

  // A click inside the TTL: the forced discover must re-spawn `agy models` and
  // answer with the model the second run saw.
  const route = ws.routes.get('/plugins/agy-cli/pool/refresh-quota')
  assert.ok(route)
  const resp = fakeResponse()
  await new Promise((resolve) => {
    resp.res.on('finish', resolve)
    route.handler(fakeRequest('POST', '/plugins/agy-cli/pool/refresh-quota'), resp.res)
  })
  assert.equal(resp.status, 200)
  assert.equal(resp.json.ok, true)
  assert.equal(spawns, 2, 'refresh-quota must re-run `agy models` inside the TTL')
  assert.equal(resp.json.catalog.source, 'merged')
  const ids = resp.json.catalogModels.map(m => m.id)
  assert.ok(ids.includes('m-new'), 'the forced catalog must carry the newly discovered id')
  assert.equal(resp.json.catalog.count, resp.json.catalogModels.length)
  dispose()
})

test('web router: a second /status answers from the warm cache without another spawn', async () => {
  const ws = fakeWebServer()
  let spawns = 0
  const discovery = new AgyModelDiscovery({
    runCommand: async () => {
      spawns += 1
      return {
        exitCode: 0,
        signal: null,
        termination: 'completed',
        stdoutLines: ['claude-sonnet-4-6\tClaude Sonnet 4.6'],
        stderr: '',
        durationMs: 1,
      }
    },
  })
  const dispose = setupWebRoutes(fakeContext(ws), { enabled: true, model: 'gemini-3.8-flash' }, discovery)
  const route = ws.routes.get('/plugins/agy-cli/status')
  assert.ok(route)

  const ask = async () => {
    const resp = fakeResponse()
    await new Promise((resolve) => {
      resp.res.on('finish', resolve)
      route.handler(fakeRequest('GET', '/plugins/agy-cli/status'), resp.res)
    })
    return resp
  }

  const cold = await ask()
  assert.equal(spawns, 1, 'a cold cache pays for exactly one discovery')
  assert.equal(cold.json.catalog.source, 'merged')
  const coldIds = cold.json.catalogModels.map(m => m.id)

  const warm = await ask()
  assert.equal(spawns, 1, 'a warm cache must answer the poll without spawning again')
  assert.equal(warm.json.catalog.source, 'cache')
  assert.deepEqual(warm.json.catalogModels.map(m => m.id), coldIds, 'the warm answer must carry the same catalog')
  dispose()
})

test('web router: refresh-quota is not cut by the /status discovery deadline', async () => {
  const ws = fakeWebServer()
  // The 250ms answer is longer than the configured 100ms deadline, so a status
  // poll times out while a refresh click still gets the real result. Keeping it
  // at 250ms instead of a literal 4.5s wait is what makes this test sub-second;
  // the absence of the old hardcoded 4s panel constant itself is covered by the
  // 'built artifact no longer carries the old 4s discovery deadline' test.
  const slow = {
    peekCatalog: () => undefined,
    discover: async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
      return {
        models: [{ id: 'm-slow-but-real', name: 'Slow But Real' }],
        source: 'merged',
        stale: false,
      }
    },
  }
  const dispose = setupWebRoutes(
    fakeContext(ws),
    { enabled: true, model: 'gemini-3.8-flash', modelDiscoveryTimeoutMs: 100 },
    slow,
  )

  // A poll is bounded by the one configured deadline.
  const statusRoute = ws.routes.get('/plugins/agy-cli/status')
  assert.ok(statusRoute)
  const poll = fakeResponse()
  await new Promise((resolve) => {
    poll.res.on('finish', resolve)
    statusRoute.handler(fakeRequest('GET', '/plugins/agy-cli/status'), poll.res)
  })
  assert.equal(poll.json.catalog.source, 'unavailable', 'the poll must give up at modelDiscoveryTimeoutMs')

  // The click is not: it awaits the discovery bare, so the 250ms answer lands.
  const route = ws.routes.get('/plugins/agy-cli/pool/refresh-quota')
  assert.ok(route)
  const clickStarted = Date.now()
  const click = fakeResponse()
  await new Promise((resolve) => {
    click.res.on('finish', resolve)
    route.handler(fakeRequest('POST', '/plugins/agy-cli/pool/refresh-quota'), click.res)
  })
  const waited = Date.now() - clickStarted
  assert.ok(waited >= 200, `refresh-quota must wait for the slow discovery (waited ${waited}ms)`)
  assert.equal(click.json.catalog.source, 'merged')
  assert.ok(click.json.catalogModels.map(m => m.id).includes('m-slow-but-real'))
  dispose()
})

test('web router: built artifact no longer carries the old 4s discovery deadline', () => {
  // Negative guard on the compiled panel router: the hardcoded 4s discovery
  // deadline (DISCOVERY_AWAIT_MS) must be gone, otherwise the module-scope
  // constant could creep back in without any behavioural test noticing that a
  // second, shorter deadline is bounding discovery again.
  const built = readFileSync(new URL('../lib/web/router.js', import.meta.url), 'utf8')
  assert.equal(built.includes('DISCOVERY_AWAIT_MS'), false, 'the 4s discovery deadline constant must not survive the build')
})

// Startup warm-up coverage: `apply()` does `void modelDiscovery.discover(...)`
// before the enabled check (src/index.ts). It is deliberately not exercised
// here because apply() builds its own AgyModelDiscovery from config with no
// injection seam; testing it would either spawn a real `agy models` child or
// require a production-only test hook, neither acceptable in this card. The
// warm-up is recorded as a documented manual/real-machine check in
// review-cycle-report.md.
