/**
 * compactionPlugin — manual and auto context compaction against a scripted
 * MockAdapter, mounted on top of the standard tmpHarness bundle. The plugin
 * leans on Session.deriveMessages()'s existing compaction projection, so the
 * tests verify the whole chain from the plugin side.
 */
import { describe, expect, it, vi } from 'vitest'
import { tmpHarness, text } from './helpers.js'
import { type CompactionService } from '../src/plugins/compaction.js'
import type { ChatMessage, LLMRequest, ModelAdapter, SessionEventPayload, SessionEventRecord } from '../src/core/types.js'

function isCompactionNote(e: SessionEventRecord): boolean {
  return e.type === 'session/note' && (e.payload as { note?: string }).note === 'compaction'
}

function contentOf(m: ChatMessage): string {
  return typeof m.content === 'string' ? m.content : ''
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** A real async stream whose summary can be held while other work appends. */
function pausedSummary() {
  const started = barrier()
  const finish = barrier()
  const requests: LLMRequest[] = []
  const adapter: ModelAdapter = {
    id: 'paused-summary',
    async *stream(request) {
      requests.push(request)
      started.release()
      await finish.promise
      yield* text('SUMMARY: completed work')
    },
  }
  return { adapter, requests, started: started.promise, release: finish.release }
}

function assistantToolCall(id: string): SessionEventPayload {
  const toolCalls = [{ id, type: 'function' as const, function: { name: 'bash', arguments: '{}' } }]
  return {
    type: 'assistant/message',
    payload: {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls,
      stream: { text: '', toolCalls, durationMs: 1 },
    },
  }
}

describe('compactionPlugin', () => {
  it('manual compact summarizes the pending records and appends a compaction marker', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('hello there'), text('SUMMARY: user greeted, agent replied')],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('hi there')
    const sessionId = main.sessionId

    const result = await compaction.compact(sessionId)

    expect(result.summary).toContain('SUMMARY')
    // agent/meta + system/message + user/message + assistant/message
    expect(result.compactedEvents).toBe(4)

    const session = await ctx.sessions.open(sessionId)
    const last = session.events[session.events.length - 1]!
    expect(isCompactionNote(last)).toBe(true)
    expect((last.payload as { summary?: string }).summary).toContain('SUMMARY')
  })

  it('deriveMessages projects pre-marker records into the summary plus new messages', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('hello there'), text('SUMMARY: user greeted, agent replied')],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('hi there')
    const sessionId = main.sessionId
    const session = await ctx.sessions.open(sessionId)

    await compaction.compact(sessionId)
    await session.append({ type: 'user/message', payload: { content: 'next question' } })

    const messages = session.deriveMessages()
    // system prompt + [context compacted] summary + the new user message
    expect(messages).toHaveLength(3)
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]!.role).toBe('user')
    expect(contentOf(messages[1]!)).toContain('[context compacted')
    expect(contentOf(messages[1]!)).toContain('SUMMARY')
    expect(messages[2]).toMatchObject({ role: 'user', content: 'next question' })
    // the original turn is carried by the summary, not replayed
    expect(messages.some((m) => contentOf(m).includes('hi there'))).toBe(false)
  })

  it('a second compact supersedes the first marker in the projection', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        text('first reply'),
        text('SUMMARY v1: greetings only'),
        text('second reply'),
        text('SUMMARY v2: decided on compaction'),
      ],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('turn one')
    const sessionId = main.sessionId
    await compaction.compact(sessionId)

    await harness.run('turn two')
    const result = await compaction.compact(sessionId)
    expect(result.summary).toContain('SUMMARY v2')

    const session = await ctx.sessions.open(sessionId)
    const markers = session.events.filter(isCompactionNote)
    expect(markers).toHaveLength(2)
    expect(markers[1]!.seq).toBeGreaterThan(markers[0]!.seq)

    // Only the newest marker drives the projection.
    const messages = session.deriveMessages()
    const summaryMessage = messages.find((m) => contentOf(m).includes('[context compacted'))
    expect(summaryMessage).toBeDefined()
    expect(contentOf(summaryMessage!)).toContain('SUMMARY v2')
    expect(contentOf(summaryMessage!)).not.toContain('SUMMARY v1')
    expect(messages.some((m) => contentOf(m).includes('turn one'))).toBe(false)
    expect(messages.some((m) => contentOf(m).includes('turn two'))).toBe(false)
  })

  it('carries the prior summary into the next compaction request', async () => {
    const requests: LLMRequest[] = []
    const { harness, ctx } = await tmpHarness({
      steps: [
        text('first reply'),
        (request) => { requests.push(request); return text('SUMMARY: retain the original user goal') },
        text('second reply'),
        (request) => { requests.push(request); return text('SUMMARY: original goal plus new work') },
      ],
    })
    const compaction = ctx.get<CompactionService>('compaction')
    await harness.run('original goal')
    await compaction.compact(harness.main().sessionId)
    await harness.run('new work')
    await compaction.compact(harness.main().sessionId)

    expect(contentOf(requests[1]!.messages[1]!)).toContain('SUMMARY: retain the original user goal')
    expect(contentOf(requests[1]!.messages[1]!)).toContain('new work')
  })

  it('auto-compacts after a main turn once events reach the threshold', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('a'), text('b')],
      config: { plugins: { 'core-compaction': { config: { auto: 6 } } } },
    })
    const done: Array<{ sessionId: string; summary: string }> = []
    ctx.on('compaction/done', (payload: { sessionId: string; summary: string }) => done.push(payload))

    await harness.run('one')
    await harness.run('two') // events.length reaches 6 here

    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 10_000, interval: 50 })
    expect(done[0]!.summary.length).toBeGreaterThan(0)
    expect(done[0]!.sessionId).toBe(harness.main().sessionId)

    const session = await ctx.sessions.open(done[0]!.sessionId)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)
  })

  it('auto-compacts on the token estimate even when the event count is low', async () => {
    // auto set impossibly high so only autoTokens can trip it.
    const { harness, ctx } = await tmpHarness({
      steps: [text('a'), text('SUMMARY: token-triggered compaction')],
      config: { plugins: { 'core-compaction': { config: { auto: 10_000, autoTokens: 1 } } } },
    })
    const done: Array<{ sessionId: string; summary: string }> = []
    ctx.on('compaction/done', (payload: { sessionId: string; summary: string }) => done.push(payload))

    await harness.run('one')

    await vi.waitFor(() => expect(done).toHaveLength(1), { timeout: 10_000, interval: 50 })
    expect(done[0]!.summary).toContain('token-triggered')
  })

  it('disables both automatic triggers without disabling manual compaction', async () => {
    const { ctx, adapter } = await tmpHarness({
      steps: [text('SUMMARY: manual only')],
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } },
    })
    const stream = vi.spyOn(adapter, 'stream')
    const compaction = ctx.get<CompactionService>('compaction')
    const session = await ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: '界'.repeat(50_000) } })
    await Promise.all(Array.from({ length: 125 }, () =>
      session.append({ type: 'assistant/attempt', payload: { error: 'retry' } }),
    ))

    ctx.emit('ui/turn/end', { sessionId: session.id, main: true })
    await compaction.maybeAutoCompact(session.id)
    expect(stream).not.toHaveBeenCalled()
    expect(session.events.filter(isCompactionNote)).toHaveLength(0)
    expect(compaction.autoThreshold).toBe(0)
    expect(compaction.autoTokensThreshold).toBe(0)

    await compaction.compact(session.id)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)
  })

  it('keeps autoTokens active when the event threshold is explicitly disabled', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('reply'), text('SUMMARY: token-only trigger')],
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 1 } } } },
    })
    const compaction = ctx.get<CompactionService>('compaction')
    const done = vi.fn()
    ctx.on('compaction/done', done)

    await harness.run('one')
    await compaction.maybeAutoCompact(harness.main().sessionId)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1), { timeout: 1000, interval: 10 })
    expect(done.mock.calls[0]![0].summary).toBe('SUMMARY: token-only trigger')
    expect(compaction.autoThreshold).toBe(0)
    expect(compaction.autoTokensThreshold).toBe(1)
  })

  it('counts only events after the marker instead of compacting every subsequent turn', async () => {
    const { harness, ctx, adapter } = await tmpHarness({
      steps: [text('reply one'), text('SUMMARY one'), text('reply two'), text('reply three'), text('SUMMARY two')],
      config: { plugins: { 'core-compaction': { config: { auto: 4, autoTokens: 0 } } } },
    })
    const stream = vi.spyOn(adapter, 'stream')
    const compaction = ctx.get<CompactionService>('compaction')
    const done = vi.fn()
    ctx.on('compaction/done', done)

    await harness.run('one')
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    const session = await ctx.sessions.open(harness.main().sessionId)
    await compaction.maybeAutoCompact(session.id)
    expect(stream).toHaveBeenCalledTimes(2)

    expect((await harness.run('two')).output).toBe('reply two')
    await compaction.maybeAutoCompact(session.id)
    expect(stream).toHaveBeenCalledTimes(3)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)

    expect((await harness.run('three')).output).toBe('reply three')
    await compaction.maybeAutoCompact(session.id)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(2))
    expect(stream).toHaveBeenCalledTimes(5)
    expect(session.events.filter(isCompactionNote)).toHaveLength(2)
  })

  it('does not repeatedly compact an unchanged summary that still exceeds autoTokens', async () => {
    const { ctx, adapter } = await tmpHarness({
      steps: [text('SUMMARY: still larger than one token')],
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 1 } } } },
    })
    const compaction = ctx.get<CompactionService>('compaction')
    const stream = vi.spyOn(adapter, 'stream')
    const session = await ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'question' } })

    await compaction.maybeAutoCompact(session.id)
    await compaction.maybeAutoCompact(session.id)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)
  })

  it.each(['manual', 'auto'] as const)('shares one attempt across concurrent manual/auto calls (%s starts)', async (firstKind) => {
    const paused = pausedSummary()
    const { ctx } = await tmpHarness({
      adapter: paused.adapter,
      config: { plugins: { 'core-compaction': { config: { auto: 1, autoTokens: 0 } } } },
    })
    const compaction = ctx.get<CompactionService>('compaction')
    const session = await ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'question' } })

    const first = firstKind === 'manual' ? compaction.compact(session.id) : compaction.maybeAutoCompact(session.id)
    await paused.started
    const manual = compaction.compact(session.id)
    const anotherManual = compaction.compact(session.id)
    expect(compaction.isCompacting(session.id)).toBe(true)
    let autoFinished = false
    const auto = compaction.maybeAutoCompact(session.id).then(() => { autoFinished = true })
    try {
      await Promise.resolve()
      expect(autoFinished).toBe(false)
    } finally {
      paused.release()
      await Promise.all([first, manual, anotherManual, auto])
    }

    expect(paused.requests).toHaveLength(1)
    expect(compaction.isCompacting(session.id)).toBe(false)
    expect(await manual).toEqual(await anotherManual)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)
  })

  it.each(['user message', 'pending tool', 'completed tool'] as const)(
    'defers a stale summary when a new %s arrives during its stream',
    async (change) => {
      const paused = pausedSummary()
      const { ctx } = await tmpHarness({
        adapter: paused.adapter,
        config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } },
      })
      const compaction = ctx.get<CompactionService>('compaction')
      const session = await ctx.sessions.create()
      await session.append({ type: 'user/message', payload: { content: 'original question' } })

      const attempt = compaction.compact(session.id)
      await paused.started
      try {
        await session.append({ type: 'user/message', payload: { content: 'new question' } })
        if (change !== 'user message') await session.append(assistantToolCall('new-call'))
        if (change === 'completed tool') {
          await session.append({ type: 'tool/result', payload: { id: 'new-call', name: 'bash', output: 'new result', durationMs: 1 } })
        }
      } finally {
        paused.release()
      }

      expect(await attempt).toMatchObject({ deferred: true, compactedEvents: 0 })
      expect(session.events.filter(isCompactionNote)).toHaveLength(0)
      expect(session.deriveMessages().some((m) => contentOf(m) === 'new question')).toBe(true)
      if (change === 'pending tool') {
        await session.append({ type: 'tool/result', payload: { id: 'new-call', name: 'bash', output: 'new result', durationMs: 1 } })
      }
      await compaction.compact(session.id)
      expect(contentOf(paused.requests[1]!.messages[1]!)).toContain('new question')
      expect(session.events.filter(isCompactionNote)).toHaveLength(1)
    },
  )

  it('does not let an older result mask a newly pending tool call with the same id', async () => {
    const { ctx, adapter } = await tmpHarness()
    const stream = vi.spyOn(adapter, 'stream')
    const compaction = ctx.get<CompactionService>('compaction')
    const session = await ctx.sessions.create()
    await session.append(assistantToolCall('reused'))
    await session.append({ type: 'tool/result', payload: { id: 'reused', name: 'bash', output: 'old result', durationMs: 1 } })
    await session.append(assistantToolCall('reused'))

    expect(await compaction.compact(session.id)).toMatchObject({ deferred: true, compactedEvents: 0 })
    expect(stream).not.toHaveBeenCalled()
    expect(session.events.filter(isCompactionNote)).toHaveLength(0)
  })

  it('defers instead of cutting an in-flight step in half', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('reply'), text('SUMMARY: the in-flight step')],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('start things')
    const sessionId = main.sessionId
    const session = await ctx.sessions.open(sessionId)

    // A step is now in flight: the assistant requested a tool call whose
    // result has not arrived yet. Compacting here would land the marker
    // between the assistant tool_calls and its tool/result.
    await session.append({
      type: 'assistant/message',
      payload: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c-live', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        stream: {
          text: '',
          toolCalls: [{ id: 'c-live', type: 'function', function: { name: 'bash', arguments: '{}' } }],
          durationMs: 1,
        },
      },
    })

    const deferred = await compaction.compact(sessionId)
    expect(deferred.deferred).toBe(true)
    expect(deferred.compactedEvents).toBe(0)
    expect(session.events.filter(isCompactionNote)).toHaveLength(0)

    // Once the step completes, the same call goes through.
    await session.append({ type: 'tool/result', payload: { id: 'c-live', name: 'bash', output: 'done', durationMs: 2 } })
    const retry = await compaction.compact(sessionId)
    expect(retry.deferred).toBeUndefined()
    expect(retry.compactedEvents).toBeGreaterThan(0)
    expect(session.events.filter(isCompactionNote)).toHaveLength(1)
  })

  it('an error chunk from the LLM rejects compact and leaves no marker', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [text('reply'), [{ type: 'error', error: 'boom' }]],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('do things')
    const sessionId = main.sessionId

    const status: boolean[] = []
    ctx.on('compaction/status', (payload: { active: boolean }) => status.push(payload.active))
    await expect(compaction.compact(sessionId)).rejects.toThrow(/boom/)
    expect(compaction.isCompacting(sessionId)).toBe(false)
    expect(status).toEqual([true, false])

    const session = await ctx.sessions.open(sessionId)
    expect(session.events.filter(isCompactionNote)).toHaveLength(0)
  })

  it('a throwing adapter step rejects compact and leaves no marker', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        text('reply'),
        () => {
          throw new Error('kaboom')
        },
      ],
    })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('do things')
    const sessionId = main.sessionId

    await expect(compaction.compact(sessionId)).rejects.toThrow(/kaboom/)

    const session = await ctx.sessions.open(sessionId)
    expect(session.events.filter(isCompactionNote)).toHaveLength(0)
  })
})

