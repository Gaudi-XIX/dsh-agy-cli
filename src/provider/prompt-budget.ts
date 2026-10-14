import { getAgyUserMessageByteLength } from '../agy/stream-protocol.js'

export const DEFAULT_INPUT_FRAME_LIMIT_BYTES = 256 * 1024
// AGY's text input is practically truncated below the stream frame limit.
// Keep a margin below the observed ~192 KiB cutoff so the current turn and
// the DSH protocol cannot disappear from the tail of AGY's input.
export const DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES = 180 * 1024
// AGY 1.1.18's DSH-owned structured envelope appeared to have an additional
// effective ceiling from the injected Agent/system contract: prompts around
// 61 KiB exited without a usable structured response, so 56 KiB was pinned as
// the largest tested safe band. AGY 1.3.2 no longer shows that ceiling — the
// envelope came back parseable at 58 KiB and again at 136 KiB of prompt
// (frame 141,879 bytes), both exit 0. The old bound is now smaller than the
// protocol text alone on a Desktop profile: oneOf branches over ~59 tools
// serialize to ~58 KiB, so every dsh-owned request started by tripping
// AGY_INPUT_TOO_LARGE and by dropping history messages instead. 128 KiB keeps
// ~2.2x headroom over that fixed cost and stays well under the 256 KiB frame.
export const DEFAULT_DSH_TOOL_PROMPT_CONTENT_LIMIT_BYTES = 128 * 1024
export const DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES = 32 * 1024
export const DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES = 96 * 1024

const TOOL_RESULT_MARKER = '[DSH TOOL RESULT]'
const TRUNCATION_SUFFIX = '\n[DSH TOOL RESULT TRUNCATED]\n'
const OMITTED_TOOL_RESULT = `${TOOL_RESULT_MARKER}\n[DSH TOOL RESULT OMITTED FROM HISTORY BUDGET]\n`
const DSH_PROTOCOL_MARKER = '=== DSH TOOL PROTOCOL V1 ==='
const HISTORY_COMPACTION_MARKER = '=== USER ===\n[DSH HISTORY COMPACTED: older messages were omitted to stay within AGY input limits. The latest request and tool result are authoritative; re-read files with DSH tools when needed.]'
const OMITTED_HISTORY_SECTION = '=== USER ===\n[DSH HISTORY COMPACTED: this message was omitted to stay within AGY input limits.]'

export class AgyPromptBudgetError extends Error {
  readonly code = 'AGY_INPUT_TOO_LARGE' as const

  constructor(
    readonly actualBytes: number,
    readonly limitBytes: number,
  ) {
    super(`AGY input exceeds the configured limit (${actualBytes} > ${limitBytes} bytes)`)
    this.name = 'AgyPromptBudgetError'
  }
}

export interface AgyPromptBudgetOptions {
  maxFrameBytes: number
  maxPromptBytes?: number
  maxSingleToolResultBytes?: number
  maxHistoricalToolResultBytes?: number
  /**
   * What to do when a single serialized section alone exceeds the prompt
   * budget. `'reject'` (default) throws AGY_INPUT_TOO_LARGE; `'clamp'` clips
   * that section's head and keeps its tail. The main turn stays on `'reject'`:
   * silently losing the beginning of the user's own message is worse than a
   * clean error. Side-channel requests (a session-title or compaction summary
   * over the whole conversation, which arrive as one oversized section) use
   * `'clamp'` — they have no tool protocol to protect, the newest content is
   * what a summary needs, and failing them outright only stalls the panel.
   */
  oversizedSectionPolicy?: 'reject' | 'clamp'
}

export interface AgyPromptBudgetResult {
  readonly prompt: string
  readonly promptBytes: number
  readonly promptLimitBytes: number
  readonly frameBytes: number
  readonly frameLimitBytes: number
  readonly toolResultCount: number
  readonly largestToolResultBytes: number
  readonly truncatedToolResultCount: number
  readonly historyCompacted: boolean
  readonly omittedMessageCount: number
}

interface ToolResultSegment {
  start: number
  end: number
  text: string
}

interface SerializedSection {
  text: string
  /** Character range of `text` inside the serialized history. */
  start: number
  startOfLine: boolean
  /** Whether a blank separator line precedes the section in the history. */
  leadingBlankLine: boolean
  /** UTF-8 bytes of the history that precede this section. */
  byteOffset: number
}

