# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

把本机已登录的 **Google Antigravity CLI（`agy`）** 接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 作为一级模型提供方。

> 拒绝反代与协议模拟的封号隐患，告别套壳黑盒失控。插件采用本地官方 CLI 原生直通路线：非反代、非伪造请求头，凭据永驻本机，不改动官方二进制、不替换官方签名；DSH 全权接管工具调度，执行步骤实时透明可见；内置批处理工具、动态工具投影、8.8KB 输出折叠、全链路遥测切断、180s 阶梯看门狗与技能全量透传，兼顾长程稳定与日常工程效率。

**这个插件的核心职责：**

1. **生成流量由官方二进制自己签名** —— 每一轮模型请求都通过官方 `agy.exe` 发出，插件不代签名、不替换生成链路，模型侧风控面与官方客户端一致。
2. **消耗 Antigravity 账号官方额度** —— 请求走本机已登录账号套餐，与官方客户端同池同规则，无需额外配置 API Key。
3. **AGY 只做模型推理，DSH 接管 Harness** —— 工具执行、权限审批、工作区沙箱与上下文预算由 DSH 负责，通过公开预设参数剥离 AGY 自带 agent 循环。

> **平台限制**：**仅支持 Windows**。配额面板与凭据保活依赖 Windows Credential Manager；进程看门狗、配额命令行嗅探与无窗口启动器亦围绕 Windows 实现，未在 macOS/Linux 验证。

---

## 产品定位：四维框架

### 维度一 · 立项痛点与触动

三类实际工程痛点促成这个插件：
- **账号风控暴露**：反代服务与协议模拟会改变请求指纹和通道形态，代价最终落在使用者账号上。
- **黑盒套壳失控**：模型生成与内部工具调用不透明，卡死、空回或权限拒批时只能靠猜。
- **长任务失稳与短轮次空耗**：历史日志和工具大返回迅速撑爆上下文；单次工具频繁往返加上断网遥测重试风暴、子进程假死挂起，大幅拉长端到端耗时。

### 维度二 · 路线与战略放弃

坚持**本机官方 CLI 原生直通**：每轮生成均由官方 `agy.exe` 发出并签名，插件只负责协议桥接与宿主托管（`src/agy/persistent-transport.ts`、`src/agy/process.ts`）。路线成立必须先承认代价，插件主动放弃以下五项：

- 放弃**云端免配与一键开箱** → 换取凭据永驻本机 Windows Credential Manager，通道特征与官方客户端对齐。
- 放弃**逆向网页 API 或 Cookie 爬虫** → 换取不引入非官方协议逆向风险。
- 放弃**篡改官方二进制或内存补丁** → 换取官方数字签名完整无损，不破坏客户端自身校验。
- 放弃**多账号号池与轮换调度** → 换取单账号原生合规，不存在单机多号并发关联风险。
- 放弃**外挂黑盒全自动循环** → 换取 DSH 宿主级透明调度，每一步工具调用可审计、可拦截。

### 维度三 · 独有壁垒（人无我有）

在本地官方 CLI 直通路线下，以下八条机制边界均可对照源码逐条验证：

