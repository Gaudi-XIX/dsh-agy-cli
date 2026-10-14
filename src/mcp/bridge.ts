/**
 * The runtime half of the MCP bridge.
 *
 * `agy-registration.ts` owns the AGY config-file side (write on activate,
 * remove on dispose); this module owns the live half: the projected tool set,
 * the loopback HTTP endpoint on the host's `webServer` carrier, and the
 * `tools/call` round-trip back into the DSH tool pipeline.
 *
 * One deliberate asymmetry: listing tools is dynamic (the DSH registry can
 * change between turns), while execution always goes through
 * `tools.execute()` so the host's guard chain and approval service see every
 * call. The call carries the owning session's live Agent, resolved through
 * `sessionController.resolveAgent()`, because the DSH approval service denies
 * any call that has no agent to route through.
 */
import { randomUUID } from 'node:crypto'
import { mountMcpEndpoint, type DshWebServerLike, type McpEndpoint } from './endpoint.js'
export type { DshWebServerLike, McpEndpoint }
import {
  agyConfigRoot,
  agySettingsRoot,
  registerAgyMcpServer,
  unregisterAgyMcpServer,
  AGY_MCP_SERVER_NAME,
} from './agy-registration.js'
import {
  projectDshTools,
  type DshToolRegistryLike,
} from './tool-projection.js'
import type { McpCallResult, McpTextContent, McpToolDescriptor } from './protocol.js'

/** The subset of the DSH tool registry this bridge uses. */
export interface DshToolRuntimeLike extends DshToolRegistryLike {
  execute(execution: {
    readonly callId: unknown
    readonly name: string
    readonly arguments: unknown
    readonly agent?: unknown
    readonly signal: AbortSignal
  }): Promise<DshToolExecutionResultLike>
}

export interface DshToolExecutionResultLike {
  readonly isError: boolean
  readonly error?: { readonly message?: unknown } | undefined
  readonly value?: unknown
  readonly content?: readonly unknown[]
}

/** The host service that resolves a session id to its live Agent. */
export interface DshSessionControllerLike {
  resolveAgent(sessionId: unknown): Promise<{ readonly agent?: unknown } | { readonly error?: unknown }>
}

export interface DshMcpBridgeOptions {
  readonly webServer: DshWebServerLike
  readonly tools: DshToolRuntimeLike
  readonly sessionController?: DshSessionControllerLike | undefined
  /** Optional allowlist of DSH tool names exposed to AGY. */
  readonly toolAllowlist?: readonly string[] | undefined
  readonly serverVersion: string
  /** Overrides the AGY MCP-config root; tests pass a temporary directory. */
  readonly agyConfigRoot?: string | undefined
  /**
   * Overrides the AGY settings root. `agySettingsRoot()` is the production
   * default (the outer directory); this knob only exists so a test can
   * keep both files in one temporary directory.
   */
  readonly agySettingsRoot?: string | undefined
  readonly logger?: (message: string) => void
}

export interface DshMcpBridge {
  /** The bridge is live: endpoint mounted and AGY config entry written. */
  readonly active: boolean
  /** Why the bridge is not active, when it is not. */
  readonly inactiveReason: string | undefined
  readonly endpoint: McpEndpoint | undefined
  /** URL AGY reaches the bridge on; undefined until the bridge is live. */
  readonly url: string | undefined
  /** Point the bridge at the DSH session owning the next AGY turn. */
  readonly setSession: (sessionId: string) => void
  readonly dispose: () => Promise<void>
}

const INSTRUCTIONS = [
  'These tools are executed by the DSH host, not by this environment.',
  'Call a tool by its name; the DSH host validates arguments, applies its own',
  'permission policy, and returns the result. A result with isError=true means',
  'the host refused or failed the call — report it instead of retrying blindly.',
].join(' ')

function textOf(block: unknown): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const record = block as Record<string, unknown>
  if (record.type !== 'text' || typeof record.text !== 'string') return undefined
  return record.text
}

function resultToCallResult(result: DshToolExecutionResultLike): McpCallResult {
  if (result.isError) {
    const message = typeof result.error?.message === 'string' ? result.error.message : 'tool execution failed'
    const detail = Array.isArray(result.content)
      ? result.content.map(textOf).filter((part): part is string => part !== undefined).join('\n')
      : ''
    return { content: [{ type: 'text', text: detail.length > 0 ? `${message}\n${detail}` : message }], isError: true }
  }
  const blocks: McpTextContent[] = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      const text = textOf(block)
      blocks.push({ type: 'text', text: text ?? JSON.stringify(block) })
    }
  }
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: result.value === undefined ? '' : JSON.stringify(result.value) })
  }
  return { content: blocks, isError: false }
}

