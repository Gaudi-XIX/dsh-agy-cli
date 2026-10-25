/**
 * DSH bundle entry point.
 *
 * The bundle patch carries explicit ready defaults for DSH profile installs.
 * Keep the public programmatic Config schema safe for direct library callers;
 * BundleConfig is available when a caller explicitly wants bundle defaults.
 */
import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync } from 'node:fs'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { AgyAdapter } from './provider/agy.js'
import {
  BundleConfig,
  Config as ConfigSchema,
  createConfigSchema,
  type Config as ConfigType,
} from './provider/config.js'
import type { ModelConfig, ToolPolicy } from './provider/config.js'
import { MockAdapter } from './provider/mock.js'
import { AgyModelDiscovery } from './agy/models.js'
import { appendAgyDiagnosticRecord, AGY_DIAGNOSTIC_LOG_PATH } from './agy/log.js'
import { configuredModels, readConfigFlag } from './provider/config.js'
import { SessionRegistry } from './session/store.js'
import { FileSessionStore, resolveSessionStorePath } from './session/file-store.js'
import type { DshContextLookup } from './dsh/context.js'

export const name = 'dsh-agy-cli'
export const inject = ['llm', 'sessions', 'workspaceRegistry', 'sandboxPolicy', 'permissionPresets', 'approval']

/** Programmatic library default: enabled=false, toolPolicy=reject. */
export const Config = ConfigSchema
export { AgyAdapter, MockAdapter }
export { AgyModelDiscovery, mergeModelCatalog, parseAgyModels } from './agy/models.js'
export { diagnoseAgy } from './agy/diagnostics.js'
export { diagnoseProvider } from './diagnostics.js'
export { DshContextError, diagnoseDshContext, readDshContextServices, resolveDshContext } from './dsh/context.js'
export {
  appendToolProtocolPrompt,
  createStructuredToolProtocol,
  parseStructuredEnvelope,
  renderToolProtocolPrompt,
  StructuredResponseAccumulator,
  ToolProtocolError,
  TOOL_PROTOCOL_LIMITS,
} from './provider/tool-protocol.js'
export { stageToolSchema } from './provider/tool-schema-file.js'
export type {
  DshApprovalPolicy,
  DshApprovalServiceLike,
  DshContextLookup,
  DshContextServices,
  DshContextSnapshot,
  DshContextState,
  DshContextErrorCode,
  DshContextDiagnostic,
  DshPermissionPreset,
  DshPermissionPresetServiceLike,
  DshSandboxMode,
  DshSandboxPolicyLike,
  DshServiceAvailability,
  DshSessionLike,
  DshSessionState,
  DshSessionStoreLike,
  DshWorkspaceLike,
  DshWorkspaceRegistryLike,
  DshWorkspaceState,
} from './dsh/context.js'
export type {
  StructuredEnvelope,
  StructuredToolProtocol,
  ToolProtocolErrorCode,
} from './provider/tool-protocol.js'
export type { StagedToolSchema } from './provider/tool-schema-file.js'
export { diagnoseProfile, runDoctor } from './doctor.js'
export {
  AgyImageBridgeError,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_COUNT,
  IMAGE_MEDIA_TYPES,
  prepareAgyPrompts,
} from './provider/image-bridge.js'
import {
  startDshMcpBridge,
  type DshMcpBridge,
  type DshSessionControllerLike,
  type DshToolRuntimeLike,
  type DshWebServerLike,
} from './mcp/bridge.js'
import { noteRegistration, setupWebRoutes } from './web/router.js'
import {
  findMissingAgentTemplates,
  type MissingAgentTemplate,
} from './agent-installer.js'
import { agentTemplatesForRequest } from './agent-presets.js'
import {
  AGENT_PRESET_IDS,
  getAgentPreset,
  listAgentPresets,
  readAgentPresetTemplate,
  requireAgentPreset,
} from './agent-presets.js'
export {
  AGENT_PRESET_IDS,
  agentTemplatesForRequest,
  getAgentPreset,
  listAgentPresets,
  readAgentPresetTemplate,
  requireAgentPreset,
}
export {
  DEFAULT_AGENT_DIRECTORY,
  AgentInstallError,
  describeAgentPresets,
  findMissingAgentTemplates,
  installAgentPreset,
  isAgentPreset,
} from './agent-installer.js'
export { formatAgentsHelp, runAgentsCli } from './agents-cli.js'
export { BundleConfig, ConfigSchema, createConfigSchema }
export type {
  DoctorOptions,
  DoctorResult,
  EffectiveBridgeCapability,
  EffectiveDshContext,
  ProfileDiagnosticOptions,
  ProfileDiagnosticResult,
} from './doctor.js'
export type {
  AgentExecutionMode,
  AgentPreset,
  AgentPresetId,
} from './agent-presets.js'
export type {
  AgentDirectoryEntry,
  AgentInstallAction,
  AgentInstallResult,
  AgentInstallOptions,
  MissingAgentTemplate,
} from './agent-installer.js'
export type {
  AgyImageAttachmentStore,
  AgyImageBridgeErrorCode,
  AgyImageMediaType,
  ImageBridgeOptions,
  PreparedAgyPrompts,
} from './provider/image-bridge.js'
export type { ConfigType, ModelConfig, ToolPolicy }
export interface Config extends ConfigType {}

