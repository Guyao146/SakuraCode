/** Fixed previews reduce model input without losing recorded text or crossing session boundaries. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { text, toolCall, tmpHarness } from './helpers.js'
import { SessionService, type Session } from '../src/core/session.js'
import { ConversationHistoryService } from '../src/core/conversation-history.js'
import { OpenAICompatAdapter } from '../src/core/llm.js'
import type { AgentHandle, TurnResult } from '../src/core/agent.js'
import type { ChatMessage, ToolContext, ToolOutputPreview } from '../src/core/types.js'
import { previewToolOutput, validateToolOutputBudget, MAX_TOOL_OUTPUT_PAGE_CHARS } from '../src/util/tool-output.js'
import { estimateRequestContextTokens } from '../src/util/context.js'
import { spawnExperts } from '../src/experts.js'

const budget = 12_000
const longOutput = 'HEADER_EVIDENCE\n' + 'detailed result line 0123456789\n'.repeat(4000) + '\nEXIT 17; TAIL_DIAGNOSTIC'
const config = (enabled = budget) => ({ plugins: {
  'core-tools': { config: { outputPreviewChars: enabled } },
  'core-compaction': { config: { auto: 0, autoTokens: 0 } },
  'core-skills': { disabled: true }, 'core-agent-defs': { disabled: true },
} })
const tcFor = (session: Session): ToolContext => ({ sessionId: session.id, agentId: 'test-agent', signal: new AbortController().signal })

async function record(session: Session, output: string, modelPreview?: ToolOutputPreview, id = 'large-call') {
  const call = { id, type: 'function' as const, function: { name: 'large_fixture', arguments: '{}' } }
  await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: null, tool_calls: [call],
    stream: { text: '', toolCalls: [call], durationMs: 0 } } })
  return session.append({ type: 'tool/result', payload: { id, name: 'large_fixture', output, durationMs: 0,
    ...(modelPreview ? { modelPreview } : {}) } })
}
function pageBody(output: string) { return output.slice(output.indexOf('\n\n') + 2) }

beforeEach(() => { vi.stubGlobal('fetch', () => { throw new Error('Network is forbidden in tool preview tests') }) })
afterEach(() => { vi.unstubAllGlobals() })

describe('fixed tool text previews', () => {
  it.each([undefined, 0])('leaves output unchanged with budget %s', enabled => {
    expect(validateToolOutputBudget(enabled)).toBe(0)
    expect(previewToolOutput(longOutput, 0)).toBeUndefined()
  })
  it.each([-1, 1, 1023, 12.5, Number.NaN, Infinity, '12000', null, 1_000_001])('rejects invalid budget %s', value => {
    expect(() => validateToolOutputBudget(value)).toThrow()
  })
  it('keeps small text intact and bounds a large preview including its reference and diagnostic tail', () => {
    expect(previewToolOutput('small', budget)).toBeUndefined()
    const preview = previewToolOutput(longOutput, budget, true)!
    expect(preview.content.length).toBeLessThanOrEqual(budget)
    expect(preview.reference).toMatch(/^output_[0-9a-f]{32}$/)
    expect(preview.content).toContain(preview.reference)
    expect(preview.content).toContain('ERROR;')
    expect(preview.content).toContain('HEADER_EVIDENCE')
    expect(preview.content).toContain('TAIL_DIAGNOSTIC')
    expect(preview.content).toContain('earlier tool-side truncation cannot be recovered')
    expect(preview.content).not.toBe(longOutput)
  })
  it('does not split a surrogate pair on preview edges', () => {
    const preview = previewToolOutput('😀'.repeat(40_000), 1024)!
    expect(preview.content.length).toBeLessThanOrEqual(1024)
    expect(preview.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u)
  })

  it('applies after result middleware, keeps full output/images and leaves skill text and readback pages untrimmed', async () => {
    const { ctx } = await tmpHarness({ config: config() })
    const session = await ctx.sessions.create()
    ctx.tools.register({ name: 'large_fixture', description: 'offline text', kind: 'read', parameters: { type: 'object' },
      async execute() { return { output: longOutput, isError: true, images: ['data:image/png;base64,fixture'] } } })
    ctx.on('tools/post-execute', (payload: { name: string; output?: string }, next) =>
      next(payload.name === 'large_fixture' ? { ...payload, output: payload.output + '\nMIDDLEWARE_TAIL' } : payload))
    const result = await ctx.tools.execute('first', 'large_fixture', '{}', tcFor(session))
    expect(result.output).toBe(longOutput + '\nMIDDLEWARE_TAIL')
    expect(result.images).toEqual(['data:image/png;base64,fixture'])
    expect(result.isError).toBe(true)
    expect(result.modelPreview?.content).toContain('MIDDLEWARE_TAIL')
    ctx.tools.register({ name: 'skill', description: 'instruction fixture', kind: 'read', parameters: { type: 'object' },
      async execute() { return longOutput } })
    expect((await ctx.tools.execute('skill-text', 'skill', '{}', tcFor(session))).modelPreview).toBeUndefined()
    await record(session, result.output, result.modelPreview)
    const page = await ctx.tools.execute('readback', 'tool_output_read', JSON.stringify({ reference: result.modelPreview!.reference, limit: MAX_TOOL_OUTPUT_PAGE_CHARS }), tcFor(session))
    expect(page.modelPreview).toBeUndefined()
    expect(pageBody(page.output)).toBe(result.output.slice(0, MAX_TOOL_OUTPUT_PAGE_CHARS))
  })

  it('does not preview for a custom agent that cannot access the readback tool or when that tool is disabled', async () => {
    const { ctx } = await tmpHarness({ config: config() })
    ctx.tools.register({ name: 'large_fixture', description: 'text', kind: 'read', parameters: { type: 'object' }, async execute() { return longOutput } })
    const agent = ctx.agents.spawn({ seed: '', tools: ['large_fixture'], persistentSession: true })
    const session = await ctx.sessions.create()
    const result = await ctx.tools.execute('limited', 'large_fixture', '{}', { ...tcFor(session), agentId: agent.id })
    expect(result.modelPreview).toBeUndefined()
    const disabledConfig = config(); Object.assign(disabledConfig.plugins, { 'tool-output-read': { disabled: true } })
    const second = await tmpHarness({ config: disabledConfig })
    second.ctx.tools.register({ name: 'large_fixture', description: 'text', kind: 'read', parameters: { type: 'object' }, async execute() { return longOutput } })
    expect((await second.ctx.tools.execute('disabled', 'large_fixture', '{}', tcFor(session))).modelPreview).toBeUndefined()
  })
})

describe('recorded output projection and recovery', () => {
  it('persists full output, replays the same preview after restart and restores exact text from bounded pages', async () => {
    const { ctx } = await tmpHarness({ config: config() })
    const session = await ctx.sessions.create(), preview = previewToolOutput(longOutput, budget)!
    await record(session, longOutput, preview)
    const projected = session.deriveMessages().find(message => message.role === 'tool')!
    expect(projected).toMatchObject({ content: preview.content, tool_call_id: 'large-call' })
    const cold = new SessionService(path.dirname(session.dir)), reopened = await cold.open(session.id)
    expect(reopened.deriveMessages()).toEqual(session.deriveMessages())
    expect(await fs.readFile(session.file, 'utf8')).toContain('TAIL_DIAGNOSTIC')
    expect(reopened.events.find(event => event.type === 'tool/result')).toMatchObject({ payload: { output: longOutput } })
    let restored = ''
    while (restored.length < longOutput.length) {
      const result = await ctx.tools.execute('page', 'tool_output_read', JSON.stringify({ reference: preview.reference, offset: restored.length, limit: MAX_TOOL_OUTPUT_PAGE_CHARS }), tcFor(session))
      expect(result.isError).toBeFalsy()
      restored += pageBody(result.output)
    }
    expect(restored).toBe(longOutput)
    const exporter = ctx.get<{ toMarkdown(id: string): Promise<string>; toJson(id: string): Promise<unknown> }>('sessionExport')
    expect(await exporter.toMarkdown(session.id)).toContain(longOutput)
    expect(JSON.stringify(await exporter.toJson(session.id))).toContain(JSON.stringify(longOutput).slice(1, -1))
  })

  it('still reads a compacted result but never references discarded context after a clear', async () => {
    const { ctx } = await tmpHarness({ config: config() }), session = await ctx.sessions.create()
    const preview = previewToolOutput(longOutput, budget)!
    await record(session, longOutput, preview)
    await session.append({ type: 'session/note', payload: { note: 'compaction', summary: 'summary' } })
    expect(JSON.stringify(session.deriveMessages())).not.toContain(preview.reference)
    expect((await ctx.tools.execute('compacted', 'tool_output_read', JSON.stringify({ reference: preview.reference }), tcFor(session))).isError).toBeFalsy()
    await session.clearContext()
    expect((await ctx.tools.execute('cleared', 'tool_output_read', JSON.stringify({ reference: preview.reference }), tcFor(session))).isError).toBe(true)
  })

  it('inherits only retained output references into an independent conversation branch', async () => {
    const { ctx } = await tmpHarness({ config: config() }), source = await ctx.sessions.create()
    await source.append({ type: 'user/message', payload: { content: 'retained task' } })
    const kept = previewToolOutput(longOutput, budget)!, discarded = previewToolOutput(longOutput + 'DISCARDED', budget)!
    await record(source, longOutput, kept, 'retained-call')
    const target = await source.append({ type: 'user/message', payload: { content: 'discarded task' } })
    await record(source, longOutput + 'DISCARDED', discarded, 'discarded-call')
    const history = new ConversationHistoryService(ctx.sessions)
    const preview = await history.preview(source.id, target.seq)
    const branch = (await history.rewind({ sessionId: source.id, turnSeq: target.seq, contextRevision: preview.contextRevision,
      fingerprint: preview.fingerprint, mode: 'conversation' }, () => {})).session
    await ctx.sessions.delete(source.id)
    const read = (reference: string) => ctx.tools.execute('branch-page', 'tool_output_read', JSON.stringify({ reference, limit: 300 }), tcFor(branch))
    expect(pageBody((await read(kept.reference)).output)).toBe(longOutput.slice(0, 300))
    expect((await read(discarded.reference)).isError).toBe(true)
  })

  it('keeps original tool call/result pairing and recent image content', async () => {
    const { ctx } = await tmpHarness({ config: config() }), session = await ctx.sessions.create()
    const preview = previewToolOutput(longOutput, budget)!
    const row = await record(session, longOutput, preview)
    expect(row.type).toBe('tool/result')
    await session.append({ type: 'tool/result', payload: { id: 'image', name: 'screenshot', output: 'image output', images: ['data:image/png;base64,latest'], durationMs: 1 } })
    const projected = session.deriveMessages()
    const callIndex = projected.findIndex(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'large-call')
    expect(projected[callIndex + 1]).toMatchObject({ role: 'tool', tool_call_id: 'large-call', content: preview.content })
    expect(JSON.stringify(projected)).toContain('data:image/png;base64,latest')
  })

  it('does not make another session or workspace accessible by reference or by injecting a session id', async () => {
    const { ctx } = await tmpHarness({ config: config() }), owner = await ctx.sessions.create(), other = await ctx.sessions.create()
    const preview = previewToolOutput(longOutput, budget)!
    await record(owner, longOutput, preview)
    const read = (args: object) => ctx.tools.execute('denied', 'tool_output_read', JSON.stringify(args), tcFor(other))
    expect((await read({ reference: preview.reference })).isError).toBe(true)
    expect((await read({ reference: preview.reference, sessionId: owner.id })).isError).toBe(true)
    expect((await read({ reference: owner.file })).isError).toBe(true)
    const foreign = await tmpHarness({ config: config() }), foreignSession = await foreign.ctx.sessions.create()
    expect((await foreign.ctx.tools.execute('foreign', 'tool_output_read', JSON.stringify({ reference: preview.reference }), tcFor(foreignSession))).isError).toBe(true)
  })

  it.each([{ offset: -1 }, { offset: 0.5 }, { limit: 0 }, { limit: 12_001 }, { limit: '5' }])('validates pagination %j', async args => {
    const { ctx } = await tmpHarness({ config: config() }), session = await ctx.sessions.create()
    const preview = previewToolOutput(longOutput, budget)!
    await record(session, longOutput, preview)
    expect((await ctx.tools.execute('invalid-page', 'tool_output_read', JSON.stringify({ reference: preview.reference, ...args }), tcFor(session))).isError).toBe(true)
  })
})

async function teamTurn(main: AgentHandle, experts: AgentHandle[], input: string): Promise<TurnResult[]> {
  let release!: (value: { sessionId: string; userSeq: number } | undefined) => void
  const sharedUser = new Promise<{ sessionId: string; userSeq: number } | undefined>(resolve => { release = resolve })
  const first = main.turn(input, { expertMode: true, onUserMessage: release })
  void first.finally(() => release(undefined)).catch(() => {})
  return Promise.all([first, ...experts.map(expert => expert.turn(input, { expertMode: true, sharedUser }))])
}

describe('expert output previews', () => {
  it('shares bounded evidence, retains complete archival text, and grants readback only for the associated peer result', async () => {
    const { harness, ctx } = await tmpHarness({ config: config(), steps: [text('done')] })
    ctx.tools.register({ name: 'large_fixture', description: 'long evidence', kind: 'read', parameters: { type: 'object' }, async execute() { return longOutput } })
    const main = harness.main(), expert = spawnExperts(ctx.agents, ['architect']).spawned[0]!
    let expertSteps = 0
    ctx.on('llm/stream', (payload: { req: { retryContext?: { agentId?: string } }; source: unknown }, next) => {
      if (payload.req.retryContext?.agentId !== expert.id) return next(payload)
      const chunks = ++expertSteps === 1 ? toolCall('large_fixture', '{}', 'peer-large') : text('PEER_DONE')
      return { ...payload, source: (async function* () { yield* chunks })() }
    })
    const results = await teamTurn(main, [expert], 'shared evidence')
    expect(results.every(result => !result.error)).toBe(true)
    const log = await ctx.sessions.open(main.sessionId), archive = await ctx.sessions.open(expert.sessionId)
    const result = archive.events.find(row => row.type === 'tool/result' && row.payload.id === 'peer-large')!
    expect(result.type).toBe('tool/result')
    const preview = (result.payload as { modelPreview: ToolOutputPreview }).modelPreview
    expect(JSON.stringify(log.deriveMessages())).toContain(preview.reference)
    expect(JSON.stringify(log.deriveMessages())).not.toContain('detailed result line 0123456789\\n'.repeat(3000))
    const evidence = log.events.find(row => row.type === 'collaboration/message' && row.payload.toolPreviews?.['peer-large'])!
    expect(evidence).toMatchObject({ payload: { sourceSessionId: archive.id, messages: expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: longOutput }),
    ]) } })
    const allowed = await ctx.tools.execute('shared-page', 'tool_output_read', JSON.stringify({ reference: preview.reference, limit: 1000 }), { ...tcFor(log), agentId: main.id })
    expect(pageBody(allowed.output)).toBe(longOutput.slice(0, 1000))
    const unshared = await ctx.sessions.create()
    expect((await ctx.tools.execute('unshared-page', 'tool_output_read', JSON.stringify({ reference: preview.reference }), tcFor(unshared))).isError).toBe(true)
    const hidden = previewToolOutput('UNPUBLISHED_PEER_SECRET\n'.repeat(2000), budget)!
    await record(archive, 'UNPUBLISHED_PEER_SECRET\n'.repeat(2000), hidden, 'private-peer-call')
    expect((await ctx.tools.execute('unpublished', 'tool_output_read', JSON.stringify({ reference: hidden.reference }), tcFor(log))).isError).toBe(true)
    await ctx.sessions.delete(archive.id)
    const afterDelete = await ctx.tools.execute('archival-page', 'tool_output_read', JSON.stringify({ reference: preview.reference, limit: 1000 }), tcFor(log))
    expect(pageBody(afterDelete.output)).toBe(longOutput.slice(0, 1000))
  })

  it.each([false, true])('does not republish an old preview when a peer reuses a tool call id (clear: %s)', async clear => {
    const { harness, ctx } = await tmpHarness({ config: config(), steps: [text('done')] })
    let output = longOutput
    ctx.tools.register({ name: 'large_fixture', description: 'result changed between turns', kind: 'read', parameters: { type: 'object' }, async execute() { return output } })
    const main = harness.main(), expert = spawnExperts(ctx.agents, ['architect']).spawned[0]!
    let step = 0
    ctx.on('llm/stream', (payload: { req: { retryContext?: { agentId?: string } }; source: unknown }, next) => {
      if (payload.req.retryContext?.agentId !== expert.id) return next(payload)
      const chunks = ++step % 2 ? toolCall('large_fixture', '{}', 'reused-call') : text('PEER_DONE')
      return { ...payload, source: (async function* () { yield* chunks })() }
    })
    await teamTurn(main, [expert], 'first')
    const archive = await ctx.sessions.open(expert.sessionId), mainLog = await ctx.sessions.open(main.sessionId)
    const old = archive.events.find(event => event.type === 'tool/result')!
    const oldPreview = (old.payload as { modelPreview: ToolOutputPreview }).modelPreview
    if (clear) { await archive.clearContext(); await mainLog.clearContext() }
    output = 'SHORT_CURRENT_RESULT'
    await teamTurn(main, [expert], 'second')
    const second = [...mainLog.events].reverse().find(event => event.type === 'collaboration/message' && event.payload.messages.some(message => message.role === 'tool'))!
    expect(second).toMatchObject({ payload: { messages: expect.arrayContaining([expect.objectContaining({ role: 'tool', content: output })]) } })
    expect((second.payload as { toolPreviews?: unknown }).toolPreviews).toBeUndefined()
    expect(JSON.stringify(mainLog.deriveMessages())).toContain(output)
    if (clear) expect(JSON.stringify(mainLog.deriveMessages())).not.toContain(oldPreview.reference)
  })

  it('limits an expert readback to committed evidence for its current or earlier task', async () => {
    const { ctx } = await tmpHarness({ config: config() }), shared = await ctx.sessions.create(), own = await ctx.sessions.create(), peer = await ctx.sessions.create()
    const first = await shared.append({ type: 'user/message', payload: { content: 'current task' } })
    const early = previewToolOutput(longOutput, budget)!, later = previewToolOutput('NEXT_TASK_SECRET\n'.repeat(4000), budget)!
    await record(shared, longOutput, early, 'early-call')
    const beforeLate = shared.events.at(-1)!.seq
    await shared.append({ type: 'user/message', payload: { content: 'next task' } })
    await record(shared, 'NEXT_TASK_SECRET\n'.repeat(4000), later, 'later-call')
    const peerPreview = previewToolOutput('CURRENT_PEER_EVIDENCE\n'.repeat(4000), budget)!
    await shared.append({ type: 'collaboration/message', payload: { key: 'late-current-evidence', agentId: 'peer', agentName: 'peer',
      sourceSessionId: peer.id, turnSeq: 1, userSeq: first.seq, messages: [{ role: 'tool', tool_call_id: 'peer-call', content: 'CURRENT_PEER_EVIDENCE\n'.repeat(4000) }],
      toolPreviews: { 'peer-call': peerPreview } } })
    const read = (reference: string, throughSeq: number) => ctx.tools.execute('snapshot-page', 'tool_output_read', JSON.stringify({ reference, limit: 100 }),
      { ...tcFor(own), sharedContext: { sessionId: shared.id, userSeq: first.seq, throughSeq } })
    const last = shared.events.at(-1)!.seq
    expect(pageBody((await read(early.reference, last)).output)).toBe(longOutput.slice(0, 100))
    expect((await read(later.reference, last)).isError).toBe(true)
    expect((await read(peerPreview.reference, beforeLate)).isError).toBe(true)
    expect(pageBody((await read(peerPreview.reference, last)).output)).toBe('CURRENT_PEER_EVIDENCE\n'.repeat(4000).slice(0, 100))
  })
})

describe('offline request-size evidence', () => {
  it('reduces the captured upstream tool text and preserves the exact recorded original', async () => {
    const captures: { messages?: ChatMessage[]; input?: unknown[] }[] = []
    const adapter = new OpenAICompatAdapter({ baseURL: 'https://offline.invalid/v1', model: 'fixture', fetch: async (_url, init) => {
      captures.push(JSON.parse(String(init?.body)))
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    const { ctx } = await tmpHarness({ config: config() }), session = await ctx.sessions.create(), preview = previewToolOutput(longOutput, budget)!
    await record(session, longOutput, preview)
    const full = session.deriveMessages({ fullToolOutput: true }), optimized = session.deriveMessages(), tools = ctx.tools.schemas()
    for (const messages of [full, optimized]) for await (const _chunk of adapter.stream({ messages, tools })) { /* consume stubbed SSE */ }
    expect(captures[0]?.messages?.find(message => message.role === 'tool')?.content).toBe(longOutput)
    expect(captures[1]?.messages?.find(message => message.role === 'tool')?.content).toBe(preview.content)
    const before = estimateRequestContextTokens(full, tools), after = estimateRequestContextTokens(optimized, tools)
    expect(after).toBeLessThan(before * 0.3)
    console.info(`OFFLINE_PREVIEW_INPUT before=${before} after=${after} reduced=${((1 - after / before) * 100).toFixed(1)}%; heuristic, not provider billing or cache hits`)
  })
})
