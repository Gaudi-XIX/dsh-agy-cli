# 归档：面板的多账号 UI 与死控件（2026-10-20）

> **受本文件管辖的现状**：AGY 控制面板（`client/index.ts`）现只保留单账号额度卡 + 思考强度
> + 模型显示三块。2026-10-23 起组件入口是注册到宿主 keyed 槽
> `settings.models.provider-card` 的 provider 卡（`id: 'agy-link-provider-card'`，
> `key: 'dsh-agy-cli'`），`AgySettingsSection` 这个名字已不存在。本文件记录被拆掉的 UI
> 形状、拆分依据、以及 **将来要恢复时该接哪些线**。代码本体不删——git 历史里在 `HEAD~` 的
> `client/index.ts`，恢复第一步就是 `git show` 取回。
>
> **挂载点（2026-10-21 用户裁定后变更）**：面板不再注册 `settings.section`（设置导航独立分区）
> 与 `conversation.session.header.actions`（会话页头部徽标），改为注册宿主 keyed 槽
> `settings.models.provider-card`（`key: 'dsh-agy-cli'`，与 `src/index.ts:169-174`
> `registerConfigurableProviders` 的 `settingsNs` 逐字相同），渲染在宿主「设置-模型」页
> Antigravity CLI 那一行的卡片扩展区。模态（`AgyModalDialog`/`agyModalStore`）、徽标
> （`AgySessionStatus`）与 `portalToBody` 随之删除，相关 locale 键
> （`section.label`/`console.title`/`console.close`/`header.badgeTitle*`）与 modal CSS
> 同步移除；第 5 条「重复的产品名」中的「会话头徽章」一项已不存在。
> 恢复旧形态时，两处注册的写法见本文件 git 历史（`HEAD~1` 之前的 `client/index.ts`）。

## 零、2026-10-23 改版：卡片自带折叠 + 两个 select + 勾选清单

用户三条反馈（2026-10-23 15:54）→ 三处改法，均已落码（`client/index.ts`）：

1. **「点编辑弹出的额度框，再点编辑收不回去」**。根因在宿主：`app.asar` ModelsSection 第
   532135 行 `renderSlot("settings.models.provider-card", {provider, configured, keyConfigured},
   {entryKey})` 后面紧跟 532140 的 `open ? renderProviderEditor(…) : null`——卡片是编辑表单的
   **兄弟**，不在折叠区内，slot props 也没有 open。改法：卡片用 `MutationObserver` 盯自己所在
   `<li>` 的 childList，把「编辑表单出现/消失在我们后面」当展开信号（`anchor.nextElementSibling`），
   再叠一个 ▾/▸ 手动开关兜底（`manualOpen` 覆盖 `hostOpen`，宿主状态一变就清空手动值）。
   ⇒ 点「编辑」展开面板、再点收起；即使宿主 DOM 结构将来变动，手动开关仍能收回。
2. **「5 小时额度折成两行」**。`renderLine` 的窗口标签原来写死 `width: 52px`，中文放不下。
   改为 `white-space: nowrap` + 自适应宽度 + `padding-right`。
3. **「模型 + 思考强度在放开新模型（如 Pro）后会乱」**。旧形态是「每个模型一个药丸按钮
   （点＝隐藏）＋ 思考强度四段按钮」，模型一多就是一面墙，且看不出当前生效项。改为：
   模型 `<select>`（值＝`status.defaultModel`，写 `POST /config {key:"defaultModel"}`）、
   思考强度 `<select>`（auto/low/medium/high，写 `defaultEffort`）、模型显隐改为可滚动
   勾选清单（写 `hiddenModels`）。样式新增 `.agy-select` / `.agy-checklist` / `.agy-check-item`，
   并删除随之失效的 `segGroup`/`segBtn`/`segBtnActive` 三个 style 条目（`--agy-seg-*` CSS 变量
   保留，未来分段控件可直接复用）。

验收（时点：2026-10-23 17:0x）：`npm run build:client` = 8 modules → `dist/client.js` 198,728 B；
`build-client-smoke` ok；宿主 `/plugins/events` 里 `dsh-agy-cli` 的 rev 与盘上按
`(mtimeMs, ctimeMs, size)` 实算一致 ⇒ 刷新页面即加载，无需重启宿主。

