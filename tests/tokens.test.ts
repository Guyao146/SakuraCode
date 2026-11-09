import { describe, expect, it } from 'vitest'
import { cacheHitRate, estimateMessagesTokens, estimateTokens, IMAGE_TOKENS, MESSAGE_OVERHEAD, summarizeUsage } from '../src/util/tokens.js'
import type { SessionEventRecord, UsageStats } from '../src/core/types.js'

describe('estimateTokens', () => {
  it('returns 0 for empty and whitespace-only text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n\t ')).toBe(0)
  })

  it('estimates ASCII words at ~4 chars per token', () => {
    // 'hello' → ceil(5/4) = 2, 'world' → 2 → 4
    expect(estimateTokens('hello world')).toBe(4)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts CJK characters at 1 token each', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('。')).toBe(1) // CJK punctuation
  })

  it('handles mixed CJK and ASCII', () => {
    // '你好' = 2 CJK + ' hello' → ceil(5/4)=2 → 4
    expect(estimateTokens('你好 hello')).toBe(4)
    // Same visual length of pure ASCII is cheaper than CJK-heavy text
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('八个汉字')).toBe(4)
  })

  it('grows when content doubles', () => {
    const one = 'do the thing carefully'
    expect(estimateTokens(one + ' ' + one)).toBeGreaterThan(estimateTokens(one))
  })
})

describe('estimateMessagesTokens', () => {
  it('sums string contents plus per-message overhead', () => {
    const total = estimateMessagesTokens([
      { role: 'system', content: 'hello world' }, // 4 + 4
      { role: 'user', content: 'a b c' }, // 3 + 4
    ])
    // 'a b c' → three runs of 1 char → 3
    expect(total).toBe((4 + 4) + (3 + 4))
  })

  it('charges image parts a flat cost', () => {
    const total = estimateMessagesTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abcd' }, // 1
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ])
    expect(total).toBe(1 + IMAGE_TOKENS + MESSAGE_OVERHEAD)
  })

  it('includes assistant tool_call function names and arguments', () => {
    const args = JSON.stringify({ command: 'echo hi' })
    const total = estimateMessagesTokens([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: args } }] },
    ])
    expect(total).toBe(MESSAGE_OVERHEAD + estimateTokens('bash ' + args))
  })

  it('includes tool message contents', () => {
    const total = estimateMessagesTokens([{ role: 'tool', tool_call_id: 'c1', content: 'abcdefgh' }])
    expect(total).toBe(MESSAGE_OVERHEAD + 2)
  })

  it('is monotonic as the conversation grows', () => {
    const one = estimateMessagesTokens([{ role: 'user', content: '八个汉字' }])
    const two = estimateMessagesTokens([
      { role: 'user', content: '八个汉字' },
      { role: 'assistant', content: '收到，马上处理' },
    ])
    expect(two).toBeGreaterThan(one)
  })
})

const usageEvents = (rows: Array<UsageStats | undefined>): SessionEventRecord[] => rows.map((usage, index) => ({
  seq: index + 1, time: new Date(index).toISOString(), type: 'assistant/message',
  payload: { role: 'assistant', content: '', stream: { text: '', toolCalls: [], durationMs: 0, ...(usage ? { usage } : {}) } },
}))

