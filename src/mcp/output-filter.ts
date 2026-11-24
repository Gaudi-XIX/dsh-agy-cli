/**
 * Output filtering for MCP tool results crossing the bridge to AGY.
 *
 * Two independent concerns, applied in this order:
 * 1. Terminal noise stripping — ANSI escape sequences and `\r` progress-bar
 *    redraws are byte-hungry and meaningless to a model consumer.
 * 2. Size folding — the official transport rejects inline messages over
 *    roughly 10KB; oversized results would trigger the disk-persist penalty.
 *    `DEFAULT_INLINE_MAX_BYTES` leaves headroom for protocol envelope bytes.
 */

/** Fold threshold in UTF-8 bytes (official inline limit ~10KB, minus envelope headroom). */
export const DEFAULT_INLINE_MAX_BYTES = 8800

/**
 * Remove ANSI escape sequences (CSI, OSC with BEL/ST terminator, and
 * two-character ESC escapes) plus carriage returns from terminal progress
 * bars. Everything else passes through untouched.
 */
export function stripTerminalNoise(text: string): string {
  return (
    text
      // OSC: ESC ] ... BEL  or  ESC \ (string terminator)
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      // CSI: ESC [ ... final byte 0x40-0x7E
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // Remaining two-character ESC sequences (charset selection like ESC ( B, etc.)
      .replace(/\x1b[()#%][0-9A-Za-z]/g, '')
      .replace(/\x1b[@-Z\\-_]/g, '')
      // Progress-bar redraws: carriage return collapses consecutive frames.
      .replace(/\r/g, '')
  )
}

/** Marker inserted where folded content was elided; reports byte counts. */
const FOLD_MARKER = (elided: number, total: number) =>
  `\n[... output filtered: ${elided} of ${total} bytes elided ...]\n`

/**
 * Fold text longer than `maxBytes` UTF-8 bytes: keep the head and the tail
 * (split evenly, never cutting a multi-byte code point) with an elision
 * marker in between.
 */
export function foldOversizeText(text: string, maxBytes: number = DEFAULT_INLINE_MAX_BYTES): string {
  const total = Buffer.byteLength(text, 'utf8')
  if (total <= maxBytes) return text
  // Two-pass marker sizing: probe with a placeholder to reserve the marker's
  // own bytes, then re-render with the true elided count (total - budget).
  const probe = FOLD_MARKER(0, total)
  let budget = maxBytes - Buffer.byteLength(probe, 'utf8')
  let marker = FOLD_MARKER(total - budget, total)
  const delta = Buffer.byteLength(marker, 'utf8') - Buffer.byteLength(probe, 'utf8')
  if (delta > 0) {
    budget -= delta
    marker = FOLD_MARKER(total - budget, total)
  }
  const headBytes = Math.floor(budget / 2)
  const tailBytes = budget - headBytes
  return sliceUtf8(text, headBytes) + marker + sliceTailUtf8(text, tailBytes)
}

/** First `maxBytes` UTF-8 bytes of `text`, cut on a code-point boundary. */
function sliceUtf8(text: string, maxBytes: number): string {
  let end = maxBytes
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end--
  }
  return text.slice(0, end)
}

/** Last `maxBytes` UTF-8 bytes of `text`, cut on a code-point boundary. */
function sliceTailUtf8(text: string, maxBytes: number): string {
  let start = 0
  while (start < text.length && Buffer.byteLength(text.slice(start), 'utf8') > maxBytes) {
    start++
  }
  return text.slice(start)
}

/** Combined out-stack filter: strip terminal noise, then fold oversize text. */
export function filterToolOutput(text: string, maxBytes: number = DEFAULT_INLINE_MAX_BYTES): string {
  return foldOversizeText(stripTerminalNoise(text), maxBytes)
}
