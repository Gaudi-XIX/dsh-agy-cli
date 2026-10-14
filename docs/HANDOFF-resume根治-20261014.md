# AGY provider — resume 根治（2026-10-14 17:2x–17:5x）

## 结论（可验收信号）

**根治 = resume 档每轮 `requestMode: delta` + `conversationReused: true` + `promptBytes` 与历史长度解耦。**
在此之前该档每轮都是 `requestMode: bootstrap`、`conversationReused: false`、`promptBytes === promptLimitBytes === 184320`、
`omittedMessageCount` 137——整段 DSH 历史被重新序列化成一条贴顶提示词，上游前缀缓存零命中（`cacheReadTokens: 0`）。

## 根因链（三条，全部实测）

1. **`sessionId → conversationId` 映射只活在内存**。`agy.ts:996` 默认 `new SessionRegistry()`（纯内存），
   宿主重启即空 ⇒ 每个既有会话的第一轮都退回全量 bootstrap。`src/session/store.ts` 头注释自陈
   "losing it on plugin restart falls back to full DSH history"。
2. **TIMEOUT 时把映射删掉**（`agy.ts:1787` 原 `if (mapped.code === 'TIMEOUT' && sessionKey !== undefined) this.sessions.delete(sessionKey)`），
   理由是「别让 DSH 重试一个半截对话」。**实测反了**：`probe-timeout-resume.mjs` 证明 AGY 被 timeout 杀掉后
   会话仍在盘上、`--conversation <id>` 跨新进程可续。删绑定 ⇒ 一轮超时把会话永久钉死在 bootstrap 贴顶形状，
   下一轮再超时 ⇒ 死循环（遥测 `fddb3e89`/`715deca7`/`0e4ea6dd`/`2739345c`/`3675f99d` 五连 TIMEOUT，均 120289–120364 ms）。
3. **AGY 早退自杀被报成 `AGY_INPUT_FAILED/EOF@stdin`**：`337f43ab` 的 `stderrSummary` 是
   `error: Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal/fetchUserInfo": EOF`
   ——资格检查被代理掐断（Google 经代理约 25% 被掐）后 AGY 自杀，fork 写 stdin 撞已关管道。

## 已落地（fork `F:\defws\dsh-agy-provider`，HEAD `39cd5ae`，258/258 绿，tsc 0 error）

| 提交 | 内容 |
|---|---|
| `ac90eb9` fix(session): keep the AGY conversation binding across host restarts | 新增 `src/session/file-store.ts`（`FileSessionStore`：写 `<DSH_HOME>/agy-provider/sessions.json`，30 天淘汰、2000 条上限按 `updatedAt`、`.tmp`+`renameSync` 原子替换、坏文件/不可写降级内存）；`src/index.ts:300-302` 仅 `sessionMode==='resume'` 时注入（`full` 仍纯内存，测试隔离不变）；`src/provider/config.ts` 加 `sessionStorePath`（空=DSH 默认、`.json`=文件、否则目录） |
| `39cd5ae` fix(session): keep the conversation binding when a one-shot turn times out | 删掉 one-shot 失败路径里的 TIMEOUT 分支。另两处作废点保留：carrier 内部信封（`:1933`）、AGY 内部工具异常（`:1949`）；`conversationMismatch` 仍 abort + 全量重试 ⇒ 陈旧 id 只赔一轮，不会打死会话 |

**作废点清单（别再加回）**：TIMEOUT 不再是删绑定的理由。真需要删的三处：内部信封载体失败、AGY 侧工具异常、
`conversationMismatch`（后者是 abort+full-fallback，不是静默删）。

## 探针实证（可复用）

- `probe-resume-across-process.mjs`：两轮各起全新进程，第二轮只带第一轮 id ⇒ 答出第一轮暗号、回报同一 id ⇒ **跨进程 resume = YES**。
- `probe-stale-conversation.mjs`：喂不存在的 `00000000-0000-4000-8000-000000000000` ⇒ exit 0、AGY 给新 id、stderr 仅 `warning: conversation "..." not found` ⇒ **陈旧 id 安全退化**。
- `probe-timeout-resume.mjs`：turn 1 用 20 s 上限在 AGY 已 emit `init` 后被杀，turn 2 新进程只带该 id ⇒ 正常答完 ⇒ **被 time out 的会话仍可续**。
- AGY 会话真落盘：`F:\AgentData\antigravity\data\conversations\` = **342 个 SQLite `.db`（623.50 MB）+ `.db-wal`**。

## 遗留

- **`39cd5ae` 未 push**（用户 m02649：推送他自己说）。fork 远程 `https://github.com/Gaudi-XIX/dsh-agy-provider`。
- **durable store 尚待真机验收**：`C:\Users\toast\.dsh\agy-provider\sessions.json` 已由运行态宿主创建（17:24:27 > 宿主 15:33:47 启动 ⇒ 新代码已在运行态），当前 `{"sessions":[]}`。验收信号＝既有会话的下一轮出现 `requestMode: delta` + `conversationReused: true`。
- 探针残留备份待删（红线，逐项待批）：内层 `F:\AgentData\antigravity\data\gemini-root-config\` 的 `mcp_config.json.dsh-agy-provider.bak`(333 B)、`settings.json.dsh-agy-provider.bak`(569 B)；外层 `settings.json.bak-pre-allowrules-20261013-143245`(120 B)、`settings.json.bak-pre-wildcard-20261014-1226`(610 B)；`agents/` 下 3 个 `dsh-agy-mcp-executor.md.backup-*`/`.bak-pre-exclude-*`。
- `probe-timeout-resume.mjs` 的 turn 1 两次被 `loadCodeAssist: EOF` 打断 ⇒ 单次探针阴性不等于否定结论，须复跑。