/**
 * Bring the bridge up. Every failure mode resolves to `active: false` with a
 * reason instead of throwing, so the provider can fall back to the prompt
 * contract path when the carrier or the tool registry is not available.
 */
export async function startDshMcpBridge(options: DshMcpBridgeOptions): Promise<DshMcpBridge> {
  const inactive = (reason: string): DshMcpBridge => {
    options.logger?.(`dsh mcp bridge inactive: ${reason}`)
    return {
      active: false,
      inactiveReason: reason,
      endpoint: undefined,
      url: undefined,
      setSession: () => {},
      dispose: async () => {},
    }
  }
  if (options.webServer === undefined || typeof options.webServer.register !== 'function') {
    return inactive('host webServer service is unavailable')
  }
  if (typeof options.tools?.schemas !== 'function' || typeof options.tools?.execute !== 'function') {
    return inactive('host tools service is unavailable')
  }

  let endpoint: McpEndpoint
  try {
    // Project lazily on every `tools/list`: the bridge starts during plugin
    // load, but the file, shell, and web tools only join `ctx.tools` once the
    // agent presets and the remaining services finish mounting. Snapshotting
    // here froze a host that had 18 tools and never exposed the rest.
    if (projectDshTools(options.tools, {
      ...(options.toolAllowlist === undefined ? {} : { allowlist: options.toolAllowlist }),
    }).tools.length === 0) {
      return inactive('host tools service exposed no tools')
    }
    endpoint = mountMcpEndpoint(options.webServer, {
      serverName: AGY_MCP_SERVER_NAME,
      serverVersion: options.serverVersion,
      instructions: INSTRUCTIONS,
      listTools: async () => projectDshTools(options.tools, {
        ...(options.toolAllowlist === undefined ? {} : { allowlist: options.toolAllowlist }),
      }).tools,
      callTool: (sessionHandle, name, args) => executeDshTool(options, sessionHandle, name, args),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    })
  } catch (error) {
    return inactive(`endpoint mount failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (endpoint.url === undefined) {
    endpoint.dispose()
    return inactive('host webServer has not reported a listening port')
  }

  try {
    await registerAgyMcpServer(
      {
        url: endpoint.url,
        token: endpoint.token,
        // The allow rules AGY needs are per tool. `writeAllowRules` only
        // replaces this bridge's own `mcp(dsh/*)` rules, so a later re-read can
        // widen the set without disturbing anything the user added.
        toolNames: projectDshTools(options.tools, {
          ...(options.toolAllowlist === undefined ? {} : { allowlist: options.toolAllowlist }),
        }).tools.map(tool => tool.name),
      },
      {
        ...(options.agyConfigRoot === undefined ? {} : { configRoot: options.agyConfigRoot }),
        ...(options.agySettingsRoot === undefined ? {} : { settingsRoot: options.agySettingsRoot }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
    )
  } catch (error) {
    endpoint.dispose()
    return inactive(`AGY mcp_config.json update failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    active: true,
    inactiveReason: undefined,
    endpoint,
    url: endpoint.url,
    setSession: handle => endpoint.setSession(handle),
    dispose: async () => {
      endpoint.dispose()
      await unregisterAgyMcpServer({
        ...(options.agyConfigRoot === undefined ? {} : { configRoot: options.agyConfigRoot }),
        ...(options.agySettingsRoot === undefined ? {} : { settingsRoot: options.agySettingsRoot }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      }).catch(() => {})
    },
  }
}

async function executeDshTool(
  options: DshMcpBridgeOptions,
  sessionHandle: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  // The AGY session handle is the DSH session id by convention (see the
  // stream() path); resolve it to the live Agent so the approval service has
  // someone to ask. No resolvable agent means fail closed, never silently open.
  let agent: unknown
  if (options.sessionController !== undefined && sessionHandle.length > 0) {
    const resolved = await options.sessionController.resolveAgent(sessionHandle).catch(() => undefined)
    if (resolved !== undefined && typeof resolved === 'object' && 'agent' in resolved) {
      agent = (resolved as { agent: unknown }).agent
    }
  }
  const controller = new AbortController()
  const result = await options.tools.execute({
    callId: randomUUID(),
    name,
    arguments: args,
    ...(agent === undefined ? {} : { agent }),
    signal: controller.signal,
  })
  return resultToCallResult(result)
}

export { AGY_MCP_SERVER_NAME, agyConfigRoot, agySettingsRoot }
