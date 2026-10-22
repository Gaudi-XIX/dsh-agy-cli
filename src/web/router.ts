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
import { readAgyRuntimeOverrides, saveAgyRuntimeOverrides, type AgyRuntimeOverrides } from '../agy/overrides.js'
import { lastKeepaliveOutcome, refreshAgyTokenIfDue } from '../agy/keepalive.js'

interface QuotaModelEntry {
  remainingFraction?: number
  resetTime?: string
}

interface FamilyQuotaModelEntry {
  modelId: string
  displayName?: string
  remainingFraction?: number | undefined
  resetTime?: string | undefined
}

interface FamilyQuotaInfo {
  remainingFraction?: number | undefined
  resetTime?: string | undefined
  weeklyFraction?: number | undefined
  weeklyResetTime?: string | undefined
  description?: string | undefined
  updatedAt?: number | undefined
  models?: FamilyQuotaModelEntry[] | undefined
  /** True when upstream reported no fraction for a window: unknown, not zero. */
  fiveHourUnknown?: boolean | undefined
  weeklyUnknown?: boolean | undefined
}

interface QuotaSummaryBucket {
  bucketId?: string
  displayName?: string
  window?: string
  resetTime?: string
  remainingFraction?: number
  description?: string
  disabled?: boolean
}

interface QuotaSummaryGroup {
  displayName?: string
  description?: string
  buckets?: QuotaSummaryBucket[]
}

interface QuotaSummaryResponse {
  groups?: QuotaSummaryGroup[]
  description?: string
}

const CORDIS_PATCH_PATH = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')

/**
 * Endpoint hosts for the Cloud Code Assist API. The split is not two accounts
 * and not two subscriptions — it is the same consumer OAuth identity read
 * through two hosts, and only `daily` carries real consumption:
 *
 * - `daily-cloudcode-pa.googleapis.com` — the host agy.exe hardcodes for every
 *   `streamGenerateContent` call (verified in every cli-*.log), so it is the
 *   only host whose quota numbers describe what we actually spend. Verified in
 *   `docs/prod-generation-feasibility-20261020.md` §1-3.
 * - `cloudcode-pa.googleapis.com` ("prod") — answers 200 for quota RPCs but
 *   reports `remainingFraction: 1` forever with a resetTime that drifts to
 *   "now + window" on every call (06:05→10-26T22:24Z, 06:40→10-26T22:39Z,
 *   09:58→10-27T01:58Z). Generation against it returns 429 `Resource has been
 *   exhausted` 24/24 in our probes and 0/4 in the A/B alternation, so it is an
 *   empty ledger, not spare capacity. It is kept only as a catalog fallback:
 *   its `fetchAvailableModels` lists 25 models vs daily's 19.
 *
 * Reading prod for display is what made the panel show a fake 100% while the
 * account was actually at 1% and returning 429.
 */
const QUOTA_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'
const QUOTA_ENDPOINT_PROD = 'https://cloudcode-pa.googleapis.com'
const CLOUD_CODE_API_VERSION = '1.4.2'

/**
 * Identity headers. Google returns *different quota payloads* for the same
 * endpoint depending on which client asks: with the terse UA below, daily's
 * `retrieveUserQuotaSummary` omits the Gemini group entirely and returns only
 * the third-party group; with the full CLI identity it returns both groups
 * (probe_ua_identity.mjs: rf=0.008422057, reset 2026-10-23T22:00:21Z). Sending
 * the terse UA is why the panel once read "Gemini 100%" from a host that had no
 * Gemini numbers to give.
 */
const AGY_IDENTITY_HEADERS: Record<string, string> = {
  'User-Agent': `antigravity/cli/${CLOUD_CODE_API_VERSION} (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)`,
  'X-Goog-Api-Client': 'antigravity/cli/1.4.2 aidev_client windows/amd64 consumer',
}

function readOverrides(): AgyRuntimeOverrides {
  return readAgyRuntimeOverrides() ?? { hiddenModels: [] }
}

