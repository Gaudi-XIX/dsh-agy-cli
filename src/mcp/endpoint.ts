/**
 * The MCP endpoint AGY connects to.
 *
 * Mounted on the host's existing HTTP carrier (`ctx.webServer`) rather than a
 * private `node:http` listener: the carrier already owns the loopback bind, the
 * port and the TLS story, and route registration is scoped to the plugin fiber
 * so disabling the plugin removes the endpoint.
 *
 * Security model, in one place:
 * - the route is claimed under a random path segment, so the URL itself is not
 *   guessable;
 * - every request must carry the random bearer token minted at mount time;
 * - only `127.0.0.1`/`::1` peers are served, so a forwarded or reverse-proxied
 *   port cannot reach the endpoint even if the token leaks;
 * - only POST is served;
 * - DSH tool execution still passes the normal tool pipeline, so the host's own
 *   approval and guard rules decide what actually runs.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  encodeMcpFrame,
  McpServerSession,
  type McpCallResult,
  type McpToolDescriptor,
} from './protocol.js'

/** The host's HTTP carrier service (`ctx.webServer`). */
export interface DshWebServerLike {
  /** The listening port; `undefined` before the carrier finishes listening. */
  readonly port?: number
  readonly host?: string
  register(route: DshWebRoute): () => void
}

export interface DshWebRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface McpEndpointOptions {
  readonly serverName: string
  readonly serverVersion: string
  readonly instructions: string
  readonly listTools: (sessionId: string) => Promise<readonly McpToolDescriptor[]>
  readonly callTool: (sessionId: string, name: string, args: Record<string, unknown>) => Promise<McpCallResult>
  readonly logger?: (message: string) => void
}

export interface McpEndpoint {
  /** Full loopback URL including the secret path segment, or undefined if the
   *  carrier has not reported a port yet. */
  readonly url: string | undefined
  /** Bearer token AGY must send. */
  readonly token: string
  /** Point the endpoint at the DSH session the next AGY turn belongs to. */
  readonly setSession: (sessionId: string) => void
  readonly dispose: () => void
}

const MAX_BODY_BYTES = 4 * 1024 * 1024

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('MCP request body exceeds the bounded limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Claim one MCP route on the host carrier. The returned `dispose` releases the
 * route; callers must invoke it from an effect so a plugin reload cannot leak
 * the registration.
 */
export function mountMcpEndpoint(
  webServer: DshWebServerLike,
  options: McpEndpointOptions,
): McpEndpoint {
  const token = randomBytes(32).toString('hex')
  const routeSegment = randomBytes(16).toString('hex')
  const path = `/api/dsh-agy-provider/mcp/${routeSegment}`
  // The AGY conversation this bridge currently serves. AGY sends its own
  // session id when it has one; otherwise the transport handle is this value,
  // which the adapter re-points at the DSH session before each AGY turn.
  let sessionHandle = randomBytes(16).toString('hex')
  const session = new McpServerSession({
    serverName: options.serverName,
    serverVersion: options.serverVersion,
    instructions: options.instructions,
    listTools: sessionHandle => options.listTools(sessionHandle),
    callTool: (sessionHandle, name, args) => options.callTool(sessionHandle, name, args),
  })

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        send(res, 403, 'forbidden', 'text/plain; charset=utf-8')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST', 'content-length': 0 })
        res.end()
        return
      }
      const authorization = req.headers.authorization ?? ''
      const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
      if (!constantTimeEquals(presented, token)) {
        send(res, 401, 'unauthorized', 'text/plain; charset=utf-8')
        return
      }
      const body = await readBody(req)
      if (body.trim().length === 0) {
        send(res, 400, 'empty request body', 'text/plain; charset=utf-8')
        return
      }
      const response = await session.handleMessage(body, sessionHandle)
      if (response === undefined) {
        // Notification: MCP expects 202 with no body.
        res.writeHead(202, { 'content-length': 0 })
        res.end()
        return
      }
      send(res, 200, encodeMcpFrame(response), 'application/json; charset=utf-8')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      options.logger?.(`mcp endpoint error: ${message}`)
      if (!res.headersSent) {
        send(res, 500, message, 'text/plain; charset=utf-8')
      } else {
        res.end()
      }
    }
  }

  const release = webServer.register({ kind: 'exact', path, handler })
  // Read the port lazily: the carrier reports it only after its own listen
  // callback, which may be later than this registration.
  const port = webServer.port
  const host = webServer.host === '0.0.0.0' ? '127.0.0.1' : (webServer.host ?? '127.0.0.1')
  return {
    url: typeof port === 'number' && port > 0 ? `http://${host}:${port}${path}` : undefined,
    token,
    dispose: release,
    setSession: (handle: string) => {
      sessionHandle = handle
    },
  }
}
