/** Per-attempt token estimates and per-turn wall time. Provider usage frames are cumulative, not deltas. */
import { performance } from 'node:perf_hooks'
import type { SessionEventRecord, StreamSummary, TurnMetrics, UsageStats } from '../core/types.js'
import { estimateTokens } from './tokens.js'

const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

export function streamOutputTokens(stream: StreamSummary): number {
  return estimateTokens(stream.text) + estimateTokens(stream.thinking ?? '') + stream.toolCalls.reduce((total, call) =>
    total + estimateTokens(call.function.name + ' ' + call.function.arguments), 0)
}

export class TurnMeter {
  readonly startedAt = new Date().toISOString()
  private readonly start = performance.now()
  private input = 0
  private output = 0
  private reported = 0
  private estimated = 0
  private requests = 0
  private retries = 0
  usage?: UsageStats

  attempt(stream: StreamSummary, inputEstimate: number, retry = false): void {
    const estimates = { inputTokens: inputEstimate, outputTokens: streamOutputTokens(stream) }
    stream.estimatedUsage = estimates
    for (const field of ['inputTokens', 'outputTokens'] as const) {
      const value = stream.usage?.[field]
      if (valid(value)) { this.reported++; this[field === 'inputTokens' ? 'input' : 'output'] += value }
      else { this.estimated++; this[field === 'inputTokens' ? 'input' : 'output'] += estimates[field] }
    }
    if (stream.usage) {
      this.usage ??= {}
      for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'] as const) {
        const value = stream.usage[field]
        if (valid(value)) this.usage[field] = (this.usage[field] ?? 0) + value
      }
    }
    this.requests++
    if (retry) this.retries++
  }

  finish(status: TurnMetrics['status']): TurnMetrics {
    return { startedAt: this.startedAt, endedAt: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - this.start)),
      inputTokens: this.input, outputTokens: this.output, totalTokens: this.input + this.output,
      usageSource: this.reported ? this.estimated ? 'mixed' : 'reported' : 'estimated',
      requests: this.requests, retries: this.retries, status, scope: 'agent' }
  }
}

export function teamMetrics(rows: readonly TurnMetrics[]): TurnMetrics {
  if (!rows.length) throw new Error('A team summary requires at least one completed turn')
  const start = Math.min(...rows.map(row => Date.parse(row.startedAt)))
  const end = Math.max(...rows.map(row => Date.parse(row.endedAt)))
  const reported = rows.some(row => row.usageSource !== 'estimated')
  const estimated = rows.some(row => row.usageSource !== 'reported')
  const failed = rows.filter(row => row.status === 'error' || row.status === 'rejected').length
  const cancelled = rows.filter(row => row.status === 'cancelled').length
  const inputTokens = rows.reduce((total, row) => total + row.inputTokens, 0)
  const outputTokens = rows.reduce((total, row) => total + row.outputTokens, 0)
  return { startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), elapsedMs: Math.max(0, end - start),
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, requests: rows.reduce((total, row) => total + row.requests, 0),
    retries: rows.reduce((total, row) => total + row.retries, 0), usageSource: reported ? estimated ? 'mixed' : 'reported' : 'estimated',
    scope: 'team', members: rows.length, failedMembers: failed, cancelledMembers: cancelled,
    status: failed ? 'error' : cancelled ? 'cancelled' : 'done' }
}

export interface RecordedTurnSummary { userSeq: number; metrics: TurnMetrics; teamSize?: number }

/** Old logs have no reliable turn-end clock: label their bounded timestamp/stream reconstruction as approximate. */
export function recordedTurnSummaries(events: readonly SessionEventRecord[]): RecordedTurnSummary[] {
  const summaries = new Map<number, RecordedTurnSummary>()
  let user: Extract<SessionEventRecord, { type: 'user/message' }> | undefined
  let streams: Extract<SessionEventRecord, { type: 'assistant/message' | 'assistant/attempt' }>[] = []
  let end: SessionEventRecord | undefined
  const flush = (): void => {
    if (!user || summaries.has(user.seq) || !streams.length) return
    let inputTokens = 0, outputTokens = 0, reported = 0, estimated = 0
    for (const event of streams) {
      const stream = event.payload.stream
      if (!stream) continue
      for (const field of ['inputTokens', 'outputTokens'] as const) {
        const real = stream.usage?.[field]
        const fallback = stream.estimatedUsage?.[field] ?? (field === 'outputTokens' ? streamOutputTokens(stream) : estimateTokens(user.payload.content))
        if (valid(real)) reported++; else estimated++
        const value = valid(real) ? real : fallback
        if (field === 'inputTokens') inputTokens += value; else outputTokens += value
      }
    }
    const last = streams.at(-1)!
    if (last.type === 'assistant/message' && last.payload.tool_calls?.length || last.type === 'assistant/attempt' && last.payload.retry) return
    const status = last.type === 'assistant/attempt' && !last.payload.retry ? last.payload.error === 'cancelled' ? 'cancelled' : 'error' : 'done'
    summaries.set(user.seq, { userSeq: user.seq, metrics: { startedAt: user.time, endedAt: end?.time ?? last.time,
      elapsedMs: Math.max(0, Date.parse(end?.time ?? last.time) - Date.parse(user.time)) || 0,
      inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
      usageSource: reported ? estimated ? 'mixed' : 'reported' : 'estimated', requests: streams.filter(row => row.payload.stream).length,
      retries: streams.filter(row => row.type === 'assistant/attempt' && row.payload.retry).length, status, scope: 'agent', legacy: true } })
  }
  // Explicit notes can arrive after the following user turn (parallel experts), so collect them first.
  for (const event of events) {
    if (event.type !== 'session/note' || event.payload.note !== 'turn-summary') continue
    const { userSeq, metrics, teamSize } = event.payload as unknown as RecordedTurnSummary
    if (!Number.isSafeInteger(userSeq) || !metrics || !valid(metrics.totalTokens) || !valid(metrics.elapsedMs)) continue
    if (!summaries.has(userSeq) || metrics.scope === 'team') summaries.set(userSeq, { userSeq, metrics, ...(teamSize ? { teamSize } : {}) })
  }
  for (const event of events) {
    if (event.type === 'user/message') { flush(); user = event; streams = []; end = event }
    else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') { streams.push(event); end = event }
    else if (event.type === 'tool/result') end = event
  }
  flush()
  return [...summaries.values()].sort((a, b) => a.userSeq - b.userSeq)
}