/** Model-visible context accounting. Counts only; never exposes prompt or tool contents. */
import type { ChatMessage, SessionEventRecord, ToolSchema } from '../core/types.js'
import { estimateMessagesTokens, estimateTokens, MESSAGE_OVERHEAD } from './tokens.js'

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 64_000
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000
const MAX_SEGMENTS = 256

export interface ContextBudgetSettings {
  /** Local planning budget, not a claim about the provider's context window. */
  contextWindowTokens: number
  /** 0 disables the token trigger; the event trigger remains independent. */
  thresholdPercent: number
  /** 0 disables the event trigger. */
  autoThreshold: number
}

export function validateContextBudget(value: unknown): ContextBudgetSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('上下文阈值设置必须是对象。')
  const row = value as Record<string, unknown>
  if (!Number.isSafeInteger(row.contextWindowTokens) || Number(row.contextWindowTokens) < 1024 || Number(row.contextWindowTokens) > MAX_CONTEXT_WINDOW_TOKENS) {
    throw new Error('本地上下文预算必须是 1,024～2,000,000 之间的整数 tokens。')
  }
  if (typeof row.thresholdPercent !== 'number' || !Number.isFinite(row.thresholdPercent) || row.thresholdPercent < 0 || row.thresholdPercent > 99) {
    throw new Error('压缩百分比必须是 0～99 之间的数字；0 关闭按 token 自动压缩。')
  }
  if (!Number.isSafeInteger(row.autoThreshold) || Number(row.autoThreshold) < 0 || Number(row.autoThreshold) > 1_000_000) {
    throw new Error('事件阈值必须是 0～1,000,000 之间的整数；0 关闭按事件自动压缩。')
  }
  return { contextWindowTokens: Number(row.contextWindowTokens), thresholdPercent: row.thresholdPercent, autoThreshold: Number(row.autoThreshold) }
}

/** A clear is a projection boundary, just like compaction, but has no summary. */
export function lastContextMarkerIndex(events: readonly SessionEventRecord[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event.type === 'session/note' && (event.payload.note === 'compaction' || event.payload.note === 'context-clear')) return i
  }
  return -1
}

/** Tool schemas are part of the request, even though they are not chat messages. */
export function estimateToolSchemasTokens(tools: readonly ToolSchema[]): number {
  return tools.reduce((total, tool) => total + MESSAGE_OVERHEAD + estimateTokens(JSON.stringify({ type: 'function', function: tool })), 0)
}

export function estimateRequestContextTokens(messages: ChatMessage[], tools: readonly ToolSchema[] = []): number {
  return estimateMessagesTokens(messages) + estimateToolSchemasTokens(tools)
}

export type ContextCategory = 'system' | 'tools' | 'user' | 'assistant' | 'thinking' | 'toolCalls' | 'toolResults'
export const CONTEXT_CATEGORIES: readonly ContextCategory[] = ['system', 'tools', 'user', 'assistant', 'thinking', 'toolCalls', 'toolResults']

export interface ContextSegment {
  category: ContextCategory
  tokens: number
}

export interface ContextBreakdown {
  estimated: true
  totalTokens: number
  messageTokens: number
  toolDefinitionTokens: number
  /** Reasoning is logged for the UI, but the adapters do not replay it. */
  excludedThinkingTokens: number
  categories: Array<ContextSegment & { percent: number }>
  segments: ContextSegment[]
  /** Older segments folded by category to bound the response; totals stay exact. */
  sequenceMerged: number
}

export function inspectContext(messages: ChatMessage[], tools: readonly ToolSchema[] = [], events: readonly SessionEventRecord[] = []): ContextBreakdown {
  const counts = Object.fromEntries(CONTEXT_CATEGORIES.map(category => [category, 0])) as Record<ContextCategory, number>
  let segments: ContextSegment[] = []
  const add = (category: ContextCategory, tokens: number): void => {
    if (!tokens) return
    counts[category] += tokens
    const last = segments.at(-1)
    if (last?.category === category) last.tokens += tokens
    else segments.push({ category, tokens })
  }
  const toolDefinitionTokens = estimateToolSchemasTokens(tools)
  let definitionsAdded = false
  for (const message of messages) {
    if (message.role !== 'system' && !definitionsAdded) {
      add('tools', toolDefinitionTokens)
      definitionsAdded = true
    }
    if (message.role === 'assistant') {
      const calls = message.tool_calls ?? []
      const content = estimateTokens(message.content ?? '')
      // An assistant carrying only calls belongs to toolCalls, including its envelope.
      add('assistant', content + (content || !calls.length ? MESSAGE_OVERHEAD : 0))
      add('toolCalls', calls.reduce((total, call) => total + estimateTokens(call.function.name + ' ' + call.function.arguments), 0) + (!content && calls.length ? MESSAGE_OVERHEAD : 0))
    } else {
      add(message.role === 'tool' ? 'toolResults' : message.role, estimateMessagesTokens([message]))
    }
  }
  if (!definitionsAdded) add('tools', toolDefinitionTokens)
  const totalTokens = CONTEXT_CATEGORIES.reduce((total, category) => total + counts[category], 0)
  const activeEvents = events.slice(lastContextMarkerIndex(events) + 1)
  const excludedThinkingTokens = activeEvents.reduce((total, event) => total + (event.type === 'assistant/message' ? estimateTokens(event.payload.stream?.thinking ?? '') : 0), 0)
  let sequenceMerged = 0
  if (segments.length > MAX_SEGMENTS) {
    sequenceMerged = segments.length - (MAX_SEGMENTS - CONTEXT_CATEGORIES.length)
    const older = segments.slice(0, sequenceMerged)
    const prefix = CONTEXT_CATEGORIES.map(category => ({ category, tokens: older.reduce((total, segment) => total + (segment.category === category ? segment.tokens : 0), 0) })).filter(segment => segment.tokens > 0)
    segments = [...prefix, ...segments.slice(sequenceMerged)]
  }
  return {
    estimated: true, totalTokens, messageTokens: totalTokens - toolDefinitionTokens, toolDefinitionTokens, excludedThinkingTokens,
    categories: CONTEXT_CATEGORIES.map(category => ({ category, tokens: counts[category], percent: totalTokens ? counts[category] * 100 / totalTokens : 0 })),
    segments, sequenceMerged,
  }
}