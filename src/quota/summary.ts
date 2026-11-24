// Parsing and rendering for the AGY language server quota responses.
// Response shape references (not copied): n2ns/antigravity-panel QUOTA_DATA_MODEL.md.

export interface ModelQuotaRow {
  label: string
  modelId: string
  remainingFraction: number
  resetTime: string | null
}

export interface QuotaBucket {
  bucketId: string
  remainingFraction: number
  resetTime: string | null
}

/** The local server may answer with a single JSON document or newline-delimited
 * JSON fragments (connect streaming may interleave framing lines). */
export function parseDelimitedJson(body: string): Record<string, unknown>[] {
  const trimmed = body.trim()
  if (!trimmed) return []
  try {
    const single: unknown = JSON.parse(trimmed)
    if (single && typeof single === 'object' && !Array.isArray(single)) {
      return [single as Record<string, unknown>]
    }
  } catch {
    // fall through to line-by-line parsing
  }
  const values: Record<string, unknown>[] = []
  for (const line of trimmed.split(/\r?\n/)) {
    const candidate = line.trim()
    if (!candidate) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        values.push(parsed as Record<string, unknown>)
      }
    } catch {
      // framing line; ignore
    }
  }
  return values
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** Parse GetUserStatus model quota rows. Disabled rows (no quota info) are skipped. */
export function parseModelRows(responses: Record<string, unknown>[]): ModelQuotaRow[] {
  const rows: ModelQuotaRow[] = []
  for (const response of responses) {
    const userStatus = asRecord(response['userStatus'])
    const models = userStatus?.['models']
    if (!Array.isArray(models)) continue
    for (const entry of models) {
      const record = asRecord(entry)
      if (!record || record['disabled'] === true) continue
      const quotaInfo = asRecord(record['quotaInfo'])
      const remaining = quotaInfo?.['remainingFraction']
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
      const modelOrAlias = asRecord(record['modelOrAlias'])
      const modelId = typeof modelOrAlias?.['model'] === 'string' ? (modelOrAlias['model'] as string) : ''
      const label = typeof record['label'] === 'string' ? (record['label'] as string) : modelId
      const resetTime = typeof quotaInfo?.['resetTime'] === 'string' ? (quotaInfo['resetTime'] as string) : null
      rows.push({ label, modelId, remainingFraction: remaining, resetTime })
    }
  }
  return rows
}

/** Parse RetrieveUserQuotaSummary weekly / 5h buckets from groups[].buckets[]. */
export function parseSummaryBuckets(responses: Record<string, unknown>[]): QuotaBucket[] {
  const buckets: QuotaBucket[] = []
  for (const response of responses) {
    const groups = response['groups']
    if (!Array.isArray(groups)) continue
    for (const entry of groups) {
      const group = asRecord(entry)
      const bucketList = group?.['buckets']
      if (!Array.isArray(bucketList)) continue
      for (const bucketEntry of bucketList) {
        const bucket = asRecord(bucketEntry)
        if (!bucket) continue
        const remaining = bucket['remainingFraction']
        if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue
        const bucketId = typeof bucket['bucketId'] === 'string' ? (bucket['bucketId'] as string) : ''
        const resetTime = typeof bucket['resetTime'] === 'string' ? (bucket['resetTime'] as string) : null
        buckets.push({ bucketId, remainingFraction: remaining, resetTime })
      }
    }
  }
  return buckets
}

/** Human-readable countdown (e.g. `2h13m`) or a fallback marker. */
export function formatCountdown(resetTime: string | null, nowMs: number): string {
  if (!resetTime) return '重置时间未知'
  const resetMs = Date.parse(resetTime)
  if (Number.isNaN(resetMs)) return `重置时间无法解析(${resetTime})`
  const diffMs = resetMs - nowMs
  if (diffMs <= 0) return '已重置'
  const totalMinutes = Math.floor(diffMs / 60_000)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d${hours}h${minutes}m`
  if (hours > 0) return `${hours}h${minutes}m`
  return `${minutes}m`
}

/** Render the human-readable report; empty model list yields a readable notice. */
export function renderReport(models: ModelQuotaRow[], buckets: QuotaBucket[], nowMs = Date.now()): string {
  if (models.length === 0) return '[quota] 语言服务器响应中没有可解析的模型配额行。'
  const lines: string[] = []
  for (const model of models) {
    const percent = Math.round(model.remainingFraction * 1000) / 10
    lines.push(`${model.label || model.modelId}: 剩余 ${percent}%,重置倒计时 ${formatCountdown(model.resetTime, nowMs)}`)
  }
  if (buckets.length > 0) {
    lines.push('周/5小时配额桶:')
    for (const bucket of buckets) {
      const percent = Math.round(bucket.remainingFraction * 1000) / 10
      lines.push(`  ${bucket.bucketId}: 剩余 ${percent}%,重置倒计时 ${formatCountdown(bucket.resetTime, nowMs)}`)
    }
  }
  return lines.join('\n')
}
