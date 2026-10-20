# 模型目录储备：被 UI 隐藏的条目与切回方式

> 归档时间：2026-10-20 13:3x（东八区）。数据基准：`agy models`（agy.exe v1.4.2）、daily 端点 `fetchAvailableModels`、`agy -p /usage --output-format json`。
> 代码没有被删除。UI 精简只改了两处常量与一处渲染，条目本身仍可从配置恢复——**恢复是改配置，不是改代码**。

## 1. 为什么只留 Gemini 3.8 Flash

三条事实同时成立才做的决定：

1. **能用**：`agy models` 只列出 6 个 id，其中第三方只有 `claude-sonnet-4-6`、`claude-opus-4-6-thinking`、`gpt-oss-120b-medium`；Gemini 侧是 `gemini-3.8-flash` 的 high/medium/low 三个 effort 变体（同一个基础 id）。
2. **耗尽**：2026-10-20 12:0x `agy -p /usage` 读数 —— Gemini weekly 0.008289657533168793（1%）、3p weekly **0**（reset 2026-10-23T19:08:49Z）。列出来的第三方模型，点发送就是 429。
3. **要退场**：Google 官方 `docs/cli/commands/models.md` 标注 Claude Sonnet/Opus 4.6 与 GPT-OSS 将于 **2026-11-02** 从促销档移除。

## 2. 被移出 UI 的条目

### 2.1 面板模型勾选（原 `src/web/router.ts` 的 `DEFAULT_CATALOG_MODELS`）

| id | name | 现状 | 恢复条件 |
|---|---|---|---|
| `gemini-3.8-flash` | Gemini 3.8 Flash | **保留（现役唯一）** | — |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Thinking) | 3p weekly = 0；11-02 退场 | 额度恢复 / 换直付套餐 / 11-02 前临时用 |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) | 同上 | 同上 |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) | 同上 | 同上 |

### 2.2 宿主选择器（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `- id: dsh-agy-provider` 段）

原 `models:` 是四项（`gemini-3.8-flash` / `claude-sonnet-4-6` / `claude-opus-4-6-thinking` / `gpt-oss-120b-medium`），原 `visibleModels:` 是四项同名。现均收成一项 `gemini-3.8-flash`。

注意 `visibleModels` 为空数组的语义是**显示全部**，不是「一个都不显示」——这是原来「面板出现 19 条目录」的直接原因（`src/provider/config.ts:415` `filterVisibleModels`：`visibleModels.length === 0` 直接 return 全部）。所以收窄必须显式写一项，不能置空。

### 2.3 额度展示族（原 `client/index.ts` 的 `renderQuotaBar` 三卡）

原固定渲染三张卡：`Gemini`（google）/ `Claude`（anthropic）/ `GPT-OSS`（openai）。现只渲染 Gemini。逐模型明细行同步只取 `quotas.google.models`。

`src/web/router.ts` 里 `refreshQuotas` 仍然解析并缓存 anthropic / openai 两族的数据（`cachedQuotas` 三键仍在），只是 `DISPLAY_FAMILIES` 与客户端不再渲染。保留解析是为了恢复时不用重写聚合逻辑。

## 3. 已排除的候选（不要再试）

这两类曾出现在上游目录里，实测均不可用：

| 候选 | daily | prod | 结论 |
|---|---|---|---|
| `gemini-3.1-pro-high` / `-low` | 404 `Requested entity was not found` | 429 | daily 目录里不存在该 id |
| `gemini-3.6-flash-high` / `-medium` | 404 | 429 | 同上 |
| `gemini-3.5-pro` | — | — | **该 id 从未存在**；3.5 代只有 flash 系（`-extra-low` / `-low` / `-lite`） |
| `gemini-4-argon-*` | 墓碑（`gemini-4-argon-disabled`） | `disabled: true` + `tagTitle: "Upgrade"` | 需**直付** Pro/Ultra；联营/促销档拿不到（详见 `docs/argon-availability-research-20261020.md`） |

`prod` 端点的目录比 daily 多 6 条（25 vs 19），但 prod 对 consumer 账号的生成请求 0/4、8/8、24/24 全 429 —— **目录新 ≠ 可用池**。

