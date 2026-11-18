# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

Runs the locally authenticated **Google Antigravity CLI (`agy`)** as a first-class model provider for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness).

> Reject the account-ban risk of reverse proxies and protocol spoofing, and leave opaque wrapper shells behind. The plugin takes a native pass-through route through the local official CLI: no reverse proxy, no forged request headers, credentials stay on your machine, the account is completely safe from bans; DSH takes full control of tool dispatch, with execution steps visible in real time; long tasks are deeply optimized with built-in tool compression, long-log folding and anti-false-positive redaction, keeping context clean and stable over long runs from the ground up.

**What this plugin does, in three points:**

1. **Generation is signed by the official binary.** Every model request goes out through the official `agy.exe`; the plugin does not sign it, proxy it, or replace its generation path, so the model-side risk surface matches the official client.
2. **Spends your Antigravity quota.** Requests draw on your own subscription under the same pool and rules as the official client. No API key.
3. **AGY is only the model; DSH owns the harness.** Tool execution, approvals, sandbox and context budgeting stay 100% inside DSH; AGY's own agent loop is stripped.

> **Platform: Windows only.** The quota panel and credential keep-alive depend on Windows Credential Manager. The other features have no cross-platform implementation and are untested on macOS/Linux.

## Product positioning: the five axes

### ① Pain & Trigger

Three real problems drove this plugin: **account-ban risk** (inherent to reverse-proxy and protocol-spoofing setups), **opaque wrapper shells** (generation and execution hidden from view), and **long-task context snowballing** (history and long logs piling up until the budget collapses).

### ② Tech Route & Trade-offs

A **native local-CLI channel**: every turn is issued and signed by the official `agy.exe`; the plugin only bridges. Two things are deliberately given up — cloud one-click sign-in and zero-friction setup, traded for full compliance and credentials that never leave the machine; and tampering with the model generation mechanism, so the model-side risk surface matches the official client exactly.

### ③ Unique

**No reverse proxy, no forged request headers** — zero ban risk at the root. **DSH takes full control of the harness**: tool dispatch, approvals, sandbox and context budgeting all live in DSH, with execution steps streaming transparently — only which tools actually ran, never the model's internal thinking.

### ④ Better

Deep hardening for long tasks: base tools **mounted on demand** (schema size cut by over 90%), **intelligent folding of long historical outputs**, **sensitive-term replacement before dispatch to prevent false-positive refusals**, and **fault-tolerant streaming with retry and text-preservation on disconnect** — keeping context clean and stable from the ground up.

### ⑤ Table Stakes

**Full support for the official model matrix**, with long-context and deep-thinking capability leveled up; model visibility and reasoning effort follow the official capabilities, with nothing artificially disabled.

---

## Credentials and network behaviour (stated plainly)

- **Reads**: the Google OAuth blob that AGY stores in Windows Credential Manager (target `gemini:antigravity`), via `CredRead` in `src/agy/keepalive.ts`. Used for two things: deciding whether the token is close to expiry and should trigger one official-CLI renewal, and reading `access_token` for the quota queries below. The token stays in process memory; it is never logged or placed in an error message.
- **Quota queries — the only outbound request the plugin makes itself**: the token above is sent as `Authorization: Bearer` to the read-only quota RPCs of `https://daily-cloudcode-pa.googleapis.com` and `https://cloudcode-pa.googleapis.com`, together with AGY client identity headers (`User-Agent` / `X-Goog-Api-Client`) — the server returns different quota groups per client, and omitting them drops the Gemini group. **Those requests go to those two Google endpoints only; nothing is sent to third parties.**
- **Not done**: no interception, replay or forgery of generation requests; no token handed to third parties; no credentials read beyond the target above.
- **Renewal**: token rotation is performed entirely by the official `agy.exe`; the plugin only launches it once before expiry.

Evidence for the endpoint semantics and identity-header behaviour: `docs/prod-generation-feasibility-20261020.md`.

## Features

- **Lean Prompt (official system prompt stripped)**: Custom Agent preset physically disables Google's verbose built-in prompt and default tools (`excludeDefaultComponents: true`), reserving full prompt budget for DSH workspace rules.
- **Adaptive base tools & on-demand mounting**: Exposes only base terminal and file operations along with dynamic discovery (`dsh_discover_tools`), shrinking schema size by over 90%; additional capabilities mount automatically on call.
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

Requires Windows, the official Antigravity CLI installed and signed in locally, and Node ≥ 22.

**One more step, or AGY will report an unknown agent** (the bundled agent presets are not copied into AGY's agent directory by the install alone):

```console
npx dsh-agy-cli agents install read-only --apply
npx dsh-agy-cli agents install workspace-write --apply
```

`--apply` writes into `~/.gemini/antigravity-cli/gemini-root-config/agents`; add `--backup` first if you want a copy, and `agents list` shows the current state. After a host restart the plugin's card appears under Settings → Models (model visibility, reasoning effort, quota panel).

**Diagnostics**: `npx dsh-agy-cli doctor --profile <profile>` — install, bundle declaration, agent presets, config parsing and credential state, without spending quota.

## License

MIT. Original copyright and full commit history are preserved in `LICENSE` and in this repository's git history.
