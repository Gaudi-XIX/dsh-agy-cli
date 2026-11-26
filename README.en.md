# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

Run your own **Gemini account** inside DSH — through the Google Antigravity CLI (`agy`) already signed in on this machine, on your existing subscription, with no separate API key. [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) is the host.

> **First, should you even install this?** Windows only, and the official `agy` must be installed and signed in first. If you have no Antigravity account, want multi-account rotation, or are not on Windows, this plugin is not for you.
>
> **Your account safety, which matters most:** every request is sent and signed by the official `agy.exe` itself — no reverse proxy, no protocol spoofing, no binary patching — so the account side is just like using the official client directly; credentials stay on this Windows machine. Tool execution, approvals, and the workspace sandbox remain with DSH, visible and interceptable at every step.

**What this plugin does, in three points:**

1. **Generation is signed by the official binary.** Every model request goes out through the official `agy.exe`; the plugin does not sign it, proxy it, or replace its generation path, so the model-side risk surface matches the official client.
2. **Spends your Antigravity quota.** Requests draw on your own subscription under the same pool and rules as the official client. No API key.
3. **AGY is only the model; DSH owns the harness.** Tool execution, approvals, sandbox, and context budgeting stay 100% inside DSH; AGY's own agent loop is stripped via public preset parameters.

> **Want the deeper mechanics?** The four-dimension framework below walks through the problems, trade-offs and source references one by one; installation steps, config tables and troubleshooting follow. The two blocks above are enough to decide whether to install.

---

## Product positioning: the four dimensions

### Dimension 1 · Why this exists

Three practical problems drove this plugin:
- **Account-ban exposure**: reverse proxies and protocol spoofing alter request fingerprints and channel shape, leaving the account risk on the user.
- **Opaque wrapper shells**: hidden model generation and tool loops leave you guessing when turns stall or fail silently.
- **Long-task bloat and short-turn latency**: unpruned logs exhaust context quickly, while one-tool-per-turn round trips, offline Clearcut telemetry retry storms, and hung child processes inflate end-to-end latency.

### Dimension 2 · Route and deliberate trade-offs

A **native local-CLI channel**: every turn is issued and signed by the official `agy.exe`; the plugin only bridges (`src/agy/persistent-transport.ts`, `src/agy/process.ts`). To make the trade-offs explicit, five things are given up on purpose:

- Giving up **cloud one-click sign-in and zero-friction setup** → traded for credentials that stay inside Windows Credential Manager and a channel matching the official client.
- Giving up **turning the web UI into an API or driving it with cookie crawlers** → traded for zero reverse-engineering risk.
- Giving up **patching the generation mechanism or official binary** → traded for an intact official signature.
- Giving up **account pools and account rotation** → traded for single-account compliance with no multi-account correlation surface.
- Giving up **opaque out-of-process automation** → traded for DSH owning the harness with fully auditable tool execution.

### Dimension 3 · Unique advantage (the moat)

Under this route, eight mechanism boundaries are verifiable directly in source:

| # | Boundary | Source implementation |
|---|---|---|
| 1 | No web-to-API reverse engineering | Uses AGY 1.1.15 `stream-json` NDJSON (`src/agy/persistent-transport.ts`); no browser traffic or cookie scraping. |
| 2 | Zero binary tampering | Only spawns the official `agy.exe` (launched via `bin/win32-x64/agy-launcher.exe` on Windows to suppress console flashes without altering the target binary). |
| 3 | Single-account compliance | Uses only the locally signed-in account; no pooling or rotation, one active turn per AGY process. |
| 4 | Compliant takeover via public parameters | Disables built-in components using `excludeDefaultComponents: true` in `agents/dsh-agy-mcp-executor.md`. |
| 5 | Local credential isolation | Reads `gemini:antigravity` from Windows Credential Manager only for keep-alive and quota checks (`src/agy/keepalive.ts`); never injected into prompts or logs. |
| 6 | Full telemetry cutoff | Injects all 4 telemetry-disable env vars across `runProcess`, `experimental-transport.ts`, and `persistent-transport.ts`, blocking Clearcut's 5s offline retry storm. |
| 7 | 180s tiered watchdog | Sends stdin EOF + terminate signal on timeout, waits 3s (`WATCHDOG_GRACEFUL_MS`), then escalates to `taskkill /pid <pid> /t /f` (or POSIX process group `SIGKILL`) to prevent orphan locks (`src/agy/process.ts`). |
| 8 | History fingerprint chain | In `resume` mode, verifies a DSH history prefix fingerprint before reusing a conversation; edits or compactions rebuild cleanly from full history (`src/provider/agy.ts`). |

### Dimension 4 · Hardened strengths

