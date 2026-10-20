# prod（cloudcode-pa.googleapis.com）与 daily（daily-cloudcode-pa.googleapis.com）端点关系调研报告

- **调研时间**：2026-10-20 06:30–11:5x（本地 Asia/Shanghai）；网络证据基准=当日抓取，本机证据基准=agy.exe v1.4.2（200,970,904 B，mtime 2026-10-18 10:51）与其日志
- **通道说明**：web_search 不可用；联网经 web_fetch（api.github.com 直连 + r.jina.ai 代理抓官方文档/搜索页）。GitHub issue 全文均直读原文（非转述缓存）
- **委托任务**（m00002）：查清 prod vs daily 的关系与用途，回答 5 问；每条结论标注证据等级；查不到写"未找到"；严禁编造
- **证据等级**：【官方一手】=Google 自有资产（官方文档、官方二进制、官方 CLI 日志、官方仓库维护者回复）；【第三方实现注释】=第三方开源项目源码/文档记载；【社区实测】=issue/论坛可复现个人报告；【未找到证据】=明文列出

---

## ① 结论速览

| 问 | 结论 | 依据等级 |
|---|---|---|
| Q1 发布体系关系 | 同一服务族（`cloudcode-pa` API，proto `google.internal.cloud.code.v1internal.CloudCode`）的**多环境部署**可证（二进制内 5 个环境前缀 host 并存）；但 **autopush→daily→prod 构成灰度发布环——未找到任何官方说法**。第三方另有"prod=VS Code Cloud Code 时代的 legacy production、daily=Antigravity 现行"的历史叙述（非官方） | 一手+未找到 |
| Q2 prod 是否正式生产端点 | 是**正式（非 sandbox）端点**，但官方口径只到"企业侧 license discovery + model catalog + telemetry"与"CLI Tier 3 网关模型发现"。**"面向所有人的正式生成端点"官方文档：未找到**；consumer 打 prod 生成实测全失败 | 官方一手 |
| Q3 是否服务特定账号 | 无官方路由声明（未找到）。最强非官方证据：第三方反汇编官方 agy 的 `UpdateEndpointURL`——`personal_consumer`→ exclusively daily，`business_licensed_enterprise`/`business_agent_platform_paygo`→prod，零跨层回退；官方 CLI 存在 `CLOUD_CODE_URL` 覆盖开关（官方仓库用户日志实证）。注意 `usesGcpTos` 字段语义混杂（Pro=true、Ultra=false），不是干净的 consumer/企业判别式 | 第三方+社区实测 |
| Q4 consumer 能否在 prod 生成 | **不能（现况多方一致，无一成功报告）**：24/24 consumer 账号 prod 生成 429；官方仓库多人切 prod 后 400/403 变 429。**但 prod 的读 RPC 对 consumer 返回 200**，且模型目录比 daily 新（含 Enterprise-only 的 3.7 条目，目录≠资格） | 社区实测交叉 |
| Q5 额度是否不同池 | **是，两套独立账本（本报告最硬结论）**：同 token 同刻双域对照，prod 的 gemini-5h 恒 remainingFraction=1、resetTime 恒=now+5h（从未记账）、fetchAvailableModels 恒 1.0；daily 值与官方 IDE/`agy /usage` 逐值吻合。**consumer 真账本只在 daily**；prod 读数是满额/陈旧合成视图 | 社区实测≥4 源 |

**一句话总答**：daily 是 consumer 账号（Free/Pro/Ultra/One）现行的生成端点与唯一真实记账账本；prod 是无前缀的正式默认 host，现况服务面=企业侧许可证发现/模型目录/telemetry + CLI Tier-3 发现，对 consumer 生成关闭（429）、额度读数不记账；两者属同一 `cloudcode-pa` 服务族的不同环境，"灰度发布环"无官方依据。

---

## ② 逐条证据

### Q1 发布体系关系

