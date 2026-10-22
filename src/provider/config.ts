import z from '@deepseek-ai/schemastery'
import { AGENT_PRESET_IDS, type AgentPresetId } from '../agent-presets.js'
import {
  DEFAULT_INPUT_FRAME_LIMIT_BYTES,
  DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES,
  DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES,
} from './prompt-budget.js'

export interface Config {
  /** Keep the bundle inert until explicitly enabled. */
  enabled?: boolean
  /** DSH provider route owned by this plugin. */
  provider?: string
  /** AGY model passed to the CLI when a request does not override it. */
  model?: string
  /** Explicit model catalog; legacy `model` remains the default/fallback entry. */
  models?: ModelConfig[]
  /** Visible models filter; empty means show all discovered models. */
  visibleModels?: string[]
  /** Discover additional models with `agy models`; `off` keeps static-only behavior. */
  modelDiscovery?: 'auto' | 'off'
  /** In-memory model discovery cache lifetime. */
  modelDiscoveryTtlMs?: number
  /** Timeout for the quota-free `agy models` command. */
  modelDiscoveryTimeoutMs?: number
  /** Ownership policy for DSH tool schemas; AGY remains the internal tool owner. */
  toolPolicy?: ToolPolicy
  /**
   * Expose DSH tools to AGY over MCP instead of serializing their schemas into
   * the prompt. The MCP path keeps the whole prompt budget for conversation
   * history, returns tool calls as real AGY tool events (so the intermediate
   * steps stay visible in the DSH transcript), and routes every execution
   * through the host tool pipeline. Requires the host `webServer` and `tools`
   * services; when either is missing the provider falls back to the prompt
   * contract so the route keeps working.
   */
  mcpBridge?: boolean
  /** Restrict the MCP tool projection to these DSH tool names; empty exposes all. */
  mcpToolAllowlist?: string[]
  /** AGY agent profile; must name a template installed under AGY's `agents/` directory. */
  agent?: string
  /** Optional bundled Agent capability profile; omitted preserves the configured agent. */
  agentPreset?: AgentPresetId
  /** @deprecated Use DSH session workspace; kept for legacy agy-owned compatibility. */
  workspaceRoot?: string
  /** Explicit AGY executable path; empty means discover from environment/PATH. */
  agyPath?: string
  /**
   * Backstop for one AGY child process: the ceiling on total wall time. Only a
   * process whose output *never stops* can reach it, because the idle watchdog
   * below decides every normal case. Omitted means no ceiling.
   */
  timeoutMs?: number
  /**
   * Inactivity budget for one AGY child process: killed when no stdout/stderr
   * line arrives for this long. Re-armed on every line, so a long reasoning
   * step or a long tool chain is never mistaken for a hang — this is the
   * instrument that actually fires. MUST stay below `timeoutMs`: both timers are
   * armed inside the same process, so a wall clock that expires first makes
   * this watchdog unreachable and every healthy long turn dies as `timeout`.
   */
  idleTimeoutMs?: number
  /**
   * How the request pipe is retired after AGY's user frame is written. `hold`
   * (default) keeps it open until AGY emits its closing `result` line, because
   * an immediate EOF is read as "no next turn": AGY shuts its store manager
   * down and cancels the turn it is still generating, which reaches the user as
   * text that appears and is then rolled back. `close` restores the historical
   * behaviour for callers that need the process to exit on EOF.
   */
  stdinMode?: 'hold' | 'close'
  /** `full` sends DSH history; `resume` reuses an AGY conversation. */
  sessionMode?: 'resume' | 'full'
  /**
   * Where the durable `DSH sessionId -> AGY conversationId` map lives, so
   * `sessionMode: resume` survives a host restart. Empty uses
   * `<DSH_HOME>/agy-provider/sessions.json`. A value ending in `.json` is a
   * file; anything else is a directory holding `sessions.json`.
   */
  sessionStorePath?: string
  /** Minimum AGY version accepted by the diagnostic command. */
  minimumAgyVersion?: string
  /** Maximum number of active AGY child processes per adapter instance. */
  maxConcurrent?: number
  /** Maximum number of AGY requests waiting for a process slot. */
  maxQueue?: number
  /** Maximum queue wait in milliseconds; `0` disables the queue timeout. */
  queueTimeoutMs?: number
  /** Maximum stdout/stderr bytes captured from one AGY process. */
  maxOutputBytes?: number
  /** Maximum length of one AGY stream-json line. */
  maxEventLineLength?: number
  /** Maximum UTF-8 bytes allowed for one encoded AGY stream-json input frame. */
  inputFrameLimitBytes?: number
  /** Maximum UTF-8 bytes retained for one serialized DSH tool result. */
  maxSingleToolResultBytes?: number
  /** Maximum UTF-8 bytes retained across serialized historical DSH tool results. */
  maxHistoricalToolResultBytes?: number
  /** Number of one-shot JSON-format repair attempts for DSH-owned tools. */
  toolProtocolRepairRetries?: number
  /** Safe final-message fallback after a failed JSON repair. */
  toolProtocolPlainTextFallback?: 'off' | 'final-message'
  /** Provider-owned bounded retry policy; omission follows DSH normal defaults. */
  retryPolicy?: AgyRetryPolicyConfig
  /** Optional model/Agent/effort overrides for DSH auxiliary call purposes. */
  purposeRoutes?: PurposeRoutesConfig
  /** Transport for AGY requests; 'one-shot' keeps 0.7.0 behavior, 'persistent' opt-in reuses one AGY stream-json worker per DSH session. */
  transport?: TransportMode
  /** Idle TTL for a persistent worker in ms; 0 closes immediately after a turn. */
  persistentIdleTtlMs?: number
  /** Ready timeout for persistent worker startup in ms. */
  persistentReadyTimeoutMs?: number
  /** Fallback policy when persistent cannot start: never or before-accept only. */
  persistentFallback?: PersistentFallbackMode
  /**
   * How often the plugin checks AGY's keyring token, in ms; `0` disables the
   * check. The check is a Credential Manager read, and starting agy.exe only
   * happens on the tick inside `tokenKeepaliveLeadMs` before the expiry — AGY
   * ignores a token it still considers valid, so a wide window would just spin
   * the process for nothing. Keep this well under the lead: 60 s interval with a
   * 60 s lead gives several chances to fire before the credential dies.
   */
  tokenKeepaliveMs?: number
  /**
   * The token is renewed once it has less life than this. AGY itself only
   * rotates an EXPIRED token, so this is really "fire on the last tick before
   * the moment it lapses" — see `src/agy/keepalive.ts`.
   */
  tokenKeepaliveLeadMs?: number
  /**
   * Working directory handed to the renewal run. agy itself only reads the
   * keyring/network during a wake-up turn, so any existing directory works; the
   * plugin cannot assume the host process has a usable one, and the host's cwd
   * is not guaranteed to exist (a removed workspace directory makes Node's
   * spawn fail with a bare ENOENT that reads like a missing executable).
   * Defaults to the user profile directory.
   */
  tokenKeepaliveCwd?: string
  /** AttachmentStore-to-AGY image bridge; omitted/off preserves text-only behavior. */
  imageInput?: 'off' | 'experimental'
  /** Deterministic response used only by the M1 mock route. */
  response?: string
  /** Optional delay used only by the M1 mock route. */
  delayMs?: number
}

