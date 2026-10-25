import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, parse as parsePath, relative, resolve } from 'node:path'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  resolveRetryPolicy,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  RequestMessage,
  LlmModelInfo,
  LlmProviderInfo,
  ReasoningEffortId,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
  ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import {
  ExperimentalAgyTransport,
  PersistentTransportError,
  type PersistentTransportResult,
} from '../agy/persistent-transport.js'
import {
  AgyProcessError,
  agyProcessDiagnosticOf,
  isAgyReasoningEffort,
  runAgyProcess,
  type AgyExecutionMode,
  type AgyReasoningEffort,
  type AgyRequest,
  type AgyStdinMode,
  type ProcessResult,
} from '../agy/process.js'
import { getAgentPreset, type AgentPresetId } from '../agent-presets.js'
import {
  AgyModelDiscovery,
  type AgyModelDiscoveryCommand,
  type AgyModelDiscoveryResult,
} from '../agy/models.js'
import { diagnoseAgy, type AgyDiagnosticResult } from '../agy/diagnostics.js'
import { AgyConcurrencyLimiter, AgyQueueError } from '../agy/limiter.js'
import {
  buildAgyLogRecord,
  emitAgyLog,
  type AgyBridgeOutcome,
  type AgyCarrierValidation,
  type AgyLogger,
  type AgyProtocolFailureDetail,
  type AgyProtocolResponseShape,
  type AgyTelemetry,
  type AgyUsageSource,
} from '../agy/log.js'
import { classifyAgyFailure, safeAgyFailureMessage } from '../agy/errors.js'
import { readAgyRuntimeOverrides } from '../agy/overrides.js'
import {
  AgyParserError,
  AgyStreamParser,
  conversationIdOf,
  emptyAgyEventCategoryCounts,
  errorDetailOf,
  eventCategoryOf,
  finalResultRawOf,
  isToolEvent,
  isDshCarrierRecipient,
  isPermissionEvent,
  responseOf,
  sendMessageOf,
  statusOf,
  stepTypeOf,
  textDeltaOf,
  toolEventDiagnosticOf,
  toolEventKindOf,
  toolNameOf,
  usageOf,
  type AgyJsonEvent,
} from '../agy/parser.js'
import { resolveAgyExecutable } from '../agy/process.js'
import {
  AGY_RETRYABLE_CODES,
  configuredModels,
  DEFAULT_AGENT,
  DEFAULT_MODEL,
  extractModelEffort,
  filterVisibleModels,
  normalizeModelId,
  type AgyRetryableCode,
  type AgyRetryPolicyConfig,
  type Config,
  type ModelConfig,
  type PurposeRouteConfig,
  type PurposeRoutesConfig,
  type PersistentFallbackMode,
  type ToolPolicy,
  type TransportMode,
} from './config.js'
import {
  AGY_INTERNAL_TOOL_EVENT_CODE,
  DSH_CONTEXT_UNAVAILABLE_CODE,
  PERMISSION_REQUIRED_CODE,
  UNSUPPORTED_REASONING_EFFORT_CODE,
  UNSUPPORTED_TOOLS_CODE,
} from './error-codes.js'
import { SessionRegistry, type SessionFingerprint, type SessionRecord } from '../session/store.js'
import { AgyPromptError, serializeAgyPrompt, serializeAgyTurnPrompt } from './serialize.js'
import {
  appendToolProtocolPrompt,
  appendToolProtocolRepairPrompt,
  createStructuredToolProtocol,
  parseStructuredEnvelope,
  TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE,
  TOOL_PROTOCOL_RESPONSE_LIMIT_CODE,
  ToolProtocolError,
  TOOL_PROTOCOL_RESPONSE_INVALID_CODE,
  TOOL_PROTOCOL_UNKNOWN_TOOL_CODE,
  type ParseStructuredEnvelopeOptions,
  type ToolProtocolArgumentDiagnostic,
  type ToolProtocolRepairReason,
  type StructuredToolProtocol,
} from './tool-protocol.js'
import {
  AgyPromptBudgetError,
  boundAgyPrompt,
  DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES,
  DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES,
  DEFAULT_INPUT_FRAME_LIMIT_BYTES,
  DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES,
  DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES,
  stableAgyPromptPrefix,
} from './prompt-budget.js'
import {
  AgyImageBridgeError,
  prepareAgyPrompts,
  type AgyImageAttachmentStore,
  type PreparedAgyPrompts,
} from './image-bridge.js'
import {
  DshContextError,
  resolveDshContext,
  type DshContextLookup,
  type DshContextSnapshot,
} from '../dsh/context.js'

export type AgyProcessRunner = (request: AgyRequest) => Promise<ProcessResult>

export interface AgyAdapterDependencies {
  /** Injectable seam for deterministic tests; production uses `runAgyProcess`. */
  runAgyProcess?: AgyProcessRunner
  /** Injectable quota-free `agy models` command for deterministic tests. */
  runModelDiscovery?: AgyModelDiscoveryCommand
  /** Injectable session mapping; production uses the durable file-backed store. */
  sessionRegistry?: SessionRegistry
  /** Optional structured logger; logging failures never affect the request. */
  logger?: AgyLogger
  /** Injectable process limiter for deterministic concurrency tests. */
  concurrencyLimiter?: AgyConcurrencyLimiter
  /** Optional DSH AttachmentStore; text-only requests do not require it. */
  attachmentStore?: Pick<AttachmentStore, 'readImage'>
  /** Lazy resolver for runtimes that compose the optional store after this plugin. */
  resolveAttachmentStore?: () => Pick<AttachmentStore, 'readImage'> | undefined
  /**
   * Injectable seam for deterministic tests of the persistent path; production
   * leaves it undefined and the transport is built from the resolved AGY
   * executable.
   */
  persistentTransport?: PersistentTransportLike
  /** Optional Cordis reflection seam for the DSH-owned capability context. */
  dshContext?: DshContextLookup
  /**
   * Resolves the live MCP tool bridge, if the composition has one. Lazy
   * because the bridge is mounted on the host webServer and its fiber may
   * start after this adapter is constructed.
   */
  resolveToolBridge?: () => DshToolBridgeHandle | undefined
}

/**
 * The slice of the persistent transport the adapter needs. Declared
 * structurally so tests can drive the streaming path without a real AGY
 * worker process.
 */
export interface PersistentTransportLike {
  request(input: {
    readonly sessionId: string
    readonly text: string
    readonly signal?: AbortSignal
    readonly timeoutMs?: number
    readonly idleTimeoutMs?: number
    readonly maxOutputBytes?: number
    readonly onEvent?: (payload: unknown) => void
    readonly agent?: string
    readonly model?: string
    readonly reasoningEffort?: AgyReasoningEffort
    readonly conversation?: string
    readonly extraArgs?: readonly string[]
  }): Promise<PersistentTransportResult>
}

/**
 * The slice of the MCP tool bridge the adapter needs. Declared structurally so
 * the provider never imports the bridge module's host-service types.
 */
export interface DshToolBridgeHandle {
  readonly active: boolean
  readonly inactiveReason: string | undefined
  /** Point the bridge at the DSH session owning the next AGY turn. */
  readonly setSession: (sessionId: string) => void
  /** URL AGY reaches the bridge on; undefined until the bridge is live. */
  readonly url: string | undefined
}

interface AttemptOutcome {
  retryWithFullPrompt: boolean
}

interface EffectiveAgyRoute {
  model: string
  agent: string
  reasoningEffort: AgyReasoningEffort | undefined
}

interface AgyAgentRuntime {
  agent: string
  agentPreset: AgentPresetId | undefined
  agentCanViewFile: boolean
  workspaceRoot: string | undefined
  addDirs: readonly string[] | undefined
  mode: AgyExecutionMode | undefined
  disableSlashCommands: boolean | undefined
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<T>) => void
    reject: (error: unknown) => void
  }> = []
  private closed = false
  private failure: unknown

  push(value: T): void {
    if (this.closed) return
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.values.push(value)
    else waiter.resolve({ done: false, value })
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined })
    }
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.closed = true
    this.failure = error
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error)
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ done: false, value })
    if (this.failure !== undefined) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve({ done: true, value: undefined })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

const DEFAULT_MINIMUM_AGY_VERSION = '1.1.15'
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_QUEUE = 32
const DEFAULT_QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_EVENT_LINE_LENGTH = 1_048_576
const IMAGE_TOOL_PATH_KEYS = new Set(['AbsolutePath', 'absolutePath', 'path', 'file_path', 'filePath'])
const IMAGE_TOOL_JSON_KEYS = new Set(['args', 'arguments', 'input', 'parameters', 'tool_input', 'toolInput'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unwrapToolPath(value: string): string {
  let current = value.trim()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(current.startsWith('"') && current.endsWith('"'))) break
    try {
      const decoded: unknown = JSON.parse(current)
      if (typeof decoded !== 'string') break
      current = decoded.trim()
    } catch {
      current = current.slice(1, -1).trim()
    }
  }
  return current
}

function imageToolPathCandidates(event: AgyJsonEvent): string[] {
  const candidates: string[] = []
  const visit = (value: unknown, key: string | undefined, depth: number): void => {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (key !== undefined && IMAGE_TOOL_PATH_KEYS.has(key)) {
        candidates.push(unwrapToolPath(value))
        return
      }
      if (key !== undefined && IMAGE_TOOL_JSON_KEYS.has(key)) {
        try {
          visit(JSON.parse(value), undefined, depth + 1)
        } catch {
          // Some lifecycle events intentionally omit structured tool arguments.
        }
      }
      return
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, undefined, depth + 1)
      return
    }
    if (!isRecord(value)) return
    for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1)
  }
  visit(event, undefined, 0)
  return candidates
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInsideDirectory(directory: string, selected: string): boolean {
  const rel = relative(resolve(directory), selected)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function isExpectedImagePath(candidate: string, prepared: PreparedAgyPrompts): boolean {
  if (!isAbsolute(candidate) || !prepared.bridgeActive) return false
  const selected = resolve(candidate)
  const allowed = [prepared.imageDirectory, prepared.imageCacheDirectory].some(directory =>
    directory !== undefined && isInsideDirectory(directory, selected))
  if (!allowed) return false
  return prepared.imagePaths.some(expected => samePath(expected, selected))
}

function isAllowedImageToolEvent(
  event: AgyJsonEvent,
  prepared: PreparedAgyPrompts,
  imageRuntime: AgyAgentRuntime | undefined,
): boolean {
  if (
    !prepared.bridgeActive
    || imageRuntime?.agentPreset !== 'image-view'
    || imageRuntime.agent !== 'dsh-agy-image-view'
  ) return false

  const toolName = toolNameOf(event)
  if (toolName !== undefined && toolName !== 'view_file') return false
  if (toolName === undefined && event.event !== 'tool_result') return false

  const candidates = imageToolPathCandidates(event)
  return candidates.length === 0 || candidates.every(candidate => isExpectedImagePath(candidate, prepared))
}

/**
 * AGY may expose its own task-orchestration lifecycle as a step_update tool
 * event even when the selected AGY Agent is tool-free. `manage_task` is an
 * AGY-internal bookkeeping event: it never becomes a DSH tool call and its
 * input is never executed by this provider. Keep this allowlist deliberately
 * narrow; every other AGY tool event remains fail-closed below.
 */
function isIgnorableAgyOrchestrationToolEvent(event: AgyJsonEvent): boolean {
  return event.event === 'step_update'
    && stepTypeOf(event) === 'tool'
    && toolNameOf(event) === 'manage_task'
}

/**
 * One in-flight MCP tool call observed on the AGY event stream. AGY reports the
 * call when it starts and the result when it finishes, so the adapter buffers
 * the opening event and only emits a DSH tool call once the call completed.
 */
interface AgyMcpToolStep {
  readonly stepIndex: number
  readonly toolName: string
  readonly arguments: unknown
}

/** Read the MCP tool identity out of an AGY `call_mcp_tool` step. */
function mcpToolStepOf(event: AgyJsonEvent): AgyMcpToolStep | undefined {
  if (event.event !== 'step_update') return undefined
  const step = (event as { step_update?: Record<string, unknown> }).step_update
  if (step === undefined || step.step_type !== 'tool') return undefined
  const info = step.tool_info
  if (typeof info !== 'object' || info === null) return undefined
  const record = info as Record<string, unknown>
  if (record.name !== 'call_mcp_tool') return undefined
  const parameters = record.parameters
  if (typeof parameters !== 'object' || parameters === null) return undefined
  const args = parameters as Record<string, unknown>
  // AGY nests the real call under `Arguments`; the server is our own bridge.
  const toolName = typeof args.ToolName === 'string' ? args.ToolName : undefined
  if (toolName === undefined || toolName.length === 0) return undefined
  const stepIndex = typeof step.step_index === 'number' ? step.step_index : -1
  return { stepIndex, toolName, arguments: args.Arguments ?? {} }
}

/**
 * One bridged MCP step rendered as a progress line for the reasoning channel.
 *
 * Deliberately NOT a DSH tool-call block. The host commits the assistant
 * message, then executes every `tool-call` block it contains and starts another
 * step (`@deepseek-ai/dsh-agent-loop` — `message.content.filter(block =>
 * block.type === "tool-call")` … `executeToolCalls(...)`). The bridge has
 * already run the tool, so advertising it as a call executes it a second time,
 * re-asks for approval, and makes AGY answer the same work again — the
 * "content arrived, vanished, then arrived several times over" report. A
 * reasoning line keeps the step visible in the transcript without handing the
 * host a call to replay.
 *
 * For Scheme B (规范化过程流 Step Process), each bridged step is emitted as a
 * structured, human-readable Chinese status line into the reasoning channel,
 * with commands/paths safely enclosed in backticks (`code`) to protect against
 * browser auto-translation plugins. DSH Desktop and Pocket display this as the
 * live progress indicator during execution and collapse it into the process
 * drawer once completed, keeping the final text response 100% clean and concise.
 */
// The provider streams process lines once each (the host's reasoning text is
// append-only). The host's own collapsed-summary logic
// (`latestCompletedParagraphFirstLine`) splits on BLANK lines and shows the
// first line of the latest completed paragraph while the row is running — that
// is exactly the "fold shows only the newest step, live" behavior the user
// asked for. So each step must be its OWN paragraph: a blank line separates
// consecutive steps. A single leading banner line is emitted first; when the
// row settles, the host's summary falls back to that line (the banner) as the
// one-line collapsed view.
function cleanStepTarget(str: string, maxLen = 100): string {
  const singleLine = str.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!singleLine) return ''
  const safe = singleLine.replace(/`/g, "'")
  return safe.length > maxLen ? `${safe.slice(0, maxLen)}…` : safe
}

/** One process step as its own markdown paragraph (blank line = separator). */
function mcpStepProcessLine(step: AgyMcpToolStep, state: string): string {
  const isError = state === 'ERROR'
  const statusIcon = isError ? '❌' : '🛠️'
  const rawArgs = step.arguments ?? {}
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<string, unknown>

  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v !== '') return v
    }
    return ''
  }

  let line: string
  if (step.toolName === 'pwsh' || step.toolName === 'bash') {
    const verb = isError ? '执行失败' : '执行'
    const cmd = cleanStepTarget(typeof args.command === 'string' ? args.command : '')
    line = cmd ? `${statusIcon} [${step.toolName}] ${verb}: \`${cmd}\`` : `${statusIcon} [${step.toolName}] ${verb}`
  } else if (step.toolName === 'read' || step.toolName === 'write' || step.toolName === 'edit') {
    const verbBase = step.toolName === 'read' ? '读取' : step.toolName === 'write' ? '写入' : '编辑'
    const verb = isError ? `${verbBase}失败` : verbBase
    const p = cleanStepTarget(pick('file_path', 'path'), 120)
    line = p ? `${statusIcon} [${step.toolName}] ${verb}: \`${p}\`` : `${statusIcon} [${step.toolName}] ${verb}`
  } else if (step.toolName === 'grep') {
    const verb = isError ? '检索失败' : '检索'
    const pat = cleanStepTarget(pick('pattern'))
    line = pat ? `${statusIcon} [grep] ${verb}: \`${pat}\`` : `${statusIcon} [grep] ${verb}`
  } else if (step.toolName === 'glob') {
    const verb = isError ? '查找失败' : '查找'
    const pat = cleanStepTarget(pick('pattern', 'include'))
    line = pat ? `${statusIcon} [glob] ${verb}: \`${pat}\`` : `${statusIcon} [glob] ${verb}`
  } else {
    const verb = isError ? '执行失败' : '执行'
    const t = cleanStepTarget(pick('description', 'toolSummary', 'toolAction', 'query', 'url', 'path', 'file_path', 'command'))
    line = t ? `${statusIcon} [${step.toolName}] ${verb}: \`${t}\`` : `${statusIcon} [${step.toolName}] ${verb}`
  }
  return `${line}\n\n`
}