- **Minimal initial toolset (adaptive on-demand projection)**: Exposes only essential terminal/file tools plus `dsh_discover_tools` by default, keeping schemas compact and letting the model discover and mount additional host tools by keyword when needed (`src/mcp/tool-projection.ts`, `src/mcp/bridge.ts`).
- **Transactional batch tools (`apply_edits` / `read_slices`)**: `apply_edits` validates all edits in memory (All-or-Nothing) before touching disk so failed matches leave zero dirty files; `read_slices` extracts file outlines and specific line ranges in one call (`src/mcp/batch-tools.ts`).
- **8.8KB output folding & ANSI sanitization**: Folds tool outputs at 8800 bytes (preserving head and tail) to avoid upstream 10KB temp-file spills, while stripping ANSI escape sequences and `\r` progress noise (`src/mcp/output-filter.ts`).
- **Historical output folding & prompt cloak**: Folds historical tool results exceeding `toolResultFoldThresholdBytes` (default 2048 bytes) and softens blunt trigger patterns via `promptCloak` (`src/provider/prompt-budget.ts`, `src/provider/prompt-cloak.ts`).
- **Non-rollback streaming state machine**: `stdinMode: 'hold'` keeps stdin open until the closing `result` line arrives so AGY never cancels delivered text mid-turn.

---

## Capabilities added through 0.17.0

1. **180s process watchdog with tree-kill escalation** (`src/agy/process.ts`): Defaults to `DEFAULT_WATCHDOG_MS = 180_000` with a 3s graceful window (`WATCHDOG_GRACEFUL_MS = 3_000`) before process-tree termination.
2. **Local no-login quota sniffer (`npm run quota`)** (`src/quota/`, `scripts/check-quota.mjs`): Reads ports from local CLI logs and `csrf_token` from the running `language_server` process to query local ConnectRPC quota endpoints.
3. **Live MCP batch-tool wiring**: `apply_edits` and `read_slices` are wired into `src/mcp/bridge.ts` for real execution, not schema projection alone.
4. **Telemetry cutoff across all transports**: Both `experimental-transport.ts` and `persistent-transport.ts` inject `DO_NOT_TRACK=1`, `ANTIGRAVITY_DISABLE_TELEMETRY=1`, `GOOGLE_CLOUD_DISABLE_TELEMETRY=1`, and `DISABLE_TELEMETRY=1` alongside `spawnStderrDetail` diagnostics.
5. **Machine-agnostic tool discoverability**: `DISCOVER_TOOLS_DESCRIPTOR` guides the model to search the host registry by keyword when blocked by missing capabilities, with no hardcoded tool names or allowlists.
6. **One-shot `EMPTY_RESPONSE` recovery hint**: Records sessions that end with `EMPTY_RESPONSE` (5-minute TTL, max 64 entries) and appends a one-shot tail hint on the next request in the same session without invalidating the prompt prefix cache.
7. **Full skills passthrough**: `ensureAgyGlobalSkills()` (`src/agy/skills-config.ts`) idempotently adds `~/.agents/skills` to `~/.gemini/config/skills.json` while preserving user entries; workspace `.agents/skills` rely on native `cwd` discovery with no allowlist, and non-preset main turns omit `--disable-slash-commands`.
8. **Quota-refresh catalog sync & flag conflict suppression**: `refresh-quota` invokes `discover(..., { force: true })` to bypass the 5-minute cache and cooldown and adopts the returned catalog in the UI; `--disable-slash-commands` and `--mode` conflicts are symmetrically suppressed across `one-shot` and `persistent` spawn paths.
9. **Discovery deadline, hide-list removal & turn-scoped image preset**: Removes the hardcoded 4s `DISCOVERY_AWAIT_MS` deadline in favor of `modelDiscoveryTimeoutMs` (default 10s, min 100 / max 30000), uses peek-first `/status` + startup warm-up, removes `hiddenModels` completely (discovered models are always visible), and swaps to the `image-view` preset only when the current turn carries images (`turnHasImages`).

---

## Installation & Host Mounting