/**
 * Matches a serialized section header at the start of a line. The `m` flag is
 * load-bearing: {@link splitSerializedHistoryWithOffsets} reuses this source with
 * a `g` flag over a whole multi-section history, and without `m` the `^` anchor
 * only matches offset 0, so the split silently returns a single section and every
 * clip lands on the entire history instead of at a message boundary.
 */
const SECTION_HEADER_PATTERN = /^(=== (?:USER|ASSISTANT|TOOL|SYSTEM) ===\n)/m

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function prefixForBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLength(value) <= maxBytes) return value

  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (byteLength(value.slice(0, middle)) <= maxBytes) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  const suffixBytes = byteLength(TRUNCATION_SUFFIX)
  if (maxBytes <= suffixBytes) return prefixForBytes(value, maxBytes)
  return `${prefixForBytes(value, maxBytes - suffixBytes)}${TRUNCATION_SUFFIX}`
}

function suffixForBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (byteLength(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (byteLength(value.slice(middle)) <= maxBytes) high = middle
    else low = middle + 1
  }
  return value.slice(low)
}

/**
 * Keep the newest content of a serialized history section when the section is
 * too large to fit on its own. Side-channel requests (a session-title refresh
 * over the whole conversation) arrive as a single section, so section-level
 * eviction cannot help — only clipping that section can. The tail wins because
 * in a conversation tail the newest turn lives; the marker tells AGY the head
 * was clipped rather than that nothing was said.
 */
function clampSectionToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) return value
  const headerMatch = SECTION_HEADER_PATTERN.exec(value)
  const header = headerMatch?.[1] ?? ''
  const marker = '[DSH OLDER CONTEXT CLIPPED FROM HEAD: THIS SECTION WAS TOO LARGE]\n'
  const bodyBudget = maxBytes - byteLength(header) - byteLength(marker)
  if (bodyBudget <= 0) return suffixForBytes(value, maxBytes)
  return `${header}${marker}${suffixForBytes(value.slice(header.length), bodyBudget)}`
}

type OversizedSectionPolicy = 'reject' | 'clamp'

interface ClipResult {
  prompt: string
  omitted: number
}

// Fraction of the budget a clipped prompt may occupy. The remainder is the
// margin that keeps a resume-mode bootstrap from being pinned to the exact
// limit; see `clampSectionsToBytes`.
const CLIP_TARGET_RATIO = 0.9

function clipHeadroomBytes(maxPromptBytes: number): number {
  return Math.max(128, Math.floor(maxPromptBytes * CLIP_TARGET_RATIO))
}

/**
 * Run a *fixed* byte budget over the serialized sections, keeping the newest
 * bytes of the conversation. Unlike {@link compactSerializedHistory}'s
 * section-level eviction — which drops a whole message as soon as one no longer
 * fits — this clips inside a section. It is the fallback for the bootstrap of a
 * resumed session: `resume` mode sends the entire DSH history as a single
 * prompt, so by the time a conversation is long enough the request is clamped
 * on *every* turn. Section-level eviction alone left it pinned at the exact
 * limit with the newest message dropped, which made the next AGY request miss
 * its upstream prompt cache and re-read the whole conversation.
 *
 * The cut is anchored to a message boundary, never to the limit. Anchoring to a
 * message start means the clipped prompt only changes when a new message is
 * appended, so the prefix AGY already cached stays byte-identical while the
 * conversation grows within the message at the boundary.
 */