**【官方一手·本机二进制直读】** `F:\AgentData\antigravity\cli\agy.exe`（v1.4.2），边界感知 host 扫描：

| host | 独立命中 | offset | 语境 |
|---|---|---|---|
| `cloudcode-pa.googleapis.com` | 多处（总 9） | 60562483（`https://…`）、64889893/64892349/64898039/64898135（proto 注释 `cloudcode-pa.googleapis.com/AgentPlugin`、`…/Health`、GetAgentPlugin/ListAgentPlugins/GetHealth/RecordTrajectoryAnalytics） | 另有 token `ccpa_missingaicode_error`（59173814）+`aicode_error` |
| `daily-cloudcode-pa.googleapis.com` | 1 | 60722504 | `https://` 默认网关 URL |
| `autopush-cloudcode-pa.sandbox.googleapis.com` | 1 | 60946791 | 环境表 |
| `preprod-daily-cloudcode-pa.sandbox.googleapis.com` | 1 | 61025019 | 环境表（裸 `cloudcode-pa` 朴素搜索命中的其实是它的子串，见下 official-identity.json 注） |
| `cloudcode-pa.sandbox.googleapis.com` | 2 | — | 环境表 |
| `businessaicode.googleapis.com` | 28 | — | 企业侧生成/编排（见 Q2） |

**【官方一手·包路径】** 官方仓库 issue 中的官方栈符号路径：`google3/third_party/jetski/language_server/code_assist_client/http_helpers.go`、`codeassistclient`（antigravity-cli#1255 的 root cause 引用、CLIProxyAPI#5209 评论同名路径）——`v1internal` proto 命名空间 `google.internal.cloud.code.v1internal.CloudCode` + `google.internal.cloud.code.v1internal.JetskiService`（本机第三方二进制直读产物 `F:\defws\tmp\20261012-agy-peer-survey\repo_chaos-03x__dsh-agy\dsh-agy-main\docs\official-identity.json:329-365` 记录，含 4 baseUrl+3 otherHost 清单；:354-359 注释记录"裸 cloudcode-pa 在二进制恰好出现一次且是 preprod-daily-… 子串"——与边界感知方法论互证）。

**【第三方实现注释·历史叙述】** cockpit-tools#2520 原文把 prod 称 "the **legacy** production endpoint used by VS Code Cloud Code"，并称 "It does not support Antigravity 2.0's 5-hour sliding quota smoothing"。这是第三方视角的"prod 早于 Antigravity、daily 承载新机制"叙述，与二进制现状相容，但非官方发布体系说明。

**【未找到证据】** Google 任何官方渠道（docs / issuetracker / 员工发言）关于 autopush→daily→prod 发布环的说明。issuetracker 搜索 `cloudcode-pa` 跳转登录墙（公开面为空）。民间三层分法（RUNTIME=[daily,prod]/DISCOVERY=[daily,prod,daily-sandbox]/BOOTSTRAP=[prod]）只对应第三方回退表（dsh-agy-link `src/host/oauth.ts:64-70`），属实现策略非官方架构。

### Q2 prod 的官方定位

**【官方一手】Google 企业文档** https://antigravity.google/docs/enterprise/ （r.jina.ai 抓取）"Network allowlists & mTLS endpoints"：
- 表行：**"Cloud Code Telemetry & Client Services (Standard HTTPS) → `cloudcode-pa.googleapis.com`"**；同表并列 `businessaicode.googleapis.com`（.us.rep/.eu.rep/.mtls 区域变体）与 `aiplatform.googleapis.com`。全表**不出现** daily-cloudcode-pa 或任何 sandbox host。
- 正文（逐字）："Route `businessaicode.googleapis.com` and `cloudcode-pa.googleapis.com` through your global PSC endpoint or Private Google Access configuration so **initial license discovery and model catalog requests** succeed."
- → 官方把 prod 定位为企业网络必须放通的 **许可证发现 + 模型目录 + telemetry** 正式服务。