export type ToolPolicy = 'reject' | 'agy-owned' | 'dsh-owned'
export type TransportMode = 'one-shot' | 'persistent'
export type PersistentFallbackMode = 'never' | 'before-accept'

// Keep the default route policy aligned with @deepseek-ai/dsh-llm.
// The DSH retry executor owns the retry loop; this list only declares which
// stable provider failures are eligible for that executor.
//
// AGY_INPUT_FAILED and AGY_SPAWN_FAILED are transient on this host: the AGY
// binary runs its own eligibility check (loadCodeAssist) against Google before
// it accepts any stream-json input, and that call is intermittently reset when
// it goes through the local HTTP proxy. AGY then exits 1-2s after start, so our
// write to the child's stdin lands on a closed pipe and surfaces as "Unable to
// write AGY stream-json input (Error:EOF stage=stdin)" — observed verbatim at
// 2026-10-13 15:02 and reproduced with an 184 KB frame. Nothing about the
// request is wrong, so one more attempt genuinely fixes it. AGY_INPUT_TOO_LARGE
// is deliberately absent: a frame above the configured limit never shrinks on
// its own, and retrying it only burns quota.
export const AGY_RETRYABLE_CODES = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'AGY_INPUT_FAILED',
  'AGY_SPAWN_FAILED',
] as const
export type AgyRetryableCode = typeof AGY_RETRYABLE_CODES[number]