### Standard DSH profile install

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add dsh-agy-cli
```

Requires Windows, Node ≥ 20, and a locally signed-in official `agy` CLI (`>= 1.1.15`).

### Local development via Junction / `link:`

For local checkout development, link the repository into the DSH profile (`node_modules\dsh-agy-cli` becomes a Windows Junction pointing to your repo), then rebuild and restart DSH:

```powershell
npm run build
npx @deepseek-ai/dsh plugin --profile desktop add link:F:/AgentData/dsh-agy-cli
```

### Install bundled Agent templates (required)

```powershell
npx dsh-agy-cli agents install mcp-executor --apply
npx dsh-agy-cli agents install image-view --apply
```

Templates write into `~/.gemini/antigravity-cli/gemini-root-config/agents` (use `--backup` to keep existing files). Run `npx dsh-agy-cli doctor --profile desktop` to verify setup without spending quota.

---

## `npm run quota` usage

```powershell
cd F:\AgentData\dsh-agy-cli
npm run quota
```

Scans the latest `cli-*.log` files under `~/.gemini/antigravity-cli/log/` (override via `AGY_QUOTA_LOG_DIR`) for HTTP ports, extracts `csrf_token` from the running `language_server` process on Windows, and queries local ConnectRPC `GetUserStatus` / `RetrieveUserQuotaSummary`.

> **Verification boundary**: Log/token/ConnectRPC parsing is covered by unit test fixtures; end-to-end execution against a live port requires an active signed-in `agy` process and has not been verified in headless CI.

---

## Configuration reference

Defaults below reflect `src/provider/config.ts` and `cordis.patch.yml` (Bundle enables `enabled: true`, `toolPolicy: 'dsh-owned'`):

| Key | Type / Values | Default (Bundle) | Notes |
|---|---|---|---|
| `enabled` | `boolean` | `true` (`false` in library) | Enable AGY provider. |
| `model` | `string` | `'gemini-3.1-pro'` | Default base model ID. |
| `modelDiscovery` | `'auto' \| 'off'` | `'auto'` | Discover models via `agy models`; `off` uses static config only. |
| `modelDiscoveryTtlMs` | `number` (1000–3600000) | `300000` | In-memory discovery cache TTL in ms. |
| `modelDiscoveryTimeoutMs` | `number` (100–30000) | `10000` | Timeout for `agy models` discovery (and forced refresh). |
| `toolPolicy` | `'reject' \| 'agy-owned' \| 'dsh-owned'` | `'dsh-owned'` | `dsh-owned` delegates tools to DSH via `dsh-agy-mcp-executor`. |
| `mcpBridge` | `boolean` | `true` | Expose DSH tools to AGY over local MCP. |
| `mcpAdaptiveBaseOnly` | `boolean` | `true` | Project base tools + `dsh_discover_tools` initially. |
| `toolResultFoldThresholdBytes` | `number` (256–1048576) | `2048` | Fold historical tool outputs larger than this threshold. |
| `promptCloak` | `boolean` | `true` | Soften blunt trigger patterns before sending. |
| `imageInput` | `'off' \| 'experimental'` | `'experimental'` | Swaps to `image-view` only when the current turn has images. |
| `sessionMode` | `'resume' \| 'full'` | `'full'` | `full` sends history; `resume` reuses AGY conversation with fingerprint check. |
| `stdinMode` | `'hold' \| 'close'` | `'hold'` | Keep stdin open until `result` arrives to avoid premature turn cancellation. |
| `transport` | `'one-shot' \| 'persistent'` | `'one-shot'` | Spawn per turn (`one-shot`) or reuse worker (`persistent`). |
| `timeoutMs` | `number` (1–3600000) | `900000` (`180000` watchdog fallback) | Backstop wall-clock ceiling per request in ms. |
| `idleTimeoutMs` | `number` (1–3600000) | `300000` | Inactivity budget re-armed per output line; must stay below `timeoutMs`. |
| `tokenKeepaliveMs` | `number` (0–3600000) | `60000` | Credential Manager expiry check interval; `0` disables keep-alive. |

---

## Troubleshooting

- **Discovery timeouts**: `/status` uses `peekCatalog()` (non-blocking) and warms up at startup. If cold `agy models` takes longer than 10s, increase `modelDiscoveryTimeoutMs` (up to `30000`), click Refresh in the quota panel (`force: true`), or set `modelDiscovery: 'off'`.
- **What is `EMPTY_RESPONSE`?**: In print mode, AGY soft-denies unapproved built-in tool confirmations and exits without text or tool calls. From `0.17.0`, the plugin records the session (5m TTL) and appends a one-shot hint at the tail of the next request in that session so the model replies directly or uses confirmation-free tools without breaking prefix cache.
- **Why can't `agy` see DSH's skills directory?**: Global skills rely on `~/.gemini/config/skills.json` containing `~/.agents/skills` (auto-bootstrapped unless the file is malformed JSON — check DSH logs for `could not ensure AGY global skills config`). Project `.agents/skills` rely on workspace `cwd` and are only scanned by AGY when `--disable-slash-commands` is omitted; preset-backed modes (`dsh-owned` / `agentPreset`) pass `--disable-slash-commands` intentionally so DSH owns skills and tools.
- **What are `history` image placeholders?**: Only images in the current turn are staged and trigger `image-view`. Earlier turns' images are cached under `<DSH_HOME>/agy-cli/image-cache` (14-day retention) and rendered as `[IMAGE_ATTACHMENT file=... media_type=... width=... height=... earlier_turn=cached]` (or `earlier_turn=unavailable` if unreadable/unsupported), keeping follow-up turns in text mode without failing on an old missing attachment.

---

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test        # full tsc build + test suite
npm run verify  # typecheck + test + npm pack --dry-run
```

---

## Baseline parity

| Item | Status |
|---|---|
| Models | Discovered at runtime from `agy models` (`src/agy/models.ts`); all discovered models visible |
| Reasoning effort | `gemini-*` models accept `--effort`; `claude-*` omit it (`src/provider/agy.ts`) |
| Platform | Windows only (Windows Credential Manager, `taskkill /T`, console-free launcher) |
| Credentials | Uses locally signed-in official AGY CLI quota; no API key required |
| License | MIT (original copyright and git history preserved in `LICENSE`) |
