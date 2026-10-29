/** Whitelist the fields documented by the deployed official /v1/usage page.
 * No account JWT, password, key material or arbitrary response metadata is returned. */
export interface SakuraApiQuotaWindow {
  period: 'daily' | 'weekly' | 'monthly' | 'quota' | '5h'
  limit?: number
  used?: number
  remaining?: number
  resetAt?: string
}

export interface SakuraApiSubscription {
  name: string
  expiresAt?: string
  windows: SakuraApiQuotaWindow[]
}

export interface SakuraApiUsageInfo {
  balance?: number
  balanceSource?: 'authorization' | 'usage' | 'account'
  balanceUpdatedAt?: string
  subscriptions?: SakuraApiSubscription[]
  quota?: SakuraApiQuotaWindow
  usage?: { requests?: number; inputTokens?: number; outputTokens?: number; cost?: number }
  usageSource?: 'key' | 'account'
  updatedAt?: string
  warning?: string
}

export const record = (v: unknown): Record<string, any> | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : undefined
export const validToken = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x20\x7f]/.test(v)
const number = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const date = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 80 && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : undefined

function quotaWindow(period: SakuraApiQuotaWindow['period'], limit: unknown, used: unknown, reset?: unknown): SakuraApiQuotaWindow {
  const cap = number(limit), consumed = number(used)
  return { period, ...(cap !== undefined ? { limit: cap } : {}), ...(consumed !== undefined ? { used: consumed } : {}),
    ...(cap !== undefined && cap > 0 && consumed !== undefined ? { remaining: Math.max(0, cap - consumed) } : {}),
    ...(date(reset) ? { resetAt: date(reset) } : {}) }
}

/** Missing amounts stay unknown; zero limit is unlimited, not zero remaining. */
export function parseSakuraApiUsage(value: unknown): SakuraApiUsageInfo {
  const row = record(value)
  if (!row || !['balance', 'subscription', 'subscriptions', 'quota', 'usage', 'remaining', 'mode'].some(key => Object.hasOwn(row, key))) {
    throw new Error('invalid SakuraAPI Key usage')
  }
  const total = record(record(row.usage)?.total)
  const usage = total ? { requests: number(total.requests), inputTokens: number(total.input_tokens),
    outputTokens: number(total.output_tokens), cost: number(total.actual_cost) } : undefined
  const rawSubscriptions = Array.isArray(row.subscriptions) ? row.subscriptions : row.subscription ? [row.subscription] : undefined
  const subscriptions = rawSubscriptions?.slice(0, 100).flatMap((value: unknown) => {
    const sub = record(value)
    if (!sub) return []
    const windows: SakuraApiQuotaWindow[] = []
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      if (sub[period + '_limit_usd'] !== undefined || sub[period + '_usage_usd'] !== undefined) {
        windows.push(quotaWindow(period, sub[period + '_limit_usd'], sub[period + '_usage_usd'], sub[period + '_reset_at']))
      }
    }
    const name = typeof sub.group_name === 'string' ? sub.group_name : typeof sub.plan_name === 'string' ? sub.plan_name
      : typeof row.planName === 'string' ? row.planName : '订阅'
    return [{ name: name.slice(0, 160), ...(date(sub.expires_at) ? { expiresAt: date(sub.expires_at) } : {}), windows }]
  })
  const quota = record(row.quota)
  return { ...(typeof row.balance === 'number' && Number.isFinite(row.balance) ? { balance: row.balance } : {}),
    ...(usage ? { usage } : {}), ...(subscriptions ? { subscriptions } : {}),
    ...(quota ? { quota: quotaWindow('quota', quota.limit, quota.used, quota.reset_at) } : {}),
    ...(row.status === 'quota_exhausted' ? { warning: '授权 Key 的额度已耗尽，请在官网充值或调整 Key 配额。' } : {}) }
}