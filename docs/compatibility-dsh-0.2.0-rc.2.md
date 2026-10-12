# DSH 宿主 0.2.0-rc.2 适配记录

> 2026-10-12，fork 适配提交 `b195ef8`。宿主：DeepSeek Harness 桌面版 v0.2.0-rc.2（Electron 44 / cordis 4.0.4 / Node 24），Windows 11。
> 结论：**断裂面远小于"0.1→0.2 大版本跨"的直觉——三类 API 变化、3 个源文件、约 30 行改动**。typecheck 0 错、自带测试 219/219、live 通路（spawn 真实 agy）实测 PASS。

## 版本 gate 的机械原因

peer 声明 `^0.1.0-rc.7 || ^0.1.0-rc.8` 不含宿主实际供给的 `0.2.0-rc.2`。修正范围直接对照已适配宿主的 `dsh-subscriptions@0.1.5`：`>=0.1.7-rc.2 <0.3.0-0`（五个 dsh-* 子包同改；`@deepseek-ai/cordis@^4.0.1` 不动，semver 兼容宿主的 4.0.4）。

## 三类 API 断裂与修法

### 1. `CallId` → `ToolCallId`（brand 重命名）

`@deepseek-ai/dsh-llm` 不再导出 `CallId`；branded id 类型与同名构造函数现名 `ToolCallId`（`lib/types/brand.d.ts`）。

```diff
-  CallId,
+  ToolCallId,
   EMPTY_RESPONSE_CODE,
   ...
-  const callId = CallId(randomUUID())
+  const callId = ToolCallId(randomUUID())
```

位置：`src/provider/agy.ts` import + 2 处构造（`agy.ts:1294/1874`）。

### 2. tool-result 从 content block 升级为一等 tool-role 消息（最大语义变化）

0.2.0 的 `ContentBlock` 联合收窄为 `file | text | image | reasoning | tool-call | tool-addition | tool-removal`——`tool-result` 不再是 block。工具结果改为独立消息类型 `ToolResultMessage`（`role: 'tool'`、`toolCallId: ToolCallId`、`isError?: boolean`、`content` 继承自 `MessageBase`），`Message` 联合新增 `tool` 成员。

这是 dsh-owned 工具桥的配套架构：provider 只回 `tool-call` chunk 发起调用，DSH ToolRuntime 执行后，结果以 tool-role 消息进入下一轮 `GenerateOptions.messages`——不再经流式 chunk 回传。

修法（`src/provider/serialize.ts`）：
- `blockText`/`blockValue` 删除 `case 'tool-result'` 死分支；
- `messageText`/`roleLabel` 参数 `Message` → `RequestMessage`，`messageText` 增加 `role === 'tool'` 分支，保持原有 `[DSH TOOL RESULT]` 文本渲染格式不变；
- `src/provider/image-bridge.ts`：`imageRefsOf`/`replaceImageBlocks` 删除对 tool-result block 的递归（图片引用现在只可能出现在顶层 image block——image 桥在请求入口统一 staging/替换）；`replaceMessageImages` 签名放宽为 `RequestMessage[]`。

### 3. `SettingsProvider.register()` 废弃

`@deepseek-ai/dsh-settings@0.2.0` 移除了 `settingsNamespace()` 与 `register()`；新机制是 **SettingsForms（cordis Service）自动投影每个插件 export 的 `Config` schema** 生成设置表单，插件无需手动注册。provider 本就声明了 `export const Config = ConfigSchema`，投影前提天然满足。

修法（`src/index.ts`）：删除 `settingsNamespace`/`SettingsProvider` import、`resolveSettingsConfig` 的 register 与 late-inject 兜底（直接返回宿主合并后的 `config`，它已是 live 值）、`inject` 从 `['llm', 'settings']` 收窄为 `['llm']`。

对照现役插件佐证：`dsh-better-sidebar@0.25.0`（rc.2 上存活）只有 `settings.configure({auto}, fiber)` 与 `settings.describe()`，无任何 register。

## 验证

| 层 | 结果 |
|---|---|
| typecheck（devDeps 升至 0.2.0-rc.2 实包类型） | 0 错 |
| 自带测试套件 | 219/219（含 2 个 fixture 从旧 block 结构更新为 tool-role 消息） |
| live 通路 | spawn 真实 AGY CLI（无 fake runner）→ `gemini-3.8-flash-medium` 真实回话 → text-delta/usage/finish 全链路正常，22.6s 端到端 |
| AGY 版本 | `1.3.2` 实测通过（上游矩阵此前最高验证到 1.1.15） |

## Windows 凭据与代理运维事实（live 测试时发现）

- AGY 登录态存 **Windows 凭据管理器**（`LegacyGeneric:target=gemini:antigravity`），非磁盘文件。
- access token 会过期；过期后 AGY 用 refresh token 自动续期——**续期需要网络且只认 `HTTPS_PROXY` 环境变量**（Go 默认传输）。
- 无代理时的症状具有迷惑性：`keyringAuth: timed out after 10s, skipping keyring auth` 后报 `Please sign in to view available models`——**看似掉登录，实为刷新超时**，设置代理后立即自愈。
- DSH 宿主子进程树自带 `~/.dsh/.env` 的 `HTTP(S)_PROXY`，故 provider 在宿主内天然可用；独立终端直跑 agy 必须手动带上代理变量。

## 可复用方法

适配 DSH 插件宿主版本的套路：①对照已适配插件的 peer 范围确定 gate 正确写法；②devDeps 升到目标宿主实包版本跑 typecheck——tsc 会给出完整断裂清单；③断裂面按联合类型变化逐个落图，通常远小于大版本号差带来的预期。
