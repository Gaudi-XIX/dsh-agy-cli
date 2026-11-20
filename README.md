# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

把本机已登录的 **Google Antigravity CLI（`agy`）** 接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 作为一级模型提供方。

> 拒绝反代与协议模拟的封号隐患，告别套壳黑盒失控。插件采用本地官方 CLI 原生直通路线：非反代、非伪造请求头，凭据永驻本机，不改动官方二进制、不替换官方签名；DSH 全权接管工具调度，执行步骤实时透明可见；深度优化长任务，内置工具压缩、长日志折叠与防误杀脱敏，从底层保障纯净上下文与长程稳定。

**这个插件的三件事：**

1. **生成流量由官方二进制自己签名** —— 每一轮模型请求都通过官方 `agy.exe` 发出，插件不代它签名、不接管它的生成链路，模型侧的风控面与官方客户端一致。
2. **吃到 Antigravity 账号的官方额度** —— 消耗打在你自己的套餐上，与官方客户端同池同规则，不需要 API Key。
3. **AGY 只当模型，DSH 接管 harness** —— 工具执行、审批、沙箱、上下文预算 100% 在 DSH；AGY 自带的 agent 循环被剥离。

> **平台限制**：**仅 Windows**。配额面板与凭据保活依赖 Windows Credential Manager；其余功能无跨平台实现，未在 macOS/Linux 验证。

## 产品定位：四维框架

只留四层：为什么做、主动放弃了什么、别人没有的、比别人更耐操的。及格线级别的通用能力统一收敛到文末「基线支持与兼容性」，不当卖点。

### 维度一 · 立项痛点与触动

三类现实问题促成这个插件：**账号封禁风险**（反代与协议模拟的通道形态和官方客户端不一致，风控面因此变化，代价却落在使用者的账号上）、**套壳黑盒失控**（模型生成链路与工具执行都不透明，出错只能靠猜）、**长任务上下文雪崩**（历史输出与长日志持续累积，预算先于任务耗尽）。

### 维度二 · 路线与战略放弃

走**本机官方 CLI 原生通道**：每一轮生成都由官方 `agy.exe` 发出并签名，插件只做桥接（`src/agy/persistent-transport.ts`）。路线成立的前提是承认代价，所以主动放弃五样东西：

- 放弃**云端一键免登与零门槛接入** → 换取凭据不出本机，通道形态与官方客户端一致。
- 放弃**把网页版逆向成 API、用 Cookie 爬虫** → 换取不引入逆向链路带来的账号面。
- 放弃**篡改模型生成机制、给二进制打补丁** → 换取官方数字签名完好，模型侧风控面与官方客户端一致。
- 放弃**多账号池化与账号轮换** → 换取单账号原生合规，机制上不存在「同 IP 多账号并发」这一关联面。
- 放弃**外挂黑盒全自动调度** → 换取 DSH 全权接管，执行步骤百分之百可追溯可审查。

### 维度三 · 独有壁垒（人无我有）

在这条路线下，六条合规边界都能打开源码逐条核对。每一条都是「主动选择不做什么」的正面证据，不是与谁比较的结论。

| # | 合规边界 | 本仓实现 |
|---|---|---|
| 1 | 非网页逆向 | 通道是 AGY 1.1.15 stream-json 的 NDJSON（`src/agy/persistent-transport.ts`）：不把网页版逆向成 API、不用 Cookie 爬虫、不解析浏览器流量 |
| 2 | 零二进制篡改 | 只 `spawn` 官方 `agy.exe`（`src/agy/persistent-transport.ts`）：不打内存补丁、不破机器码、不替换官方签名，生成流量由官方二进制自己签名 |
| 3 | 单账号原生合规 | 只用本机已登录的那一个账号，不建账号池、不做轮换；每个 AGY 进程同一时刻只跑一个活跃 turn（`src/agy/persistent-transport.ts`） |
| 4 | 官方公开参数合规接管 | 用官方 Agent 预设的公开参数 `excludeDefaultComponents: true` 关停官方默认组件（`src/agent-presets.ts`、`agents/dsh-agy-mcp-executor.md`）：接管走官方公开接口，不私改协议 |
| 5 | 凭据本地沙箱驻留 | 只从本机 Windows Credential Manager 读 target `gemini:antigravity`（`src/agy/keepalive.ts`）：读到即用、不落日志、不进错误消息；续期由官方 `agy.exe` 自办 |
| 6 | Retry-After 智能退避 | 可重试错误按服务端 `Retry-After`（数值秒或 HTTP-date）等待，单次上限 24 小时（`src/agy/errors.ts`）；接线在 `src/provider/agy.ts`，用例在 `tests/error-classification.test.mjs` |

### 维度四 · 深度加固（人有我优）

通用能力谁都能写，写到不崩才算数：

- **工具上下文投影**：默认只下发基础终端与文件能力，其余按需发现后挂载（`dsh_discover_tools`，`src/mcp/tool-projection.ts`），工具 Schema 体积随之下降。
- **长输出自适应折叠**：超预算的历史命令输出与长日志保留首尾、紧凑折叠中间（`foldToolResultText`，`src/provider/prompt-budget.ts`）。
- **敏感防御**：下发前软化上游易触发的词与指令对抗短语（`cloakPrompt`，`src/provider/prompt-cloak.ts`，接线在 `src/provider/agy.ts`）；日志与错误消息统一走脱敏（`redactText`，`src/agy/redact.ts`）。
- **流式容错与断连保文本**：`stdinMode: hold` 防回滚（`src/agy/process.ts`，默认值见 `src/provider/agy.ts`），尾流逐段交付，连接断掉不丢已经交付的文本。