/**
 * The consolidated process block opens with a banner paragraph. The host's
 * collapsed summary for a running row is `latestCompletedParagraphFirstLine`
 * — the first line of the latest completed paragraph — so, with one blank-line
 * separated paragraph per step, the fold live-rolls to the newest step; when
 * the row settles, the summary falls back to `firstLine`, i.e. this banner,
 * giving a stable one-line view of the finished process.
 */
function reasoningBanner(): string {
  return '[agy 过程流]\n\n'
}

/**
 * The block closes with a total-step paragraph, appended after the last step's
 * blank-line separator. It is not the settled summary (that is the banner) but
 * it carries the count the reader needs to judge a stuck, looping turn at a
 * glance when the body is expanded.
 */
function reasoningCloseLine(stepCount: number): string {
  return `〔共 ${stepCount} 步〕\n`
}

function stepStateOf(event: AgyJsonEvent): string | undefined {
  if (event.event !== 'step_update') return undefined
  const step = (event as { step_update?: Record<string, unknown> }).step_update
  const state = step?.state
  return typeof state === 'string' ? state : undefined
}

function dshOwnedToolEventError(
  event: AgyJsonEvent,
  toolProtocol: StructuredToolProtocol | undefined,
  imageContext?: {
    prepared: PreparedAgyPrompts
    runtime: AgyAgentRuntime | undefined
  },
  mcpToolsEnabled = false,
): LlmError | undefined {
  // Under the MCP bridge AGY is *supposed* to emit tool events: every
  // call_mcp_tool step is a DSH tool call travelling over the bridge, so the
  // internal-tool rejection only applies to the prompt-contract path.
  if (mcpToolsEnabled && mcpToolStepOf(event) !== undefined) return undefined
  if (toolProtocol === undefined || !isToolEvent(event)) return undefined
  if (
    imageContext !== undefined
    && isAllowedImageToolEvent(event, imageContext.prepared, imageContext.runtime)
  ) return undefined
  if (isIgnorableAgyOrchestrationToolEvent(event)) return undefined
  return new LlmError(
    'AGY emitted an internal tool event while DSH-owned tools were enabled',
    AGY_INTERNAL_TOOL_EVENT_CODE,
  )
}

/**
 * AGY's main-agent wrapper may deliver a DSH tool envelope through its
 * orchestration-only send_message primitive. Accept only the default_api
 * carrier or a carrier addressed to the active root conversation, and only
 * after validating the payload against the current DSH protocol. Every other
 * internal event remains rejected by dshOwnedToolEventError. AGY 1.1.x can
 * address the same DSH-owned carrier through one of its stable DSH runtime
 * recipients (`dsh`, `dsh-session`, or `dsh-runner`) instead of a UUID.
 */
function dshOwnedCarrierResponseOf(
  event: AgyJsonEvent,
  toolProtocol: StructuredToolProtocol | undefined,
  activeConversationId: string | undefined,
  telemetry: AgyTelemetry,
): string | undefined {
  if (toolProtocol === undefined) return undefined
  const carrier = sendMessageOf(event)
  if (carrier === undefined) return undefined
  const isDefaultApiCarrier = carrier.recipient === 'default_api'
  const isDshRuntimeCarrier = isDshCarrierRecipient(carrier.recipient)
  const isSelfConversationCarrier = activeConversationId !== undefined
    && carrier.recipient === activeConversationId
  if (!isDefaultApiCarrier && !isDshRuntimeCarrier && !isSelfConversationCarrier) {
    telemetry.carrierValidation = 'recipient-rejected'
    return undefined
  }
  // Validation is deliberately performed here, before the carrier is
  // converted into a normal DSH result. This prevents arbitrary AGY messages
  // from becoming tool calls.
  try {
    const envelope = parseStructuredEnvelope(carrier.message, toolProtocol, {
      onCompatibilityApplied: compatibility => {
        telemetry.protocolCompatibilityApplied = compatibility
      },
    })
    telemetry.carrierValidation = envelope.kind === 'message' ? 'valid-message' : 'valid-tool-call'
  } catch (error) {
    telemetry.carrierValidation = carrierValidationOf(error)
    recordProtocolFailure(telemetry, carrier.message, error)
    throw error
  }
  return carrier.message
}

function carrierValidationOf(error: unknown): AgyCarrierValidation {
  if (!(error instanceof ToolProtocolError)) return 'invalid-envelope'
  switch (error.code) {
    case TOOL_PROTOCOL_UNKNOWN_TOOL_CODE:
      return 'unknown-tool'
    case TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE:
      return 'arguments-invalid'
    case TOOL_PROTOCOL_RESPONSE_LIMIT_CODE:
      return 'response-limit'
    case TOOL_PROTOCOL_RESPONSE_INVALID_CODE:
    default:
      return 'invalid-envelope'
  }
}

function recordToolEvent(
  telemetry: AgyTelemetry,
  event: AgyJsonEvent,
  activeConversationId?: string,
): void {
  const kind = toolEventKindOf(event)
  if (kind === undefined) return
  telemetry.toolEventCount += 1
  telemetry.toolEventKind ??= kind
  telemetry.toolEventStreamIndex = telemetry.eventCount
  telemetry.toolEventDiagnostic = toolEventDiagnosticOf(event, activeConversationId)
}

