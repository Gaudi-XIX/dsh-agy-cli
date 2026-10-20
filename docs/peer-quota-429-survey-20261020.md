# AGY 额度池与 429 处置：peer 横向抄写结论（2026-10-20）

> 采集时间：2026-10-20 06:5x–07:3x（东八区）。抄写对象为同类开源实现（OmniRoute、agy-link、chaos-03x/dsh-agy），非我方代码。
> 本文只记「实际任务如何发生」的机制与可复用判据；原始文件缓存在 `tmp/20261020-omnirote-study/`（临时目录，用完自清）。
> 同目录 [`quota-experiment-report.md`](quota-experiment-report.md) 是既有的 V2-M5 sessionMode 实验报告，与本文互不覆盖。

---

## 1. 端点分层：OmniRoute 把端点按用途分成三类

`diegosouzapw/OmniRoute`（实测抓取，`open-sse/config/antigravityUpstream.ts`）原文：

```ts
export const ANTIGRAVITY_RUNTIME_BASE_URLS = Object.freeze([
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
]);

export const ANTIGRAVITY_DISCOVERY_BASE_URLS = Object.freeze([
  ...ANTIGRAVITY_RUNTIME_BASE_URLS,
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
]);

export const ANTIGRAVITY_BOOTSTRAP_BASE_URLS = Object.freeze([
  "https://cloudcode-pa.googleapis.com",
]);
```

落到实际任务上：

| 用途 | 端点序 | 消费者 |
|---|---|---|
| 生成（streamGenerateContent / agents） | daily → prod | `executors/antigravity.ts` |
| 目录与额度发现（models / fetchAvailableModels / retrieveUserQuota*） | daily → prod → daily-sandbox | `services/usage/antigravity.ts`、`services/usage/antigravityWeeklyQuota.ts` |
| 项目引导（loadCodeAssist / onboardUser） | 仅 prod | `ANTIGRAVITY_CONFIG.loadProjectApiUrl`、`getAntigravityOnboardUrls()` |

⇒ **生产流量与额度读取共用同一条 RUNTIME 链（daily first）**，prod 只在引导类接口单独使用。这与 `agy.exe` 二进制硬编码 `daily-cloudcode-pa.googleapis.com` 一致，不是配置可切的东西。

chaos-03x/dsh-agy 的注解与 OmniRoute 同向（`src/oauth/constants.ts` 注释原文）：
`"The daily runtime host (no .sandbox suffix) is the live endpoint for consumer OAuth accounts — cloudcode-pa.googleapis.com daily host answers 200. Order matters: first reachable non-429/403/503 wins."`
其文档 `docs/ANTIGRAVITY-API.md:9-12` 端点表：Production `Returns 429 for consumer OAuth accounts (enterprise/license use) — verified`；Daily `**Main endpoint for consumer accounts (200, verified)**`；Daily(Sandbox) `Verified usable (fallback)`；Autopush(Sandbox) `Returns 403 (consumer has no license), tail fallback`。

## 2. 429 分类：四类，每类绑定不同动作

`open-sse/services/antigravity429Engine.ts`（文件头自陈「CLIProxyAPI classifies 429 into 4 categories; OmniRoute previously had only 2 (free tier vs RPM)」）：

```ts
const QUOTA_EXHAUSTED_KEYWORDS = [
  "quota_exhausted", "quota exhausted",
  // Antigravity native message: "Individual quota reached. Contact your administrator to enable overages."
  "quota reached", "enable overages", "individual quota",
];
```

判定顺序（`classify429`）：
1. `/\breset\s+(?:after|in)\s+0s\b/` → `rate_limited`（零重置窗是更强证据，压过措辞）
2. 命中 `QUOTA_EXHAUSTED_KEYWORDS` 或 13 项 credits 关键词（`google_one_ai` / `insufficient credit(s)` / `g1_credits` 等）→ `quota_exhausted`
3. `per minute` / `rpm` / `rate limit` / `rate_limit` / `too many requests` → `rate_limited`
4. `free tier` / `daily limit` / `exhausted your capacity` → `quota_exhausted`
5. `try again` / `temporarily` → `soft_rate_limit`
6. 其余 → `unknown`

`decide429(category, retryAfterMs)`：

