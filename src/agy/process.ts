import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { redactText } from './redact.js'
import { AgyStreamProtocolError, encodeAgyUserMessage } from './stream-protocol.js'
import { buildWindowsNoConsoleLaunch } from './windows-launcher.js'

export type ProcessTermination = 'completed' | 'non-zero' | 'signaled' | 'aborted' | 'timeout' | 'idle-timeout' | 'output-limit'
/**
 * How `runProcess` retires the stdin pipe after writing the request frame.
 *
 * `'close'` ends stdin immediately (the historical behaviour). AGY's print mode
 * reads that EOF as "there is no next turn", shuts its store manager down and
 * cancels the turn still being generated — measured as
 * `Print mode: stream input closed after 1 turn(s)` followed by
 * `CORTEX_STEP_STATUS_CANCELED` on every step, which surfaces to the user as
 * text that appears and is then rolled back.
 *
 * `'hold'` keeps the pipe open and closes it only when the run is over (a
 * `result` line arrived, or the process exited). Nothing in AGY's stream-json
 * contract requires a follow-up frame, so holding costs nothing but the
 * lifetime of one pipe — and `idleTimeoutMs`/`timeoutMs` still kill a run that
 * goes silent, so a turn can never hang forever on an unclosed pipe.
 */
export type AgyStdinMode = 'close' | 'hold'
/** Maps a termination to the code the retry classifier sees, so a silence kill
 * and a wall-clock kill are distinguishable in telemetry without changing the
 * DSH-facing code (`TIMEOUT` either way). */

export const AGY_REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type AgyReasoningEffort = typeof AGY_REASONING_EFFORTS[number]

export const AGY_EXECUTION_MODES = ['plan', 'accept-edits'] as const
export type AgyExecutionMode = typeof AGY_EXECUTION_MODES[number]

export function isAgyReasoningEffort(value: unknown): value is AgyReasoningEffort {
  return typeof value === 'string'
    && (AGY_REASONING_EFFORTS as readonly string[]).includes(value)
}

export function isAgyExecutionMode(value: unknown): value is AgyExecutionMode {
  return typeof value === 'string'
    && (AGY_EXECUTION_MODES as readonly string[]).includes(value)
}

export class AgyProcessError extends Error {
  constructor(
    message: string,
    readonly code: 'ABORTED' | 'SPAWN_FAILED' | 'INPUT_FAILED' | 'INPUT_TOO_LARGE' | 'OUTPUT_HANDLER_FAILED' | 'OUTPUT_LIMIT',
    options?: ErrorOptions,
    readonly diagnostic?: AgyProcessDiagnostic,
  ) {
    super(message, options)
    this.name = 'AgyProcessError'
  }
}

export type AgyProcessDiagnosticStage = 'prepare' | 'spawn' | 'stdin' | 'stdout-handler'

/**
 * Safe process-failure metadata; never contains the prompt, the response, or paths.
 *
 * `stderrSummary` is the one deliberate exception on the stderr side. When AGY
 * dies before the first stdin write, the EOF is only a symptom: the cause is a
 * line AGY already printed to stderr (an eligibility failure, a rejected model,
 * a broken upstream connection). Without that line every such failure reads as
 * the same uninformative `(Error:EOF stage=stdin)`. It is therefore carried as a
 * single redacted, capped line, and only on the stdin stage.
 */
export interface AgyProcessDiagnostic {
  readonly stage: AgyProcessDiagnosticStage
  readonly errorName?: string
  readonly errorCode?: string
  readonly lineNumber?: number
  readonly lineLength?: number
  readonly lineHash?: string
  readonly stdoutLineCount?: number
  readonly stdoutBytes?: number
  readonly stderrBytes?: number
  readonly stderrSummary?: string
}

/** Longest stderr excerpt carried on a stdin failure. */
const STDERR_SUMMARY_MAX_LENGTH = 200

/**
 * Pick the most informative stderr line for a failed launch: AGY writes its
 * fatal reason last, after progress chatter, so the last non-empty line wins.
 */
export function stderrSummaryOf(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  const chosen = lines.at(-1)
  if (chosen === undefined) return undefined
  return redactText(chosen, STDERR_SUMMARY_MAX_LENGTH)
}

function errorNameOf(error: unknown): string | undefined {
  return error instanceof Error && error.name.length > 0 ? error.name.slice(0, 128) : undefined
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code.slice(0, 128) : undefined
}