function canonicalWorkspaceRoot(value: string | undefined): string | undefined {
  const selected = value?.trim()
  if (selected === undefined || selected.length === 0) return undefined
  try {
    const canonical = realpathSync(selected)
    if (!statSync(canonical).isDirectory() || canonical === parsePath(canonical).root) {
      throw new Error('workspace root must be a non-root directory')
    }
    return canonical
  } catch (error) {
    throw new RangeError(
      `workspaceRoot must point to an existing non-root directory: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function resolveAgyAgentRuntime(config: Config, toolPolicy: ToolPolicy): AgyAgentRuntime {
  const dshOwned = toolPolicy === 'dsh-owned'
  const configuredPreset = config.agentPreset === undefined ? undefined : getAgentPreset(config.agentPreset)
  if (config.agentPreset !== undefined && configuredPreset === undefined) {
    throw new RangeError('agentPreset must be one of: tool-free, read-only, workspace-write')
  }
  const preset = dshOwned
    ? getAgentPreset('mcp-executor')
    : configuredPreset
  const workspaceRoot = dshOwned ? undefined : canonicalWorkspaceRoot(config.workspaceRoot)
  if (preset?.writeAccess === true && workspaceRoot === undefined) {
    throw new RangeError('workspaceRoot is required when agentPreset is workspace-write')
  }
  return {
    agent: preset?.agentName ?? config.agent ?? DEFAULT_AGENT,
    agentPreset: preset?.id,
    agentCanViewFile: preset?.tools.includes('view_file') === true,
    workspaceRoot,
    addDirs: workspaceRoot === undefined ? undefined : [workspaceRoot],
    mode: preset?.mode,
    disableSlashCommands: preset === undefined ? undefined : true,
  }
}

const AGY_REASONING_METADATA = [
  {
    id: 'low' as ReasoningEffortId,
    name: 'Low',
  },
  {
    id: 'medium' as ReasoningEffortId,
    name: 'Medium',
  },
  {
    id: 'high' as ReasoningEffortId,
    name: 'High',
  },
] as const

function abortError(): LlmError {
  return new LlmError('AGY request aborted by caller', 'ABORTED')
}

/**
 * Fingerprint of the DSH history one conversation holds: a short hash over the
 * serialized system + messages. Kept deliberately independent of the outbound
 * prompt (image bridges and tool contracts may decorate it) — this hash only
 * answers "is the DSH history the same one the AGY conversation was built on".
 */
function historyFingerprintOf(messages: readonly RequestMessage[], system: string | undefined): string {
  // serializeAgyPrompt reads only, but its parameter keeps the host's mutable
  // array type — the shallow copy is for the type, the cost is one array.
  const serialized = serializeAgyPrompt({
    ...(messages.length === 0
      ? { messages: [{ role: 'user', content: [{ type: 'text', text: ' ' }] }] as unknown as RequestMessage[] }
      : { messages: [...messages] as unknown as RequestMessage[] }),
    ...(system === undefined ? {} : { system }),
  })
  return createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16)
}

/** Fingerprint metadata to store after a turn was delivered successfully. */
function fingerprintAfterTurn(options: GenerateOptions): SessionFingerprint {
  return {
    chainHash: historyFingerprintOf(options.messages, options.system),
    messageCount: options.messages.length,
  }
}

function idleTimeoutMsOf(result: ProcessResult): number | undefined {
  // The process layer owns the budget; the adapter only knows the elapsed time
  // between the last delivered line and the kill, which is what the message
  // reports so the operator sees the threshold that actually fired.
  const lastLineAt = numberValue(result.lastOutputAtMs)
  return lastLineAt === undefined ? undefined : Math.max(0, Date.now() - lastLineAt)
}
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = numberValue(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** Convert AGY's observed snake/camel-case usage variants to DSH accounting. */
export function mapAgyUsage(raw: Record<string, unknown>): TokenUsage {
  const input = firstNumber(raw, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'])
  const output = firstNumber(raw, ['outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'])
  const cacheRead = firstNumber(raw, ['cacheReadTokens', 'cache_read_tokens', 'cacheReadInputTokens'])
  const cacheWrite = firstNumber(raw, ['cacheWriteTokens', 'cache_write_tokens', 'cacheCreationInputTokens'])
  const reasoning = firstNumber(raw, ['reasoningTokens', 'reasoning_tokens'])
  const total = firstNumber(raw, ['totalTokens', 'total_tokens'])

  // AGY 1.1.13 exposes totalTokens in the observed result. Preserve that
  // total conservatively as input pressure until AGY exposes a split.
  const inputTokens = input ?? (output === undefined ? total ?? 0 : 0)
  const outputTokens = output ?? 0
  return {
    inputTokens,
    outputTokens,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
  }
}

function recordUsageTelemetry(
  telemetry: AgyTelemetry,
  usage: TokenUsage,
  source: AgyUsageSource,
  cumulativeRaw: Record<string, unknown> | undefined,
): void {
  telemetry.usageSource = source
  telemetry.usage = addUsage(telemetry.usage, usage)
  if (cumulativeRaw !== undefined) telemetry.cumulativeUsage = mapAgyUsage(cumulativeRaw)
  const cacheRead = usage.cacheReadTokens
  if (cacheRead !== undefined) {
    telemetry.cacheHit = cacheRead > 0
    const denominator = usage.inputTokens + cacheRead
    telemetry.cacheTokenShare = denominator > 0 ? cacheRead / denominator : 0
  }
}

function asLlmError(error: unknown): LlmError {
  if (error instanceof LlmError) return error
  if (error instanceof DshContextError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyPromptError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyPromptBudgetError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof ToolProtocolError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyImageBridgeError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof AgyParserError) {
    return new LlmError(`AGY stream-json parse failed at line ${error.lineNumber}`, 'AGY_PARSE', { cause: error })
  }
  if (error instanceof AgyQueueError) {
    return new LlmError(error.message, error.code, { cause: error })
  }
  if (error instanceof PersistentTransportError) {
    if (error.code === 'TIMEOUT') {
      return new LlmError(error.message, 'TIMEOUT', { cause: error })
    }
    if (error.code === 'WORKER_ERROR') {
      // AGY's own failure text, carried in the result frame. The one-shot path
      // classifies the same text (see classifyAgyFailure on AGY_STATUS) so a
      // proxy-cut stream becomes TRANSPORT and the host retries it; without
      // that step the identical flake surfaces as an unknown code the host
      // refuses to retry. Classification keeps the loud failures loud: an AUTH,
      // quota or context-window error inside this frame still maps to its own
      // non-retryable code instead of being retried five times.
      return new LlmError(
        error.message,
        classifyAgyFailure(error.message, 'AGY_WORKER_ERROR'),
        { cause: error },
      )
    }
    return new LlmError(error.message, `AGY_${error.code}`, { cause: error })
  }
  if (error instanceof AgyProcessError) {
    return new LlmError(
      error.message,
      error.code === 'INPUT_TOO_LARGE' ? 'AGY_INPUT_TOO_LARGE' : `AGY_${error.code}`,
      { cause: error },
    )
  }
  return new LlmError('AGY provider request failed', 'AGY_REQUEST', {
    cause: error instanceof Error ? error : new Error(String(error)),
  })
}

function processFailure(result: ProcessResult): LlmError | undefined {
  if (result.termination === 'aborted') return abortError()
  if (result.termination === 'timeout') {
    return new LlmError('AGY request exceeded the configured wall-clock timeout', 'TIMEOUT')
  }
  if (result.termination === 'idle-timeout') {
    return new LlmError(
      `AGY produced no output for ${idleTimeoutMsOf(result) ?? 'the configured'} ms`,
      'TIMEOUT',
    )
  }
  if (result.termination === 'output-limit') {
    return new LlmError('AGY output exceeded the configured capture limit', 'AGY_OUTPUT_LIMIT')
  }
  if (result.termination !== 'completed' || result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    const code = classifyAgyFailure(stderr, 'AGY_EXIT')
    return new LlmError(
      stderr.length === 0
        ? `AGY exited unsuccessfully (exit code ${result.exitCode ?? 'unknown'})`
        : safeAgyFailureMessage('AGY exited unsuccessfully', stderr),
      code,
    )
  }
  return undefined
}

function isSuccessStatus(status: string | undefined): boolean {
  return status === undefined || status.toUpperCase() === 'SUCCESS'
}

/**
 * Claude 4.6 occasionally ignores the final JSON-envelope instruction even
 * though its tool-free AGY Agent has no native tools available. Preserve the
 * strict parser for JSON-looking output and every other model, but treat a
 * genuinely plain Claude response as a final DSH message. This fallback can
 * never create a tool call; malformed structured output still fails closed.
 */
function parseAgyToolEnvelope(
  raw: unknown,
  protocol: StructuredToolProtocol,
  model: string,
  allowPlainTextFallback: boolean,
  options: ParseStructuredEnvelopeOptions = {},
): ReturnType<typeof parseStructuredEnvelope> {
  try {
    return parseStructuredEnvelope(raw, protocol, options)
  } catch (error) {
    if (
      !(error instanceof ToolProtocolError)
      || error.code !== TOOL_PROTOCOL_RESPONSE_INVALID_CODE
      || (!allowPlainTextFallback && !/^claude-/i.test(model))
      || typeof raw !== 'string'
    ) throw error

    const content = raw.trim()
    if (content.length === 0 || /^[{[]/.test(content) || /^```/i.test(content)) throw error
    return parseStructuredEnvelope({ kind: 'message', content }, protocol, options)
  }
}

function toolProtocolErrorOf(error: unknown): ToolProtocolError | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof ToolProtocolError) return current
    if (!(current instanceof Error)) return undefined
    current = current.cause
  }
  return undefined
}

function isRepairableToolProtocolError(error: unknown): boolean {
  const protocolError = toolProtocolErrorOf(error)
  return protocolError !== undefined
    && (
      (protocolError.code === TOOL_PROTOCOL_RESPONSE_INVALID_CODE && protocolError.detail === 'not JSON')
      || protocolError.code === TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE
    )
}

function errorCodeOf(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (current instanceof Error) {
      const code = (current as Error & { code?: unknown }).code
      if (typeof code === 'string') return code
      current = current.cause
      continue
    }
    return undefined
  }
  return undefined
}

function isRepairableAgyRequestError(error: unknown): boolean {
  return isRepairableToolProtocolError(error) || errorCodeOf(error) === AGY_INTERNAL_TOOL_EVENT_CODE
}

function protocolRepairReasonOf(error: unknown): ToolProtocolRepairReason | undefined {
  return errorCodeOf(error) === AGY_INTERNAL_TOOL_EVENT_CODE ? 'internal-tool-event' : undefined
}

function protocolRepairHintOf(error: unknown): Pick<
  ToolProtocolArgumentDiagnostic,
  'toolName' | 'issue' | 'missingRequiredKeys'
> | undefined {
  const diagnostic = toolProtocolErrorOf(error)?.diagnostic
  if (diagnostic === undefined) return undefined
  return {
    toolName: diagnostic.toolName,
    issue: diagnostic.issue,
    ...(diagnostic.missingRequiredKeys === undefined
      ? {}
      : { missingRequiredKeys: diagnostic.missingRequiredKeys }),
  }
}

function protocolFailureDetailOf(error: ToolProtocolError): AgyProtocolFailureDetail {
  if (error.detail === 'not JSON') return 'not-json'
  if (error.detail === 'envelope') return 'envelope'
  if (error.detail === 'message shape') return 'message-shape'
  if (error.detail === 'tool_call shape') return 'tool-call-shape'
  if (error.code === TOOL_PROTOCOL_RESPONSE_LIMIT_CODE) return 'response-limit'
  if (error.code.startsWith('TOOL_PROTOCOL_')) return 'validation'
  return 'unknown'
}