export interface AgyRetryPolicyConfig {
  /** Eligible retries after the first AGY process; hard capped at DSH's default of 5. */
  maxRetries?: number
  /** Stable transient codes allowed to consume another AGY attempt. */
  retryableCodes?: AgyRetryableCode[]
}

export type AgyReasoningEffortConfig = 'low' | 'medium' | 'high'

export interface PurposeRouteConfig {
  /** Optional model override for this auxiliary call purpose. */
  model?: string
  /** Optional AGY Agent override for this auxiliary call purpose. */
  agent?: string
  /** Optional AGY reasoning effort override for this auxiliary call purpose. */
  reasoningEffort?: AgyReasoningEffortConfig
}

export interface PurposeRoutesConfig {
  compaction?: PurposeRouteConfig
  sessionTitle?: PurposeRouteConfig
}

export interface ModelConfig {
  /** Exact model id passed to AGY. */
  id: string
  /** Optional selector label; defaults to `id`. */
  name?: string
  /** Optional selector description. */
  description?: string
  /** Optional provider-declared combined context capacity. */
  contextWindow?: number
}

export const DEFAULT_MODEL = 'gemini-3.1-pro'

/**
 * The AGY agent profile used when the config does not name one.
 *
 * This must be a template that ships with this package and is installed under
 * AGY's `agents/` directory: AGY rejects an unknown profile outright, before it
 * accepts any input, with `exit 1` and
 * `error: unknown agent "<name>" (available: ...)`. The host sees that as an
 * early process death and reports it as a stdin failure, so a name that is not
 * installable turns into a misleading error far from the cause.
 *
 * It used to be `deepseek-proxy`, an agent that exists only in the upstream
 * author's own environment; every fresh install therefore failed out of the box.
 */
export const DEFAULT_AGENT = 'dsh-agy-mcp-executor'

const ModelConfig = z.object({
  id: z.string().pattern(/^\S(?:.*\S)?$/).required(),
  name: z.string().pattern(/^\S(?:.*\S)?$/),
  // Kept for YAML/API compatibility; the selector intentionally does not render it.
  description: z.string().hidden(),
  contextWindow: z.natural().min(1).max(10_000_000),
}) as unknown as z<ModelConfig>

const RetryPolicyConfig = z.object({
  maxRetries: z.natural().max(5).default(5),
  // Deliberately open-ended: the allowlist must be able to grow (AGY_INPUT_FAILED
  // and AGY_SPAWN_FAILED were added on 2026-10-13) without rejecting every profile
  // that was written against the previous list. Anything not in AGY_RETRYABLE_CODES
  // is dropped by resolveAgyRetryPolicy with a process warning.
  retryableCodes: z.array(z.string().pattern(/^[A-Z][A-Z0-9_]*$/)).min(1).default([...AGY_RETRYABLE_CODES]),
}) as unknown as z<AgyRetryPolicyConfig>

const PurposeRoute = z.object({
  model: z.string().pattern(/^\S(?:.*\S)?$/),
  agent: z.string().pattern(/^\S(?:.*\S)?$/),
  reasoningEffort: z.union(['low', 'medium', 'high'] as const),
}) as unknown as z<PurposeRouteConfig>

const PurposeRoutes = z.object({
  compaction: PurposeRoute,
  sessionTitle: PurposeRoute,
}) as unknown as z<PurposeRoutesConfig>

