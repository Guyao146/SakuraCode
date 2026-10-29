/**
 * core-compaction — context compaction service (ctx.compaction).
 *
 * compact() summarizes the records accumulated after the last compaction
 * marker into a single LLM-written summary and appends it as a session/note
 * carrying { note: 'compaction', summary }. Session.deriveMessages() already
 * projects such markers: everything before the newest marker (except the
 * system prompt) is replaced by the summary as a user message, so the next
 * turn starts from a bounded context without losing the thread.
 *
 * Auto-compaction: after each main turn (ui/turn/end with main !== false),
 * compact when events since the last marker or estimated context tokens reach
 * their threshold. Each threshold is independent; both must be 0 to disable.
 * Failures surface as kernel/error.
 */

import type { Context, Plugin } from '../kernel/index.js'
import type { LLMService } from '../core/llm.js'
import type { SessionService } from '../core/session.js'
import type { SessionEventRecord } from '../core/types.js'
import type { ToolsService } from '../core/tools.js'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, estimateRequestContextTokens, lastContextMarkerIndex as lastMarkerIndex, validateContextBudget, type ContextBudgetSettings } from '../util/context.js'

export interface CompactionConfig {
  /** Auto-compact at this many events after the last marker; 0 disables only this trigger. */
  auto?: number
  /** Auto-compact at this estimated context token count; 0 disables only this trigger. */
  autoTokens?: number
  /** Local planning budget for the GUI, not the provider's declared context limit. */
  contextWindowTokens?: number
  /** Optional percentage trigger; when supplied it takes precedence over autoTokens. */
  thresholdPercent?: number
  /** Hard cap on the summary text length. */
  maxSummaryChars?: number
  /**
   * Model used for summary requests (a registered model or adapter id). Empty
   * or omitted follows the current selection (ctx.llm.selectedModel()).
   */
  compactModel?: string
}

export interface CompactionResult {
  summary: string
  compactedEvents: number
  /** Nothing was appended: a tool is pending or the transcript changed during summarization. */
  deferred?: boolean
}

export interface CompactionService {
  /**
   * Summarize the prior summary plus records after it, then append a marker.
   * Concurrent calls for the same session share the first caller's attempt/focus.
   */
  compact(sessionId: string, opts?: { focus?: string; signal?: AbortSignal }): Promise<CompactionResult>
  /** Event count since the last marker (default 120; 0 disables only this trigger). */
  autoThreshold: number
  /** Estimated projected-context tokens (default 48000; 0 disables only this trigger). */
  autoTokensThreshold: number
  /** Local planning budget, default 64000 tokens. */
  contextWindowTokens: number
  /** Set the local budget and both independent triggers together. */
  setContextBudget(settings: ContextBudgetSettings): void
  /** Auto path: test either threshold and await any shared attempt, including deferrals. */
  maybeAutoCompact(sessionId: string): Promise<void>
  /** Includes pending automatic checks, which may still append a summary. */
  isCompacting(sessionId: string): boolean
  /** Model summarization requests name, or undefined to follow the current selection. */
  compactModel: string | undefined
  /** Override the compaction model at runtime; null/empty restores follow-selection. */
  setCompactModel(model?: string | null): void
}

const SUMMARY_INSTRUCTION =
  'summarize the conversation for a coding agent: user goals, decisions made, ' +
  'files touched, current state, pending work. Be factual and compact.'

/** Per-entry transcript cap, in characters. */
const ENTRY_LIMIT = 500
/** Whole-transcript cap; older lines are elided first (newest kept). */
const TRANSCRIPT_LIMIT = 24000
/** Default auto-compaction threshold (config `auto` overrides; 0 = off). */
const DEFAULT_AUTO_THRESHOLD = 120
/**
 * Default auto-compaction threshold on the estimated context size (config
 * `autoTokens` overrides; 0 = off). Fires independent of `auto` — whichever
 * trips first wins.
 */
const DEFAULT_AUTO_TOKENS = 48_000
/** Default summary cap (config `maxSummaryChars` overrides). */
const DEFAULT_SUMMARY_CHARS = 4000