function integerFieldOf(error: unknown, key: 'lineNumber'): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : undefined
}

function shortLineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex').slice(0, 16)
}

function processDiagnosticFor(
  error: unknown,
  stage: AgyProcessDiagnosticStage,
  details: {
    line?: string
    stdoutLineCount?: number
    stdoutBytes?: number
    stderrBytes?: number
    stderrSummary?: string
  } = {},
): AgyProcessDiagnostic {
  const line = details.line
  const errorName = errorNameOf(error)
  const errorCode = errorCodeOf(error)
  const lineNumber = integerFieldOf(error, 'lineNumber')
  return {
    stage,
    ...(errorName === undefined ? {} : { errorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(line === undefined ? {} : {
      lineLength: line.length,
      lineHash: shortLineHash(line),
    }),
    ...(details.stdoutLineCount === undefined ? {} : { stdoutLineCount: details.stdoutLineCount }),
    ...(details.stdoutBytes === undefined ? {} : { stdoutBytes: details.stdoutBytes }),
    ...(details.stderrBytes === undefined ? {} : { stderrBytes: details.stderrBytes }),
    ...(details.stderrSummary === undefined ? {} : { stderrSummary: details.stderrSummary }),
  }
}

function diagnosticLabel(diagnostic: AgyProcessDiagnostic | undefined): string {
  if (diagnostic === undefined) return ''
  const cause = [diagnostic.errorName, diagnostic.errorCode].filter(Boolean).join(':')
  const line = diagnostic.lineNumber === undefined ? '' : ` line=${diagnostic.lineNumber}`
  const length = diagnostic.lineLength === undefined ? '' : ` length=${diagnostic.lineLength}`
  const stage = `stage=${diagnostic.stage}`
  const stderr = diagnostic.stderrSummary === undefined ? '' : ` stderr=${JSON.stringify(diagnostic.stderrSummary)}`
  return ` (${[cause || undefined, stage, line.trim(), length.trim(), stderr.trim()].filter(Boolean).join(' ')})`
}

/** Find process diagnostics through the LlmError -> cause chain. */
export function agyProcessDiagnosticOf(error: unknown): AgyProcessDiagnostic | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    if (current instanceof AgyProcessError && current.diagnostic !== undefined) return current.diagnostic
    if (!(current instanceof Error)) return undefined
    current = current.cause
  }
  return undefined
}

export interface ProcessRequest {
  executable: string
  args: readonly string[]
  /** Optional stdin payload written once before the stream is closed. */
  stdin?: string
  /**
   * Whether to end stdin right after writing the payload (default) or keep it
   * open until the run finishes. See `AgyStdinMode`.
   */
  stdinMode?: AgyStdinMode
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Hard wall-clock ceiling for the whole run. Omitted means unbounded. */
  timeoutMs?: number
  /**
   * Inactivity budget: the run is killed when no stdout/stderr line arrives for
   * this long. Re-armed on every delivered line, so a turn that keeps producing
   * output can run past `timeoutMs` without being cut off. Omitted means only
   * the wall-clock ceiling applies.
   */
  idleTimeoutMs?: number
  /** Maximum captured stdout bytes; omitted means unlimited. */
  maxStdoutBytes?: number
  /** Maximum captured stderr bytes; omitted means unlimited. */
  maxStderrBytes?: number
  signal?: AbortSignal
  /** Called synchronously for each complete stdout line as it arrives. */
  onStdoutLine?: (line: string) => void
  /** Use the Windows no-console bridge for a console-subsystem executable. */
  windowsNoConsole?: boolean
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  termination: ProcessTermination
  stdoutLines: readonly string[]
  stderr: string
  durationMs: number
  /** Epoch ms of the last stdout/stderr chunk; used to report an idle kill. */
  lastOutputAtMs?: number
}