/** Adapter that records every request and exposes several model names. */
function recordingAdapter(models: string[], defaultModel: string) {
  const requests: LLMRequest[] = []
  const adapter: ModelAdapter = {
    id: 'recording',
    defaultModel,
    models,
    async *stream(request) {
      requests.push(request)
      yield* text('SUMMARY: recorded')
    },
  }
  return { adapter, requests }
}

describe('compactionPlugin — summary model choice', () => {
  it('routes the summary through the configured compactModel', async () => {
    const { adapter, requests } = recordingAdapter(['mock-chat', 'mock-reasoner'], 'mock-chat')
    const { harness, ctx } = await tmpHarness({
      adapter,
      config: { plugins: { 'core-compaction': { config: { compactModel: 'mock-reasoner' } } } },
    })
    const compaction = ctx.get<CompactionService>('compaction')
    expect(compaction.compactModel).toBe('mock-reasoner')

    const main = harness.main()
    await harness.run('work work')
    requests.length = 0
    const result = await compaction.compact(main.sessionId!)
    expect(result.summary).toContain('SUMMARY')
    expect(requests.some((r) => r.model === 'mock-reasoner')).toBe(true)
  })

  it('follows the current selection when no compactModel is set', async () => {
    const { adapter, requests } = recordingAdapter(['mock-chat', 'mock-reasoner'], 'mock-chat')
    const { harness, ctx } = await tmpHarness({ adapter })
    const compaction = ctx.get<CompactionService>('compaction')
    expect(compaction.compactModel).toBeUndefined()

    const main = harness.main()
    await harness.run('work work')
    requests.length = 0
    // No explicit selection: the request carries no model field, so the
    // adapter's documented default (mock-chat) is what the provider uses.
    await compaction.compact(main.sessionId!)
    expect(requests.at(-1)!.model).toBeUndefined()

    // A new turn gives the next compact something to summarize.
    await harness.run('more work')
    requests.length = 0
    ctx.llm.select('mock-reasoner')
    await compaction.compact(main.sessionId!)
    expect(requests.at(-1)!.model).toBe('mock-reasoner')
  })

  it('setCompactModel overrides the config at runtime and null restores follow-selection', async () => {
    const { adapter, requests } = recordingAdapter(['mock-chat', 'mock-reasoner'], 'mock-chat')
    const { harness, ctx } = await tmpHarness({ adapter })
    const compaction = ctx.get<CompactionService>('compaction')

    const main = harness.main()
    await harness.run('work work')

    compaction.setCompactModel('mock-reasoner')
    expect(compaction.compactModel).toBe('mock-reasoner')
    requests.length = 0
    await compaction.compact(main.sessionId!)
    expect(requests.at(-1)!.model).toBe('mock-reasoner')

    await harness.run('more work')
    compaction.setCompactModel(null)
    expect(compaction.compactModel).toBeUndefined()
    requests.length = 0
    // Back to follow-selection — and with no selection the model field is
    // absent, leaving the adapter default in charge.
    await compaction.compact(main.sessionId!)
    expect(requests.at(-1)!.model).toBeUndefined()
  })
})