function resolveSettingsConfig(ctx: Context, config: ConfigType): ConfigType {
  // DSH 0.2.0 removed SettingsProvider.register(): the harness's SettingsForms
  // projects the plugin's exported `Config` schema automatically, and `config`
  // already is the live merged value. Direct library callers compose the LLM
  // service alone, which keeps working unchanged.
  void ctx
  return config
}

export function apply(ctx: Context, config: ConfigType): void {
  const activeConfig = resolveSettingsConfig(ctx, config)
  const modelDiscovery = activeConfig.modelDiscovery === 'off' ? undefined : new AgyModelDiscovery({
    ...(activeConfig.agyPath?.trim() ? { executable: activeConfig.agyPath.trim() } : {}),
    ...(activeConfig.modelDiscoveryTtlMs === undefined ? {} : { ttlMs: activeConfig.modelDiscoveryTtlMs }),
    ...(activeConfig.modelDiscoveryTimeoutMs === undefined ? {} : { timeoutMs: activeConfig.modelDiscoveryTimeoutMs }),
  })
  // Settings panel: expose the local AGY CLI as the Antigravity CLI provider.
  // The namespace is the plugin name; settingsPath [] means the whole section is the profile.
  //
  // The outcome is recorded, not discarded: the Models page attaches the AGY
  // card only to a directory row whose `settingsNs` is exactly this string, and
  // a refused registration (DUPLICATE_DIRECTORY when this profile mounts the
  // plugin twice) used to be swallowed — which made "no card on the Models page"
  // indistinguishable from "card rendered empty". `/plugins/agy-cli/diagnose`
  // now reports both the refusal and the directory it actually has.
  const registerProviderDirectory = (): boolean => {
    try {
      ctx.llm.registerConfigurableProviders([{
        provider: 'agy',
        displayName: 'Antigravity CLI',
        settingsNs: 'dsh-agy-cli',
        settingsPath: [],
      }])
      noteRegistration('configurableProviders', 'ok')
      return true
    } catch (error) {
      noteRegistration('configurableProviders', error instanceof Error ? error.message : String(error))
      return false
    }
  }
  if (!registerProviderDirectory()) {
    // Why a retry: a refused registration means another mount of this plugin
    // already holds the `agy` entry. If that mount is disposed afterwards (the
    // bundle mount being replaced by the patch override), the directory loses the
    // entry and the Models page keeps listing the provider with an EMPTY
    // settingsNs — a row that renders no card. Retrying once after the loader
    // settles repairs that order dependence without a host restart.
    ctx.effect(() => {
      const timers = [3_000, 10_000].map((delay) => {
        const timer = setTimeout(() => { registerProviderDirectory() }, delay)
        if (typeof timer.unref === 'function') timer.unref()
        return timer
      })
      return () => { for (const timer of timers) clearTimeout(timer) }
    })
  }
  try {
    ctx.llm.registerModelDiscovery('dsh-agy-cli', async (request) => {
      // If editing an existing agy route, prefer our already-known catalog; otherwise discover via AGY CLI.
      // request.provider being 'agy' or undefined both mean this plugin owns the draft.
      if (request.provider !== undefined && request.provider !== 'agy') return []
      const configured = configuredModels(activeConfig)
      const result = activeConfig.modelDiscovery === 'off'
        ? { models: configured, source: 'static' as const, stale: false }
        : await modelDiscovery!.discover(configured)
      return result.models.map(m => ({
        id: m.id,
        ...(m.name === undefined ? {} : { name: m.name }),
        ...(m.contextWindow === undefined ? {} : { contextWindow: m.contextWindow }),
      }))
    })
    noteRegistration('modelDiscovery', 'ok')
  } catch (error) {
    noteRegistration('modelDiscovery', error instanceof Error ? error.message : String(error))
  }

  // Mount web HTTP routes for GUI control panel & status polling (/plugins/agy-cli/*)
  try {
    setupWebRoutes(ctx, activeConfig, modelDiscovery)
    noteRegistration('webRoutes', 'ok')
  } catch (error) {
    noteRegistration('webRoutes', error instanceof Error ? error.message : String(error))
  }

  // Settings are resolved before the enabled check, so disabled profiles can
  // still be edited from the configuration surface.
  if (!readConfigFlag(activeConfig.enabled)) return
  const provider = activeConfig.provider ?? 'agy'
  if (provider === 'agy-mock') {
    ctx.llm.registerAdapter([provider], new MockAdapter(activeConfig))
    return
  }
  const logger = ctx.logger('dsh-agy-cli')

  // AGY exits with `unknown agent "<name>" (available: ...)` *before* it reads
  // any input when the profile named on the command line has no template on
  // disk. The child then dies while its stdin is being written, and the adapter
  // reports that as AGY_INPUT_FAILED — an error naming the wrong component.
  // Report the real cause once, at startup, naming the exact missing files.
  // This only warns: installing templates is a deliberate user action, and
  // writing into another application's config directory unprompted is not
  // something a provider should do.
  ctx.effect(() => {
    let cancelled = false
    void (async () => {
      try {
        const wanted = agentTemplatesForRequest({
          toolPolicy: activeConfig.toolPolicy === 'agy-owned'
            ? 'agy-owned'
            : activeConfig.toolPolicy === 'dsh-owned' ? 'dsh-owned' : 'reject',
          agentPreset: activeConfig.agentPreset,
          agent: activeConfig.agent,
          imageInput: activeConfig.imageInput === 'experimental' ? 'experimental' : 'off',
        })
        const missing = (await Promise.all(wanted.map(async entry => {
          if (entry.preset === undefined) return undefined
          const absent = await findMissingAgentTemplates([entry.preset])
          return absent.length === 0 ? undefined : absent[0]
        }))).filter((entry): entry is MissingAgentTemplate => entry !== undefined)
        if (cancelled || missing.length === 0) return
        logger.warn(
          'AGY agent template(s) missing: %s. AGY rejects an unknown agent before reading any input, '
          + 'which surfaces as AGY_INPUT_FAILED. Install them with: npx dsh-agy-cli agents install %s --apply',
          missing.map(entry => `${entry.agentName} (${entry.targetPath})`).join(', '),
          missing.map(entry => entry.preset).join(' '),
        )
      } catch (error) {
        logger.warn('could not check AGY agent templates: %s', error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  })
  // AttachmentStore is optional for the text-only path. Use the reflection
  // lookup instead of reading ctx.attachments directly: Cordis requires every
  // direct service property access to be declared in `inject`.

  // The MCP tool bridge hands DSH tools to AGY out of band (so their schemas
  // never enter the prompt) and routes every execution back through the host's
  // own tool pipeline. It starts as an effect so the registration is removed
  // again when this fiber unloads.
  let toolBridge: DshMcpBridge | undefined
  let toolBridgeError: string | undefined
  const wantsBridge = activeConfig.mcpBridge !== false
    && activeConfig.toolPolicy === 'dsh-owned'
  if (wantsBridge) {
    ctx.effect(() => {
      let cancelled = false
      void (async () => {
        const bridge = await startDshMcpBridge({
          webServer: ctx.get('webServer') as DshWebServerLike,
          tools: ctx.get('tools') as DshToolRuntimeLike,
          // Late-bound on purpose: this plugin loads before the Session
          // controller bundle finishes mounting, and a value captured here
          // stays undefined for the life of the host.
          sessionControllerLookup: () => ctx.get('sessionController') as DshSessionControllerLike | undefined,
          ...((activeConfig.mcpToolAllowlist ?? []).length > 0 ? { toolAllowlist: activeConfig.mcpToolAllowlist } : {}),
          serverVersion: '0.0.0',
          logger: message => {
            logger.info(message)
            // The host logger has no file sink, so a bridge that silently loses
            // the session agent leaves no evidence. Mirror into the diagnostic
            // log the rest of this provider already writes.
            try {
              appendFileSync(
                AGY_DIAGNOSTIC_LOG_PATH,
                `${JSON.stringify({ event: 'bridge.log', at: Date.now(), message })}\n`,
                'utf8',
              )
            } catch {
              // Diagnostics must never break the bridge.
            }
          },
        })
        if (cancelled) {
          await bridge.dispose()
          return
        }
        toolBridge = bridge
        if (!bridge.active) {
          toolBridgeError = bridge.inactiveReason
          logger.warn('dsh mcp bridge inactive: %s', bridge.inactiveReason ?? 'unknown reason')
        }
      })().catch(error => {
        toolBridgeError = error instanceof Error ? error.message : String(error)
        logger.warn('dsh mcp bridge failed to start: %s', toolBridgeError)
      })
      return async () => {
        cancelled = true
        const bridge = toolBridge
        toolBridge = undefined
        await bridge?.dispose()
      }
    })
  }

  ctx.llm.registerAdapter([provider], new AgyAdapter(activeConfig, {
    logger: record => {
      try {
        logger.info('%s', JSON.stringify(record))
      } finally {
        appendAgyDiagnosticRecord(record)
      }
    },
    // With sessionMode 'resume' the sessionId -> conversationId map must outlive
    // the plugin: AGY keeps every conversation on disk, so a durable map turns
    // the first turn after a host restart from a full-history re-serialization
    // (pinned at the input limit, missing the upstream prompt cache) into an
    // incremental one. 'full' never reads the map, so it stays in memory.
    ...(activeConfig.sessionMode === 'resume'
      ? { sessionRegistry: new SessionRegistry(new FileSessionStore({ path: resolveSessionStorePath(activeConfig.sessionStorePath) })) }
      : {}),
    // Resolve lazily because attachments is optional and can be composed after
    // this plugin. Text-only requests remain independent of the service.
    resolveAttachmentStore: () => ctx.get('attachments') as Pick<AttachmentStore, 'readImage'> | undefined,
    resolveToolBridge: () => {
      if (!wantsBridge) return undefined
      if (toolBridge?.active === true) return toolBridge
      return undefined
    },
    dshContext: ctx as unknown as DshContextLookup,
  }))
}