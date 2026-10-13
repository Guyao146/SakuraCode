/** Shared expert roster and main-agent synthesis contracts; all turns use an offline model. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHandle, AgentStatus } from '../src/core/agent.js'
import { BASE_BUNDLE } from '../src/harness.js'
import { buildExpertSummary, DEFAULT_EXPERTS, spawnExperts } from '../src/experts.js'
import { tmpHarness, text, type MockStep } from './helpers.js'

// Do not discover user skills, hooks, plugins or MCP servers. Explicit dummy
// provider options also prevent fallback to any environment credentials.
const core = new Set(['core-session', 'core-system-prompt', 'core-approval', 'core-llm', 'core-tools', 'core-agent'])
const config = {
  bundles: [],
  plugins: {
    ...Object.fromEntries(BASE_BUNDLE.map(({ name }) => [name, { disabled: !core.has(name) }])),
    'core-llm': { config: { apiKey: '', baseURL: 'http://127.0.0.1:1/offline', model: 'mock-model' } },
  },
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network is forbidden in expert unit tests') }))
})
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled() }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks() }
})

function boot(steps: MockStep[] = [text('ok')]) {
  return tmpHarness({ steps, config, approvalMode: 'default' })
}

describe('spawnExperts', () => {
  it('spawns the built-in three-member team with expert metadata and persistent idle sessions', async () => {
    const { ctx } = await boot()
    const spawn = vi.spyOn(ctx.agents, 'spawn')
    const { spawned, reused, skipped } = spawnExperts(ctx.agents)
    expect(spawned.map((h) => h.name)).toEqual(DEFAULT_EXPERTS.map((e) => e.name))
    expect(reused).toEqual([])
    expect(skipped).toEqual([])
    for (const handle of spawned) {
      expect(handle.meta.expert).toBe(DEFAULT_EXPERTS.find((e) => e.name === handle.name)?.key)
      expect(handle.meta.role).toBe('sub')
      expect(handle.status).toBe('idle')
    }
    for (const [options] of spawn.mock.calls) {
      expect(options).toMatchObject({ seed: '', autoStart: false, persistentSession: true, background: true, tools: 'core' })
    }
    expect(ctx.agents.list()).toEqual(spawned)
  })

  it('returns existing handles on repeated starts rather than just skipping their names', async () => {
    const { ctx } = await boot()
    const first = spawnExperts(ctx.agents)
    const second = spawnExperts(ctx.agents)
    const third = spawnExperts(ctx.agents)
    expect(second.spawned).toEqual([])
    expect(second.skipped).toEqual([])
    expect(second.reused).toEqual(first.spawned)
    expect(third.reused).toEqual(first.spawned)
    second.reused.forEach((handle, i) => expect(handle).toBe(first.spawned[i]))
    expect(ctx.agents.list()).toHaveLength(3)
  })

  it('restores a cleared active team with the same handles and conversation history', async () => {
    const received: string[] = []
    const { ctx } = await boot([(req) => {
      received.push(String(req.messages.at(-1)?.content ?? ''))
      return text('offline expert answer')
    }])
    let active = spawnExperts(ctx.agents).spawned
    const original = [...active]
    await Promise.all(active.map((handle) => handle.turn('opening task')))
    const sessions = active.map((handle) => handle.sessionId)
    active = [] // The caller stops fan-out without deleting the roster.
    const restarted = spawnExperts(ctx.agents)
    active = [...restarted.spawned, ...restarted.reused]
    expect(restarted.spawned).toEqual([])
    expect(active.map((handle) => handle.sessionId)).toEqual(sessions)
    active.forEach((handle, i) => expect(handle).toBe(original[i]))
    await Promise.all(active.map((handle) => handle.turn('follow-up task')))
    expect(received.filter((message) => message === 'opening task')).toHaveLength(3)
    expect(received.filter((message) => message === 'follow-up task')).toHaveLength(3)
    for (const handle of active) {
      const session = await ctx.sessions.open(handle.sessionId)
      const inputs = session.events.filter((e) => e.type === 'user/message').map((e) => (e.payload as { content: string }).content)
      expect(inputs).toEqual(['opening task', 'follow-up task'])
    }
  })

  it('reuses only requested members, in request order and without repeated keys', async () => {
    const { ctx } = await boot()
    const first = spawnExperts(ctx.agents)
    const subset = spawnExperts(ctx.agents, ['reviewer', 'architect', 'reviewer'])
    expect(subset.spawned).toEqual([])
    expect(subset.skipped).toEqual([])
    expect(subset.reused).toEqual([first.spawned[2], first.spawned[0]])
    expect(ctx.agents.list()).toHaveLength(3)
  })

  it('combines a reused subset with only the missing newly spawned members', async () => {
    const { ctx } = await boot()
    const reviewer = spawnExperts(ctx.agents, ['reviewer']).spawned[0]!
    const full = spawnExperts(ctx.agents)
    expect(full.reused).toEqual([reviewer])
    expect(full.spawned.map((handle) => handle.meta.expert)).toEqual(['architect', 'implementer'])
    expect(full.skipped).toEqual([])
    expect(ctx.agents.list()).toHaveLength(3)
  })

  it.each([
    { role: 'sub' as const },
    { role: 'sub' as const, expert: 'unrelated' },
    { role: 'main' as const, expert: 'architect' },
  ])('does not adopt a same-name member without matching expert identity: %j', async (meta) => {
    const { ctx } = await boot()
    const ordinary = ctx.agents.spawn({ name: '架构师', seed: '', autoStart: false, meta })
    const result = spawnExperts(ctx.agents)
    expect(result.reused).toEqual([])
    expect(result.skipped).toEqual(['架构师'])
    expect(result.spawned.map((handle) => handle.name)).toEqual(['实现者', '审查者'])
    expect(ctx.agents.get(ordinary.id)).toBe(ordinary)
    expect(ordinary.meta).toEqual(meta)
    expect(ctx.agents.list()).toHaveLength(3)
  })

  it('uses the stable preset identity rather than relying on a matching display name', async () => {
    const { ctx } = await boot()
    const existing = ctx.agents.spawn({ name: '自定义展示名', seed: '', autoStart: false, meta: { role: 'sub', expert: 'reviewer' } })
    const result = spawnExperts(ctx.agents, ['reviewer'])
    expect(result).toEqual({ spawned: [], reused: [existing], skipped: [] })
    expect(existing.name).toBe('自定义展示名')
  })

  it('keeps additional takenNames reservations without hiding real roster conflicts', async () => {
    const { ctx } = await boot()
    const ordinary = ctx.agents.spawn({ name: '审查者', seed: '', autoStart: false, meta: { role: 'sub' } })
    const result = spawnExperts(ctx.agents, undefined, new Set(['架构师']))
    expect(result.spawned.map((handle) => handle.name)).toEqual(['实现者'])
    expect(result.reused).toEqual([])
    expect(result.skipped).toEqual(['架构师', '审查者'])
    expect(ctx.agents.get(ordinary.id)).toBe(ordinary)
    const existing = result.spawned[0]!
    expect(spawnExperts(ctx.agents, ['implementer'], new Set(['实现者']))).toEqual({ spawned: [], reused: [existing], skipped: [] })
  })

  it('validates every key before spawning even when an unknown key follows valid ones', async () => {
    const { ctx } = await boot()
    const spawn = vi.spyOn(ctx.agents, 'spawn')
    expect(() => spawnExperts(ctx.agents, ['architect', 'ghost'])).toThrow(/unknown expert "ghost"/)
    expect(spawn).not.toHaveBeenCalled()
    expect(ctx.agents.list()).toEqual([])
    expect(spawnExperts(ctx.agents, ['reviewer']).spawned.map((handle) => handle.name)).toEqual(['审查者'])
  })
})

function member(id: string, status: AgentStatus, result?: string, error?: string): AgentHandle {
  return {
    id, name: `专家-${id}`, sessionId: `session-${id}`, model: 'mock-model', meta: { role: 'sub', expert: 'reviewer' },
    status, result, error,
    turn: vi.fn(async () => ({ output: 'must not run', steps: 0 })),
    wait: vi.fn(async () => ({ output: 'must not wait', steps: 0 })),
    interrupt: vi.fn(),
  }
}

describe('buildExpertSummary', () => {
  it('includes actual completed expert output, names, IDs and statuses without starting any turns', async () => {
    const answer = 'actual expert evidence beyond a short roster preview: ' + 'evidence '.repeat(60) + 'RESULT_END'
    const { ctx } = await boot([text(answer)])
    const handles = spawnExperts(ctx.agents).spawned
    await Promise.all(handles.map((handle) => handle.turn('inspect task')))
    const spies = handles.map((handle) => ({ turn: vi.spyOn(handle, 'turn'), wait: vi.spyOn(handle, 'wait') }))
    const summary = buildExpertSummary(handles)!
    expect(summary).toContain('综合成统一答复')
    expect(summary.split(answer)).toHaveLength(4)
    for (const handle of handles) {
      expect(summary).toContain(handle.name)
      expect(summary).toContain(handle.id)
    }
    expect(summary).toContain('状态: done')
    for (const spy of spies) {
      expect(spy.turn).not.toHaveBeenCalled()
      expect(spy.wait).not.toHaveBeenCalled()
    }
  })

  it('reports incomplete, failed, cancelled and empty results without reusing any stale success', () => {
    const handles = [
      member('running', 'running', 'STALE_RUNNING'),
      member('failed', 'error', 'STALE_ERROR', 'provider failed'),
      member('cancelled', 'cancelled', 'STALE_CANCELLED'),
      member('idle', 'idle', 'STALE_IDLE'),
      member('empty', 'done', '   '),
      member('ready', 'done', 'CURRENT_CONCLUSION'),
    ]
    const order = [...handles]
    const summary = buildExpertSummary(handles)!
    expect(summary).toContain('CURRENT_CONCLUSION')
    expect(summary).toContain('provider failed')
    expect(summary).toContain('空结果')
    expect(summary).toContain('尚未完成')
    expect(summary).toContain('本轮已中断')
    expect(summary).not.toContain('STALE_')
    for (const handle of handles) {
      expect(summary).toContain(handle.id)
      expect(summary).toContain(`状态: ${handle.status}`)
      expect(handle.turn).not.toHaveBeenCalled()
      expect(handle.wait).not.toHaveBeenCalled()
    }
    expect(handles).toEqual(order)
  })

  it('does not leak a previous real successful result after a later turn fails', async () => {
    const { ctx } = await boot([text('PREVIOUS_SUCCESS'), () => { throw new Error('CURRENT_FAILURE') }])
    const handle = spawnExperts(ctx.agents, ['reviewer']).spawned[0]!
    await handle.turn('first task')
    await handle.turn('second task')
    expect(handle.status).toBe('error')
    expect(handle.result).toBe('PREVIOUS_SUCCESS') // The agents service intentionally retains it.
    expect(buildExpertSummary([handle])).toBeNull()
    const summary = buildExpertSummary([handle, member('ready', 'done', 'CURRENT_SUCCESS')])!
    expect(summary).toContain('CURRENT_FAILURE')
    expect(summary).not.toContain('PREVIOUS_SUCCESS')
  })

  it('returns null for an empty, unfinished, failed-only or empty-result team', () => {
    expect(buildExpertSummary([])).toBeNull()
    const unusable = [
      member('running', 'running', 'stale'), member('error', 'error', 'stale', 'failure only'),
      member('cancelled', 'cancelled', 'stale'), member('idle', 'idle'), member('empty', 'done', '\n  '),
    ]
    for (const handle of unusable) expect(buildExpertSummary([handle])).toBeNull()
    expect(buildExpertSummary(unusable)).toBeNull()
  })

  it('includes a member once when callers accidentally repeat its handle', () => {
    const handle = member('same', 'done', 'UNIQUE_CONCLUSION')
    const summary = buildExpertSummary([handle, handle])!
    expect(summary.split('UNIQUE_CONCLUSION')).toHaveLength(2)
    expect(summary.split('### 专家')).toHaveLength(2)
  })

  it('caps every member block at 12000 characters, including long names and errors', () => {
    const huge = member('long-id'.repeat(3000), 'done', 'DETAIL'.repeat(5000) + 'OMITTED_RESULT_TAIL')
    Object.defineProperty(huge, 'name', { value: 'long-name'.repeat(3000) })
    const summary = buildExpertSummary([huge, member('failure', 'error', 'STALE', 'ERROR'.repeat(5000))])!
    const blocks = summary.split('\n\n### 专家 ').slice(1)
    expect(blocks).toHaveLength(2)
    for (const block of blocks) expect(('### 专家 ' + block).length).toBeLessThanOrEqual(12000)
    expect(summary).toContain('[已截断]')
    expect(summary).not.toContain('OMITTED_RESULT_TAIL')
    expect(summary).not.toContain('STALE')
  })

  it('caps the whole prompt at 40000 characters and preserves actual evidence before omitted statuses', () => {
    const unfinished = Array.from({ length: 50 }, (_, i) => member(`failed-${i}`, 'error', 'STALE', 'x'.repeat(15000)))
    const summary = buildExpertSummary([...unfinished, member('ready', 'done', 'AVAILABLE_CONCLUSION')])!
    expect(summary).toContain('AVAILABLE_CONCLUSION')
    expect(summary).toContain('其余记录已省略')
    expect(summary.length).toBeLessThanOrEqual(40000)
    expect(summary).not.toContain('STALE')
  })
})
