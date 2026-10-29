/**
 * tests/agent-loop.test.ts — DefaultAgentLoop turn flow through a real
 * createHarness composition with a scripted ModelAdapter.
 */

import { promises as fs } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmpHarness, text, toolCall, type MockStep } from './helpers.js'
import { toolPolicyFilter } from '../src/core/index.js'
import type { AssistantMessage, HarnessContext, LLMRequest, ModelAdapter, SessionEventRecord, StreamChunk, ToolMessage, TurnResult } from '../src/core/index.js'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Payload shapes of the session events these tests inspect. */
type UserMessagePayload = { content: string; from?: string }
type AssistantPayload = AssistantMessage & { stream: unknown }
type ToolCallPayload = { id: string; name: string; arguments: string }
type ToolResultPayload = { id: string; name: string; output: string; isError?: boolean; durationMs: number }

/** Filter session events by type and project their payloads (by tag). */
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: 'user/message'): UserMessagePayload[]
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: 'assistant/message'): AssistantPayload[]
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: 'assistant/attempt'): Array<{ error: string }>
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: 'tool/call'): ToolCallPayload[]
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: 'tool/result'): ToolResultPayload[]
function payloadsOf(events: ReadonlyArray<SessionEventRecord>, type: string): unknown[] {
  return events.filter((e) => e.type === type).map((e) => e.payload)
}

type TurnEndPayload = Partial<TurnResult> & {
  agentId: string; sessionId: string; main?: boolean
  usage?: { inputTokens?: number; outputTokens?: number }
}

function observeTurnEnd(ctx: HarnessContext) {
  const ends: TurnEndPayload[] = []
  const uiEnds: TurnEndPayload[] = []
  const statuses: Array<{ id: string; status: string; error?: string }> = []
  const stoppingAttempts: Array<Array<{ error: string }>> = []
  ctx.on('turn/end', (payload: TurnEndPayload) => { ends.push(payload) })
  ctx.on('ui/turn/end', (payload: TurnEndPayload) => { uiEnds.push(payload) })
  ctx.on('agent/status', (payload: { id: string; status: string; error?: string }) => { statuses.push(payload) })
  ctx.on('agent/turn-stopping', ({ session }: { session: { events: SessionEventRecord[] } }) => {
    stoppingAttempts.push(payloadsOf(session.events, 'assistant/attempt'))
  })
  return { ends, uiEnds, statuses, stoppingAttempts }
}

