import { describe, expect, it } from 'vitest'
import { CONTEXT_CATEGORIES, estimateRequestContextTokens, estimateToolSchemasTokens, inspectContext, lastContextMarkerIndex, validateContextBudget } from '../src/util/context.js'
import { estimateMessagesTokens } from '../src/util/tokens.js'
import type { ChatMessage, SessionEventRecord, ToolSchema } from '../src/core/types.js'

const tools: ToolSchema[] = [{ name: 'read', description: 'PRIVATE_TOOL_DESCRIPTION', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
const messages: ChatMessage[] = [
  { role: 'system', content: 'PRIVATE_SYSTEM' },
  { role: 'user', content: [{ type: 'text', text: 'PRIVATE_USER' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIVATE_IMAGE' } }] },
  { role: 'assistant', content: 'PRIVATE_ASSISTANT', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{"path":"PRIVATE_PATH"}' } }] },
  { role: 'tool', tool_call_id: '1', content: 'PRIVATE_OUTPUT' },
  { role: 'assistant', content: null, tool_calls: [{ id: '2', type: 'function', function: { name: 'read', arguments: '{}' } }] },
]

describe('context window accounting', () => {
  it('includes every model-visible field once and never exposes contents', () => {
    const result = inspectContext(messages, tools)
    expect(result.totalTokens).toBe(estimateMessagesTokens(messages) + estimateToolSchemasTokens(tools))
    expect(result.totalTokens).toBe(estimateRequestContextTokens(messages, tools))
    expect(result.categories.map(row => row.category)).toEqual(CONTEXT_CATEGORIES)
    expect(result.categories.reduce((sum, row) => sum + row.tokens, 0)).toBe(result.totalTokens)
    expect(result.categories.reduce((sum, row) => sum + row.percent, 0)).toBeCloseTo(100)
    expect(result.segments.reduce((sum, row) => sum + row.tokens, 0)).toBe(result.totalTokens)
    expect(result.segments.map(row => row.category)).toEqual(['system', 'tools', 'user', 'assistant', 'toolCalls', 'toolResults', 'toolCalls'])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })

  it('does not pretend logged reasoning is sent in model context', () => {
    const event: SessionEventRecord = { seq: 1, time: '', type: 'assistant/message', payload: { role: 'assistant', content: 'answer', stream: { text: 'answer', toolCalls: [], durationMs: 1, thinking: 'private thinking' } } }
    const result = inspectContext([{ role: 'assistant', content: 'answer' }], [], [event])
    expect(result.excludedThinkingTokens).toBeGreaterThan(0)
    expect(result.categories.find(row => row.category === 'thinking')).toMatchObject({ tokens: 0, percent: 0 })
    expect(result.totalTokens).toBe(estimateMessagesTokens([{ role: 'assistant', content: 'answer' }]))
    const cleared: SessionEventRecord = { seq: 2, time: '', type: 'session/note', payload: { note: 'context-clear' } }
    expect(inspectContext([], [], [event, cleared]).excludedThinkingTokens).toBe(0)
    expect(lastContextMarkerIndex([event, cleared])).toBe(1)
  })

  it('handles empty input and tools-only input without NaN', () => {
    const empty = inspectContext([])
    expect(empty.totalTokens).toBe(0)
    expect(empty.categories.every(row => row.percent === 0)).toBe(true)
    expect(empty.segments).toEqual([])
    expect(inspectContext([], tools).totalTokens).toBe(estimateToolSchemasTokens(tools))
  })

  it('bounds ordered segments while preserving totals and the newest sequence', () => {
    const history: ChatMessage[] = Array.from({ length: 1000 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'abcd' }))
    const result = inspectContext(history, tools)
    expect(result.segments.length).toBeLessThanOrEqual(256)
    expect(result.sequenceMerged).toBeGreaterThan(0)
    expect(result.segments.reduce((total, segment) => total + segment.tokens, 0)).toBe(estimateRequestContextTokens(history, tools))
    expect(result.segments.slice(-2).map(row => row.category)).toEqual(['user', 'assistant'])
  })
})

describe('context budget validation', () => {
  it('accepts fractional percentages and explicitly disabled independent triggers', () => {
    expect(validateContextBudget({ contextWindowTokens: 128000, thresholdPercent: 72.5, autoThreshold: 0 })).toEqual({ contextWindowTokens: 128000, thresholdPercent: 72.5, autoThreshold: 0 })
    expect(validateContextBudget({ contextWindowTokens: 64000, thresholdPercent: 0, autoThreshold: 0 }).thresholdPercent).toBe(0)
  })

  it.each([null, [], {}, { contextWindowTokens: 0, thresholdPercent: 75, autoThreshold: 120 }, { contextWindowTokens: 2000001, thresholdPercent: 75, autoThreshold: 120 },
    { contextWindowTokens: '64000', thresholdPercent: 75, autoThreshold: 120 }, { contextWindowTokens: 64000, thresholdPercent: 100, autoThreshold: 120 },
    { contextWindowTokens: 64000, thresholdPercent: NaN, autoThreshold: 120 }, { contextWindowTokens: 64000, thresholdPercent: 75, autoThreshold: -1 }])('rejects invalid settings %j', value => {
    expect(() => validateContextBudget(value)).toThrow()
  })
})