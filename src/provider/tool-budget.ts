/**
 * Tool-schema token budget, rewritten in TypeScript from
 * magpie-community/plugins packages/agy-cli 0.1.55 (tool-budget.mjs).
 * MIT; Copyright (c) 2026 DylanLIiii, gitxm, yce. See NOTICE-upstream-license.txt.
 *
 * agy holds every MCP tool it loads into one customization budget of 20,000
 * tokens, counted as ceil(UTF-8 bytes / 3). Past it, agy drops whole tools,
 * largest first, so the best-documented tools vanish from the model's function
 * list. fitTools trims descriptions instead, so every tool and every part of
 * its schema stays: names, argument names, types, enums, required, items,
 * anyOf and the bounds all go as the caller wrote them. Only descriptions are
 * shortened, and only as far as the budget needs.
 */
import type { McpToolDescriptor } from '../mcp/protocol.js'

/** What the listed tools may take of agy's 20,000: room for the name prefix and serialization. */
export const TOOL_TOKEN_BUDGET = 18_000

const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')

/** agy token count for one JSON value: ceil(UTF-8 bytes of its JSON / 3). */
export function agyTokens(value: unknown): number {
  return Math.ceil(bytes(JSON.stringify(value) ?? '') / 3)
}

const tokensOf = (tools: readonly McpToolDescriptor[]): number =>
  tools.reduce((total, tool) => total + agyTokens(tool), 0)

// Keywords that say nothing about which arguments are valid. Removed only
// where they are keywords: a property named "title" is the caller's, and stays.
const DECOR = new Set(['$schema', 'title', 'examples'])

// A property whose description is its contract keeps more of its text.
const CONTRACT_WEIGHT = 11
const TOOL_WEIGHT = 2.5

/** A cut shorter than this says nothing, so the description goes whole or not at all. */
export const MIN_TEXT = 24

type JsonObject = Record<string, unknown>
type Cap = (node: JsonObject) => number

function isContract(node: JsonObject): boolean {
  const description = typeof node.description === 'string' ? node.description : ''
  if (/\b(Variants|Accepts anyOf|anyOf constraints|oneOf constraints|allOf constraints|additionalProperties):/.test(description)) {
    return true
  }
  const types = Array.isArray(node.type) ? node.type : [node.type]
  const properties = node.properties
  const hasProperties = properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    && Object.keys(properties as JsonObject).length > 0
  return types.includes('object') && !hasProperties
}

/** Shorten text to at most `max` UTF-8 bytes, ending on a sentence where one is near. */
export function cut(text: string, max: number): string | null {
  if (bytes(text) <= max) return text
  const bare = text.replace(/\s*\bExamples?:[\s\S]*$/i, '').trimEnd()
  if (bare.length > 0 && bytes(bare) <= max) return bare
  const room = max - bytes('…')
  if (room < 4) return null
  let out = ''
  let used = 0
  for (const ch of bare.length > 0 ? bare : text) {
    const size = bytes(ch)
    if (used + size > room) break
    out += ch
    used += size
  }
  const stop = Math.max(...['. ', '; ', '。', '；'].map((punctuation) => out.lastIndexOf(punctuation)))
  if (stop > out.length / 2) out = out.slice(0, stop + 1)
  return out.trimEnd() + '…'
}

function trim(text: string, max: number): string | null {
  if (bytes(text) <= max) return text
  return max < MIN_TEXT ? null : cut(text, max)
}

function walk(node: unknown, cap: Cap, strip: boolean): unknown {
  if (Array.isArray(node)) return node.map((item) => walk(item, cap, strip))
  if (node === null || typeof node !== 'object') return node
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node as JsonObject)) {
    if (strip && DECOR.has(key)) continue
    if (key === 'description' && typeof value === 'string') {
      const max = cap(node as JsonObject)
      const text = max === Infinity ? value : trim(value, max)
      if (text !== null && text.length > 0) out.description = text
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value as JsonObject).map(([name, schema]) => [name, walk(schema, cap, strip)]),
      )
      continue
    }
    if (key === 'enum' || key === 'const' || key === 'default' || key === 'required') {
      out[key] = value
      continue
    }
    out[key] = walk(value, cap, strip)
  }
  return out
}

interface ShapeOptions {
  readonly strip: boolean
  readonly L?: number
  readonly lean?: boolean
}

function shaped(tools: readonly McpToolDescriptor[], options: ShapeOptions): McpToolDescriptor[] {
  const { strip, L, lean } = options
  const plain = lean === true ? MIN_TEXT - 1 : L
  const cap: Cap = L === undefined
    ? () => Infinity
    : (node) => (isContract(node) ? CONTRACT_WEIGHT * L : (plain ?? L))
  return tools.map((tool) => {
    const out: JsonObject = { ...tool }
    if (tool.inputSchema !== null && typeof tool.inputSchema === 'object') {
      out.inputSchema = walk(tool.inputSchema, cap, strip) as JsonObject
    }
    if (typeof tool.description === 'string') {
      const max = L === undefined ? Infinity : TOOL_WEIGHT * L
      const text = max === Infinity ? tool.description : trim(tool.description, max)
      if (text !== null && text.length > 0) out.description = text
      else delete out.description
    }
    return out as unknown as McpToolDescriptor
  })
}

function highest(lo: number, hi: number, fits: (value: number) => boolean): number {
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Fit a tool set into the budget by trimming descriptions only. Five stages:
 * fast path, strip decoration, binary-search L, lean binary-search, and a
 * fail-open fallback that keeps every tool even if the budget is still exceeded.
 */
export function fitTools(
  tools: readonly McpToolDescriptor[],
  budget: number = TOOL_TOKEN_BUDGET,
): McpToolDescriptor[] {
  if (!Array.isArray(tools) || tools.length === 0) return tools as McpToolDescriptor[]
  if (tokensOf(tools) <= budget) return tools as McpToolDescriptor[]
  const stripped = shaped(tools, { strip: true })
  if (tokensOf(stripped) <= budget) return stripped
  const at = (level: number): McpToolDescriptor[] => shaped(tools, { strip: true, L: level })
  if (tokensOf(at(0)) > budget) return at(0)
  const level = highest(0, 4000, (candidate) => tokensOf(at(candidate)) <= budget)
  if (level >= MIN_TEXT) return at(level)
  const lean = (candidate: number): McpToolDescriptor[] =>
    shaped(tools, { strip: true, L: candidate, lean: true })
  if (tokensOf(lean(0)) > budget) return at(level)
  return lean(highest(0, 4000, (candidate) => tokensOf(lean(candidate)) <= budget))
}
