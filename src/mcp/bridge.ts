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
  validateToolArguments,
  NEVER_PROJECTED_TOOLS,
  type DshToolRegistryLike,
  type ToolProjectionResult,
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
  resolveAgent(sessionId: unknown): Promise<unknown>
}

export interface DshMcpBridgeOptions {
  readonly webServer: DshWebServerLike
  readonly tools: DshToolRuntimeLike
  readonly sessionController?: DshSessionControllerLike | undefined
  /**
   * Late-bound `sessionController` lookup.
   *
   * The bridge starts while this plugin loads, and the Session controller is
   * mounted by a different bundle: reading the service once at start can pin
   * `undefined` for the whole host lifetime, which silently degrades every
   * scoped query to the global tool view (the file and shell tools live on the
   * agent plane). Resolving per turn removes the load-order dependency.
   */
  readonly sessionControllerLookup?: (() => DshSessionControllerLike | undefined) | undefined
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
      listTools: async (sessionHandle) => {
        const agent = await agentOf(options, sessionHandle)
        const projection = projectVisibleTools(options, agent)
        const dropped = projection.excluded.filter(name => !NEVER_PROJECTED_TOOLS.has(name))
        options.logger?.(
          `dsh mcp bridge: listTools session="${sessionHandle}" agent=${agent === undefined ? 'none' : 'resolved'} tools=${projection.tools.length}${dropped.length === 0 ? '' : ` dropped=${dropped.join(',')}`}`,
        )
        return projection.tools
      },
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
        // No tool list travels here on purpose: the allow rule this bridge
        // needs is the server-wide wildcard `mcp(dsh/*)`, so a DSH tool that
        // appears later is covered the moment it shows up in `tools/list`
        // without rewriting the AGY settings file. The per-turn projection in
        // `listTools` is the scoped one that matters.
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

/**
 * Resolve the live Agent for the session this bridge currently serves.
 *
 * The adapter re-points the endpoint at the DSH session before every AGY turn
 * (see the `setSession` call in the provider), and that handle survives across
 * turns, so a direct lookup is enough. Getting the Agent matters twice over: the
 * approval service denies any execution with no agent to route through, and the
 * tool registry answers a *scoped* query with the agent-plane tools (file and
 * shell) that its global view does not contain.
 *
 * A failure to resolve is reported through the bridge logger instead of being
 * swallowed: "the session has no agent" and "the lookup threw" look identical
 * from the outside, and that ambiguity is what made this bug cost a restart.
 */
async function agentOf(
  options: DshMcpBridgeOptions,
  sessionHandle: string,
): Promise<unknown> {
  // The lookup reads a Cordis service that a sibling bundle mounts later;
  // cordis throws on property access while it is not mounted. Degrade to the
  // static controller instead of failing every MCP request with a 500.
  let controller: DshSessionControllerLike | undefined
  try {
    controller = options.sessionControllerLookup?.()
  } catch {
    controller = undefined
  }
  controller ??= options.sessionController
  if (controller === undefined) {
    options.logger?.('dsh mcp bridge: the host sessionController service is unavailable')
    return undefined
  }
  if (sessionHandle.length === 0) return undefined
  const resolved = await controller.resolveAgent(sessionHandle).catch((error: unknown) => {
    const rejection = subagentRejectionIn(error)
    options.logger?.(rejection === undefined
      ? `dsh mcp bridge: resolveAgent("${sessionHandle}") threw ${String(error)}`
      : `dsh mcp bridge: session "${sessionHandle}" is owned by subagent routing (${rejection}); the host refuses an agent handle for a child session by design, so this turn sees the global tool view`)
    return undefined
  })
  const agent = agentIn(resolved)
  if (agent === undefined) {
    options.logger?.(`dsh mcp bridge: no agent resolved for session "${sessionHandle}"`)
  }
  return agent
}

/**
 * Read the host's subagent-ownership rejection out of a thrown value.
 *
 * `sessionController.resolveAgent()` answers `RemoteError('session/agent-busy')`
 * with `reason: 'use subagent delivery for this child session'` for any session
 * whose header carries `origin: 'subagent'` — the host deliberately refuses to
 * hand out an agent handle for a child session. That is a designed boundary, not
 * a bridge defect, so the log says so instead of leaving a bare
 * "no agent resolved" line that reads like a bug every time a subagent runs.
 */
function subagentRejectionIn(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const record = error as { code?: unknown; message?: unknown; details?: { reason?: unknown } | unknown }
  const details = typeof record.details === 'object' && record.details !== null
    ? (record.details as { reason?: unknown })
    : undefined
  const reason = typeof details?.reason === 'string' ? details.reason : undefined
  if (reason !== undefined && /subagent delivery/i.test(reason)) return reason
  const code = typeof record.code === 'string' ? record.code : undefined
  const message = typeof record.message === 'string' ? record.message : undefined
  if (code === 'session/agent-busy' || (message !== undefined && /subagent routing/i.test(message))) {
    return message ?? code ?? 'session/agent-busy'
  }
  return undefined
}

function agentIn(resolved: unknown): unknown {
  if (resolved === undefined || resolved === null) return undefined
  // The host's controller already unwraps: `sessionController.resolveAgent()`
  // returns the Agent itself (it throws `ApiSessionAgentResult.error` instead of
  // handing back a wrapper). Older and mocked shapes carry `{ agent }`, so accept
  // both — but never mistake a thrown-error wrapper for a live agent.
  if (typeof resolved === 'object') {
    const record = resolved as { agent?: unknown; error?: unknown }
    if ('agent' in record) return record.agent
    // A rejection wrapper is not an agent; the host normally throws instead of
    // returning one, but an older build may hand it back as a value.
    if ('error' in record) return undefined
  }
  return resolved
}

async function executeDshTool(
  options: DshMcpBridgeOptions,
  sessionHandle: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpCallResult> {
  // Bridge-level gates first, independent of agent resolution: a tool the
  // projection layer refuses to show must never execute through this bridge.
  // Without this, a session whose agent could not be resolved (subagent
  // routing, controller not mounted) degenerates to the global view, and a
  // never-projected or allowlisted-out name would reach `tools.execute`
  // directly — bypassing the promise tool-projection.ts makes.
  if (NEVER_PROJECTED_TOOLS.has(name)) {
    return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true }
  }
  if (options.toolAllowlist !== undefined && options.toolAllowlist.length > 0
    && !options.toolAllowlist.includes(name)) {
    return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true }
  }
  // No resolvable agent means fail closed, never silently open: the call still
  // goes through `tools.execute()` so the host guard chain sees it, but the host
  // itself decides what an unscoped call may do.
  const agent = await agentOf(options, sessionHandle)
  const projected = projectVisibleTools(options, agent).tools
  const descriptor = projected.find(entry => entry.name === name)
  if (descriptor === undefined) {
    // Only assert "unknown tool" when the projection is the one AGY was shown.
    // With no resolvable agent the scoped list degenerates to the global view,
    // so a legitimate file tool can be missing from it; that call still has to
    // reach the host, which denies it on its own terms instead of us inventing a
    // rejection for a tool we merely failed to see.
    if (agent !== undefined) {
      return { content: [{ type: 'text', text: `unknown tool "${name}"` }], isError: true }
    }
  } else {
    const problems = validateToolArguments(descriptor.inputSchema, args)
    if (problems.length > 0) {
      // Wording mirrors the host's own rejection so AGY sees one consistent
      // failure shape whether the bridge or DSH catches the call.
      return { content: [{ type: 'text', text: `invalid arguments: ${problems.join('; ')}` }], isError: true }
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

/**
 * The same projection `tools/list` advertises, used to pre-check a call.
 * A registry failure yields an empty list, which reads as "unknown tool" —
 * the correct fail-closed direction for a bridge that cannot see what it runs.
 */
function projectVisibleTools(
  options: DshMcpBridgeOptions,
  agent: unknown,
): ToolProjectionResult {
  return projectDshTools(options.tools, {
    ...(options.toolAllowlist === undefined ? {} : { allowlist: options.toolAllowlist }),
    scope: agent,
  })
}

export { AGY_MCP_SERVER_NAME, agyConfigRoot, agySettingsRoot }