describe('compactionPlugin — context budget and clear boundaries', () => {
  it('updates both independent triggers atomically and includes tool definitions in auto token accounting', async () => {
    const { ctx, adapter } = await tmpHarness({ steps: [text('SUMMARY: tool schema trigger')], config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    const compaction = ctx.get<CompactionService>('compaction'), stream = vi.spyOn(adapter, 'stream')
    compaction.setContextBudget({ contextWindowTokens: 64000, thresholdPercent: 1, autoThreshold: 0 })
    expect(compaction.autoTokensThreshold).toBe(640)
    expect(compaction.contextWindowTokens).toBe(64000)
    const session = await ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'tiny message' } })
    await compaction.maybeAutoCompact(session.id)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(session.events.some(isCompactionNote)).toBe(true)
    compaction.setContextBudget({ contextWindowTokens: 128000, thresholdPercent: 0, autoThreshold: 0 })
    expect(compaction.autoTokensThreshold).toBe(0)
    expect(() => compaction.setContextBudget({ contextWindowTokens: 1, thresholdPercent: 75, autoThreshold: 120 })).toThrow()
    expect(compaction.contextWindowTokens).toBe(128000)
    expect(compaction.autoThreshold).toBe(0)
  })

  it('never resurrects an old summary after a clear and makes no request for an unchanged cleared context', async () => {
    const { ctx, adapter } = await tmpHarness({ steps: [text('SUMMARY: new context only')], config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    const compaction = ctx.get<CompactionService>('compaction'), stream = vi.spyOn(adapter, 'stream')
    const session = await ctx.sessions.create()
    await session.append({ type: 'session/note', payload: { note: 'compaction', summary: 'MUST_NOT_RESURRECT' } })
    await session.clearContext()
    await compaction.compact(session.id)
    expect(stream).not.toHaveBeenCalled()
    await session.append({ type: 'user/message', payload: { content: 'FRESH_CONTEXT' } })
    await compaction.compact(session.id)
    const request = stream.mock.calls[0]![0]
    expect(JSON.stringify(request.messages)).toContain('FRESH_CONTEXT')
    expect(JSON.stringify(request.messages)).not.toContain('MUST_NOT_RESURRECT')
    expect(session.events.filter(isCompactionNote)).toHaveLength(2)
  })

  it('honors cancellation and disposal instead of appending a late summary', async () => {
    const paused = pausedSummary(), { ctx } = await tmpHarness({ adapter: paused.adapter })
    const compaction = ctx.get<CompactionService>('compaction'), session = await ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'cancel this summary' } })
    const controller = new AbortController()
    const attempt = compaction.compact(session.id, { signal: controller.signal })
    await paused.started
    expect(paused.requests[0]?.signal).toBeDefined()
    controller.abort(); ctx.dispose(); paused.release()
    expect(await attempt).toMatchObject({ deferred: true, compactedEvents: 0 })
    expect(session.events.some(isCompactionNote)).toBe(false)
    expect(compaction.isCompacting(session.id)).toBe(false)
  })

  it('accepts config percentages without changing legacy absolute thresholds unless explicitly requested', async () => {
    const { ctx } = await tmpHarness({ config: { plugins: { 'core-compaction': { config: { contextWindowTokens: 128000, thresholdPercent: 70, autoTokens: 1, auto: 0 } } } } })
    const compaction = ctx.get<CompactionService>('compaction')
    expect(compaction.autoTokensThreshold).toBe(89600)
    expect(compaction.autoThreshold).toBe(0)
    expect(compaction.contextWindowTokens).toBe(128000)
  })
})
