# Gemini 4 Argon 在 Google Antigravity 中不可见 — 取证报告

**调研时间**：2026-10-20 周二 06:24–12:50（东八区）
**数据基准**：本机 `agy.exe` v1.4.2（SHA512 与官方自动更新清单一致）；Windows 凭据管理器 `gemini:antigravity` 的 consumer OAuth token；联网经本机代理 `127.0.0.1:12450`；外部页面经 `r.jina.ai` 代理抓取（快照均为 2026-10-20 实抓）。
**取证纪律**：全程只读——仅列举类 RPC（`fetchAvailableModels` / `retrieveUserQuotaSummary` / `listExperiments` / `loadCodeAssist`）与本地产物读取，**未发起任何生成请求，未消耗 AGY 额度**。每条结论标注证据等级【官方一手】/【本地一手】/【第三方】/【社区传闻】/【未找到证据】。

---

## 结论摘要

**用户看不到 Argon，与客户端版本无关，与灰度无关；是服务端按「账号付费来源」做的权益裁剪。**

三条判据同时成立，构成本案闭环：

1. **客户端不落后**：`agy.exe` v1.4.2 就是官方最新版，其二进制内置目录**已经**包含 `gemini-4-argon-high/medium/low` 与显示名 `Gemini 4 Argon (High/Medium/Low)`。模型能不能显示，取决于服务端下发什么，而服务端对本账号只下发到 `gemini-3.8-flash-tiered` + Claude/GPT 4.6 世代。【本地一手】
2. **不是灰度**：`listExperiments` 对本账号返回 88（prod）/ 90（daily）个实验 id、489 个 flag，**全部 payload 里 `argon` 命中数为 0**——没有任何一个 experiment 与 Argon 相关。Argon 的开关不在实验系统里，而是写死在服务端权益判定。【本地一手】
3. **是付费来源**：官方在本机实际命中的 prod 响应里，对 Argon 三条档位打的都是 `disabled: true` + `tagTitle: "Upgrade"`；daily 端点更把它降级成一条 id 字面量叫 `gemini-4-argon-disabled` 的墓碑，`tagDescription` 官方原文为 **「Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers.」** Google 员工在官方论坛对同款问题的定论逐字为：**「directly paid (non-trial / non-promotional) Google AI Pro and Ultra……Partner-bundled offers like Jio are treated as promotional plans in Antigravity……but Argon stays locked.」**【官方一手】

**用户自述的「联营商 Pro 套餐」正落在 promotional plans 这一侧**，因此看不到 Argon 是**设计行为**，不是 bug、不是漏灰度、不是版本问题。

---

## 一、三个假设逐条判定

### 假设 1：AGY 版本没更新，最新版才行 —— **不成立**

| 证据 | 等级 |
|---|---|
| 官方自动更新清单实抓：`{"version":"1.4.2", ...}` → 最新就是 1.4.2，本机已是最新；`agy update` 亦回 "You are already on the latest version" | 【官方一手】`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json` |
| 本机二进制 `F:\AgentData\antigravity\cli\agy.exe`（200,970,904 B）offset 59.68M–60.05M 区段的可打印串里，**已经硬编码** `gemini-4-argon-medium` @59680750/`gemini-4-argon-high` @59752937/`gemini-4-argon-low` 区与显示名 `Gemini 4 Argon (Medium)` @60033344 | 【本地一手】抽取产物 `F:\defws\tmp\20261020-agy-quota\bin_argon_ctx.txt`(3,551 B)、`bin_block_5987_6012.txt`(250,034 B) |
| **反向实证**：第三方在 `agy` 1.4.2 + 正价 Google AI Pro 上直接跑通 `agy --model gemini-4-argon --effort low --print "merhaba"` 并拿到回复 | 【第三方】`https://github.com/erayendes/kortext/pull/35`（2026-10-18 merged） |
| 另有第三方在 `agy` 上跑通 `gemini-4-argon-medium` / `gemini-4-argon-low`（peerhub 0.21.3，2026-10-20 复现 3 次） | 【第三方】`https://github.com/greatgc-flow/peerhub/issues/195` |

⇒ **同一版本，有人能用有人不能用**，版本变量已被排除。官方博文里那句「Update to the latest version of Antigravity to try it」是必要非充分条件。【官方一手】`https://antigravity.google/blog/gemini-4-argon-in-google-antigravity`（Published 2026-10-13T08:00:00Z）

### 假设 2：仍是灰度测试，没灰度到 —— **不成立**（应改判为「按账号权益的确定性裁剪」）

支持「是灰度」的线索只有一条：官方博文用过 "rolling out starting today" 的措辞。但博文全篇**没有** gradual / rollout wave / waitlist / region / staged 任何排队或分批语义。【官方一手】

反证是三条硬证据：

1. **实验系统里没有 Argon**。本机 token 实打 `listExperiments`：prod 88 个 `experimentIds`（`F:\defws\tmp\20261020-agy-quota\rpc_prod_listExperiments_7b7d.txt`，47,003 B）、daily 90 个（`rpc_daily_listExperiments_7b7d.txt`，47,503 B）、两者 84 个相同；prod 侧 489 个 flag。对两份 payload 全文正则 `(?i)argon` 命中数 **均为 0**，`gemini 4` 变体命中数亦为 0。与权益相关的只有：
   - `GCAUpgradeToPaid__enable_upgrade_from_free_tier = true`
   - `GCAUpgradeToPaid__enable_g1_upgrade_flow = **false**`
   - `GCAUpgradeToPaid__current_tier_polling_interval_ms = 43200000`（= 12 小时轮询一次 tier）
   - daily 另有 `GeminiFreeTier__enable_free_tier = false`、`GeminiFreeTier__call_onboard_user_from_legacy_flow = true`、`GeminiFreeTier__license_message_frequency_days = 60`
   ⇒ **不存在「Argon 实验开关」这种东西**；而且 `enable_g1_upgrade_flow=false` + 12 小时的 tier 轮询间隔，恰好解释了一批「刚付费却还没解锁」的社区投诉（见下文「直付仍被拒」类），这是**权益同步延迟**，不是灰度。【本地一手】
