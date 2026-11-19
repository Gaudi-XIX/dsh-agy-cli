/**
 * MCP 会话归属（fix-agy-mcp-session-crosstalk）
 *
 * 成因：endpoint 的进程级全局 `sessionHandle` 被并发回合覆写——回合 A 开始
 * 后、A 的 MCP 请求尚未到达时，回合 B 开始 setSession('sess-B')，A 的请求
 * 快照到 B 的 handle，工具调用落在别人的会话里。
 *
 * 修后语义：AGY 在每个请求上自带 `_meta.sessionId` 自证归属，resolveSession
 * 以 `_meta` 为准，transport handle 仅在请求不带 `_meta` 时兜底。纯离线，
 * 不联网、不跑 agy.exe，用 mountMcpEndpoint + 假 HTTP 载体直调 handler。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mountMcpEndpoint } from '../lib/mcp/endpoint.js'

/** 假 HTTP 载体：登记路由并暴露 handler。 */
function fakeWebServer() {
  const state = { handler: undefined }
  return {
    state,
    port: 43117,
    host: '127.0.0.1',
    register(route) {
      state.handler = route.handler
      return () => { state.handler = undefined }
    },
  }
}

/** 构造一个最小 IncomingMessage/ServerResponse 替身。 */
function fakeReqRes(token, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  const req = {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]() {
      let i = 0
      return { next: () => (i < chunks.length ? { value: chunks[i++], done: false } : { value: undefined, done: true }) }
    },
  }
  let resBody = ''
  const res = {
    writeHead(status, headers) { res.status = status; res.headers = headers },
    end(text) { if (text !== undefined) resBody += text; res.done = true },
  }
  return { req, res, getResBody: () => resBody }
}

test('crosstalk: 请求自带 _meta.sessionId 时，全局 handle 被并发回合覆写不改变归属', async () => {
  const web = fakeWebServer()
  const seenSessions = []
  const endpoint = mountMcpEndpoint(web, {
    serverName: 'test',
    serverVersion: '0.0.0',
    instructions: '',
    listTools: async sessionId => {
      seenSessions.push(sessionId)
      return []
    },
    callTool: async () => ({ content: [], isError: false }),
  })
  const handler = web.state.handler
  assert.equal(typeof handler, 'function')

  // 回合 A 开始：agy.ts stream() 覆写全局 handle。
  endpoint.setSession('sess-A')
  // 回合 B 开始（A 的 MCP 请求还没到）：全局 handle 被 B 覆写。
  endpoint.setSession('sess-B')
  // 回合 A 的 tools/list 此刻才到达 endpoint；AGY 在每个请求上自带
  // _meta.sessionId 自证归属。
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: { _meta: { sessionId: 'sess-A' } },
  })
  const { req, res } = fakeReqRes(endpoint.token, body)
  await handler(req, res)

  assert.equal(seenSessions.length, 1)
  // 修后：A 的请求归属 sess-A，即使全局 handle 已被 sess-B 覆写。
  assert.equal(seenSessions[0], 'sess-A')
  endpoint.dispose()
})

test('fallback: 请求不带 _meta 时归属退回 transport handle（语义不回归）', async () => {
  const web = fakeWebServer()
  const seenSessions = []
  const endpoint = mountMcpEndpoint(web, {
    serverName: 'test',
    serverVersion: '0.0.0',
    instructions: '',
    listTools: async sessionId => {
      seenSessions.push(sessionId)
      return []
    },
    callTool: async () => ({ content: [], isError: false }),
  })
  const handler = web.state.handler

  endpoint.setSession('sess-handle')
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  const { req, res } = fakeReqRes(endpoint.token, body)
  await handler(req, res)

  assert.equal(seenSessions.length, 1)
  assert.equal(seenSessions[0], 'sess-handle')
  endpoint.dispose()
})
