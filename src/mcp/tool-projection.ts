/**
 * Project the live DSH tool registry into MCP tool descriptors.
 *
 * This is the replacement for the old DSH-owned prompt contract: instead of
 * serializing every tool schema into the prompt (58 KB on a stock profile with
 * 18 bundles, which the 56 KiB prompt budget could not hold), the same schemas
 * travel over MCP and cost zero prompt bytes.
 *
 * The schemas are sanitized by `sanitizeSchema` from the structured tool
 * protocol, so MCP exposure and the legacy envelope agree on exactly which
 * JSON Schema keywords are allowed to leave the host.
 */
import { sanitizeSchema, TOOL_PROTOCOL_LIMITS } from '../provider/tool-protocol.js'
import type { McpToolDescriptor } from './protocol.js'

/** The subset of `ctx.tools` this module needs. */
export interface DshToolRegistryLike {
  schemas(scope?: unknown): readonly unknown[]
}

export interface DshToolSchemaLike {
  readonly name?: unknown
  readonly description?: unknown
  readonly parameters?: unknown
}

export interface ToolProjectionOptions {
  /** Restrict the projection to these tool names (empty/absent = every tool). */
  readonly allowlist?: readonly string[]
  /** Upper bound on projected tools; guards a pathological registry. */
  readonly maxTools?: number
}

export interface ToolProjectionResult {
  readonly tools: readonly McpToolDescriptor[]
  /** Names dropped by the allowlist, the built-in exclusions, or the cap. */
  readonly excluded: readonly string[]
}

/**
 * Tools that must never be projected to AGY. These are either DSH-internal
 * controls that would let AGY steer its own host, or tools whose execution
 * requires a DSH agent identity that an MCP-originated call does not carry.
 */
const NEVER_PROJECTED_TOOLS: ReadonlySet<string> = new Set([
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
])

const FALLBACK_SCHEMA: Record<string, unknown> = Object.freeze({
  type: 'object',
  properties: {},
  additionalProperties: false,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSchemaName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const name = value.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/**
 * Project the registry. `listChanged: false` is advertised to AGY, so the set
 * is snapshotted per request rather than pushed; a profile change simply takes
 * effect on the next turn.
 */
export function projectDshTools(
  registry: DshToolRegistryLike | undefined,
  options: ToolProjectionOptions = {},
): ToolProjectionResult {
  const excluded: string[] = []
  const maxTools = options.maxTools ?? TOOL_PROTOCOL_LIMITS.maxTools
  if (registry === undefined || typeof registry.schemas !== 'function') {
    return { tools: [], excluded }
  }
  let raw: readonly unknown[]
  try {
    raw = registry.schemas() ?? []
  } catch {
    return { tools: [], excluded }
  }
  const allow = options.allowlist === undefined || options.allowlist.length === 0
    ? undefined
    : new Set(options.allowlist)

  const seen = new Set<string>()
  const tools: McpToolDescriptor[] = []
  for (const entry of raw) {
    const name = readSchemaName(entry)
    if (name === undefined) continue
    if (seen.has(name)) continue
    seen.add(name)
    if (NEVER_PROJECTED_TOOLS.has(name)) {
      excluded.push(name)
      continue
    }
    if (allow !== undefined && !allow.has(name)) {
      excluded.push(name)
      continue
    }
    if (tools.length >= maxTools) {
      excluded.push(name)
      continue
    }
    const source = entry as DshToolSchemaLike
    let parameters: Record<string, unknown>
    try {
      const sanitized = sanitizeSchema(source.parameters, 0, `tool ${name}.parameters`)
      parameters = isRecord(sanitized) && sanitized.type === 'object' ? sanitized : { ...FALLBACK_SCHEMA }
    } catch {
      // An unsupported keyword must not remove a working tool from the model's
      // view; fall back to an open object and let DSH validate the arguments.
      parameters = { ...FALLBACK_SCHEMA }
    }
    const description = typeof source.description === 'string' ? source.description : ''
    tools.push({
      name,
      description: description.length > TOOL_PROTOCOL_LIMITS.maxDescriptionLength
        ? description.slice(0, TOOL_PROTOCOL_LIMITS.maxDescriptionLength)
        : description,
      inputSchema: parameters,
    })
  }
  tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { tools, excluded }
}
