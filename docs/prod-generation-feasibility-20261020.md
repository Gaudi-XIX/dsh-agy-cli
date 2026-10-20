# prod 生成可用性与 429 重试有效性实测（2026-10-20）

**调研时间**：2026-10-20 10:40–10:52 东八区。身份：Windows 凭据管理器 `gemini:antigravity` 的 OAuth token（先跑 `agy.exe -p` 刷新过期 token），完整 CLI 身份头 `User-Agent: antigravity/cli/1.4.2 (aidev_client; os_type=windows; arch=amd64; auth_method=consumer)`。代理 `127.0.0.1:12450`。请求形状照抄 chaos-03x `dsh-agy` 的 `toAgyRequestBody`（project/requestId/model/userAgent/requestType/request.contents/generationConfig）。

## 结论

1. **prod 生成接口对 consumer 账号实测不可用**：`https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent` 连续 4 次全部 HTTP 429 `Resource has been exhausted (e.g. check quota)`，响应无模型名、无 `quotaResetTimeStamp`、无重置延迟元数据——不是「额度满但可消费」的账本，是 consumer 账号在 prod 上根本得不到生成配额。**「自己拼 HTTP 打 prod 拿满额度」这条路实测关闭。**
2. **daily 生成间歇成功，失败是额度边界抖动**：同一请求形状打 `daily-cloudcode-pa.googleapis.com`，12 次中 6 次 200、6 次 429（429 带 `quotaResetTimeStamp: 2026-10-23T22:00:21Z`，与官方 `/usage` 的 Gemini Models Weekly reset 完全一致）。加不加 `X-Goog-Api-Client` 身份头不影响结果（各 3/6）。
3. **429 重试有效**：5 轮「重试至多 6 次」全部在第 1–3 次内成功（成功率 5/5）；单次成功率仅 1/5。即在额度边界，重试能救回 80%+ 的轮次。
4. 成功响应的 `modelVersion` 是 `gemini-3.8-flash-n`；`text` 常为空是因为 `maxOutputTokens: 32` 被思考 token 吃光（`finishReason: MAX_TOKENS`），不是异常。

## 实测表

| 端点 | 请求 | 结果 | 429 元数据 |
|---|---|---|---|
| daily | gemini-3.8-flash-high | 6/12 成功 | `reason: QUOTA_EXHAUSTED`，`quotaResetTimeStamp: 2026-10-23T22:00:21Z`（=官方 /usage weekly 锚点）|
| daily | gemini-3.8-flash（未解析） | 404 `Requested entity was not found` | —（CLI 侧必须解析 alias，wire 上要用 `-high`）|
| prod | gemini-3.8-flash-high | 0/4 成功 | 无模型名、无重置时间戳，纯 `Resource has been exhausted` |
| daily+`X-Goog-Api-Client` | gemini-3.8-flash-high | 3/6 成功 | 同 daily 无头版本 |

## 对 provider 修复的启示

- **面板额度读数的正确修复方向**：读 daily 端点 + 完整 CLI 身份头（简陋 UA 会被裁剪 Gemini 组），而不是 prod。prod 恒满（gemini rf=1）且生成恒 429，是空账本；daily 才有真实消耗与固定重置锚点。
- **429 处理**：当前 `classifyAgyFailure` 把 `Individual quota reached…429` 判成 `QUOTA_EXCEEDED`（fail-closed 不重试）。实测额度边界时重试能救回轮次，建议在 spawn 路径对 QUOTA_EXCEEDED 也做有限重试（≤3 次），与 AGY 自标 `retryable: true` 对齐。
- **不需要换引擎**：「自拼 HTTP 切端点」的收益只剩重试（prod 不可用），而重试可以在现有 spawn 路径实现，无需重写翻译层/SSE 解析。

## 补充实测（11:53）：官方开关 `CLOUD_CODE_URL` 确实能把 agy 切到 prod —— 但生成仍然全灭

此前「agy.exe 硬编码 daily、自身不能切端点」的结论**是测错了变量**（我试的是 `AGY_LLM_GATEWAY_URL` / `GOOGLE_GEMINI_BASE_URL` / `ANTIGRAVITY_MULTICALL_DESTINATION`）。二进制里真正的开关是：

```
[CLIAuthProvider] UpdateEndpointURL called with CLOUD_CODE_URL: %q
[CLIAuthProvider] UpdateEndpointURL: preserving custom endpoint %q
```

实测 `CLOUD_CODE_URL=https://cloudcode-pa.googleapis.com` + `agy -p … --model gemini-3.8-flash`：

- 日志 `cli-20261020_115313.log` 首行 `Overriding CloudCodeServerURL via CLOUD_CODE_URL environment variable` ⇒ 覆盖**生效**；
- 该轮 `loadCodeAssist` / `fetchAvailableModels` / `streamGenerateContent` **全部打到 prod**；
- `run.go:395` attempt 1–8 **全部 429** `Resource has been exhausted`（attempt 8 是一次 EOF 传输错误），约 2 分钟后 `session.go:273` 报错退出，exit 3。

⇒ **这是定论级证据：prod 那份「Gemini 100%」额度对 consumer 账号不是可用的免费额度，而是不记账的合成视图**（社区 ≥4 源同结论：prod `gemini-5h` 恒 remainingFraction=1、resetTime 恒 = now+5h，见 `prod-endpoint-research.md` §Q5）。用官方开关把流量切过去消费，得到的是 8/8 失败。

## 探针脚本（tmp/20261020-agy-quota/，用后自清）

`probe_gen_chaos_shape.mjs` / `probe_diff_shape.mjs` / `probe_ab_repeat.mjs` / `probe_retry_efficacy.mjs` 及各自 `.out.txt`、`agy_refresh.out.txt`。