function clampSectionsToBytes(
  sections: readonly SerializedSection[],
  maxPromptBytes: number,
): ClipResult {
  if (sections.length === 0) return { prompt: '', omitted: 0 }
  const newestIndex = sections.length - 1
  const budget = clipHeadroomBytes(maxPromptBytes)

  // Walk backwards from the newest message to find a window that fits the budget.
  //
  // Clipping the oldest rather than the newest is what keeps the answer possible:
  // the newest section is the turn being asked, and a half-clipped question
  // produces a wrong answer instead of a smaller one. Only the head of the
  // retained window is sacrificial.
  const firstKept = ((): number => {
    let used = 0
    let start = newestIndex
    for (let index = newestIndex; index >= 0; index -= 1) {
      const size = byteLength(sections[index]!.text)
      const separator = index === newestIndex ? 0 : 2
      if (used + size + separator > budget && index !== newestIndex) break
      used += size + separator
      start = index
    }
    return start
  })()

  // Snap the window start down to a power-of-two stride.
  //
  // Without this the start drifts outward by exactly one message per turn as the
  // conversation grows, so the retained bytes differ on every request and the
  // upstream prompt cache can never hit (measured: 101 bytes shared out of
  // 165243, i.e. effectively nothing). Snapping to 1, 2, 4, 8, ... messages means
  // the start only moves when the conversation nearly doubles the window, so
  // between snaps every turn emits the previous bytes plus an appended tail —
  // which is exactly what an append-only cache needs. It also keeps the window
  // contiguous, so no message is ever skipped.
  //
  // The boundary is quantized *before* packing, not after: adjusting an
  // already-packed window only moves its first kept message, which is the byte
  // the cache comparison fails on.
  const packedStart = firstKept
  const quantizedStart = ((): number => {
    if (packedStart <= 0) return 0
    let stride = 1
    while (stride * 2 <= packedStart) stride *= 2
    return packedStart - (packedStart % stride)
  })()

  // Pack forward from the quantized boundary so the retained window always
  // *starts* at that boundary.
  //
  // Walking backwards from the newest message instead packs as much of the tail
  // as fits, and when the conversation grows the oldest surviving message moves
  // by one every turn — so the first bytes of the prompt change on every request
  // and the upstream cache can never match. Starting at the boundary makes the
  // first kept message a function of the boundary alone, and the tail is what
  // absorbs growth: within one stride the emitted bytes are the previous bytes
  // plus an appended tail.
  //
  // The newest message is reserved first. It is the turn being asked, and it must
  // survive whole even when older messages would otherwise take its budget; that
  // also keeps the tail cut point still, because the newest message is the only
  // section that grows between turns.
  const newest = sections[newestIndex]!
  const newestWhole = byteLength(newest.text)
  const olderBudget = Math.max(0, budget - newestWhole - 2)

  const kept: string[] = []
  let used = 0
  for (let index = quantizedStart; index < newestIndex; index += 1) {
    const section = sections[index]!
    const size = byteLength(section.text)
    const separator = kept.length === 0 ? 0 : 2
    if (used + size + separator > olderBudget) break
    used += size + separator
    kept.push(section.text)
  }

  // Nothing from the boundary fit (a single huge message sits right at it).
  // Fall back to clipping that one message so the caller still gets an
  // answerable prompt instead of an empty window.
  const omitted = quantizedStart + kept.length
  const newestFits = used + newestWhole + (kept.length > 0 ? 2 : 0) <= budget
  const newestText = newestFits
    ? newest.text
    : clampSectionToBytes(newest.text, Math.max(1, budget - (kept.length > 0 ? byteLength(kept.join('\n\n')) + 2 : 0)))

  const parts: string[] = []
  if (omitted > 0) parts.push(OMITTED_HISTORY_SECTION)
  parts.push(...kept, newestText)
  return { prompt: parts.join('\n\n'), omitted }
}

function collectToolResultSegments(prompt: string): ToolResultSegment[] {
  const segments: ToolResultSegment[] = []
  let searchFrom = 0
  while (searchFrom < prompt.length) {
    const start = prompt.indexOf(TOOL_RESULT_MARKER, searchFrom)
    if (start < 0) break
    const nextSection = prompt.indexOf('\n=== ', start + TOOL_RESULT_MARKER.length)
    const end = nextSection < 0 ? prompt.length : nextSection
    segments.push({ start, end, text: prompt.slice(start, end) })
    searchFrom = end
  }
  return segments
}

function replaceSegments(
  prompt: string,
  segments: readonly ToolResultSegment[],
  replacements: readonly string[],
): string {
  if (segments.length === 0) return prompt
  let output = ''
  let cursor = 0
  segments.forEach((segment, index) => {
    output += prompt.slice(cursor, segment.start)
    output += replacements[index] ?? segment.text
    cursor = segment.end
  })
  return output + prompt.slice(cursor)
}