| category | kind | retryAfterMs 缺省 |
|---|---|---|
| `soft_rate_limit` | `instant_retry_same_auth`（≤3s）否则 `soft_retry` | 2s |
| `rate_limited` | `soft_retry`（≤5min）否则 `short_cooldown_switch_auth` | 60s |
| `quota_exhausted` | `full_quota_exhausted`（24h 冷却、跳过该账号） | 24h |
| `unknown` | `soft_retry` | 5s |

credits 失败计数：`CREDITS_DISABLE_THRESHOLD = 3` 次后 `CREDITS_COOLDOWN_MS = 5h` 禁用该 authKey（`recordCreditsFailure` / `isCreditsDisabled`）。

**对照我方**（`F:\defws\dsh-agy-provider`，供修复定位）：
- `src\provider\config.ts:141` `AGY_RETRYABLE_CODES = ['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT','AGY_INPUT_FAILED','AGY_SPAWN_FAILED']`（无 `QUOTA_EXCEEDED`）。
- `src\agy\errors.ts:20 classifyAgyFailure(detail, fallback)` 判定顺序：context-window → `(?:quota|credit|balance|billing|budget|usage limit|limit (?:exceeded|reached))` → `QUOTA_EXCEEDED_CODE` → `(?:rate limit|too many requests|throttl|\b429\b)` → `'RATE_LIMIT'` → `"retryable": true` → `'TRANSPORT'`。
⇒ 现场文案 `Individual quota reached. Please upgrade your subscription… Resets in 96h12m27s. … code 429` 命中第一个 quota 正则，判成 `QUOTA_EXCEEDED`（不重试、fail-closed），而 AGY 自身在同一条错误里标了 `retryable: true`。**这就是「整轮直接失败、零退避」的直接机制。**

agy-link 与 chaos-03x 的分类口径同样把 quota 与 rate-limit 分开：
- `repo_amlyczz__dsh-agy-link\src\common\types.ts:328` 正则含 `individual quota reached|quota (?:exceeded|reached|exhausted)|out of quota|insufficient quota|check quota` 等；`:320` 注释 `Deliberately narrow: bare 429 … produced ghost cooldowns`；`:222` `the next account — but it is NEVER a cooldown reason`。
- `repo_chaos-03x__dsh-agy\src\runtime\classify.ts:93-119` 先 `QUOTA_EXHAUSTED_KEYWORDS`（含 `individual quota`），无显式 retry 提示时 `text.includes('quota') || text.includes('resource_exhausted') → quota_exhausted`。
- `repo_chaos-03x__dsh-agy\src\runtime\rotation.ts:124-194`：`FULL_QUOTA_COOLDOWN_MS = 24h`（注释 `24h cooldown for a fully exhausted daily quota (single-account: stop hitting the wall)`）、`RATE_LIMIT_COOLDOWN_MS = 5min`、`MAX_RATE_LIMIT_COOLDOWN_MS = 30min`、`VERIFICATION_COOLDOWN_MS = 15min`；`quota_exhausted` 用服务端 resetTime 封顶 24h；`rate_limited` 返回 `{action:'rotate'}`（换号且不冷却）。

## 3. 家庭（family）作用域：Gemini 与 Claude/GPT 分开记冷却

`open-sse/services/antigravityQuotaFamily.ts`：

```ts
if (bare.startsWith("gemini-") || bare.includes("/gemini-") || bare.includes("gemini")) return "gemini";
if (bare.startsWith("claude-") || bare.startsWith("cloud-") || bare.includes("/claude-") || bare.includes("/cloud-") || bare.includes("anthropic")) return "claude";
return "other";
```

`getQuotaScopedModelForProvider` 对 provider `antigravity`/`agy` 返回 `family:gemini` / `family:claude`；其他 provider 保持精确模型 id。

`open-sse/services/antigravityFamilyCooldown.ts`：家庭冷却持久化在连接行 `providerSpecificData.antigravityFamilyRateLimitedUntil`，用 `lockModel("agy"|"antigravity", connectionId, "gemini-family-lock"|"claude-family-lock", reason, cooldownMs)` 落锁；`rehydrateAntigravityFamilyLocks` 启动时把未过期锁重新落上。关键约束（原文注释）：

> `// Fire-and-forget family PSD write. RPM/burst 429s must pass reason !== quota_exhausted.`