export function createConfigSchema(defaults: {
  enabled?: boolean
  toolPolicy?: ToolPolicy
} = {}): z<Config> {
  const defaultEnabled = defaults.enabled ?? false
  const defaultToolPolicy = defaults.toolPolicy ?? 'reject'

  const schemaBase = z.object({
    enabled: z.boolean().default(defaultEnabled).description('Enable AGY provider'),
    // The route is fixed by this plugin and is not a user-facing setting.
    provider: z.string().default('agy').description('Provider route id').hidden(),
    model: z.string().default(DEFAULT_MODEL).description('Default model id (base, without -high/-medium/-low suffix)'),
    // Explicit catalogs are an advanced YAML escape hatch; the normal UI uses discovery.
    models: z.array(ModelConfig).default([]).description('Explicit model catalog; entries are base ids').hidden(),
    visibleModels: z.array(z.string().pattern(/^\S(?:.*\S)?$/)).default([]).description('Visible models filter; empty shows all discovered models, non-empty only shows checked base ids'),
    modelDiscovery: z.union(['auto', 'off'] as const).default('auto').description('Discover models via agy models'),
    modelDiscoveryTtlMs: z.number().min(1_000).max(3_600_000).default(300_000).description('Discovery cache TTL ms').hidden(),
    modelDiscoveryTimeoutMs: z.number().min(100).max(30_000).default(10_000).description('Discovery timeout ms').hidden(),
    toolPolicy: z.union(['reject', 'agy-owned', 'dsh-owned'] as const).default(defaultToolPolicy).description('Tool ownership policy'),
    mcpBridge: z.boolean().default(true).description('Expose DSH tools to AGY over MCP instead of embedding their schemas in the prompt'),
    mcpToolAllowlist: z.array(z.string().pattern(/^\S(?:.*\S)?$/)).default([]).description('MCP tool projection allowlist; empty exposes every DSH tool'),
    agent: z.string().default(DEFAULT_AGENT).description('AGY agent profile'),
    agentPreset: z.union(AGENT_PRESET_IDS).description('Optional agent preset'),
    workspaceRoot: z.string().pattern(/^\S(?:.*\S)?$/).description('Deprecated: use DSH session workspace').deprecated().hidden(),
    agyPath: z.string().default('').description('AGY executable path').hidden(),
    timeoutMs: z.number().min(1).max(3_600_000).default(900_000).description('Backstop wall clock per request ms; only an endless-output run can reach it').hidden(),
    idleTimeoutMs: z.number().min(1).max(3_600_000).default(300_000).description('Inactivity budget per request ms; re-armed on every output line. Must stay below timeoutMs').hidden(),
    stdinMode: z.union(['hold', 'close'] as const).default('hold').description('Keep the request pipe open until AGY closes the turn (hold) or end it as soon as the frame is written (close)').hidden(),
    sessionMode: z.union(['resume', 'full'] as const).default('full').description('Session mode'),
    sessionStorePath: z.string().default('').description('Durable sessionId to conversationId map path; empty uses DSH_HOME/agy-provider/sessions.json'),
    minimumAgyVersion: z.string().pattern(/^\d+\.\d+\.\d+$/).default('1.1.15').description('Minimum AGY version').hidden(),
    maxConcurrent: z.natural().min(1).max(64).default(4).description('Max concurrent AGY processes').hidden(),
    maxQueue: z.natural().max(256).default(32).description('Max queue length').hidden(),
    queueTimeoutMs: z.natural().max(3_600_000).default(30_000).description('Queue timeout ms').hidden(),
    transport: z.union(['one-shot', 'persistent'] as const).default('one-shot').description('Transport mode').hidden(),
    persistentIdleTtlMs: z.number().min(0).max(3_600_000).default(30_000).description('Persistent idle TTL ms').hidden(),
    persistentReadyTimeoutMs: z.number().min(1).max(60_000).default(10_000).description('Persistent ready timeout ms').hidden(),
    persistentFallback: z.union(['never', 'before-accept'] as const).default('before-accept').description('Persistent fallback policy').hidden(),
    maxOutputBytes: z.natural().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024).description('Max output bytes').hidden(),
    maxEventLineLength: z.natural().min(1_024).max(8 * 1024 * 1024).default(1_048_576).description('Max event line length').hidden(),
    inputFrameLimitBytes: z.natural().min(128).max(16 * 1024 * 1024).default(DEFAULT_INPUT_FRAME_LIMIT_BYTES).description('AGY input frame limit bytes').hidden(),
    maxSingleToolResultBytes: z.natural().min(1_024).max(512 * 1024).default(DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES).description('Maximum serialized tool result bytes').hidden(),
    maxHistoricalToolResultBytes: z.natural().min(1_024).max(2 * 1024 * 1024).default(DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES).description('Maximum historical tool result bytes').hidden(),
    toolProtocolRepairRetries: z.natural().max(1).default(1).description('Structured tool protocol repair retries').hidden(),
    toolProtocolPlainTextFallback: z.union(['off', 'final-message'] as const).default('final-message').description('Plain text fallback after structured protocol repair').hidden(),
    retryPolicy: RetryPolicyConfig.default({
      maxRetries: 5,
      retryableCodes: [...AGY_RETRYABLE_CODES],
    }).hidden(),
    purposeRoutes: PurposeRoutes.description('Purpose-specific overrides').hidden(),
    // Default lead equals the default interval on purpose: agy only rotates a
    // token it already considers expired, so there is no benefit to a wide
    // window — it would just restart agy.exe on every tick without effect.
    tokenKeepaliveMs: z.number().min(0).max(3_600_000).default(60_000).description('Keyring token keep-alive check interval ms; 0 disables it').hidden(),
    tokenKeepaliveLeadMs: z.number().min(0).max(3_600_000).default(60_000).description('Renew the keyring token once it has less life than this ms').hidden(),
    tokenKeepaliveCwd: z.string().description('Working directory for the renewal run; defaults to the user profile directory').hidden(),
    imageInput: z.union(['off', 'experimental'] as const).description('Image input mode'),
    response: z.string().default('AGY mock provider is ready.').description('Mock response').hidden(),
    delayMs: z.number().min(0).max(60_000).default(0).description('Mock delay ms').hidden(),
  })

  const schema = (z as any).transform(schemaBase, (data: any) => ({
    ...data,
    model: typeof data.model === 'string' ? (data.model as string).replace(/-(?:low|medium|high)$/i, '') : data.model,
    models: Array.isArray(data.models) ? (data.models as any[]).map((m: any) => ({ ...m, id: typeof m.id === 'string' ? (m.id as string).replace(/-(?:low|medium|high)$/i, '') : m.id })) : data.models,
    visibleModels: Array.isArray(data.visibleModels) ? (data.visibleModels as any[]).map((v: any) => typeof v === 'string' ? (v as string).replace(/-(?:low|medium|high)$/i, '') : v) : data.visibleModels,
  }))
  const localized = (schema as any).i18n({
    'zh-CN': {
      enabled: { $description: '是否启用 AGY 提供方' },
      provider: { $description: '提供方路由 ID（固定为 agy）' },
      model: { $description: '默认模型 ID（基础名称，不含 -high/-medium/-low 后缀，推理强度另选）' },
      models: { $description: '显式模型目录；条目为基础 ID，可覆盖名称与上下文窗口' },
      visibleModels: { $description: '可见模型过滤；为空时显示全部发现模型，非空时仅显示勾选的基础 ID' },
      modelDiscovery: { $description: '是否通过 agy models 自动发现模型' },
      modelDiscoveryTtlMs: { $description: '模型发现缓存时间（毫秒）' },
      modelDiscoveryTimeoutMs: { $description: '模型发现超时（毫秒）' },
      toolPolicy: { $description: '工具所有权：reject=拒绝 DSH 工具, agy-owned=旧版 AGY 执行, dsh-owned=推荐 DSH 执行' },
      mcpBridge: { $description: '通过 MCP 把 DSH 工具交给 AGY（推荐）；关闭则退回把工具 schema 写进提示词的旧方式' },
      mcpToolAllowlist: { $description: 'MCP 工具白名单；为空时暴露全部 DSH 工具' },
      agent: { $description: 'AGY 代理名称，须为已安装的模板（如 dsh-agy-mcp-executor）' },
      agentPreset: { $description: '代理能力预设' },
      workspaceRoot: { $description: '已废弃：请使用 DSH 会话的项目目录，无需手动配置' },
      agyPath: { $description: 'AGY 可执行文件路径，空则自动发现' },
      timeoutMs: { $description: '单次请求的墙上时钟上限（毫秒）' },
      idleTimeoutMs: { $description: '单次请求的无输出静默预算（毫秒）；每有一行输出即重新计时' },
      stdinMode: { $description: '请求管道收尾方式：hold=等 AGY 自己结束本轮再关（默认，避免中途无输出被判死）, close=写完即关' },
      sessionMode: { $description: '会话模式：full=每轮完整历史, resume=复用 AGY 会话' },
      sessionStorePath: { $description: '会话映射（DSH 会话→AGY 对话）的落盘路径；留空用 DSH_HOME/agy-provider/sessions.json，让 resume 模式在宿主重启后仍能续话' },
      minimumAgyVersion: { $description: '最低允许的 AGY 版本' },
      maxConcurrent: { $description: '最大并发 AGY 进程数' },
      maxQueue: { $description: '最大排队长度' },
      queueTimeoutMs: { $description: '排队超时（毫秒）' },
      transport: { $description: '传输模式：one-shot=每请求新进程, persistent=同会话复用 worker' },
      persistentIdleTtlMs: { $description: '持久 worker 空闲回收时间（毫秒）' },
      persistentReadyTimeoutMs: { $description: '持久 worker 就绪超时（毫秒）' },
      persistentFallback: { $description: '持久失败回退策略' },
      maxOutputBytes: { $description: '单次 AGY 输出最大字节' },
      maxEventLineLength: { $description: '单行事件最大长度' },
      inputFrameLimitBytes: { $description: 'AGY 单次输入帧上限（字节）；超长工具结果会先裁剪' },
      maxSingleToolResultBytes: { $description: '单个历史工具结果保留上限（字节）' },
      maxHistoricalToolResultBytes: { $description: '所有历史工具结果合计保留上限（字节）' },
      toolProtocolRepairRetries: { $description: 'DSH 工具协议返回非 JSON 时的修复重试次数' },
      toolProtocolPlainTextFallback: { $description: '修复仍失败时是否将普通文本安全降级为最终消息' },
      purposeRoutes: { $description: '按用途（压缩/标题）的模型覆盖' },
      tokenKeepaliveMs: { $description: '凭据保活检查间隔（毫秒，默认 60 秒）；0 表示关闭。到期前一个周期内才真正启动 agy 续期' },
      tokenKeepaliveLeadMs: { $description: '凭据剩余有效期低于该毫秒数时自动续期（默认 60 秒）' },
      imageInput: { $description: '图片输入：off=关闭, experimental=通过最小 view_file Agent 处理附件' },
    },
    en: {
      enabled: { $description: 'Enable AGY provider' },
      provider: { $description: 'Provider route id (always agy)' },
      model: { $description: 'Default base model id (without -high/-medium/-low suffix; effort selected separately)' },
      models: { $description: 'Explicit model catalog; entries are base ids' },
      visibleModels: { $description: 'Visible models filter; empty shows all discovered base models, non-empty only shows checked ids' },
      modelDiscovery: { $description: 'Auto-discover models via agy models' },
      modelDiscoveryTtlMs: { $description: 'Discovery cache TTL (ms)' },
      modelDiscoveryTimeoutMs: { $description: 'Discovery timeout (ms)' },
      toolPolicy: { $description: 'Tool ownership: reject, agy-owned (legacy), dsh-owned (recommended)' },
      agent: { $description: 'AGY agent profile; must be an installed template (e.g. dsh-agy-mcp-executor)' },
      agentPreset: { $description: 'Agent capability preset' },
      workspaceRoot: { $description: 'Deprecated: uses DSH session workspace, no manual path needed' },
      agyPath: { $description: 'AGY executable path, empty auto-discovers' },
      timeoutMs: { $description: 'Per-request wall-clock ceiling (ms)' },
      idleTimeoutMs: { $description: 'Per-request inactivity budget (ms); re-armed on every output line' },
      stdinMode: { $description: 'How the request pipe is retired: hold=wait for AGY to finish the turn (default), close=end right after the frame is written' },
      sessionMode: { $description: 'Session mode: full or resume' },
      sessionStorePath: { $description: 'Path of the durable DSH session to AGY conversation map; empty uses DSH_HOME/agy-provider/sessions.json so resume keeps working after a host restart' },
      minimumAgyVersion: { $description: 'Minimum AGY version' },
      maxConcurrent: { $description: 'Max concurrent AGY processes' },
      maxQueue: { $description: 'Max queue length' },
      queueTimeoutMs: { $description: 'Queue timeout (ms)' },
      transport: { $description: 'Transport: one-shot or persistent' },
      persistentIdleTtlMs: { $description: 'Persistent idle TTL (ms)' },
      persistentReadyTimeoutMs: { $description: 'Persistent ready timeout (ms)' },
      persistentFallback: { $description: 'Persistent fallback policy' },
      maxOutputBytes: { $description: 'Max output bytes per AGY process' },
      maxEventLineLength: { $description: 'Max event line length' },
      inputFrameLimitBytes: { $description: 'AGY input frame limit in bytes; oversized tool results are compacted first' },
      maxSingleToolResultBytes: { $description: 'Maximum retained bytes for one historical tool result' },
      maxHistoricalToolResultBytes: { $description: 'Maximum combined retained bytes for historical tool results' },
      toolProtocolRepairRetries: { $description: 'Repair retries when a DSH tool response is not JSON' },
      toolProtocolPlainTextFallback: { $description: 'Safely treat plain text as a final message after repair' },
      purposeRoutes: { $description: 'Purpose-specific model overrides' },
      tokenKeepaliveMs: { $description: 'Keyring token keep-alive check interval (ms, default 60 s); 0 disables it. agy is only started on the tick inside the lead' },
      tokenKeepaliveLeadMs: { $description: 'Renew the keyring token once it has less than this many ms of life left (default 60 s)' },
      imageInput: { $description: 'Image input: off, or experimental through the minimal view_file Agent' },
    },
  })
  return localized
    .comment('其余字段在 cordis.patch.yml 中，请直接编辑对应段。 (dsh-agy-provider)') as unknown as z<Config>
}