describe('summarizeUsage cache coverage', () => {
  it('keeps cache unreported when no provider reports it, including attempts without usage', () => {
    const stats = summarizeUsage(usageEvents([{ inputTokens: 100, outputTokens: 10 }, undefined, { outputTokens: 4 }]))
    expect(stats).toEqual({ requests: 2, inputTokens: 100, outputTokens: 14, cachedTokens: 0, reasoningTokens: 0,
      cacheCoverage: { requests: 3, reportedRequests: 0, rateRequests: 0, inputTokens: 0, cachedTokens: 0 } })
    expect(cacheHitRate(stats.cacheCoverage)).toBeUndefined()
    expect(summarizeUsage([]).cacheCoverage.requests).toBe(0)
  })

  it('retains explicit zero reports rather than treating them as missing', () => {
    const stats = summarizeUsage(usageEvents([{ inputTokens: 100, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }]))
    expect(stats.cacheCoverage).toEqual({ requests: 1, reportedRequests: 1, rateRequests: 1, inputTokens: 100, cachedTokens: 0 })
    expect(cacheHitRate(stats.cacheCoverage)).toBe(0)
    const zero = summarizeUsage(usageEvents([{ inputTokens: 0, cachedTokens: 0 }]))
    expect(zero.cacheCoverage).toEqual({ requests: 1, reportedRequests: 1, rateRequests: 1, inputTokens: 0, cachedTokens: 0 })
    expect(cacheHitRate(zero.cacheCoverage)).toBeUndefined()
  })

  it('uses only requests reporting both valid input and cache for the rate, never unrelated input', () => {
    const stats = summarizeUsage(usageEvents([
      { inputTokens: 900, outputTokens: 10 },
      { inputTokens: 100, outputTokens: 20, cachedTokens: 50, reasoningTokens: 5 },
      { cachedTokens: 30 },
      undefined,
    ]))
    expect(stats).toMatchObject({ requests: 3, inputTokens: 1000, outputTokens: 30, cachedTokens: 80, reasoningTokens: 5,
      cacheCoverage: { requests: 4, reportedRequests: 2, rateRequests: 1, inputTokens: 100, cachedTokens: 50 } })
    expect(cacheHitRate(stats.cacheCoverage)).toBe(50)
    expect(stats.inputTokens + stats.outputTokens).toBe(1030)
  })

  it('excludes invalid negative, non-finite and non-number fields from sums and rate coverage', () => {
    const stats = summarizeUsage(usageEvents([
      { inputTokens: -1, outputTokens: Infinity, cachedTokens: 10, reasoningTokens: NaN },
      { inputTokens: NaN, outputTokens: -3, cachedTokens: 0 },
      { inputTokens: 100, cachedTokens: -10 },
      { inputTokens: 100, cachedTokens: NaN },
      { inputTokens: '100', outputTokens: null, cachedTokens: '10' } as unknown as UsageStats,
    ]))
    expect(stats).toMatchObject({ inputTokens: 200, outputTokens: 0, cachedTokens: 10, reasoningTokens: 0,
      cacheCoverage: { requests: 5, reportedRequests: 2, rateRequests: 0, inputTokens: 0, cachedTokens: 0 } })
    expect(cacheHitRate(stats.cacheCoverage)).toBeUndefined()
  })

  it('excludes cache counts larger than input from paired samples without clamping or borrowing denominators', () => {
    const invalid = [{ inputTokens: 100, cachedTokens: 150 }, { inputTokens: 0, cachedTokens: 50 }]
    const unpaired = summarizeUsage(usageEvents(invalid))
    expect(unpaired.cacheCoverage).toEqual({ requests: 2, reportedRequests: 2, rateRequests: 0, inputTokens: 0, cachedTokens: 0 })
    expect(cacheHitRate(unpaired.cacheCoverage)).toBeUndefined()
    const mixed = summarizeUsage(usageEvents([...invalid, { inputTokens: 100, cachedTokens: 25 }]))
    expect(mixed).toMatchObject({ inputTokens: 200, cachedTokens: 225,
      cacheCoverage: { requests: 3, reportedRequests: 3, rateRequests: 1, inputTokens: 100, cachedTokens: 25 } })
    expect(cacheHitRate(mixed.cacheCoverage)).toBe(25)
    for (const coverage of [null, {}, { ...mixed.cacheCoverage, requests: '3' }, { ...mixed.cacheCoverage, reportedRequests: 4 },
      { ...mixed.cacheCoverage, rateRequests: 0.5 }, { ...mixed.cacheCoverage, cachedTokens: 150 },
      { ...mixed.cacheCoverage, cachedTokens: Infinity }, { ...mixed.cacheCoverage, inputTokens: null }]) {
      expect(cacheHitRate(coverage)).toBeUndefined()
    }
  })

  it('counts logged retry attempts once and ignores events without streams and collaboration evidence', () => {
    const events = usageEvents([{ inputTokens: 10, outputTokens: 2, cachedTokens: 0 }])
    events.push({ seq: 2, time: new Date(1).toISOString(), type: 'assistant/attempt', payload: { retry: true, error: 'fixture',
      stream: { text: '', toolCalls: [], durationMs: 0, usage: { inputTokens: 20, cachedTokens: 10 } } } })
    events.push({ seq: 3, time: new Date(2).toISOString(), type: 'assistant/attempt', payload: { error: 'no request' } })
    events.push({ seq: 4, time: new Date(3).toISOString(), type: 'session/note', payload: { note: 'turn-summary', usage: { inputTokens: 999 } } })
    events.push({ seq: 5, time: new Date(4).toISOString(), type: 'collaboration/message', payload: { key: 'fixture', agentId: 'peer', agentName: 'peer',
      sourceSessionId: 'other', turnSeq: 1, messages: [{ role: 'assistant', content: 'peer output' }] } })
    expect(summarizeUsage(events)).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 2, cachedTokens: 10,
      cacheCoverage: { requests: 2, reportedRequests: 2, rateRequests: 2, inputTokens: 30, cachedTokens: 10 } })
  })
})
