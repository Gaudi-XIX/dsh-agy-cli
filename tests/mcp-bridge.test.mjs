import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  McpServerSession,
  MCP_PROTOCOL_VERSION,
  negotiateProtocolVersion,
} from '../lib/mcp/protocol.js'
import { projectDshTools, validateToolArguments } from '../lib/mcp/tool-projection.js'
import { mountMcpEndpoint } from '../lib/mcp/endpoint.js'
import {
  AGY_MCP_SERVER_NAME,
  isOwnedEntry,
  registerAgyMcpServer,
  unregisterAgyMcpServer,
} from '../lib/mcp/agy-registration.js'
import { startDshMcpBridge } from '../lib/mcp/bridge.js'

/** A fake host HTTP carrier that records the routes plugins claim. */
// The host settles one assistant step as a batch; a bridge call is a batch of
// one. These mocks answer in the same shape production returns.
const batchOf = (exec, result) => ({ results: [{ callId: exec.calls[0].id, result }] })

function fakeWebServer(port = 43117) {
  const routes = new Map()
  return {
    port,
    host: '127.0.0.1',
    routes,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate exact route "${route.path}"`)
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
}

/** Drive the mounted route the way AGY would: loopback socket, bearer token. */
async function postRoute(webServer, path, token, body) {
  const route = webServer.routes.get(path)
  assert.ok(route, `route ${path} is mounted`)
  let status
  let payload = ''
  const res = {
    headersSent: false,
    writeHead(code) {
      status = code
      this.headersSent = true
    },
    end(chunk) {
      if (chunk !== undefined) payload += chunk
    },
  }
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(body, 'utf8')
    },
  }
  await route.handler(req, res)
  return { status, body: payload }
}

test('MCP session negotiates the protocol version and answers initialize', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'agy', version: '1.3.2' } },
  }))
  assert.equal(response.result.protocolVersion, '2024-11-05')
  assert.equal(response.result.serverInfo.name, 'dsh')
  assert.equal(session.client.name, 'agy')
})

test('MCP session never answers a notification', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  }))
  assert.equal(response, undefined)
})

test('MCP session reports a malformed frame as a parse error', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const response = await session.handleMessage('{not json')
  assert.equal(response.error.code, -32700)
})

test('protocol version negotiation falls back to the server default', () => {
  assert.equal(negotiateProtocolVersion('2024-11-05'), '2024-11-05')
  assert.equal(negotiateProtocolVersion('1999-01-01'), MCP_PROTOCOL_VERSION)
  assert.equal(negotiateProtocolVersion(undefined), MCP_PROTOCOL_VERSION)
})

test('MCP session turns a throwing tool into an isError result, not a transport error', async () => {
  const session = new McpServerSession({
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => {
      throw new Error('host refused the call')
    },
  })
  const response = await session.handleMessage(JSON.stringify({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'read', arguments: {} },
  }))
  assert.equal(response.error, undefined)
  assert.equal(response.result.isError, true)
  assert.match(response.result.content[0].text, /host refused the call/)
})

test('tool projection sorts names and reuses the protocol schema gate', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'write', description: 'w', parameters: { type: 'object', properties: {} } },
      { name: 'read', description: 'r', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'grep', description: 'g', parameters: { type: 'object', properties: {} } },
    ],
  })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['apply_edits', 'grep', 'read', 'read_slices', 'write'])
  assert.equal(projection.tools[2].inputSchema.type, 'object')
})

test('tool projection drops host-internal control tools and honours the allowlist', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'compress', description: 'c', parameters: { type: 'object' } },
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { name: 'write', description: 'w', parameters: { type: 'object' } },
    ],
  }, { allowlist: ['read'] })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['read'])
  assert.ok(projection.excluded.includes('compress'))
  assert.ok(projection.excluded.includes('write'))
})

test('tool projection degrades an unusable schema to an open object instead of dropping the tool', () => {
  const projection = projectDshTools({
    schemas: () => [{ name: 'odd', description: 'o', parameters: 'not-a-schema' }],
  })
  assert.equal(projection.tools.length, 3)
  const odd = projection.tools.find(tool => tool.name === 'odd')
  assert.deepEqual(odd.inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
})

test('tool projection honours an explicit maxTools cap and names what it dropped', () => {
  // Regression: the default cap was 64 while this machine's 18-bundle profile
  // projects 73 tools, so four `schedule_*` tools vanished with nothing logged.
  const names = ['read', 'grep', 'write', 'glob', 'edit', 'pwsh']
  const projection = projectDshTools({
    schemas: () => names.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  }, { maxTools: 3 })
  // The cap is applied in registry order, BEFORE the final alphabetical sort:
  // the first three names the registry hands over are the three that survive,
  // so which tools a future overflow costs is decided by registry order rather
  // than by importance. The sorted output is what AGY actually sees.
  assert.deepEqual(projection.tools.map(tool => tool.name), ['grep', 'read', 'write'])
  assert.deepEqual([...projection.excluded].sort(), ['apply_edits', 'edit', 'glob', 'pwsh', 'read_slices'])
})

test('tool projection leaves the default cap far above this machine\'s tool count', () => {
  const names = Array.from({ length: 73 }, (_, index) => `tool-${String(index).padStart(3, '0')}`)
  const projection = projectDshTools({
    schemas: () => names.map(name => ({ name, description: name, parameters: { type: 'object' } })),
  })
  assert.equal(projection.tools.length, 75)
  assert.deepEqual(projection.excluded, [])
})

test('the bridge asks the registry as the session agent, not as the global layer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-scope-'))
  try {
    const webServer = fakeWebServer()
    const agent = { id: 'agent-scoped' }
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        // The global view (no scope) is the short UI/memory-only list. The file
        // and shell tools are an ancestor contribution of the agent plane, so a
        // scope-less call would silently hand AGY a bridge with no `read`.
        schemas: scope => scope === undefined
          ? [{ name: 'click', description: 'c', parameters: { type: 'object' } }]
          : [
            { name: 'click', description: 'c', parameters: { type: 'object' } },
            { name: 'read', description: 'r', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
          ],
        async execute(exec) {
          return batchOf(exec, { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] })
        },
      },
      // The real controller unwraps and returns the Agent itself (it throws the
      // rejection instead of handing back a wrapper), so the bare object is what
      // production sees and what the bridge has to accept.
      sessionController: { async resolveAgent() { return agent } },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-scope')
    const path = new URL(bridge.url).pathname
    const { body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 11, method: 'tools/list', params: {},
    }))
    const names = JSON.parse(body).result.tools.map(tool => tool.name)
    assert.ok(names.includes('read'), 'the scoped agent plane reaches AGY')

    const call = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'read', arguments: { file_path: 'a.txt' } },
    }))
    assert.equal(JSON.parse(call.body).result.isError, false)
    assert.equal(JSON.parse(call.body).error, undefined)
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge resolves the session controller late, so a later mount is not lost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-late-'))
  try {
    const webServer = fakeWebServer()
    let mounted = false
    const agent = { id: 'agent-late' }
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: scope => scope === undefined
          ? [{ name: 'click', description: 'c', parameters: { type: 'object' } }]
          : [
            { name: 'click', description: 'c', parameters: { type: 'object' } },
            { name: 'read', description: 'r', parameters: { type: 'object' } },
          ],
        async execute(exec) {
          return batchOf(exec, { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] })
        },
      },
      // This plugin loads before the Session controller bundle finishes
      // mounting, so the service is absent at start and only the lookup can see
      // it. Pinning the value here used to freeze the global view for good.
      sessionControllerLookup: () => (mounted ? { async resolveAgent() { return agent } } : undefined),
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-late')

    const path = new URL(bridge.url).pathname
    const list = async id => JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/list', params: {},
    }))).body).result.tools.map(tool => tool.name)

    assert.deepEqual(await list(21), ['apply_edits', 'click', 'read_slices'], 'no controller means the global view')

    mounted = true
    assert.ok((await list(22)).includes('read'), 'a controller mounted later still scopes the view')
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge rejects a call that violates the advertised schema before the host runs it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-args-'))
  try {
    const webServer = fakeWebServer()
    const executions = []
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: () => [
          { name: 'memory_search', description: 'm', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
        ],
        async execute(exec) {
          executions.push({ name: exec.calls[0].name, callId: exec.calls[0].id })
          return batchOf(exec, { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] })
        },
      },
      sessionController: { async resolveAgent() { return { agent: { id: 'a' } } } },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-args')
    const path = new URL(bridge.url).pathname
    const call = async (id, args) => JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_search', arguments: args },
    }))).body).result

    // AGY sent `{}` for a required string and a number for a string field.
    const empty = await call(21, {})
    assert.equal(empty.isError, true)
    assert.match(empty.content[0].text, /invalid arguments: missing required property "query"/)
    const wrongType = await call(22, { query: 123 })
    assert.equal(wrongType.isError, true)
    assert.match(wrongType.content[0].text, /"query" must be a string, got number/)
    assert.deepEqual(executions, [], 'neither call reached the host pipeline')

    // A type the schema does not describe is left to DSH, not guessed here.
    const unknownKey = await call(23, { query: 'ok', somethingElse: 7 })
    assert.equal(unknownKey.isError, false)
    assert.deepEqual(executions.map(entry => entry.name), ['memory_search'])

    const ghost = JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'write', arguments: { file_path: 'x' } },
    }))).body).result
    assert.equal(ghost.isError, true)
    assert.match(ghost.content[0].text, /unknown tool "write"/)
    assert.deepEqual(executions.map(entry => entry.name), ['memory_search'], 'a tool AGY was never shown does not run')

    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('validateToolArguments checks only what the schema declares', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string' },
      depth: { type: 'integer' },
      files: { type: 'array' },
      flags: { type: 'object' },
      on: { type: 'boolean' },
      any: {},
    },
    required: ['path'],
  }
  assert.deepEqual(validateToolArguments(schema, { path: 'a' }), [])
  assert.deepEqual(validateToolArguments(schema, { path: 1 }), ['"path" must be a string, got number'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', depth: 1.5 }), ['"depth" must be an integer, got number'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', files: 'x', on: 'yes' }), [
    '"files" must be an array, got string',
    '"on" must be a boolean, got string',
  ])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', files: [], flags: {}, any: null }), [])
  assert.deepEqual(validateToolArguments(schema, {}), ['missing required property "path"'])
  assert.deepEqual(validateToolArguments(schema, undefined), ['arguments must be an object, got undefined'])
  assert.deepEqual(validateToolArguments(schema, ['a']), ['arguments must be an object, got array'])
  assert.deepEqual(validateToolArguments(schema, { path: 'a', undeclared: 1 }), [])
  // Nothing declared to check against means nothing to reject here.
  assert.deepEqual(validateToolArguments({ type: 'object' }, { anything: 1 }), [])
  assert.deepEqual(validateToolArguments(undefined, { anything: 1 }), [])
})

test('the mounted endpoint rejects a missing token and a non-loopback peer', async () => {
  const webServer = fakeWebServer()
  const endpoint = mountMcpEndpoint(webServer, {
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const path = new URL(endpoint.url).pathname

  const unauthorized = await postRoute(webServer, path, 'wrong-token', '{}')
  assert.equal(unauthorized.status, 401)

  const route = webServer.routes.get(path)
  let status
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true },
    end() {},
  }
  await route.handler({
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}` },
    socket: { remoteAddress: '10.0.0.5' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{}') },
  }, res)
  assert.equal(status, 403)
})