⇒ 只有 `quota_exhausted` 才写家庭冷却，RPM/突发不写。测试样例（`__tests__/antigravity-quota-family.test.ts`）证实：`gemini-3.7-flash-medium` 被锁时同族 `-low` 同锁、跨账号不锁、`claude-sonnet-4` 不锁。

**我方现状**：provider 侧没有家庭/模型级冷却概念，429 一律整轮失败，无法分别处置「Gemini 池满」与「Claude/GPT 池空」。

## 4. 额度读数：三个源并发，各有明确分工

`open-sse/services/usage/antigravity.ts:625`：

```ts
const [data, userQuotaData, quotaSummary] = await Promise.all([
  fetchAntigravityAvailableModelsCached(accessToken, projectId, clientProfile, options),
  fetchAntigravityUserQuotaCached(accessToken, projectId, clientProfile, options),
  fetchAndParseAntigravityQuotaSummary(accessToken, projectId, clientProfile, options),
]);
```

源取舍原文注释（`:558-564`）：

> `fetchAvailableModels is catalog/eligibility data and may keep reporting full buckets after real usage. retrieveUserQuota is the consumption signal for Gemini-family buckets, so prefer it when present and fall back to fetchAvailableModels only for models that have no retrieveUserQuota entry (for example Claude/GPT OSS buckets).`

以及 `:677-679`：

> `// Distinguish "upstream did not report remainingFraction" from "remaining is 0%". fetchAvailableModels is a catalog view and can be stale/full; retrieveUserQuota is the source of truth for actual Gemini consumption when it includes the model.`

实现的边界规则（可直接对表的判据）：
- 缺 `remainingFraction` ⇒ `fractionReported: false`，`remainingPercentage` 键**整个省略**，并 `console.warn`；`total` 记 0，绝不把未知记成 0% 或 100%。
- `fractionReported && !resetAt && fraction >= 1` ⇒ `unlimited`；未上报 fraction 永不判 unlimited。
- 本地用量兜底 `applyLocalUsageFallback`：只对 `quotaSource === "fetchAvailableModels" && used === 0 && !unlimited` 生效；从 `usage_history` 按 `resetAt - 5h < ts <= resetAt` 窗口累加 `tokens_input+output+reasoning`，`Math.max(1, ceil(tokens/1000))` 折算 units（`ANTIGRAVITY_LOCAL_USAGE_WINDOW_MS = 5h`、`ANTIGRAVITY_LOCAL_USAGE_TOKENS_PER_UNIT = 1000`），来源改标 `localUsageHistory`。
- 缓存与超时：models 60s、quota 60s、订阅 5min；每个请求 `AbortSignal.timeout(10000)`；`inflight` Map 合并并发同键请求；401/403 直接 break（不再回退下一个端点）。
- `retrieveUserQuotaSummary` 解析（`antigravityWeeklyQuota.ts`）：`normalizeAntigravityQuotaWindow` 按 `window`/`bucketId`/`displayName` 文本判 `session|weekly`（`\b5h\b|five[-\s]?hour|\bsession\b` / `\bweekly\b|\b7d\b|seven[-\s]?day`）；`normalizeGroup` 按文本含 gemini / claude|gpt 归组，归不进的按 `[^a-z0-9]+ → _` 造 fallback id；`bucket.disabled === true` 丢弃；同时接受 `bucket.remaining.remainingFraction` 与扁平 `bucket.remainingFraction` 两种形状（注释：上游信封变了也不能把家庭窗口悄悄全抹掉）；`QUOTA_CACHE_TTL_MS = 60s`。
- `fetchAvailableModels` 的 URL 走 `ANTIGRAVITY_DISCOVERY_BASE_URLS`（daily → prod → daily-sandbox），而 summary/userQuota 只走 `ANTIGRAVITY_RUNTIME_BASE_URLS`（daily → prod）。
- tier 标签：`mapCodeAssistTierIdToLabel` 把 tierId 文本映射 Ultra/Pro(含 GOOGLE_ONE、ONE_AI)/Enterprise/Business/Plus/Lite/Free，`getAntigravityPlanLabel` 用「live 命中已知集合 > fallback 命中 > 非 Free 的 live」的顺序取标签。

## 5. 面板分组：Gemini 与 Claude/GPT 两组，各显示 5h + Weekly