**【官方一手】本机官方 CLI 日志** `C:\Users\toast\.gemini\antigravity-cli\log\cli-20261020_064119.log`：
- `I1020 06:41:19 [ModelConfig] Resolving models from Tier 3 (Gateway discovery at https://cloudcode-pa.googleapis.com, wireProtocol: )`
- `W1020 06:41:20 [ModelConfig] Tier 3 gateway discovery failed: …/v1/models returned status 404. Falling back to Tier 4.`
- 二进制内 model_discovery 四级 Tier 字符串：Tier1=Inline admin_settings（61251141）、Tier2=Remote catalog（61224686）、Tier3="Gateway discovery at %s"（61290336）、Tier4=Built-in default catalog（61251219）。
- → 官方 CLI 把 **prod 当 Tier-3 网关模型发现端点**，对 consumer 身份 `/v1/models` 404 回退内置目录。本机其余 400+ 个 cli-*.log 全部只有 daily 命中（prod=0），唯此文件 prod=4。

**【官方一手·旁证】consumer 运行时流量全在 daily** ——官方仓库 antigravity-cli 用户日志（issue 内官方 `http_helpers.go` 行格式）：#1255（`Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse"`）、#1238（同端点 broken pipe）、#183（孤儿进程每 6 分钟轮询 `daily…:loadCodeAssist`/`:fetchAvailableModels`/`:listExperiments`）、#1086（web_search 走 `daily…:generateContent`）、#1134（consumer：`daily…:loadCodeAssist`；ADC 企业路径：models 直接走 `aiplatform.googleapis.com` 且不调 loadCodeAssist）。**#1016 里企业 WIF 用户日志：`URL: https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` + `SelfAssignLicense`**（antigravity-cli#1110）——企业侧 loadCodeAssist 打 prod，与 Q2/Q3 图景自洽。

**【未找到证据】** 官方文档存在"prod 是（面向所有人的）正式生成端点"的表述；antigravity.google/docs 各页不含 `v1internal` 端点说明；`v1internal` RPC 面整体不在公开文档中。公开搜索面（Bing/Google 经 r.jina.ai）对 `"cloudcode-pa.googleapis.com"` 只返回无关页——网页索引基本不收录该主机名技术讨论，无法从搜索面补官方说法。

### Q3 按账号路由的证据

**【未找到证据】** Google 官方声明按账号类型路由 daily/prod。

**【第三方实现注释·反汇编】router-for-me/CLIProxyAPI#5209**（2026-08-24/25，closed=completed；方法自述=binary disassembly of official agy + 24 live consumer accounts 探测；评论 5392347048 附重建伪代码）：
- `CLIAuthProvider.ResolveAuthMode` 枚举：`personal_consumer`(Free/Pro/Ultra/Google One)/`business_licensed_enterprise`(Workspace/Enterprise)/`business_agent_platform_paygo`(GCP PayGo)/`pending_business_onboarding`；判别输入=`loadCodeAssist` 响应的 license/gcpManaged/project。
- `CLIAuthProvider.UpdateEndpointURL` 优先序：**`CLOUD_CODE_URL` env > 自定义 config > AuthMode 严格路由**——`personal_consumer`→ exclusively daily（"No fallback to Prod!"），企业/PayGo→prod。行为矩阵："Official agy never called prod for consumers; CPA（旧版）fallback daily→prod causes 429 cooldown cascades"。
- 与本机二进制字符串、以及下列官方仓库用户实测全部吻合。

