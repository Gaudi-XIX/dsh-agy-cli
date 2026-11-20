# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

Runs the locally authenticated **Google Antigravity CLI (`agy`)** as a first-class model provider for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> Reject the account-ban risk of reverse proxies and protocol spoofing, and leave opaque wrapper shells behind. The plugin takes a native pass-through route through the local official CLI: no reverse proxy, no forged request headers, credentials stay on your machine, and the official binary and its signature are left untouched; DSH takes full control of tool dispatch, with execution steps visible in real time; long tasks are deeply optimized with built-in tool compression, long-log folding and anti-false-positive redaction, keeping context clean and stable over long runs from the ground up.

**What this plugin does, in three points:**

1. **Generation is signed by the official binary.** Every model request goes out through the official `agy.exe`; the plugin does not sign it, proxy it, or replace its generation path, so the model-side risk surface matches the official client.
2. **Spends your Antigravity quota.** Requests draw on your own subscription under the same pool and rules as the official client. No API key.
3. **AGY is only the model; DSH owns the harness.** Tool execution, approvals, sandbox and context budgeting stay 100% inside DSH; AGY's own agent loop is stripped.

> **Platform: Windows only.** The quota panel and credential keep-alive depend on Windows Credential Manager. The other features have no cross-platform implementation and are untested on macOS/Linux.

## Product positioning: the four dimensions

Four layers only: why this exists, what it deliberately gives up, what nobody else has, and where it is hardened. Table-stakes basics are collected in the "Baseline parity" table at the end.

### Dimension 1 · Why this exists

Three real problems drove this plugin: **account-ban exposure** (a reverse-proxy or protocol-spoofing channel does not look like the official client, so the risk surface changes while the cost lands on your account), **opaque wrapper shells** (model generation and tool execution both hidden, leaving you to guess when something breaks), and **long-task context collapse** (history and long logs keep piling up until the budget runs out before the task does).

### Dimension 2 · Route and deliberate trade-offs

A **native local-CLI channel**: every turn is issued and signed by the official `agy.exe`; the plugin only bridges (`src/agy/persistent-transport.ts`). The route only means something if its price is stated, so five things are given up on purpose:

- Giving up **cloud one-click sign-in and zero-friction setup** → traded for credentials that never leave this machine and a channel shaped like the official client.
- Giving up **turning the web UI into an API, or driving it with cookie crawlers** → traded for never taking on the account exposure of a reverse-engineering path.
- Giving up **patching the generation mechanism or the binary** → traded for an intact official signature and a model-side risk surface identical to the official client.
- Giving up **account pools and account rotation** → traded for single-account compliance, with "many accounts behind one IP" structurally absent.
- Giving up **opaque out-of-process automation** → traded for DSH owning the harness, with execution steps fully auditable.

### Dimension 3 · Unique advantage (the moat)

Under this route the plugin holds six compliance boundaries, each checkable against source. Every row is positive evidence of something deliberately *not* done, not a comparison with anyone.

| # | Boundary | Implementation |
|---|---|---|
| 1 | No web-to-API reverse engineering | The channel is AGY 1.1.15 stream-json NDJSON (`src/agy/persistent-transport.ts`): the web UI is not turned into an API, no cookie crawler, no browser traffic is parsed |
| 2 | Zero binary tampering | The official `agy.exe` is only `spawn`ed (`src/agy/persistent-transport.ts`): no memory patching, no machine-code cracking, no signature replacement; generation is signed by the official binary itself |
| 3 | Single-account compliance | Exactly the one locally signed-in account is used — no account pool, no rotation; each AGY process runs one active turn at a time (`src/agy/persistent-transport.ts`) |
| 4 | Compliant takeover via public parameters | The official agent preset's public parameter `excludeDefaultComponents: true` disables the official default components (`src/agent-presets.ts`, `agents/dsh-agy-mcp-executor.md`): takeover uses public interfaces only, no private protocol changes |
| 5 | Credentials stay in the local sandbox | Only the `gemini:antigravity` target is read from Windows Credential Manager (`src/agy/keepalive.ts`): used in memory, never logged, never placed in an error message; renewal is the official `agy.exe`'s own job |
| 6 | Retry-After-aware backoff | Retryable errors wait for the server's `Retry-After` (seconds or HTTP-date), capped at 24 hours (`src/agy/errors.ts`); wired in `src/provider/agy.ts`, covered by `tests/error-classification.test.mjs` |

### Dimension 4 · Hardened strengths

Anyone can write the generic parts; not collapsing is the difference:

- **Tool context projection**: only base terminal and file capabilities are exposed; everything else is discovered and mounted on demand (`dsh_discover_tools` in `src/mcp/tool-projection.ts`), so the tool schema stays small.
- **Adaptive long-output folding**: over-budget historical command output and long logs keep head and tail and fold the middle compactly (`foldToolResultText` in `src/provider/prompt-budget.ts`).
- **Sensitive-input defence**: upstream trigger words and override phrases are softened before dispatch (`cloakPrompt` in `src/provider/prompt-cloak.ts`, wired in `src/provider/agy.ts`); logs and error messages all go through redaction (`redactText` in `src/agy/redact.ts`).
- **Streaming resilience**: `stdinMode: hold` prevents rollback (`src/agy/process.ts`, default set in `src/provider/agy.ts`), the tail streams as it arrives, and a dropped connection keeps the text already delivered.

