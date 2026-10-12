/**
 * Minimal MCP (Model Context Protocol) server-side JSON-RPC layer.
 *
 * DSH ships `@modelcontextprotocol/core`, but that package exports only Zod
 * schemas — it has no `Server` class and no transport. The framing and the
 * three methods AGY actually needs are implemented here, deliberately small:
 * a session-based server (one session per AGY conversation) over newline
 * delimited JSON-RPC 2.0.
 *
 * Wire compatibility notes learned from AGY 1.3.2:
 * - the negotiated protocol version is echoed back from the client, because
 *   AGY rejects a server that answers with a version it did not offer;
 * - a JSON-RPC *notification* (no `id`) must never be answered;
 * - tool failures travel as a normal `tools/call` result with `isError: true`
 *   so the model can react to them instead of seeing a transport error.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export const MCP_ERROR_CODES = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
})

export interface McpTextContent {
  readonly type: 'text'
  readonly text: string
}

export interface McpToolDescriptor {
  readonly name: string
  readonly description: string
  /** JSON Schema for the tool arguments; already sanitized by the caller. */
  readonly inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  readonly content: readonly McpTextContent[]
  readonly isError: boolean
}

export interface McpJsonRpcError {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: '2.0'
  readonly id: string | number
  readonly result?: unknown
  readonly error?: McpJsonRpcError
}

export interface McpInitializeResult {
  readonly protocolVersion: string
  readonly capabilities: Record<string, unknown>
  readonly serverInfo: { readonly name: string; readonly version: string }
  readonly instructions: string
}

export interface McpServerHandlers {
  readonly serverName: string
  readonly serverVersion: string
  readonly instructions: string
  /** Tools exposed for one session; re-read on every `tools/list`. */
  listTools(sessionId: string): Promise<readonly McpToolDescriptor[]>
  /** Execute one tool call for a session. Rejections become `isError` results. */
  callTool(sessionId: string, name: string, args: Record<string, unknown>): Promise<McpCallResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Pick the highest protocol version both sides understand. */
export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === 'string' && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)) {
    return requested
  }
  return MCP_PROTOCOL_VERSION
}

/**
 * One MCP server instance. It is transport agnostic: `handleMessage` takes one
 * decoded JSON-RPC message and returns the response to write back, or
 * `undefined` for notifications.
 */
export class McpServerSession {
  private readonly handlers: McpServerHandlers
  private initialized = false
  private clientInfo: { name?: string; version?: string } | undefined
  private sessionHandle = ''

  constructor(handlers: McpServerHandlers) {
    this.handlers = handlers
  }

  get isInitialized(): boolean {
    return this.initialized
  }

  get client(): { name?: string; version?: string } | undefined {
    return this.clientInfo
  }

  async handleMessage(raw: string, sessionHandle = ''): Promise<McpJsonRpcResponse | undefined> {
    this.sessionHandle = sessionHandle
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        jsonrpc: '2.0',
        id: 0,
        error: { code: MCP_ERROR_CODES.parseError, message: 'Parse error: body is not valid JSON' },
      }
    }
    if (!isRecord(parsed) || parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      return {
        jsonrpc: '2.0',
        id: isRecord(parsed) && (typeof parsed.id === 'string' || typeof parsed.id === 'number') ? parsed.id : 0,
        error: { code: MCP_ERROR_CODES.invalidRequest, message: 'Invalid Request' },
      }
    }
    const id = parsed.id
    const isRequest = typeof id === 'string' || typeof id === 'number'
    try {
      const result = await this.dispatch(parsed.method, isRecord(parsed.params) ? parsed.params : {})
      // Notifications carry no id and must not be answered.
      if (!isRequest) return undefined
      if (result === NOTIFICATION) return undefined
      return { jsonrpc: '2.0', id, result }
    } catch (error) {
      if (!isRequest) return undefined
      if (error instanceof McpRpcError) {
        return { jsonrpc: '2.0', id, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) } }
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: MCP_ERROR_CODES.internalError, message: errorMessage(error) },
      }
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params)
      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'notifications/roots/list_changed':
        return NOTIFICATION
      case 'ping':
        return {}
      case 'tools/list':
        return { tools: await this.handlers.listTools(this.resolveSession(params)) }
      case 'tools/call':
        return this.callTool(params)
      default:
        throw new McpRpcError(MCP_ERROR_CODES.methodNotFound, `Method not found: ${method}`)
    }
  }

  private initialize(params: Record<string, unknown>): McpInitializeResult {
    this.initialized = true
    const clientInfo = params.clientInfo
    this.clientInfo = isRecord(clientInfo)
      ? {
          ...(typeof clientInfo.name === 'string' ? { name: clientInfo.name } : {}),
          ...(typeof clientInfo.version === 'string' ? { version: clientInfo.version } : {}),
        }
      : undefined
    return {
      protocolVersion: negotiateProtocolVersion(params.protocolVersion),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.handlers.serverName, version: this.handlers.serverVersion },
      instructions: this.handlers.instructions,
    }
  }

  private async callTool(params: Record<string, unknown>): Promise<McpCallResult> {
    const name = params.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new McpRpcError(MCP_ERROR_CODES.invalidParams, 'tools/call requires a tool name')
    }
    const rawArguments = params.arguments
    if (rawArguments !== undefined && !isRecord(rawArguments)) {
      throw new McpRpcError(MCP_ERROR_CODES.invalidParams, 'tools/call arguments must be an object')
    }
    try {
      return await this.handlers.callTool(this.resolveSession(params), name, rawArguments ?? {})
    } catch (error) {
      // A failing DSH tool is an expected outcome, not a protocol error: the
      // model has to see the failure text to decide what to do next.
      return { content: [{ type: 'text', text: errorMessage(error) }], isError: true }
    }
  }

  /**
   * Resolve which AGY conversation a request belongs to. The transport-level
   * handle (the secret path segment) wins, because it is what the endpoint
   * minted for this bridge; `_meta.sessionId` is the client's own hint and is
   * used only when the transport supplies nothing.
   */
  private resolveSession(params: Record<string, unknown>): string {
    if (this.sessionHandle.length > 0) return this.sessionHandle
    return sessionOf(params)
  }
}

const NOTIFICATION = Symbol('mcp-notification')

export class McpRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'McpRpcError'
    this.code = code
    this.data = data
  }
}

/**
 * AGY passes its own session handle as `_meta.sessionId` on every request; the
 * HTTP route also carries it in the path. Both are read here so one server can
 * serve several concurrent AGY conversations.
 */
function sessionOf(params: Record<string, unknown>): string {
  const meta = params._meta
  if (isRecord(meta)) {
    const sessionId = meta.sessionId ?? meta.session_id
    if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  }
  return ''
}

/** Serialize one response as a single newline-terminated JSON-RPC frame. */
export function encodeMcpFrame(response: McpJsonRpcResponse): string {
  return `${JSON.stringify(response)}\n`
}
