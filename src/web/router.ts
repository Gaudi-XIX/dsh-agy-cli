import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Config as ConfigType } from '../provider/config.js'
import { configuredModels } from '../provider/config.js'
import type { AgyModelDiscovery } from '../agy/models.js'
import type { DshWebServerLike } from '../mcp/endpoint.js'

interface QuotaModelEntry {
  remainingFraction?: number
  resetTime?: string
}

interface FamilyQuotaModelEntry {
  modelId: string
  displayName?: string
  remainingFraction?: number
  resetTime?: string
}

interface FamilyQuotaInfo {
  remainingFraction?: number
  resetTime?: string
  weeklyFraction?: number
  weeklyResetTime?: string
  description?: string
  updatedAt?: number
  models?: FamilyQuotaModelEntry[]
}

const RUNTIME_OVERRIDES_PATH = join(homedir(), '.dsh', 'agy-link', 'runtime-overrides.json')
const CORDIS_PATCH_PATH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

function readOverrides(): { hiddenModels: string[]; defaultEffort?: string; defaultModel?: string } {
  try {
    if (existsSync(RUNTIME_OVERRIDES_PATH)) {
      const data = JSON.parse(readFileSync(RUNTIME_OVERRIDES_PATH, 'utf8'))
      return {
        hiddenModels: Array.isArray(data.hiddenModels) ? data.hiddenModels : [],
        defaultEffort: typeof data.defaultEffort === 'string' ? data.defaultEffort : undefined,
        defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : undefined,
      }
    }
  } catch {}
  return { hiddenModels: [] }
}

function saveOverrides(overrides: { hiddenModels?: string[]; defaultEffort?: string; defaultModel?: string }): void {
  try {
    const current = readOverrides()
    const merged = { ...current, ...overrides }
    mkdirSync(dirname(RUNTIME_OVERRIDES_PATH), { recursive: true })
    writeFileSync(RUNTIME_OVERRIDES_PATH, JSON.stringify(merged, null, 2), 'utf8')
  } catch {}
}

function updateCordisPatch(visibleModels?: string[], defaultModel?: string): void {
  try {
    if (!existsSync(CORDIS_PATCH_PATH)) return
    let content = readFileSync(CORDIS_PATCH_PATH, 'utf8')
    const providerRegex = /(- id: dsh-agy-provider[\s\S]*?)(?=\n- id:|\n[a-zA-Z]|\Z)/
    const match = content.match(providerRegex)
    if (!match) return

    let block = match[1]!
    if (defaultModel) {
      block = block.replace(/(model:\s*)[^\r\n]+/, `$1${defaultModel}`)
    }
    if (visibleModels) {
      const lines = visibleModels.map((m) => `      - ${m}`).join('\n')
      const visibleRegex = /visibleModels:(\s*\n(\s+-[^\r\n]+\n*)*)/
      if (visibleRegex.test(block)) {
        block = block.replace(visibleRegex, `visibleModels:\n${lines}\n`)
      }
    }
    content = content.replace(providerRegex, block)
    writeFileSync(CORDIS_PATCH_PATH, content, 'utf8')
  } catch {}
}

const WIN_CRED_SCRIPT = `
param($target)
$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinCredHost {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  public static string Read(string target) {
    IntPtr ptr;
    if (CredRead(target, 1, 0, out ptr)) {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      CredFree(ptr);
      return System.Convert.ToBase64String(b);
    }
    return null;
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
[Console]::Out.Write([WinCredHost]::Read($target))
`

interface KeyringIdentity {
  accessToken: string | null
  email?: string | undefined
  name?: string | undefined
}

function readIdentityFromKeyring(): KeyringIdentity {
  if (process.platform !== 'win32') return { accessToken: null }
  try {
    const b64 = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, 'gemini:antigravity'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    if (!b64) return { accessToken: null }
    const jsonStr = Buffer.from(b64, 'base64').toString('utf8')
    const parsed = JSON.parse(jsonStr)
    const accessToken = parsed?.token?.access_token ?? null

    let email: string | undefined
    let name: string | undefined
    const idToken = parsed?.id_token || parsed?.token?.id_token
    if (typeof idToken === 'string') {
      try {
        const parts = idToken.split('.')
        const p1 = parts[1]
        if (p1) {
          const payload = JSON.parse(Buffer.from(p1, 'base64').toString('utf8'))
          email = typeof payload?.email === 'string' ? payload.email : undefined
          name = typeof payload?.name === 'string' ? payload.name : undefined
        }
      } catch {}
    }

    return { accessToken, email, name }
  } catch {
    return { accessToken: null }
  }
}

function readAccessTokenFromKeyring(): string | null {
  return readIdentityFromKeyring().accessToken
}