| # | 机制边界 | 盘上实现依据 |
|---|---|---|
| 1 | 非网页逆向 | 通信基于 AGY 1.1.15 `stream-json` NDJSON 协议（`src/agy/persistent-transport.ts`），不解析网页流量。 |
| 2 | 零二进制篡改 | 仅直接 `spawn` 官方 `agy.exe`（Windows 下经无黑框启动器 `bin/win32-x64/agy-launcher.exe` 透传句柄，不改写目标程序）。 |
| 3 | 单账号原生合规 | 仅使用本机当前登录账号，不建号池、不做轮换，单一进程同一时刻只执行一个活跃 turn。 |
| 4 | 公开参数合规接管 | 使用官方 Agent 模板公开字段 `excludeDefaultComponents: true` 停用默认内置工具（`agents/dsh-agy-mcp-executor.md`），不依赖私有逆向参数。 |
| 5 | 凭据本地沙箱驻留 | 仅在检查/续期与面板查额时从 Windows Credential Manager 读取 `gemini:antigravity`（`src/agy/keepalive.ts`），不外传、不写入提示词或日志。 |
| 6 | 全链路遥测切断 | 主进程与双 transport 启动子进程时统一注入 4 个禁用环境变量，阻断断网状态下的 Clearcut 每 5 秒无退避重试风暴（`src/agy/process.ts`、`src/agy/experimental-transport.ts`、`src/agy/persistent-transport.ts`）。 |
| 7 | 180s 阶梯看门狗 | 超时后先发 stdin EOF 与取消信号并给予 3s 优雅退出宽限，未退出则执行 Windows `taskkill /t /f` 进程树强杀，避免孤儿进程占住端口或文件锁（`src/agy/process.ts`）。 |
| 8 | 历史指纹防错乱 | `resume` 模式每轮记录 DSH 历史前缀指纹，若历史被编辑、截断或压缩，立即丢弃旧会话并用完整历史重建，防止增量消息错位（`src/provider/agy.ts`）。 |

### 维度四 · 深度加固（人有我优）

- **首轮只下发最小必要工具（动态按需投影）**：默认仅向模型暴露基础终端、文件读写工具及轻量发现入口 `dsh_discover_tools`，将全量 Schema 的上万 Token 占用压缩至极小集合；当任务需要额外能力时，模型自行按关键词检索并挂载对应工具到当前会话（`src/mcp/tool-projection.ts`、`src/mcp/bridge.ts`）。
- **复合批处理工具与事务写盘**：`apply_edits` 在内存中先做全量匹配预检（All-or-Nothing），全部命中才统一落盘，任意一处失败则 0 文件修改，彻底杜绝半成品脏工作区；`read_slices` 支持按行区间批量切片与顶层符号大纲提取，压降大文件读取轮次与上下文开销（`src/mcp/batch-tools.ts`）。
- **8.8KB 输出安全折叠与 ANSI 清洗**：主动将单次工具返回折叠在 8800 字节内（保留首尾关键内容），避开上游 CLI 超过 10KB 强制落盘临时文件并迫使模型二次读取的额外开销；同步清洗 ANSI 颜色控制符与 `\r` 进度条刷新噪音（`src/mcp/output-filter.ts`）。
- **历史长输出自适应折叠与脱敏清洗**：超过 `toolResultFoldThresholdBytes`（默认 2048 字节）的历史工具结果折成首尾摘要；`promptCloak` 对敏感模式做温和脱敏以提升长程稳定性（`src/provider/prompt-budget.ts`、`src/provider/prompt-cloak.ts`）。
- **流式防回滚状态机**：默认 `stdinMode: 'hold'` 保持管道直到收到终止 `result` 帧，避免过早 EOF 触发官方 `store manager` 取消已输出的生成内容。

---

## 0.17.0 能力清单

