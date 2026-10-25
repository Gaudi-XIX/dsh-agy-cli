# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-agy-provider)](https://www.npmjs.com/package/dsh-agy-provider)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-provider)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Gaudi-XIX/dsh-agy-provider)](https://github.com/Gaudi-XIX/dsh-agy-provider)

Integrates the locally authenticated **Google Antigravity CLI (AGY)** as a native model provider for [DeepSeek Harness (DSH)](https://github.com/darkings/dsh).

---

## Architectural Core: DSH Governs the Harness, AGY Powers Compliant Compute

Unlike common community Anti-gravity plugins, `dsh-agy-provider` establishes a strict division of responsibilities and control boundaries:

> **The Harness (workspace sandboxing, approval policies, tool execution, context budgeting, and long-term memory) is 100% owned and executed by DSH;**  
> **The AGY CLI is stripped of all tool permissions and demoted to a pure, compliant inference and quota provider.**

```text
       ┌────────────────────────────────────────────────────────┐
       │                   DeepSeek Harness                     │
       │  ┌─────────────────┐ ┌───────────────┐ ┌─────────────┐ │
       │  │ Workspace / CWD │ │ Sandbox/Perms │ │ MCP / Tools │ │
       │  └────────┬────────┘ └───────┬───────┘ └──────┬──────┘ │
       │           │                  │                │        │
       │           ▼                  ▼                ▼        │
       │               DSH ToolRuntime & Event Loop             │
       └─────────────────────────────▲──────────────────────────┘
                                     │ (dsh-owned tool calls)
                       ┌─────────────┴─────────────┐
                       │     dsh-agy-provider      │
                       │ ├─ stdinMode: hold guardian│
                       │ ├─ State-machine & Thought │
                       │ ├─ Turn-budgeted image br. │
                       │ └─ Tail-stream & recovery  │
                       └─────────────┬─────────────┘
                                     │ (stream-json IPC)
                                     ▼
                       ┌───────────────────────────┐
                       │      Native agy.exe       │
                       │ (Pure Inference & Quota)  │
                       └───────────────────────────┘
```

---

## Technical Comparison with Peer DSH AGY Quota Plugins

Compared to other DSH plugins that utilize AGY quota, this project differs fundamentally across three architectural dimensions:

### 1. Credential & Protocol Trust Boundary: Process Delegation vs. Reverse-Engineered Private RPC Proxy

* **Peer Plugin Technical Path**:  
  Extract and persist OAuth tokens within the DSH process, forge client headers, and make direct HTTP requests to Google Cloud Code private RPC endpoints, frequently accompanied by multi-account rotation mechanisms for quota scheduling.
* **Our Technical Path**:  
  Zero credential storage, zero credential exfiltration, and zero forged network traffic. All upstream requests are signed and sent by the user's legitimately installed, official `agy.exe` binary; DSH communicates with the local process exclusively through standard `stream-json` IPC pipes. A precise boundary statement: the plugin's **token keep-alive** and **quota panel** do read the OAuth blob that AGY itself stores in the Windows Credential Manager (`gemini:antigravity`), but only to check expiry and read the quota identity. Token rotation is performed exclusively by the official binary's own silent auth (Google's client secret lives inside the closed-source `agy.exe` and is physically unreachable), and the plugin never uses the credential as auth material for requests of its own — fundamentally different from extracting a token to forge a client.
* **Advantages**:
  - **Zero Risk of Account Bans or Abuse Flags**: Network transport (TLS, IP address, protocol fingerprints) and client authentication are handled entirely by the official binary. There is no risk of accounts being banned due to reverse-engineered private APIs or forged client fingerprints.
  - **Clean Credential Boundary**: The plugin maintains zero credential stores; credentials flow through local memory only and never reach a log line or an error message.
* **Trade-offs (Costs)**:
  - **Inability to Support Multi-Account Pooling**: Strictly bound to the single authenticated local OS account, without in-memory account cycling or concurrent rotation. Quotas are strictly governed by official single-account limits.
  - **Strict Host Environment Prerequisite**: Requires a pre-installed, officially authenticated CLI binary on the host machine.

---

### 2. Execution & Sandbox Authority: DSH-Exclusive Authority vs. Bypassed Permissions

* **Peer Plugin Technical Path**:  
  To simplify execution, some wrapper plugins inject `--dangerously-skip-permissions` into child processes, running commands unconstrained outside the sandbox; others allow internal CLI tool loops to overlap with DSH's tool loop, creating race conditions.
* **Our Technical Path**:  
  Injecting privilege escalation flags is strictly forbidden. The AGY CLI is restricted to pure model inference. Generated tool invocation intents are intercepted at the pipe layer, returning full execution control (100%) to DSH's ToolRuntime, strictly adhering to DSH's sandbox policy (`read-only` / `workspace-write` / `danger-full-access`) and user approval gates.
* **Advantages**:
  - **Strict Sandbox Integrity**: All file operations, shell commands, and network calls execute under DSH host governance; the model cannot bypass the sandbox through the underlying CLI.
  - **Single Execution Loop**: Eliminates dual-loop race conditions between CLI internal tool mechanisms and DSH's host tool system.
* **Trade-offs (Costs)**:
  - **Inter-Process IPC Latency**: Each tool execution step must traverse process boundaries (intent capture -> DSH host execution -> formatted input frame replay). Multi-step tool chains exhibit higher end-to-end latency than pure in-memory direct API bindings.

