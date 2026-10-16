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
  assert.deepEqual(projection.tools.map(tool => tool.name), ['grep', 'read', 'write'])
  assert.equal(projection.tools[1].inputSchema.type, 'object')
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
  assert.equal(projection.tools.length, 1)
  assert.deepEqual(projection.tools[0].inputSchema, {
    type: 'object',
    properties: {},
    additionalProperties: false,
  })
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
        async execute() {
          return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
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
          executions.push(exec.name)
          return { isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }
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
    assert.deepEqual(executions, ['memory_search'])

    const ghost = JSON.parse((await postRoute(webServer, path, bridge.endpoint.token, JSON.stringify({
      jsonrpc: '2.0', id: 24, method: 'tools/call', params: { name: 'write', arguments: { file_path: 'x' } },
    }))).body).result
    assert.equal(ghost.isError, true)
    assert.match(ghost.content[0].text, /unknown tool "write"/)
    assert.deepEqual(executions, ['memory_search'], 'a tool AGY was never shown does not run')

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
          return { isError: false, value: 'file contents', content: [{ type: 'text', text: 'file contents' }] }
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
    assert.equal(executions[0].name, 'read')
    assert.deepEqual(executions[0].arguments, { path: 'a.txt' })
    assert.ok(executions[0].callId, 'a correlation id is minted')

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
    tools: { schemas: () => [], execute: async () => ({ isError: false, value: null }) },
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
        async execute() {
          return { isError: true, error: { message: 'denied by host policy' }, content: [] }
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