**【社区实测·官方仓库】CLOUD_CODE_URL 覆盖真实存在且生效** —— antigravity-cli#1016（maintainer=chandrashakherkamasani 有回复）：
- 评论 5710650804（Windows，consumer）：`CLOUD_CODE_URL=https://cloudcode-pa.googleapis.com` 后日志 `URL: https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist`，403 PERMISSION_DENIED 原样（资格判定两域都有）。
- 评论 5731041448（agy 1.2.6）、5820926775（1.2.10）、5949689150（1.2.14）、5952544232（macOS Ultra）：daily 下 Gemini=`FAILED_PRECONDITION 400 User location is not supported`、Claude 正常；**仅换 CLOUD_CODE_URL=prod → 变 `RESOURCE_EXHAUSTED 429`**——单一变量换端点、错误种类改变，两后端各自独立资格/额度判定。
- maintainer 首评口径（官方一手发言）：资格拒绝是 "server-side account and regional eligibility restrictions enforced by Google's backend services"，本仓只收 CLI 客户端 bug——官方承认后端按账号/区域判定存在，但未公开规则。
- 评论 6258139199（10-19，agy 1.4.2）：全模型 429、`authMethod=consumer, quotaProject=`（空）、CLI 不调 `v1internal:onboardUser`；同机 IDE 调了 onboardUser 后正常——consumer 侧还存在 onboardUser 供给步骤差异。

**【第三方】判别式的坑** —— cockpit-tools#2520：付费 consumer（g1-pro-tier）`loadCodeAssist` 返回 `currentTier:{id:"g1-pro-tier", usesGcpTos:true}`，cockpit 按 `usesGcpTos` 路由 prod（`resolve_cloud_code_base_url`，`crates/cockpit-core/src/modules/quota.rs:259` 与 `src-tauri/src/modules/quota.rs:263`）→ 读数失真；t3code#21115 则报 AI Ultra `usesGcpTos:false`。**`usesGcpTos` 不是干净的 consumer/企业判别式**；quota-station PR#7 与 cockpit 建议修法的共同判据="GCP ToS 且有非 `aicode-consumers` 的真实 project → prod，其余 → daily"。`aicode-consumers`＝consumer 伪 project 占位（t3code#21115 与 antigravity-cli#1086 请求体均见 `"project":"aicode-consumers"`）。

**【第三方实现注释】** dsh-agy 文档（同工作区 `F:\defws\tmp\20261012-agy-peer-survey\repo_chaos-03x__dsh-agy\dsh-agy-main\docs\ANTIGRAVITY-API.md:9-12`）："Production … Returns 429 for consumer OAuth accounts (enterprise/license use) — verified"；autopush-sandbox 403 "consumer has no license"。artifex-mcp#1 也记载其实现把 prod 只放进 `LOAD_CODE_ASSIST_ENDPOINTS`、不放 `GENERATE_IMAGE_ENDPOINTS`——第三方普遍把 prod 当发现/引导面、daily/sandbox 当生成面。

### Q4 prod 对 consumer 的可用性

**生成：不可用（现况），无任何成功报告。**
- 【社区实测·大样本】CLIProxyAPI#5209：24 个活跃 consumer 账号同 token 同 payload——daily **24/24 = 200 流式正常**；prod **24/24 = 429 RESOURCE_EXHAUSTED**，"Google gates this endpoint to enterprise/GCP-licensed accounts"。
- 【社区实测·官方仓库】antigravity-cli#1016 至少 5 人（Win/macOS/Linux，consumer/Pro/Ultra/1.2.6→1.4.2 多版本）：切 prod 全部 429 或 403，无一例成功。
- 【社区实测】shanliuling/dsh-image-gen#75（AI Plus）：daily=500（自身请求体缺陷）、prod=429 RESOURCE_EXHAUSTED。
- 【社区实测】Wei-Shaw/sub2api#8129（10-15，Google AI Pro，`g1-pro-tier`，valid project）：prod `streamGenerateContent(gemini-3.7-flash-high)`=429；daily 同模型=404 NOT_FOUND；作者明确记录"未获得任何一次 3.7 生成成功，429 只算失败请求不算可用性证明"。
- 【本机委托方自测】（m00002 输入事实）：prod 生成 4/4 = 429 "Resource has been exhausted"、无模型名、无 quotaResetTimeStamp。