`src/app/(dashboard)/dashboard/usage/components/ProviderLimits/AntigravityQuotaGroups.tsx`：
`resolveAntigravityQuotaGroups` 优先用 `rawGroups`（summary 原形），否则从扁平 quotas 找 `gemini_session`/`gemini_weekly`/`claude_gpt_session`/`claude_gpt_weekly` 四个键重组；四个聚合键缺失时回退到该族任一模型桶（`fallbackGeminiSession` / `fallbackClaudeSession`）。
每组两行：`5 hour` 与 `Weekly`，各带百分比条与 `Resets in <countdown>`；窗口缺失时渲染 `"<label>: unavailable from upstream"`——**明示未知，而不是显示 0 或 100**。

对照我方面板（`F:\defws\dsh-agy-provider\src\web` 的 `calcFamily`）：读 prod summary 时看到 Gemini 满额、3p 归零，对「未知」只降级成 `—`，且完全不提示「读到的池 ≠ 实际消耗的池」。

## 6. credits 注入（可选旁路，非必需）

`open-sse/services/antigravityCredits.ts`：`injectCreditsField` 在请求体加 `enabledCreditTypes: ["GOOGLE_ONE_AI"]`；模式由环境变量 `ANTIGRAVITY_CREDITS` 取 `off|retry|always`（缺省 off），`retry` 只在 429 兜底时注入，`always` 首请求即注入并跳过常规额度路径。probe 用一个 `gemini-2-flash` + `maxOutputTokens:1` 的最小 SSE 请求从响应里读 `remainingCredits[].creditType === "GOOGLE_ONE_AI"` 的 `creditAmount`（注释承认「This uses ~1 credit」）。

## 7. 可直接借鉴的三条（修复候选，待用户裁定后再动代码）

1. **429 分类补档 + 至少一次退避**：把 `enable overages` / `individual quota` 等同族措辞纳入 quota 判据（我方正则已覆盖 `quota reached`，缺这两项）；并让 AGY 自标 `retryable: true` 的情况至少触发一次退避重试，而非立即 fail-closed。
2. **家庭级冷却 + 面板家庭分组**：Gemini 与 Claude/GPT 分开记 cooldown（仅 `quota_exhausted` 写）；面板按家庭显示 5h/Weekly 两行，未上报窗口显示 `unavailable from upstream` 而非 0/100。
3. **额度读数改三源并发 + 未知显式化**：`fetchAvailableModels`（目录/资格，可能长期满额）+ `retrieveUserQuota`（Gemini 消耗真相）+ `retrieveUserQuotaSummary`（家庭/窗口聚合）并发；缺 `remainingFraction` 的模型标 unknown；本地用量只对「目录源且 used=0」的桶兜底。

## 8. 采集样本清单（均有本地副本，`tmp/20261020-omnirote-study/`）

- `open-sse/config/antigravityUpstream.ts` — 端点三类
- `open-sse/services/antigravity429Engine.ts` — 四分类 + decide429 + credits 失败计数
- `open-sse/services/antigravityQuotaFamily.ts` — 家庭归类 + 窗口选取 + finitePercentUsed
- `open-sse/services/antigravityFamilyCooldown.ts` — 家庭冷却持久化与再水合
- `open-sse/services/usage/antigravityWeeklyQuota.ts` — summary 解析、缓存、inflight 合并
- `open-sse/services/usage/antigravity.ts` — 三源并发、源取舍、本地用量兜底、订阅/tier 标签
- `open-sse/services/antigravityCredits.ts` — GOOGLE_ONE_AI credits 注入
- `open-sse/executors/antigravity/proFallbackChain.ts` — Pro 候选链纯决策函数
- `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/AntigravityQuotaGroups.tsx` — 面板分组
- `open-sse/services/__tests__/antigravity-quota-family.test.ts` — 家庭锁/精确锁判定样例

本地 peer 仓（前次抄写，仍在 `tmp/20261012-agy-peer-survey/`）：`repo_amlyczz__dsh-agy-link`（`src\host\oauth.ts:65` AGY_ENDPOINTS、`src\host\quota.ts:581-640` getOrderedEndpoints + fetch 回退、`:773-868` 聚合规则）、`repo_chaos-03x__dsh-agy`（`src\runtime\classify.ts`、`src\runtime\rotation.ts`）。