test('the endpoint completes an initialize handshake over HTTP', async () => {
  const webServer = fakeWebServer()
  const endpoint = mountMcpEndpoint(webServer, {
    serverName: 'dsh',
    serverVersion: '1.0.0',
    instructions: 'bridge',
    listTools: async () => [],
    callTool: async () => ({ content: [], isError: false }),
  })
  const path = new URL(endpoint.url).pathname
  const { status, body } = await postRoute(webServer, path, endpoint.token, JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION },
  }))
  assert.equal(status, 200)
  assert.equal(JSON.parse(body).result.serverInfo.name, 'dsh')
})

test('AGY MCP registration writes an owned entry and preserves foreign servers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-reg-'))
  try {
    await mkdir(root, { recursive: true })
    const configPath = join(root, 'mcp_config.json')
    await writeFile(configPath, JSON.stringify({
      mcpServers: { someoneElse: { type: 'stdio', command: 'npx' } },
    }), 'utf8')

    await registerAgyMcpServer({ url: 'http://127.0.0.1:1234/x', token: 'tok' }, { configRoot: root })
    const written = JSON.parse(await readFile(configPath, 'utf8'))
    assert.ok(written.mcpServers.someoneElse, 'foreign entry survives')
    const entry = written.mcpServers[AGY_MCP_SERVER_NAME]
    assert.equal(entry.url, 'http://127.0.0.1:1234/x')
    assert.equal(entry.headers.authorization, 'Bearer tok')
    assert.ok(isOwnedEntry(entry), 'entry is attributed to this plugin')

    const removed = await unregisterAgyMcpServer({ configRoot: root })
    assert.equal(removed, true)
    const after = JSON.parse(await readFile(configPath, 'utf8'))
    assert.equal(after.mcpServers[AGY_MCP_SERVER_NAME], undefined)
    assert.ok(after.mcpServers.someoneElse, 'foreign entry still survives cleanup')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AGY MCP cleanup leaves a foreign server that happens to be named dsh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-foreign-'))
  try {
    const configPath = join(root, 'mcp_config.json')
    await writeFile(configPath, JSON.stringify({
      mcpServers: { [AGY_MCP_SERVER_NAME]: { type: 'http', url: 'http://example.test/mcp' } },
    }), 'utf8')
    const removed = await unregisterAgyMcpServer({ configRoot: root })
    assert.equal(removed, false)
    const after = JSON.parse(await readFile(configPath, 'utf8'))
    assert.ok(after.mcpServers[AGY_MCP_SERVER_NAME], 'user-managed server is not deleted')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('AGY settings are written one directory above the MCP config, not beside it', async () => {
  // Measured against the real CLI: a rule placed in the `settings.json` next to
  // `mcp_config.json` never reaches the Allow table AGY logs at startup, while
  // the same rule one level up does. Writing both into one root looks correct
  // on disk and then auto-denies every MCP call in headless mode.
  //
  // Only `settingsRoot` is overridden, so this pins the *default* relationship
  // between the two roots rather than whatever a fixture passes in.
  const cliRoot = await mkdtemp(join(tmpdir(), 'agy-cli-root-'))
  const settingsRoot = await mkdtemp(join(tmpdir(), 'agy-settings-root-'))
  try {
    await registerAgyMcpServer(
      { url: 'http://127.0.0.1:1234/x', token: 'tok', toolNames: ['read', 'write'] },
      { settingsRoot, configRoot: cliRoot },
    )

    const mcpConfig = JSON.parse(await readFile(join(cliRoot, 'mcp_config.json'), 'utf8'))
    assert.ok(mcpConfig.mcpServers[AGY_MCP_SERVER_NAME], 'the MCP server entry lives in the nested root')

    const settings = JSON.parse(await readFile(join(settingsRoot, 'settings.json'), 'utf8'))
    // One server-scoped wildcard, not one rule per tool. AGY matches
    // `mcp(<server>/*)` — the syntax its own binary documents for the bundled
    // `chrome_devtools` server — so DSH-side grants stay the only control point
    // and adding a DSH tool needs no rewrite of this file. Enumerating tools was
    // the old behaviour and is what made every tool-set change a config churn.
    assert.deepEqual(settings.permissions.allow, [`mcp(${AGY_MCP_SERVER_NAME}/*)`])

    await unregisterAgyMcpServer({ settingsRoot, configRoot: cliRoot })
    const cleared = JSON.parse(await readFile(join(settingsRoot, 'settings.json'), 'utf8'))
    assert.equal(
      (cleared.permissions?.allow ?? []).some(rule => rule.startsWith(`mcp(${AGY_MCP_SERVER_NAME}/`)),
      false,
      'cleanup removes the wildcard rule',
    )
  } finally {
    await rm(cliRoot, { recursive: true, force: true })
    await rm(settingsRoot, { recursive: true, force: true })
  }
})

test('the bridge executes a tool through the host pipeline with the resolved agent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-bridge-'))
  try {
    const webServer = fakeWebServer()
    const executions = []
    const agent = { id: 'agent-1' }
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object', properties: {} } }],
        async execute(exec) {
          executions.push(exec)
          return batchOf(exec, { isError: false, value: 'file contents', content: [{ type: 'text', text: 'file contents' }] })
        },
      },
      sessionController: {
        async resolveAgent(sessionId) {
          assert.equal(sessionId, 'session-abc')
          return { agent }
        },
      },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    assert.equal(bridge.active, true)

    bridge.setSession('session-abc')
    const path = new URL(bridge.url).pathname
    const { status, body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read', arguments: { path: 'a.txt' } },
    }))
    assert.equal(status, 200)
    const parsed = JSON.parse(body)
    assert.equal(parsed.result.isError, false)
    assert.equal(parsed.result.content[0].text, 'file contents')

    // The whole point of the bridge: the call carries the live Agent, which is
    // what lets the host approval service route (or deny) the request.
    assert.equal(executions.length, 1)
    assert.equal(executions[0].agent, agent)
    assert.equal(executions[0].calls[0].name, 'read')
    assert.deepEqual(JSON.parse(executions[0].calls[0].arguments), { path: 'a.txt' })
    assert.ok(executions[0].calls[0].id, 'a correlation id is minted')

    await bridge.dispose()
    assert.equal(webServer.routes.size, 0, 'dispose releases the route')
    const config = JSON.parse(await readFile(join(root, 'mcp_config.json'), 'utf8'))
    assert.equal(config.mcpServers[AGY_MCP_SERVER_NAME], undefined, 'dispose unregisters the AGY server')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge fails closed when the host carrier is unavailable', async () => {
  const bridge = await startDshMcpBridge({
    webServer: undefined,
    tools: { schemas: () => [], execute: async (exec) => batchOf(exec, { isError: false, value: null }) },
    serverVersion: '1.0.0',
  })
  assert.equal(bridge.active, false)
  assert.match(bridge.inactiveReason, /webServer/)
})