## 4. 切回步骤

### 4.1 恢复第三方模型（Claude / GPT-OSS）

1. 确认额度真的回来了：`agy -p /usage --output-format json`，看 `Claude and GPT` 组的 weekly 是否 > 0。
2. 改 `~/.dsh/profiles/desktop/cordis.patch.yml`（先备份）的 `- id: dsh-agy-provider` 段：
   ```yaml
   visibleModels:
     - gemini-3.8-flash
     - claude-sonnet-4-6
     - claude-opus-4-6-thinking
     - gpt-oss-120b-medium
   models:
     - id: gemini-3.8-flash
       name: Gemini 3.8 Flash
     - id: claude-sonnet-4-6
       name: Claude Sonnet 4.6 (Thinking)
     - id: claude-opus-4-6-thinking
       name: Claude Opus 4.6 (Thinking)
     - id: gpt-oss-120b-medium
       name: GPT-OSS 120B (Medium)
   ```
   两处都改：`visibleModels` 过滤 `models`，只改一处不会让模型出现。
3. 恢复面板勾选与额度卡：把 `src/web/router.ts` 的 `DEFAULT_CATALOG_MODELS` 补回上表四行、`DISPLAY_FAMILIES` 改成 `['google', 'anthropic', 'openai'] as const`；`client/index.ts` 的额度区补回两行 `renderQuotaBar('Claude','anthropic',acc)` / `renderQuotaBar('GPT-OSS','openai',acc)`，`allChildModels` 恢复三族展开。
4. 重新构建：`npx --no-install tsc -p tsconfig.json`（lib/ 供宿主），面板客户端需 `npm run build:client`——**该命令当前断的**（`package.json:54` 硬编码 `C:/Users/toast/.dsh/profiles/desktop/node_modules/tsdown/dist/run.mjs`，本机无 tsdown，见下节）。
5. 重启 DeepSeek Harness 才生效；面板侧 Ctrl+R 只刷新已装载的客户端 bundle，**不是**重读 `dist/client.js`。

### 4.2 恢复 `dynamicCatalogModels`（把上游目录全量喂给面板）

已删除。原逻辑在 `refreshQuotas` 中把 daily `fetchAvailableModels` 的 19 条全量塞进 `dynamicCatalogModels`，再在 `/plugins/agy-link/status` 里作为 `catalogModels` 返回。

需要恢复时的最小形状：
```ts
let dynamicCatalogModels: Array<{ id: string; name: string }> = []
// 在 modelsRaw 循环里：
discoveredList.push({ id, name: displayName })
// 循环后：
if (discoveredList.length > 0) dynamicCatalogModels = discoveredList
// status 路由里：
let discovered = dynamicCatalogModels.length > 0 ? [...dynamicCatalogModels] : [...DEFAULT_CATALOG_MODELS]
```
不建议恢复：每次 status 轮询都把 19 条目录随响应下发，而面板只有 1 条可勾选；且被隐藏的条目点发送就是 404/429。

## 5. 构建命令的已知断裂（恢复时的绊脚石）

`npm run build:client` 因 `package.json:54` 写死了本机 profile 下的 tsdown 路径而必然失败，本机无 tsdown（仓 devDependencies 也从未有过）。可用口径：

```
npx --no-install tsc -p tsconfig.json --noEmit   # 类型检查
node scripts/run-tests.mjs                       # 测试
```

要修就得装依赖（`tsdown@0.22.14`，与同类实现 chaos-03x / amlyczz / Jaylor-Wang / suntianc 四家同款），属「新增依赖需用户点头」的红线，用户 2026-10-20 明确表示暂缓（「用得很顺，没出现不能的问题」）。

## 6. 同批次相关文档

- `docs/prod-endpoint-research-20261020.md` — 四个 cloudcode 端点的定位与 consumer 生成实测
- `docs/prod-generation-feasibility-20261020.md` — 自拼 HTTP 直打 prod 的可行性实测
- `docs/peer-quota-429-survey-20261020.md` — 同类实现的端点分层 / 429 分类 / 额度聚合抄写
- `docs/argon-availability-research-20261020.md` — Gemini 4 Argon 三假设的取证结论
