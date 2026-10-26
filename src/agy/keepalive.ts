/**
 * Keep the keyring OAuth token alive before it lapses.
 *
 * Why this exists: AGY stores its Google credential in the Windows Credential
 * Manager entry `gemini:antigravity` with a hard `expiry` field. Once that
 * moment passes, every quota RPC answered with 401 until some other program
 * happened to start `agy.exe` and refresh it. The panel therefore showed
 * "登录已过期" after the machine sat idle for an hour, even though the account
 * itself was fine (observed 2026-10-22).
 *
 * The refresh itself cannot be done over HTTP here: rotating the token needs
 * Google's OAuth client id/secret, which live inside the closed-source agy.exe.
 * What CAN be done is start agy.exe ourselves early enough that its own
 * "silent auth" path rotates the token, and hand it a run that produces as few
 * billable tokens as possible.
 *
 * Two facts measured on this host shape the design (2026-10-22):
 *
 * 1. `agy <subcommand>` (e.g. `agy models`) prints `not authenticated, trying
 *    silent auth` and then only calls the token endpoint when the stored token
 *    is ALREADY expired — while it is merely close to expiry the subcommand
 *    succeeds without rotating anything. It is also useless as a wake-up: it
 *    skips `loadCodeAssist`, so it cannot be used to probe liveness.
 * 2. `agy -p "." --effort low` DID rotate (keyring LastWritten moved 11:00:24,
 *    log `browser.go:265 token refreshed, new expiry=...`), but it completes a
 *    real assistant turn: three `streamGenerateContent` upstream calls, ~20 s,
 *    and those calls are part of what drains the weekly bucket this whole
 *    feature is trying to protect.
 *
 * So the cheap path is "close the request pipe immediately after the frame is
 * written" (`stdinMode: 'close'`). AGY reads that EOF as "no next turn", shuts
 * its store manager down and cancels the turn (the same reason the adapter's
 * default is `hold`), but the silent-auth handshake runs BEFORE any generation
 * begins — the token is rotated and no `streamGenerateContent` is issued.
 * `startAgyProcess` makes that mode mandatory rather than a suggestion.
 *
 * 3. What "due" actually means, read off the logs: `keyring.go:64 keyringAuth:
 *    loaded token ... expired=` is followed by `browser.go:265 token refreshed,
 *    new expiry=now+3599s` ONLY when `expired=true`, and never twice in a row
 *    while it is false. Starting agy while the token still has life is
 *    therefore a pure no-op that costs a process launch every tick.
 *
 * So renewal happens on the LAST tick before expiry, not in a wide window that
 * would only ever spin agy for nothing. The check that keeps running in the
 * lead window is a write comparison, not a process launch.
 */
import { execFile, execFileSync } from 'node:child_process'
import { buildAgyArgs, resolveAgyExecutable, runProcess, type ProcessResult } from './process.js'

/** Windows Credential Manager target AGY stores its OAuth blob under. */
export const AGY_KEYRING_TARGET = 'gemini:antigravity'

/**
 * Reads the SAME P/Invoke blob the web router reads, but inheriting the router's
 * proven invocation shape: `-Command "& { <script> } <target>"`. Feeding the
 * script through `-Command -` (stdin) silently executes nothing on this host —
 * PowerShell parses the here-string and exits 0 with empty stdout, measured
 * 2026-10-22. Duplicated rather than imported so the keep-alive path has no
 * dependency on the HTTP layer.
 */
const WIN_CRED_SCRIPT = `
param($target)
$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinCredKeepalive {
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
[Console]::Out.Write([WinCredKeepalive]::Read($target))
`

export interface KeyringTokenState {
  /** Epoch ms parsed from the blob's `token.expiry`, or undefined when unreadable. */
  expiresAtMs?: number | undefined
}

/** One decoded read of the Credential Manager blob. */
export interface KeyringBlob {
  accessToken: string | null
  email?: string | undefined
  name?: string | undefined
  /** Epoch ms from `token.expiry`; undefined when the blob has no readable expiry. */
  expiresAtMs?: number | undefined
}

