/**
 * Register the DSH tool bridge as an MCP server inside the AGY CLI.
 *
 * AGY keeps its MCP server table in its own config root
 * (`~/.gemini/antigravity-cli/mcp_config.json`), so this is the one place where
 * the plugin writes outside the DSH profile. Two rules keep that honest:
 *
 * 1. every write is attributed — the entry is named and tagged by this plugin,
 *    so it can be identified again on the next start;
 * 2. registration is bound to the plugin lifecycle: the entry is written when
 *    the provider becomes active and removed when it stops, so uninstalling or
 *    disabling the plugin does not leave a live endpoint behind.
 *
 * The edit is a read-modify-write of the AGY config with a backup, matching
 * what the AGY CLI itself does for `agy mcp add`. The AGY CLI is used only to
 * locate the config root, never to mutate it: `agy mcp add` cannot express the
 * "replace my previous entry" semantics this needs.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** The MCP server name AGY shows for this bridge. */
export const AGY_MCP_SERVER_NAME = 'dsh'

/** Marks an entry as owned by this plugin so cleanup never touches foreign servers. */
const OWNER_TAG = 'dsh-agy-provider'

export interface AgyMcpEntry {
  readonly url: string
  readonly token: string
}

export interface AgyMcpConfigFile {
  readonly path: string
  readonly root: Record<string, unknown>
}

export interface AgyMcpRegistrationOptions {
  /** Overrides the AGY config root; tests pass a temporary directory. */
  readonly configRoot?: string
  readonly logger?: (message: string) => void
}

/** The AGY config root, which follows the same junction as the rest of AGY's data. */
export function agyConfigRoot(): string {
  const explicit = process.env.DSH_AGY_CONFIG_ROOT
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  return join(homedir(), '.gemini', 'antigravity-cli')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mcpConfigPath(options: AgyMcpRegistrationOptions): string {
  return join(options.configRoot ?? agyConfigRoot(), 'mcp_config.json')
}

async function readConfig(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return { mcpServers: {} }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!isRecord(parsed)) return { mcpServers: {} }
    const servers = parsed.mcpServers
    return { ...parsed, mcpServers: isRecord(servers) ? { ...servers } : {} }
  } catch (error) {
    // Never overwrite a config that exists but cannot be parsed: that file is
    // the user's, and silently replacing it would drop their other servers.
    throw new Error(`AGY MCP config at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** True when the entry was written by this plugin. */
export function isOwnedEntry(value: unknown): boolean {
  if (!isRecord(value)) return false
  const headers = value.headers
  if (!isRecord(headers)) return false
  return headers['x-dsh-owner'] === OWNER_TAG
}

function entryFor(entry: AgyMcpEntry): Record<string, unknown> {
  return {
    type: 'http',
    url: entry.url,
    headers: {
      'x-dsh-owner': OWNER_TAG,
      authorization: `Bearer ${entry.token}`,
    },
  }
}

async function writeConfig(path: string, root: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const backup = `${path}.dsh-agy-provider.bak`
  if (existsSync(path) && !existsSync(backup)) {
    await writeFile(backup, await readFile(path), { encoding: 'utf8' })
  }
  const temporary = `${path}.dsh-agy-provider.tmp`
  await writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, { encoding: 'utf8' })
  await rename(temporary, path)
}

/**
 * Write (or replace) this plugin's AGY MCP server entry. Returns the config
 * path so callers can report it. Foreign entries are preserved untouched.
 */
export async function registerAgyMcpServer(
  entry: AgyMcpEntry,
  options: AgyMcpRegistrationOptions = {},
): Promise<AgyMcpConfigFile> {
  const path = mcpConfigPath(options)
  const root = await readConfig(path)
  const servers = root.mcpServers as Record<string, unknown>
  servers[AGY_MCP_SERVER_NAME] = entryFor(entry)
  await writeConfig(path, { ...root, mcpServers: servers })
  options.logger?.(`registered AGY MCP server "${AGY_MCP_SERVER_NAME}" at ${path}`)
  return { path, root }
}

/**
 * Remove this plugin's AGY MCP server entry, leaving every other entry alone.
 * Returns true when an entry was actually removed.
 */
export async function unregisterAgyMcpServer(
  options: AgyMcpRegistrationOptions = {},
): Promise<boolean> {
  const path = mcpConfigPath(options)
  if (!existsSync(path)) return false
  const root = await readConfig(path)
  const servers = root.mcpServers as Record<string, unknown>
  const current = servers[AGY_MCP_SERVER_NAME]
  if (current === undefined) return false
  // Only remove an entry this plugin wrote; a user-managed server that happens
  // to be named "dsh" is theirs to keep.
  if (!isOwnedEntry(current)) {
    options.logger?.(`AGY MCP server "${AGY_MCP_SERVER_NAME}" is not owned by this plugin; leaving it in place`)
    return false
  }
  delete servers[AGY_MCP_SERVER_NAME]
  await writeConfig(path, { ...root, mcpServers: servers })
  options.logger?.(`removed AGY MCP server "${AGY_MCP_SERVER_NAME}" from ${path}`)
  return true
}