describe('agent loop (main agent turns)', () => {
  it('happy path: tool call step then final answer, session log and deriveMessages reconstruct the context', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        toolCall('todo_write', JSON.stringify({ todos: [{ content: 'a', status: 'in_progress', priority: 'high' }] })),
        text('ALL DONE'),
      ],
    })

    const result = await harness.run('plan my work')

    expect(result.error).toBeUndefined()
    expect(result.cancelled).toBeFalsy()
    expect(result.steps).toBe(2)
    expect(result.output).toBe('ALL DONE')

    // The main agent's session log holds the full turn.
    const main = ctx.agents.list().find((a) => a.meta.role === 'main')
    expect(main).toBeDefined()
    const session = await ctx.sessions.open(main!.sessionId)
    const types = session.events.map((e) => e.type)
    expect(types).toContain('system/message')
    expect(types).toContain('user/message')
    expect(types).toContain('assistant/message')
    expect(types).toContain('tool/call')
    expect(types).toContain('tool/result')

    // user message
    const userMessages = payloadsOf(session.events, 'user/message')
    expect(userMessages).toHaveLength(1)
    expect(userMessages[0]!.content).toBe('plan my work')

    // first assistant message carries the todo_write tool call
    const assistantMessages = payloadsOf(session.events, 'assistant/message')
    expect(assistantMessages).toHaveLength(2)
    const withCalls = assistantMessages[0]!
    expect(withCalls.content).toBeNull()
    expect(withCalls.tool_calls).toHaveLength(1)
    expect(withCalls.tool_calls![0]!.function.name).toBe('todo_write')
    expect(withCalls.tool_calls![0]!.function.arguments).toBe(
      JSON.stringify({ todos: [{ content: 'a', status: 'in_progress', priority: 'high' }] }),
    )

    // tool call + result events pair up
    const calls = payloadsOf(session.events, 'tool/call')
    const results = payloadsOf(session.events, 'tool/result')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.name).toBe('todo_write')
    expect(calls[0]!.id).toBe(withCalls.tool_calls![0]!.id)
    expect(results).toHaveLength(1)
    expect(results[0]!.id).toBe(calls[0]!.id)
    expect(results[0]!.output).toContain('todo list updated (1 item(s))')
    expect(results[0]!.output).toContain('◐ a [high]')

    // final assistant message is plain text
    const final = assistantMessages[1]!
    expect(final.content).toBe('ALL DONE')
    expect(final.tool_calls).toBeUndefined()

    // deriveMessages() projects the log into wire messages
    const messages = session.deriveMessages()
    expect(messages).toHaveLength(5)
    expect(messages[0]!.role).toBe('system')
    expect(messages[1]).toMatchObject({ role: 'user', content: 'plan my work' })
    const callMessage = messages[2] as AssistantMessage
    expect(callMessage.role).toBe('assistant')
    expect(callMessage.tool_calls).toHaveLength(1)
    const toolMessage = messages[3] as ToolMessage
    expect(toolMessage.role).toBe('tool')
    expect(toolMessage.tool_call_id).toBe(callMessage.tool_calls![0]!.id)
    expect(toolMessage.content).toContain('todo list updated')
    const last = messages[messages.length - 1] as AssistantMessage
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('ALL DONE')
    expect('tool_calls' in last).toBe(false)
  })

  it('subagent delegation: child runs its own turn and session, main sees the tool result', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        toolCall('subagent', JSON.stringify({ description: 'explore', prompt: 'say hi' })),
        text('CHILD ANSWER'), // consumed by the child while main awaits the tool
        text('MAIN DONE'), // consumed by main after the tool result
      ],
    })

    const result = await harness.run('delegate something')

    expect(result.error).toBeUndefined()
    expect(result.output).toBe('MAIN DONE')
    expect(ctx.agents.list()).toHaveLength(2)

    const main = ctx.agents.list().find((a) => a.meta.role === 'main')!
    const child = ctx.agents.list().find((a) => a.meta.role !== 'main')!
    expect(child.status).toBe('done')
    expect(child.sessionId).toBeTruthy()
    expect(child.sessionId).not.toBe(main.sessionId)

    // the main session records the delegation and the child's answer as the tool result
    const mainSession = await ctx.sessions.open(main.sessionId)
    const mainResults = payloadsOf(mainSession.events, 'tool/result')
    expect(mainResults).toHaveLength(1)
    expect(mainResults[0]!.name).toBe('subagent')
    expect(mainResults[0]!.output).toBe('CHILD ANSWER')

    // the child session is a real, separate log with its own turn
    const childSession = await ctx.sessions.open(child.sessionId)
    const childUser = payloadsOf(childSession.events, 'user/message')
    expect(childUser).toHaveLength(1)
    expect(childUser[0]!.content).toBe('say hi')
    const childMessages = childSession.deriveMessages()
    const childFinal = childMessages[childMessages.length - 1] as AssistantMessage
    expect(childFinal.role).toBe('assistant')
    expect(childFinal.content).toBe('CHILD ANSWER')
    expect('tool_calls' in childFinal).toBe(false)
  })

  it('background subagent: tool returns a handle immediately, the child completes on its own', async () => {
    // Both post-tool requests route by the user prompt they carry, so the
    // script is order-independent: the child sees its prompt, main does not.
    const routeByPrompt: MockStep = (req: LLMRequest) =>
      req.messages.some((m) => m.role === 'user' && String(m.content).includes('BG-WORK-42'))
        ? text('BG CHILD DONE')
        : text('MAIN DONE')
    const { harness, ctx } = await tmpHarness({
      steps: [
        toolCall('subagent', JSON.stringify({ description: 'bg', prompt: 'BG-WORK-42 please', run_in_background: true })),
        routeByPrompt,
        routeByPrompt,
      ],
    })

    const result = await harness.run('kick off a background task')

    expect(result.error).toBeUndefined()
    expect(result.output).toBe('MAIN DONE')

    // the subagent tool returned immediately with the agent id
    const main = ctx.agents.list().find((a) => a.meta.role === 'main')!
    const mainSession = await ctx.sessions.open(main.sessionId)
    const mainResults = payloadsOf(mainSession.events, 'tool/result')
    expect(mainResults).toHaveLength(1)
    expect(mainResults[0]!.output).toMatch(/^started agent-\d+ .*in the background/)

    // the child exists and finishes on its own
    expect(ctx.agents.list()).toHaveLength(2)
    const child = ctx.agents.list().find((a) => a.meta.role !== 'main')!
    const waited = await child.wait()
    expect(child.status).toBe('done')
    expect(waited.output).toBe('BG CHILD DONE')
  })
})