/** macOS/Linux read path: untouched, never part of the Windows hot path. */
function readKeyringTokenStateSyncImpl(): KeyringTokenState {
  if (process.platform !== 'win32') return {}
  try {
    const b64 = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, AGY_KEYRING_TARGET],
      {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim()
    if (!b64) return {}
    const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
      token?: { expiry?: unknown; expires_in?: unknown }
    }
    const token = parsed?.token ?? {}
    const raw = typeof token.expiry === 'string' ? token.expiry : undefined
    const parsedExpiry = raw === undefined ? Number.NaN : Date.parse(raw)
    const expiresInSeconds = typeof token.expires_in === 'number' ? token.expires_in : 3599
    return Number.isFinite(parsedExpiry)
      ? { expiresAtMs: parsedExpiry }
      // A blob without `expiry` is not "expired": assume the standard lifetime
      // so a reader quirk cannot trigger a refresh loop on every tick.
      : { expiresAtMs: Date.now() + expiresInSeconds * 1000 }
  } catch {
    return {}
  }
}

/**
 * Synchronous expiry read. Non-Windows only: on Windows every `execFileSync`
 * spawn blocks the host's event loop for 0.2–3 s (measured 2026-10-23), which is
 * what made `/status` take 10–22 s. Windows callers must use the async
 * `readKeyringTokenState()` / `readKeyringBlob()` instead.
 */
export function readKeyringTokenStateSync(): KeyringTokenState {
  return readKeyringTokenStateSyncImpl()
}

function decodeKeyringBlob(b64: string): KeyringBlob {
  const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
    token?: { access_token?: unknown; expiry?: unknown; expires_in?: unknown }
    id_token?: unknown
  }
  const accessToken = typeof parsed?.token?.access_token === 'string' ? parsed.token.access_token : null
  // `expiry` is the field agy.exe itself compares against before rotating the
  // token, so it is the one reading the panel should trust: no id_token
  // decoding, no guess from `expires_in`.
  const rawExpiry = parsed?.token?.expiry
  const parsedExpiry = typeof rawExpiry === 'string' ? Date.parse(rawExpiry) : Number.NaN

  let email: string | undefined
  let name: string | undefined
  const idToken = parsed?.id_token
  if (typeof idToken === 'string') {
    try {
      const p1 = idToken.split('.')[1]
      if (p1) {
        const payload = JSON.parse(Buffer.from(p1, 'base64').toString('utf8')) as { email?: unknown; name?: unknown }
        email = typeof payload?.email === 'string' ? payload.email : undefined
        name = typeof payload?.name === 'string' ? payload.name : undefined
      }
    } catch {}
  }

  return {
    accessToken,
    email,
    name,
    ...(Number.isFinite(parsedExpiry) ? { expiresAtMs: parsedExpiry } : {}),
  }
}

// ---- async keyring reads (the only Windows path the web router may use) ----
// Why: `readIdentityFromKeyring` used to spawn Windows PowerShell synchronously
// and `/status` called it 2–3 times per request, so every settings RPC queued
// behind a blocked event loop. Reads are async now, single-flighted, and
// cached. The cache is a "last known value" (answers immediately even when
// stale) plus a 30 s freshness window: a renewal done by keepalive or by a
// normal message shows up without the panel paying another spawn.
const KEYRING_FRESH_MS = 30_000
let cachedBlob: KeyringBlob | undefined
let cachedBlobAt = 0
let blobInFlight: Promise<KeyringBlob> | undefined

function blobIsFresh(now: number): boolean {
  return cachedBlob !== undefined && now - cachedBlobAt < KEYRING_FRESH_MS
}

