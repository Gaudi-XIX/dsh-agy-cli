# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-agy-provider)](https://www.npmjs.com/package/dsh-agy-provider)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-provider)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Gaudi-XIX/dsh-agy-provider)](https://github.com/Gaudi-XIX/dsh-agy-provider)

将本机已合法登录的 **Google Antigravity CLI (AGY)** 转化为 [DeepSeek Harness (DSH)](https://github.com/darkings/dsh) 的原生顶级模型 Provider。

---

## 核心设计定位：DSH 掌管 Harness 全局，AGY 仅作合规算力引擎

与市面上大量同类 Anti-gravity 插件不同，`dsh-agy-provider` 从立项第一天起就确立了清晰的控制权分界：

> **Harness（工作区沙箱、审批系统、工具链执行、上下文预算与长程记忆）100% 由 DSH 接管；**  
> **AGY CLI 被彻底剥离外围权限与自带工具，降维收编为纯粹的模型算力与合法额度供给通道。**

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
                       │ ├─ stdinMode: hold 管道守护│
                       │ ├─ 状态机拦截 & 思考链折叠 │
                       │ ├─ 按轮预算多模态图片桥接  │
                       │ └─ 尾流式交付 & 断流文本兜底│
                       └─────────────┬─────────────┘
                                     │ (stream-json IPC)
                                     ▼
                       ┌───────────────────────────┐
                       │      Native agy.exe       │
                       │   (纯模型推理 + 合法配额)   │
                       └───────────────────────────┘
```

---

## 与其他 Anti-gravity 方案的本质区别

### 1. 完全合规、完全安全（Compliance & Security by Design）

* **拒绝逆向黑产链路**：
  绝大多数第三方方案采用“逆向工程私有 RPC、内存抓取/硬编码存储 Google OAuth Token、自建本地 HTTP 反代”的方式，极易触发 Google 官方风控甚至封号。本插件**零私存凭据、零网络伪造**，100% 委托用户本机通过官方安装程序正常登录的 `agy.exe` 原生接管。
* **绝不绕过安全审批（`dsh-owned` 权限闭环）**：
  许多套壳插件为了省事，在后台向 CLI 注入 `--dangerously-skip-permissions`，导致系统命令在无沙箱状态下任意裸奔。本插件**严禁传递任何越权标志**，所有 Shell 命令、文件写操作、网络请求全部无缝交还 DSH 宿主的沙箱（`sandboxPolicy`）与审批策略（`read-only` / `workspace-write` / `danger-full-access`）。
* **Fail-Closed 结构化防御**：
  对所有提示词帧施加严苛的 56 KiB 安全上限，工具调用施加严格的 Schema 白名单和原型链防污染检查，从协议层面杜绝越权与注入攻击。

### 2. 通过技术手段，形成经过编排的尾流式输出（Orchestrated Tail-Stream Delivery）

* **终结流式“回滚抹平”顽疾**：
  官方 `agy.exe` 原生是为终端打字交互设计的，管道极其敏感：外部一旦提早关闭标准输入（EOF），CLI 会误判为“用户取消轮次”而触发 `CORTEX_STEP_STATUS_CANCELED`，导致用户看到文字刚流出就被全部清空回滚。本方案通过 `stdinMode: hold` 精准锁定输入管道生命周期，配合按输出实时重置的动态看门狗，彻底解决了生成回滚顽疾。
* **思考过程与结果沉淀（思维链折叠跟随）**：
  在输出流底层构建状态机，将冗长交错的 Thought 思考链与工具调用过程实时收敛折叠并跟随最新行，在最终生成完成时平滑沉淀并交付干净、规范的**尾流式答案**。
* **部分答案兜底（Partial Output Recovery）**：
  即便遇到网络长连接中断，已产生的有效文字绝不丢弃，系统会自动截留保留，并将中断原因以注记形式附于末尾。

---

## 我们与原生 AGY 的能力范式跃迁

跳出底层实现细节，在实际使用能力上，本插件让 Anti-gravity 实现了三大根本性跃迁：

| 能力维度 | 原生 Anti-gravity CLI（终端黑框） | 经过 dsh-agy-provider 增强后 |
| :--- | :--- | :--- |
| **生态连接** | 封闭终端孤岛，仅能使用几个简陋内置命令 | **接入 DSH 现代 Agent 宇宙**：海量 MCP 工具、长程记忆河流（Memory River）、多智能体子代理协作 |
| **多模态视界** | **4 张图片硬限制**：超过 4 张直接抛错崩溃，长对话发图导致整个会话报废 | **自愈型长程视界**：按轮动态预算（当前轮 ≤4 张）+ 磁盘内容寻址暂存 + 历史路径占位回溯，长对话无限发图不崩溃 |
| **额度与治理** | 盲盒状态：被 prod 虚假满额欺骗，Token 频繁静默过期导致调用中断 | **真相透明与静默保活**：直读 daily 真实双窗口账本，毫秒级过期倒计时，临期以最小开销触发原生 Token Rotation 免重新登录 |
| **模型交互** | `gemini-3.8-flash-high` 等机械硬编码选项，切换繁琐 | **基座与思考强度解耦**：左侧选择基座（Flash 3.8 / Pro 3.1 等），右侧选择强度（Auto / Low / Medium / High） |

---

## 技术选择的代价与内在缺陷（Trade-offs & Limitations）

没有任何架构是万能的。选择“DSH 掌控 Harness、严格合规与尾流编排”，必然意味着我们承担了以下工程代价与缺陷：

1. **双重事件循环的协议阻抗（Protocol Impedance & Latency）**：
   DSH 拥有自己的 Tool Loop，底层的 AGY CLI 内部也有一套内置循环。为了让 DSH 绝对主导，我们必须在管道边界拦截意图并二次转译。这导致每执行一步工具，都需要经历进程管道的跨界流转，**多步工具链的端到端耗时高于纯内存内直连 API**。
2. **上下文管理的“双重记账”摩擦（Double-Accounting Context Friction）**：
   DSH 拥有全局上下文裁剪与压缩机制，而底层 CLI 内部也固执地维护着自己的会话数据库。为了防止“DSH 已经裁掉旧历史，底层 CLI 却还在使用旧上下文”的幽灵错位，每次全量投递都必须在严苛的管道输入字节上限内做精细裁剪，对大上下文吞吐带来了一定限制。
3. **首字延迟感知（TTFT Lag）**：
   由于子进程拉起、握手自检、思考链拦截折叠以及尾流编排的前置处理，输出无法做到直连 HTTP 裸流那样的“毫秒级逐字蹦字”，用户在首字涌现前会有短暂的前置等待感。
4. **天然放弃灰色号池套利**：
   严格绑定本机 Windows 凭据管理器中的单一合法账号，官方给多少配额就用多少配额，无法像反代插件那样在后台挂几十个黑产 Token 进行并发负载均衡。

---

## 安装与配置

### 1. 前置要求
- Node.js >= 20
- 本机已安装官方 **Google Antigravity CLI (`agy`)** 且已通过 `agy` 命令登录。

### 2. 通过 DSH 插件管理器安装
在 DSH 桌面端或 Web/Headless 模式下安装：

```powershell
# 桌面端 / Web 配置文件安装
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

## 诊断与健康检查

插件内置了不消耗模型额度的系统诊断工具：

```powershell
# 运行配置文件健康体检
npx dsh-agy-provider doctor --profile desktop --json

# 运行自动化测试套件（317 项全部通过）
npm test
```

---

## 来源与开源协议

本项目基于 **[Darkings/dsh-agy-provider](https://github.com/darkings/dsh-agy-provider)**（MIT）进行深度适配与架构重塑。

遵循 [MIT 许可证](LICENSE) 开源。