function truncateToolResults(
  prompt: string,
  maxSingleToolResultBytes: number,
  maxHistoricalToolResultBytes: number,
): { prompt: string; truncatedCount: number } {
  let candidate = prompt
  let truncatedCount = 0
  let segments = collectToolResultSegments(candidate)
  if (segments.length === 0) return { prompt: candidate, truncatedCount }

  const replacements = segments.map(segment => {
    const replacement = truncateUtf8(segment.text, maxSingleToolResultBytes)
    if (replacement !== segment.text) truncatedCount += 1
    return replacement
  })
  candidate = replaceSegments(candidate, segments, replacements)

  // Once each result has its deterministic per-result bound, enforce the
  // aggregate budget by evicting complete oldest segments. Shrinking an
  // already-retained segment in response to a later result changes the bytes
  // of the old prefix on every turn and destroys upstream prompt-cache
  // eligibility. The fixed omission marker keeps the serialized section
  // shape valid while making the eviction decision stable and observable.
  let totalBytes = collectToolResultSegments(candidate)
    .reduce((total, segment) => total + byteLength(segment.text), 0)
  while (totalBytes > maxHistoricalToolResultBytes) {
    segments = collectToolResultSegments(candidate)
    const segment = segments[0]
    if (segment === undefined) break
    const currentBytes = byteLength(segment.text)
    const replacement = totalBytes - currentBytes + byteLength(OMITTED_TOOL_RESULT) <= maxHistoricalToolResultBytes
      ? OMITTED_TOOL_RESULT
      : ''
    candidate = replaceSegments(candidate, [segment], [replacement])
    totalBytes -= currentBytes - byteLength(replacement)
    truncatedCount += 1
  }

  return { prompt: candidate, truncatedCount }
}

/** Return the immutable prefix before the first dynamic DSH history section. */
export function stableAgyPromptPrefix(prompt: string): string {
  const firstMessage = prompt.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  if (firstMessage >= 0) return prompt.slice(0, firstMessage).trimEnd()
  if (/^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(prompt)) return ''
  return prompt
}

function splitHistoryAndProtocol(prompt: string): {
  history: string
  protocol: string
  protocolBeforeHistory: boolean
} {
  const markerIndex = prompt.indexOf(DSH_PROTOCOL_MARKER)
  if (markerIndex < 0) return { history: prompt, protocol: '', protocolBeforeHistory: false }

  const dynamicMarker = prompt.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  // DSH-owned prompts place the immutable system/protocol prefix before the
  // dynamic history so the prefix can remain byte-stable for upstream cache
  // matching. Split that layout back into history + protected protocol for
  // budgeting; otherwise a prefix protocol would make history appear empty.
  if (dynamicMarker >= 0 && markerIndex < dynamicMarker) {
    const stablePrefix = prompt.slice(0, markerIndex).trimEnd()
    const protocolStart = markerIndex
    const protocolEndMarker = '\n=== END DSH TOOL PROTOCOL V1 ==='
    const protocolEnd = prompt.indexOf(protocolEndMarker, protocolStart)
    const protocolEndOffset = protocolEnd < 0
      ? dynamicMarker
      : protocolEnd + protocolEndMarker.length
    const protocol = prompt.slice(protocolStart, protocolEndOffset).trim()
    const afterProtocol = prompt.slice(protocolEndOffset).trimStart()
    const repairIndex = afterProtocol.indexOf('\n\n=== DSH TOOL PROTOCOL REPAIR ===')
    const historyTail = repairIndex < 0
      ? afterProtocol
      : afterProtocol.slice(0, repairIndex).trimEnd()
    const repair = repairIndex < 0 ? '' : afterProtocol.slice(repairIndex + 2).trim()
    const history = [stablePrefix, historyTail].filter(value => value.length > 0).join('\n\n')
    return {
      history,
      protocol: [protocol, repair].filter(value => value.length > 0).join('\n\n'),
      protocolBeforeHistory: true,
    }
  }

  // The protocol is intentionally treated as an immutable suffix. Repair
  // instructions follow the V1 marker and therefore remain protected too.
  const historyEnd = prompt.slice(0, markerIndex).trimEnd()
  return {
    history: historyEnd,
    protocol: prompt.slice(markerIndex),
    protocolBeforeHistory: false,
  }
}

function splitSerializedHistory(history: string): string[] {
  return splitSerializedHistoryWithOffsets(history).map(section => section.text)
}

/**
 * Split a serialized history into sections, reporting each section's byte
 * offset from the start of `history`. The offsets are what makes a *stable*
 * clip possible: clamping the newest section by its own start rather than by
 * the limit produces identical bytes on every turn, so a long conversation
 * keeps hitting AGY's upstream prompt cache instead of re-billing the prefix
 * each time.
 */