async function readKeyringBlobUncached(): Promise<KeyringBlob> {
  // Credential seam, checked before the platform gate. Why: there is no Windows
  // Credential Manager on Linux/macOS (and none on a CI runner), so every chain
  // behind this read — the quota panel, its 4 daily-host tests — could only ever
  // be green on the one dev machine that happened to hold a real login. That is
  // a fake green, not a passing suite. `DSH_AGY_KEYRING_BLOB` feeds the exact
  // base64 OAuth blob agy.exe stores through the identical decode path, so a
  // test (or an operator without a keyring) can stand in for the credential.
  // Unset => behavior unchanged. Set => the blob is trusted as if read from the
  // store, on every platform: whoever can set this env can already read that
  // store as the same user, so it grants nothing new.
  const injected = process.env.DSH_AGY_KEYRING_BLOB?.trim()
  if (injected !== undefined && injected.length > 0) {
    try {
      return decodeKeyringBlob(injected)
    } catch {
      // A malformed blob is "no credential", never a crash and never a partial
      // identity: fail closed to the same shape the unreadable keyring gives.
      return { accessToken: null }
    }
  }
  if (process.platform !== 'win32') return { accessToken: null }
  return await new Promise<KeyringBlob>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `& { ${WIN_CRED_SCRIPT} }`, AGY_KEYRING_TARGET],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
      (error, stdout) => {
        const b64 = typeof stdout === 'string' ? stdout.trim() : ''
        // A spawn failure or an unreadable blob must not be cached as "signed
        // out": the caller falls back to the last known value instead.
        if (error !== null || b64.length === 0) {
          resolve({ accessToken: null })
          return
        }
        try {
          resolve(decodeKeyringBlob(b64))
        } catch {
          resolve({ accessToken: null })
        }
      },
    )
  })
}

/**
 * Current keyring contents. Never throws and never blocks the event loop.
 * `force` bypasses the freshness window (used after a renewal). A concurrent
 * read joins the one already running unless the caller forced.
 */
export async function readKeyringBlob(options: { force?: boolean | undefined } = {}): Promise<KeyringBlob> {
  const now = Date.now()
  if (options.force !== true && blobIsFresh(now)) return cachedBlob as KeyringBlob
  if (blobInFlight !== undefined && options.force !== true) return blobInFlight
  const run = readKeyringBlobUncached().then((blob) => {
    if (blob.accessToken !== null) {
      cachedBlob = blob
      cachedBlobAt = Date.now()
    }
    return blob
  })
  blobInFlight = run
  try {
    return await run
  } finally {
    if (blobInFlight === run) blobInFlight = undefined
  }
}

/** Expiry-only view of `readKeyringBlob`, for the keep-alive decision. */
export async function readKeyringTokenState(options: { force?: boolean | undefined } = {}): Promise<KeyringTokenState> {
  const blob = await readKeyringBlob(options)
  return blob.expiresAtMs === undefined ? {} : { expiresAtMs: blob.expiresAtMs }
}

/**
 * Arguments for the wake-up run. Deliberately minimal:
 * - the prompt goes on argv (`-p .`). AGY refuses an empty prompt ("empty
 *   prompt. Usage: agy --print ...") and reads a single "." as "look at the
 *   working directory", which is the cheapest turn that still authenticates.
 *   The adapter's `-p ''` + stdin-frame shape cannot be reused here: AGY exits
 *   with code 2 and `--input-format stream-json reads prompts from stdin, so a
 *   prompt given on the command line would be ignored` — measured 2026-10-22,
 *   and that rejection was silent enough to make the first version look like a
 *   working renewal that never rotated anything.
 * - no `--input-format` / `--output-format`: they only matter for framing a
 *   stream we are not reading; leaving them out also avoids the conflict above.
 * - `--effort low` is passed anyway: some gemini-* ids refuse to start without
 *   an `--effort` flag, and if the cancellation ever loses the race, the turn
 *   that runs is the cheapest one available instead of the 'high' default.
 * - no `--agent`: this must not depend on a template being installed.
 * - `--disable-slash-commands`: a bare "." must never be parsed as a command.
 */
export function buildKeepaliveArgs(model?: string): string[] {
  return [
    '-p', '.',
    ...(model === undefined || model.trim().length === 0 ? [] : ['--model', model.trim()]),
    '--effort', 'low',
    '--disable-slash-commands',
  ]
}

