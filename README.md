# dsh-agy-cli

[![npm](https://img.shields.io/npm/v/dsh-agy-cli)](https://www.npmjs.com/package/dsh-agy-cli)
[![license](https://img.shields.io/github/license/Gaudi-XIX/dsh-agy-cli)](LICENSE)

把本机已登录的 **Google Antigravity CLI（`agy`）** 接入 [DeepSeek Harness (DSH)](https://github.com/darkings/dsh) 作为一级模型提供方。**全部上游流量由官方二进制自己签名发起；工具执行、审批策略、工作区沙箱 100% 留在 DSH。**

> **接续声明**：本项目是 [`darkings/dsh-agy-provider`](https://github.com/darkings/dsh-agy-provider) 的接续维护版——原作者自 2026-08-28 起停更，本仓库自 2026-10-12 起接续（适配 DSH 0.2.0-rc.2 宿主、MCP 工具桥、全源码安全审计），git 历史完整保留原作者全部署名，MIT 协议不变。模型路由 id 保持 `agy`，从原版迁移无需改配置。
>
> **血统与出处**：源码主体来自 `dsh-agy-provider`（原作者 Darkings），设置页 UI 部分源自 [`dsh-agy-link`](https://github.com/amlyczz/dsh-agy-link) 的面板代码精简而来；接续期间新增的能力各自标注了借鉴出处（见下文「功能」节）。

---

## 生态位置：一张 25 家插件的地图（调研结论）

写这个 README 之前，我们把这个市场（awesome-dsh-plugin，6,896 条）里全部 25 个 Antigravity 相关插件逐个查了一遍。先给你地形，再说我们在哪。

### 25 家分属 6 个技术维度

| 维度 | 家数 | 干什么 |
|---|---|---|
| **模型 provider 接入** | **12** | 把 Antigravity 额度变成 DSH 里可选的模型路由 ← **我们在这里** |
| 视觉/图像工具 | 4 | 借额度看图、画图 |
| 子代理委派 | 2 | agy 当一次性编码子代理（工具面，不是模型路由） |
| 会话数据 | 2 | 读 Antigravity 本地会话历史 |
| 工作流外围 | 2 | 外部 agent 控制面等 |
| 配额监控 | 1 | 多平台额度仪表盘 |

### 我们所在的维度里，12 家分三条路线

分界线只有两条本质问题：**凭据怎么碰、harness（工具执行/审批/上下文管理）归谁**。

| 路线 | 家数 | 代表 | 代价 |
|---|---|---|---|
| **OAuth 凭据提取直连** | 8 | dsh-antigravity-oauth、dsh-subscriptions、dsh-antigravity-auth | 自由度最高（多账号池、图像、搜索），但伪造客户端直连私有 RPC——`dsh-antigravity-oauth` 的描述自己写着 "carries account-ban risk" |
| **官方 CLI 委托（harness 归 CLI）** | 1 | dsh-agy-link（活跃） | 合规，但工具在 CLI 内部黑盒里跑，DSH 的审批/沙箱够不着 |
| **官方通道 + DSH 主导 harness** | 3 | **本插件**、dsh-agy-safe（停更）、dsh-antigravity-acp（活跃，走 ACP 协议） | 合规 + DSH 治理兼得，是 12 家里唯一对「harness 强弱」免疫的子格 |

### 这条线现在的真实格局

同格三家，截至 2026-10-26：**dsh-agy-safe 停更于 09-08**（npm 0.1.8 后无活动），**上游原版停更于 08-28**；`dsh-antigravity-acp` 活跃但已岔去 **ACP server 进程线**（见下）。也就是说——**「官方 CLI 委托 + DSH 主导」这条 CLI 战线，目前只剩本仓库一家在维护**。原版与 agy-safe 的存量用户（两者合计月下载约千级）面对的是停更插件与新宿主（0.2.0-rc.2）不兼容的现实。

### 三条第一性原理，本插件逐条这样满足

1. **完全安全合规**：不抽取任何 token、不伪造任何网络请求——所有上游流量由官方 `agy.exe` 二进制自己签名。凭据只在本机内存中流经（保活/配额面板读凭据管理器 blob 仅用于判过期与身份），不落日志、不进错误消息。
2. **原样享受官方账户额度**：消耗打在你自己的 Antigravity 套餐上，与官方客户端同池同规则。是否有客户端差异化的计费政策，无读数不宣称。
3. **DSH 的 harness 替代 AGY 的 harness**：AGY CLI 被剥离工具执行权，降维为纯模型推理端——工具调用意图在管道层被拦截，执行权 100% 收归 DSH 的 ToolRuntime，服从 DSH 的沙箱三档（read-only / workspace-write / danger-full-access）与审批规则。

## 与两个邻居的诚实对比

**vs `dsh-agy-safe`（同路线前辈，停更）**：同为 CLI 无头桥接 + 工具契约回传。它有一条我们敬佩的特色——历史指纹链（会话哈希检测上下文分叉后重放完整历史）；我们的 resume 走 conversation 绑定 + mismatch 自动重放，思路不同目标相同。它停更后无法跟进 DSH 0.2.0-rc.2；本仓库接续了这个生态位并完成两轮全源码安全审计（原型污染防线、MCP 桥面闸门、面板加固——详见 CHANGELOG 0.11.0/0.12.0）。

**vs `dsh-antigravity-acp`（活跃，最强同格竞品）**：架构同构（工具执行都归 DSH），**协议分岔**是本质差异——

| | 本插件（stream-json CLI 线） | dsh-antigravity-acp（ACP server 线） |
|---|---|---|
| 连接的进程 | 官方 `agy` CLI 本体（秒级冷启动） | 官方独立发布的 ACP server 进程（PyInstaller，冷启动实测约 52 秒，需预热设计） |
| 协议地位 | 闭源二进制的私有行协议，靠实测固化，官方改一行就要跟 | 公开标准协议（Agent Client Protocol），有规范有版本 |
| 工具边界的保证方式 | 协议不管工具，靠工程纪律事后收权（fail-closed 准入 + 桥面闸门 + 审计） | 协议天生剥夺——agent 只有「请求工具」的发言权，执行权写在规范里归 client |
| 依赖 | 只需本机 CLI 装好登录 | Node ≥ 22.19 + 下载维护 ACP server 进程 |

诚实说：它的工程完成度目前是标杆（设置页、额度药丸、连接预热、图片输入）。我们的差异化立足点是**轻**（秒级起轮、零额外下载、只依赖 CLI 登录态）与 CLI print 模式这条兼容面更宽的通道。两条线是协议分岔不是替代关系；若官方未来把 CLI 模式冻结，迁移到 ACP 线只需换传输层，harness 设计不变。

**差距清单（我们自己的短板，不藏着）**：对比 acp，我们没有对话旁的额度药丸、没有连接预热（worker 复用已有，冷启动预热未做）、图片走落盘桥而非真实像素传入；私有行协议存在上游漂移风险；工程面 320 例测试对它的 600+，数量不在一个量级（但我们的门禁把测试数锁进脚本，删一个用例会红）。**本轮已补**：历史指纹链（agy-safe 的特色，已按我们的结构实现并测试）。

## 功能（接续版增量）

- **双工具路线**：MCP 桥把 DSH 工具交给 AGY（真工具事件、过程流可视化，推荐），失败自动降级为 prompt 契约
- **DSH 主导 harness**：工作区、审批、沙箱、上下文预算全在 DSH；AGY 只出模型
- **流式 + 状态机**：`stdinMode: hold` 防回滚、思考链折叠、尾流交付、断连保文本
- **会话管理 + 历史指纹链**（指纹设计借自 dsh-agy-safe）：resume / full 双模式，每轮成功后记录 DSH 历史指纹；resume 前本地比对前缀，检出历史被编辑/压缩/截断即废弃旧会话并从完整历史重建，delta prompt 不会落在过期上下文上；死亡会话自动重放，会话映射落盘可迁移
- **图片输入**（experimental）：附件经图片桥落盘，由最小权限的 view_file Agent 查看——机制与 acp 的「真实像素传入」不同，但通道已存在
- **配额面板与凭据保活**：loopback-only；保活读凭据仅判过期，刷新由官方二进制自己完成
- **安全加固（0.11.0/0.12.0）**：原型污染防线、MCP 桥面闸门、面板 loopback 门与原子写、凭据脱敏补漏——全部有测试背书
- **路线图**（对比 acp 尚缺，按需补）：对话旁的额度药丸（需宿主 UI slot，当前配额在设置面板）、连接预热（`transport: persistent` 的 worker 复用已覆盖进程重用，冷启动预热未做）

## 安装

```console
dsh plugin --profile <你的 profile> add dsh-agy-cli
```

前置要求：本机已安装并登录官方 Antigravity CLI（`agy`）；Node ≥ 22。迁移自 `dsh-agy-provider` 或 `dsh-agy-safe`：模型路由 id 保持 `agy`，无需改模型配置；运行数据目录由 `~/.dsh/agy-link/` 变更为 `~/.dsh/agy-cli/`（旧的 runtime-overrides.json 可手动搬移）。

## 开发与门禁

```bash
npm ci --ignore-scripts
npm run typecheck
npm test    # tsc 全量 → 317 例 node --test
```

## 许可

MIT。原作品版权归 Darkings（darkings/dsh-agy-provider）所有，本接续版在同等许可证下延续并保留完整署名历史。