---

### 3. Stream Pipeline & Lifecycle Control: State-Machine Orchestration vs. Raw Stream Passthrough

* **Peer Plugin Technical Path**:  
  Raw stdout from child processes is passed directly outward. Because the AGY CLI stdin lifecycle is not managed, an early EOF on stdin causes the CLI to misinterpret the turn as canceled (`CORTEX_STEP_STATUS_CANCELED`), rolling back and clearing previously streamed tokens; outputs also intermingle raw thought traces with final answers.
* **Our Technical Path**:  
  Employs `stdinMode: hold` to actively maintain the stdin pipe open until an explicit completion frame is emitted by the CLI. An output state-machine intercepts the stream, folding thoughts in real time and settling a clean, deterministic tail-stream answer at turn completion. Streamed text is safely preserved even upon unexpected pipe disconnects.
* **Advantages**:
  - **Eliminates Stream Rollback**: Completely resolves the issue of tokens being rolled back due to premature stdin closure.
  - **Structured Output Delivery**: Intermediate reasoning traces and final delivery text are cleanly stratified, preventing raw logs from polluting conversation history.
* **Trade-offs (Costs)**:
  - **Increased Pre-Roll Latency (TTFT)**: Each turn incurs process spawn, CLI startup handshakes, and state-machine pre-processing overhead, introducing a 1–2 second delay before the first token appears compared to raw HTTP streaming.
  - **Sensitivity to Closed-Source Binary Changes**: The external state machine tightly couples with the CLI's `stream-json` line format. Upstream schema or error payload modifications require maintenance updates.

---

### Summary of Architectural Trade-offs

| Engineering Trade-offs / Concessions | Architectural Gains / Advantages |
| :--- | :--- |
| **No multi-account pool cycling** (bounded by single-account quota) | **Zero account ban risk** (100% compliant official authentication and network fingerprint) |
| **Inter-process IPC latency** (cross-boundary tool call overhead) | **Guaranteed sandbox integrity** (DSH exclusively owns ToolRuntime and approval gates) |
| **Higher initial latency (TTFT) & state-machine maintenance** | **Zero stream rollback** (structured tail-stream delivery and partial text recovery) |

---

## Two Ancillary Surfaces (Honest Disclosure)

Besides the model main path, the plugin ships two ancillary capabilities that **do touch the credential blob**, both loopback-only:

1. **Token keep-alive** (`tokenKeepaliveMs`, checked every 60 s by default): the blob read only decides expiry; the actual rotation happens when the plugin starts the official `agy.exe` once on the last tick before expiry (input pipe closed immediately, zero billed tokens) and AGY's own silent auth rotates the credential. A failed attempt for a given expiry is remembered and never re-spun.
2. **Quota panel** (the card on the Models page + `/plugins/agy-link/status`): reads the blob to show the account identity (email/name) and expiry countdown, and fetches remaining quotas from Google's quota endpoint using the keyring token. All panel routes are loopback-only.

Neither surface performs billed inference, persists credentials, or lets a credential reach a log line or an error message.

---

## Relationship with dsh-zcode-provider: Two Ends of One Spectrum

The same author's [`dsh-zcode-provider`](https://github.com/Gaudi-XIX/dsh-zcode-provider) pushes this technical route to the opposite end; the difference between the two plugins is the cleanest demonstration of "harness ownership":

- **This plugin = DSH governs the harness.** The AGY CLI exposes a stream-json event protocol and structured tool-call envelopes, so the model only *thinks* — every *action* (tool execution, approvals, sandbox, context) happens inside DSH.
- **dsh-zcode-provider = the ZCode CLI governs the harness.** ZCode 0.17.0 exposes no bare-model interface, no tool projection, and its quota is bound to the official signing channel — with no interface to build on, the task is delegated wholesale to the CLI.

**Selection rule**: multi-step tool tasks belong on this plugin (quality is decided by DSH's harness); plain text Q&A belongs on the zcode route (harness strength is irrelevant there). One provider decides one harness — the provider a session picks is the harness it runs under.

---

## Installation & Configuration

### 1. Requirements
- Node.js >= 20
- Official **Google Antigravity CLI (`agy`)** installed and authenticated via `agy`.

### 2. Install via DSH Plugin Manager

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add dsh-agy-provider@0.10.0
```

### 3. Recommended Configuration (`cordis.patch.yml`)

```yaml
- id: dsh-agy-provider
  name: dsh-agy-provider
  config:
    enabled: true
    provider: agy
    model: gemini-3.8-flash
    visibleModels:
      - gemini-3.8-flash
      - gemini-3.1-pro
    models:
      - id: gemini-3.8-flash
        name: Gemini 3.8 Flash
      - id: gemini-3.1-pro
        name: Gemini 3.1 Pro
    toolPolicy: dsh-owned
    sessionMode: resume
    imageInput: experimental
    stdinMode: hold
    timeoutMs: 900000
    idleTimeoutMs: 300000
    modelDiscovery: off
```

---

## Diagnostics & Testing

```powershell
# Run profile diagnostic inspection without consuming quota
npx dsh-agy-provider doctor --profile desktop --json

# Run automated test suite
npm test
```

---

## License

Derived from **[Darkings/dsh-agy-provider](https://github.com/darkings/dsh-agy-provider)** (MIT).  
Licensed under the [MIT License](LICENSE).
