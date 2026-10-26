# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

Runs the locally authenticated **Google Antigravity CLI (`agy`)** as a first-class model provider for [DeepSeek Harness (DSH)](https://github.com/darkings/dsh).

**What this plugin does, in three points:**

1. **Generation is signed by the official binary.** Every model request goes out through the official `agy.exe`; the plugin does not sign it, proxy it, or replace its generation path, so the model-side risk surface matches the official client.
2. **Spends your Antigravity quota.** Requests draw on your own subscription under the same pool and rules as the official client. No API key.
3. **AGY is only the model; DSH owns the harness.** Tool execution, approvals, sandbox and context budgeting stay 100% inside DSH; AGY's own agent loop is stripped.

> **Platform: Windows only.** The quota panel and credential keep-alive depend on Windows Credential Manager. The other features have no cross-platform implementation and are untested on macOS/Linux.

---

## Credentials and network behaviour (stated plainly)

- **Reads**: the Google OAuth blob that AGY stores in Windows Credential Manager (target `gemini:antigravity`), via `CredRead` in `src/agy/keepalive.ts`. Used for two things: deciding whether the token is close to expiry and should trigger one official-CLI renewal, and reading `access_token` for the quota queries below. The token stays in process memory; it is never logged or placed in an error message.
- **Quota queries — the only outbound request the plugin makes itself**: the token above is sent as `Authorization: Bearer` to the read-only quota RPCs of `https://daily-cloudcode-pa.googleapis.com` and `https://cloudcode-pa.googleapis.com`, together with AGY client identity headers (`User-Agent` / `X-Goog-Api-Client`) — the server returns different quota groups per client, and omitting them drops the Gemini group. **Those requests go to those two Google endpoints only; nothing is sent to third parties.**
- **Not done**: no interception, replay or forgery of generation requests; no token handed to third parties; no credentials read beyond the target above.
- **Renewal**: token rotation is performed entirely by the official `agy.exe`; the plugin only launches it once before expiry.

Evidence for the endpoint semantics and identity-header behaviour: `docs/prod-generation-feasibility-20261020.md`.

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

MIT. Source derived from Darkings' `dsh-agy-provider` (MIT); the original copyright and full commit history are preserved in `LICENSE` and in this repository's git history.