const contextEvent = (event: SessionEventRecord): boolean => !(event.type === 'session/note' && ['turn-summary', 'expert-context'].includes(String(event.payload.note)) ||
  event.type === 'collaboration/message' && !event.payload.messages.length)

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max)
}

/** One transcript line per user/assistant/tool record; other types are skipped. */
function transcriptLine(e: SessionEventRecord): string | undefined {
  if (e.type === 'user/message') {
    return `[${e.seq}] user: ${truncate(e.payload.content, ENTRY_LIMIT)}`
  }
  if (e.type === 'assistant/message') {
    const calls = (e.payload.tool_calls ?? []).map((c) => c.function.name).filter(Boolean)
    const body =
      (e.payload.content ?? '').trim() || (calls.length ? `(tool_calls: ${calls.join(', ')})` : '(no content)')
    return `[${e.seq}] assistant: ${truncate(body, ENTRY_LIMIT)}`
  }
  if (e.type === 'tool/result') {
    return `[${e.seq}] tool ${e.payload.name}: ${truncate(e.payload.output, ENTRY_LIMIT)}`
  }
  if (e.type === 'collaboration/message' && e.payload.messages.length) {
    const text = e.payload.messages.map(message => message.role === 'assistant' ? message.content ?? ''
      : message.role === 'tool' ? message.content : message.role === 'user' && typeof message.content === 'string' ? message.content : '').join('\n')
    return `[${e.seq}] expert ${e.payload.agentName} (member evidence, not user instruction): ${truncate(text, ENTRY_LIMIT)}`
  }
  return undefined
}

/**
 * True while a step is still running: some assistant tool_calls record in the
 * window after the last marker has not yet received all of its tool/result
 * records. Appending a compaction marker in that window would land between the
 * assistant call and its result, splitting the pair across the marker.
 */
function hasInFlightToolCalls(events: readonly SessionEventRecord[]): boolean {
  const pending = new Set<string>()
  for (const e of events) {
    if (e.type === 'assistant/message') {
      for (const call of e.payload.tool_calls ?? []) pending.add(call.id)
    } else if (e.type === 'tool/result') {
      pending.delete(e.payload.id)
    }
  }
  return pending.size > 0
}

