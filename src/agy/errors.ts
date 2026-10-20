import { CONTEXT_WINDOW_EXCEEDED_CODE, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { redactText } from './redact.js'

/** Stable provider-neutral codes emitted after classifying AGY text/status details. */
export type AgyClassifiedErrorCode =
  | typeof CONTEXT_WINDOW_EXCEEDED_CODE
  | typeof QUOTA_EXCEEDED_CODE
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'MODEL_NOT_FOUND'
  | 'AGY_AGENT_MISSING'
  | 'AGY_STATUS'
  | 'AGY_EXIT'
  | 'TRANSPORT'

// Billing/account-level failure wording: no amount of waiting helps, the caller
// must stop and surface it. Kept separate from the drained-bucket pattern below
// because the two deserve opposite treatment (fail-closed vs bounded retry).
const ACCOUNT_QUOTA_WORDS = /quota|credit|balance|billing|budget|usage\s+limit|limit\s+(?:exceeded|reached)/i;

// Wording that means "the 5h/weekly bucket is drained" rather than a billing
// failure. The distinction is load-bearing: a drained bucket is retryable (it
// sits on a boundary value where ~1 in 5 attempts succeeds, and the window
// resets on its own), while a billing failure never clears by waiting.
//   "Individual quota reached. … Resets in 96h12m27s"   → bucket drained, resets on the window
//   "Resource has been exhausted (e.g. check quota)."   → burst/rate limit, no reset hint
// Peer references (same rule, independently derived):
//   OmniRoute open-sse/services/antigravity429Engine.ts  QUOTA_EXHAUSTED_KEYWORDS
//     = ['quota_exhausted','quota exhausted','quota reached','enable overages','individual quota']
//     plus `/\breset\s+(?:after|in)\s+0s\b/` → rate_limited
//   chaos-03x dsh-agy src/runtime/classify.ts:93-119     QUOTA_EXHAUSTED_KEYWORDS
// Deliberately narrow: `limit\s+(?:exceeded|reached)` needs a neighbouring word
// that ties it to a window (quota/usage/weekly/5-hour) so that
// "billing budget limit reached" stays a billing failure. Over-broad matching
// produced ghost cooldowns in agy-link (repo_amlyczz__dsh-agy-link
// src/common/types.ts:320).
const DRAINED_QUOTA_WORDS = /(?:quota|usage|weekly|5[-\s]?hour)[-\s]*(?:limit|limits)\s+(?:reached|exceeded)|limit\s+(?:reached|exceeded)\s+(?:for|on)\s+(?:quota|usage|weekly|5[-\s]?hour)|individual\s+quota|quota\s+(?:reached|exhausted)|out\s+of\s+quota|insufficient\s+quota/i
const RESETS_IMMEDIATELY = /\breset\s+(?:after|in)\s+0s\b/i

/**
 * Classify observed AGY status/stderr/error-event detail. This is deliberately
 * conservative: unknown text keeps the caller-supplied fallback code.
 *
 * Note the ordering is load-bearing for 429s. AGY emits
 * `RESOURCE_EXHAUSTED (code 429)` for both a drained 5h/weekly bucket and a
 * transient burst limit; only the drained form names a reset far in the future.
 * The drained form is reported as RATE_LIMIT so the bounded retry in
 * `dsh-llm-retry` can re-issue the turn — live probes showed the bucket sits on
 * a boundary value where 1 in 5 attempts succeeds (probe_retry_efficacy.mjs:
 * 5/5 rounds recovered, 2-3 attempts each), while a 92-96h reset means retrying
 * beyond a few attempts is pure token burn.
 */
export function classifyAgyFailure(detail: string, fallback: string): string {
  const value = detail.trim().slice(0, 2_048)
  if (value.length === 0) return fallback
  if (/(?:context(?:\s+window)?|prompt|input).{0,48}(?:too\s+(?:long|large)|exceed|maximum|limit)|(?:maximum|limit).{0,48}(?:context|prompt|input)/i.test(value)) {
    return CONTEXT_WINDOW_EXCEEDED_CODE
  }
  if (ACCOUNT_QUOTA_WORDS.test(value) && !DRAINED_QUOTA_WORDS.test(value)) {
    return QUOTA_EXCEEDED_CODE
  }
  // A drained-bucket 429 that promises an immediate reset is really a burst limit.
  if (DRAINED_QUOTA_WORDS.test(value) && !RESETS_IMMEDIATELY.test(value)) return 'RATE_LIMIT'
  if (/(?:rate\s*limit|too\s+many\s+requests|throttl|\b429\b)/i.test(value)) return 'RATE_LIMIT'
  // Transport-layer flakes: the local proxy or the upstream edge cuts the
  // connection mid-request. AGY itself labels these `"retryable": true` in its
  // AGY_ERROR trailer; honoring that keeps a transient blip from killing the
  // whole turn (observed: `wsarecv`/`EOF` against 127.0.0.1:12450 on exit 3).
  if (/"retryable"\s*:\s*true/i.test(value)) return 'TRANSPORT'
  if (/\bEOF\b|wsarecv|forcibly\s+closed|connection\s+(?:reset|aborted|closed)|broken\s+pipe|EPIPE|ECONNRESET|stream\s+was\s+interrupted/i.test(value)) {
    return 'TRANSPORT'
  }
  if (/(?:model|deployment).{0,48}(?:not\s+found|unknown|invalid|unavailable|does\s+not\s+exist)|no\s+such\s+model/i.test(value)) {
    return 'MODEL_NOT_FOUND'
  }
  if (/(?:agent|profile).{0,48}(?:not\s+found|unknown|missing|invalid)/i.test(value)) return 'AGY_AGENT_MISSING'
  if (/(?:unauthori[sz]ed|not\s+authenticated|authentication|login|sign[\s-]+in|invalid\s+credential|expired\s+token|invalid\s+token|access\s+denied|forbidden)/i.test(value)) {
    return 'AUTH'
  }
  return fallback
}

/** Keep user-facing failure text bounded and redacted; structured logs use only the code. */
export function safeAgyFailureMessage(prefix: string, detail: string | undefined): string {
  const safeDetail = detail === undefined ? '' : redactText(detail.trim(), 512)
  return safeDetail.length === 0 ? prefix : `${prefix}: ${safeDetail}`
}
