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
  Zero token extraction, zero token storage, and zero forged network traffic. All model generation is strictly delegated to the user's legitimately installed, official `agy.exe` binary. DSH communicates with the local process exclusively through standard `stream-json` IPC pipes.
* **Advantages**:
  - **Zero Risk of Account Bans or Abuse Flags**: Network transport (TLS, IP address, protocol fingerprints) and client authentication are handled entirely by the official binary. There is no risk of accounts being banned due to reverse-engineered private APIs or forged client fingerprints.
  - **Clean Credential Boundary**: The plugin maintains zero credential stores and exposes zero credential leak surface.
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