function saveOverrides(updates: { hiddenModels?: string[]; defaultEffort?: string; defaultModel?: string }): void {
  saveAgyRuntimeOverrides(updates)
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
  /** Epoch ms from `token.expiry`; undefined when the blob has no readable expiry. */
  expiresAtMs?: number | undefined
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
    // `expiry` is the field agy.exe itself compares against before rotating the
    // token, so it is the one reading the panel should trust: no id_token
    // decoding, no guess from `expires_in`.
    const rawExpiry = parsed?.token?.expiry
    const parsedExpiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN
    const expiresAtMs = Number.isFinite(parsedExpiry) ? parsedExpiry : undefined

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

    return { accessToken, email, name, expiresAtMs }
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

      connectReq.on('timeout', () => {
        connectReq.destroy(new Error('Proxy CONNECT timed out after 10000ms'))
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
                  ...AGY_IDENTITY_HEADERS,
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

            httpsReq.on('timeout', () => {
              httpsReq.destroy(new Error('HTTPS pa.googleapis.com timed out after 10000ms'))
            })
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
// The access token the cached snapshot was measured with. Comparing it against
// the live keyring is how a renewed credential invalidates the 30 s cache.
let lastQuotaToken: string | undefined
// Why this exists: the panel needs to tell "credentials expired" apart from
// "no quota data yet". Google answers 401 UNAUTHENTICATED when the OAuth token
// in the Windows keyring has lapsed (agy.exe refreshes it on its next run).
// A silent catch used to turn that into an empty quota card with no hint.
let lastQuotaError: 'unauthorized' | 'network' | null = null

// `refreshQuotas` sits outside `setupWebRoutes` (it is module-level state), but
// renewal needs the live config. setupWebRoutes installs the current one here
// on every call; an unset value simply skips renewal instead of guessing.
let quotaConfig: ConfigType | undefined

// ---- attach diagnostics (Models page) ----
// The host renders `settings.models.provider-card` only for the directory row
// whose `settingsNs` equals the key the client registered, and the plugin's
// three boot registrations are best-effort (a duplicate mount throws and used to
// be swallowed). From outside the browser that made four different failures look
// identical: no directory row, a refused registration, a card the host never
// dispatched, and a card that rendered empty. `/plugins/agy-link/diagnose`
// reports the first two from the host side and the fourth from the browser.
const bootNotes = new Map<string, string>()

/** Record the outcome of one boot registration step (called from apply()). */
export function noteRegistration(step: string, detail: string): void {
  bootNotes.set(step, detail)
}

interface CardPing {
  at: number
  props: string[]
}

const cardPings: CardPing[] = []

/** Record one card mount reported by the browser half. */
export function noteCardPing(props: string[]): void {
  cardPings.push({ at: Date.now(), props })
  if (cardPings.length > 20) cardPings.shift()
}

/** Snapshot for `/plugins/agy-link/diagnose`. */
export function getAttachDiagnostics(): { notes: Record<string, string>; cardPings: CardPing[] } {
  return { notes: Object.fromEntries(bootNotes), cardPings: [...cardPings] }
}

async function refreshQuotas(force = false): Promise<Partial<Record<'google' | 'anthropic' | 'openai', FamilyQuotaInfo>>> {
  const now = Date.now()
  const cacheFresh = !force && now - lastQuotaFetchTime < 30_000 && Object.keys(cachedQuotas).length > 0
  if (cacheFresh) {
    // A cached snapshot is only valid while the credential it describes is
    // still in the keyring unchanged. That is how a renewal done by anything
    // else (the timer, or this plugin's own keep-alive) shows up on the panel
    // without waiting out the 30 s window.
    if (readAccessTokenFromKeyring() === lastQuotaToken) return cachedQuotas
    lastQuotaFetchTime = 0
  }

  try {
    // Renewal is decided before the fetch, because the token we are about to
    // send may already be past the lead window. `refreshAgyTokenIfDue` is cheap
    // when nothing is due and refuses to loop on a failing keyring, so it can
    // sit on every refresh path (status poll, timer, manual refresh). A lead of
    // 0 means the operator disabled renewal in one place instead of two.
    if (quotaConfig !== undefined) {
      const keepaliveCwd = quotaConfig.tokenKeepaliveCwd?.trim()
        || process.env.USERPROFILE?.trim()
        || process.env.HOME?.trim()
      await refreshAgyTokenIfDue({
        executable: quotaConfig.agyPath?.trim() || undefined,
        model: quotaConfig.model,
        leadMs: quotaConfig.tokenKeepaliveLeadMs ?? 0,
        ...(keepaliveCwd === undefined || keepaliveCwd.length === 0 ? {} : { cwd: keepaliveCwd }),
      })
    }
    // Read after the renewal attempt, never before: sending a token that was
    // just replaced would guarantee a 401 for this very fetch.
    const liveToken = readAccessTokenFromKeyring()
    if (!liveToken) {
      lastQuotaError = 'unauthorized'
      return cachedQuotas
    }
    lastQuotaToken = liveToken

    // Read the host that actually serves our generation traffic. prod is only a
    // catalog fallback: its quota numbers are an empty ledger (see the comment
    // on QUOTA_ENDPOINT_DAILY), so falling back to it would reintroduce the
    // fake-100% panel.
    const [summaryRaw, modelsRaw] = await Promise.all([
      fetchHttpsThroughHttpProxy(`${QUOTA_ENDPOINT_DAILY}/v1internal:retrieveUserQuotaSummary`, liveToken).catch(() => null) as Promise<QuotaSummaryResponse | null>,
      fetchHttpsThroughHttpProxy(`${QUOTA_ENDPOINT_DAILY}/v1internal:fetchAvailableModels`, liveToken).catch(() => null) as Promise<{ models?: Record<string, { displayName?: string; quotaInfo?: QuotaModelEntry }> } | null>,
    ])

    // "Unauthenticated" is the only failure worth surfacing in the UI: it means
    // the OAuth token in the keyring lapsed and a fresh agy.exe run (or a
    // message through the provider) will refresh it. Network/upstream failures
    // are transient and self-heal on the next poll.
    const summaryErr = (summaryRaw as { error?: { code?: number } } | null)?.error?.code
    const modelsErr = (modelsRaw as { error?: { code?: number } } | null)?.error?.code
    if (summaryErr === 401 || modelsErr === 401) {
      lastQuotaError = 'unauthorized'
    } else if (summaryRaw === null && modelsRaw === null) {
      lastQuotaError = 'network'
    } else {
      lastQuotaError = null
    }

    const familyQuotas: Partial<Record<'google' | 'anthropic' | 'openai', FamilyQuotaInfo>> = {
      google: { updatedAt: now, models: [] },
      anthropic: { updatedAt: now, models: [] },
      openai: { updatedAt: now, models: [] },
    }

    if (summaryRaw && Array.isArray(summaryRaw.groups)) {
      for (const group of summaryRaw.groups) {
        const dName = (group.displayName || '').toLowerCase()
        const desc = (group.description || '').toLowerCase()
        const isGoogle = dName.includes('gemini') || desc.includes('gemini')
        const is3P = dName.includes('claude') || dName.includes('gpt') || desc.includes('claude') || desc.includes('gpt')
        const targetFamilies: Array<'google' | 'anthropic' | 'openai'> = isGoogle
          ? ['google']
          : is3P
          ? ['anthropic', 'openai']
          : []

        let fiveHourFrac: number | undefined
        let fiveHourReset: string | undefined
        let weeklyFrac: number | undefined
        let weeklyReset: string | undefined

        for (const b of group.buckets || []) {
          // A disabled window is "does not currently apply" (Google's own wording
          // in the bucket description, e.g. "You have hit your weekly limit, the
          // 5-hour limit does not currently apply"). It is not a reading: skip it
          // so the 5-hour row stays unknown instead of inheriting a stale value.
          if (b.disabled === true) continue
          const w = (b.window || b.bucketId || '').toLowerCase()
          const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
            ? Math.min(1, Math.max(0, b.remainingFraction))
            : undefined
          if (w.includes('5h') || w.includes('five_hour') || w.includes('5-hour')) {
            fiveHourFrac = frac
            fiveHourReset = b.resetTime
          } else if (w.includes('weekly') || w.includes('week')) {
            weeklyFrac = frac
            weeklyReset = b.resetTime
          }
        }

        for (const fam of targetFamilies) {
          // No fraction for a window means upstream did not report it — record
          // that as unknown. Filling in 1 (the old behaviour) is what made a
          // drained account render as "100% remaining".
          familyQuotas[fam]!.remainingFraction = fiveHourFrac
          familyQuotas[fam]!.resetTime = fiveHourReset
          familyQuotas[fam]!.fiveHourUnknown = fiveHourFrac === undefined
          familyQuotas[fam]!.weeklyFraction = weeklyFrac
          familyQuotas[fam]!.weeklyResetTime = weeklyReset
          familyQuotas[fam]!.weeklyUnknown = weeklyFrac === undefined
          familyQuotas[fam]!.description = group.description
        }
      }
    }

    if (modelsRaw && typeof modelsRaw === 'object' && modelsRaw.models) {
      // The upstream catalog response names ~19 models. The panel only ever
      // shows DEFAULT_CATALOG_MODELS, so keep the per-model quota detail for
      // those ids and drop the rest instead of shipping every upstream entry
      // over the wire on each status poll.
      const catalogIds = new Set(DEFAULT_CATALOG_MODELS.map((m) => m.id))
      for (const [id, m] of Object.entries(modelsRaw.models)) {
        if (!catalogIds.has(id)) continue
        const info = m?.quotaInfo
        const displayName = m?.displayName || id

        const entry: FamilyQuotaModelEntry = {
          modelId: id,
          displayName,
          remainingFraction: typeof info?.remainingFraction === 'number' && Number.isFinite(info.remainingFraction)
            ? Math.min(1, Math.max(0, info.remainingFraction))
            : undefined,
          ...(info?.resetTime ? { resetTime: info.resetTime } : {}),
        }
        const lower = id.toLowerCase()
        const targetFam: 'google' | 'anthropic' | 'openai' = lower.includes('claude')
          ? 'anthropic'
          : lower.includes('gpt')
          ? 'openai'
          : 'google'
        familyQuotas[targetFam]!.models!.push(entry)
      }
    }

    if (!summaryRaw?.groups && modelsRaw?.models) {
      for (const fam of DISPLAY_FAMILIES) {
        const list = familyQuotas[fam]?.models || []
        // Only models that actually reported a fraction take part in the
        // aggregate. A model whose `quotaInfo` has no `remainingFraction` is a
        // model upstream declined to meter — treating it as 1 (the old
        // behaviour) silently turns "not reported" into "full".
        const metered = list.filter((x) => typeof x.remainingFraction === 'number')
        const remaining = metered.length > 0 ? Math.min(...metered.map((x) => x.remainingFraction as number)) : undefined
        const resetEntry = list.find((x) => x.resetTime)
        const isWeekly = resetEntry?.resetTime
          ? (new Date(resetEntry.resetTime).getTime() - now) >= 24 * 3600 * 1000
          : false
        familyQuotas[fam] = {
          ...familyQuotas[fam],
          remainingFraction: remaining,
          ...(!isWeekly && resetEntry?.resetTime ? { resetTime: resetEntry.resetTime } : {}),
          fiveHourUnknown: remaining === undefined,
          weeklyFraction: remaining,
          ...(isWeekly && resetEntry?.resetTime ? { weeklyResetTime: resetEntry.resetTime } : {}),
          updatedAt: now,
          models: list,
        }
      }
    }

    cachedQuotas = familyQuotas
    lastQuotaFetchTime = now
  } catch {}

  return cachedQuotas
}

/**
 * The catalog the panel shows. Gemini 3.8 Flash is the only model this account
 * can actually reach: `agy models` lists it (plus effort variants of the same
 * id), and the third-party families are drained — the 3p weekly bucket has read
 * remainingFraction 0 since 2026-10-20, and Google removes Claude/GPT from
 * promotional plans on 2026-11-02. Listing drained models only produces entries
 * that fail on send.
 *
 * The retired entries and a switch-back procedure are parked in
 * `docs/archived-model-catalog-20261020.md` — restoring any of them is a
 * config edit (`models` + `visibleModels` in the profile patch), not a code
 * change.
 */
const DEFAULT_CATALOG_MODELS = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
]

/** Quota families the panel renders. Same reasoning as above; see the doc. */
const DISPLAY_FAMILIES = ['google'] as const

export function setupWebRoutes(ctx: Context, activeConfig: ConfigType, modelDiscovery?: AgyModelDiscovery): () => void {
  const disposers: Array<() => void> = []
  quotaConfig = activeConfig
  disposers.push(() => {
    if (quotaConfig === activeConfig) quotaConfig = undefined
  })

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

    // Automatic renewal. The actual decision lives in `refreshQuotas` (it runs
    // right before the quota fetch, which is the only moment a lapsed token
    // actually costs something). This timer only exists so renewal also happens
    // while nobody is looking at the panel — a status poll alone is not a
    // dependable clock. See `src/agy/keepalive.ts`.
    const keepaliveMs = activeConfig.tokenKeepaliveMs ?? 0
    if (keepaliveMs > 0) {
      let stopped = false
      const keepaliveTimer = setInterval(() => {
        if (stopped) return
        // force=false: refreshQuotas still renews when due; it just will not
        // refetch quota numbers that are younger than the 30 s cache.
        void refreshQuotas(false).catch(() => {})
      }, keepaliveMs)
      // The host must be able to exit without waiting for this timer.
      if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref()
      disposers.push(() => {
        stopped = true
        clearInterval(keepaliveTimer)
      })
    }

    // 0. GET /plugins/agy-link/diagnose — the Models-page attach path as the
    // host sees it. `configurable` must contain one entry whose settingsNs is
    // the card key; when it does and `cardPings` is still empty, the host never
    // dispatched the entry (a directory/namespace problem) rather than the card
    // rendering nothing (a card problem). Read-only; safe to poll.
    reg('/plugins/agy-link/diagnose', (_req, res) => {
      const llm = (ctx as unknown as {
        llm?: {
          listProviders?: () => Array<{ id: string }>
          listConfigurableProviders?: () => Array<{ provider: string; displayName: string; settingsNs: string; settingsPath: string[] }>
        }
      }).llm
      const readOrNull = <T>(fn: () => T): T | string => {
        try {
          return fn()
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      }
      const configurable = readOrNull(() => (llm?.listConfigurableProviders?.() ?? [])
        .map((entry) => ({ provider: entry.provider, displayName: entry.displayName, settingsNs: entry.settingsNs })))
      const diagnostics = getAttachDiagnostics()
      sendJson(res, 200, {
        cardSlot: 'settings.models.provider-card',
        cardKey: 'dsh-agy-provider',
        ...diagnostics,
        providers: readOrNull(() => (llm?.listProviders?.() ?? []).map((provider) => provider.id)),
        configurable,
        rowCarriesCardKey: Array.isArray(configurable)
          ? configurable.some((entry) => entry.settingsNs === 'dsh-agy-provider')
          : null,
      })
    })

    // The browser half reports every mount of the card here. A dispatch that
    // never happens never arrives, which is what separates "no row" from "card
    // rendered empty"; the prop names prove which owner props the host passed.
    reg('/plugins/agy-link/card-ping', async (req, res) => {
      const body = await readBody(req)
      const raw = body.props
      const props = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : []
      noteCardPing(props)
      sendJson(res, 200, { ok: true })
    })

    // 1. GET /plugins/agy-link/status
    reg('/plugins/agy-link/status', async (_req, res) => {
      const overrides = readAgyRuntimeOverrides() ?? { hiddenModels: [], defaultEffort: undefined, defaultModel: undefined }
      const quotas = await refreshQuotas(false)

      let discovered = [...DEFAULT_CATALOG_MODELS]
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
        version: CLOUD_CODE_API_VERSION,
        enabled: activeConfig.enabled ?? true,
        permissionMode: 'dsh-owned',
        workspaceRoot: '',
        defaultModel,
        defaultEffort,
        auth: {
          phase: lastQuotaError === 'unauthorized' ? 'expired' : 'signed_in',
          // The panel needs the real expiry, not just a boolean: with automatic
          // renewal in place the useful question became "how long is left", and
          // a refresh that silently fails must still be visible.
          tokenExpiresAt: identity.expiresAtMs === undefined ? null : new Date(identity.expiresAtMs).toISOString(),
          tokenExpiresInSeconds: identity.expiresAtMs === undefined
            ? null
            : Math.round((identity.expiresAtMs - Date.now()) / 1000),
          keepalive: keepaliveMs > 0,
          // Report the last renewal verdict so a failed renew is visible in the
          // panel instead of masquerading as "still renewing".
          keepaliveLastReason: lastKeepaliveOutcome()?.reason ?? null,
          keepaliveLastDetail: lastKeepaliveOutcome()?.detail ?? null,
          message: lastQuotaError === 'unauthorized'
            ? '登录已过期：发一条 AGY 消息即可自动刷新凭据'
            : 'Windows Credential Manager (gemini:antigravity) 就绪',
        },
        quotaError: lastQuotaError,
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
