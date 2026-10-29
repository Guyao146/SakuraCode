/** Shared expert context and user-only memory use real persisted temporary sessions, never the user's workspace. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentHandle, AgentRuntime, TurnResult } from '../src/core/agent.js'
import type { ChatMessage, LLMRequest, ModelAdapter } from '../src/core/types.js'
import { spawnExperts } from '../src/experts.js'
import { SessionService } from '../src/core/session.js'
import type { MemoryProcessingService } from '../src/plugins/memory-processing.js'
import type { WorkspaceMemoryService } from '../src/plugins/workspace-memory.js'
import { text, toolCall, tmpHarness } from './helpers.js'

const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
const users = (messages: ChatMessage[]) => messages.filter(message => message.role === 'user').map(message => message.content)
async function teamTurn(main: AgentHandle, experts: AgentHandle[], input: string): Promise<TurnResult[]> {
  let resolve!: (value: { sessionId: string; userSeq: number } | undefined) => void
  const sharedUser = new Promise<{ sessionId: string; userSeq: number } | undefined>(done => { resolve = done })
  const first = main.turn(input, { expertMode: true, onUserMessage: resolve })
  void first.finally(() => resolve(undefined)).catch(() => {})
  return Promise.all([first, ...experts.map(expert => expert.turn(input, { expertMode: true, sharedUser }))])
}

describe('expert shared context', () => {
  it('gives every expert prior main history, one canonical task, attributed peer answers and restart-safe context without changing archive logs', async () => {
    const requests: LLMRequest[] = []
    const { harness, ctx } = await tmpHarness({ steps: [request => { requests.push(structuredClone({ ...request, signal: undefined })); return text('ANSWER_' + requests.length) }] })
    const main = harness.main(); await main.turn('MAIN_PRIOR_DIRECTION')
    const experts = spawnExperts(ctx.agents).spawned
    const results = await teamTurn(main, experts, 'SHARED_TASK_ONCE')
    expect(results.every(result => !result.error)).toBe(true)
    const turns = requests.slice(1)
    expect(turns).toHaveLength(4)
    for (const request of turns) {
      expect(users(request.messages)).toEqual(['MAIN_PRIOR_DIRECTION', 'SHARED_TASK_ONCE'])
      expect(JSON.stringify(request.messages)).toContain('ANSWER_1')
    }
    const session = await ctx.sessions.open(main.sessionId)
    expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(2)
    const contributions = session.events.filter(event => event.type === 'collaboration/message')
    expect(new Set(contributions.map(event => event.payload.key)).size).toBe(contributions.length)
    expect(contributions.filter(event => event.payload.messages.length)).toHaveLength(3)
    const before = await Promise.all(experts.map(async expert => {
      const archive = await ctx.sessions.open(expert.sessionId)
      expect(archive.events.filter(event => event.type === 'user/message')).toHaveLength(1)
      expect(archive.events.find(event => event.type === 'session/note' && event.payload.note === 'expert-context'))
        .toMatchObject({ payload: { contextSessionId: main.sessionId, throughSeq: expect.any(Number), userSeq: results[0]!.userSeq } })
      return { file: archive.file, bytes: await fs.readFile(archive.file) }
    }))
    await main.turn('MAIN_FOLLOWUP')
    const last = requests.at(-1)!
    for (const expert of experts) expect(JSON.stringify(last.messages)).toContain(expert.name)
    expect(users(last.messages)).toEqual(['MAIN_PRIOR_DIRECTION', 'SHARED_TASK_ONCE', 'MAIN_FOLLOWUP'])
    for (const row of before) expect(await fs.readFile(row.file)).toEqual(row.bytes)
    const cold = new SessionService(path.dirname(session.dir)), reopened = await cold.open(session.id)
    expect(reopened.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('does not expose an unfinished main tool call or mix the next queued task into a slower expert request', async () => {
    const holdMain = barrier(), holdExpert = barrier()
    const owner = new Map<string, AgentRuntime>()
    const calls = new Map<string, number>(), expertRequests: LLMRequest[] = []
    const adapter: ModelAdapter = { id: 'shared-tools-fixture', async *stream(request) {
      const agent = owner.get(request.retryContext!.agentId!)!, step = (calls.get(agent.id) ?? 0) + 1; calls.set(agent.id, step)
      if (agent.meta.role === 'main') {
        if (step === 1) { yield* toolCall('hold_main_fixture', '{}', 'held-main-call'); return }
        yield* text('MAIN_DONE'); return
      }
      expertRequests.push(structuredClone({ ...request, signal: undefined }))
      if (step === 1) { await holdExpert.promise; yield* toolCall('list_agents', '{}', 'expert-list'); return }
      yield* text('EXPERT_DONE')
    } }
    const { harness, ctx } = await tmpHarness({ adapter })
    ctx.on('agent/request', (payload: { agent: AgentRuntime; request: LLMRequest }, next) => { owner.set(payload.agent.id, payload.agent); return next(payload) })
    ctx.tools.register({ name: 'hold_main_fixture', kind: 'read', description: 'Test-only barrier', parameters: { type: 'object' },
      async execute() { await holdMain.promise; return 'MAIN_TOOL_EVIDENCE' } })
    const main = harness.main(), expert = spawnExperts(ctx.agents, ['architect']).spawned[0]!
    const task = teamTurn(main, [expert], 'CURRENT_TASK')
    try {
      await vi.waitFor(() => expect(expertRequests).toHaveLength(1))
      expect(expertRequests[0]!.messages.some(message => message.role === 'tool' || message.role === 'assistant' && message.tool_calls?.length)).toBe(false)
      holdMain.release()
      await main.wait()
      await main.turn('NEXT_QUEUED_TASK')
      holdExpert.release()
      await task
      expect(expertRequests).toHaveLength(2)
      expect(JSON.stringify(expertRequests[1]!.messages)).not.toContain('NEXT_QUEUED_TASK')
      expect(JSON.stringify(expertRequests[1]!.messages)).toContain('MAIN_TOOL_EVIDENCE')
      expect(users(expertRequests[1]!.messages)).toEqual(['CURRENT_TASK'])
      const log = await ctx.sessions.open(main.sessionId), projected = log.deriveMessages()
      const index = projected.findIndex(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'held-main-call')
      expect(projected[index + 1]).toMatchObject({ role: 'tool', tool_call_id: 'held-main-call' })
    } finally { holdMain.release(); holdExpert.release(); await task }
  })

  it('keeps peer commits outside a pending assistant/tool block and honors context-clear and compaction boundaries', async () => {
    const { ctx } = await tmpHarness(), session = await ctx.sessions.create()
    const user = await session.append({ type: 'user/message', payload: { content: 'task' } })
    const call = { id: 'main-pair', type: 'function' as const, function: { name: 'read', arguments: '{}' } }
    await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: null, tool_calls: [call], stream: { text: '', toolCalls: [call], durationMs: 0 } } })
    await session.append({ type: 'collaboration/message', payload: { key: 'peer:1', agentId: 'expert-1', agentName: '架构师', sourceSessionId: 'peer', turnSeq: 1, userSeq: user.seq,
      messages: [{ role: 'assistant', content: 'PEER_EVIDENCE' }] } })
    expect(JSON.stringify(session.deriveMessages({ committedOnly: true }))).not.toContain('main-pair')
    await session.append({ type: 'tool/result', payload: { id: 'main-pair', name: 'read', output: 'READ_RESULT', durationMs: 1 } })
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    await session.append({ type: 'session/note', payload: { note: 'compaction', summary: 'COMPACTED_TEAM' } })
    expect(JSON.stringify(session.deriveMessages())).toContain('COMPACTED_TEAM')
    expect(JSON.stringify(session.deriveMessages())).not.toContain('PEER_EVIDENCE')
    await session.append({ type: 'session/note', payload: { note: 'context-clear' } })
    expect(session.deriveMessages()).toEqual([])
  })
})

describe('expert user-only memory provenance', () => {
  it('collects only original user adjustment directions once, excluding main/peer utterances and generated summaries', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [text('AGENT_GUESS_NOT_A_USER_DIRECTION')] })
    const main = harness.main(), experts = spawnExperts(ctx.agents).spawned
    await teamTurn(main, experts, '请改成浅色并保留用户草稿')
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory'), processor = ctx.get<MemoryProcessingService>('memoryProcessing')
    let snapshot = await memory.reload()
    expect(snapshot.pendingContent).toContain('用户调整要求：请改成浅色并保留用户草稿')
    expect(snapshot.pendingContent).not.toContain('AGENT_GUESS')
    await main.turn('GENERATED_SUMMARY_TEXT', { source: 'expert-summary', expertMode: true })
    await processor.collect(main.sessionId)
    snapshot = await memory.reload()
    expect(snapshot.pendingContent).not.toContain('GENERATED_SUMMARY_TEXT')
    const session = await ctx.sessions.open(main.sessionId)
    expect(session.events.filter(event => event.type === 'user/message').at(-1)).toMatchObject({ payload: { source: 'expert-summary' } })
    ctx.agents.setExpertMemoryMode(main.id, false)
    await main.turn('ordinary turn')
    expect((await memory.reload()).pendingContent).toContain('AGENT_GUESS_NOT_A_USER_DIRECTION')
  })

  it('hides and blocks memory_write and direct memory file writes for the expert roster while leaving manual updates and project edits available', async () => {
    let schemas: string[] = []
    const { harness, ctx } = await tmpHarness({ steps: [request => { schemas = (request.tools ?? []).map(tool => tool.name); return text('done') }] })
    const main = harness.main(); spawnExperts(ctx.agents, ['architect'])
    await main.turn('用户要求调整布局')
    expect(schemas).toContain('memory_read'); expect(schemas).not.toContain('memory_write')
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory'), before = memory.snapshot()
    const tc = { agentId: main.id, sessionId: main.sessionId, signal: new AbortController().signal }
    expect(await ctx.tools.execute('agent-memory', 'memory_write', JSON.stringify({ content: 'AGENT_UTTERANCE', revision: before.revision }), tc)).toMatchObject({ isError: true })
    expect(await ctx.tools.execute('file-memory', 'write', JSON.stringify({ file_path: before.path, content: 'AGENT_UTTERANCE' }), tc)).toMatchObject({ isError: true })
    expect(memory.snapshot().content).toBe(before.content)
    await memory.update({ content: 'MANUAL_USER_NOTE' }, memory.snapshot().revision)
    expect(memory.snapshot().content).toBe('MANUAL_USER_NOTE')
  })
})