# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-agy-provider)](https://www.npmjs.com/package/dsh-agy-provider)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-provider)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Gaudi-XIX/dsh-agy-provider)](https://github.com/Gaudi-XIX/dsh-agy-provider)

Transform the locally authenticated **Google Antigravity CLI (AGY)** into a native, top-tier model provider for [DeepSeek Harness (DSH)](https://github.com/darkings/dsh).

---

## Architectural Core: DSH Governs the Harness, AGY Powers Compliant Compute

Unlike typical community Anti-gravity plugins, `dsh-agy-provider` establishes a strict, non-negotiable separation of responsibilities:

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

## Fundamental Distinctions from Peer Anti-Gravity Solutions

### 1. Absolute Compliance & Security by Design

* **Zero-Reverse Engineering / No Stolen Tokens**:  
  Peer plugins frequently rely on reverse-engineering internal Google Cloud Code RPCs, extracting and persisting private OAuth tokens, or running unauthorized local HTTP proxies. This plugin stores **zero credentials** and forges no network requests; all authentication and generation are 100% delegated to the user's legitimately installed, official `agy.exe` binary.
* **Never Bypass Security Gates (`dsh-owned` Safety Loop)**:  
  Many plugins inject `--dangerously-skip-permissions` into the CLI background processes to bypass confirmation prompts, allowing arbitrary shell execution without isolation. We strictly forbid privilege escalation flags. All terminal runs, file modifications, and network operations are held to DSH's native sandbox (`sandboxPolicy`) and approval presets (`read-only`, `workspace-write`, `danger-full-access`).
* **Fail-Closed Structural Invariants**:  
  Hardcoded 56 KiB prompt-budget ceilings, strict schema allowlisting, and prototype-pollution defenses ensure no prompt injection or payload tampering can break containment.

### 2. Orchestrated Tail-Stream Delivery

* **Eliminating Stream Rollback (`CORTEX_STEP_STATUS_CANCELED`)**:  
  The native `agy.exe` was designed for terminal interactive typing. Its I/O pipes are fragile: an early stdin EOF leads the CLI to interpret the turn as canceled, rolling back all previously streamed tokens. Through `stdinMode: hold` and output-driven adaptive idle watchdogs, we guarantee zero stream rollback.
* **Structured Thought Folding & Tail-End Settlement**:  
  Our stream state machine folds messy internal thoughts and intermediate tool commands in real time, settling and delivering clean, structured, and deterministic final answers at the tail of the turn.
* **Partial Output Recovery**:  
  Even under network drops or upstream proxy flakes, streamed text is safely salvaged and presented with diagnostic rationale notes rather than dropped.

---

## Paradigm Shifts in Capabilities vs. Native AGY

| Capability Dimension | Native Anti-gravity CLI (Terminal TUI) | Enhanced by `dsh-agy-provider` |
| :--- | :--- | :--- |
| **Ecosystem Reach** | Isolated terminal sandbox, limited to built-in commands | **Full DSH Harness Universe**: Extensible MCP tools, Memory River, multi-agent teams |
| **Multimodal Vision** | **Hard 4-Image Cap**: Exceeding 4 images crashes the entire session permanently | **Self-Healing Long-Horizon Multimodal**: Turn-budgeted staging (current turn ≤ 4 images) + content-addressed disk caching + historical placeholder recovery |
| **Quota & Governance**| Black-box guesswork: deceived by prod 100% synthetic views, silent token expiry | **True Quota Transparency & Silent Keepalive**: Daily dual-window tracking with minute-level countdowns; automated keyring keepalive token rotation |
| **Model UX** | Hardcoded suffixes like `gemini-3.8-flash-high` cluttering menus | **Decoupled Base & Reasoning Effort**: Independent base model select (Flash 3.8 / Pro 3.1) and reasoning effort select (Auto/Low/Med/High) |

---

## Technical Trade-offs & Limitations

Choosing strict DSH harness ownership and pipe orchestration requires accepting explicit engineering trade-offs:

1. **Dual Event Loop Impedance & IPC Latency**:  
   DSH owns its own Tool Loop, while AGY has an internal agent loop. Intercepting and mapping tool calls across process pipes incurs higher end-to-end latency per tool call compared to direct in-memory API bindings.
2. **Double-Accounting Context Friction**:  
   DSH maintains global memory compaction, while `agy.exe` maintains its internal conversation store. Replaying full history requires strict frame budgeting (e.g. 56 KiB cap and tool section eviction) to avoid pipe choke-points.
3. **Pre-roll Latency (TTFT)**:  
   Process spawn, CLI self-checks, and thought-folding state machines add 1–2 seconds of pre-roll delay before the first token lands compared to bare HTTP streaming.
4. **No Multi-Account Pooling Arbitrage**:  
   We strictly adhere to the single authorized Windows Credential Manager account, with no support for unauthorized account-pool rotations.

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

## Diagnostics & Verification

```powershell
# Run profile diagnostic inspection without consuming model quota
npx dsh-agy-provider doctor --profile desktop --json

# Run test suite (all 317 tests passing)
npm test
```

---

## License

Derived from **[Darkings/dsh-agy-provider](https://github.com/darkings/dsh-agy-provider)** (MIT).  
Licensed under the [MIT License](LICENSE).