test('the bridge reports an error result instead of throwing when a tool fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-fail-'))
  try {
    const webServer = fakeWebServer()
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
        async execute(exec) {
          return batchOf(exec, { isError: true, error: { message: 'denied by host policy' }, content: [] })
        },
      },
      sessionController: { async resolveAgent() { return { agent: { id: 'a' } } } },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('s1')
    const path = new URL(bridge.url).pathname
    const { body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'read', arguments: {} },
    }))
    const parsed = JSON.parse(body)
    assert.equal(parsed.result.isError, true)
    assert.match(parsed.result.content[0].text, /denied by host policy/)
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge falls back to agentsLookup when sessionController rejects with subagent routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-subagent-'))
  try {
    const webServer = fakeWebServer()
    const childAgent = { id: 'agent-child-subagent' }
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: scope => scope === childAgent
          ? [
            { name: 'click', description: 'c', parameters: { type: 'object' } },
            { name: 'ops_bash', description: 'b', parameters: { type: 'object' } },
          ]
          : [{ name: 'click', description: 'c', parameters: { type: 'object' } }],
        async execute(exec) {
          return batchOf(exec, { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] })
        },
      },
      sessionController: {
        async resolveAgent() {
          const err = new Error('use subagent delivery for this child session')
          err.code = 'session/agent-busy'
          throw err
        },
      },
      agentsLookup: () => ({
        get(id) {
          if (id === 'session-subagent-1') return childAgent
          return undefined
        },
      }),
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-subagent-1')
    const path = new URL(bridge.url).pathname
    const { body } = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 99, method: 'tools/list', params: {},
    }))
    const names = JSON.parse(body).result.tools.map(tool => tool.name)
    assert.ok(names.includes('ops_bash'), 'the subagent child session resolves ops_bash via agentsLookup')
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tool projection in adaptiveBaseOnly mode projects only base tools and discovery', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'pwsh', description: 'p', parameters: { type: 'object' } },
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { name: 'write', description: 'w', parameters: { type: 'object' } },
      { name: 'wechat_send', description: 'ws', parameters: { type: 'object' } },
      { name: 'schedule_create', description: 'sc', parameters: { type: 'object' } },
    ],
  }, { adaptiveBaseOnly: true })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['apply_edits', 'dsh_discover_tools', 'pwsh', 'read', 'read_slices', 'write'])
  assert.ok(projection.excluded.includes('wechat_send'))
  assert.ok(projection.excluded.includes('schedule_create'))
})