**读 RPC：对 consumer 返回 200，但内容与 daily 不同、且不可作资格依据。**
- sub2api#8129：prod `fetchAvailableModels` 200，列 `gemini-3.7-flash-low/med/high` 带非零 quota + **"Leaving Soon"** 元数据；daily 200 但 22/23 个模型**无 3.7**。作者引官方 https://antigravity.google/docs/models/ ——**Gemini 3.7 Flash 只列 Enterprise 档不列 AI Pro/Ultra**（官方一手的按套餐能力表）→ prod 目录比 daily 新/全，但目录条目≠该账号可调资格；"prod catalog entry legacy/stale metadata" 是作者疑点，官方未答。
- t3code#21115：prod `retrieveUserQuotaSummary` 对旧 UA 也返回 Gemini 组（daily 同 UA 不返回），但值是满额假账（见 Q5）。
- router-for-me/Cli-Proxy-API-Management-Center#499（10-16）：daily 的 summary 自 10-15/16 起只回 Claude/GPT 组（按 UA 版本门控，旧 UA `antigravity/hub/1.0.0` 缺 Gemini 组、`2.24.0` 齐全）；把 prod 排端点表首位即"恢复"Gemini 组——**两域组集合随 UA/时间漂移**。同周多项目撞同一变更（antigravity-priority#3、openusage#1397、AgEnD#1898、claude-usage-tray-windows#204，均记 daily 缺组/prod 保组的对照）。

**【未找到证据】** 任何"consumer OAuth 在 prod 生成成功"的报告（含付费档、含旧时段）。

### Q5 额度池是否独立

**结论：独立两本账，consumer 真实消费只记 daily。同 token 同刻双域对照实验 ≥4 个独立来源，且 daily 侧逐值对上官方 IDE/CLI。**
- 【社区实测 A】jlcodes99/cockpit-tools#2520（9-20，g1-pro-tier）：官方 IDE "Models & Usage" 5h=0%（撞限、20 分钟刷新）、weekly=50%；同时同 token——prod summary：`gemini-5h remainingFraction=1`、weekly=0.8331（陈旧）；daily summary：`gemini-5h=0`、`weekly=0.5004` + description "You have hit your 5-hour limit…"（与 IDE 逐值吻合）。原文："Calling retrieveUserQuotaSummary on cloudcode-pa **always returns gemini-5h remainingFraction=1.0** and a stale weekly quota"。
- 【社区实测 B】amlyczz/dsh-agy-link#48（10-18，free-tier，closed）：面板取 prod（weekly 86%、5h 恒 100%）vs `agy /usage` 取 daily（92%、97%）；**连查 5 次 prod `gemini-5h` resetTime 恒=now+5h、remainingFraction 恒 1——"该桶从未开始计时/记账"**；daily `retrieveUserQuota` 12 个 gemini 模型 `remainingFraction=0.9711094`、resetTime `2026-10-18T21:14:37Z` 与 CLI 完全一致。根因=`AGY_ENDPOINTS` prod 排第一 + 命中条件只看"有没有 gemini 组"不看"是否记账"。
- 【社区实测 C】pingdotgg/t3code#21115（10-18，AI Ultra）：prod `gemini-5h`/`gemini-weekly` **"permanently stuck at 100% left"、"those prod buckets are unused … never reflect real consumer Gemini usage"**；daily（UA=2.24.0）返回 live `gemini-weekly 0.8504`/`gemini-5h 0.7467`。配套 PR t3code#21020 记录 prod summary 的 proto3 零值省略行为与 `aicode-consumers` 占位 project 细节。
- 【社区实测 D】sylearn/AIUsage#81（10-19）：旧实现打 `cloudcode-pa…/fetchAvailableModels`（UA 1.11.3）**"It always returns remainingFraction: 1.0 for all models"**；改 `daily…/retrieveUserQuotaSummary`（POST、UA 2.24.0、body `{"project":"aicode-consumers"}`）后拿到真实双窗口 groups；并记 `disabled:true` 桶语义（周额度耗尽时 5h 桶被 disabled）。
- 【判据推论】与团队"同源权威"准则一致：读数与生成必须同端点同账本。prod 读 200 且有 Gemini 组 ≠ prod 承担该账号额度——对 consumer 它是**不记账的合成/备用视图**（对企业账号是否记账，无 consumer 侧观测可判，未找到证据）。

