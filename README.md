# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-agy-provider)](https://www.npmjs.com/package/dsh-agy-provider)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-provider)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Gaudi-XIX/dsh-agy-provider)](https://github.com/Gaudi-XIX/dsh-agy-provider)

将本机已登录的 **Google Antigravity CLI (AGY)** 作为模型提供商接入 [DeepSeek Harness (DSH)](https://github.com/darkings/dsh)。

---

## 核心架构：DSH 掌控 Harness 全局，AGY 提供合规算力

与市面上常见的 Anti-gravity 相关插件不同，`dsh-agy-provider` 确立了严格的职责与控制权边界：

> **Harness（工作区沙箱、审批策略、工具执行、上下文预算与长程记忆）100% 由 DSH 接管并执行；**  
> **AGY CLI 被剥离外围权限与内置工具执行权，降维收编为纯粹的模型推理与合规配额供给端。**

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
                                     │ (dsh-owned 工具调用)
                       ┌─────────────┴─────────────┐
                       │     dsh-agy-provider      │
                       │ ├─ stdinMode: hold 管道守护│
                       │ ├─ 状态机编排 & 思考链折叠 │
                       │ ├─ 按轮预算图片协议桥接    │
                       │ └─ 尾流式交付 & 异常兜底   │
                       └─────────────┬─────────────┘
                                     │ (stream-json IPC)
                                     ▼
                       ┌───────────────────────────┐
                       │      Native agy.exe       │
                       │   (纯模型推理 + 合规配额)   │
                       └───────────────────────────┘
```

---

## 与其他 DSH AGY 额度插件的技术路径对比

针对市面上其他利用 AGY 额度的 DSH 插件方案，本项目在技术路径与架构设计上存在以下三个核心维度的差异：

### 1. 凭据与协议信任边界：进程级委托 vs 逆向自建反代

* **其他插件的技术路径**：  
  在 DSH 进程内提取并保存 OAuth Token，伪造客户端 Header，在内存中直接向 Google 内部私有 RPC 接口发起 HTTP 请求，通常辅以多账号轮换机制进行配额调度。
* **本插件的技术路径**：  
  不存储、不外发凭据，不伪造任何网络请求——所有上游流量都由本机安装的官方 `agy.exe` 二进制自己签名发起，DSH 仅通过标准 stream-json IPC 管道与之通信。需要精确说明的边界：插件的**凭据保活**与**配额面板**会读取 Windows 凭据管理器中 AGY 自己存放的 OAuth blob（`gemini:antigravity`），但只用于「判断过期时间」与「读配额身份」；token 的刷新完全由官方二进制自己的静默认证完成（Google 的 client secret 在闭源 `agy.exe` 内，插件物理上拿不到），插件从不把凭据用作自己发请求的认证材料——这与「抽 token 伪造客户端直连」有本质区别。
* **优势**：
  - **零风控与封号风险**：网络传输（TLS、IP、协议指纹）和客户端认证完全由官方二进制完成，不存在因逆向私有 API、伪造客户端特征被 Google 服务端识别为异常流量而封禁账号的风险。
  - **清晰的凭据安全边界**：插件本身不维护任何凭据存储；凭据只在本机内存中流经，不落日志、不进错误消息。
* **劣势（代价）**：
  - **无法构建多账号号池**：物理绑定本机已登录的单一合法凭据，无法在内存中实现多账号轮询或并发切号，配额上限严格受制于单账号官方额度。
  - **强依赖宿主环境**：运行前提是宿主物理机上存在已安装且已完成认证的官方 CLI 二进制。

---

### 2. 工具执行与沙箱控制权：DSH 独占执行权 vs 越权绕过沙箱

* **其他插件的技术路径**：  
  部分套壳插件为了简化流程，向 CLI 进程注入 `--dangerously-skip-permissions`，将命令执行权交由底层 CLI 裸跑；或者放任 CLI 内部工具逻辑与 DSH 自身的 Tool Loop 重叠，造成执行冲突。
* **本插件的技术路径**：  
  严禁向 CLI 传递任何越权参数。AGY CLI 被限定为纯模型推理器，其生成的工具调用意图在管道层被拦截，执行权 100% 收归 DSH 的 ToolRuntime，严格服从 DSH 的沙箱策略（`read-only` / `workspace-write` / `danger-full-access`）与用户审批规则。
* **优势**：
  - **沙箱完整性保障**：所有文件读写、Shell 命令和网络请求均在 DSH 宿主监管下运行，模型无法通过底层 CLI 逃逸沙箱。
  - **消除执行回路竞态**：消除了 CLI 内部工具逻辑与 DSH 宿主工具体系的双重事件循环竞态。
* **劣势（代价）**：
  - **跨进程 IPC 延迟**：每次工具调用必须在 DSH 与外部进程之间进行中转（意图捕获 → DSH 宿主执行 → 格式化回填输入），多步工具调用的端到端耗时高于纯内存内直连 API。

---

### 3. 流式管道与生命周期控制：状态机编排防回滚 vs 原始流简单透传

* **其他插件的技术路径**：  
  直接将子进程的标准输出向外透传。由于未适配 AGY CLI 的输入管道生命周期，输入端一旦提前收到 EOF，CLI 会触发内部任务撤回（`CORTEX_STEP_STATUS_CANCELED`），导致前面已输出的内容被全额回滚清空；同时输出中混杂原始 Thought 思考行。
* **本插件的技术路径**：  
  采用 `stdinMode: hold` 主动保持标准输入管道开启，直至收到 CLI 的明确完成帧；在输出端建立状态机拦截层，在流式生成过程中将思考链折叠收敛，并在最后平滑交付确定性尾流；遇异常断连可保留已流出的部分有效文本。
* **优势**：
  - **根除流式回滚**：彻底解决了 CLI 因输入流过早关闭而撤回 token 的问题，确保输出确定性。
  - **结构化输出交付**：中间思考状态与最终交付文本清晰分层，避免原始调试行污染主对话流。
* **劣势（代价）**：
  - **首字延迟（TTFT）增加**：每次调用需经历进程拉起、CLI 启动自检和前置状态机处理，首字延迟通常在 1~2 秒，无法达到直接发送 HTTP 请求的毫秒级即时响应。
  - **对闭源二进制变更敏感**：外部状态机强依赖 CLI 的 stream-json 行协议。一旦官方调整流式事件结构或错误格式，编排层必须跟进适配，维护成本高于标准的 HTTP 协议解析。

---

### 核心权衡总结

本项目与其他 DSH AGY 插件在额度利用上的根本权衡：

| 放弃的代价 / 劣势 | 换取的工程收益 / 优势 |
| :--- | :--- |
| **放弃多账号号池轮询**（受制于单机官方配额） | **零封号风险**（完全遵循官方二进制认证协议与网络指纹） |
| **承担跨进程 IPC 延迟**（多步工具调用存在管道开销） | **沙箱绝对受控**（DSH 100% 独占 ToolRuntime 与权限审批） |
| **较高的首字延迟（TTFT）与状态机维护成本** | **消除流式回滚**（规整的尾流交付与异常文本断流兜底） |

---

## 两个附加面（诚实披露）

除模型接入主链路外，插件还有两个会**接触凭据 blob** 的附加能力，均只在本机 loopback 语境下工作：

1. **凭据保活**（`tokenKeepaliveMs`，默认 60 秒检查一次）：读凭据 blob 只为判断过期时间；真正刷新靠插件在到期前的最后一个检查周期**主动启动一次官方 `agy.exe`**（立即关闭输入管道，产生零计费 token），由 AGY 自己的静默认证完成轮换。同一到期时刻的失败尝试会被记住，不会反复拉起进程。
2. **配额面板**（设置页「模型」里本行卡片 + `/plugins/agy-link/status`）：读凭据 blob 展示账号身份（邮箱/名字）与到期倒计时，并带着凭据管理器里的 token 由**本机直连 Google 的配额查询接口**拉取剩余额度。所有面板路由仅限 loopback 访问。

两个附加面都**不产生计费推理**、不落盘凭据、不把凭据带进任何错误消息或日志。

---

## 与 dsh-zcode-provider 的关系：同一光谱的两端

同一作者维护的 [`dsh-zcode-provider`](https://github.com/Gaudi-XIX/dsh-zcode-provider) 把本插件的技术路线推到了另一端，两者的差异是理解「harness 归属」最干净的对照：

- **本插件 = DSH 主导 harness**。AGY CLI 暴露了 stream-json 事件协议与结构化 tool-call 信封，所以模型只负责「想」，所有「做」（工具执行、审批、沙箱、上下文）都在 DSH 手里。
- **dsh-zcode-provider = ZCode CLI 主导 harness**。ZCode 0.17.0 不暴露裸模型接口、不吐工具投影、额度绑官方签名通道——接口没开门，插件侧变不出来，只能整轮任务委托。

**选型口径**：多步工具任务走本插件（质量由 DSH 的 harness 决定）；纯文本问答走 zcode 路线（harness 强弱无感，免费额度该用就用）。一个 provider 决定一个 harness——会话选了谁，谁就主导。

---

## 安装与配置

### 1. 前置要求
- Node.js >= 20
- 本机已安装官方 **Google Antigravity CLI (`agy`)** 且已通过 `agy` 命令登录。

### 2. 通过 DSH 插件管理器安装

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add dsh-agy-provider@0.10.0
```

### 3. 配置示例（推荐放入 `cordis.patch.yml`）

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

## 诊断与测试

```powershell
# 运行配置文件健康体检（不消耗模型额度）
npx dsh-agy-provider doctor --profile desktop --json

# 运行自动化测试套件
npm test
```

---

## 开源协议

本项目基于 **[Darkings/dsh-agy-provider](https://github.com/darkings/dsh-agy-provider)**（MIT）进行重构与增强。

遵循 [MIT License](LICENSE) 开源。