class CompactionServiceImpl implements CompactionService {
  autoThreshold: number
  autoTokensThreshold: number
  contextWindowTokens: number
  compactModel: string | undefined
  private readonly maxSummaryChars: number
  /** One compaction per session at a time (manual and auto share the promise). */
  private readonly inFlight = new Map<string, Promise<CompactionResult>>()
  /** Coalesce automatic checks, including their error notification. */
  private readonly autoInFlight = new Map<string, Promise<void>>()
  private readonly controller = new AbortController()

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionService,
    private readonly llm: LLMService,
    config: CompactionConfig | undefined,
  ) {
    ctx.effect(() => () => this.controller.abort())
    this.autoThreshold = config?.auto ?? DEFAULT_AUTO_THRESHOLD
    this.autoTokensThreshold = config?.autoTokens ?? DEFAULT_AUTO_TOKENS
    this.contextWindowTokens = config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS
    if (config?.contextWindowTokens !== undefined || config?.thresholdPercent !== undefined) {
      const budget = validateContextBudget({ contextWindowTokens: this.contextWindowTokens,
        thresholdPercent: config?.thresholdPercent ?? 75, autoThreshold: this.autoThreshold })
      if (config?.thresholdPercent !== undefined) this.setContextBudget(budget)
    }
    this.maxSummaryChars = config?.maxSummaryChars ?? DEFAULT_SUMMARY_CHARS
    this.compactModel = config?.compactModel || undefined
  }

  setCompactModel(model?: string | null): void {
    this.compactModel = model || undefined
  }

  setContextBudget(settings: ContextBudgetSettings): void {
    const budget = validateContextBudget(settings)
    this.contextWindowTokens = budget.contextWindowTokens
    this.autoThreshold = budget.autoThreshold
    this.autoTokensThreshold = budget.thresholdPercent > 0 ? Math.max(1, Math.floor(budget.contextWindowTokens * budget.thresholdPercent / 100)) : 0
  }

  isCompacting(sessionId: string): boolean {
    const same = (id: string): boolean => process.platform === 'win32' ? id.toLowerCase() === sessionId.toLowerCase() : id === sessionId
    return [...this.inFlight.keys(), ...this.autoInFlight.keys()].some(same)
  }

  compact(sessionId: string, opts: { focus?: string; signal?: AbortSignal } = {}): Promise<CompactionResult> {
    const existing = this.inFlight.get(sessionId)
    if (existing) return existing
    const attempt = this.compactOnce(sessionId, opts).finally(() => {
      this.inFlight.delete(sessionId)
      this.ctx.emit('compaction/status', { sessionId, active: this.isCompacting(sessionId) })
    })
    this.inFlight.set(sessionId, attempt)
    this.ctx.emit('compaction/status', { sessionId, active: true })
    return attempt
  }

  private async compactOnce(sessionId: string, opts: { focus?: string; signal?: AbortSignal }): Promise<CompactionResult> {
    // Unknown sessions throw (ENOENT) — propagated to the caller.
    const session = await this.sessions.open(sessionId)
    const markerIndex = lastMarkerIndex(session.events)
    const snapshotLength = session.events.length
    const pending = session.events.slice(markerIndex + 1).filter(contextEvent)
    const marker = session.events[markerIndex]
    const previousSummary = marker?.type === 'session/note' && marker.payload.note === 'compaction' ? String(marker.payload.summary ?? '') : ''

    // An unchanged projection needs no additional marker or model request.
    if (!pending.length) return { summary: previousSummary, compactedEvents: 0 }
    // Do not even spend a summary request on an incomplete tool-call/result pair.
    if (hasInFlightToolCalls(pending)) return this.defer(sessionId)

    // The newest marker supersedes the old one in deriveMessages(), so its
    // summary must carry forward too. Keep it separate from the elidable lines.
    const prefix = previousSummary
      ? `[previous summary]\n${truncate(previousSummary, DEFAULT_SUMMARY_CHARS)}\n`
      : ''
    const lines: string[] = []
    for (const e of pending) {
      const line = transcriptLine(e)
      if (line) lines.push(line)
    }
    if (!lines.length) return { summary: previousSummary, compactedEvents: 0 }
    const elision = '[…older elided]\n'
    let length = Math.max(0, lines.length - 1) + lines.reduce((sum, line) => sum + line.length, 0)
    let start = 0
    while (start < lines.length - 1 && prefix.length + elision.length + length > TRANSCRIPT_LIMIT) {
      length -= lines[start++]!.length + 1
    }
    const transcript = prefix + (start ? elision : '') + lines.slice(start).join('\n')
    const signal = opts.signal ? AbortSignal.any([opts.signal, this.controller.signal]) : this.controller.signal
    if (signal.aborted) return this.defer(sessionId)
    const summary = await this.summarize(transcript, opts.focus, signal)

    // Any append makes this snapshot stale, even if a new tool step completed
    // before the summary did. Appending now would silently discard events the
    // summary never saw. Check and append synchronously (Session.append pushes
    // its record before yielding) so no call/result can slip across the marker.
    if (signal.aborted || this.ctx.isDisposed() || session.events.length !== snapshotLength) return this.defer(sessionId, summary)

    await session.append({ type: 'session/note', payload: { note: 'compaction', summary } })
    this.ctx.emit('compaction/done', { sessionId, summary })
    return { summary, compactedEvents: pending.length }
  }

  private defer(sessionId: string, summary = ''): CompactionResult {
    this.ctx.emit('compaction/deferred', { sessionId })
    return { summary, compactedEvents: 0, deferred: true }
  }

  /** Auto path: independent triggers, with failures reported once as kernel/error. */
  maybeAutoCompact(sessionId: string): Promise<void> {
    const existing = this.autoInFlight.get(sessionId)
    if (existing) return existing
    if (!(this.autoThreshold > 0 || this.autoTokensThreshold > 0)) return Promise.resolve()
    const attempt = this.autoCompactOnce(sessionId)
      .catch((error: unknown) => {
        this.ctx.emit('kernel/error', { event: 'compaction', error })
      })
      .finally(() => {
        this.autoInFlight.delete(sessionId)
        this.ctx.emit('compaction/status', { sessionId, active: this.isCompacting(sessionId) })
      })
    this.autoInFlight.set(sessionId, attempt)
    this.ctx.emit('compaction/status', { sessionId, active: true })
    return attempt
  }

  private async autoCompactOnce(sessionId: string): Promise<void> {
    const active = this.inFlight.get(sessionId)
    if (active) {
      await active
      return
    }
    const session = await this.sessions.open(sessionId)
    const pendingCount = session.events.slice(lastMarkerIndex(session.events) + 1).filter(contextEvent).length
    if (!pendingCount) return
    const eventLimitReached = this.autoThreshold > 0 && pendingCount >= this.autoThreshold
    // Estimate the projected context, never the already-compacted raw log.
    const tokenLimitReached = this.autoTokensThreshold > 0 &&
      estimateRequestContextTokens(session.deriveMessages(), this.ctx.peek<ToolsService>('tools')?.schemas() ?? []) >= this.autoTokensThreshold
    if (eventLimitReached || tokenLimitReached) await this.compact(sessionId)
  }

  private async summarize(transcript: string, focus?: string, signal?: AbortSignal): Promise<string> {
    const system = focus
      ? `${SUMMARY_INSTRUCTION}\nExtra focus requested by the user: ${focus}`
      : SUMMARY_INSTRUCTION
    // A dedicated compaction model wins; otherwise the summary follows the
    // model the user currently selected (/model or the GUI picker). The
    // request only names a model when one is actually resolved, so a freshly
    // mounted adapter without a selection still uses its documented default.
    const requested = this.compactModel || this.llm.selectedModel() || undefined
    const adapter = this.llm.pick(requested)
    let text = ''
    for await (const chunk of adapter.stream({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript },
      ],
      temperature: 0,
      signal,
      maxTokens: 1024,
      ...(requested ? { model: requested } : {}),
    })) {
      if (chunk.type === 'text') text += chunk.delta
      else if (chunk.type === 'error') throw new Error(`compaction LLM error: ${chunk.error}`)
    }
    const summary = text.trim().slice(0, this.maxSummaryChars)
    if (!summary) throw new Error('compaction produced an empty summary')
    return summary
  }
}