1. **进程看门狗（180s 超时 + 树杀优雅终止）**：`src/agy/process.ts` 默认设置 `DEFAULT_WATCHDOG_MS = 180_000`（未显式配置更长 `timeoutMs` 时生效），到期先关闭 stdin 并发送终止信号，等待 `WATCHDOG_GRACEFUL_MS = 3_000`（3 秒）后升级为进程树强杀（Windows `taskkill /pid <pid> /t /f`，POSIX 进程组 `SIGKILL`），根治 `agy` 假死与孤儿进程残留。
2. **本地免登录配额统计（`npm run quota`）**：`src/quota/`（`discovery.ts`、`summary.ts`）配合 `scripts/check-quota.mjs` 实现无浏览器查额，自动扫描日志端口与进程 `csrf_token` 并通过本地 ConnectRPC 读取各模型剩余配额与重置倒计时。
3. **批处理工具真接线（`apply_edits` / `read_slices`）**：批处理工具从原先仅在 Schema 投影层可见，已在 `src/mcp/bridge.ts` 接入真实调度执行路径，大模型可直接在单轮完成多文件原子替换或切片读取。
4. **全链路 transport 遥测禁用**：不仅主路径 `runProcess`，`experimental-transport.ts` 与 `persistent-transport.ts` 在 spawn 子进程时均强制注入 `DO_NOT_TRACK=1`、`ANTIGRAVITY_DISABLE_TELEMETRY=1`、`GOOGLE_CLOUD_DISABLE_TELEMETRY=1`、`DISABLE_TELEMETRY=1`，彻底根除断网时 Clearcut 每 5 秒重试风暴，并在启动失败时附着 `spawnStderrDetail`。
5. **`dsh_discover_tools` 搜索可发现性增强**：`DISCOVER_TOOLS_DESCRIPTOR` 描述更新为引导模型在能力受阻时自行以关键词检索宿主完整工具注册表并按名挂载，不点名具体工具名、不硬编码白名单。
6. **`EMPTY_RESPONSE` 会话级一次性兜底**：发生无文本且无工具调用的 `EMPTY_RESPONSE` 时标记当前会话（5 分钟 TTL，上限 64 个会话），同会话下一次请求自动在提示词末尾追加一次性文本回复引导，不改动稳定前缀以保住缓存命中，避免重复空转。
7. **技能全量透传与原生发现**：`src/agy/skills-config.ts` 在插件启用时幂等更新 `~/.gemini/config/skills.json`，注入 `~/.agents/skills` 全量全局技能目录且完整保留用户原有 `entries` / `inherits`；项目级技能依靠工作区 `cwd` 原生发现 `.agents/skills`，不写技能白名单；无预设的主回合不传 `--disable-slash-commands`。
8. **刷新额度联动模型目录与 `--mode` 冲突抑制**：面板刷新额度（`refresh-quota`）对模型发现传 `{ force: true }` 跳过 5 分钟 TTL 缓存与失败冷却，前端直接消费返回的新 `catalog` / `catalogModels` 字段；`--disable-slash-commands` 与 `--mode` 的参数冲突在 `one-shot` 与 `persistent` 两条 spawn 路径实现对称抑制。
9. **模型发现期限、隐藏名单移除与图片预设按需门控**：移除旧 `DISCOVERY_AWAIT_MS` 4 秒硬期限，等待上限统一由配置项 `modelDiscoveryTimeoutMs`（默认 `10000` ms，范围 `100`~`30000` ms）控制；`/status` 改为 `peekCatalog()` peek-first 优先读缓存不阻塞，插件启动时触发后台预热；彻底移除 `hiddenModels` 手动隐藏名单，发现即显示；`dsh-agy-image-view` 预设改为仅本轮消息真实带图（`turnHasImages`）才换入，历史图不再把整轮锁进图片检查模式。

---

## 安装与宿主挂载

### 前置要求

- **操作系统**：Windows（实测 Windows 11）。
- **Node.js**：`>= 20`。
- **官方客户端**：本机已安装并登录 Google Antigravity CLI（`agy --version >= 1.1.15`）。

### 方式一：标准 DSH Profile 安装（推荐普通用户）

必须安装到 DSH Profile 依赖目录，不要只在普通目录执行 `npm install`：

```powershell
npx @deepseek-ai/dsh plugin --profile desktop add dsh-agy-cli
```

（若使用 Web profile，将 `desktop` 替换为 `web`。）

### 方式二：Junction / 本地源码链接部署（本地开发调试推荐）

本地源码开发仓可通过本地路径链接（DSH / pnpm 会在目标 profile 的 `node_modules\dsh-agy-cli` 创建指向源码目录的 Windows **Junction**），改动代码并构建后重启宿主即可生效，无需反复打包安装：