function fetchHttpsThroughHttpProxy(targetUrlStr: string, accessToken: string, proxyUrl = 'http://127.0.0.1:12450'): Promise<any> {
  return new Promise((resolve, reject) => {
    try {
      const targetUrl = new URL(targetUrlStr)
      const proxy = new URL(proxyUrl)

      const connectReq = http.request({
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: `${targetUrl.hostname}:443`,
        timeout: 10000,
      })

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy()
          reject(new Error(`Proxy CONNECT failed with status: ${res.statusCode}`))
          return
        }

        const tlsSocket = tls.connect(
          {
            socket,
            servername: targetUrl.hostname,
          },
          () => {
            const body = JSON.stringify({})
            const httpsReq = https.request(
              {
                host: targetUrl.hostname,
                path: targetUrl.pathname + targetUrl.search,
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  'Content-Type': 'application/json',
                  'User-Agent': 'antigravity/1.3.2 (windows; amd64)',
                  'Content-Length': Buffer.byteLength(body),
                },
                createConnection: () => tlsSocket,
                timeout: 10000,
              },
              (httpsRes) => {
                const chunks: Buffer[] = []
                httpsRes.on('data', (d) => chunks.push(d))
                httpsRes.on('end', () => {
                  try {
                    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    resolve(parsed)
                  } catch (e) {
                    reject(e)
                  }
                })
              },
            )

            httpsReq.on('error', (err) => reject(err))
            httpsReq.write(body)
            httpsReq.end()
          },
        )

        tlsSocket.on('error', (err) => reject(err))
      })

      connectReq.on('error', (err) => reject(err))
      connectReq.end()
    } catch (e) {
      reject(e)
    }
  })
}

let cachedQuotas: Partial<Record<'google' | 'anthropic' | 'openai', FamilyQuotaInfo>> = {}
let lastQuotaFetchTime = 0
let dynamicCatalogModels: Array<{ id: string; name: string }> = []

async function refreshQuotas(force = false): Promise<Partial<Record<'google' | 'anthropic' | 'openai', FamilyQuotaInfo>>> {
  const now = Date.now()
  if (!force && now - lastQuotaFetchTime < 30_000 && Object.keys(cachedQuotas).length > 0) {
    return cachedQuotas
  }

  const token = readAccessTokenFromKeyring()
  if (!token) return cachedQuotas

  try {
    const raw = await fetchHttpsThroughHttpProxy('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', token)
    if (raw && typeof raw === 'object' && raw.models) {
      const models = raw.models as Record<string, { displayName?: string; quotaInfo?: QuotaModelEntry }>
      const googleModels: FamilyQuotaModelEntry[] = []
      const anthropicModels: FamilyQuotaModelEntry[] = []
      const openaiModels: FamilyQuotaModelEntry[] = []
      const discoveredList: Array<{ id: string; name: string }> = []

      for (const [id, m] of Object.entries(models)) {
        const info = m?.quotaInfo
        const displayName = (m as any)?.displayName || id
        discoveredList.push({ id, name: displayName })

        const entry: FamilyQuotaModelEntry = {
          modelId: id,
          displayName,
          remainingFraction: typeof info?.remainingFraction === 'number' ? info.remainingFraction : 1,
          ...(info?.resetTime ? { resetTime: info.resetTime } : {}),
        }
        const lower = id.toLowerCase()
        if (lower.includes('claude')) anthropicModels.push(entry)
        else if (lower.includes('gpt')) openaiModels.push(entry)
        else googleModels.push(entry)
      }

      if (discoveredList.length > 0) {
        dynamicCatalogModels = discoveredList
      }

      const calcFamily = (list: FamilyQuotaModelEntry[]): FamilyQuotaInfo => {
        const remaining = list.length > 0 ? Math.min(...list.map((x) => x.remainingFraction ?? 1)) : 1
        const resetEntry = list.find((x) => x.resetTime)
        return {
          remainingFraction: remaining,
          ...(resetEntry?.resetTime ? { resetTime: resetEntry.resetTime } : {}),
          weeklyFraction: remaining,
          updatedAt: now,
          models: list,
        }
      }

      cachedQuotas = {
        google: calcFamily(googleModels),
        anthropic: calcFamily(anthropicModels),
        openai: calcFamily(openaiModels),
      }
      lastQuotaFetchTime = now
    }
  } catch {}

  return cachedQuotas
}

const DEFAULT_CATALOG_MODELS = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', name: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

