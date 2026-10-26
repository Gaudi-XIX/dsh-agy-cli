# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

把本机已登录的 **Google Antigravity CLI（`agy`）** 接入 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 作为一级模型提供方。

**这个插件的三件事：**

1. **生成流量由官方二进制自己签名** —— 每一轮模型请求都通过官方 `agy.exe` 发出，插件不代它签名、不接管它的生成链路，模型侧的风控面与官方客户端一致。
2. **吃到 Antigravity 账号的官方额度** —— 消耗打在你自己的套餐上，与官方客户端同池同规则，不需要 API Key。
3. **AGY 只当模型，DSH 接管 harness** —— 工具执行、审批、沙箱、上下文预算 100% 在 DSH；AGY 自带的 agent 循环被剥离。

> **平台限制**：**仅 Windows**。配额面板与凭据保活依赖 Windows Credential Manager；其余功能无跨平台实现，未在 macOS/Linux 验证。

---

## 凭据与网络行为（如实写清）

这一点容易被含糊带过，所以直接列出来：

- **读取**：Windows Credential Manager 里 AGY 写入的 Google OAuth blob（target `gemini:antigravity`），由 `src/agy/keepalive.ts` 的 `CredRead` 完成。用途有两个：判断令牌是否临近过期并触发一次官方 CLI 续期；读取 `access_token` 用于下面的配额查询。读到的令牌只在进程内使用，不落日志、不进错误消息。
- **配额查询（唯一的插件自带出站请求）**：把上面读到的 `access_token` 作为 `Authorization: Bearer` 发往 `https://daily-cloudcode-pa.googleapis.com` 与 `https://cloudcode-pa.googleapis.com` 的只读配额 RPC（`retrieveUserQuotaSummary` / `fetchAvailableModels`），并附带 AGY 客户端的身份头（`User-Agent` / `X-Goog-Api-Client`）——服务端对不同客户端返回的配额分组不同，不带身份头会漏掉 Gemini 组。**请求只发往 Google 这两个端点，不外传第三方。**
- **不做的**：不拦截、不重放、不伪造生成请求；不把令牌交给任何第三方；不读取除上述 target 以外的凭据。
- **续期**：令牌轮换完全由官方 `agy.exe` 自己完成，插件只负责在到期前拉起它一次。

实测依据见 `docs/prod-generation-feasibility-20261020.md`（两个端点的配额语义、身份头对返回值的影响）。

## 功能

- **双工具路线**：MCP 桥把 DSH 工具交给 AGY（真工具事件、过程流可视化，推荐），失败自动降级为 prompt 契约
- **DSH 主导 harness**：工作区、审批、沙箱、上下文预算全在 DSH；AGY 只出模型
- **流式 + 状态机**：`stdinMode: hold` 防回滚、思考链折叠、尾流交付、断连保文本
- **会话管理 + 历史指纹链**：resume / full 双模式，每轮成功后记录 DSH 历史指纹；resume 前本地比对前缀，检出历史被编辑/压缩/截断即废弃旧会话并从完整历史重建，delta prompt 不会落在过期上下文上；死亡会话自动重放，会话映射落盘可迁移
- **图片输入**（experimental）：附件经图片桥落盘，由最小权限的 view_file Agent 查看
- **配额面板与凭据保活**：loopback-only；面板显示真实双窗口配额，令牌临近过期时自动拉起官方 CLI 续期
- **安全加固**：原型污染防线、MCP 桥面闸门、面板 loopback 门与原子写、凭据脱敏——全部有测试背书

## 安装

```console
dsh plugin --profile <你的 profile> add dsh-agy-cli
```

前置要求：Windows；本机已安装并登录官方 Antigravity CLI（`agy`）；Node ≥ 22。

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
npm test    # tsc 全量 → 320 例 node --test
```

## 许可

MIT。源码衍生自 Darkings 的 `dsh-agy-provider`（MIT）；原作者版权与完整提交历史保留于 `LICENSE` 与本仓 git 历史。