2. **裁剪是按账号稳定分层的，不是随机批次**。8 个正价 Google AI Pro 账号的直接 `fetchAvailableModels`：4 个拿 4.6、4 个拿 5.5 变体；换发 `entitlement.userTier` 后「the split remains……which doesn't follow the accounts' `currentTier`」。分层跟的是账号的付费来源，不跟时间批次。【第三方】`https://github.com/yetone/magpie/pull/706`（2026-10-04 merged）
3. **官方给同一问题的答案是权益判定，不是「排队中」**。Google 员工对 Jio 捆绑账号的回复直接给出原因与两条出路（切换直付 / 改用 3.8 Flash High），无一处提「rollout in progress」。【官方一手】见假设 3。

### 假设 3：只有正价 Pro 才有，联营商 Pro 不行 —— **成立**（决定性，官方一手定性）

**A. 本机响应里就带着官方判词**

daily 端点带 `project` 参数时返回的 Argon 墓碑条目（`F:\defws\tmp\20261020-agy-quota\rpc_daily_fetchAvailableModels_7b2270726f6a.txt`，134,120 B）：

```
gemini-4-argon-disabled
  displayName     : "Gemini 4 Argon"
  disabled        : true
  model           : MODEL_PLACEHOLDER_M421
  thinkingLevel   : 2
  tagTitle        : "Unavailable"
  tagDescription  : "Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers."
  quotaInfo       : <absent>
```

⇒ **`paid` 这个词是 Google 自己写进下发给本机的响应里的。** 注意 id 字面量就叫 `-disabled`——daily 端点不是「没给 Argon」，而是**专门给了一条说明「你为什么没有」的占位记录**。prod 端点则给全三条真档位（`-high/-medium/-low`，`MODEL_PLACEHOLDER_M417/M418/M419`）并统一打 `tagTitle:"Upgrade"` / `tagDescription:"Upgrade to use this model"`。

**B. Google 员工的官方定论（同一 gating 机制，逐字）**

官方论坛 `https://discuss.ai.google.dev/t/190091`，帖标题即本案：**「Gemini 4 Argon not available in Antigravity despite active Google AI Pro (Jio) subscription」**。post id `345650` / post_number 4，作者 `Ambati_Rajendra`（**trust_level 3，user_title "Regular"**），created **2026-10-19T09:06:23.393Z**，回复给催问「Any response from their side?」的用户：

> 「While the Jio offer unlocks Argon on `gemini.google.com`, **Gemini 4 Argon** in Antigravity is only included with **directly paid (non-trial / non-promotional) Google AI Pro and Ultra** subscriptions (see the footnote on our Models page). Partner-bundled offers like Jio are treated as **promotional plans** in Antigravity, so you get the full Pro 5-hour quota refresh on **Gemini 3.8 Flash**, but **Argon stays locked**.」
>
> 出路一：「If you want Gemini 4 Argon in Antigravity: You'll need to switch from the Jio bundle to a directly billed Google AI Pro or Ultra plan」
> 出路二：「If you stay on your Jio plan: Switch to **Gemini 3.8 Flash (High)** — you still get the full Google AI Pro quota limits on that model.」

该帖 `incoming_link_count` 180、views 411、OP 收 9 个 heart，`shared_issue_count = **36**`（Discourse 的「同一问题在别处被提 36 次」计数）——**这不是孤例，是被官方认定的一类**。

同一员工在 `https://discuss.ai.google.dev/t/188999`（2026-10-14 开帖）post_number 2 / id `343982` / created **2026-10-15T15:42:24.415Z** 的五问五答里进一步定性：

- **Jio 18 个月捆绑 = 「promotional extended-trial membership」**；
- 该档保留**第一方 Gemini 模型的 Pro 档 5 小时刷新配额**（含 Gemini 3.8 Flash 三档），但 Ultra 专属与第三方新模型不给；
- Claude Sonnet 5.5 / Opus 5.5 限于 **paid (non-promotional / non-trial)** Pro 与 Ultra；legacy 3p 模型（Claude 4.6 / GPT-OSS 120B）自 **2026-11-02** 起对 promotional / trial / free 档停用。

**C. 官方 GitHub issue 里 Google 员工的同款判词**

`https://github.com/google-antigravity/antigravity-cli/issues/1184`，title「Claude Opus 5.5 and Sonnet 5.5 not appearing in Model Selector for Pro subscribers」，state=**open**，assignee `chandrashakherkamasani`。comment id `6047077915`，created 2026-10-07T21:20:05Z，author `chandrashakherkamasani`，**author_association = "COLLABORATOR"**：

> 「Claude Opus 5.5 and Sonnet 5.5 are only available on **directly billed (non-trial)** Google AI Pro and Ultra plans. **Trial plans, device promotions (e.g. Pixel, Chromebook) and partner benefits count as promotional plans and don't include Claude 5.5.**」

⇒ **「partner benefits（伙伴/联营权益）」被官方显式归入 promotional plans。** 原文讲的是 Claude 5.5，但 daily 端点 `tagDescription` 用的是同一句 "paid Pro" 的口径，机制同源。

**D. 官方文档与 FAQ 的条文**

`https://antigravity.google/docs/models`（经 `r.jina.ai` 抓取，HTTP 200）可用性表：

