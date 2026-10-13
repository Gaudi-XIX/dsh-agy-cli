/**
 * Register the DSH tool bridge as an MCP server inside the AGY CLI.
 *
 * AGY keeps its MCP server table in its own config root
 * (`~/.gemini/antigravity-cli/gemini-root-config/`, see {@link agyConfigRoot}),
 * so this is the one place where the plugin writes outside the DSH profile.
 * Three rules keep that honest:
 *
 * 1. every write is attributed — the entry is named and tagged by this plugin,
 *    so it can be identified again on the next start;
 * 2. registration is bound to the plugin lifecycle: the entry is written when
 *    the provider becomes active and removed when it stops, so uninstalling or
 *    disabling the plugin does not leave a live endpoint behind;
 * 3. an allow rule is written alongside the entry, because headless AGY cannot
 *    prompt for the `mcp` permission and auto-denies every MCP call without one
 *    (stderr: `a tool required the "mcp" permission that headless mode cannot
 *    prompt for, so it was auto-denied`). The rule is scoped to
 *    `mcp(<server>/<tool>)` per exposed tool: `mcp(<server>)` alone does not
 *    match, and `mcp(*)` would hand AGY every MCP server on the machine.
 *
 * The edit is a read-modify-write of the AGY config with a backup, matching
 * what the AGY CLI itself does for `agy mcp add`. The AGY CLI is used only to
 * locate the config root, never to mutate it: `agy mcp add` cannot express the
 * "replace my previous entry" semantics this needs, and it has no equivalent
 * for the permission rules.
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
  /** Exposed tool names, used to scope the AGY-side allow rules. */
  readonly toolNames?: readonly string[]
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

/**
 * The directory AGY actually reads `mcp_config.json`, `settings.json` and
 * `agents/` from.
 *
 * It is the `gemini-root-config` child of the CLI data directory, not the data
 * directory itself: the CLI keeps session state at
 * `~/.gemini/antigravity-cli/` and a second, differently-populated
 * `mcp_config.json` there, but `agy mcp list` and `agy agents` only ever read
 * the nested root. Writing the outer copy is silently ignored — the file looks
 * correct on disk while AGY reports `No MCP servers configured`.
 *
 * `HOME`/`USERPROFILE` overrides do not relocate this either: the CLI resolves
 * it through the Windows known-folder API, so tests must pass `configRoot`
 * rather than trying to sandbox the process environment.
 */
export function agyConfigRoot(): string {
  const explicit = process.env.DSH_AGY_CONFIG_ROOT
  if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit.trim()
  return join(homedir(), '.gemini', 'antigravity-cli', 'gemini-root-config')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mcpConfigPath(options: AgyMcpRegistrationOptions): string {
  return join(options.configRoot ?? agyConfigRoot(), 'mcp_config.json')
}

function settingsPath(options: AgyMcpRegistrationOptions): string {
  return join(options.configRoot ?? agyConfigRoot(), 'settings.json')
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

/** One allow rule per exposed tool: `mcp(<server>)` alone does not match. */
export function agyAllowRule(toolName: string): string {
  return `mcp(${AGY_MCP_SERVER_NAME}/${toolName})`
}

function isAllowRuleForThisBridge(rule: string): boolean {
  return rule.startsWith(`mcp(${AGY_MCP_SERVER_NAME}/`)
}

/**
 * Read the AGY settings file. A file that exists but cannot be parsed is an
 * error rather than an empty document: overwriting it would drop the user's
 * trusted workspaces and unrelated permission rules.
 */
async function readSettings(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isRecord(parsed) ? { ...parsed } : {}
  } catch (error) {
    throw new Error(`AGY settings at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Add this bridge's allow rules to the AGY settings, replacing any rules left
 * by a previous run and preserving every other entry verbatim.
 */
async function writeAllowRules(
  rules: readonly string[],
  options: AgyMcpRegistrationOptions,
): Promise<string> {
  const path = settingsPath(options)
  const root = await readSettings(path)
  const permissions = isRecord(root.permissions) ? { ...root.permissions } : {}
  const existing = Array.isArray(permissions.allow) ? permissions.allow : []
  const foreign = existing.filter(
    (rule): rule is string => typeof rule === 'string' && !isAllowRuleForThisBridge(rule),
  )
  if (rules.length === 0 && foreign.length === existing.length) return path
  permissions.allow = [...foreign, ...rules]
  await writeConfig(path, { ...root, permissions })
  options.logger?.(`allowed ${rules.length} AGY MCP tool(s) in ${path}`)
  return path
}

/** Drop this bridge's allow rules, leaving foreign rules untouched. */
async function clearAllowRules(options: AgyMcpRegistrationOptions): Promise<boolean> {
  const path = settingsPath(options)
  if (!existsSync(path)) return false
  const root = await readSettings(path)
  if (!isRecord(root.permissions)) return false
  const permissions = { ...root.permissions }
  const existing = Array.isArray(permissions.allow) ? permissions.allow : []
  const foreign = existing.filter(
    (rule): rule is string => typeof rule === 'string' && !isAllowRuleForThisBridge(rule),
  )
  if (foreign.length === existing.length) return false
  if (foreign.length === 0) delete permissions.allow
  else permissions.allow = foreign
  if (Object.keys(permissions).length === 0) delete root.permissions
  else root.permissions = permissions
  await writeConfig(path, root)
  options.logger?.(`removed this plugin's AGY allow rules from ${path}`)
  return true
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
  await writeAllowRules((entry.toolNames ?? []).map(agyAllowRule), options)
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
  if (current === undefined) {
    // The entry can be gone while the allow rules survive a crashed session;
    // clearing them is still this plugin's job.
    await clearAllowRules(options).catch(() => false)
    return false
  }
  // Only remove an entry this plugin wrote; a user-managed server that happens
  // to be named "dsh" is theirs to keep.
  if (!isOwnedEntry(current)) {
    options.logger?.(`AGY MCP server "${AGY_MCP_SERVER_NAME}" is not owned by this plugin; leaving it in place`)
    return false
  }
  delete servers[AGY_MCP_SERVER_NAME]
  await writeConfig(path, { ...root, mcpServers: servers })
  options.logger?.(`removed AGY MCP server "${AGY_MCP_SERVER_NAME}" from ${path}`)
  await clearAllowRules(options).catch(() => false)
  return true
}