describe('agent loop terminal outcomes', () => {
  it.each([
    { name: 'truncated response', delta: 'PARTIAL ANSWER', maxSteps: 4 },
    { name: 'truncated response at the step limit', delta: '', maxSteps: 1 },
  ])('reports $name consistently without discarding usage or partial output', async ({ delta, maxSteps }) => {
    const usage = { inputTokens: 9, outputTokens: 4 }
    const expectedError = 'stopped: max output length reached'
    const { harness, ctx } = await tmpHarness({
      maxSteps,
      steps: [[
        { type: 'text', delta },
        { type: 'usage', ...usage },
        { type: 'done', reason: 'length' },
      ], text('RECOVERED')],
    })
    const observed = observeTurnEnd(ctx)
    const agent = harness.main()
    const result = await agent.turn('give a complete answer')
    expect(result).toMatchObject({ output: delta, steps: 1, error: expectedError })
    expect(result.cancelled).toBeUndefined()
    expect(agent.status).toBe('error')
    expect(agent.error).toBe(expectedError)
    expect(observed.statuses.at(-1)).toEqual({ id: agent.id, status: 'error', error: expectedError })
    expect(observed.ends).toHaveLength(1)
    expect(observed.ends[0]).toMatchObject({ agentId: agent.id, sessionId: agent.sessionId, output: delta, steps: 1, error: expectedError })
    expect(observed.uiEnds).toHaveLength(1)
    expect(observed.uiEnds[0]).toMatchObject({ agentId: agent.id, sessionId: agent.sessionId, output: delta, steps: 1, error: expectedError, main: true, usage })
    expect(observed.uiEnds[0]?.cancelled).toBeUndefined()

    const session = await ctx.sessions.open(agent.sessionId)
    expect(payloadsOf(session.events, 'assistant/message')).toEqual([expect.objectContaining({ content: delta || null })])
    expect(payloadsOf(session.events, 'assistant/attempt')).toEqual([{ error: expectedError }])
    expect(observed.stoppingAttempts).toEqual([[{ error: expectedError }]])
    const persisted = (await fs.readFile(session.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEventRecord)
    expect(payloadsOf(persisted, 'assistant/attempt')).toEqual([{ error: expectedError }])
    // Attempts are observability records, never messages replayed to the model.
    expect(session.deriveMessages().at(-1)).toEqual({ role: 'assistant', content: delta || null })

    const retry = await agent.turn('continue')
    expect(retry).toMatchObject({ output: 'RECOVERED', steps: 1 })
    expect(retry.error).toBeUndefined()
    expect(agent.status).toBe('done')
    expect(agent.error).toBeUndefined()
    expect(observed.ends).toHaveLength(2)
    expect(observed.uiEnds).toHaveLength(2)
    expect(observed.uiEnds[1]).toMatchObject({ output: 'RECOVERED', steps: 1, main: true })
    expect(observed.uiEnds[1]?.error).toBeUndefined()
    expect(payloadsOf(session.events, 'assistant/attempt')).toEqual([{ error: expectedError }])
  })

  it.each(['', 'Working on it'] as const)('records step exhaustion after tool calls with intermediate text %j', async (delta) => {
    const expectedError = 'reached max steps (1) without a final answer'
    const { harness, ctx } = await tmpHarness({
      maxSteps: 1,
      steps: [[
        { type: 'text', delta },
        ...toolCall('todo_write', JSON.stringify({ todos: [] }), 'step-limit-call'),
      ]],
    })
    const observed = observeTurnEnd(ctx)
    const agent = harness.main()
    const result = await agent.turn('keep working until done')
    expect(result).toMatchObject({ output: delta, steps: 1, error: expectedError })
    expect(result.cancelled).toBeUndefined()
    expect(agent.status).toBe('error')
    expect(agent.error).toBe(expectedError)
    expect(observed.statuses.at(-1)).toEqual({ id: agent.id, status: 'error', error: expectedError })
    expect(observed.ends).toHaveLength(1)
    expect(observed.ends[0]).toMatchObject({ agentId: agent.id, sessionId: agent.sessionId, error: expectedError })
    expect(observed.uiEnds).toHaveLength(1)
    expect(observed.uiEnds[0]).toMatchObject({ agentId: agent.id, sessionId: agent.sessionId, error: expectedError, main: true })
    expect(observed.uiEnds[0]?.cancelled).toBeUndefined()

    const session = await ctx.sessions.open(agent.sessionId)
    expect(payloadsOf(session.events, 'assistant/attempt')).toEqual([{ error: expectedError }])
    expect(observed.stoppingAttempts).toEqual([[{ error: expectedError }]])
    // Reaching the cap still leaves every logged call paired with its result.
    const results = payloadsOf(session.events, 'tool/result')
    expect(results).toEqual([expect.objectContaining({ id: 'step-limit-call', name: 'todo_write' })])
    expect(results[0]?.isError).toBeFalsy()
    const messages = session.deriveMessages()
    expect(messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'step-limit-call' }] })
    expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'step-limit-call' })
    const persisted = (await fs.readFile(session.file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as SessionEventRecord)
    expect(payloadsOf(persisted, 'assistant/attempt')).toEqual([{ error: expectedError }])
  })

  it('does not mark a final answer at the exact step limit as an error', async () => {
    const { harness, ctx } = await tmpHarness({ maxSteps: 1, steps: [text('DONE')] })
    const observed = observeTurnEnd(ctx)
    const agent = harness.main()
    const result = await agent.turn('finish in one step')
    expect(result).toMatchObject({ output: 'DONE', steps: 1 })
    expect(result.error).toBeUndefined()
    expect(result.cancelled).toBeUndefined()
    expect(agent.status).toBe('done')
    expect(observed.ends).toHaveLength(1)
    expect(observed.uiEnds).toHaveLength(1)
    expect(observed.uiEnds[0]).toMatchObject({ output: 'DONE', steps: 1, main: true })
    expect(observed.uiEnds[0]?.error).toBeUndefined()
    expect(payloadsOf((await ctx.sessions.open(agent.sessionId)).events, 'assistant/attempt')).toEqual([])
    expect(observed.stoppingAttempts).toEqual([[]])
  })
})

