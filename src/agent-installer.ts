import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  getAgentPreset,
  listAgentPresets,
  readAgentPresetTemplate,
  requireAgentPreset,
  type AgentPreset,
  type AgentPresetId,
} from './agent-presets.js'

/**
 * Where the AGY CLI discovers agent templates.
 *
 * This is `gemini-root-config/agents`, not `~/.gemini/config/agents`: the CLI
 * keeps a second, differently-populated `agents` directory under its data root
 * and only scans this one (`agy agents` lists a template added here and ignores
 * one removed from the other). `DSH_AGY_CONFIG_ROOT` mirrors
 * {@link agyConfigRoot} in `mcp/agy-registration.ts`, so pointing AGY at
 * another root moves both the MCP table and the templates together.
 */
export const DEFAULT_AGENT_DIRECTORY = join(
  process.env.DSH_AGY_CONFIG_ROOT?.trim() || join(homedir(), '.gemini', 'antigravity-cli', 'gemini-root-config'),
  'agents',
)

export type AgentInstallAction = 'create' | 'unchanged' | 'conflict' | 'backup-and-create'

export class AgentInstallError extends Error {
  constructor(
    message: string,
    readonly code: 'AGENT_TARGET_EXISTS' | 'AGENT_TARGET_NOT_FILE' | 'AGENT_INSTALL_FAILED',
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'AgentInstallError'
  }
}

export interface AgentInstallOptions {
  preset: AgentPresetId | string
  directory?: string
  apply?: boolean
  backup?: boolean
}

export interface AgentInstallResult {
  preset: AgentPresetId
  agentName: string
  targetPath: string
  applied: boolean
  action: AgentInstallAction
  backupPath?: string
}

function configuredAgentDirectory(directory?: string): string {
  const selected = directory?.trim() || process.env.AGY_AGENT_DIR?.trim() || DEFAULT_AGENT_DIRECTORY
  return resolve(selected)
}

async function targetState(targetPath: string): Promise<{ exists: false } | { exists: true; file: boolean; content?: string }> {
  try {
    const stat = await lstat(targetPath)
    if (!stat.isFile()) return { exists: true, file: false }
    return { exists: true, file: true, content: await readFile(targetPath, 'utf8') }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exists: false }
    throw error
  }
}

function backupPathFor(targetPath: string): string {
  return `${targetPath}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
}

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const directory = resolve(targetPath, '..')
  const tempPath = join(directory, `.${basename(targetPath)}.${randomUUID()}.tmp`)
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(tempPath, targetPath)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    throw new AgentInstallError(
      `Could not install Agent template: ${error instanceof Error ? error.message : String(error)}`,
      'AGENT_INSTALL_FAILED',
      { cause: error },
    )
  }
}

function resultFor(
  preset: AgentPreset,
  targetPath: string,
  applied: boolean,
  action: AgentInstallAction,
  backupPath?: string,
): AgentInstallResult {
  return {
    preset: preset.id,
    agentName: preset.agentName,
    targetPath,
    applied,
    action,
    ...(backupPath === undefined ? {} : { backupPath }),
  }
}

/**
 * Preview or explicitly install one bundled Agent template.
 * Existing files are never overwritten unless both apply and backup are set.
 */
export async function installAgentPreset(options: AgentInstallOptions): Promise<AgentInstallResult> {
  const preset = requireAgentPreset(options.preset)
  const directory = configuredAgentDirectory(options.directory)
  const targetPath = join(directory, preset.fileName)
  const content = await readAgentPresetTemplate(preset)
  const state = await targetState(targetPath)

  if (state.exists && !state.file) {
    throw new AgentInstallError(
      `Agent target is not a regular file: ${targetPath}`,
      'AGENT_TARGET_NOT_FILE',
    )
  }

  if (state.exists && state.content === content) {
    return resultFor(preset, targetPath, options.apply === true, 'unchanged')
  }

  if (state.exists && options.apply !== true) {
    return resultFor(preset, targetPath, false, 'conflict')
  }

  if (state.exists && options.backup !== true) {
    throw new AgentInstallError(
      `Agent target already exists; preview first, then use --backup to preserve it: ${targetPath}`,
      'AGENT_TARGET_EXISTS',
    )
  }

  if (options.apply !== true) {
    return resultFor(preset, targetPath, false, 'create')
  }

  await mkdir(directory, { recursive: true })
  let backupPath: string | undefined
  if (state.exists) {
    backupPath = backupPathFor(targetPath)
    await rename(targetPath, backupPath)
  }

  try {
    await writeAtomic(targetPath, content)
  } catch (error) {
    if (backupPath !== undefined) {
      await rename(backupPath, targetPath).catch(() => undefined)
    }
    throw error
  }

  return resultFor(preset, targetPath, true, backupPath === undefined ? 'create' : 'backup-and-create', backupPath)
}

export interface AgentDirectoryEntry {
  id: AgentPresetId
  agentName: string
  fileName: string
  description: string
  tools: readonly string[]
  writeAccess: boolean
}

/** One bundled template that is not present in the directory AGY scans. */
export interface MissingAgentTemplate {
  readonly preset: AgentPresetId
  readonly agentName: string
  readonly targetPath: string
}

/**
 * Which bundled templates are absent from the AGY agent directory.
 *
 * AGY refuses an unknown profile before it accepts any input, exiting with
 * `error: unknown agent "<name>" (available: ...)`; the adapter then sees a
 * child that died while its stdin was being written and reports
 * `AGY_INPUT_FAILED`, which names the wrong component. Checking the directory up
 * front turns that into one actionable line.
 *
 * Only presence is checked, never the contents: a user who edited their copy of
 * a template meant to, and overwriting it is not this function's business.
 */
export async function findMissingAgentTemplates(
  presets: readonly AgentPreset[],
  directory?: string,
): Promise<readonly MissingAgentTemplate[]> {
  const root = configuredAgentDirectory(directory)
  const missing: MissingAgentTemplate[] = []
  for (const preset of presets) {
    const targetPath = join(root, preset.fileName)
    const state = await targetState(targetPath)
    if (!state.exists || !state.file) missing.push({ preset: preset.id, agentName: preset.agentName, targetPath })
  }
  return missing
}

export function describeAgentPresets(): readonly AgentDirectoryEntry[] {
  return listAgentPresets().map(preset => ({
    id: preset.id,
    agentName: preset.agentName,
    fileName: preset.fileName,
    description: preset.description,
    tools: preset.tools,
    writeAccess: preset.writeAccess,
  }))
}

export function isAgentPreset(value: unknown): value is AgentPresetId {
  return getAgentPreset(value) !== undefined
}