test('tool projection in adaptiveBaseOnly mode honors mounted tools', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'pwsh', description: 'p', parameters: { type: 'object' } },
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { name: 'wechat_send', description: 'ws', parameters: { type: 'object' } },
    ],
  }, { adaptiveBaseOnly: true, mountedTools: new Set(['wechat_send']) })
  assert.deepEqual(projection.tools.map(tool => tool.name), ['apply_edits', 'dsh_discover_tools', 'pwsh', 'read', 'read_slices', 'wechat_send'])
})

test('tool projection preserves both ops tools and raw fallback tools, keeping subagent in drawer', () => {
  const projection = projectDshTools({
    schemas: () => [
      { name: 'ops_bash', description: 'b', parameters: { type: 'object' } },
      { name: 'ops_read_files', description: 'r', parameters: { type: 'object' } },
      { name: 'ops_write_file', description: 'w', parameters: { type: 'object' } },
      { name: 'ops_edit_file', description: 'e', parameters: { type: 'object' } },
      { name: 'pwsh', description: 'p', parameters: { type: 'object' } },
      { name: 'read', description: 'r', parameters: { type: 'object' } },
      { name: 'write', description: 'w', parameters: { type: 'object' } },
      { name: 'subagent', description: 'sa', parameters: { type: 'object' } },
    ],
  }, { adaptiveBaseOnly: true })
  // subagent must stay in drawer (excluded), ops and raw base tools projected
  assert.ok(projection.excluded.includes('subagent'))
  assert.deepEqual(projection.tools.map(tool => tool.name), [
    'apply_edits',
    'dsh_discover_tools',
    'ops_bash',
    'ops_edit_file',
    'ops_read_files',
    'ops_write_file',
    'pwsh',
    'read',
    'read_slices',
    'write',
  ])
})