describe('toolPolicyFilter', () => {
  it("'core' excludes the subagent family but keeps other tools", () => {
    const filter = toolPolicyFilter('core', false)
    expect(filter('subagent')).toBe(false)
    expect(filter('list_subagent_models')).toBe(false)
    expect(filter('read')).toBe(true)
    expect(filter('bash')).toBe(true)
    expect(filter('todo_write')).toBe(true)
  })

  it('array policy is an explicit allow-list', () => {
    const filter = toolPolicyFilter(['read', 'todo_write'], false)
    expect(filter('read')).toBe(true)
    expect(filter('todo_write')).toBe(true)
    expect(filter('bash')).toBe(false)
    expect(filter('subagent')).toBe(false)
    expect(filter('list_subagent_models')).toBe(false)
  })

  it("'full' hides the subagent family unless nested subagents are allowed", () => {
    const noNested = toolPolicyFilter('full', false)
    expect(noNested('subagent')).toBe(false)
    expect(noNested('read')).toBe(true)
    const nested = toolPolicyFilter('full', true)
    expect(nested('subagent')).toBe(true)
    expect(nested('list_subagent_models')).toBe(true)
  })
})

describe('cancellation', () => {
  it.each([false, true])('honors an adapter cancelled marker without an aborted signal (tool call: %s)', async (withToolCall) => {
    let signal: AbortSignal | undefined
    const chunks: StreamChunk[] = [
      { type: 'text', delta: 'UNCOMMITTED PARTIAL' },
      ...(withToolCall ? toolCall('todo_write', JSON.stringify({ todos: [] }), 'cancelled-call').slice(0, -1) : []),
      { type: 'done', reason: 'cancelled' },
    ]
    const { harness, ctx } = await tmpHarness({
      maxSteps: 1,
      steps: [(req) => { signal = req.signal; return chunks }],
    })
    const observed = observeTurnEnd(ctx)
    const agent = harness.main()
    const result = await agent.turn('stop when the provider cancels')
    expect(signal?.aborted).toBe(false)
    expect(result).toMatchObject({ cancelled: true, steps: 1 })
    expect(result.error).toBeUndefined()
    expect(agent.status).toBe('cancelled')
    expect(agent.error).toBeUndefined()
    expect(observed.statuses.at(-1)).toEqual({ id: agent.id, status: 'cancelled' })
    expect(observed.ends).toEqual([expect.objectContaining({ agentId: agent.id, sessionId: agent.sessionId, cancelled: true, metrics: result.metrics })])
    expect(observed.uiEnds).toEqual([expect.objectContaining({ agentId: agent.id, sessionId: agent.sessionId, cancelled: true, main: true, metrics: result.metrics })])
    expect(result.metrics).toMatchObject({ status: 'cancelled', scope: 'agent', requests: 1 })
    const session = await ctx.sessions.open(agent.sessionId)
    expect(payloadsOf(session.events, 'assistant/attempt')).toEqual([expect.objectContaining({ error: 'cancelled' })])
    expect(observed.stoppingAttempts).toEqual([[expect.objectContaining({ error: 'cancelled' })]])
    expect(session.events.find(event => event.type === 'assistant/attempt')).toMatchObject({ payload: { stream: { text: 'UNCOMMITTED PARTIAL', estimatedUsage: expect.any(Object) } } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain('UNCOMMITTED PARTIAL')
    // A cancelled, unfinished stream is not committed or executed, just as
    // when AbortError interrupts that stream before it closes.
    expect(payloadsOf(session.events, 'assistant/message')).toEqual([])
    expect(payloadsOf(session.events, 'tool/call')).toEqual([])
    expect(payloadsOf(session.events, 'tool/result')).toEqual([])
  })

  it('interrupt() during a hung model stream yields cancelled result and agent status', async () => {
    let streamStarted = false
    const blockingAdapter: ModelAdapter = {
      id: 'blocking-adapter',
      async *stream(req: LLMRequest): AsyncIterable<import('../src/core/index.js').StreamChunk> {
        streamStarted = true
        // Never yield: hang until the request signal aborts, then unwind with
        // an AbortError so the loop's cancellation path handles it.
        await new Promise<never>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }
          if (req.signal?.aborted) abort()
          else req.signal?.addEventListener('abort', abort)
        })
        yield { type: 'done', reason: 'stop' } // unreachable
      },
    }

    const { harness, ctx } = await tmpHarness({ adapter: blockingAdapter, steps: [] })
    const observed = observeTurnEnd(ctx)
    const handle = harness.main()

    const pending = handle.turn('please hang forever')
    const deadline = Date.now() + 10_000
    while (!streamStarted && Date.now() < deadline) await sleep(10)
    expect(streamStarted).toBe(true)

    handle.interrupt()
    const result = await pending

    expect(result.cancelled).toBe(true)
    expect(result.error).toBeUndefined()
    expect(handle.status).toBe('cancelled')
    expect(handle.error).toBeUndefined()
    expect(observed.statuses.at(-1)).toEqual({ id: handle.id, status: 'cancelled' })
    expect(observed.ends).toEqual([expect.objectContaining({ agentId: handle.id, sessionId: handle.sessionId, cancelled: true, metrics: result.metrics })])
    expect(observed.uiEnds).toEqual([expect.objectContaining({ agentId: handle.id, sessionId: handle.sessionId, cancelled: true, main: true, metrics: result.metrics })])
    expect(payloadsOf((await ctx.sessions.open(handle.sessionId)).events, 'assistant/attempt')).toEqual([expect.objectContaining({ error: 'cancelled' })])
    expect(observed.stoppingAttempts).toEqual([[expect.objectContaining({ error: 'cancelled' })]])
  })
})