export function setupWebRoutes(ctx: Context, activeConfig: ConfigType, modelDiscovery?: AgyModelDiscovery): () => void {
  const disposers: Array<() => void> = []

  ctx.inject(['webServer'], (innerCtx) => {
    const webServer = (innerCtx as unknown as { webServer: DshWebServerLike }).webServer
    if (!webServer || typeof webServer.register !== 'function') return

    const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }

    const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> => {
      return new Promise((resolve) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          try {
            const v = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
          } catch {
            resolve({})
          }
        })
      })
    }

    const reg = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => {
      const d = webServer.register({ kind: 'exact', path, handler })
      if (typeof d === 'function') disposers.push(d)
    }

    // 1. GET /plugins/agy-link/status
    reg('/plugins/agy-link/status', async (_req, res) => {
      const overrides = readOverrides()
      const quotas = await refreshQuotas(false)

      let discovered = dynamicCatalogModels.length > 0 ? [...dynamicCatalogModels] : [...DEFAULT_CATALOG_MODELS]
      if (modelDiscovery) {
        try {
          const configured = configuredModels(activeConfig)
          const disc = await modelDiscovery.discover(configured)
          if (disc?.models && disc.models.length > 0) {
            const set = new Set(discovered.map((m) => m.id))
            for (const dm of disc.models) {
              if (!set.has(dm.id)) {
                discovered.push({ id: dm.id, name: dm.name ?? dm.id })
              }
            }
          }
        } catch {}
      }

      let hidden = overrides.hiddenModels
      if (hidden.length === 0 && Array.isArray(activeConfig.visibleModels) && activeConfig.visibleModels.length > 0) {
        hidden = discovered.map((m) => m.id).filter((id) => !activeConfig.visibleModels!.includes(id))
      }

      const defaultModel = overrides.defaultModel ?? activeConfig.model ?? 'gemini-3.8-flash'
      const defaultEffort = overrides.defaultEffort ?? 'high'

      const identity = readIdentityFromKeyring()
      const accountAlias = identity.email
        ? `${identity.name ? `${identity.name} ` : ''}(${identity.email})`
        : '本机主账号 (gemini:antigravity)'

      sendJson(res, 200, {
        plugin: 'dsh-agy-provider',
        bin: activeConfig.agyPath || 'F:\\AgentData\\antigravity\\cli\\agy.exe',
        version: '1.3.2',
        enabled: activeConfig.enabled ?? true,
        permissionMode: 'dsh-owned',
        workspaceRoot: '',
        defaultModel,
        defaultEffort,
        auth: {
          phase: 'signed_in',
          message: 'Windows Credential Manager (gemini:antigravity) 就绪',
        },
        pool: {
          version: 1,
          mode: 'sequential',
          defaultCooldownMs: 900000,
          maxCooldownMs: 3600000,
          primaryAccountId: 'primary',
          activeAccountId: 'primary',
          accounts: [
            {
              id: 'primary',
              alias: accountAlias,
              email: identity.email,
              defaultAlias: false,
              dir: '',
              systemHome: true,
              enabled: true,
              createdAt: Date.now(),
              cooldowns: {},
              quotas,
            },
          ],
        },
        catalog: { source: 'agy models', count: discovered.length, lastError: null },
        catalogModels: discovered,
        hiddenModels: hidden,
        bindings: 1,
        lastRun: null,
      })
    })

    // 2. POST /plugins/agy-link/config
    reg('/plugins/agy-link/config', async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'POST only' })
        return
      }

      const body = await readBody(req)
      const key = typeof body.key === 'string' ? body.key : ''
      const value = body.value

      if (key === 'hiddenModels' && Array.isArray(value)) {
        saveOverrides({ hiddenModels: value })
        const discovered = DEFAULT_CATALOG_MODELS.map((m) => m.id)
        const visible = discovered.filter((id) => !value.includes(id))
        updateCordisPatch(visible)
        sendJson(res, 200, { ok: true, key, value })
        return
      }

      if (key === 'defaultEffort' && typeof value === 'string') {
        saveOverrides({ defaultEffort: value })
        sendJson(res, 200, { ok: true, key, value })
        return
      }

      if (key === 'defaultModel' && typeof value === 'string') {
        saveOverrides({ defaultModel: value })
        updateCordisPatch(undefined, value)
        sendJson(res, 200, { ok: true, key, value })
        return
      }

      sendJson(res, 200, { ok: true, key, value })
    })

    // 3. POST /plugins/agy-link/pool/refresh-quota
    reg('/plugins/agy-link/pool/refresh-quota', async (req, res) => {
      const quotas = await refreshQuotas(true)
      const identity = readIdentityFromKeyring()
      const accountAlias = identity.email
        ? `${identity.name ? `${identity.name} ` : ''}(${identity.email})`
        : '本机主账号 (gemini:antigravity)'

      sendJson(res, 200, {
        ok: true,
        pool: {
          version: 1,
          mode: 'sequential',
          defaultCooldownMs: 900000,
          maxCooldownMs: 3600000,
          primaryAccountId: 'primary',
          activeAccountId: 'primary',
          accounts: [
            {
              id: 'primary',
              alias: accountAlias,
              email: identity.email,
              defaultAlias: false,
              dir: '',
              systemHome: true,
              enabled: true,
              createdAt: Date.now(),
              cooldowns: {},
              quotas,
            },
          ],
        },
      })
    })

    // 4. GET & POST /plugins/agy-link/auth
    reg('/plugins/agy-link/auth', (_req, res) => {
      sendJson(res, 200, { phase: 'signed_in', message: '已通过 Windows 凭据管理器授权' })
    })
  })

  return () => {
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
  }
}