export const compactionPlugin: Plugin = {
  name: 'core-compaction',
  description: 'Context compaction service (ctx.compaction) — summarize old turns behind a session/note marker',
  inject: ['sessions', 'llm'] as const,
  config: {
    type: 'object',
    properties: {
      auto: { type: 'number', description: 'auto-compact at this many events after the last marker (0 disables this trigger, default 120)' },
      autoTokens: { type: 'number', description: 'auto-compact at this estimated context token count (0 disables this trigger, default 48000)' },
      contextWindowTokens: { type: 'number', description: 'local context planning budget, not the provider limit (default 64000)' },
      thresholdPercent: { type: 'number', description: 'percentage of the local budget that triggers compaction; overrides autoTokens (0 disables token trigger)' },
      maxSummaryChars: { type: 'number', description: 'hard cap on the summary length' },
      compactModel: { type: 'string', description: 'model used for summary requests; empty follows the current selection (a registered model or adapter id)' },
    },
  },
  apply(ctx, config, sessionsLike: unknown, llmLike: unknown) {
    ctx.provide('compaction')
    const service = new CompactionServiceImpl(
      ctx,
      sessionsLike as SessionService,
      llmLike as LLMService,
      config as CompactionConfig | undefined,
    )
    ctx.set('compaction', service)

    // Auto-compaction fires after main turns. The ctx.on registration is
    // tracked on this plugin scope, so it dies with the scope — no manual
    // unsubscribe needed.
    ctx.on('ui/turn/end', (payload?: { sessionId?: string; main?: boolean }) => {
      if (!payload || payload.main === false) return
      const sessionId = payload.sessionId
      if (!sessionId) return
      service.maybeAutoCompact(sessionId)
    })
  },
}