function splitSerializedHistoryWithOffsets(history: string): SerializedSection[] {
  if (history.length === 0) return []
  const sections: SerializedSection[] = []
  // Rebuild with `gm`, not `g`: `.source` carries only the pattern, so the `m`
  // flag on SECTION_HEADER_PATTERN is lost here and `^` would then match offset 0
  // alone, collapsing the whole history into one section.
  const header = new RegExp(SECTION_HEADER_PATTERN.source, 'gm')
  let cursor = 0
  let match: RegExpExecArray | null = header.exec(history)
  while (match !== null) {
    const start = match.index
    const leading = start === 0 ? 0 : 2
    if (start > cursor) {
      sections.push({
        text: history.slice(cursor, start - leading),
        start: cursor,
        startOfLine: true,
        leadingBlankLine: leading === 2,
        byteOffset: byteLength(history.slice(0, cursor)),
      })
    }
    cursor = start
    match = header.exec(history)
  }
  if (cursor < history.length) {
    sections.push({
      text: history.slice(cursor),
      start: cursor,
      startOfLine: true,
      leadingBlankLine: false,
      byteOffset: byteLength(history.slice(0, cursor)),
    })
  }
  return sections
}

function joinHistorySections(
  sections: readonly string[],
  protocol: string,
  protocolBeforeHistory = false,
): string {
  const history = sections.join('\n\n')
  if (protocol.length === 0) return history
  if (history.length === 0) return protocol
  if (!protocolBeforeHistory) return `${history}\n\n${protocol}`
  if (/^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(history)) {
    return `${protocol}\n\n${history}`
  }
  const firstDynamic = history.search(/\n\n=== (?:USER|ASSISTANT|TOOL) ===\n/)
  if (firstDynamic < 0) {
    return /^=== (?:USER|ASSISTANT|TOOL) ===\n/.test(history)
      ? `${protocol}\n\n${history}`
      : `${history}\n\n${protocol}`
  }
  return `${history.slice(0, firstDynamic)}\n\n${protocol}\n\n${history.slice(firstDynamic + 2)}`
}