export interface KeepaliveOptions {
  /** AGY executable; empty resolves through PATH/env like the adapter does. */
  executable?: string | undefined
  /** Model id for the wake-up argv; empty omits `--model` and uses AGY's default. */
  model?: string | undefined
  /** Refresh once the token has less than this much life left. */
  leadMs?: number | undefined
  /** Wall-clock ceiling for the wake-up process. */
  timeoutMs?: number | undefined
  /** Directory the child runs in. Defaults to the user's home, not the project. */
  cwd?: string | undefined
  /** Injected for tests; defaults to `runProcess`. */
  run?: ((request: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>) | undefined
  /** Injected for tests; defaults to `readKeyringTokenState`. */
  readState?: ((options?: { force?: boolean | undefined }) => KeyringTokenState | Promise<KeyringTokenState>) | undefined
}

export type KeepaliveReason = 'not-due' | 'no-expiry' | 'no-executable' | 'completed' | 'failed' | 'rejected' | 'not-rotated'

/**
 * When to wake AGY up. AGY only rotates an EXPIRED token, so "renew early" would
 * mean launching a process that provably does nothing; the caller keeps its
 * check interval short instead and renewal fires on the last tick before the
 * expiry. The window is still exposed as configuration because a user who sets a
 * negative skew (renew after the moment it lapses) may want either side.
 */
export const DEFAULT_KEEPALIVE_LEAD_MS = 60 * 1000

export interface KeepaliveOutcome {
  /** True when agy.exe was started because the token was close to expiry. */
  refreshed: boolean
  reason: KeepaliveReason
  /** Seconds left on the old token when the refresh started. */
  remainingSeconds?: number | undefined
  /** Epoch ms of the token as it stands after the attempt. */
  expiresAtMs?: number | undefined
  /** Process exit code of the last attempt, when there was one. */
  exitCode?: number | null | undefined
  /** Why the last attempt failed, for the panel banner. */
  detail?: string | undefined
}

/** Expiry value of the last renewal attempt that did not rotate, if any. */
let lastFailedExpiry: number | undefined
/** Why that attempt gave up, so a deduplicated tick still reports the cause. */
let lastFailedReason: KeepaliveReason | undefined
let lastFailedDetail: string | undefined

function rememberFailure(expiresAtMs: number, reason: KeepaliveReason, detail?: string): void {
  lastFailedExpiry = expiresAtMs
  lastFailedReason = reason
  lastFailedDetail = detail
}

function forgetFailure(): void {
  lastFailedExpiry = undefined
  lastFailedReason = undefined
  lastFailedDetail = undefined
}

export async function refreshAgyTokenIfDue(options: KeepaliveOptions = {}): Promise<KeepaliveOutcome> {
  const readState = options.readState ?? readKeyringTokenState
  const leadMs = options.leadMs ?? DEFAULT_KEEPALIVE_LEAD_MS

  const before = await readState()
  if (before.expiresAtMs === undefined) return { refreshed: false, reason: 'no-expiry' }

  const remainingMs = before.expiresAtMs - Date.now()
  const remainingSeconds = Math.round(remainingMs / 1000)
  if (remainingMs > leadMs) {
    return { refreshed: false, reason: 'not-due', remainingSeconds, expiresAtMs: before.expiresAtMs }
  }

  // Renewal must never be a side effect of "somebody looked at the panel" or of
  // a timer that keeps ticking: a failing attempt would otherwise restart
  // agy.exe every few minutes. Module-level on purpose — remember the expiry we
  // last gave up on and stay quiet until the keyring actually moves. The reason
  // keeps the original failure so the panel can still say WHY it stopped.
  if (before.expiresAtMs === lastFailedExpiry) {
    return {
      refreshed: false,
      reason: lastFailedReason ?? 'not-due',
      remainingSeconds,
      expiresAtMs: before.expiresAtMs,
      ...(lastFailedDetail === undefined ? {} : { detail: lastFailedDetail }),
    }
  }

  const executable = resolveAgyExecutable(options.executable)
  if (executable.trim().length === 0) {
    return { refreshed: false, reason: 'no-executable', remainingSeconds, expiresAtMs: before.expiresAtMs }
  }

  const started = await startAgyKeepaliveRun({
    executable,
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.run === undefined ? {} : { run: options.run }),
  })
  if (!started.ok) {
    // Spawn failures and argument rejections are different animals: a spawn
    // failure is the environment, a rejection is our own argv. Report them
    // separately so the panel can say which one happened.
    const rejected = started.exitCode !== null && started.exitCode !== 0
    const reason: KeepaliveReason = rejected ? 'rejected' : 'failed'
    rememberFailure(before.expiresAtMs, reason, started.detail)
    return {
      refreshed: false,
      reason,
      remainingSeconds,
      expiresAtMs: before.expiresAtMs,
      exitCode: started.exitCode,
      ...(started.detail === undefined ? {} : { detail: started.detail }),
    }
  }