### 零附、2026-10-23 深夜：卡顿与打不开（两条实测根因）

现象（用户原话）：「刚已经重启了，但是感觉很卡很卡很卡」「打开这个 AGY 的页面，在模型里面很卡，
点进去是空白的，然后要等很久」＋「第一次打开有一个旋转，写着『什么什么操作失败，请重试』。
我再去打开就是空白了」。

| # | 根因 | 证据 | 修法 |
|---|---|---|---|
| 1 | 每 3 秒轮询 `/plugins/agy-cli/status` | `client/index.ts:191` `setInterval(…, 3000)`，订阅者为 0 也不停 | 按用户裁定整段删除定时器，改为 `loadStatusOnce()`：挂载时取一次 + 手动「刷新额度」 |
| 2 | 同步 spawn PowerShell 读凭据 | `/status` 首字节实测 10,934–22,000 ms；`/diagnose` 同时仅 1–7 ms ⇒ 卡在 `/status` 自己的服务端计算；`src/web/router.ts` 用 `execFileSync('powershell.exe', …, { timeout: 5000 })`，一次 `/status` 要串行跑 2–3 次 | `src/agy/keepalive.ts` 新增 `readKeyringBlob()`：`execFile` 异步 + 30 s 缓存 + in-flight 复用；`readIdentityFromKeyring()` 改 async；`refreshQuotas` 加 `quotaInFlight` 单飞 |
| 3 | single-flight 写错，后到的调用方立刻 resolve | node 复现：第二次 `await loadStatusOnce()` 立即 settle 且 `status === null` ⇒ 走错误分支显示「操作未完成。请重试」 | `statusInFlight` 改存 Promise 本身，后到者 `return statusInFlight`（同一 run），`statusFetchSeq` 仍丢弃乱序响应 |
| 4 | 失败态没有重试入口 | `status === null` 分支只有 spinner + 一句文案 | 该分支渲染 `[错误文案][重试]` 按钮；locale 四语言新增 `status.retry`（zh `重试` / en `Retry` / pt-BR `Tentar novamente` / es `Reintentar`） |

验收（时点：2026-10-23 22:xx）：`npx tsc -p tsconfig.json` 通过；`node scripts/run-tests.mjs`
= **306 pass / 0 fail**；`build-client.mjs` → `dist/client.js` 201,769 B，实算 rev
`e335049e1319` 与宿主 SSE 图一致；服务端直取该 rev 正文 marker 全 HIT
（`statusInFlight !== null` / `status.retry` / `loadStatusOnce` HIT，`ensureStatusPolling` /
`statusPollTick` MISS）。宿主实测 `/status` 首字节从 10–22 s 降到 2,993 ms。
本轮改动已提交：`fdd1eb4`。

## 一、为什么拆

用户裁定（2026-10-20）：「关于多账号、主账号的内容全部精简掉……防备着哪天又有多账号轮转的需求，
但是目前只保留单账号」＋「账号显示了两次，anti gravity 产品名也显示了两次」。

三条硬依据，不是审美：

1. **死接口**。客户端 `postJson` 打过 10 个路径，服务端 `src/web/router.ts` 只注册 4 条
   （`GET /plugins/agy-cli/status`、`POST /config`、`POST /pool/refresh-quota`、`GET|POST /auth`）。
   下面这 8 个**从来没有服务端实现**：`/pool/begin-add`、`/pool/complete-add`、`/pool/cancel-add`、
   `/pool/primary`、`/pool/remove`、`/pool/proxy`、`/pool/mode`、`/pool/clear-cooldown`。
   点击只会走 `res === null → actionFailed() → api.genericError` 弹一条「操作未完成」。