---

## ③ 明确列出"没查到什么"

1. **autopush→daily→prod 灰度发布环的官方确认**：未找到。官方一手只支持"同一服务族多环境并存（5 host）"。
2. **"cloudcode-pa 是面向所有人的正式生产生成端点"的官方文档表述**：未找到。官方口径=企业 license discovery/model catalog/telemetry + Tier-3 网关发现；`v1internal` RPC 面整体无公开文档。
3. **官方按账号类型路由（consumer→daily、企业→prod）的公开声明**：未找到。机制记载全部来自第三方反汇编（#5209）+ 用户侧 CLOUD_CODE_URL 实测，二者互相吻合但无官方文本。
4. **"consumer 在 prod 生成成功"的任何报告**：未找到（含付费档）。
5. **prod 的 Gemini 桶为何对 consumer 恒满/onboardUser 与资格预配的确切规则**：未找到官方解释；社区只证现象。
6. **daily 于 2026-10-15/16 起按 UA 隐藏 Gemini 组的官方说明**：未找到（只有多项目同期观测）。
7. **Google 员工/维护者对两域关系的正面阐述**：未找到（issuetracker 公开面为空；antigravity-cli 维护者只定性"服务端按账号/区域的资格限制"，未解释端点架构；sub2api#8129 向维护者求确认 prod 目录条目是否 stale metadata，无人答）。
8. **两域底层 quota 是否同一 GCP 配额系统**：未找到证据——观测只到"账本内容不同"。
9. **prod 对 enterprise/GCP 账号是否承担生成**：无一手可验证来源（企业侧报告只见 loadCodeAssist/SelfAssignLicense/catalog 调用打 prod，生成走 businessaicode/aiplatform 的描述来自企业文档路由语境+二进制 businessaicode 28 次出现，未见企业用户直接贴出 `cloudcode-pa:streamGenerateContent` 成功样本）。

## 附：本机可复核资产
- 二进制 host/Tier 字符串 offset 表：见 Q1/Q2（边界感知扫描，非朴素子串；agy.exe v1.4.2）
- Tier-3 prod 日志：`C:\Users\toast\.gemini\antigravity-cli\log\cli-20261020_064119.log`（其余 400+ 日志均 daily-only）
- 第三方端点表原始直读记录：`F:\defws\tmp\20261012-agy-peer-survey\repo_chaos-03x__dsh-agy\dsh-agy-main\docs\`（ANTIGRAVITY-API.md:9-12；official-identity.json:329-365）
- 民间三层分法对应实现：dsh-agy-link `src/host/oauth.ts:64-70`（daily→prod→daily-sandbox→autopush-sandbox 回退表）

## ④ 对额度面板的直接含义（供委托方取用）
- 查 consumer 账号 Gemini 额度必须打 **daily** `v1internal:retrieveUserQuotaSummary`，UA 需带现行版本号（否则 Gemini 组缺席），并把 `remainingFraction` 缺失按 0 处理、检查 `disabled`。prod 兜底只能在"确认该桶在记账"的判据下用（5h resetTime≈now+5h 恒满=不记账特征，dsh-agy-link#48 已给出 stale 判据 `remainingFraction===1 && reset-now>4.5h`）。
- 这与既有记忆结论一致并升级为多源实证：daily=灰度环境但恰是 consumer 现行主链路+真账本；prod=默认正式 host 但对 consumer 是"目录新、生成关、账不记"的企业服务面。