function compactSerializedHistory(
  prompt: string,
  maxPromptBytes: number,
  oversizedSectionPolicy: 'reject' | 'clamp' = 'reject',
): { prompt: string; compacted: boolean; omittedMessageCount: number } {
  if (byteLength(prompt) <= maxPromptBytes) {
    return { prompt, compacted: false, omittedMessageCount: 0 }
  }

  const { history, protocol, protocolBeforeHistory } = splitHistoryAndProtocol(prompt)
  const sections = splitSerializedHistory(history)
  if (sections.length === 0) {
    throw new AgyPromptBudgetError(byteLength(prompt), maxPromptBytes)
  }
  const sectionAt = (index: number): string => sections[index] ?? ''

  const latestIndex = sections.length - 1
  const systemIndexes = sections
    .map((section, index) => section.startsWith('=== SYSTEM ===\n') ? index : -1)
    .filter(index => index >= 0)
  const selected = new Set<number>([latestIndex])

  // Keep the first system instruction when it fits. If it does not fit, the
  // current turn still wins; the protocol is always kept separately.
  const firstSystemIndex = systemIndexes[0]
  if (firstSystemIndex !== undefined) selected.add(firstSystemIndex)

  const omittedMarker = HISTORY_COMPACTION_MARKER
  const fits = (indexes: Iterable<number>, includeMarker: boolean): boolean => {
    const ordered = [...indexes].sort((left, right) => left - right)
    const candidateSections = includeMarker
      ? [
          ...ordered.filter(index => index !== latestIndex && index !== firstSystemIndex)
            .map(sectionAt),
          omittedMarker,
          ...(firstSystemIndex !== undefined && ordered.includes(firstSystemIndex)
            ? [sectionAt(firstSystemIndex)]
            : []),
          sectionAt(latestIndex),
        ]
      : ordered.map(sectionAt)
    return byteLength(joinHistorySections(candidateSections, protocol, protocolBeforeHistory)) <= maxPromptBytes
  }

  // Rebuild the mandatory set in a stable order. The marker is inserted as a
  // synthetic user section so the model knows that older context was removed.
  if (!fits(selected, true)) selected.delete(firstSystemIndex ?? -1)
  if (!fits(selected, true)) selected.clear()
  selected.add(latestIndex)

  // Add recent history first, newest-first, and stop at the first message that
  // does not fit. Stopping rather than skipping is what keeps the retained window
  // contiguous: a gap would renumber the conversation and change every later
  // byte, so the upstream cache could never hit.
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const candidate = new Set(selected)
    candidate.add(index)
    if (!fits(candidate, true)) break
    selected.add(index)
  }

  // If the first system section was skipped by the recent-history pass, add it
  // only when doing so does not displace the latest section or protocol.
  if (firstSystemIndex !== undefined && !selected.has(firstSystemIndex)) {
    const candidate = new Set(selected)
    candidate.add(firstSystemIndex)
    if (fits(candidate, true)) selected.add(firstSystemIndex)
  }

  const ordered = [...selected].sort((left, right) => left - right)
  const preservedSections = ordered.map(sectionAt)
  let omittedMessageCount = sections.length - selected.size
  const preservedWithoutMarker = preservedSections.filter(
    section => !section.startsWith('=== USER ===\n[DSH HISTORY COMPACTED:'),
  )
  const latestPreserved = preservedWithoutMarker[preservedWithoutMarker.length - 1]
  const withMarker = latestPreserved === undefined
    ? [omittedMarker]
    : [
        ...preservedWithoutMarker.slice(0, -1),
        omittedMarker,
        latestPreserved,
      ]

  // The marker is useful for diagnosis, but it must never cause the latest
  // section or the protocol to be lost. If an unusually small test limit
  // leaves no room, omit the marker rather than the current request.
  let compactedPrompt = joinHistorySections(withMarker, protocol, protocolBeforeHistory)
  if (byteLength(compactedPrompt) > maxPromptBytes) {
    compactedPrompt = joinHistorySections(preservedSections, protocol, protocolBeforeHistory)
  }
  const overflowed = (): boolean => byteLength(compactedPrompt) > maxPromptBytes
  // Eviction packs the prompt right up to the limit and stops as soon as it is
  // under it, so a long conversation lands on a prompt of 184192/184320 bytes
  // with no headroom. That is still a miss for the upstream prompt cache: the
  // next turn evicts one more message, which shifts the retained head and
  // rewrites the whole prefix (measured: 7609 of 184192 bytes shared across one
  // appended turn). Clipping to a fixed fraction of the budget leaves room for
  // the next turn to grow into instead of evicting, and anchors the cut to a
  // message boundary so the bytes before it stay put.
  const withinHeadroom = (): boolean =>
    byteLength(compactedPrompt) > clipHeadroomBytes(maxPromptBytes)
  if ((overflowed() || withinHeadroom()) && oversizedSectionPolicy === 'clamp') {
    // A side channel (a session-title or auto-review summary over the whole
    // conversation) has no protocol to protect and arrives as one oversized
    // dump, so section-level eviction cannot help. Clipping every retained
    // section to what remains of the budget still yields a usable answer over
    // the newest content, which beats AGY_INPUT_TOO_LARGE.
    const historyBudget = Math.max(128, maxPromptBytes - byteLength(protocol) - 2)
    compactedPrompt = joinHistorySections(
      [...selected].sort((left, right) => left - right)
        .map(index => clampSectionToBytes(sectionAt(index), historyBudget)),
      protocol,
      protocolBeforeHistory,
    )
  }
  if ((overflowed() || withinHeadroom()) && !protocolBeforeHistory) {
    // A main turn that eviction cannot bring comfortably under the limit. Every
    // request in `resume` mode ships the complete DSH history, so once a
    // conversation is long enough this happens on *every* turn: eviction packs
    // the prompt right up to the limit, the next turn evicts one more message,
    // and the retained head shifts (measured: 7609 of 184192 bytes shared across
    // one appended turn), so AGY never hits its upstream prompt cache. Clipping
    // to a fixed fraction of the budget leaves room for the next turn to grow
    // into instead of evicting, and anchors the cut to a message boundary so the
    // bytes before it stay put.
    //
    // A prompt that carries the tool protocol before its history is the DSH-owned
    // main turn. There the protocol must stay byte-stable and the user's own
    // newest message must not be silently shortened, so the strict `reject`
    // contract below still applies and a genuine overflow is a clean error.
    const { history: rawHistory, protocol: historyProtocol, protocolBeforeHistory: protocolFirst } =
      splitHistoryAndProtocol(prompt)
    const sections = splitSerializedHistoryWithOffsets(rawHistory)
    // Only a multi-message history has a boundary to clip at. One oversized
    // section is the shape the strict callers refuse on purpose, so leave it to
    // the throw below rather than silently clipping the only thing there is.
    if (sections.length > 1) {
      const budget = Math.max(128, maxPromptBytes - byteLength(historyProtocol) - 2)
      const clipped = clampSectionsToBytes(sections, budget)
      const nextPrompt = joinHistorySections([clipped.prompt], historyProtocol, protocolFirst)
      if (byteLength(nextPrompt) <= maxPromptBytes) {
        compactedPrompt = nextPrompt
        omittedMessageCount = Math.max(omittedMessageCount, clipped.omitted)
      }
    }
  }
  if (byteLength(compactedPrompt) > maxPromptBytes) {
    // The only way through is a clip inside the newest section, which the
    // `reject` callers deliberately refuse.
    throw new AgyPromptBudgetError(byteLength(compactedPrompt), maxPromptBytes)
  }

  return {
    prompt: compactedPrompt,
    compacted: true,
    omittedMessageCount,
  }
}