export interface AgyRequest extends Omit<ProcessRequest, 'executable' | 'args'> {
  executable?: string
  prompt: string
  agent?: string
  model?: string
  conversation?: string
  reasoningEffort?: AgyReasoningEffort
  /** Explicit AGY directories made available to the selected Agent. */
  addDirs?: readonly string[]
  /** Bounded AGY execution mode selected by an Agent preset. */
  mode?: AgyExecutionMode
  /** Disable slash commands for bundled non-interactive presets. */
  disableSlashCommands?: boolean
  /** Absolute temporary JSON Schema path passed to AGY's final-result validator. */
  jsonSchemaPath?: string
  /** Maximum UTF-8 bytes allowed for one encoded stream-json user frame. */
  maxInputFrameBytes?: number
  /**
   * How long to keep the request pipe open. AGY's print mode treats an
   * immediate EOF as "no next turn" and cancels the turn it is still
   * generating, so the adapter holds the pipe by default; see `AgyStdinMode`.
   */
  stdinMode?: AgyStdinMode
}

export function defaultAgyCommand(): 'agy.exe' | 'agy' {
  return process.platform === 'win32' ? 'agy.exe' : 'agy'
}

function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.once('error', () => child.kill())
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Resolve an explicit AGY path, AGY_PATH/AGY_EXECUTABLE, or an executable on
 * PATH. Returning the bare command in the final fallback lets spawn produce
 * the platform-native diagnostic if PATH changes between discovery and run.
 */
export function resolveAgyExecutable(explicit?: string): string {
  const configured = explicit?.trim()
    || process.env.AGY_PATH?.trim()
    || process.env.AGY_EXECUTABLE?.trim()
  if (configured !== undefined && configured.length > 0) return resolve(configured)

  const command = defaultAgyCommand()
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const suffixes = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of pathEntries) {
    const direct = join(directory, command)
    if (existsSync(direct)) return direct
    if (process.platform === 'win32' && !command.includes('.')) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${command}${suffix.toLowerCase()}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return command
}

/** Build AGY's stdin stream-json argv without invoking a shell. */
export function buildAgyArgs(
  request: Pick<
    AgyRequest,
    | 'prompt'
    | 'agent'
    | 'model'
    | 'conversation'
    | 'reasoningEffort'
    | 'addDirs'
    | 'mode'
    | 'disableSlashCommands'
    | 'jsonSchemaPath'
  >,
): string[] {
  if (request.reasoningEffort !== undefined && !isAgyReasoningEffort(request.reasoningEffort)) {
    throw new TypeError('AGY reasoning effort must be one of: low, medium, high')
  }
  if (request.mode !== undefined && !isAgyExecutionMode(request.mode)) {
    throw new TypeError('AGY execution mode must be one of: plan, accept-edits')
  }
  if (request.addDirs?.some(directory => typeof directory !== 'string' || directory.trim().length === 0)) {
    throw new TypeError('AGY add-dir entries must be non-empty paths')
  }
  if (request.jsonSchemaPath !== undefined && request.jsonSchemaPath.trim().length === 0) {
    throw new TypeError('AGY json-schema path must be non-empty')
  }
  return [
    '-p', '',
    ...(request.agent === undefined ? [] : ['--agent', request.agent]),
    ...(request.model === undefined ? [] : ['--model', request.model]),
    ...(request.conversation === undefined ? [] : ['--conversation', request.conversation]),
    ...(request.reasoningEffort === undefined ? [] : ['--effort', request.reasoningEffort]),
    ...(request.addDirs?.flatMap(directory => ['--add-dir', directory]) ?? []),
    ...(request.mode === undefined ? [] : ['--mode', request.mode]),
    ...(request.disableSlashCommands === true ? ['--disable-slash-commands'] : []),
    ...(request.jsonSchemaPath === undefined ? [] : ['--json-schema', request.jsonSchemaPath]),
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
  ]
}