```powershell
# 1. 在源码仓构建产物（生成 lib/ 与 dist/）
npm run build

# 2. 挂载本地源码仓到 DSH profile（自动写入 link: 依赖并建立 Junction）
npx @deepseek-ai/dsh plugin --profile desktop add link:F:/AgentData/dsh-agy-cli
```

或者手动确认 / 建立目录 Junction（以 `desktop` profile 为例）：

```powershell
# 查看是否已建立 Junction 指向本地开发仓
Get-Item "$env:USERPROFILE\.dsh\profiles\desktop
ode_modules\dsh-agy-cli" | Select-Object LinkType, Target
# 实际数据目录若位于 F:\AgentData\dsh\data\profiles\desktop
ode_modules\dsh-agy-cli，
# 也可使用 cmd /c mklink /J <profile>
ode_modules\dsh-agy-cli F:\AgentData\dsh-agy-cli
```

### 安装 Bundled Agent 预设（必做）

仅安装插件不会自动把内置 Agent 模板写入 AGY 目录；需执行一次模板安装，否则 AGY 会报未知 Agent：

```powershell
npx dsh-agy-cli agents list
npx dsh-agy-cli agents install mcp-executor --apply
npx dsh-agy-cli agents install image-view --apply
```

默认写入 `~/.gemini/antigravity-cli/gemini-root-config/agents`（可通过 `--dir` 指定目录，加 `--backup` 可先备份同名旧模板）。

### 诊断自检（零额度消耗）

```powershell
npx dsh-agy-cli doctor --profile desktop
```

检查安装状态、Bundle 声明、Agent 预设、配置解析与凭据有效期，全程不发送模型请求。

---

## `npm run quota` 用法

在本地终端直接探测运行中的 AGY Language Server 端口与模型配额，无需打开浏览器网页登录：

```powershell
cd F:\AgentData\dsh-agy-cli
npm run quota
```

**工作原理**：
1. 扫描 `~/.gemini/antigravity-cli/log/` 下最新的 `cli-*.log`（最多 3 份），提取 `Language server listening on random port at <port> for HTTP` 监听端口（可通过环境变量 `AGY_QUOTA_LOG_DIR` 覆盖日志目录）。
2. 在 Windows 上通过 `Win32_Process` 查询 `language_server` 进程命令行中的 `csrf_token`。
3. 以 ConnectRPC 协议携带 `X-Codeium-Csrf-Token` 请求本地 `127.0.0.1:<port>` 的 `GetUserStatus` 与 `RetrieveUserQuotaSummary`，格式化打印各模型剩余配额百分比与重置倒计时。

> **验证边界说明**：`src/quota/` 解析层（日志端口提取、token 提取、ConnectRPC 分段响应解析与报表渲染）已由单元测试 fixture 完整覆盖；真实端口连通场景需本机存在活跃的 `agy` / `language_server` 进程，未在无活跃进程的 CI 环境下端到端跑通。若探测报错找不到端口或 `csrf_token`，请先确认本机 `agy` 处于启动并已登录状态。

---

## 核心配置项表

以下配置字段与默认值对应 `src/provider/config.ts` 与 `cordis.patch.yml`（Bundle 默认启用 `enabled: true`、`toolPolicy: 'dsh-owned'`）：