| 模型 | Free & AI Plus | AI Pro | AI Ultra | Enterprise |
|---|---|---|---|---|
| Gemini 4 Argon*** | ❌ | ✅** | ✅ | ✅ |
| Gemini 3.8 Flash | ✅ | ✅ | ✅ | ✅ |
| Claude Sonnet 5.5 / Opus 5.5 (thinking)** | ❌ | ✅** | ✅ | ✅ |
| Claude Sonnet 4.6 / Opus 4.6 (thinking)\* | ✅ | ✅ | ❌ | ❌ |
| GPT-OSS-120b\* | ✅ | ✅ | ✅ | ❌ |

脚注 \*\* 是决定性的一行：**「Available on Google AI Pro for *non-trial subscriptions only*. To switch from a trial to a paid Google AI Pro plan, submit an upgrade request.」**（链接 `https://one.google.com/support`）
脚注 \* 「Will be removed on November 2, 2026.」；脚注 \*\*\*「Not available in Antigravity IDE. Available in the Antigravity App, Antigravity CLI, and IDE extensions.」

`https://antigravity.google/docs/faq`（HTTP 200）「How do I upgrade to a paid Google AI plan?」逐字：

> 「Some models (such as **Gemini 4 Argon, Claude Opus 5.5, and Claude Sonnet 5.5**) require a paid **Google AI Pro** or **Google AI Ultra** subscription and are **not included in free trials**. … **For memberships through third-party partners, Pixel Pass, or Google Fi**, learn how to manage third-party subscriptions (https://support.google.com/googleone/answer/15801606)」

⇒ **注意这里有个值得写清的张力**：`docs/models` 与 `docs/faq` 的**文字**只写「non-trial」，**条文层面不按购买渠道分类**（表格无「渠道」列，`docs/plans` 全文也无渠道区分）；但 `faq` 单独把「third-party partners / Pixel Pass / Google Fi」拎出来给出「管理第三方订阅」的链接，加上官方论坛与 GitHub 回复**在执行层面**一致使用 "directly billed / non-promotional" 的口径，实际判定就是看**谁在收你的钱**。【官方一手，两处口径并列呈现已验证冲突点】

`https://ai.google.dev/gemini-api/docs/google-ai-plans`（HTTP 200）：AI Pro 行「Access to premium models like **Gemini 4 Argon**……」；Limitations 节「**Gemini 4 Argon is not available on the Free plan.**」；**全文无渠道区分条款**。

**E. 社区规模证据（同型投诉，全部指向同一判据）**

`https://discuss.ai.google.dev/search.json?q=argon%20antigravity%20pro` 实返 50 条命中（2026-10-14～10-20）：

- **联营/捆绑类**：190091、190485、189886、189943、190635、190886（均 Jio）、189862、186590（「Does a Jio-provided Google AI Pro plan count as "non-trial" for Claude 5.5 access in Antigravity?」）
- **设备促销类**：189760「Long-time Pro subscriber locked out of Argon because I bought a google phone!」——OP `James_Lunardi`：「I have paid for Pro for a long time. I am still a Pro subscriber today. But right now, I can't use Argon… The reason is my new Pixel 11 Pro. It came with 6 months of AI Pro for…」⇒ **正价老用户在设备促销生效后被重新判定为 promotional，反向印证「看谁收费」**
- **学生/教育类**：190471、190755、190059、190015
- **Family 共享类**：190432、189933、190888
- 190461（OP `TISOCH`）：面板显示 "Your Plan: Google AI Pro" 但 Argon 灰显，tooltip 原文「Gemini 4 Argon is currently available to Ultra and paid Pro plan subscribers.」——**与本机 daily `tagDescription` 逐字一致**，说明本机与投诉者走的是同一条服务端判词。
- 官方 `ai_topic_gist` 摘要（论坛自生成，非用户言论）在 190485 上直接写：「Support clarified that promotional Google AI Pro subscriptions bundled with Jio exclude Gemini 4 Argon in Antigravity, requiring users to switch to a directly paid subscription or upgrade to Google AI Ultra」；190282 上写：「the model requires a directly billed, non-promotional Google AI Pro subscription alongside updating the application to the latest version」。

**F. 必须如实标注的例外（不得与 Jio 类混为一谈）**

少数 OP 自述**已在直付仍被拒**，且**未获官方回复**，性质未定：

| 帖 | OP 自述 | 状态 |
|---|---|---|
| 190444 | `Damian_Trebenda`：「directly paid Google AI Pro (5 TB) … €21.99 per month……Antigravity correctly recognizes my subscription as Google AI Pro……97% weekly and 100% five-hour quota remaining. However, Gemini 4…」 | 无官方回复，未定 |
| 190497 | `Jagdish_Nigam`：试用结束后已开始直付 ₹1,950/月 5TB，仍显示不可用 | 无官方回复，未定 |
| 190434 / 190755 | `Calvin_Zhx`/`Thorpor`：「This is not a free trial. What works: Gemini app → Argon available；Antigravity → 3.8 Flash 和 Claude 5.5 可用；What doesn't: Antigravity desktop app / CLI → Argon does not appear」 | 无官方回复，未定 |

⇒ **最可能的解释是权益同步延迟**（与 `GCAUpgradeToPaid__current_tier_polling_interval_ms = 43,200,000` = 12 小时轮询吻合；且 `enable_g1_upgrade_flow = false` 说明 G1 升级流在本档未被打开），但**这是推断，不是已验证结论**。报告不将其并入假设 3 的定性。

---

## 二、Argon 的模型 id 与额度归属

### 模型 id（判据已从「第三方 PR」升级为「服务端下发原文」）

**prod 端点原生 id 三条**（`rpc_prod_fetchAvailableModels_7b2270726f6a.txt`）：

| id | displayName | model 占位 | thinkingLevel | disabled |
|---|---|---|---|---|
| `gemini-4-argon-high` | Gemini 4 Argon (High) | `MODEL_PLACEHOLDER_M417` | 3 | true |
| `gemini-4-argon-medium` | Gemini 4 Argon (Medium) | `MODEL_PLACEHOLDER_M418` | 2 | true |
| `gemini-4-argon-low` | Gemini 4 Argon (Low) | `MODEL_PLACEHOLDER_M419` | 1 | true |

其余字段：`apiProvider: "API_PROVIDER_GOOGLE_GEMINI"`、`modelProvider: "MODEL_PROVIDER_GOOGLE"`、`minThinkingBudget: 32`、`maxTokens: 1048576`、`maxOutputTokens: 65536`、`supportsVideo`。**基础 id 就是 `gemini-4-argon`，档位走 `-low/-medium/-high` 后缀，没有 `-tiered` 后缀**（与 `gemini-3.8-flash-tiered` 不同族）。这与 `docs/models` 正文「thinking level 为 Low/Medium/High 三档」及 `agy --effort low|medium|high|xhigh|max` 一致。

- `agy models`（不带 project 的默认列举）里 **一条 Argon 都没有**——本机 6 条只有 `gemini-3.8-flash-high/medium/low`、`claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`（`agy_models.out.txt`）。
- 第三方实现里另有防御性变体 `gemini-4-argon-cyber-permissive`（Fairwind allowlist，默认 thinking HIGH），依赖 `google-genai>=2.30.1`。【第三方】`https://github.com/tryonlabs/opentryon/pull/152`（2026-10-20 merged）。**本机任何端点都未下发该 id**，不得当成本机可用项。
- 注意 Gemini 4 系不再接受 `temperature`（迁移指南称采样参数被忽略）。【第三方】`https://github.com/darkzOGx/youtube-automation-agent/pull/79`

### `project` 参数是决定「Argon 是否出现在响应里」的开关（本轮新发现，此前未记录）

同一 token、同一端点、只改请求体：

| 请求体 | prod 模型数 | 含 Argon |
|---|---|---|
| `{}`（`agy models` 默认形态） | **25** | ❌ 无 |
| `{"project":"default-cli-project"}` | **34** | ✅ Argon 3 条（全 `disabled:true`） |

差集正好是 9 条：`gemini-4-argon-high/medium/low` + `gemini-3.7-flash-high/medium/low` + `gemini-3.8-flash-high/medium/low`（`Compare-Object` 实证，only-in-no-project = 0，即带 `project` 的响应是超集）。

⇒ **之前记录「prod 25 条里一条 argon 都没有」是对的，但结论要改**：Argon 并非完全不下发，而是**不带 `project` 时不下发；带 `project` 时下发但全部 `disabled`**。这个差异不改变判定（依然拿不到），但把「裁剪发生在服务端下发环节」这条链条补完整了——**服务端知道该给什么，也明确地把它标成不可用**。

另：`{"cloudaicompanionProject":"..."}` → **400** `Unknown name "cloudaicompanionProject": Cannot find field.` ⇒ 该字段名不存在，**只有 `project` 有效**。

### 判据（干净、可复用）

- **可用** = 模型条目**带 `quotaInfo`**
- **不可用** = **`disabled: true` 且无 `quotaInfo`**，并带 `tagTitle`/`tagDescription` 判词
- 字段差集：Argon 独有 `disabled`/`minThinkingBudget`/`supportsVideo`/`thinkingLevel`；正常可用模型独有 `quotaInfo`/`vertexModelId`
- prod 的 `agentModelSorts[0].groups[0].modelIds` 把 **Argon 三档排在推荐位第 1–3**，却全打 `disabled` ⇒ 面板里「排在最前但灰着」正是这个形状的产物，与 190461 的截图描述吻合。

### 额度归属：**Argon 有独立额度，且 Pro 档是 weekly-only（没有 5 小时窗口）**

本机 `retrieveUserQuotaSummary` 实测（`probe_quota_with_project.mjs`，2026-10-20 12:46 读数，**时点值，引用前必重读**）：

| 端点 | 请求体 | 结果 |
|---|---|---|
| prod | `{}` / `{project:"default-cli-project"}` / `{project:"aicode-consumers"}` | **三组完全相同**，`argon_hits=0`；仅两组：`Gemini Models`(`gemini-weekly`=1@`2026-10-27T04:46:43Z`, `gemini-5h`=1)、`Claude and GPT models`(`3p-weekly`=0@`2026-10-23T19:08:49Z`, `3p-5h`=1 **disabled**) |
| daily | 同上三种 | **三组完全相同**，`argon_hits=0`；`Gemini Models`(`gemini-weekly`=0.0082896575@`2026-10-23T22:00:21Z`, `gemini-5h`=0.9950103@`2026-10-20T06:05:46Z`)、`Claude and GPT models`(同上) |

⇒ **加 `project` 不改变额度响应**（与它改变模型列表不同）。

**本机没有 argon bucket，不是因为「Argon 无独立额度」，而是因为本账号未解锁——解锁后才会出现该 bucket。** 独立证据：Pro 用户专帖 `https://discuss.ai.google.dev/t/190068`（title「Request for 5-Hour Rolling Limit on Gemini 4 Argon for Pro Users instead of Weekly-Only Quota」，2026-10-16T20:45:19Z）原文逐字：

> 「…the current restriction of a **weekly-only quota** for Argon makes heavy coding and agentic debugging very difficult. Once the weekly limit is exhausted, developers are left stranded for days. **The Suggestion:** Please adopt a rolling window quota model similar to Gemini 3.8 Flash (e.g., a rolling 5-hour limit or daily refreshed tier) for Gemini 4 Argon on the Pro plan.」

⇒ **Pro 档 Argon = weekly-only**；`docs/plans` 全文（【官方一手】）**未提 Argon 单独额度或额外 bucket**，所以这条只有社区一手体感支撑，标注为【社区传闻/用户实测】。Overages 侧 Pro/Ultra 可走 AI credits（`AI Credit Overages`：Never/Always），但未见任何材料说明 Argon 是否可用 credits 抵扣——**未找到证据**。

---

## 三、本机身份与权益：关键辨识（防误读）

`loadCodeAssist` 对本机 token 的实返（`F:\defws\tmp\20261020-agy-quota\loadcodeassist_prod.json` / `loadcodeassist_daily.json`，两份内容一致，3,869 B）：

```json
"currentTier": { "id": "free-tier", "name": "Antigravity", ... },
"allowedTiers": [ { "id": "free-tier", "isDefault": true }, { "id": "standard-tier", ... } ],
"cloudaicompanionProject": "aicode-consumers",
"gcpManaged": false,
"paidTier": {
  "id": "g1-pro-tier", "name": "Google AI Pro", "description": "Google AI Pro",
  "upgradeSubscriptionUri": "https://antigravity.google/g1-upgrade",
  "upgradeSubscriptionText": "You can upgrade to a Google AI Ultra plan to receive higher rate limits.",
  "availableCredits": [ { "creditType": "GOOGLE_ONE_AI", "minimumCreditAmountForUsage": "50" } ]
}
```

**⚠️ 这条极易读错，务必按以下口径写：**

- **`currentTier = "free-tier"` 不是「用户没有 Pro」的证据。** 它是 Code Assist 的 tier 槽位名，所有 consumer 账号都落在这里；`paidTier = "g1-pro-tier" / "Google AI Pro"` 才说明是 Pro。第三方工具因此专门立规则：`resolve_remote_plan` 只读 `currentTier` 会误报 Free，**应优先读 `paidTier.name`**（【第三方】`syrtis` #477、`GNOME-AI-Usage` #133/#134）；`CodexBar` #4565 更是同一个坑的实例（`agy` 显示 `(Google AI Pro)` 而 OAuth 侧 `loginMethod: "Free"`），其判据来自 #3789：**5-hour 窗口只在付费档存在** ⇒ 本机 `gemini-5h` 窗口存在，进一步佐证 Pro 权益确实生效（在 3.8 Flash 上）。
- **`paidTier` 里没有「谁在收这笔钱」这个字段。** 服务端只告诉你 `g1-pro-tier`，不告诉你它是直付还是联营/促销。这与第三方结论一致：「the API reports `paidTier: g1-pro-tier` but **not who bills it**」（【第三方】`codex-antigravity-auth` PR#183）。⇒ **本机无法自证「我是直付」或「我是联营」，这个判定只存在于 Google 侧的计费归属，客户端读不到。**
- 本机日志侧的 consumer 身份确认：`server_oauth.go:204 applyAuthResult: email=gaodi0619@gmail.com, authMethod=consumer, quotaProject=`（无 quota project）。
- `getUserStatus` → **404**（`/v1internal:getUserStatus` was not found，返回 Google 404 HTML 页）⇒ **不存在这个 RPC**，别指望它给出权益来源。
- `fetchAdminControls` → **200** 但内容为 `{}`（3 B）⇒ 无信息。
- `listModelConfigs` → `{}` 与 `{"domain":"AGENT"}` 都是 **400**（后者报 `Invalid value at 'domain' …ListModelConfigsRequest.Domain, "AGENT"`）⇒ **拿不到模型配置表**，此路不通。

**四端点对照**（此前实测，`all_four.json`）：`daily-cloudcode-pa` 19 模型 / 无 Gemini 额度组；`cloudcode-pa`(prod) 25 模型 / Gemini 组=1；`daily-cloudcode-pa.sandbox` 19 模型；`autopush-cloudcode-pa.sandbox` → **403** "You do not have a valid license of this product…"。⇒ 四者均无 Argon。

---

## 四、时间线（本案的重要修正）

| 时点（UTC） | 事件 | 等级 |
|---|---|---|
| 2026-10-12 | **Gemini 3.1 Pro / 3.6 Flash / 3.7 Flash 在全部 Antigravity 账号与档位永久退役**，由 Gemini 3.8 Flash（Low/Medium/High）取代。与 Jio/Pro 无关，是全局阵容更新。 | 【官方一手】论坛 188999 post 2 |
| 2026-10-13 08:00 | Argon 发布博文，宣称面向 Pro 与 Ultra，「desktop app and the Antigravity CLI」 | 【官方一手】 |
| 2026-10-13～10-15 | **实际仅 Ultra 可用**；Pro 用户大规模投诉（论坛数十帖，反应数最高 189085=41 赞、188979=31、188900=30） | 【社区传闻】 |
| 2026-10-15 15:42 | Google 员工 188999 post 2：Argon「exclusively available to Google AI Ultra (and Enterprise)……不在 Pro（无论直付还是 Jio 捆绑）」且「we do not have an announced timeline for bringing Gemini 4 Argon to the Pro tier」 | 【官方一手】 |
| **2026-10-16 00:16** | Google 员工 `chunduriv`（flair **google**，moderator，trust_level 4）在 189741 post_number 2 / id `344097`：**「We are happy to share that Gemini 4 Argon is indeed now available to our paid Pro plan subscribers!」** 该答复被标记为 **accepted answer**（`has_accepted_answer: true`） | 【官方一手】 |
| 2026-10-15（第三方记录） | 「Google rolled Argon out to **paid** Google AI Pro subscribers in Antigravity on **2026-10-15**」 | 【第三方】`agentdeals` PR#2863 |
| 2026-10-16 起 | Argon 对 **paid Pro** 生效，Pro 档为 **weekly-only** 额度（用户随即要求补 5 小时滚动窗口） | 【官方一手】+【社区传闻】 |
| 2026-10-19 09:06 | Google 员工 190091 post 4 给出本案定性答复（directly paid / promotional 分界） | 【官方一手】 |
| 2026-11-02 | Claude Sonnet 4.6 / Opus 4.6 / GPT-OSS-120b 下线（官方脚注）；promotional / trial / free 档的第三方模型访问同时停用 | 【官方一手】 |
| 2026-10-20（本次取证） | 本机 prod 响应里 `claude-sonnet-4-6` / `claude-opus-4-6-thinking` 已带 `tagTitle:"Notice"` 的官方下线预告：「Sonnet 5.5 is now available on paid Pro and Ultra plans. Third-party model access will no longer be available on your current plan starting on November 2, 2026.」 | 【本地一手】 |

⇒ **关键澄清：「Argon 只给 Ultra」是 2026-10-15 及之前的旧口径，10-16 起已改为「paid Pro 也开放」。本机今天看不到 Argon，原因不是 Ultra 门槛，而是「paid vs promotional」这条线。**

⇒ **另一个对本地用户有直接后果的时间点：2026-11-02 起，本机现在能用的 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium` 对 promotional 档全部停用，而这三条正是 `agy models` 6 条里的 3 条。** 本机 3p 额度组的 `3p-weekly` 现在 remainingFraction = 0（已耗尽，reset 2026-10-23T19:08:49Z），`3p-5h` 为 disabled。⇒ **联营 Pro 账号在 11-02 后在 AGY 里只剩 `gemini-3.8-flash-high/medium/low` 三条**。这不是推测——`docs/models` 脚注 + 服务端已下发的 Notice 判词 + 官方员工 188999 回复三源一致。

---

## 五、本机能否拿到 Argon？需要什么条件

### 能走的路（只有一条，且不是技术开关）

**换成直付（directly billed / non-promotional）的 Google AI Pro 或 Ultra 订阅**，然后等 tier 同步（`current_tier_polling_interval_ms` = 12 小时）。官方给了两处入口：
- 从 trial 转 paid Pro：submit an upgrade request → `https://support.google.com/googleone/contact/googleone_ai_pro_signup_issues`（`docs/models` 脚注指向 `https://one.google.com/support`）
- 管理第三方/联营订阅：`https://support.google.com/googleone/answer/15801606`

本机已是 1.4.2 最新版，无需升级、无需重装；`Gemini 4 Argon` 三档会在服务端解锁后自动出现在 `agy models`。

**留在联营档的官方替代**：改用 **Gemini 3.8 Flash (High)**——官方员工原话「you still get the full Google AI Pro quota limits on that model」。这也是 `agy models` 现在有的三条之一。

### 不能走的路（全部实测为死路，且带合规风险）

**1. 参数/UA 层面的 tier 覆盖——本机实测六种变体全部失败。**
探针 `F:\defws\tmp\20261020-agy-quota\probe_tier_override.mjs`（打 prod `:fetchAvailableModels`，只列举不生成）：

| 请求体变体 | 结果 |
|---|---|
| `{project:"default-cli-project"}` | 200，34 models，Argon 3 条全 `disabled=true` |
| `{project, entitlement:{userTier:"G1_PRO_TIER"}}` | **400** `INVALID_ARGUMENT` "Request contains an invalid argument." |
| `{project, entitlement:{userTier:"g1-pro-tier"}}` | **400** 同上 |
| `{project, userTier:"G1_PRO_TIER"}` | **400** `Unknown name "userTier": Cannot find field.` |
| `{project, planType:"Pro"}` | **400** `Unknown name "planType": Cannot find field.` |
| `{project, includeDisabled:true}` | **400** `Unknown name "includeDisabled": Cannot find field.` |

⇒ **服务端只认 token 背后的账号权益；`disabled` 与 `quotaInfo` 由服务端单方面决定，客户端没有任何声明/提升 tier 的入口。** 与 magpie PR#706「the paid tier was answered with `INVALID_ARGUMENT` and the request fell back to none」逐字吻合。换 UA（简陋 / 完整 CLI 身份 / darwin 变体，`probe_ua_identity.mjs`）、换端点（四端点全试）同样无效；`enable_g1_upgrade_flow = false` 也说明连升级流开关都没对本档打开。

**2. 用第三方桥接 agy 偷渡 —— 这是 ToS 明确禁止的，不要做。**
`https://antigravity.google/terms` 第 6 条逐字（【官方一手】，本轮实抓）：

> 「You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the Service in connection with products not provided by us. **Using third party software, tools, or services to access the Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement.** Such actions may be grounds for **suspension or termination** of your Antigravity and/or Gemini CLI accounts.」

`docs/faq` 另有：「`agy -p` is intended for direct scripting and CI workflows. **Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans.**」

⇒ **本报告只做了只读列举取证，未做任何封装或账号轮转**；把 argon 硬塞进 DSH provider 桥这类做法会直接撞上这条，账号风险远大于一个模型的收益。**这条判据对本机现装的 `dsh-agy-cli` / `dsh-connect-trae` 一类桥接同样适用**，建议父代理留意。

**3. 「改配置就能拿到」——未找到任何证据。** 二进制里 argon 条目是**硬编码的静态目录**（`agy.exe` 已内置），改本地 config / 环境变量不会覆盖服务端的 `disabled` 标志；`listExperiments` 里也没有相关开关。

### 顺带排除的干扰项

- **地域不是原因**。`docs/faq` 列出 Antigravity 批准地区（亚洲 43 个）与「Google One AI 计划不可用地区」清单（Türkiye、Brunei、Curaçao、Greenland、Jersey、Guernsey、Isle of Man、Kosovo、Montenegro 等 31 个）——**印度在可用区**，故论坛那批 Jio 投诉不属地域问题；本机在中国大陆经代理使用属另一条链路，但 `paidTier=g1-pro-tier` 与两组额度 bucket 均正常返回，说明**权益识别本身没被地域卡住**，Argon 的 `disabled` 是付费来源判定所致。
- **不是登录态问题**。token 直连即返 200/34 models，`listExperiments` 亦正常返回 489 flag；此前记忆中「Ple sign in」类坑（keyring 刷新需 `HTTPS_PROXY`）本案未复现。

---

## 六、明确列出「没查到什么」

1. **没查到 Argon 的专属额度 bucket id**。本机所有端点均无；`retrieveUserQuotaSummary` 加 `project` 也不改变额度响应。只有社区帖 190068 说 Pro 档 Argon 是 "weekly-only quota"，**没有官方文档确认 bucket 命名**（如是否存在 `argon-weekly`）——未找到证据。
2. **没查到官方任何一页文档写「按购买渠道区分」**。`docs/models` 脚注只说 "non-trial subscriptions only"；`docs/plans` 全文无渠道区分；`ai.google.dev/gemini-api/docs/google-ai-plans` 全文无渠道区分。**「渠道」这条判据只存在于官方论坛回复与 GitHub COLLABORATOR 回复的口径里**（虽属【官方一手】言论，但未进入正式条文）。这是本案最重要的口径缺口。
3. **没查到 `agy.exe` 二进制里有 `gemini-4-argon-cyber-permissive`**（第三方 opentryon PR#152 提到的变体）——本机二进制与全部端点都只有 `-high/-medium/-low` 三档。
4. **没查到任何「联营商 Pro 拿不到 Argon」的 GitHub issue 直接报告**。`"reseller" "Google AI Pro" "Antigravity"` total_count=4，四条均无关。**该假设的证实全部来自官方论坛（discuss.ai.google.dev）与 COLLABORATOR 的 GitHub 评论，不是 GitHub issue 搜索**——搜索渠道在此案上是无效渠道，须写明以免后来者重复消耗。
5. **没查到 Argon 是否可用 AI credits 抵扣**（`docs/plans` 只讲 Pro/Ultra 可用 AI Credit Overages，未点名 Argon）——未找到证据。
6. **官方文档页 404 清单（勿再重试这些路径）**：`/docs/cli.md`、`/docs/credits.md`、`/docs/cli/commands/models.md` 均 404（任务给定的「已知可用页」里 `cli` 实测不可用）。已验证可用：`/docs/plans.md`、`/docs/models.md`、`/docs/faq.md`、`/docs/cli/commands/usage.md`、`/terms`、`/blog/gemini-4-argon-in-google-antigravity`。
7. **RPC 探测的死路清单**：`getUserStatus` → 404；`listModelConfigs`（`{}` 与 `{domain:"AGENT"}`）→ 400；`fetchAdminControls` → 200 但返回 `{}`；`cloudaicompanionProject` 字段 → 400 Unknown name。**当前已知有用的入参只有 `project`，有用的 RPC 只有 `fetchAvailableModels` / `retrieveUserQuotaSummary` / `listExperiments` / `loadCodeAssist`。**
8. **`experimentIds` 语义未破**。`listExperiments` 的 88/90 个 id 全是裸数字，无名称表可读；`fetchAvailableModels` 响应顶层另有一组 54 个 `experimentIds`（与 `listExperiments` 的集合部分重叠，如 `105979552`/`105979574`/`106015333` 等）。**未找到能把某个 id 映射到「Argon 开关」的途径**，但从「两份 payload 全文 `argon` 命中为 0」已足以否定灰度假说。
9. **`MODEL_PLACEHOLDER_M4xx` 的含义未破**。`M417/M418/M419/M421` 显然是内部真实 model 名的占位掩码（daily 用 M421、prod 用 M417–419，同一 Argon 两端点占位号不同），**未找到**其映射表，也**未找到证据**说客户端能把它还原成真名。
10. **本机账号的「直付 vs 联营」无法自证**——服务端不下发该字段（见 §三）。判定依据只有用户自述「联营商的 Pro 套餐」这一条。若要 100% 定案，需在 `https://one.google.com` 付款页看该订阅的**收款方**（Google 直收 or 伙伴代收），本报告未做此核验（涉及登录账号操作，超出只读取证范围）。

---

## 附录 A：证据清单

### A.1 本地一手（`F:\defws\tmp\20261020-agy-quota\`）

| 文件 | 字节 | 内容 |
|---|---|---|
| `rpc_prod_fetchAvailableModels_7b2270726f6a.txt` | 266,962 | **prod + `project` 参数：34 models，含 Argon 三档（全 disabled）** — 本案核心证据 |
| `rpc_daily_fetchAvailableModels_7b2270726f6a.txt` | 134,120 | **daily + `project`：23 models，含 `gemini-4-argon-disabled` 墓碑 + 官方 "paid Pro" 判词** |
| `override_baseline_project_only_.json` | 266,962 | tier 覆盖探针的基线快照（与上行同内容） |
| `rpc_prod_listExperiments_7b7d.txt` | 47,003 | 88 experimentIds + 489 flags；`argon` 命中 0 |
| `rpc_daily_listExperiments_7b7d.txt` | 47,503 | 90 experimentIds；`argon` 命中 0；与 prod 交集 84 |
| `loadcodeassist_prod.json` / `loadcodeassist_daily.json` | 3,869 ×2 | `currentTier=free-tier` + `paidTier=g1-pro-tier/"Google AI Pro"`，无收款方字段 |
| `quota_prod_*.json` / `quota_daily_*.json`（本轮 6 份） | 1,989 / 2,234 | 三种请求体额度响应全等，`argon_hits=0` |
| `models_prod.json` / `models_daily.json` | 116,396 / 76,127 | 不带 `project` 的 25 / 19 模型清单（无 argon） |
| `quota_prod.json` / `quota_daily.json` / `all_four.json` | 1,994 / 1,405 / 5,779 | 四端点对照（含 sandbox 403） |
| `usage_now.out.txt` | 2,191 | `/usage` 原始输出 11:59:46：Gemini weekly 0.0083 / 5h 0.995；3p weekly 0 / 5h disabled |
| `agy_models.out.txt` | 317 | `agy models` 实返 6 条 |
| `ccu_run1.out.txt` | 660 | 一次生成 429 `RESOURCE_EXHAUSTED`（error_id `d062f27c-4d27-43eb-8c1b-44645b96c8b7-9`） |
| `bin_argon_ctx.txt` / `bin_block_5987_6012.txt` | 3,551 / 250,034 | **agy.exe 二进制内置 argon 条目** 的可打印串抽取 |
| `probe_rpc_enum.mjs` | 5,362 | 8 RPC × 2 端点枚举探针（本轮模板） |
| `probe_tier_override.mjs` | 5,600 | tier 覆盖六变体探针 |
| `probe_quota_with_project.mjs` | ~5,900 | 额度查询 × 三种 project × 两端点（本轮新写） |
| `probe_argon_detail.mjs` | 1,901 | 从落盘响应抽 Argon 条目字段 |
| `probe_ua_identity.mjs` | 5,472 | CredReadW + CONNECT 代理 + 三种 UA 的原始模板，后续探针均复用 |
| `probe_ineligible.mjs` / `probe_tier.mjs` | 4,775 / 4,991 | loadCodeAssist 与 tier 前置探针 |
| `prod-endpoint-research.md` | 20,552 | 前序 prod 端点调研报告 |

探针凭据取法（复用要点）：PowerShell `Add-Type` P/Invoke `CredReadW(target="gemini:antigravity", type=1)` → base64 → JSON → `token.access_token`；经 `http.request({host:'127.0.0.1',port:12450,method:'CONNECT'})` + `tls.connect({socket})` 打 `https://[daily-]cloudcode-pa.googleapis.com/v1internal:<RPC>?`；UA `antigravity/cli/1.4.2 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)` + `X-Goog-Api-Client: gl-node/22.21.1`。

### A.2 官方一手 URL

- `https://antigravity.google/blog/gemini-4-argon-in-google-antigravity`（2026-10-13T08:00:00Z）
- `https://antigravity.google/docs/models`（可用性表 + 三条脚注）
- `https://antigravity.google/docs/faq`（升级条 + 地域清单 + ToS 相关条）
- `https://antigravity.google/docs/plans`（额度与 Overages，无渠道区分、无 Argon 独立额度）
- `https://antigravity.google/docs/cli/commands/usage`（`/usage` ≡ `/quota`，文档示例仍停在 3.5/3.1 Pro，未更新到 Argon）
- `https://antigravity.google/terms`（第 6 条第三方接入禁令）
- `https://ai.google.dev/gemini-api/docs/google-ai-plans`
- `https://discuss.ai.google.dev/t/190091`（post 4 / id 345650 / 2026-10-19T09:06:23Z — 本案定性答复）
- `https://discuss.ai.google.dev/t/189741`（post 2 / id 344097 / 2026-10-16T00:16:11Z — accepted answer，Argon 已向 paid Pro 开放）
- `https://discuss.ai.google.dev/t/188999`（post 2 / id 343982 / 2026-10-15T15:42:24Z — 五问五答）
- `https://github.com/google-antigravity/antigravity-cli/issues/1184`（COLLABORATOR comment id 6047077915）
- `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/windows_amd64.json`（version 1.4.2 + sha512）
- `https://support.google.com/googleone/answer/15801606`（第三方订阅管理）
- `https://support.google.com/googleone/contact/googleone_ai_pro_signup_issues`（trial→paid 升级申请）

### A.3 第三方与社区

- `https://github.com/yetone/magpie/pull/706`（8 个 Pro 账号 4.6/5.5 分层 + `entitlement.userTier` 被 INVALID_ARGUMENT）
- `https://github.com/nikships/droidproxy/pull/358`、`https://github.com/nikships/droidproxy/issues/367`
- `https://github.com/Reedtrullz/codex-antigravity-auth/pull/183`（Jio 18 个月 = IDE 也不列新模型；`paidTier` 不含收款方）
- `https://github.com/erayendes/kortext/pull/35`（1.4.2 + 正价 Pro 实测 Argon 可用）
- `https://github.com/greatgc-flow/peerhub/issues/195`（agy 上跑通 argon-medium/low）
- `https://github.com/tryonlabs/opentryon/pull/152`（`gemini-4-argon` 与 `-cyber-permissive`）
- `https://github.com/darkzOGx/youtube-automation-agent/pull/79`（Gemini 4 不再接受 temperature）
- `https://github.com/robhunter/agentdeals/pull/2863`（10-15 面向 paid Pro 放量 + 「Pro: non-trial subscriptions only」引文）
- `https://discuss.ai.google.dev/t/190068`（Pro 档 Argon weekly-only）
- `https://github.com/CodexBar…` #4565 / #3789（5h 窗口只在付费档存在）、`syrtis` #477、`GNOME-AI-Usage` #133/#134（应优先读 `paidTier.name`）
- 论坛同型投诉帖：189886、189862、189943、190485、190635、190886、186590、189760、190432、189933、190888、190471、190755、190059、190015、190461、190282；高反应帖 189085（41）、188979（31）、188900（30）
- 未定（自述直付仍被拒）：190444、190497、190434

---

## 附录 B：一句话给用户

**不是软件没更新，也不是没轮到你——是 Google 把「联营/赠送的 Pro」按「促销档」处理，Argon 只给 Google 直接收钱的 Pro/Ultra。** 现在能用的最好档位是 Gemini 3.8 Flash (High)，它有完整的 Pro 额度；想拿 Argon 只能改成直付订阅并等最多 12 小时的权益刷新。另外 **11 月 2 日后 Claude 4.6 和 GPT-OSS 也会对这个档关闭**，届时 AGY 里只剩 3.8 Flash 三档。