function splitLines(buffer: string, final: boolean): { lines: string[]; remainder: string } {
  const parts = buffer.split(/\r?\n/)
  const remainder = parts.pop() ?? ''
  if (final && remainder.length > 0) {
    parts.push(remainder.replace(/\r$/, ''))
    return { lines: parts, remainder: '' }
  }
  return { lines: parts, remainder }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Run a process with piped output and deterministic lifecycle handling.
 * stdout is delivered line-by-line while the process is running; the result
 * also retains the lines for tests and adapters that do not need live output.
 */
export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  if (request.signal?.aborted) {
    return Promise.reject(new AgyProcessError('AGY process aborted before start', 'ABORTED'))
  }

  const startedAt = Date.now()
  let launch: { executable: string; args: readonly string[] }
  try {
    launch = request.windowsNoConsole === true
      ? buildWindowsNoConsoleLaunch(request.executable, request.args)
      : { executable: request.executable, args: request.args }
    if (process.platform === 'win32' && request.windowsNoConsole === true && !existsSync(launch.executable)) {
      throw new Error('Bundled Windows AGY launcher is missing')
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    const diagnostic = processDiagnosticFor(cause, 'prepare')
    return Promise.reject(new AgyProcessError(
      `Unable to prepare AGY launcher: ${cause.message}${diagnosticLabel(diagnostic)}`,
      'SPAWN_FAILED',
      { cause },
      diagnostic,
    ))
  }
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(launch.executable, [...launch.args], {
      cwd: request.cwd,
      env: request.env === undefined ? process.env : { ...process.env, ...request.env },
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error))
    const code = (cause as NodeJS.ErrnoException).code ?? 'unknown'
    const diagnostic = processDiagnosticFor(cause, 'spawn')
    return Promise.reject(new AgyProcessError(
      `Unable to start AGY executable (${code})${diagnosticLabel(diagnostic)}`,
      'SPAWN_FAILED',
      { cause },
      diagnostic,
    ))
  }

  return new Promise<ProcessResult>((resolveResult, rejectResult) => {
    let stdoutBuffer = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const stdoutLines: string[] = []
    let termination: ProcessTermination | undefined
    let outputHandlerError: unknown
    let outputHandlerDiagnostic: AgyProcessDiagnostic | undefined
    let inputError: unknown
    let settled = false
    let lastOutputAtMs = startedAt
    let turnClosed = false

    const deliver = (line: string): void => {
      stdoutLines.push(line)
      if (!turnClosed && resultSeen(line)) {
        turnClosed = true
        endStdin()
      }
      if (request.onStdoutLine === undefined || outputHandlerError !== undefined) return
      try {
        request.onStdoutLine(line)
      } catch (error) {
        outputHandlerError = error
        outputHandlerDiagnostic = processDiagnosticFor(error, 'stdout-handler', {
          line,
          stdoutLineCount: stdoutLines.length,
          stdoutBytes,
          stderrBytes,
        })
        termination = 'aborted'
        terminateProcessTree(child)
      }
    }

    const flushStdout = (final: boolean): void => {
      const split = splitLines(stdoutBuffer, final)
      stdoutBuffer = split.remainder
      for (const line of split.lines) deliver(line)
    }

    const kill = (reason: Exclude<ProcessTermination, 'completed' | 'non-zero' | 'signaled'>): void => {
      if (termination === undefined) termination = reason
      if (!child.killed) terminateProcessTree(child)
    }

    // `hold` keeps the request pipe open until the turn is over. Ending it
    // early is read by AGY as "no next turn" and cancels the running one.
    const stdinMode: AgyStdinMode = request.stdinMode ?? 'close'
    let stdinClosed = false
    const endStdin = (): void => {
      if (stdinClosed || request.stdin === undefined) return
      stdinClosed = true
      child.stdin.end()
    }
    const resultSeen = (line: string): boolean => {
      try {
        const parsed: unknown = JSON.parse(line)
        return typeof parsed === 'object'
          && parsed !== null
          && (parsed as { event?: unknown }).event === 'result'
      } catch {
        return false
      }
    }

    const abortListener = (): void => kill('aborted')
    request.signal?.addEventListener('abort', abortListener, { once: true })
    const timeout = request.timeoutMs !== undefined && request.timeoutMs > 0
      ? setTimeout(() => kill('timeout'), request.timeoutMs)
      : undefined
    // Idle watchdog: re-armed on every stdout/stderr chunk, so long reasoning
    // or a long tool step is not mistaken for a hung process. A turn that keeps
    // producing output outlives `timeoutMs`; only real silence trips it.
    const idleBudgetMs = request.idleTimeoutMs !== undefined && request.idleTimeoutMs > 0
      ? request.idleTimeoutMs
      : undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      if (idleBudgetMs === undefined || settled) return
      if (idle !== undefined) clearTimeout(idle)
      idle = setTimeout(() => kill('idle-timeout'), idleBudgetMs)
    }
    armIdle()
    // AGY's own headless default is an unbounded turn, and its `--print-timeout`
    // is passed separately; a fixed wall clock would cut off a healthy turn, so
    // it is opt-in via `timeoutMs` and never implied by the idle budget.

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      armIdle()
      lastOutputAtMs = Date.now()
      stdoutBytes += byteLength(chunk)
      if (request.maxStdoutBytes !== undefined && stdoutBytes > request.maxStdoutBytes) {
        termination = 'output-limit'
        terminateProcessTree(child)
        return
      }
      stdoutBuffer += chunk
      flushStdout(false)
    })
    child.stdout.on('end', () => {
      if (termination !== 'output-limit') flushStdout(true)
      // A final `result` line is the contract's "turn is over" signal; the
      // process is expected to exit on its own, but a held pipe gives it a
      // clean shutdown cue rather than an EOF it may read as a new turn.
      if (stdinMode === 'hold') endStdin()
    })
    child.stderr.on('data', (chunk: string) => {
      armIdle()
      lastOutputAtMs = Date.now()
      stderrBytes += byteLength(chunk)
      if (request.maxStderrBytes !== undefined && stderrBytes > request.maxStderrBytes) {
        termination = 'output-limit'
        terminateProcessTree(child)
        return
      }
      stderr += chunk
    })
    if (request.stdin !== undefined) {
      child.stdin.once('error', error => {
        if (settled || inputError !== undefined) return
        inputError = error
        kill('aborted')
      })
    }
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      if (timeout !== undefined) clearTimeout(timeout)
      if (idle !== undefined) clearTimeout(idle)
      request.signal?.removeEventListener('abort', abortListener)
      rejectResult(new AgyProcessError(
        `Unable to start AGY executable (${error.code ?? 'unknown'})${diagnosticLabel(processDiagnosticFor(error, 'spawn'))}`,
        'SPAWN_FAILED',
        { cause: error },
        processDiagnosticFor(error, 'spawn'),
      ))
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      endStdin()
      if (timeout !== undefined) clearTimeout(timeout)
      if (idle !== undefined) clearTimeout(idle)
      request.signal?.removeEventListener('abort', abortListener)
      if (termination !== 'output-limit') flushStdout(true)
      if (outputHandlerError !== undefined) {
        rejectResult(new AgyProcessError(
          `AGY stdout handler failed${diagnosticLabel(outputHandlerDiagnostic)}`,
          'OUTPUT_HANDLER_FAILED',
          { cause: outputHandlerError },
          outputHandlerDiagnostic,
        ))
        return
      }
      if (inputError !== undefined) {
        const stderrSummary = stderrSummaryOf(stderr)
        const diagnostic = processDiagnosticFor(inputError, 'stdin', {
          stdoutLineCount: stdoutLines.length,
          stdoutBytes,
          stderrBytes,
          ...(stderrSummary === undefined ? {} : { stderrSummary }),
        })
        rejectResult(new AgyProcessError(
          `Unable to write AGY stream-json input${diagnosticLabel(diagnostic)}`,
          'INPUT_FAILED',
          { cause: inputError instanceof Error ? inputError : new Error(String(inputError)) },
          diagnostic,
        ))
        return
      }
      const finalTermination = termination
        ?? (exitCode === 0 ? 'completed' : signal === null ? 'non-zero' : 'signaled')
      resolveResult({
        exitCode,
        signal,
        termination: finalTermination,
        stdoutLines,
        stderr,
        durationMs: Date.now() - startedAt,
        lastOutputAtMs,
      })
    })
    if (request.stdin !== undefined) {
      child.stdin.write(request.stdin)
      // `hold` leaves the pipe open until `deliver` sees AGY's closing `result`
      // line (or the process exits, which closes it anyway). Ending it here is
      // what made AGY cancel a turn it was still generating.
      if (stdinMode === 'close') endStdin()
    }
  })
}

export function runAgyProcess(request: AgyRequest): Promise<ProcessResult> {
  const executable = resolveAgyExecutable(request.executable)
  let stdin: string
  try {
    stdin = encodeAgyUserMessage(request.prompt, request.maxInputFrameBytes)
  } catch (error) {
    const tooLarge = error instanceof AgyStreamProtocolError && error.code === 'FRAME_TOO_LARGE'
    return Promise.reject(new AgyProcessError(
      error instanceof Error ? error.message : 'Unable to encode AGY stream-json input',
      tooLarge ? 'INPUT_TOO_LARGE' : 'INPUT_FAILED',
      { cause: error instanceof Error ? error : new Error(String(error)) },
    ))
  }
  return runProcess({
    ...request,
    executable,
    args: buildAgyArgs(request),
    stdin,
    windowsNoConsole: true,
  })
}