---

## 凭据与网络行为（如实写清）

这一点容易被含糊带过，所以直接列出来：

- **读取**：Windows Credential Manager 里 AGY 写入的 Google OAuth blob（target `gemini:antigravity`），由 `src/agy/keepalive.ts` 的 `CredRead` 完成。用途有两个：判断令牌是否临近过期并触发一次官方 CLI 续期；读取 `access_token` 用于下面的配额查询。读到的令牌只在进程内使用，不落日志、不进错误消息。
- **配额查询（唯一的插件自带出站请求）**：把上面读到的 `access_token` 作为 `Authorization: Bearer` 发往 `https://daily-cloudcode-pa.googleapis.com` 与 `https://cloudcode-pa.googleapis.com` 的只读配额 RPC（`retrieveUserQuotaSummary` / `fetchAvailableModels`），并附带 AGY 客户端的身份头（`User-Agent` / `X-Goog-Api-Client`）——服务端对不同客户端返回的配额分组不同，不带身份头会漏掉 Gemini 组。**请求只发往 Google 这两个端点，不外传第三方。**
- **不做的**：不拦截、不重放、不伪造生成请求；不把令牌交给任何第三方；不读取除上述 target 以外的凭据。
- **续期**：令牌轮换完全由官方 `agy.exe` 自己完成，插件只负责在到期前拉起它一次。

实测依据见 `docs/prod-generation-feasibility-20261020.md`（两个端点的配额语义、身份头对返回值的影响）。

## 功能

- **底层官方提示词物理剥离（Lean Prompt）**：通过 Agent 预设底层关停官方默认臃肿系统提示词与内置工具链（`excludeDefaultComponents: true`），上下文零冗余负担，将全部提示词预算完整保留给 DSH 自身的工作区与规则。
- **自适应识别基础能力，支持工具按需动态挂载**：默认只下发基础终端与文件读写能力，辅以轻量发现工具（`dsh_discover_tools`），工具 Schema 体积随之收缩；其他能力在被调用时即时自动挂载，兼顾极小上下文与无缝调用。
- **历史长输出智能折叠**：自动识别多轮交互中超过预算的历史命令输出与长日志，智能保留首尾关键状态并紧凑折叠中间冗余，防止上下文滚雪球。
- **防拒答脱敏清洗**：下发前自动打散易触发上游生硬过滤的敏感词与指令对抗短语，大幅提升复杂指令与 Agent 请求的稳定率。
- **双工具路线**：MCP 桥把 DSH 工具交给 AGY（真工具事件、过程流可视化，推荐），失败自动降级为 prompt 契约
- **DSH 主导 harness**：工作区、审批、沙箱、上下文预算全在 DSH；AGY 只出模型
- **流式 + 状态机**：`stdinMode: hold` 防回滚、工具步骤折叠显示（只列执行了哪些工具，不显示模型的内部思考内容）、尾流交付、断连保文本
- **会话管理 + 历史指纹链**：resume / full 双模式，每轮成功后记录 DSH 历史指纹；resume 前本地比对前缀，检出历史被编辑/压缩/截断即废弃旧会话并从完整历史重建，delta prompt 不会落在过期上下文上；死亡会话自动重放，会话映射落盘可迁移
- **图片输入**（experimental）：附件经图片桥落盘，由最小权限的 view_file Agent 查看
- **配额面板与凭据保活**：loopback-only；面板显示真实双窗口配额，令牌临近过期时自动拉起官方 CLI 续期
- **安全加固**：原型污染防线、MCP 桥面闸门、面板 loopback 门与原子写、凭据脱敏——全部有测试背书

## 安装

```console
dsh plugin --profile <你的 profile> add dsh-agy-cli
```

前置要求：Windows；本机已安装并登录官方 Antigravity CLI（`agy`）；Node ≥ 20。

**装完必须再跑一步**（否则 AGY 会报 unknown agent——插件自带的 Agent 预设没有装进 AGY 的 agent 目录）：

```console
npx dsh-agy-cli agents install read-only --apply
npx dsh-agy-cli agents install workspace-write --apply
```

`--apply` 会写入 `~/.gemini/antigravity-cli/gemini-root-config/agents`；`--backup` 可先备份，`agents list` 可查看当前状态。宿主重启后，设置页「模型」里会出现本插件的配置卡（模型可见性、推理强度、配额面板）。

**诊断**：`npx dsh-agy-cli doctor --profile <profile>` —— 覆盖安装、bundle 声明、Agent 预设、配置解析、凭据状态，全程不消耗额度。

## 开发与门禁

```bash
npm ci --ignore-scripts
npm run typecheck
npm test    # tsc 全量 → 39 个 *.test.mjs 逐档跑
```

## 基线支持与兼容性（Baseline Parity）

及格线能力集中放这里，不进卖点：

| 项目 | 现状 |
|---|---|
| 模型清单 | 运行时从 `agy models` 发现（`src/agy/models.ts`），不写死白名单 |
| 推理强度 | `gemini-*` 走 `--effort` 档位，`claude-*` 不需要（`src/provider/agy.ts`） |
| 平台 | 仅 Windows：配额面板与凭据保活依赖 Windows Credential Manager |
| 凭据 | 用本机已登录的官方 AGY 账号额度，不额外配置 API Key |
| 许可 | MIT |

## 许可

MIT。原作者版权与完整提交历史保留于 `LICENSE` 与本仓 git 历史。