  // Forced: `before` (and any earlier caller) just populated the 30 s freshness
  // window, so a plain read would hand back the very expiry we are trying to
  // compare against. A renewal is only ever judged on what the keyring says
  // now, never on a snapshot taken before agy.exe ran.
  const after = await readState({ force: true })
  const expiresAtMs = after.expiresAtMs ?? before.expiresAtMs
  // A run that left the expiry untouched is a failure for our purposes even
  // though the process exited 0 — agy saw a token it considered valid, or the
  // network refused to rotate. Either way: do not relaunch on the same expiry.
  // Anything newer counts, including a credential that was replaced with one of
  // the same remaining lifetime.
  const rotated = expiresAtMs !== before.expiresAtMs
  if (rotated) {
    forgetFailure()
  } else {
    rememberFailure(before.expiresAtMs, 'not-rotated', 'agy exited 0 but the keyring expiry did not move')
  }

  return {
    refreshed: true,
    reason: rotated ? 'completed' : 'not-rotated',
    remainingSeconds,
    expiresAtMs,
    exitCode: started.exitCode,
    ...(rotated ? {} : { detail: 'agy exited 0 but the keyring expiry did not move' }),
  }
}

export interface KeepaliveRunInput {
  executable: string
  model?: string | undefined
  cwd?: string | undefined
  timeoutMs?: number | undefined
  run?: ((request: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>) | undefined
}

/** What the last renewal attempt actually did, including a rejection. */
export interface KeepaliveRunResult {
  ok: boolean
  /** Process exit code; null when the process never started. */
  exitCode: number | null
  /** First non-empty stderr line (or the spawn error), when the run failed. */
  detail?: string | undefined
}

/**
 * Start the wake-up turn. Exported so the elapsed time in the log/panel can be
 * attributed to a real process and so tests can assert the exact argv and stdin
 * contract without a live AGY.
 *
 * No stdin frame: `--input-format stream-json` is not passed, so a frame would
 * just be ignored. stdin is closed immediately instead, which is what stops the
 * turn from streaming a reply and keeps the run at zero generated tokens.
 *
 * The exit code is checked, not just the absence of a spawn error. AGY rejects
 * argument combinations with code 2 and a one-line stderr message; swallowing
 * that made the first version of this module report success while the process
 * had refused to run at all.
 */
export async function startAgyKeepaliveRun(input: KeepaliveRunInput): Promise<KeepaliveRunResult> {
  const run = input.run ?? runProcess
  const home = input.cwd ?? process.env.USERPROFILE ?? process.env.HOME
  try {
    const result = await run({
      executable: input.executable,
      args: buildKeepaliveArgs(input.model),
      stdinMode: 'close',
      ...(home === undefined ? {} : { cwd: home }),
      timeoutMs: input.timeoutMs ?? 45_000,
    })
    const code = typeof result?.exitCode === 'number' ? result.exitCode : 0
    if (code !== 0) {
      return { ok: false, exitCode: code, detail: firstLine(String(result?.stderr ?? '')) }
    }
    return { ok: true, exitCode: code }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, exitCode: null, detail: firstLine(message) }
  }
}

function firstLine(text: string, limit = 180): string | undefined {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0)
  if (line === undefined) return undefined
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}

/**
 * Outcome of the most recent renewal attempt, for the status endpoint. A
 * separate accessor keeps the decision function free of reporting concerns and
 * lets the panel show a rejected argv even on ticks that are "not due".
 */
export function lastKeepaliveOutcome(): { reason: KeepaliveReason; detail?: string | undefined } | undefined {
  if (lastFailedReason === undefined) return undefined
  return { reason: lastFailedReason, ...(lastFailedDetail === undefined ? {} : { detail: lastFailedDetail }) }
}

/**
 * Epoch ms from a Credential Manager `LastWritten` FILETIME, for the web router.
 * Only needed to tell "the keyring moved" from "it did not"; the expiry field
 * inside the blob is the load-bearing reading.
 */
export function filetimeToEpochMs(filetime: bigint | number | string): number | undefined {
  const value = typeof filetime === 'bigint' ? filetime : BigInt(String(filetime))
  if (value === 0n) return undefined
  return Number(value / 10_000n - 11_644_473_600_000n)
}