| 配置项 | 类型 / 可选值 | 默认值（Bundle） | 说明 |
|---|---|---|---|
| `enabled` | `boolean` | `true`（库默认 `false`） | 是否启用 AGY Provider。 |
| `model` | `string` | `'gemini-3.1-pro'` | 默认基础模型 ID（不带 `-low`/`-medium`/`-high` 后缀）。 |
| `modelDiscovery` | `'auto' \| 'off'` | `'auto'` | 是否通过 `agy models` 自动发现可用模型；`off` 仅用静态配置。 |
| `modelDiscoveryTtlMs` | `number`（1000 ~ 3600000） | `300000`（5 分钟） | 模型发现结果内存缓存有效期（毫秒）。 |
| `modelDiscoveryTimeoutMs` | `number`（100 ~ 30000） | `10000`（10 秒） | 单次 `agy models` 发现超时上限；刷新额度时以 `{ force: true }` 直接受此项约束。 |
| `toolPolicy` | `'reject' \| 'agy-owned' \| 'dsh-owned'` | `'dsh-owned'` | 工具归属策略。`dsh-owned` 由 DSH 执行工具并切换 `dsh-agy-mcp-executor` 预设。 |
| `mcpBridge` | `boolean` | `true` | 是否经由本地 MCP Server 向 AGY 暴露 DSH 工具（推荐开启）。 |
| `mcpAdaptiveBaseOnly` | `boolean` | `true` | 是否开启首轮仅下发基础工具 + `dsh_discover_tools` 按需挂载。 |
| `toolResultFoldThresholdBytes` | `number`（256 ~ 1048576） | `2048` | 历史工具输出超过此字节数时触发首尾折叠摘要。 |
| `promptCloak` | `boolean` | `true` | 下发前对易命中上游误拦截的短语与标识进行温和脱敏。 |
| `imageInput` | `'off' \| 'experimental'` | `'experimental'` | 图片输入模式。`experimental` 仅在当前回合真带图时切入 `dsh-agy-image-view` 预设。 |
| `sessionMode` | `'resume' \| 'full'` | `'full'` | 会话模式：`full` 每轮发送完整上下文；`resume` 复用 AGY 会话并校验历史指纹。 |
| `stdinMode` | `'hold' \| 'close'` | `'hold'` | `hold` 保持 stdin 直到收到 `result` 结束帧（防中断回滚）；`close` 写完即关。 |
| `transport` | `'one-shot' \| 'persistent'` | `'one-shot'` | 进程传输模式：`one-shot` 按轮拉起；`persistent` 实验性长驻复用 worker。 |
| `timeoutMs` | `number`（1 ~ 3600000） | `900000`（`runProcess` 默认看门狗 180000） | 单次请求墙钟总上限（毫秒）；仅持续不停吐流的任务会触达，一般由下方静默超时判定。 |
| `idleTimeoutMs` | `number`（1 ~ 3600000） | `300000`（5 分钟） | 无输出静默超时（毫秒），每收到一行输出自动续期；必须小于 `timeoutMs`。 |
| `tokenKeepaliveMs` | `number`（0 ~ 3600000） | `60000`（1 分钟） | 检查 Credential Manager 凭据寿命的周期；`0` 为禁用。 |

---

## 故障排查

### 1. 模型发现超时怎么办？

- **机制说明**：插件已删除旧版 4 秒硬截断，`/status` 接口改为 `peekCatalog()` 优先读取内存缓存（0 等待），并在插件启动时后台异步预热；若冷启动时 `agy models` 拉起较慢，唯一等待上限取决于 `modelDiscoveryTimeoutMs`（默认 10,000 ms，上限 30,000 ms）。
- **排查做法**：
  1. 在终端手动执行 `agy models` 确认官方向导是否能正常秒回，若报错请先检查本机代理或登录状态；
  2. 若本机磁盘/进程冷启动固定偏慢，在配置中将 `modelDiscoveryTimeoutMs` 调大（如 `20000` 或 `30000`）；
  3. 在设置面板点击「刷新 / 同步」，该操作会传 `force: true` 跳过 5 分钟缓存和失败冷却重新发现；
  4. 若长期无需动态列表，可将 `modelDiscovery` 设为 `'off'` 并通过 `model` / `models` 固定目录。

### 2. `EMPTY_RESPONSE` 是什么意思？