/** Programmatic library default: enabled=false, toolPolicy=reject */
export const Config: z<Config> = createConfigSchema({ enabled: false, toolPolicy: 'reject' })

/** Bundle default for DSH profile plugin add: enabled=true, DSH owns tools. */
export const BundleConfig: z<Config> = createConfigSchema({ enabled: true, toolPolicy: 'dsh-owned' })

/**
 * Resolve the effective catalog while keeping the 0.1.0 `model` setting
 * compatible. Catalog membership is advisory; unknown exact model ids remain
 * valid request targets and are handled by each adapter's resolveModel().
 */
export function configuredModels(config: Pick<Config, 'model' | 'models'> = {}): readonly ModelConfig[] {
  const fallbackId = config.model?.trim() || DEFAULT_MODEL
  const entries = config.models !== undefined && config.models.length > 0
    ? config.models
    : [{ id: fallbackId }]
  const catalog: ModelConfig[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = entry.id.trim()
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    catalog.push({ ...entry, id })
  }
  if (!seen.has(fallbackId)) catalog.push({ id: fallbackId })
  return catalog
}

/** Normalize a possibly suffixed model id to its base (strip -low/-medium/-high). */
export function normalizeModelId(id: string): string {
  return id.replace(/-(?:low|medium|high)$/i, '')
}

/** Extract effort suffix from a model id, if present. */
export function extractModelEffort(id: string): 'low' | 'medium' | 'high' | undefined {
  const m = /-(low|medium|high)$/i.exec(id)
  if (!m || !m[1]) return undefined
  return m[1].toLowerCase() as 'low' | 'medium' | 'high'
}

/** Filter catalog by visibleModels (empty = all). */
export function filterVisibleModels(models: readonly ModelConfig[], visibleModels: readonly string[] | undefined): readonly ModelConfig[] {
  if (visibleModels === undefined || visibleModels.length === 0) return models
  const allow = new Set(visibleModels.map(normalizeModelId))
  return models.filter(m => allow.has(normalizeModelId(m.id)))
}