---

## Credentials and network behaviour (stated plainly)

- **Reads**: the Google OAuth blob that AGY stores in Windows Credential Manager (target `gemini:antigravity`), via `CredRead` in `src/agy/keepalive.ts`. Used for two things: deciding whether the token is close to expiry and should trigger one official-CLI renewal, and reading `access_token` for the quota queries below. The token stays in process memory; it is never logged or placed in an error message.
- **Quota queries — the only outbound request the plugin makes itself**: the token above is sent as `Authorization: Bearer` to the read-only quota RPCs of `https://daily-cloudcode-pa.googleapis.com` and `https://cloudcode-pa.googleapis.com`, together with AGY client identity headers (`User-Agent` / `X-Goog-Api-Client`) — the server returns different quota groups per client, and omitting them drops the Gemini group. **Those requests go to those two Google endpoints only; nothing is sent to third parties.**
- **Not done**: no interception, replay or forgery of generation requests; no token handed to third parties; no credentials read beyond the target above.
- **Renewal**: token rotation is performed entirely by the official `agy.exe`; the plugin only launches it once before expiry.

Evidence for the endpoint semantics and identity-header behaviour: `docs/prod-generation-feasibility-20261020.md`.

## Features

- **Lean Prompt (official system prompt stripped)**: Custom Agent preset physically disables Google's verbose built-in prompt and default tools (`excludeDefaultComponents: true`), reserving full prompt budget for DSH workspace rules.
- **Adaptive base tools & on-demand mounting**: Exposes only base terminal and file operations along with dynamic discovery (`dsh_discover_tools`), keeping the tool schema small; additional capabilities mount automatically on call.
- **Intelligent tool output folding**: Long historical command outputs and logs exceeding threshold are folded into compact summaries, keeping context compact across turns.
- **Antigravity Cloak / prompt desensitization**: Softens upstream trigger patterns and agent signatures before sending, maximizing stability.
- **Dual tool paths**: MCP bridge surfaces DSH tools to AGY (real tool events, visualized transcript, recommended); falls back to prompt contract automatically on bridge failure.
- **DSH owns harness**: Workspaces, approvals, sandboxing, and context limits 100% inside DSH.
- **Streaming + state machine**: `stdinMode: hold` means text already delivered is never rolled back; tool steps collapse into a step list (only which tools ran, never the model's internal reasoning); the tail streams as it arrives; a dropped connection keeps the text already delivered.
- **Session management + history fingerprint chain**: `resume` and `full` modes; after each successful turn the plugin records a DSH history fingerprint and compares the prefix locally before `resume`. If history was edited, compressed or truncated, the stale session is discarded and rebuilt from full history, so a delta prompt never lands on outdated context. Dead sessions replay automatically; the session map is on disk and can be moved.
- **Image input (experimental)**: attachments land on disk through the image bridge and are viewed by a minimal-permission `view_file` agent.
- **Quota panel & credential keep-alive**: loopback-only; the panel shows the real two-window quota, and a token close to expiry triggers one renewal through the official CLI.
- **Security hardening**: prototype-pollution guard, MCP bridge gate, loopback-only panel with atomic writes, credential redaction — all backed by tests.

## Install

```console
dsh plugin --profile <your profile> add dsh-agy-cli
```

Requires Windows, the official Antigravity CLI installed and signed in locally, and Node ≥ 20.

**One more step, or AGY will report an unknown agent** (the bundled agent presets are not copied into AGY's agent directory by the install alone):

```console
npx dsh-agy-cli agents install read-only --apply
npx dsh-agy-cli agents install workspace-write --apply
```

`--apply` writes into `~/.gemini/antigravity-cli/gemini-root-config/agents`; add `--backup` first if you want a copy, and `agents list` shows the current state. After a host restart the plugin's card appears under Settings → Models (model visibility, reasoning effort, quota panel).

**Diagnostics**: `npx dsh-agy-cli doctor --profile <profile>` — install, bundle declaration, agent presets, config parsing and credential state, without spending quota.

## Development

```bash
npm ci --ignore-scripts
npm run typecheck
npm test    # full tsc build → 39 test files under tests/
```

## Baseline parity

Table-stakes capabilities live here, not in the pitch:

| Item | Status |
|---|---|
| Models | Discovered at runtime from `agy models` (`src/agy/models.ts`); no hardcoded allow-list |
| Reasoning effort | `gemini-*` models take an `--effort` level; `claude-*` do not need one (`src/provider/agy.ts`) |
| Platform | Windows only: the quota panel and credential keep-alive depend on Windows Credential Manager |
| Credentials | Uses the quota of the locally signed-in official AGY account; no extra API key to configure |
| License | MIT |

## License

MIT. Original copyright and full commit history are preserved in `LICENSE` and in this repository's git history.
