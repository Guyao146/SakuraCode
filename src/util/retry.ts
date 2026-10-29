/** A bounded failure streak, not a rolling counter that silently retries forever. */
export interface RetryPolicy {
  enabled: boolean
  windowMs: number
  maxRetries: number
  delayMs: number
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  enabled: true, windowMs: 60_000, maxRetries: 3, delayMs: 2_000,
})

export function validateRetryPolicy(value: unknown): RetryPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('重试策略必须是一个对象。')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['enabled', 'windowMs', 'maxRetries', 'delayMs'].includes(key)) ||
    typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.windowMs) ||
    Number(row.windowMs) < 1_000 || Number(row.windowMs) > 3_600_000 ||
    !Number.isSafeInteger(row.maxRetries) || Number(row.maxRetries) < 0 || Number(row.maxRetries) > 20 ||
    !Number.isSafeInteger(row.delayMs) || Number(row.delayMs) < 0 || Number(row.delayMs) > 60_000 ||
    Number(row.delayMs) >= Number(row.windowMs)) {
    throw new Error('重试时间窗口须为 1–3600 秒，次数为 0–20，间隔为 0–60 秒且小于时间窗口。')
  }
  return { enabled: row.enabled, windowMs: Number(row.windowMs), maxRetries: Number(row.maxRetries), delayMs: Number(row.delayMs) }
}

/** Adapters preserve structured failure information instead of guessing from all errors. */
export class LLMRequestError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly retryAfterMs = 0, readonly status?: number) {
    super(message)
    this.name = 'LLMRequestError'
  }
}

export function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 86_400_000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 86_400_000) : 0
}

export function isRetryableFailure(error: unknown): boolean {
  if (error instanceof LLMRequestError) return error.retryable
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'CancellationError') return false
  const cause = error.cause as { code?: unknown } | undefined
  const code = (error as NodeJS.ErrnoException).code ?? cause?.code
  if (typeof code === 'string' && /^(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_(?:CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT|SOCKET))$/.test(code)) return true
  if (error.name === 'TimeoutError') return true
  const http = /\bHTTP\s+(\d{3})\b/i.exec(error.message)
  if (http) return retryableStatus(Number(http[1]))
  return /fetch failed|network error|socket hang up|connection (?:reset|closed)|stream (?:interrupted|disconnected)|temporarily unavailable/i.test(error.message)
}