function fitPromptToFrame(
  prompt: string,
  maxFrameBytes: number,
): string {
  let candidate = prompt
  while (getAgyUserMessageByteLength(candidate) > maxFrameBytes) {
    const frameBytes = getAgyUserMessageByteLength(candidate)
    const segments = collectToolResultSegments(candidate)
    const segment = segments.find(item => byteLength(item.text) > byteLength(TOOL_RESULT_MARKER))
    if (segment === undefined) throw new AgyPromptBudgetError(frameBytes, maxFrameBytes)
    const currentBytes = byteLength(segment.text)
    const targetBytes = Math.max(
      byteLength(TOOL_RESULT_MARKER),
      currentBytes - (frameBytes - maxFrameBytes),
    )
    const replacement = truncateUtf8(segment.text, targetBytes)
    if (replacement === segment.text) throw new AgyPromptBudgetError(frameBytes, maxFrameBytes)
    candidate = replaceSegments(candidate, [segment], [replacement])
  }
  return candidate
}

/** Bound historical DSH tool output before the prompt is sent to AGY. */
export function boundAgyPrompt(
  prompt: string,
  options: AgyPromptBudgetOptions,
): AgyPromptBudgetResult {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new AgyPromptBudgetError(0, options.maxFrameBytes)
  }
  if (!Number.isSafeInteger(options.maxFrameBytes) || options.maxFrameBytes < 128) {
    throw new RangeError('AGY input frame limit must be an integer of at least 128 bytes')
  }

  const maxSingleToolResultBytes = options.maxSingleToolResultBytes
    ?? DEFAULT_MAX_SINGLE_TOOL_RESULT_BYTES
  const maxHistoricalToolResultBytes = options.maxHistoricalToolResultBytes
    ?? DEFAULT_MAX_HISTORICAL_TOOL_RESULT_BYTES
  const maxPromptBytes = options.maxPromptBytes
    ?? DEFAULT_AGY_PROMPT_CONTENT_LIMIT_BYTES
  if (!Number.isSafeInteger(maxPromptBytes) || maxPromptBytes < 128) {
    throw new RangeError('AGY prompt content limit must be an integer of at least 128 bytes')
  }
  const compacted = truncateToolResults(
    prompt,
    maxSingleToolResultBytes,
    maxHistoricalToolResultBytes,
  )
  const history = compactSerializedHistory(
    compacted.prompt,
    maxPromptBytes,
    options.oversizedSectionPolicy ?? 'reject',
  )
  const boundedPrompt = fitPromptToFrame(history.prompt, options.maxFrameBytes)
  const segments = collectToolResultSegments(boundedPrompt)
  const frameBytes = getAgyUserMessageByteLength(boundedPrompt)
  return {
    prompt: boundedPrompt,
    promptBytes: byteLength(boundedPrompt),
    promptLimitBytes: maxPromptBytes,
    frameBytes,
    frameLimitBytes: options.maxFrameBytes,
    toolResultCount: segments.length,
    largestToolResultBytes: segments.reduce(
      (largest, segment) => Math.max(largest, byteLength(segment.text)),
      0,
    ),
    truncatedToolResultCount: compacted.truncatedCount,
    historyCompacted: history.compacted,
    omittedMessageCount: history.omittedMessageCount,
  }
}