function protocolResponseShapeOf(raw: unknown): AgyProtocolResponseShape {
  if (typeof raw !== 'string') return 'non-string'
  const trimmed = raw.trim()
  if (trimmed.length === 0) return 'empty'
  if (/^```/i.test(trimmed)) return 'fenced'
  if (trimmed.startsWith('{')) return 'object-like'
  if (trimmed.startsWith('[')) return 'array-like'
  return 'plain-text'
}

function recordProtocolFailure(
  telemetry: AgyTelemetry,
  raw: unknown,
  error: unknown,
): void {
  const protocolError = toolProtocolErrorOf(error)
  if (protocolError === undefined) return
  telemetry.protocolFailureDetail = protocolFailureDetailOf(protocolError)
  telemetry.protocolResponseShape = protocolResponseShapeOf(raw)
  telemetry.protocolResponseBytes = typeof raw === 'string'
    ? Buffer.byteLength(raw, 'utf8')
    : undefined
  if (protocolError.code === TOOL_PROTOCOL_RESPONSE_INVALID_CODE && protocolError.detail === 'not JSON') {
    telemetry.protocolRepairReason ??= 'not-json'
  } else if (protocolError.code === TOOL_PROTOCOL_ARGUMENTS_INVALID_CODE) {
    telemetry.protocolRepairReason ??= 'arguments-invalid'
  }
  const diagnostic = protocolError.diagnostic
  if (diagnostic !== undefined) {
    telemetry.protocolToolName = diagnostic.toolName
    telemetry.protocolArgumentIssue = diagnostic.issue
    telemetry.protocolMissingRequiredKeys = diagnostic.missingRequiredKeys
    telemetry.protocolReceivedArgumentKeys = diagnostic.receivedArgumentKeys
  }
}

function bridgeOutcomeForError(code: string, current: AgyBridgeOutcome): AgyBridgeOutcome {
  if (code.startsWith('DSH_')) return 'context-rejected'
  if (code === PERMISSION_REQUIRED_CODE) return 'permission-required'
  if (code === AGY_INTERNAL_TOOL_EVENT_CODE) return 'agy-internal-tool'
  if (code === 'TOOL_PROTOCOL_SCHEMA_INVALID' || code === 'TOOL_PROTOCOL_SCHEMA_LIMIT') {
    return 'schema-rejected'
  }
  if (code.startsWith('TOOL_PROTOCOL_')) return 'protocol-rejected'
  if (code === UNSUPPORTED_TOOLS_CODE) {
    if (current === 'agy-internal-tool' || current === 'schema-rejected') return current
    return 'failed'
  }
  return current === 'dsh-pending' ? 'failed' : current
}

function setDshTelemetrySnapshot(
  telemetry: AgyTelemetry,
  snapshot: DshContextSnapshot,
): void {
  if (snapshot.permissionPreset === 'read-only'
    || snapshot.permissionPreset === 'workspace-write'
    || snapshot.permissionPreset === 'danger-full-access') {
    telemetry.permissionPreset = snapshot.permissionPreset
  }
  if (snapshot.sandboxMode !== undefined) telemetry.sandboxMode = snapshot.sandboxMode
  if (snapshot.approvalPolicy !== undefined) telemetry.approvalPolicy = snapshot.approvalPolicy
}

function normalizeReasoningEffort(value: unknown): AgyReasoningEffort | undefined {
  if (value === undefined) return undefined
  if (isAgyReasoningEffort(value)) return value
  throw new LlmError(
    'AGY supports reasoning efforts: low, medium, high',
    UNSUPPORTED_REASONING_EFFORT_CODE,
  )
}

// The panel's "default thinking strength" control writes ~/.dsh/agy-cli/
// runtime-overrides.json; this reads it back so the generation path uses the
// user's choice as the last-resort effort instead of the built-in 'high'.
// 30s TTL so a panel change takes effect without a host restart; an invalid or
// missing file silently falls back to the built-in default.
// `__effortOverrideCacheForTest` is the mutable record the test harness can
// poke to clear the cache between cases without a process restart.
export const __effortOverrideCacheForTest: { at: number; value: AgyReasoningEffort | undefined } = { at: 0, value: undefined }
const EFFORT_OVERRIDE_TTL_MS = 30_000
function readDefaultEffortOverride(): AgyReasoningEffort | undefined {
  const now = Date.now()
  if (now - __effortOverrideCacheForTest.at < EFFORT_OVERRIDE_TTL_MS) return __effortOverrideCacheForTest.value
  __effortOverrideCacheForTest.at = now
  __effortOverrideCacheForTest.value = readAgyRuntimeOverrides()?.defaultEffort
  return __effortOverrideCacheForTest.value
}

function resolveAgyRetryPolicy(config: AgyRetryPolicyConfig | undefined): ResolvedRetryPolicy {
  const maxRetries = config?.maxRetries ?? 5
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) {
    throw new RangeError('AGY retryPolicy.maxRetries must be an integer between 0 and 5')
  }
  const retryableCodes = config?.retryableCodes ?? [...AGY_RETRYABLE_CODES]
  // A configured list is normalized against the allowlist rather than rejected:
  // a profile written before AGY_INPUT_FAILED/AGY_SPAWN_FAILED joined the list
  // would otherwise make this resolver throw on every call, and the failure mode
  // of a stale config must never be "the provider refuses to start". Codes that
  // are no longer retryable are dropped, except when that would leave nothing to
  // retry — a non-empty list is a schema requirement, so falling back to the full
  // allowlist is safer than silently disabling retries.
  const allowed = new Set<string>(AGY_RETRYABLE_CODES)
  const dropped = [...new Set(retryableCodes.filter(code => !allowed.has(code)))]
  if (dropped.length > 0) {
    process.emitWarning(
      `AGY retryPolicy.retryableCodes dropped codes that are not retryable: ${dropped.join(', ')}`,
      { code: 'DSH_AGY_RETRY_CODES' },
    )
  }
  const filtered = retryableCodes.filter((code): code is AgyRetryableCode => allowed.has(code))
  const effectiveCodes = filtered.length > 0 ? filtered : [...AGY_RETRYABLE_CODES]
  return resolveRetryPolicy({
    mode: 'normal',
    maxRetries,
    retryableCodes: [...effectiveCodes],
  }, 'dsh-agy-cli.retryPolicy')
}

function resolveBoundedInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return resolved
}

function addUsage(left: TokenUsage | undefined, right: TokenUsage): TokenUsage {
  const sumOptional = (key: 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'): number | undefined => {
    const leftValue = left?.[key]
    const rightValue = right[key]
    if (leftValue === undefined && rightValue === undefined) return undefined
    return (leftValue ?? 0) + (rightValue ?? 0)
  }
  const cacheReadTokens = sumOptional('cacheReadTokens')
  const cacheWriteTokens = sumOptional('cacheWriteTokens')
  const reasoningTokens = sumOptional('reasoningTokens')
  return {
    inputTokens: (left?.inputTokens ?? 0) + right.inputTokens,
    outputTokens: (left?.outputTokens ?? 0) + right.outputTokens,
    ...(cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens }),
    ...(reasoningTokens === undefined
      ? {}
      : { reasoningTokens }),
  }
}

function purposeRouteFor(
  purpose: GenerateOptions['purpose'],
  routes: PurposeRoutesConfig | undefined,
): PurposeRouteConfig | undefined {
  if (purpose === 'compaction') return routes?.compaction
  if (purpose === 'session-title') return routes?.sessionTitle
  return undefined
}

/**
 * A request with no tool catalog is never a user turn: DSH ships its tool list
 * whenever the model is expected to act, and the MCP bridge still reports the
 * schemas in `toolSchemaCount` even though they leave the prompt. Such calls are
 * side channels, and their payload is a serialized dump of the conversation as
 * ONE message — the session-title provider (`@weibaohui/dsh-smart-title`,
 * `purpose: 'session-title'`), compaction, and `@deepseek-ai/dsh-experimental-auto-review`
 * (whose review request has no `purpose` at all and whose text is
 * ENVIRONMENT / PROJECT_INSTRUCTIONS / FILTERED_HISTORY / PENDING_ACTION joined).
 * A dump is the only place where a single section can exceed the prompt budget,
 * and clipping its head drops just the oldest context. A real turn keeps the
 * strict path: losing the start of the user's own message silently is worse than
 * a clean AGY_INPUT_TOO_LARGE.
 */
/**
 * Per-request argv tail for a persistent worker. `--disable-slash-commands` is
 * fixed in the transport args (it never varies), while `--mode` travels with
 * the route so a worker spawned for a preset keeps its bounded mode.
 */
function persistentExtraArgsOf(mode: AgyExecutionMode | undefined): readonly string[] {
  return mode === undefined ? [] : ['--mode', mode]
}

function isSideChannelRequest(
  toolProtocol: StructuredToolProtocol | undefined,
  toolSchemaCount: number,
): boolean {
  return toolProtocol === undefined && toolSchemaCount === 0
}

/** DSH text-only adapter backed by the locally authenticated AGY CLI. */
export class AgyAdapter extends LlmAdapter {
  private readonly model: string
  private readonly models: readonly ModelConfig[]
  private readonly agent: string
  private readonly workspaceRoot: string | undefined
  private readonly addDirs: readonly string[] | undefined
  private readonly mode: AgyExecutionMode | undefined
  private readonly disableSlashCommands: boolean | undefined
  private readonly toolPolicy: ToolPolicy
  private readonly dshContext: DshContextLookup | undefined
  private readonly agyPath: string | undefined
  private readonly timeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly stdinMode: AgyStdinMode
  private readonly run: AgyProcessRunner
  private readonly sessionMode: 'resume' | 'full'
  private readonly sessions: SessionRegistry
  private readonly minimumAgyVersion: string
  private readonly limiter: AgyConcurrencyLimiter
  private readonly logger: AgyLogger | undefined
  private readonly maxOutputBytes: number
  private readonly maxEventLineLength: number
  private readonly inputFrameLimitBytes: number
  private readonly maxSingleToolResultBytes: number
  private readonly maxHistoricalToolResultBytes: number
  private readonly toolProtocolRepairRetries: number
  private readonly toolProtocolPlainTextFallback: 'off' | 'final-message'
  private readonly retryPolicy: ResolvedRetryPolicy
  private readonly purposeRoutes: PurposeRoutesConfig | undefined
  private readonly transport: TransportMode
  private readonly persistentIdleTtlMs: number
  private readonly persistentReadyTimeoutMs: number
  private readonly persistentFallback: PersistentFallbackMode
  private readonly persistentTransport: PersistentTransportLike | undefined
  private readonly imageInput: 'off' | 'experimental'
  private readonly imageAgent: AgyAgentRuntime | undefined
  private readonly resolveAttachmentStore: () => AgyImageAttachmentStore | undefined
  private readonly resolveToolBridge: (() => DshToolBridgeHandle | undefined) | undefined
  private readonly mcpBridgeEnabled: boolean
  private readonly discovery: AgyModelDiscovery | undefined
  private readonly visibleModels: readonly string[]
  private currentModels: readonly ModelConfig[]
  private modelDiscoveryResult: AgyModelDiscoveryResult | undefined

  constructor(config: Config = {}, dependencies: AgyAdapterDependencies = {}) {
    super()
    // Normalize default model to base (strip -high/-medium/-low) for effort split
    this.model = normalizeModelId(config.model ?? DEFAULT_MODEL)
    this.models = configuredModels(config).map(m => ({ ...m, id: normalizeModelId(m.id) }))
    this.visibleModels = (config.visibleModels ?? []).map(normalizeModelId)
    this.toolPolicy = config.toolPolicy === 'agy-owned'
      ? 'agy-owned'
      : config.toolPolicy === 'dsh-owned' ? 'dsh-owned' : 'reject'
    const agentRuntime = resolveAgyAgentRuntime(config, this.toolPolicy)
    this.agent = agentRuntime.agent
    this.workspaceRoot = agentRuntime.workspaceRoot
    this.addDirs = agentRuntime.addDirs
    this.mode = agentRuntime.mode
    this.disableSlashCommands = agentRuntime.disableSlashCommands
    this.dshContext = dependencies.dshContext
    this.resolveToolBridge = dependencies.resolveToolBridge
    this.mcpBridgeEnabled = config.mcpBridge !== false
    this.agyPath = config.agyPath?.trim() === '' ? undefined : config.agyPath?.trim()
    this.timeoutMs = config.timeoutMs ?? 900_000
    this.idleTimeoutMs = config.idleTimeoutMs ?? 300_000
    this.stdinMode = config.stdinMode ?? 'hold'
    this.run = dependencies.runAgyProcess ?? runAgyProcess
    this.sessionMode = config.sessionMode === 'resume' ? 'resume' : 'full'
    this.sessions = dependencies.sessionRegistry ?? new SessionRegistry()
    this.minimumAgyVersion = config.minimumAgyVersion?.trim() || DEFAULT_MINIMUM_AGY_VERSION
    this.limiter = dependencies.concurrencyLimiter ?? new AgyConcurrencyLimiter({
      maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxQueue: config.maxQueue ?? DEFAULT_MAX_QUEUE,
      queueTimeoutMs: config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
    })
    this.logger = dependencies.logger
    this.maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    this.maxEventLineLength = config.maxEventLineLength ?? DEFAULT_MAX_EVENT_LINE_LENGTH
    this.inputFrameLimitBytes = resolveBoundedInteger(
      'inputFrameLimitBytes',
      config.inputFrameLimitBytes,
      DEFAULT_INPUT_FRAME_LIMIT_BYTES,
      128,
      16 * 1024 * 1024,
    )
    this.maxSingleToolResultBytes = resolveBoundedInteger(
      'maxSingleToolResultBytes',
      config.maxSingleToolResultBytes,
      DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES,
      1_024,
      512 * 1024,
    )
    this.maxHistoricalToolResultBytes = resolveBoundedInteger(
      'maxHistoricalToolResultBytes',
      config.maxHistoricalToolResultBytes,
      DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES,
      1_024,
      2 * 1024 * 1024,
    )
    this.toolProtocolRepairRetries = resolveBoundedInteger(
      'toolProtocolRepairRetries',
      config.toolProtocolRepairRetries,
      1,
      0,
      1,
    )
    const plainTextFallback = config.toolProtocolPlainTextFallback ?? 'final-message'
    if (plainTextFallback !== 'off' && plainTextFallback !== 'final-message') {
      throw new RangeError('toolProtocolPlainTextFallback must be off or final-message')
    }
    this.toolProtocolPlainTextFallback = plainTextFallback
    this.retryPolicy = resolveAgyRetryPolicy(config.retryPolicy)
    this.transport = config.transport === 'persistent' ? 'persistent' : 'one-shot'
    this.persistentIdleTtlMs = config.persistentIdleTtlMs ?? 30_000
    this.persistentReadyTimeoutMs = config.persistentReadyTimeoutMs ?? 10_000
    this.persistentFallback = config.persistentFallback === 'never' ? 'never' : 'before-accept'
    this.purposeRoutes = config.purposeRoutes
    this.imageInput = config.imageInput === 'experimental' ? 'experimental' : 'off'
    const imagePreset = getAgentPreset('image-view')
    this.imageAgent = this.imageInput !== 'experimental' || imagePreset === undefined
      ? undefined
      : {
          agent: imagePreset.agentName,
          agentPreset: imagePreset.id,
          agentCanViewFile: true,
          workspaceRoot: undefined,
          addDirs: undefined,
          mode: imagePreset.mode,
          disableSlashCommands: true,
        }
    this.resolveAttachmentStore = dependencies.resolveAttachmentStore
      ?? (() => dependencies.attachmentStore)
    this.currentModels = this.models
    this.discovery = config.modelDiscovery === 'off'
      ? undefined
      : new AgyModelDiscovery({
        ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
        ...(config.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: config.modelDiscoveryTtlMs }),
        ...(config.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: config.modelDiscoveryTimeoutMs }),
        maxOutputBytes: this.maxOutputBytes,
        ...(dependencies.runModelDiscovery === undefined ? {} : { runCommand: dependencies.runModelDiscovery }),
      })
    // Persistent transport is opt-in; one-shot remains default. It is created only when transport:persistent.
    // Route args (--agent/--model/--effort/--conversation) are NOT fixed here:
    // AGY reads them at process start, and the route varies per request (the
    // user can switch model inside one session). Each request supplies its own
    // route and the pool keys workers by it. See PersistentTransportRequest.
    this.persistentTransport = this.transport !== 'persistent' ? undefined : (dependencies.persistentTransport ?? new ExperimentalAgyTransport({
      executable: resolveAgyExecutable(this.agyPath),
      args: [
        '-p', '',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
        // workspaceRoot is cwd for persistent worker, not an arg
        ...(this.disableSlashCommands ? ['--disable-slash-commands'] : []),
      ],
      ...(this.workspaceRoot === undefined ? {} : { cwd: this.workspaceRoot }),
      idleTtlMs: this.persistentIdleTtlMs,
      readyTimeoutMs: this.persistentReadyTimeoutMs,
      maxFrameBytes: this.inputFrameLimitBytes,
      maxWorkers: config.maxConcurrent ?? 4,
    }))
  }

  private preparePrompt(
    basePrompt: string,
    toolProtocol: StructuredToolProtocol | undefined,
    protocolRepair: boolean,
    protocolRepairHint: Pick<
      ToolProtocolArgumentDiagnostic,
      'toolName' | 'issue' | 'missingRequiredKeys'
    > | undefined,
    protocolRepairReason: ToolProtocolRepairReason | undefined,
    telemetry: AgyTelemetry,
  ): string {
    let prompt = toolProtocol === undefined
      ? basePrompt
      : appendToolProtocolPrompt(basePrompt, toolProtocol)
    if (toolProtocol !== undefined) telemetry.toolSchemaHash = toolProtocol.schemaHash
    if (toolProtocol !== undefined && protocolRepair) {
      prompt = appendToolProtocolRepairPrompt(prompt, protocolRepairHint, protocolRepairReason)
    }
    // Side channels (session title, compaction, auto-review) are the only
    // requests with no tool catalog, and their payload is one huge conversation
    // dump. Clipping the head of that dump beats AGY_INPUT_TOO_LARGE, which
    // leaves the title stale and the tool call unreviewed. See the helper.
    const oversizedSectionPolicy: 'reject' | 'clamp' =
      isSideChannelRequest(toolProtocol, telemetry.toolSchemaCount) ? 'clamp' : 'reject'
    const bounded = boundAgyPrompt(prompt, {
      maxFrameBytes: this.inputFrameLimitBytes,
      maxPromptBytes: toolProtocol === undefined
        ? DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES
        : DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES,
      maxSingleToolResultBytes: this.maxSingleToolResultBytes,
      maxHistoricalToolResultBytes: this.maxHistoricalToolResultBytes,
      oversizedSectionPolicy,
    })
    telemetry.promptBytes = bounded.promptBytes
    telemetry.promptLimitBytes = bounded.promptLimitBytes
    telemetry.inputFrameBytes = bounded.frameBytes
    telemetry.inputFrameLimitBytes = bounded.frameLimitBytes
    telemetry.toolResultCount = bounded.toolResultCount
    telemetry.largestToolResultBytes = bounded.largestToolResultBytes
    telemetry.truncatedToolResultCount = bounded.truncatedToolResultCount
    telemetry.historyCompacted = bounded.historyCompacted
    telemetry.omittedMessageCount = bounded.omittedMessageCount
    const stablePrefix = stableAgyPromptPrefix(bounded.prompt)
    telemetry.stablePrefixBytes = Buffer.byteLength(stablePrefix, 'utf8')
    telemetry.stablePrefixHash = createHash('sha256').update(stablePrefix, 'utf8').digest('hex').slice(0, 16)
    return bounded.prompt
  }

  /** Remove the in-memory AGY mapping; the next call sends complete DSH history. */
  clearSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  /** Inspect the detached mapping for diagnostics and tests. */
  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  /** Return process-slot state without exposing prompts, paths, or credentials. */
  getConcurrencyStats() {
    return this.limiter.getStats()
  }

  /** Check AGY path, version, and configured Agent without spending model quota. */
  diagnose(): Promise<AgyDiagnosticResult> {
    return diagnoseAgy({
      ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
      expectedAgent: this.agent,
      minimumVersion: this.minimumAgyVersion,
      timeoutMs: Math.min(this.timeoutMs, 10_000),
    })
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Antigravity CLI' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.effectiveModels()
    const inputModalities = this.imageInput === 'experimental'
      ? ['text', 'image'] as const
      : ['text'] as const
    return models.map(model => ({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      inputModalities,
    }))
  }

  /** Expose safe discovery state for diagnostics and integration tests. */
  getModelDiscoveryStatus(): AgyModelDiscoveryResult | { source: 'static'; stale: false; models: readonly ModelConfig[] } {
    return this.modelDiscoveryResult ?? {
      models: this.currentModels,
      source: 'static',
      stale: false,
    }
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const baseId = normalizeModelId(model)
    const suffixEffort = extractModelEffort(model)
    // Log deprecation if suffix used (telemetry handled by caller via model id)
    const configured = this.currentModels.find(entry => entry.id.toLowerCase() === baseId.toLowerCase()) ?? this.currentModels.find(entry => entry.id === model)
    void suffixEffort // suffix implies effort, handled in stream route; resolve keeps base id for UI consistency
    // "Default thinking strength" is a user setting: the panel control writes it to
    // ~/.dsh/agy-cli/runtime-overrides.json (single source of truth), and the
    // generation path reads it here. It is only a last-resort fallback — a
    // purpose route, the host's requested effort, or a model-id suffix all win.
    // Re-read per call with a 30s TTL (the panel can change it without a restart);
    // absent/invalid file falls back to 'high', the built-in gemini default.
    const overrideEffort = readDefaultEffortOverride()
    const defaultEffort: ReasoningEffortId | undefined = baseId.toLowerCase().startsWith('gemini-')
      ? (overrideEffort ?? 'high') as ReasoningEffortId
      : undefined
    const inputModalities = this.imageInput === 'experimental'
      ? ['text', 'image'] as const
      : ['text'] as const
    return Promise.resolve({
      provider,
      id: baseId,
      name: configured?.name ?? baseId,
      inputModalities,
      ...(configured?.contextWindow === undefined
        ? {}
        : { context: { contextWindow: configured.contextWindow } }),
      reasoning: {
        efforts: AGY_REASONING_METADATA,
        ...(defaultEffort === undefined ? {} : { defaultEffort }),
      },
    })
  }


  private shouldUsePersistent(
    options: GenerateOptions,
    sessionKey: string | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
    toolSchemaCount: number,
    hasImage: boolean,
    mcpToolsEnabled = false,
  ): boolean {
    if (this.transport !== 'persistent' || this.persistentTransport === undefined) return false
    if (sessionKey === undefined) return false
    if ((options.purpose as string) === 'compaction' || (options.purpose as string) === 'sessionTitle' || (options.purpose as string) === 'session-title') return false
    if (hasImage) return false
    // The AGY main-agent wrapper can emit send_message before a DSH-owned
    // tool turn reaches its final result. Keep these turns on one-shot so the
    // carrier can be captured and the tainted process can be terminated
    // deterministically; persistent remains available for text-only turns.
    // That reasoning is specific to the prompt-embedded tool protocol: under
    // the MCP bridge no carrier exists (the tool catalogue travels out of
    // band), so there is nothing to capture and nothing to terminate early.
    if (!mcpToolsEnabled && this.toolPolicy === 'dsh-owned' && toolSchemaCount > 0) return false
    if (toolSchemaCount > 0 && dshContextSnapshot?.state !== 'ready') return false
    return true
  }

  private async *streamPersistentAttempt(
    options: GenerateOptions,
    sessionKey: string,
    telemetry: AgyTelemetry,
    route: EffectiveAgyRoute,
    prepared: PreparedAgyPrompts,
    toolProtocol: StructuredToolProtocol | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
    protocolRepair: boolean,
    protocolRepairHint: Pick<
      ToolProtocolArgumentDiagnostic,
      'toolName' | 'issue' | 'missingRequiredKeys'
    > | undefined,
    protocolRepairReason: ToolProtocolRepairReason | undefined,
    mcpToolsEnabled = false,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    if (toolProtocol !== undefined && (
      dshContextSnapshot?.state !== 'ready'
      || dshContextSnapshot.sessionState !== 'trusted'
      || dshContextSnapshot.workspaceState !== 'trusted'
    )) {
      throw new DshContextError(DSH_CONTEXT_UNAVAILABLE_CODE)
    }
    telemetry.processAttemptCount += 1
    const mappedConversationId = this.sessions.get(sessionKey)?.conversationId
    const hasConversation = mappedConversationId !== undefined
    const basePrompt = hasConversation
      ? (prepared.turnPrompt ?? serializeAgyTurnPrompt(options))
      : prepared.fullPrompt
    const prompt = this.preparePrompt(basePrompt, toolProtocol, protocolRepair, protocolRepairHint, protocolRepairReason, telemetry)
    // Persistent worker is session-affine, single active turn, reuse AGY conversation
    telemetry.dispatch = 'persistent'
    const dispatchStartedAt = Date.now()
    // Stream-chunk shape: the host renders each delta as it arrives, so the
    // persistent worker must be consumed with an event callback and an async
    // queue, exactly like the one-shot path. Waiting for `request()` to resolve
    // would buffer the whole turn and show nothing until it finished.
    const queue = new AsyncQueue<AgyJsonEvent>()
    let persistentRequest: Promise<PersistentTransportResult> | undefined
    const requestPromise = this.persistentTransport!.request({
      sessionId: sessionKey,
      text: prompt,
      // The worker is seeded with the conversation, so an incremental prompt
      // can never land in a fresh AGY conversation. A worker that comes up
      // with a different id rejects the request instead of answering without
      // context, and the caller resends the full DSH history.
      ...(hasConversation ? { conversation: mappedConversationId } : {}),
      agent: route.agent,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(persistentExtraArgsOf(this.mode).length === 0
        ? {}
        : { extraArgs: persistentExtraArgsOf(this.mode) }),
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onEvent: payload => {
        const r = payload as Record<string, unknown>
        const ev = r.event as string | undefined
        if (ev === 'step_update') {
          const su = r.step_update as Record<string, unknown> | undefined
          queue.push({
            event: 'step_update',
            ...(su === undefined ? {} : { step_update: su }),
          } as AgyJsonEvent)
        } else if (ev === 'result') {
          const res = r.result as Record<string, unknown> | undefined
          queue.push({
            event: 'result',
            ...(res === undefined ? {} : { result: res }),
          } as AgyJsonEvent)
        }
      },
    })
    persistentRequest = requestPromise.then(result => {
      telemetry.firstEventMs = result.firstEventMs
      queue.end()
      return result
    }, error => {
      queue.fail(error)
      throw error
    })
    let blockStarted = false
    let finalResponse: string | undefined
    let finalStatus: string | undefined
    let finalErrorDetail: string | undefined
    // AGY's own reason when the turn failed. Kept apart from `finalErrorDetail`
    // because a failed turn can also carry a placeholder under `response`
    // ("(no content)"), and delivering a placeholder as the answer is worse
    // than delivering the partial text already streamed.
    let lastResultError: string | undefined
    let latestStepUsage: Record<string, unknown> | undefined
    let resultUsage: Record<string, unknown> | undefined
    // One consolidated reasoning block records the bridged tool steps, so the
    // transcript shows what AGY did without the host replaying any of it.
    let mcpStepsOpen = false
    let mcpStepsText = ''
    let mcpStepCount = 0
    let mcpBannerEmitted = false
    let modelText = ''
    try {
      for await (const event of queue) {
        const r = event as unknown as Record<string, unknown>
        const ev = r.event as string | undefined
        if (ev === 'step_update') {
          const su = r.step_update as Record<string, unknown> | undefined
          const usage = su?.usage as Record<string, unknown> | undefined
          const convId = su?.conversation_id as string | undefined
          if (convId !== undefined) {
            telemetry.conversationId = convId
            this.sessions.set(sessionKey, convId)
          }
          if (usage !== undefined) latestStepUsage = usage
          telemetry.firstEventMs ??= Date.now() - dispatchStartedAt
          telemetry.eventCount += 1
          telemetry.eventCategoryCounts[eventCategoryOf(event)] += 1
          recordToolEvent(telemetry, event)
          const internalToolError = dshOwnedToolEventError(event, toolProtocol)
          if (internalToolError !== undefined) throw internalToolError
        } else if (ev === 'result') {
          const res = r.result as Record<string, unknown> | undefined
          const convId = res?.conversation_id as string | undefined
          if (convId !== undefined) {
            telemetry.conversationId = convId
            this.sessions.set(sessionKey, convId)
          }
          finalResponse = typeof res?.response === 'string' ? res.response as string : undefined
          finalStatus = typeof res?.status === 'string' ? res.status as string : undefined
          finalErrorDetail = typeof res?.error === 'string' ? res.error as string : undefined
          lastResultError = finalErrorDetail
          telemetry.finalStatus = finalStatus
          telemetry.finalResultRaw ??= finalResultRawOf(event)
          telemetry.firstEventMs ??= Date.now() - dispatchStartedAt
          telemetry.eventCount += 1
          telemetry.eventCategoryCounts[eventCategoryOf(event)] += 1
          resultUsage = res?.usage as Record<string, unknown> | undefined
        }
        if (ev === 'step_update' && mcpToolsEnabled) {
          const step = mcpToolStepOf(event)
          if (step !== undefined) {
            const state = stepStateOf(event)
            if (state === 'DONE' || state === 'ERROR') {
              telemetry.toolCallCount += 1
              telemetry.bridgeOutcome = 'mcp-tools'
              if (!mcpStepsOpen) {
                mcpStepsOpen = true
                yield { type: 'block-start', index: 1, blockType: 'reasoning' }
              }
              if (!mcpBannerEmitted) {
                mcpBannerEmitted = true
                mcpStepsText += reasoningBanner()
                yield { type: 'reasoning-delta', index: 1, text: reasoningBanner() }
              }
              const line = mcpStepProcessLine(step, state)
              mcpStepsText += line
              mcpStepCount += 1
              yield { type: 'reasoning-delta', index: 1, text: line }
            }
            continue
          }
        }
        const delta = toolProtocol === undefined ? textDeltaOf(event) : undefined
        if (delta !== undefined && delta.length > 0) {
          telemetry.firstTextMs ??= Date.now() - dispatchStartedAt
          if (!blockStarted) {
            blockStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          modelText += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }
      }
      await persistentRequest
    } finally {
      queue.end()
      persistentRequest?.catch(() => undefined)
    }
    const mcpCloseLine = mcpStepCount > 0 ? reasoningCloseLine(mcpStepCount) : ''
    mcpStepsText = `${mcpStepsText}${mcpCloseLine}`
    const selectedUsage = latestStepUsage ?? resultUsage
    const usageSource: AgyUsageSource | undefined = latestStepUsage !== undefined
      ? 'step'
      : selectedUsage === undefined ? undefined : 'result-fallback'
    const attemptUsage = selectedUsage === undefined ? undefined : mapAgyUsage(selectedUsage)
    if (attemptUsage !== undefined) recordUsageTelemetry(telemetry, attemptUsage, usageSource!, resultUsage)
    if (toolProtocol !== undefined) {
      if (finalResponse === undefined) {
        throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'missing final response')
      }
      let envelope: ReturnType<typeof parseStructuredEnvelope>
      try {
        envelope = parseAgyToolEnvelope(
          finalResponse,
          toolProtocol,
          route.model,
          this.toolProtocolPlainTextFallback === 'final-message'
            && /^claude-/i.test(route.model),
          {
            onCompatibilityApplied: compatibility => {
              telemetry.protocolCompatibilityApplied = compatibility
            },
          },
        )
      } catch (error) {
        recordProtocolFailure(telemetry, finalResponse, error)
        throw error
      }
      if (envelope.kind === 'message') {
        telemetry.bridgeOutcome = 'dsh-message'
        // An empty envelope message is a turn with nothing to say: emit no text
        // block rather than a blank one (a blank assistant message makes the
        // host refuse `session/follow` for the whole session).
        if (envelope.content.length > 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: envelope.content }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: envelope.content } }
        }
        if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return { retryWithFullPrompt: false }
      }
      const callId = ToolCallId(randomUUID())
      const argumentsJson = JSON.stringify(envelope.arguments)
      telemetry.toolCallCount += 1
      telemetry.bridgeOutcome = 'dsh-tool-call'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: callId, name: envelope.name, argumentsDelta: argumentsJson }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: envelope.name, arguments: argumentsJson } }
      if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return { retryWithFullPrompt: false }
    }
    // Text-only: already yielded deltas, need to close block and finish.
    // `result.response` is the authoritative full answer; when no delta was
    // streamed (AGY spent the turn on tool steps and only summarised at the
    // end) emit it as the answer. Nothing to emit for a tool-only step: its
    // tool-call block is the whole record, and a blank text block would land in
    // the transcript as an empty assistant message (see the one-shot path).
    // A failed turn's `response` is a placeholder ("(no content)"): when real
    // text already streamed, keep that text and park AGY's reason as a
    // reasoning annotation; otherwise fail the turn exactly like one-shot —
    // delivering the placeholder as the answer is worse than either.
    const streamedPartialAnswer = finalStatus !== undefined
      && !isSuccessStatus(finalStatus)
      && modelText.trim().length > 0
    if (finalStatus !== undefined && !isSuccessStatus(finalStatus) && !streamedPartialAnswer) {
      const detail = [finalStatus, finalErrorDetail].filter(value => value !== undefined).join(' ')
      const code = classifyAgyFailure(detail, 'AGY_STATUS')
      throw new LlmError(safeAgyFailureMessage(`AGY returned status ${finalStatus}`, detail), code)
    }
    if (streamedPartialAnswer) telemetry.partialAnswerDelivered = true
    const appendFinalResponse = !streamedPartialAnswer && finalResponse !== undefined && finalResponse.trim().length > 0
    if (appendFinalResponse && finalResponse !== undefined) {
      const suffix = modelText.length === 0
        ? finalResponse
        : finalResponse.startsWith(modelText) ? finalResponse.slice(modelText.length) : ''
      if (suffix.length > 0) {
        if (!blockStarted) {
          blockStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        modelText += suffix
        yield { type: 'text-delta', index: 0, text: suffix }
      }
    }
    if (blockStarted) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: modelText } }
    }
    if (streamedPartialAnswer) {
      const reason = (lastResultError ?? finalErrorDetail ?? 'AGY reported status ERROR').trim()
      const line = `[agy finished with error] ${reason}\n\n`
      if (!mcpStepsOpen) {
        mcpStepsOpen = true
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      }
      if (!mcpBannerEmitted) {
        mcpBannerEmitted = true
        mcpStepsText += reasoningBanner()
        yield { type: 'reasoning-delta', index: 1, text: reasoningBanner() }
      }
      mcpStepsText += line
      yield { type: 'reasoning-delta', index: 1, text: line }
    }
    if (mcpStepsOpen) {
      if (mcpCloseLine !== '') {
        yield { type: 'reasoning-delta', index: 1, text: mcpCloseLine }
      }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: mcpStepsText } }
    } else if (!blockStarted && telemetry.toolCallCount === 0) {
      // Same invariant as the one-shot path: a text-only turn that produced
      // nothing is a failure the host can retry, never a silent success.
      throw new LlmError('AGY completed without a text response', EMPTY_RESPONSE_CODE)
    }
    if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { retryWithFullPrompt: false }
  }

    private async effectiveModels(): Promise<readonly ModelConfig[]> {
    if (this.discovery === undefined) {
      this.currentModels = filterVisibleModels(this.models, this.visibleModels)
      this.modelDiscoveryResult = undefined
      return this.currentModels
    }
    const result = await this.discovery.discover(this.models)
    // result.models already normalized to base via mergeModelCatalog; apply visible filter
    const filtered = filterVisibleModels(result.models, this.visibleModels)
    this.currentModels = filtered
    this.modelDiscoveryResult = { ...result, models: filtered }
    return this.currentModels
  }

  override async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk, void, void> {
    if (options.signal?.aborted) throw abortError()
    const toolSchemaCount = options.tools?.length ?? 0
    const sessionKey = options.sessionId === undefined ? undefined : String(options.sessionId)
    // Choose the tool transport once per request. The MCP bridge carries the
    // schemas out of band, so the prompt keeps its whole budget for history and
    // AGY emits real tool events that the DSH transcript can render.
    const toolBridge = toolSchemaCount > 0 && this.toolPolicy === 'dsh-owned' && this.mcpBridgeEnabled
      ? this.resolveToolBridge?.()
      : undefined
    const useToolBridge = toolBridge?.active === true
    if (useToolBridge && sessionKey !== undefined) toolBridge.setSession(sessionKey)
    let toolProtocol: StructuredToolProtocol | undefined
    let dshContextSnapshot: DshContextSnapshot | undefined
    const purposeRoute = purposeRouteFor(options.purpose, this.purposeRoutes)
    const requestedReasoningEffort = normalizeReasoningEffort(options.reasoningEffort)
    const purposeReasoningEffort = normalizeReasoningEffort(purposeRoute?.reasoningEffort)
    // Normalize model id and extract effort suffix for backward compat (e.g. gemini-3.7-flash-high)
    const rawModel = purposeRoute?.model ?? (options.model || this.model)
    const baseModel = normalizeModelId(rawModel)
    const suffixEffort = extractModelEffort(rawModel)
    // AGY 1.1.17+ requires --effort for gemini-* flash/pro models (low/high/medium variants), but claude-* does NOT support --effort.
    // When nothing higher in the chain chose an effort, the last-resort default is the
    // user's panel setting (runtime overrides file) if present, else the built-in 'high'
    // for gemini-* to avoid AGY_REQUEST "requires --effort".
    const defaultEffortForModel = baseModel.toLowerCase().startsWith('gemini-')
      ? (readDefaultEffortOverride() ?? 'high') as AgyReasoningEffort
      : undefined
    let effectiveEffort: AgyReasoningEffort | undefined = purposeReasoningEffort ?? requestedReasoningEffort ?? suffixEffort ?? defaultEffortForModel
    // Claude models in AGY 1.1.17 report "is not supported for model" when --effort is sent; suppress for claude-*
    if (baseModel.toLowerCase().startsWith('claude-')) effectiveEffort = undefined
    const route: EffectiveAgyRoute = {
      model: baseModel,
      agent: purposeRoute?.agent ?? this.agent,
      reasoningEffort: effectiveEffort,
    }
    let existingConversationId = sessionKey === undefined || this.sessionMode === 'full'
      ? undefined
      : this.sessions.get(sessionKey)?.conversationId
    // History fingerprint check (design borrowed from dsh-agy-safe's chain):
    // a resumed turn re-serializes the prefix of the DSH history the record
    // says AGY already holds. If the host edited, compacted or truncated that
    // prefix, the fingerprint no longer matches and the turn falls back to the
    // full-history replay instead of landing a delta prompt on stale context.
    let existingRecord: SessionRecord | undefined
    let fingerprintMismatch = false
    if (sessionKey !== undefined && this.sessionMode === 'resume') {
      existingRecord = this.sessions.get(sessionKey)
      if (existingRecord?.chainHash !== undefined && existingRecord.messageCount !== undefined) {
        const expected = historyFingerprintOf(options.messages.slice(0, existingRecord.messageCount), options.system)
        fingerprintMismatch = expected !== existingRecord.chainHash
        if (fingerprintMismatch) {
          // The AGY conversation was built on a history that no longer exists
          // (edited, compacted, truncated). It is unusable in both shapes — a
          // delta lands on stale context and a full replay would duplicate it —
          // so the binding is dropped and the turn bootstraps a fresh one.
          this.sessions.delete(sessionKey)
          existingRecord = undefined
          existingConversationId = undefined
        }
      }
    }
    const initialRequestMode = this.sessionMode === 'full'
      ? 'full' as const
      : existingConversationId === undefined || fingerprintMismatch
        ? 'bootstrap' as const
        : 'delta' as const

    const telemetry: AgyTelemetry = {
      requestId: randomUUID(),
      provider: options.provider,
      model: route.model,
      agent: route.agent,
      toolPolicy: this.toolPolicy,
      toolSchemaCount,
      toolCallCount: 0,
      bridgeOutcome: toolSchemaCount === 0
        ? 'text-only'
        : this.toolPolicy === 'dsh-owned'
          ? 'dsh-pending'
          : this.toolPolicy === 'agy-owned' ? 'agy-owned' : 'schema-rejected',
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
      ...(this.discovery === undefined
        ? { modelDiscoverySource: 'static' as const }
        : this.modelDiscoveryResult === undefined
          ? {}
          : {
              modelDiscoverySource: this.modelDiscoveryResult.source,
              ...(this.modelDiscoveryResult.warningCode === undefined
                ? {}
                : { modelDiscoveryWarningCode: this.modelDiscoveryResult.warningCode }),
            }),
      sessionId: sessionKey,
      requestMode: initialRequestMode,
      conversationReused: existingConversationId !== undefined,
      startedAt: Date.now(),
      attempt: 1,
      processAttemptCount: 0,
      retryMaxRetries: this.retryPolicy.mode === 'normal' ? this.retryPolicy.maxRetries : 0,
      inputFrameBytes: undefined,
      inputFrameLimitBytes: undefined,
      promptBytes: undefined,
      promptLimitBytes: undefined,
      toolResultCount: undefined,
      largestToolResultBytes: undefined,
      truncatedToolResultCount: undefined,
      historyCompacted: false,
      omittedMessageCount: 0,
      toolEventKind: undefined,
      toolEventStreamIndex: undefined,
      toolEventDiagnostic: undefined,
      carrierAbortExpected: false,
      carrierValidation: undefined,
      protocolRepairAttempts: 0,
      protocolRepairReason: undefined,
      protocolFailureDetail: undefined,
      protocolResponseShape: undefined,
      protocolResponseBytes: undefined,
      protocolToolName: undefined,
      protocolArgumentIssue: undefined,
      protocolMissingRequiredKeys: undefined,
      protocolReceivedArgumentKeys: undefined,
      protocolCompatibilityApplied: undefined,
      eventCount: 0,
      toolEventCount: 0,
      permissionEventCount: 0,
      eventCategoryCounts: emptyAgyEventCategoryCounts(),
      dispatch: undefined,
      firstEventMs: undefined,
      firstTextMs: undefined,
      finalStatus: undefined,
      finalResultRaw: undefined,
      conversationId: undefined,
      queueWaitMs: undefined,
      process: undefined,
      usage: undefined,
      usageSource: undefined,
      cumulativeUsage: undefined,
      cacheHit: undefined,
      cacheTokenShare: undefined,
      conversationMismatch: undefined,
      partialAnswerDelivered: undefined,
      stablePrefixBytes: undefined,
      stablePrefixHash: undefined,
      toolSchemaHash: undefined,
      processDiagnostic: undefined,
      durationMs: undefined,
    }
    emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.started'))

    let releaseSession: (() => void) | undefined
    let releaseProcess: (() => void) | undefined
    let preparedPrompts: PreparedAgyPrompts | undefined
    try {
      if (toolSchemaCount > 0 && this.toolPolicy === 'dsh-owned') {
        dshContextSnapshot = await resolveDshContext(this.dshContext, {
          ...(sessionKey === undefined ? {} : { sessionId: sessionKey }),
          toolSchemaCount,
        })
        setDshTelemetrySnapshot(telemetry, dshContextSnapshot)
        // Under the MCP bridge the tool catalogue travels out of band, so the
        // prompt contract is neither built nor appended; only the fail-closed
        // capability check above still runs.
        if (dshContextSnapshot !== undefined && !useToolBridge) {
          try {
            toolProtocol = createStructuredToolProtocol(options.tools ?? [])
          } catch (error) {
            telemetry.bridgeOutcome = 'schema-rejected'
            throw error
          }
        }
        if (useToolBridge) telemetry.bridgeOutcome = 'mcp-tools'
      }
      if (toolSchemaCount > 0 && this.toolPolicy === 'reject') {
        throw new LlmError(
          'AGY text MVP does not accept DSH tool schemas under toolPolicy: reject; set toolPolicy: dsh-owned or agy-owned explicitly',
          UNSUPPORTED_TOOLS_CODE,
        )
      }
      if (options.temperature !== undefined || options.maxTokens !== undefined || options.stop !== undefined) {
        // 0.9.0 fix: DSH web may send default temperature/maxTokens/stop; AGY does not support them.
        // Do not block the request; continue with AGY defaults (previously threw UNSUPPORTED_OPTIONS).
      }
      const prepared = await prepareAgyPrompts(options, {
        enabled: this.imageInput === 'experimental',
        agentCanViewFile: this.imageAgent?.agentCanViewFile === true,
        attachmentStore: this.resolveAttachmentStore(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      preparedPrompts = prepared
      releaseSession = sessionKey === undefined ? undefined : await this.sessions.acquire(sessionKey)
      const queueStartedAt = Date.now()
      releaseProcess = await this.limiter.acquire(options.signal)
      telemetry.queueWaitMs = Date.now() - queueStartedAt

      // V8-M2 persistent dispatch: one Session one worker, before-accept fallback
      if (this.shouldUsePersistent(
        options,
        sessionKey,
        dshContextSnapshot,
        toolSchemaCount,
        prepared.bridgeActive,
        useToolBridge,
      )) {
        let persistentRepairAttempts = 0
        let persistentProtocolRepair = false
      let persistentProtocolRepairHint: Pick<
          ToolProtocolArgumentDiagnostic,
        'toolName' | 'issue' | 'missingRequiredKeys'
      > | undefined
        let persistentProtocolRepairReason: ToolProtocolRepairReason | undefined
        while (true) {
          try {
            telemetry.attempt = persistentRepairAttempts + 1
            const outcome = yield* this.streamPersistentAttempt(
              options,
              sessionKey!,
              telemetry,
              route,
              prepared,
              toolProtocol,
              dshContextSnapshot,
              persistentProtocolRepair,
              persistentProtocolRepairHint,
              persistentProtocolRepairReason,
              useToolBridge,
            )
            persistentProtocolRepair = false
            persistentProtocolRepairHint = undefined
            persistentProtocolRepairReason = undefined
            if (!outcome.retryWithFullPrompt) {
              // Success: the AGY conversation now holds exactly this turn's DSH
              // history, so the fingerprint chain advances to this request.
              if (sessionKey !== undefined && options.purpose === undefined && telemetry.conversationId !== undefined && telemetry.carrierAbortExpected !== true) {
                this.sessions.set(sessionKey, telemetry.conversationId, fingerprintAfterTurn(options))
              }
              telemetry.durationMs = Date.now() - telemetry.startedAt
              emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.completed'))
              return
            }
            break
          } catch (error) {
            if (toolProtocol !== undefined
              && isRepairableAgyRequestError(error)
              && persistentRepairAttempts < this.toolProtocolRepairRetries) {
              persistentRepairAttempts += 1
              telemetry.protocolRepairAttempts += 1
              persistentProtocolRepair = true
              persistentProtocolRepairHint = protocolRepairHintOf(error)
              persistentProtocolRepairReason = protocolRepairReasonOf(error)
              if (persistentProtocolRepairReason !== undefined) telemetry.protocolRepairReason = persistentProtocolRepairReason
              continue
            }
            const errorCode = error instanceof Error && (error as any).code !== undefined
              ? String((error as any).code)
              : undefined
            if (errorCode === 'CONVERSATION_MISMATCH') {
              // The stored AGY conversation is not the one a fresh worker came
              // up with (stale id, evicted conversation, different route).
              // This is raised at worker start, before any delta, so dropping the
              // binding and falling through to the full-history one-shot turn
              // costs one resend and cannot truncate a visible answer.
              if (sessionKey !== undefined) this.sessions.delete(sessionKey)
              telemetry.conversationMismatch = true
              break
            }
            const beforeAccept = errorCode !== undefined
              ? ['WORKER_START_FAILED','WORKER_LIMIT','DISPOSED','ABORTED','WORKER_STOPPED'].includes(errorCode)
              : false
            if (this.persistentFallback === 'before-accept' && beforeAccept) {
              // fallback to one-shot, keep telemetry for retry
              break
            }
            throw error
          }
        }
      }

      let requestedConversationId = sessionKey === undefined || this.sessionMode === 'full'
        ? undefined
        : this.sessions.get(sessionKey)?.conversationId

      if (telemetry.conversationMismatch === true) {
        // A persistent worker could not continue the stored conversation; the
        // binding is already dropped, so this turn runs one-shot from the full
        // DSH history. Mark the mode so telemetry shows why it was resent.
        telemetry.requestMode = 'full-fallback'
        requestedConversationId = undefined
      }

      let protocolRepairAttempts = 0
      let protocolRepair = false
      let protocolRepairHint: Pick<
        ToolProtocolArgumentDiagnostic,
        'toolName' | 'issue' | 'missingRequiredKeys'
      > | undefined
      let protocolRepairReason: ToolProtocolRepairReason | undefined
      for (let attempt = 0; attempt < 2 + this.toolProtocolRepairRetries; attempt += 1) {
        telemetry.attempt = attempt + 1
        let outcome: AttemptOutcome
        try {
          outcome = yield* this.streamAttempt(
            options,
            sessionKey,
            requestedConversationId,
            telemetry,
            route,
            prepared,
            toolProtocol,
            dshContextSnapshot,
            protocolRepair,
            protocolRepairHint,
            protocolRepairReason,
            useToolBridge,
          )
          protocolRepair = false
          protocolRepairHint = undefined
          protocolRepairReason = undefined
        } catch (error) {
          if (toolProtocol !== undefined
            && isRepairableAgyRequestError(error)
            && protocolRepairAttempts < this.toolProtocolRepairRetries) {
            protocolRepairAttempts += 1
            telemetry.protocolRepairAttempts += 1
            protocolRepair = true
            protocolRepairHint = protocolRepairHintOf(error)
            protocolRepairReason = protocolRepairReasonOf(error)
            if (protocolRepairReason !== undefined) {
              telemetry.protocolRepairReason = protocolRepairReason
              requestedConversationId = undefined
            }
            continue
          }
          throw error
        }
        if (!outcome.retryWithFullPrompt) {
          // Success: the AGY conversation now holds exactly this turn's DSH
          // history, so the fingerprint chain advances to this request.
          if (sessionKey !== undefined && options.purpose === undefined && telemetry.conversationId !== undefined && telemetry.carrierAbortExpected !== true) {
            this.sessions.set(sessionKey, telemetry.conversationId, fingerprintAfterTurn(options))
          }
          telemetry.durationMs = Date.now() - telemetry.startedAt
          emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.completed'))
          return
        }
        telemetry.requestMode = 'full-fallback'
        requestedConversationId = undefined
      }
      throw new LlmError(
        'AGY conversation could not be resumed; full DSH history retry failed',
        'SESSION_RESUME_FAILED',
      )
    } catch (error) {
      telemetry.processDiagnostic = agyProcessDiagnosticOf(error)
      const mapped = asLlmError(error)
      telemetry.bridgeOutcome = bridgeOutcomeForError(mapped.code, telemetry.bridgeOutcome)
      telemetry.durationMs = Date.now() - telemetry.startedAt
      emitAgyLog(this.logger, buildAgyLogRecord(telemetry, 'agy.request.failed', mapped.code))
      throw mapped
    } finally {
      telemetry.durationMs ??= Date.now() - telemetry.startedAt
      await preparedPrompts?.cleanup()
      releaseProcess?.()
      releaseSession?.()
    }
  }

  private async *streamAttempt(
    options: GenerateOptions,
    sessionKey: string | undefined,
    requestedConversationId: string | undefined,
    telemetry: AgyTelemetry,
    route: EffectiveAgyRoute,
    prepared: PreparedAgyPrompts,
    toolProtocol: StructuredToolProtocol | undefined,
    dshContextSnapshot: DshContextSnapshot | undefined,
    protocolRepair: boolean,
    protocolRepairHint: Pick<
      ToolProtocolArgumentDiagnostic,
      'toolName' | 'issue' | 'missingRequiredKeys'
    > | undefined,
    protocolRepairReason: ToolProtocolRepairReason | undefined,
    mcpToolsEnabled = false,
  ): AsyncGenerator<StreamChunk, AttemptOutcome, void> {
    if (toolProtocol !== undefined && (
      dshContextSnapshot?.state !== 'ready'
      || dshContextSnapshot.sessionState !== 'trusted'
      || dshContextSnapshot.workspaceState !== 'trusted'
    )) {
      throw new DshContextError(DSH_CONTEXT_UNAVAILABLE_CODE)
    }
    telemetry.processAttemptCount += 1
    const basePrompt = requestedConversationId === undefined
      ? prepared.fullPrompt
      : prepared.turnPrompt ?? serializeAgyTurnPrompt(options)
    const prompt = this.preparePrompt(basePrompt, toolProtocol, protocolRepair, protocolRepairHint, protocolRepairReason, telemetry)
    const addDirs = [
      ...(this.addDirs ?? []),
      ...(prepared.imageDirectory === undefined ? [] : [prepared.imageDirectory]),
      ...(prepared.imageCacheDirectory === undefined ? [] : [prepared.imageCacheDirectory]),
    ]
    const imageRuntime = prepared.bridgeActive ? this.imageAgent : undefined
    const requestMode = imageRuntime?.mode ?? this.mode
    const requestDisableSlashCommands = imageRuntime?.disableSlashCommands ?? this.disableSlashCommands
    const queue = new AsyncQueue<AgyJsonEvent>()
    const parser = new AgyStreamParser({ maxLineLength: this.maxEventLineLength })
    const controller = new AbortController()
    const forwardAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', forwardAbort, { once: true })

    let result: ProcessResult | undefined
    let settled = false
    const request: AgyRequest = {
      prompt,
      agent: imageRuntime?.agent ?? route.agent,
      model: route.model,
      timeoutMs: this.timeoutMs,
      idleTimeoutMs: this.idleTimeoutMs,
      maxStdoutBytes: this.maxOutputBytes,
      maxStderrBytes: this.maxOutputBytes,
      maxInputFrameBytes: this.inputFrameLimitBytes,
      stdinMode: this.stdinMode,
      signal: controller.signal,
      onStdoutLine: line => {
        for (const event of parser.push(`${line}\n`)) queue.push(event)
      },
      ...(requestedConversationId === undefined ? {} : { conversation: requestedConversationId }),
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(this.agyPath === undefined ? {} : { executable: this.agyPath }),
      ...(this.workspaceRoot === undefined ? {} : { cwd: this.workspaceRoot }),
      ...(addDirs.length === 0 ? {} : { addDirs }),
      ...(requestMode === undefined ? {} : { mode: requestMode }),
      ...(requestDisableSlashCommands === undefined ? {} : { disableSlashCommands: requestDisableSlashCommands }),
    }
    // Cold dispatch: the AGY process is spawned for this attempt, so the whole
    // startup cost (spawn, auth, MCP handshake) shows up before the first event.
    telemetry.dispatch = 'cold'
    const dispatchStartedAt = Date.now()
    const processPromise = this.run(request).then(processResultValue => {
      result = processResultValue
      telemetry.process = processResultValue
      settled = true
      for (const event of parser.end()) queue.push(event)
      queue.end()
    }).catch(error => {
      settled = true
      queue.fail(error)
    })

    let blockStarted = false
    // One consolidated reasoning block (index 1) records the bridged tool steps
    // and, when the turn was cut short, AGY's own reason for it. The block opens
    // lazily so a turn with neither keeps its plain text-only shape.
    let mcpStepsOpen = false
    let mcpStepsText = ''
    let mcpStepCount = 0
    let mcpBannerEmitted = false
    let modelText = ''
    let resultSeen = false
    let finalResponse: string | undefined
    let finalStatus: string | undefined
    let finalErrorDetail: string | undefined
    // AGY's own reason when the turn failed. Kept apart from `finalErrorDetail`
    // because a failed turn can also carry a placeholder under `response`
    // ("(no content)"), and delivering a placeholder as the answer is worse
    // than delivering the partial text already streamed.
    let lastResultError: string | undefined
    let latestStepUsage: Record<string, unknown> | undefined
    let resultUsage: Record<string, unknown> | undefined
    let fallbackUsage: Record<string, unknown> | undefined
    let conversationMismatch = false
    let activeConversationId: string | undefined
    let permissionRequested = false
    let carrierResponseAccepted = false

    try {
      for await (const event of queue) {
        if (carrierResponseAccepted) continue
        telemetry.firstEventMs ??= Date.now() - dispatchStartedAt
        telemetry.eventCount += 1
        telemetry.eventCategoryCounts[eventCategoryOf(event)] += 1
        const observedConversationId = conversationIdOf(event)
        if (observedConversationId !== undefined) {
          activeConversationId = observedConversationId
          telemetry.conversationId = observedConversationId
          if (requestedConversationId !== undefined && observedConversationId !== requestedConversationId) {
            conversationMismatch = true
            controller.abort()
          } else if (sessionKey !== undefined) {
            this.sessions.set(sessionKey, observedConversationId)
          }
        }
        recordToolEvent(telemetry, event, activeConversationId)
        if (conversationMismatch) continue
        if (toolProtocol !== undefined) {
          const carrierResponse = dshOwnedCarrierResponseOf(
            event,
            toolProtocol,
            activeConversationId,
            telemetry,
          )
          if (carrierResponse !== undefined) {
            carrierResponseAccepted = true
            resultSeen = true
            finalResponse = carrierResponse
            finalStatus = 'SUCCESS'
            telemetry.finalStatus = finalStatus
            telemetry.bridgeOutcome = 'dsh-tool-call'
            telemetry.carrierAbortExpected = true
            // The wrapper conversation has just emitted an internal carrier.
            // Do not resume that potentially tainted AGY session on the next
            // DSH turn; the next request must start from the full DSH history.
            if (sessionKey !== undefined) this.sessions.delete(sessionKey)
            // No DSH service is attached to AGY's internal default_api in
            // this mode. Stop the wrapper after capturing the validated
            // envelope; runProcess maps this expected abort below.
            controller.abort()
            continue
          }
        }
        const internalToolError = dshOwnedToolEventError(
          event,
          toolProtocol,
          { prepared, runtime: imageRuntime },
          mcpToolsEnabled,
        )
        if (internalToolError !== undefined) {
          telemetry.bridgeOutcome = 'agy-internal-tool'
          if (sessionKey !== undefined) this.sessions.delete(sessionKey)
          controller.abort()
          throw internalToolError
        }
        if (isPermissionEvent(event)) telemetry.permissionEventCount += 1
        const errorDetail = errorDetailOf(event)
        if (errorDetail !== undefined) finalErrorDetail = errorDetail
        if (isPermissionEvent(event)) {
          if (toolProtocol !== undefined) telemetry.bridgeOutcome = 'permission-required'
          permissionRequested = true
          controller.abort()
          continue
        }

        if (mcpToolsEnabled) {
          // Bridge mode keeps both channels live: AGY narrates through ordinary
          // text deltas and every DSH tool call arrives as an MCP step. The step
          // is recorded as a reasoning line, NOT as a DSH tool-call block. The
          // bridge has already run the tool; advertising it again makes the host
          // execute the block it just committed (`dsh-agent-loop` filters the
          // committed message for `tool-call` blocks and runs `executeToolCalls`
          // on them) — that replayed side effects, re-asked approval, and made
          // AGY answer the same work a second time.
          const step = mcpToolStepOf(event)
          if (step !== undefined) {
            const state = stepStateOf(event)
            if (state === 'DONE' || state === 'ERROR') {
              telemetry.toolCallCount += 1
              telemetry.bridgeOutcome = 'mcp-tools'
              if (!mcpStepsOpen) {
                mcpStepsOpen = true
                yield { type: 'block-start', index: 1, blockType: 'reasoning' }
              }
              if (!mcpBannerEmitted) {
                mcpBannerEmitted = true
                mcpStepsText += reasoningBanner()
                yield { type: 'reasoning-delta', index: 1, text: reasoningBanner() }
              }
              const line = mcpStepProcessLine(step, state)
              mcpStepsText += line
              mcpStepCount += 1
              yield { type: 'reasoning-delta', index: 1, text: line }
            }
            // The MCP plumbing step carries no model text, but other step
            // shapes (agent_response) do, so fall through to the text channel
            // instead of skipping the event outright.
            if (step !== undefined) continue
          }
        }

        const delta = toolProtocol === undefined ? textDeltaOf(event) : undefined
        if (delta !== undefined && delta.length > 0) {
          telemetry.firstTextMs ??= Date.now() - dispatchStartedAt
          if (!blockStarted) {
            blockStarted = true
            yield { type: 'block-start', index: 0, blockType: 'text' }
          }
          modelText += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }

        if (event.event === 'result') {
          if (toolProtocol !== undefined && resultSeen) {
            controller.abort()
            throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'duplicate final response')
          }
          resultSeen = true
          finalResponse = responseOf(event)
          finalStatus = statusOf(event)
          telemetry.finalStatus = finalStatus
          resultUsage = usageOf(event)
          // The `result` event can carry AGY's own failure detail under
          // `error` (e.g. its AGY_ERROR trailer with `"retryable": true`).
          // Without this, `finalErrorDetail` stays empty and a failed turn
          // degrades to the detail-less `AGY returned status ERROR: ERROR`.
          if (finalErrorDetail === undefined) {
            const resultRecord = event.event === 'result' && isRecord(event.result) ? event.result : undefined
            const resultError = typeof resultRecord?.error === 'string' ? (resultRecord.error as string) : undefined
            if (resultError !== undefined && resultError.trim().length > 0) finalErrorDetail = resultError
          }
          lastResultError = finalErrorDetail
          if (telemetry.finalResultRaw === undefined) telemetry.finalResultRaw = finalResultRawOf(event)
        }
        const usage = usageOf(event)
        if (usage !== undefined && event.event === 'step_update') latestStepUsage = usage
        else if (usage !== undefined && event.event !== 'result') fallbackUsage = usage
      }
      await processPromise
    } catch (error) {
      throw asLlmError(error)
    } finally {
      if (!settled) controller.abort()
      await processPromise
      options.signal?.removeEventListener('abort', forwardAbort)
    }

    const selectedUsage = latestStepUsage ?? fallbackUsage ?? resultUsage
    const usageSource: AgyUsageSource | undefined = latestStepUsage !== undefined
      ? 'step'
      : selectedUsage === undefined ? undefined : 'result-fallback'
    const attemptUsage = selectedUsage === undefined ? undefined : mapAgyUsage(selectedUsage)
    if (attemptUsage !== undefined) recordUsageTelemetry(telemetry, attemptUsage, usageSource!, resultUsage)

    if (conversationMismatch) return { retryWithFullPrompt: true }
    if (permissionRequested) {
      if (toolProtocol !== undefined) telemetry.bridgeOutcome = 'permission-required'
      throw new LlmError(
        'AGY requested interactive permission; headless Provider cannot approve it. Adjust AGY Agent permissions or tool configuration',
        PERMISSION_REQUIRED_CODE,
      )
    }

    const failure = carrierResponseAccepted
      ? undefined
      : result === undefined
        ? new LlmError('AGY process did not return a result', 'AGY_PROCESS')
        : processFailure(result)
    if (failure !== undefined) throw failure
    // AGY reports `status: ERROR` on a turn it cut short, and it can carry a
    // placeholder under `response` ("(no content)") instead of the answer. When
    // the user already watched real text stream in, keep that text, park AGY's
    // reason as a reasoning annotation, and finish normally: throwing here makes
    // the host roll the stream back and replay the whole turn, and the replay
    // reads the same broken context, so it fails identically every attempt.
    // agy-link does exactly this (its `consumable` test at src/host/adapter.ts:
    // 1508 and the result branch at src/host/mapper.ts:400-428); the difference
    // is that a placeholder response is not deliverable content, so the streamed
    // text decides whether anything survives.
    const streamedPartialAnswer = resultSeen && !isSuccessStatus(finalStatus) && modelText.trim().length > 0
    if (streamedPartialAnswer) telemetry.partialAnswerDelivered = true
    if (resultSeen && !isSuccessStatus(finalStatus) && !streamedPartialAnswer) {
      const detail = [finalStatus, finalErrorDetail].filter(value => value !== undefined).join(' ')
      const code = classifyAgyFailure(detail, 'AGY_STATUS')
      throw new LlmError(safeAgyFailureMessage(`AGY returned status ${finalStatus}`, detail), code)
    }
    if (!resultSeen && finalErrorDetail !== undefined) {
      const code = classifyAgyFailure(finalErrorDetail, 'AGY_STATUS')
      throw new LlmError(safeAgyFailureMessage('AGY reported a failure', finalErrorDetail), code)
    }

    if (toolProtocol !== undefined) {
      if (finalResponse === undefined) {
        throw new ToolProtocolError(TOOL_PROTOCOL_RESPONSE_INVALID_CODE, 'missing final response')
      }
      let envelope: ReturnType<typeof parseStructuredEnvelope>
      try {
          envelope = parseAgyToolEnvelope(
          finalResponse,
          toolProtocol,
          route.model,
          this.toolProtocolPlainTextFallback === 'final-message'
            && /^claude-/i.test(route.model),
          {
            onCompatibilityApplied: compatibility => {
              telemetry.protocolCompatibilityApplied = compatibility
            },
          },
        )
      } catch (error) {
        recordProtocolFailure(telemetry, finalResponse, error)
        throw error
      }
      if (envelope.kind === 'message') {
        telemetry.bridgeOutcome = 'dsh-message'
        // An empty envelope message is a turn with nothing to say: emit no text
        // block rather than a blank one (a blank assistant message makes the
        // host refuse `session/follow` for the whole session).
        if (envelope.content.length > 0) {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: envelope.content }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: envelope.content } }
        }
        if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return { retryWithFullPrompt: false }
      }
      const callId = ToolCallId(randomUUID())
      const argumentsJson = JSON.stringify(envelope.arguments)
      telemetry.toolCallCount += 1
      telemetry.bridgeOutcome = 'dsh-tool-call'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        name: envelope.name,
        argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: callId,
          name: envelope.name,
          arguments: argumentsJson,
        },
      }
      if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return { retryWithFullPrompt: false }
    }

    // A failed turn's `response` is a placeholder ("(no content)"); appending it
    // would write that placeholder into the answer. The streamed text is the
    // real partial answer, so leave it as it stands.
    const appendFinalResponse = !streamedPartialAnswer && finalResponse !== undefined && finalResponse.trim().length > 0
    if (appendFinalResponse && finalResponse !== undefined) {
      const suffix = modelText.length === 0
        ? finalResponse
        : finalResponse.startsWith(modelText) ? finalResponse.slice(modelText.length) : ''
      if (suffix.length > 0) {
        if (!blockStarted) {
          blockStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        modelText += suffix
        yield { type: 'text-delta', index: 0, text: suffix }
      }
    }

    if (blockStarted) {
      yield { type: 'block-end', index: 0, block: { type: 'text', text: modelText } }
    }
    // AGY's own reason for a cut-short turn belongs in the same reasoning block
    // as the bridged tool steps, so the transcript gets one annotation, not two.
    if (streamedPartialAnswer) {
      const reason = (lastResultError ?? finalErrorDetail ?? 'AGY reported status ERROR').trim()
      const line = `[agy finished with error] ${reason}\n\n`
      if (!mcpStepsOpen) {
        mcpStepsOpen = true
        yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      }
      if (!mcpBannerEmitted) {
        mcpBannerEmitted = true
        mcpStepsText += reasoningBanner()
        yield { type: 'reasoning-delta', index: 1, text: reasoningBanner() }
      }
      mcpStepsText += line
      yield { type: 'reasoning-delta', index: 1, text: line }
    }
    const mcpCloseLine = mcpStepCount > 0 ? reasoningCloseLine(mcpStepCount) : ''
    mcpStepsText = `${mcpStepsText}${mcpCloseLine}`
    if (mcpStepsOpen) {
      if (mcpCloseLine !== '') {
        yield { type: 'reasoning-delta', index: 1, text: mcpCloseLine }
      }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: mcpStepsText } }
    } else if (!blockStarted && telemetry.toolCallCount === 0) {
      throw new LlmError('AGY completed without a text response', EMPTY_RESPONSE_CODE)
    }
    // A tool-only turn with no narration and no recorded step still succeeds:
    // an empty text block is not harmless — it lands in the transcript as a
    // blank assistant message, and a session holding one is refused by the
    // host's `session/follow` (pocket then retries it forever). Throwing
    // EMPTY_RESPONSE would be worse, since the code is retryable and would
    // re-run side effects that already happened.
    if (attemptUsage !== undefined) yield { type: 'usage', usage: attemptUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
    return { retryWithFullPrompt: false }
  }
}