- **成因**：AGY 的无头 print 模式没有按单个工具预放行的命令行开关，当模型试图调用某个需要交互确认的 AGY 内部工具时，CLI 会打印 `Print mode: soft-denying tool confirmation ...`，随后模型空等退出，本轮既没有生成正文也没有通过有效工具推进，插件将其捕获并抛出 `EMPTY_RESPONSE`。
- **现行兜底**：从 `0.17.0` 起，触发 `EMPTY_RESPONSE` 时插件会记录该会话（5 分钟 TTL）；宿主重试或同会话下一次请求时，插件会在提示词末尾附着一次性引导语，提醒模型直接文本回复或仅使用无需确认的工具，同时不破坏前缀缓存，避免连续空转。若高频出现，请确认 `toolPolicy` 为 `'dsh-owned'` 且已正确安装 `dsh-agy-mcp-executor` 预设（彻底剥离 AGY 内置工具）。

### 3. 为什么 `agy` 看不到 DSH 的技能目录？

请按两条技能发现路径逐项核对：
1. **全局技能目录（`~/.agents/skills`）**：插件启用时会自动调用 `ensureAgyGlobalSkills()` 向 `~/.gemini/config/skills.json` 幂等写入 `{"path": "~/.agents/skills"}`（不覆盖原有条目）。若该文件此前被手动改坏（不是合法 JSON 对象或缺少 `entries` 数组），插件不会强行覆盖，而是在 DSH 日志打印 `could not ensure AGY global skills config` 警告；修复或删去损坏文件后重启宿主即可自动重建。
2. **项目级技能目录（`<workspace>/.agents/skills`）**：AGY 原生要求以当前工作区为 `cwd`，且**不能传 `--disable-slash-commands`**。请注意：当配置使用 `dsh-owned`（自动挂载 `mcp-executor` 预设）或显式指定了 `agentPreset` 时，插件会主动传递 `--disable-slash-commands` 以锁定预设权限边界，此时 AGY 侧的斜杠技能发现会被关闭（技能统一由 DSH 宿主端挂载提示词与工具接管）。仅在不使用预设的主回合才会透传并保留工作区原生发现。

### 4. `history` 图占位符是什么？

- **机制说明**：在 `imageInput: 'experimental'` 下，只有**当前这一轮新发的消息**带有的图片才会被临时落盘并切入 `dsh-agy-image-view` 预设读取。早先历史回合发过的图片不会每轮重复拷贝，也不会再把纯文本续聊轮次锁死在图片检查模式里。
- **占位符格式**：历史图片会被物料化进稳定缓存目录 `<DSH_HOME>/agy-cli/image-cache`（默认保留 14 天），并在历史消息上下文中替换为纯文本占位符：
  - 缓存可用时：`[IMAGE_ATTACHMENT file=<绝对路径> media_type=<类型> width=<宽> height=<高> earlier_turn=cached]` —— 当后续模型确实需要回看早先某张图时，仍可按需读取该路径；
  - 当某张早期附件已失效、被删或格式不受支持时：`[IMAGE_ATTACHMENT media_type=<类型> width=<宽> height=<高> earlier_turn=unavailable]` —— 仅标记该图不可用，不会拖垮后续整段对话的正常推进。

---

## 开发与自测

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test        # 完整 tsc 构建后执行全量测试
npm run verify  # 依次执行 typecheck + test + npm pack --dry-run
```

---

## 附录：基线支持与兼容性矩阵

| 项目 | 现行状态 |
|---|---|
| 模型发现 | 运行时由 `agy models` 动态发现（`src/agy/models.ts`），无隐藏屏蔽名单，发现即显示 |
| 推理强度 | `gemini-*` 模型支持透传 `--effort`（low / medium / high）；`claude-*` 自动跳过该参数（`src/provider/agy.ts`） |
| 运行平台 | 仅 Windows：依赖 Windows Credential Manager、`taskkill /T` 及无窗口启动器 |
| 账号凭据 | 复用本机已登录官方 AGY CLI 账号配额，无需额外 API Key |
| 开源协议 | MIT（保留原作者版权声明与完整 Git 提交历史） |