test('the bridge supports dsh_discover_tools and on-demand tool mounting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-discover-'))
  try {
    const webServer = fakeWebServer()
    const executions = []
    const bridge = await startDshMcpBridge({
      webServer,
      adaptiveBaseOnly: true,
      tools: {
        schemas: () => [
          { name: 'pwsh', description: 'Terminal execution', parameters: { type: 'object' } },
          { name: 'read', description: 'Read files', parameters: { type: 'object' } },
          { name: 'wechat_send', description: 'Send wechat message', parameters: { type: 'object', properties: { msg: { type: 'string' } } } },
        ],
        async execute(exec) {
          executions.push(exec)
          return batchOf(exec, { isError: false, value: 'sent' })
        },
      },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
      agySettingsRoot: root,
    })

    const path = new URL(bridge.url).pathname
    const list1 = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    }))
    assert.equal(list1.status, 200)
    const initialList = JSON.parse(list1.body).result
    const toolNames = initialList.tools.map(t => t.name)
    assert.deepEqual(toolNames, ['apply_edits', 'dsh_discover_tools', 'pwsh', 'read', 'read_slices'])

    // Query discovery and mount wechat_send
    const call1 = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'dsh_discover_tools',
        arguments: { query: 'wechat', mount: ['wechat_send'] },
      },
    }))
    assert.equal(call1.status, 200)
    const discoverResult = JSON.parse(call1.body).result
    assert.equal(discoverResult.isError, false)
    const payload = JSON.parse(discoverResult.content[0].text)
    assert.equal(payload.matchingCount, 1)
    assert.deepEqual(payload.newlyMounted, ['wechat_send'])

    // Next list shows wechat_send mounted
    const list2 = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
      params: {},
    }))
    assert.equal(list2.status, 200)
    const secondList = JSON.parse(list2.body).result
    assert.ok(secondList.tools.some(t => t.name === 'wechat_send'))

    // Now call wechat_send through DSH
    const call2 = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'wechat_send',
        arguments: { msg: 'hello' },
      },
    }))
    assert.equal(call2.status, 200)
    assert.equal(JSON.parse(call2.body).result.isError, false)
    assert.equal(executions.length, 1)

    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge auto-mounts an unprojected host tool on call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-automount-'))
  try {
    const webServer = fakeWebServer()
    const executions = []
    const bridge = await startDshMcpBridge({
      webServer,
      adaptiveBaseOnly: true,
      tools: {
        schemas: () => [
          { name: 'pwsh', description: 'Terminal execution', parameters: { type: 'object' } },
          { name: 'special_action', description: 'Special action', parameters: { type: 'object' } },
        ],
        async execute(exec) {
          executions.push(exec)
          return batchOf(exec, { isError: false, value: 'done' })
        },
      },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
      agySettingsRoot: root,
    })

    const path = new URL(bridge.url).pathname
    // Calling special_action directly auto-mounts it and executes
    const call1 = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'special_action',
        arguments: {},
      },
    }))
    assert.equal(call1.status, 200)
    assert.equal(JSON.parse(call1.body).result.isError, false)
    assert.equal(executions.length, 1)

    // And now it is projected in listTools
    const list = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    }))
    assert.equal(list.status, 200)
    assert.ok(JSON.parse(list.body).result.tools.some(t => t.name === 'special_action'))

    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge routes apply_edits end-to-end and rolls back on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-batch-'))
  try {
    await writeFile(join(root, 'a.txt'), 'hello world', 'utf8')
    await writeFile(join(root, 'b.txt'), 'second file', 'utf8')
    const webServer = fakeWebServer()
    let hostCalled = false
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
        async execute() {
          hostCalled = true
          return batchOf({ calls: [{ id: 'x' }] }, { isError: false, value: '', content: [] })
        },
      },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-batch')
    const path = new URL(bridge.url).pathname
    const call = args => postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_edits', arguments: args },
    }))

    // Success: both files rewritten in one transaction.
    const ok = await call({ edits: [
      { file: join(root, 'a.txt'), pattern: 'world', replacement: 'bridge' },
      { file: join(root, 'b.txt'), pattern: '^second file$', replacement: '2nd' },
    ] })
    const okResult = JSON.parse(ok.body).result
    assert.equal(okResult.isError, false)
    const payload = JSON.parse(okResult.content[0].text)
    assert.deepEqual(payload.files, [join(root, 'a.txt'), join(root, 'b.txt')])
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'hello bridge')
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), '2nd')

    // Failure (zero matches): isError result, zero files touched.
    const bad = await call({ edits: [
      { file: join(root, 'a.txt'), pattern: 'hello', replacement: 'HELLO' },
      { file: join(root, 'b.txt'), pattern: 'no-such-token', replacement: 'x' },
    ] })
    const badResult = JSON.parse(bad.body).result
    assert.equal(badResult.isError, true)
    assert.match(badResult.content[0].text, /apply_edits/)
    assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'hello bridge', 'rollback: first file untouched')
    assert.equal(await readFile(join(root, 'b.txt'), 'utf8'), '2nd')
    assert.equal(hostCalled, false, 'batch tools must not fall through to the host executor')
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the bridge routes read_slices end-to-end', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-mcp-batch-'))
  try {
    await writeFile(join(root, 'c.ts'), 'line1\nfunction f() {}\nline3', 'utf8')
    const webServer = fakeWebServer()
    const bridge = await startDshMcpBridge({
      webServer,
      tools: {
        schemas: () => [{ name: 'read', description: 'r', parameters: { type: 'object' } }],
        async execute() { throw new Error('host must not be called for read_slices') },
      },
      serverVersion: '1.0.0',
      agyConfigRoot: root,
    })
    bridge.setSession('session-slices')
    const path = new URL(bridge.url).pathname
    const res = await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'read_slices', arguments: { file: join(root, 'c.ts'), slices: [{ start: 1, end: 2 }], outline: true } },
    }))
    const result = JSON.parse(res.body).result
    assert.equal(result.isError, false)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.slices[0].text, 'line1\nfunction f() {}')
    assert.ok(payload.outline.some(entry => entry.text.includes('function f() {}')))
    await bridge.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