2. **服务端是硬编码单账号**。`status` 路由里的 `pool` 是当场拼出来的合成对象：
   `accounts: [{ id: 'primary', alias: accountAlias, dir: '', systemHome: true, enabled: true,
   cooldowns: {}, quotas }]`，`primaryAccountId`/`activeAccountId` 都是字面量 `'primary'`。
   于是「主用」「当前使用」「号池调度：顺次耗尽/轮询均衡」「冷却中·已自动切换账号」这些控件
   **在单账号后端上没有可表达的状态**。`account.cooldown` 的中文文案直接写着「已自动切换账号」，
   而本机上不存在第二个账号——那是假话。
3. **凭据来源只有一个**。身份取自 Windows 凭据管理器 `gemini:antigravity` 一条
   （`readIdentityFromKeyring()`，`router.ts:197`）。加账号需要走 Google OAuth device flow，
   那套 `poolAuth` 状态机在客户端有类型定义（`StatusPayload.poolAuth`）、服务端从不返回。

按工作区规则「不留无消费者死接口」「不增设不解决痛点的限制」，这三组一律拆。

## 二、被拆掉的 UI 形状（恢复时照此重建）

### 1. 账号卡列表（原 `client/index.ts:1243–1435`，`renderedAccountCards`）
每个账号一张卡，含：
- 绿/灰状态点 + `displayAlias`（`defaultAlias || systemHome ? t('account.defaultAlias') : t('account.aliasDefault', {number})`）
- 徽章：`status.primary`（主用）、`status.inUse`（当前使用，仅 `enabled && !authRequired` 时显示）、`status.proxy`（代理）
- 按钮：`account.setPrimary`（设为主用）、`account.sync`（刷新此账号）、`proxy.button`（展开代理输入框）、
  `account.remove`（删除）、`account.clearCooldown`（清除冷却，闪电图标）、明细折叠按钮（`toggleExpand`）
- 冷却横幅：任一模型 `cooldowns[m].cooldownUntil > Date.now()` 时显示 `account.cooldown` + 本地冷却时长
- 代理输入框：`proxy.placeholder`，值取 `proxyInputs[id] ?? acc.proxyUrl ?? ''`，保存走 `saveProxy`
- 额度行：`renderQuotaBar` × (Gemini / Claude / GPT-OSS) 三族 + 逐模型明细（折叠）

### 2. 添加账号流程（原 `client/index.ts:1436–1548`，`addAccountSection` + `poolAuth`）
`addingAccount` 打开一个内联区块，按 `status.poolAuth.phase` 五态渲染：
`idle`（按钮「打开浏览器登录」）→ `waiting`（展示 `poolAuth.url` 链接 + 等待文案 `auth.waiting`）→
`exchanging`（spinner + `auth.exchanging`）→ `done`（toast `auth.activated`）/ `failed`（`auth.code.<原因>` 映射）。
兜底通道：粘贴授权码或完整回调 URL 到 `auth.codePlaceholder`，提交 `handleCompleteAddAccount`。
`useEffect`（原 `:921–934`）监听 `status?.poolAuth?.phase/code` 自动推进并清 `authCodeInput`。
`flowStartedRef` 防止同一流程重复发起。

### 3. 号池调度（原 header 区一行）
`pool.label` + 两个分段按钮 `pool.sequential` / `pool.roundRobin`，走 `setMode` → `/pool/mode`。

### 4. 权限模式分段控件（原 `client/index.ts:1214–1233`）
`permission.label` + plan / accept-edits / skip 三档，`onClick: setCfg('permissionMode', …)`。

**这一条与多账号无关，单独说明**：服务端 `status` 回的是常量
`permissionMode: 'dsh-owned'`（`router.ts:569`），`POST /config` 的分支只有
`hiddenModels` / `defaultEffort` / `defaultModel`，`permissionMode` 落到底部
`sendJson(res, 200, { ok: true })` 的兜底——**既不生效也不持久化**。三个按钮的
`status?.permissionMode === 'plan'` 等比较永远为假，所以没有一档会高亮。
而且**不能**改成可用：provider 侧权限归 DSH 会话，`docs/dsh-provider-contract.md` 与
`docs/tool-capability-matrix.md` 都写明 provider 不传 `--dangerously-skip-permissions`、
不自动批准 AGY 权限请求（遇 permission 事件立即返回 `PERMISSION_REQUIRED`）。
即「接上消费者」这条路被产品契约堵死，只剩拆。

