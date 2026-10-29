/** Account/profile/Key projections. Never return nested API Keys, identities or tokens. */
import { accountText, parseSakuraClientUser, positiveId, SakuraApiError, type SakuraApiClientUser } from './sakuraapi-client.js'
import { parseSakuraApiUsage, record, validToken, type SakuraApiQuotaWindow, type SakuraApiUsageInfo } from './sakuraapi-usage.js'

export interface SakuraApiVip {
  enabled: boolean
  level: number
  discount?: number
  totalRecharged?: number
  currency?: string
  progressRecharged?: number
  progressRequired?: number
  nextLevel?: number
}
export interface SakuraApiKeyChoice {
  id: number; name: string; status: string; usable: boolean; reason?: string
  expiresAt?: string; quota?: number; used?: number; remaining?: number; groupIds: number[]
}
export interface SakuraApiKeyPage { items: SakuraApiKeyChoice[]; total: number; page: number; pageSize: number; pages: number }
export interface SakuraApiGroupChoice { id: number; name: string; platform: string; rateMultiplier?: number }

const amount = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const date = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined

export function parseSakuraProfile(value: unknown, expectedId: number): { user: SakuraApiClientUser; balance?: number } {
  const row = record(value)
  if (!row) throw new SakuraApiError('SakuraAPI 返回了无效个人资料。', 502)
  return { user: parseSakuraClientUser(row, expectedId),
    ...(typeof row.balance === 'number' && Number.isFinite(row.balance) ? { balance: row.balance } : {}) }
}

/** Level comes from the server's effective `level`, never recharge thresholds or Key names. */
export function parseSakuraVip(value: unknown): SakuraApiVip | undefined {
  const row = record(value)
  if (!row || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.level) || row.level < 0 || row.level > 1_000_000 ||
    row.effective_level !== undefined && row.effective_level !== row.level) return undefined
  const discount = amount(row.discount)
  return { enabled: row.enabled, level: row.level,
    ...(discount !== undefined && discount >= 0.9 && discount <= 1 ? { discount } : {}),
    ...(amount(row.total_recharged) !== undefined ? { totalRecharged: row.total_recharged } : {}),
    ...(typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? { currency: row.currency } : {}),
    ...(amount(row.progress_recharged) !== undefined ? { progressRecharged: row.progress_recharged } : {}),
    ...(amount(row.progress_required) !== undefined ? { progressRequired: row.progress_required } : {}),
    ...(positiveId(record(row.next_level)?.level) ? { nextLevel: row.next_level.level } : {}) }
}

export function parseSakuraAccountUsage(value: unknown): SakuraApiUsageInfo['usage'] {
  const row = record(value)
  if (!row) throw new SakuraApiError('SakuraAPI 返回了无效账号用量。', 502)
  return { requests: amount(row.total_requests), inputTokens: amount(row.total_input_tokens),
    outputTokens: amount(row.total_output_tokens), cost: amount(row.total_actual_cost) }
}

export function parseSakuraAccountSubscriptions(value: unknown, userId: number, progressValue?: unknown): NonNullable<SakuraApiUsageInfo['subscriptions']> {
  if (!Array.isArray(value) || value.length > 1000) throw new SakuraApiError('SakuraAPI 返回了无效账号订阅。', 502)
  const progress = new Map<number, Record<string, any>>()
  if (Array.isArray(progressValue)) for (const entry of progressValue.slice(0, 1000)) {
    const sub = record(record(entry)?.subscription), p = record(record(entry)?.progress)
    if (sub?.user_id === userId && positiveId(sub.id) && p?.id === sub.id) progress.set(sub.id, p)
  }
  return value.flatMap(value => {
    const sub = record(value), group = record(sub?.group)
    if (!sub || sub.user_id !== userId || sub.status !== 'active') return []
    const expiresAt = date(sub.expires_at)
    if (expiresAt && Date.parse(expiresAt) <= Date.now()) return []
    const windows: SakuraApiQuotaWindow[] = []
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      const p = record(progress.get(sub.id)?.[period])
      if (p) {
        const limit = amount(p.limit_usd), used = amount(p.used_usd), remaining = amount(p.remaining_usd)
        windows.push({ period, ...(limit !== undefined ? { limit } : {}), ...(used !== undefined ? { used } : {}),
          ...(limit !== undefined && limit > 0 && remaining !== undefined ? { remaining } : {}), ...(date(p.resets_at) ? { resetAt: date(p.resets_at) } : {}) })
      } else if (group?.[period + '_limit_usd'] != null || sub[period + '_usage_usd'] != null) {
        windows.push(...parseSakuraApiUsage({ subscription: { [period + '_limit_usd']: group?.[period + '_limit_usd'],
          [period + '_usage_usd']: sub[period + '_usage_usd'] } }).subscriptions![0]!.windows)
      }
    }
    return [{ name: accountText(group?.name) || '订阅', ...(expiresAt ? { expiresAt } : {}), windows }]
  }).slice(0, 100)
}