describe('harness.main({ resumeSessionId })', () => {
  /** A ModelAdapter that records every request it is handed; answers 'ACK'. */
  function recordingAdapter(seen: LLMRequest[]): ModelAdapter {
    return {
      id: 'recording-adapter',
      async *stream(req: LLMRequest) {
        seen.push(req)
        yield { type: 'text', delta: 'ACK' }
        yield { type: 'done', reason: 'stop' }
      },
    }
  }

  const userContents = (req: LLMRequest): string[] =>
    req.messages.filter((m) => m.role === 'user').map((m) => String(m.content))

  it('clears a previous error when a new turn succeeds', async () => {
    const { harness } = await tmpHarness({ steps: [() => { throw new Error('temporary failure') }, text('recovered')] })
    const agent = harness.main()
    expect((await agent.turn('first attempt')).error).toContain('temporary failure')
    expect(agent.error).toContain('temporary failure')
    expect((await agent.turn('retry')).output).toBe('recovered')
    expect(agent.status).toBe('done')
    expect(agent.error).toBeUndefined()
  })

  it('a fresh harness adopts the session of the first main() call and keeps it for plain main() calls', async () => {
    const seen: LLMRequest[] = []
    const { harness, ctx } = await tmpHarness({ adapter: recordingAdapter(seen) })

    // Pre-existing session on disk, as --resume / the GUI supplies it.
    const existing = await ctx.sessions.create({ agent: 'main' })
    await existing.append({ type: 'user/message', payload: { content: 'earlier question' } })

    const resumed = harness.main({ resumeSessionId: existing.id })
    expect(resumed.sessionId).toBe(existing.id) // visible to new dashboard clients before any turn
    expect(harness.main()).toBe(resumed) // the e2e phase-2 pattern: no opts, same agent
    const result = await harness.main().turn('follow up')

    expect(result.error).toBeUndefined()
    expect(harness.main().sessionId).toBe(existing.id)
    // The adopted session's history was reconstructed into the request.
    expect(userContents(seen[seen.length - 1]!)).toEqual(['earlier question', 'follow up'])
  })

  it('rebinds the main agent to another session and keeps that binding for later main() calls', async () => {
    const seen: LLMRequest[] = []
    const { harness, ctx } = await tmpHarness({ adapter: recordingAdapter(seen) })

    const first = harness.main()
    await first.turn('first question')
    const sessionA = first.sessionId
    expect(sessionA).not.toBe('(creating…)') // the placeholder a never-used agent reports

    const sessionB = await ctx.sessions.create({ agent: 'main' })
    await sessionB.append({ type: 'user/message', payload: { content: 'earlier question' } })

    const rebound = harness.main({ resumeSessionId: sessionB.id })
    expect(rebound).not.toBe(first)
    expect(rebound.sessionId).toBe(sessionB.id)

    // Re-requesting the same session must not churn the agent.
    expect(harness.main({ resumeSessionId: sessionB.id })).toBe(rebound)

    const result = await harness.main().turn('follow up')

    expect(result.error).toBeUndefined()
    expect(harness.main().sessionId).toBe(sessionB.id)
    expect(userContents(seen[seen.length - 1]!)).toEqual(['earlier question', 'follow up'])
    // The new turn landed in the adopted session, not in the previous one.
    const adopted = payloadsOf((await ctx.sessions.open(sessionB.id)).events, 'user/message').map((p) => p.content)
    expect(adopted).toEqual(['earlier question', 'follow up'])
    const previous = payloadsOf((await ctx.sessions.open(sessionA)).events, 'user/message').map((p) => p.content)
    expect(previous).toEqual(['first question'])
  })

  it('refuses to rebind while the main agent is mid-turn instead of dropping the turn', async () => {
    let streamStarted = false
    const blockingAdapter: ModelAdapter = {
      id: 'blocking-adapter',
      async *stream(req: LLMRequest): AsyncIterable<import('../src/core/index.js').StreamChunk> {
        streamStarted = true
        await new Promise<never>((_, reject) => {
          const abort = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }
          if (req.signal?.aborted) abort()
          else req.signal?.addEventListener('abort', abort)
        })
        yield { type: 'done', reason: 'stop' } // unreachable
      },
    }

    const { harness, ctx } = await tmpHarness({ adapter: blockingAdapter, steps: [] })
    const handle = harness.main()
    const pending = handle.turn('please hang forever')
    const deadline = Date.now() + 10_000
    while (!streamStarted && Date.now() < deadline) await sleep(10)
    expect(streamStarted).toBe(true)

    const other = await ctx.sessions.create()
    expect(() => harness.main({ resumeSessionId: other.id })).toThrow(/mid-turn/)
    expect(harness.main()).toBe(handle) // the refused call left the roster alone

    handle.interrupt()
    const result = await pending
    expect(result.cancelled).toBe(true)

    // Once idle the same rebind replaces the main agent.
    expect(harness.main({ resumeSessionId: other.id })).not.toBe(handle)
    const mains = ctx.agents.list().filter((a) => a.meta.role === 'main')
    expect(mains).toHaveLength(1)
    expect(mains[0]).not.toBe(handle)
  })
})
