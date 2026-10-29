/** Token/time accounting on the real loop: synthetic model responses, temporary logs, no billed API calls. */
import { promises as fs } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { StreamChunk, StreamSummary, TurnMetrics } from '../src/core/types.js'
import { recordedTurnSummaries, teamMetrics, TurnMeter } from '../src/util/turn-metrics.js'
import { estimateRequestContextTokens } from '../src/util/context.js'
import { ConversationHistoryService } from '../src/core/conversation-history.js'
import { text, toolCall, tmpHarness } from './helpers.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

describe('per-turn token and wall-clock metrics', () => {
  it('uses final cumulative provider usage once per attempt and includes tool waiting across multiple steps', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [
      [...toolCall('timed_fixture', '{}'), { type: 'usage', inputTokens: 10, outputTokens: 2 }, { type: 'usage', inputTokens: 15, outputTokens: 3, cachedTokens: 5 }],
      [...text('done'), { type: 'usage', inputTokens: 20, outputTokens: 4, reasoningTokens: 2 }],
    ] })
    ctx.tools.register({ name: 'timed_fixture', kind: 'read', description: 'Synthetic timed result', parameters: { type: 'object' },
      async execute() { await sleep(40); return 'fixture output' } })
    let live: { metrics: TurnMetrics; usage: { inputTokens: number; outputTokens: number } } | undefined
    ctx.on('ui/turn/end', frame => { live = frame })
    const result = await harness.run('timed task')
    expect(result.metrics).toMatchObject({ inputTokens: 35, outputTokens: 7, totalTokens: 42, requests: 2, retries: 0, usageSource: 'reported', status: 'done' })
    expect(result.metrics!.elapsedMs).toBeGreaterThanOrEqual(35)
    expect(live?.metrics).toEqual(result.metrics)
    expect(live?.usage).toMatchObject({ inputTokens: 35, outputTokens: 7 })
    const session = await ctx.sessions.open(harness.main().sessionId)
    expect(recordedTurnSummaries(session.events)).toEqual([{ userSeq: result.userSeq, metrics: result.metrics }])
    expect(session.deriveMessages().some(message => String(message.content).includes('turn-summary'))).toBe(false)
  })

  it('estimates the actual request including schemas, thinking and calls when usage is absent or partial', async () => {
    let estimate = 0
    const { harness } = await tmpHarness({ steps: [request => {
      estimate = estimateRequestContextTokens(request.messages, request.tools ?? [])
      return [{ type: 'text', delta: '你好' }, { type: 'thinking', delta: '核对' }, { type: 'usage', outputTokens: 6 }, { type: 'done', reason: 'stop' }]
    }] })
    const result = await harness.run('用中文')
    expect(result.metrics).toMatchObject({ inputTokens: estimate, outputTokens: 6, totalTokens: estimate + 6, usageSource: 'mixed', requests: 1 })
    const meter = new TurnMeter(), stream: StreamSummary = { text: '你好', thinking: '核对', toolCalls: [], durationMs: 0 }
    meter.attempt(stream, 100)
    expect(meter.finish('done')).toMatchObject({ inputTokens: 100, outputTokens: 4, totalTokens: 104, usageSource: 'estimated' })
  })

  it('counts failed retry attempts, resets cumulative usage, retains their estimates and excludes their text from model history', async () => {
    const chunks: StreamChunk[] = [{ type: 'text', delta: 'FAILED_FRAGMENT' }, { type: 'usage', inputTokens: 9, outputTokens: 2 },
      { type: 'reset', error: 'synthetic retry' }, ...text('FINAL_RESULT'), { type: 'usage', inputTokens: 12, outputTokens: 3 }]
    const { harness, ctx } = await tmpHarness({ steps: [chunks] })
    const result = await harness.run('retry task')
    expect(result.metrics).toMatchObject({ totalTokens: 26, inputTokens: 21, outputTokens: 5, requests: 2, retries: 1, usageSource: 'reported' })
    const session = await ctx.sessions.open(harness.main().sessionId)
    expect(session.events.find(event => event.type === 'assistant/attempt')).toMatchObject({ payload: { retry: true, stream: { estimatedUsage: expect.any(Object) } } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain('FAILED_FRAGMENT')
  })

  it.each(['error', 'cancelled'] as const)('persists partial unreported output and metrics on %s, never as a committed answer', async status => {
    const { harness, ctx } = await tmpHarness({ steps: [[{ type: 'text', delta: 'PARTIAL_ONLY' },
      status === 'error' ? { type: 'error', error: 'synthetic fatal' } : { type: 'done', reason: 'cancelled' }]] })
    const result = await harness.run('partial task')
    expect(result.metrics).toMatchObject({ status, usageSource: 'estimated', requests: 1 })
    expect(result.metrics!.outputTokens).toBeGreaterThan(0)
    const session = await ctx.sessions.open(harness.main().sessionId)
    expect(session.events.find(event => event.type === 'assistant/attempt')).toMatchObject({ payload: { stream: { text: 'PARTIAL_ONLY', estimatedUsage: expect.any(Object) } } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain('PARTIAL_ONLY')
  })

  it('measures concurrent team wall time rather than summing durations and retains failures and cancellations', () => {
    const row = (start: number, end: number, status: TurnMetrics['status'], usageSource: TurnMetrics['usageSource']): TurnMetrics => ({
      startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(), elapsedMs: end - start,
      inputTokens: 10, outputTokens: 5, totalTokens: 15, usageSource, requests: 1, retries: 0, status, scope: 'agent',
    })
    expect(teamMetrics([row(1000, 1300, 'done', 'reported'), row(1050, 1500, 'error', 'estimated'), row(1100, 1400, 'cancelled', 'reported')]))
      .toMatchObject({ elapsedMs: 500, totalTokens: 45, requests: 3, usageSource: 'mixed', status: 'error', members: 3, failedMembers: 1, cancelledMembers: 1 })
  })

  it('reconstructs old completed turns read-only, labels the clock approximate and does not declare unfinished calls complete', async () => {
    const { ctx } = await tmpHarness()
    const session = await ctx.sessions.create()
    const user = await session.append({ type: 'user/message', payload: { content: 'old request' } })
    await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: 'old answer', stream: { text: 'old answer', toolCalls: [], durationMs: 5 } } })
    await session.append({ type: 'user/message', payload: { content: 'unfinished request' } })
    await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: null,
      tool_calls: [{ id: 'still-running', type: 'function', function: { name: 'read', arguments: '{}' } }], stream: { text: '', toolCalls: [], durationMs: 0 } } })
    const before = await fs.readFile(session.file)
    expect(recordedTurnSummaries(session.events)).toMatchObject([{ userSeq: user.seq, metrics: { status: 'done', legacy: true, usageSource: 'estimated' } }])
    expect(await fs.readFile(session.file)).toEqual(before)
  })

  it('remaps persisted summary user sequences when branching and preserves the original log', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [text('first'), text('second')] })
    const first = await harness.run('first task'), second = await harness.run('second task')
    const source = await ctx.sessions.open(harness.main().sessionId), before = await fs.readFile(source.file)
    const history = new ConversationHistoryService(ctx.sessions), preview = await history.preview(source.id, second.userSeq!)
    const branch = (await history.rewind({ ...preview, mode: 'conversation' }, () => {})).session
    const branchUser = branch.events.find(event => event.type === 'user/message')!
    expect(recordedTurnSummaries(branch.events)).toEqual([{ userSeq: branchUser.seq, metrics: first.metrics }])
    expect(await fs.readFile(source.file)).toEqual(before)
  })
})