export function parseSakuraKeyChoice(value: unknown, userId: number): SakuraApiKeyChoice {
  const row = record(value)
  if (!row || !positiveId(row.id) || row.user_id !== userId || typeof row.status !== 'string') throw new SakuraApiError('SakuraAPI 返回了无效或非本账号的 Key。', 502)
  const quota = amount(row.quota), used = amount(row.quota_used), expiresAt = date(row.expires_at)
  const reason = row.status !== 'active' ? 'Key 未启用' : row.expires_at != null && (!expiresAt || Date.parse(expiresAt) <= Date.now()) ? 'Key 已过期'
    : quota === undefined || used === undefined ? 'Key 额度信息无效或未提供'
    : quota > 0 && used >= quota ? 'Key 额度不足' : undefined
  const groupIds = Array.isArray(row.group_bindings) ? [...new Set<number>(row.group_bindings.slice(0, 32)
    .flatMap((value: unknown) => positiveId(record(value)?.group_id) ? [record(value)!.group_id as number] : []))]
    : positiveId(row.group_id) ? [row.group_id] : []
  return { id: row.id, name: accountText(row.name) || 'Key ' + row.id, status: accountText(row.status, 40), usable: !reason,
    ...(reason ? { reason } : {}), ...(expiresAt ? { expiresAt } : {}), ...(quota !== undefined ? { quota } : {}),
    ...(used !== undefined ? { used } : {}), ...(quota !== undefined && quota > 0 && used !== undefined ? { remaining: Math.max(0, quota - used) } : {}), groupIds }
}

export function selectedSakuraKey(value: unknown, userId: number, expectedId?: number): { choice: SakuraApiKeyChoice; apiKey: string } {
  const choice = parseSakuraKeyChoice(value, userId), row = record(value)!
  if (expectedId !== undefined && choice.id !== expectedId || !choice.usable || !validToken(row.key) || !/^[\x21-\x7e]+$/.test(row.key)) {
    throw new SakuraApiError('此 Key 已失效、额度不足或不属于当前账号，请选择其他 Key。', 409)
  }
  return { choice, apiKey: row.key }
}

export function parseSakuraKeyPage(value: unknown, userId: number): SakuraApiKeyPage {
  const row = record(value)
  if (!row || !Array.isArray(row.items) || row.items.length > 100 || !positiveId(row.page) || !positiveId(row.page_size) || row.page_size > 100 ||
    !Number.isSafeInteger(row.total) || row.total < 0 || !Number.isSafeInteger(row.pages) || row.pages < 0) throw new SakuraApiError('SakuraAPI 返回了无效 Key 分页。', 502)
  return { items: row.items.map((value: unknown) => parseSakuraKeyChoice(value, userId)), total: row.total, page: row.page, pageSize: row.page_size, pages: row.pages }
}

export function parseSakuraGroups(value: unknown, ratesValue?: unknown): SakuraApiGroupChoice[] {
  if (!Array.isArray(value) || value.length > 1000) throw new SakuraApiError('SakuraAPI 返回了无效可用分组。', 502)
  const rates = record(ratesValue), ids = new Set<number>()
  return value.flatMap(value => {
    const row = record(value)
    // Subscription groups remain visible in account quota data, not in the
    // pay-as-you-go model groups offered for a newly created desktop Key.
    // Older compatible responses omit subscription_type; never infer from names.
    if (!row || !positiveId(row.id) || row.status !== 'active' || ids.has(row.id) ||
      row.subscription_type !== undefined && row.subscription_type !== 'standard') return []
    ids.add(row.id)
    const rate = amount(rates?.[String(row.id)] ?? row.rate_multiplier)
    return [{ id: row.id, name: accountText(row.name) || '分组 ' + row.id, platform: accountText(row.platform, 40),
      ...(rate !== undefined ? { rateMultiplier: rate } : {}) }]
  })
}