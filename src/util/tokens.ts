/**
 * Cheap token estimation — NOT a tokenizer.
 *
 * Used to decide when a conversation is getting close to the model's context
 * budget (auto-compaction, GUI context meter). The heuristic is deliberately
 * simple: ~4 ASCII characters per token, 1 token per CJK character (CJK
 * characters pack far more meaning per code point). Images are charged a
 * flat 800 tokens, matching the common small-detail cost of vision models.
 *
 * Accuracy target: within ~30% of a real BPE count, good enough for
 * thresholds, never for billing.
 */

import type { CacheCoverage, ChatMessage, SessionEventRecord, UsageStats } from '../core/types.js'

const CJK_RANGES: Array<[number, number]> = [
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0x3000, 0x303f], // CJK punctuation
  [0xff00, 0xffef], // Fullwidth forms
  [0x3040, 0x30ff], // Hiragana / Katakana
]

function isCJK(code: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => code >= lo && code <= hi)
}

/**
 * estimateTokens — CJK characters count 1 each; runs of non-whitespace
 * non-CJK characters count ceil(runLength / 4). Whitespace separates runs.
 * 'hello world' → 2 + 2 = 4; '你好世界' → 4.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let tokens = 0
  let run = 0
  const flush = () => {
    if (run > 0) {
      tokens += Math.ceil(run / 4)
      run = 0
    }
  }
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (isCJK(code)) {
      flush()
      tokens++
    } else if (/\s/.test(ch)) {
      flush()
    } else {
      run++
    }
  }
  flush()
  return tokens
}

/** Flat cost charged per image part. */
export const IMAGE_TOKENS = 800

/** Per-message structural overhead (roles, delimiters). */
export const MESSAGE_OVERHEAD = 4

/**
 * estimateMessagesTokens — sums every text-bearing field of a chat history:
 * system/user(string)/tool content, user multipart text parts (image parts
 * cost IMAGE_TOKENS), assistant content plus each tool_call's function name
 * and arguments JSON. Every message adds MESSAGE_OVERHEAD.
 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    total += MESSAGE_OVERHEAD
    if (message.role === 'system' || message.role === 'tool') {
      total += estimateTokens(message.content)
    } else if (message.role === 'user') {
      if (typeof message.content === 'string') {
        total += estimateTokens(message.content)
      } else {
        for (const part of message.content) {
          total += part.type === 'text' ? estimateTokens(part.text) : IMAGE_TOKENS
        }
      }
    } else {
      total += estimateTokens(message.content ?? '')
      for (const call of message.tool_calls ?? []) {
        total += estimateTokens(call.function.name + ' ' + call.function.arguments)
      }
    }
  }
  return total
}


/** Cache reporting and cache-rate coverage are separate: cache-only reports have no valid rate denominator. */
export function emptyCacheCoverage(): CacheCoverage {
  return { requests: 0, reportedRequests: 0, rateRequests: 0, inputTokens: 0, cachedTokens: 0 }
}

export function validTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Validate persisted coverage before using its counts or paired token totals. */
export function validCacheCoverage(value: unknown): value is CacheCoverage {
  if (!value || typeof value !== 'object') return false
  const coverage = value as CacheCoverage
  return [coverage.requests, coverage.reportedRequests, coverage.rateRequests].every(count => Number.isSafeInteger(count) && count >= 0)
    && coverage.rateRequests <= coverage.reportedRequests && coverage.reportedRequests <= coverage.requests
    && validTokenCount(coverage.inputTokens) && validTokenCount(coverage.cachedTokens)
    && coverage.cachedTokens <= coverage.inputTokens
    && (coverage.rateRequests > 0 || coverage.inputTokens === 0 && coverage.cachedTokens === 0)
}

/** Record one attempt, including attempts without usage. Explicit zero is a report. */
export function recordCacheCoverage(coverage: CacheCoverage, usage?: UsageStats): void {
  coverage.requests++
  if (!validTokenCount(usage?.cachedTokens)) return
  coverage.reportedRequests++
  if (!validTokenCount(usage?.inputTokens) || usage.cachedTokens > usage.inputTokens) return
  coverage.rateRequests++
  coverage.inputTokens += usage.inputTokens
  coverage.cachedTokens += usage.cachedTokens
}

/** Unknown or zero-input denominators have no meaningful percentage, not a synthetic 0%. */
export function cacheHitRate(coverage: unknown): number | undefined {
  return validCacheCoverage(coverage) && coverage.rateRequests > 0 && coverage.inputTokens > 0
    ? coverage.cachedTokens / coverage.inputTokens * 100 : undefined
}

/**
 * Session token accounting — real usage logged on each assistant/message or
 * assistant/attempt (stream.usage), not an estimate. A multi-step turn
 * contributes one row per step; cache coverage also counts unreported attempts.
 */
export interface SessionTokenStats {
  /** assistant events carrying usage; unreported attempts only enter cacheCoverage.requests. */
  requests: number
  inputTokens: number
  outputTokens: number
  /** A subset of inputTokens, not an additional charge; may also contain cache-only reports. */
  cachedTokens: number
  /** Reasoning tokens inside outputTokens, when the provider reports them. */
  reasoningTokens: number
  cacheCoverage: CacheCoverage
}

/** Sum reported usage once per logged attempt; never add cache/reasoning subsets to input/output. */
export function summarizeUsage(events: ReadonlyArray<SessionEventRecord>): SessionTokenStats {
  const stats: SessionTokenStats = { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, cacheCoverage: emptyCacheCoverage() }
  for (const event of events) {
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const stream = event.payload.stream
    if (!stream) continue
    const usage = stream.usage
    recordCacheCoverage(stats.cacheCoverage, usage)
    if (!usage) continue
    stats.requests++
    for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'] as const) {
      const value = usage[field]
      if (validTokenCount(value)) stats[field] += value
    }
  }
  return stats
}