### 5. 重复的产品名
`Antigravity` 原在四处出现：宿主设置导航的 `section.label`、模态标题 `console.title`、
面板 header 的图标+字面量、会话头徽章。宿主导航与模态标题由宿主/对话框各自负责，面板 header
再打一次是第三次。账号别名 `name (email)` 由服务端拼好，徽章再拼 `(email)` 就是地址显示两遍。
2026-10-21 起：宿主设置导航项、模态、会话头徽章三项已整体移除（面板改挂
`settings.models.provider-card`，产品名由宿主的 Models 行标题 `Antigravity CLI` 承担）；
面板 header 依旧无图标无产品名。本条目连同被拆控件一并归档，恢复多账号时不必重建它们。

## 三、恢复步骤（若日后要做多账号轮转）

1. **先补服务端**，别先补 UI：`src/web/router.ts` 加 8 条路由（begin-add/complete-add/cancel-add/
   primary/remove/proxy/mode/clear-cooldown），并让 `pool` 真读 `~/.dsh/agy-accounts/pool.json`
   （原生 Agy Link 的落盘台账，`models` 里已有逐账号 quota）。
2. **抄多账号轮转的现成实现**：peer 仓 `F:\defws\tmp\20261012-agy-peer-survey\repo_amlyczz__dsh-agy-link`
   ——`src/host/pool.ts:535 isAccountEligible`（冷却门）、`src/host/adapter.ts:1663`
   `pool.advanceAccount(account.id, family)`（**换号而非换端点**）、`src/common/pool-types.ts:104,133`
   的 `ManagedAccount` 形状（本仓 `client/common/pool-types.ts` 与之同源，UI 不用改类型）。
3. UI 侧从 `git show <本文件父提交>:client/index.ts` 取回上述五段，删掉本文件的对应说明行。
4. 客户端 `StatusPayload.poolAuth` 类型定义**保留未删**（`client/index.ts:80`），恢复时直接可用。

## 四、现状对照（面板实际渲染什么）

| 区块 | 现状 |
|---|---|
| header | 就绪/待授权徽章 + 「刷新额度」按钮 |
| 凭据过期横幅 | `status.quotaError === 'unauthorized'` 时显示 `quota.expiredHint` |
| 额度卡 | 单账号：别名 + Gemini 5h/周两条 bar + 逐模型明细（缺值显示 `—`，不填 100%） |
| 思考强度 | auto/low/medium/high，写 `~/.dsh/agy-link/runtime-overrides.json` |
| 模型显示 | 目录项点击隐藏/显示，写 `runtime-overrides.hiddenModels` 并同步 `cordis.patch.yml` 的 `visibleModels` |
| ~~多账号~~ | 已拆，见本文 |
| ~~号池调度~~ | 已拆，见本文 |
| ~~权限模式~~ | 已拆，见本文 §2.4 |
| ~~代理按钮~~ | 已拆；真正生效的代理是服务端 `fetchHttpsThroughHttpProxy` 的 `127.0.0.1:12450`（`router.ts:235`），与面板无关 |

**已知未闭合**：思考强度控件写进 `runtime-overrides.json` 后，只有面板自己读回来显示；
生成链路的实际强度在 `src/provider/agy.ts:1730` 取 `gemini-* → 'high'` 常量，不读该文件。
是否要让这个控件真正生效（或拆掉），属方向决策，待用户裁定。

## 五、下一次改这块前必须先读的两条

1. **改 `src/` 必须全量 build**：`npx tsc -p tsconfig.json`（`--noEmit` 不重建 `lib/`），宿主读的是
   `lib/`。只跑 `--noEmit` 会让测试与运行态继续用旧代码，表现为「改了没用」。
2. **改客户端只需 `node scripts/build-client.mjs`**，产物 `dist/client.js` 经 desktop profile 的
   junction 被宿主直读，**刷新页面即生效，不必重启宿主**；`scripts/build-client-smoke.mjs` 断言
   入口契约（`name`/`inject`/`apply`）。改 `src/`（服务端）则必须重启宿主才进运行态。
