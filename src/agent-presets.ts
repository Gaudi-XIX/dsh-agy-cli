import { readFile } from 'node:fs/promises'

export const AGENT_PRESET_IDS = ['tool-free', 'mcp-executor', 'image-view', 'read-only', 'workspace-write'] as const
export type AgentPresetId = typeof AGENT_PRESET_IDS[number]
export type AgentExecutionMode = 'plan' | 'accept-edits'

export interface AgentPreset {
  readonly id: AgentPresetId
  readonly agentName: string
  readonly fileName: string
  readonly description: string
  readonly tools: readonly string[]
  readonly writeAccess: boolean
  readonly mode: AgentExecutionMode | undefined
}

const PRESETS: Readonly<Record<AgentPresetId, AgentPreset>> = Object.freeze({
  'tool-free': Object.freeze({
    id: 'tool-free',
    agentName: 'dsh-agy-tool-free',
    fileName: 'dsh-agy-tool-free.md',
    description: 'Text-only reasoning with no AGY tools.',
    tools: Object.freeze([]),
    writeAccess: false,
    mode: undefined,
  }),
  'mcp-executor': Object.freeze({
    id: 'mcp-executor',
    agentName: 'dsh-agy-mcp-executor',
    fileName: 'dsh-agy-mcp-executor.md',
    // `excludeDefaultComponents: true` in the template is what removes the
    // built-in tools; `tools: []` alone does not. Measured against AGY 1.3.2:
    // an otherwise identical template carrying only `tools: []` still exposed
    // all 60 built-ins, and the model called `run_command`, which headless mode
    // then soft-denied, producing an empty response. A tool that does not exist
    // cannot be called, which is the only reliable way to keep AGY's own
    // executors out of the loop — an agent template that merely asks the model
    // not to use them is bypassed probabilistically.
    description: 'All actions through the DSH MCP server; no AGY built-in tools.',
    tools: Object.freeze([]),
    writeAccess: false,
    mode: undefined,
  }),
  'image-view': Object.freeze({
    id: 'image-view',
    agentName: 'dsh-agy-image-view',
    fileName: 'dsh-agy-image-view.md',
    description: 'Per-request image inspection with only view_file enabled.',
    tools: Object.freeze(['view_file']),
    writeAccess: false,
    mode: 'plan',
  }),
  'read-only': Object.freeze({
    id: 'read-only',
    agentName: 'dsh-agy-read-only',
    fileName: 'dsh-agy-read-only.md',
    description: 'Read-only workspace inspection and search.',
    tools: Object.freeze(['find_by_name', 'grep_search', 'view_file', 'list_dir']),
    writeAccess: false,
    mode: 'plan',
  }),
  'workspace-write': Object.freeze({
    id: 'workspace-write',
    agentName: 'dsh-agy-workspace-write',
    fileName: 'dsh-agy-workspace-write.md',
    description: 'Bounded file edits inside an explicitly configured workspace.',
    tools: Object.freeze([
      'find_by_name',
      'grep_search',
      'view_file',
      'list_dir',
      'multi_replace_file_content',
      'replace_file_content',
      'write_to_file',
    ]),
    writeAccess: true,
    mode: 'accept-edits',
  }),
})

export function listAgentPresets(): readonly AgentPreset[] {
  return AGENT_PRESET_IDS.map(id => PRESETS[id])
}

export function getAgentPreset(value: unknown): AgentPreset | undefined {
  if (typeof value !== 'string') return undefined
  return (AGENT_PRESET_IDS as readonly string[]).includes(value)
    ? PRESETS[value as AgentPresetId]
    : undefined
}

export function requireAgentPreset(value: string): AgentPreset {
  const preset = getAgentPreset(value)
  if (preset === undefined) {
    throw new TypeError(`Unknown Agent preset: ${value}. Expected one of: ${AGENT_PRESET_IDS.join(', ')}`)
  }
  return preset
}

/**
 * The Agent templates one request can reach, given the effective settings.
 *
 * AGY resolves `--agent` itself and exits with `unknown agent` when the named
 * profile has no template on disk, so the set that must exist is derivable from
 * the config without starting anything:
 *
 * - `dsh-owned` pins the executor preset, but an image-bearing request swaps in
 *   the image preset, so an enabled `imageInput: experimental` adds it;
 * - every other tool policy uses the configured `agent` string verbatim. That
 *   string is matched against the bundled names first, because a user who typed
 *   `dsh-agy-read-only` is naming a bundled template and deserves the same
 *   presence check; an unmatched name is returned with no preset so callers can
 *   see it is the user's own template to keep in place.
 */
export function agentTemplatesForRequest(options: {
  readonly toolPolicy: 'reject' | 'agy-owned' | 'dsh-owned'
  readonly agentPreset?: AgentPresetId | undefined
  readonly agent?: string | undefined
  readonly imageInput?: 'off' | 'experimental' | undefined
}): readonly { readonly preset: AgentPreset | undefined; readonly agentName: string }[] {
  const names: { preset: AgentPreset | undefined; agentName: string }[] = []
  const push = (preset: AgentPreset | undefined, agentName: string | undefined): void => {
    if (agentName === undefined || names.some(entry => entry.agentName === agentName)) return
    names.push({ preset, agentName })
  }

  if (options.toolPolicy === 'dsh-owned') {
    const executor = getAgentPreset('mcp-executor')
    push(executor, executor?.agentName)
    if (options.imageInput === 'experimental') {
      const image = getAgentPreset('image-view')
      push(image, image?.agentName)
    }
    return names
  }

  const byPresetId = options.agentPreset === undefined ? undefined : getAgentPreset(options.agentPreset)
  if (byPresetId !== undefined) {
    push(byPresetId, byPresetId.agentName)
    return names
  }
  const byName = options.agent === undefined
    ? undefined
    : listAgentPresets().find(preset => preset.agentName === options.agent || preset.id === options.agent)
  push(byName, options.agent)
  return names
}

/** Read a bundled template; the template file is included in the npm tarball. */
export async function readAgentPresetTemplate(value: AgentPresetId | AgentPreset): Promise<string> {
  const preset = typeof value === 'string' ? requireAgentPreset(value) : value
  return readFile(new URL(`../agents/${preset.fileName}`, import.meta.url), 'utf8')
}
