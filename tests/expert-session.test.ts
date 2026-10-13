/** Expert-session REST regressions: temporary workspaces, a scripted model, and loopback HTTP only. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntime, AgentStatus } from '../src/core/agent.js'
import type { LLMRequest, ModelAdapter } from '../src/core/types.js'
import { BASE_BUNDLE } from '../src/harness.js'
import { DEFAULT_EXPERTS } from '../src/experts.js'
import { runWebServer } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const OPERATOR = 'expert-session-operator-' + 'a'.repeat(40)
const VIEWER = 'expert-session-viewer-' + 'b'.repeat(40)
const EXPERT_NAMES = DEFAULT_EXPERTS.map((preset) => preset.name)
const core = new Set(['core-session', 'core-system-prompt', 'core-approval', 'core-llm', 'core-tools', 'core-agent'])
const nativeFetch = globalThis.fetch
const allowedOrigins = new Set<string>()
const cleanups: Array<() => Promise<void>> = []
let sandbox = ''
let forbiddenRequests: string[] = []

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-expert-session-'))
  const home = path.join(sandbox, 'home')
  await fs.mkdir(home)
  // Custom slash-command discovery also checks os.homedir(); never scan the real user's commands.
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('SAKURA_API_KEY', '')
  vi.stubEnv('SAKURA_BASE_URL', 'http://127.0.0.1:1/offline')
  vi.stubEnv('SAKURA_MODEL', 'mock-model')
  forbiddenRequests = []
  vi.stubGlobal('fetch', ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== '127.0.0.1' || !allowedOrigins.has(url.origin)) {
      forbiddenRequests.push(url.origin)
      throw new Error('Expert-session tests forbid non-fixture network requests')
    }
    return nativeFetch(input, init)
  }) as typeof fetch)
})

afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()?.()
    expect(forbiddenRequests).toEqual([])
  } finally {
    allowedOrigins.clear()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    await fs.rm(sandbox, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
  }
})

interface AgentRow {
  id: string
  name: string
  role: string
  sessionId: string
  status: AgentStatus
  expert?: string
  error?: string
}
interface State {
  expertMode: boolean
  expertIds: string[]
  sessionId: string | null
  workspaceId: string
  agents: AgentRow[]
  server: { remote: boolean }
}
interface StartResult {
  expertMode: boolean
  started: string[]
  reused: string[]
  skipped: string[]
  queued: boolean
}
interface ModelCall {
  id: string
  name: string
  role: string
  expert?: string
  input: string
  messages: LLMRequest['messages']
  signal: AbortSignal
  answer: string
}
interface Response<T> { status: number; body: T }

async function boot(options: { remote?: boolean; beforeReply?: (call: ModelCall) => void | Promise<void> } = {}) {
  const cwd = await fs.mkdtemp(path.join(sandbox, 'workspace-'))
  const calls: ModelCall[] = []
  const owners = new WeakMap<AbortSignal, Pick<ModelCall, 'id' | 'name' | 'role' | 'expert'>>()
  const records = new WeakMap<AbortSignal, ModelCall>()
  // A step returns chunks directly, not an array containing another chunk array.
  const scripted = new MockAdapter([(req) => text(records.get(req.signal!)!.answer)])
  const adapter: ModelAdapter = {
    id: 'expert-session-mock', defaultModel: 'mock-model', models: ['mock-model'],
    async *stream(req) {
      const signal = req.signal!
      const owner = owners.get(signal)
      if (!owner) throw new Error('Missing agent identity for the mock request')
      const call: ModelCall = {
        ...owner, signal,
        input: String([...req.messages].reverse().find((message) => message.role === 'user')?.content ?? ''),
        messages: structuredClone(req.messages),
        answer: `UNIQUE_MODEL_ANSWER_${owner.id}_${calls.length}_END`,
      }
      calls.push(call)
      records.set(signal, call)
      await options.beforeReply?.(call)
      signal.throwIfAborted()
      yield* scripted.stream(req)
    },
  }
  const handle = await runWebServer({
    cwd, sessionDir: 'sessions', jobsDir: 'jobs', adapter, approvalMode: 'default',
    host: '127.0.0.1', port: 0, open: false, quiet: true, updatesAutoCheck: false,
    token: options.remote ? OPERATOR : null,
    viewerToken: options.remote ? VIEWER : null,
    // Exercise remote access policy without exposing a listener beyond loopback.
    ...(options.remote ? { publicOrigin: 'https://expert-session.test' } : {}),
    config: {
      bundles: [],
      plugins: {
        ...Object.fromEntries(BASE_BUNDLE.map(({ name }) => [name, { disabled: !core.has(name) }])),
        'core-llm': { config: { apiKey: '', baseURL: 'http://127.0.0.1:1/offline', model: 'mock-model' } },
      },
    },
  })
  const base = `http://127.0.0.1:${handle.port}`
  allowedOrigins.add(base)
  cleanups.push(async () => {
    const agents = handle.harness.ctx.agents.list()
    await handle.close()
    await Promise.all(agents.map((agent) => agent.wait()))
    allowedOrigins.delete(base)
  })
  // LLMService may copy the request to resolve its model name, but its signal is stable.
  handle.harness.ctx.on('agent/request', (payload: { agent: AgentRuntime; request: LLMRequest }, next) => {
    owners.set(payload.request.signal!, {
      id: payload.agent.id, name: payload.agent.name, role: payload.agent.meta.role ?? 'sub',
      expert: typeof payload.agent.meta.expert === 'string' ? payload.agent.meta.expert : undefined,
    })
    return next(payload)
  })
  const headers: Record<string, string> = options.remote
    ? { host: 'expert-session.test', authorization: `Bearer ${OPERATOR}` } : {}
  async function request<T>(route: string, method: 'GET' | 'POST', body?: unknown, extra: Record<string, string> = {}): Promise<Response<T>> {
    if (options.remote) {
      // Native fetch normalizes Host; raw loopback HTTP preserves the configured proxy host.
      return new Promise((resolve, reject) => {
        const req = http.request(base + route, {
          method, headers: { ...headers, 'content-type': 'application/json', ...extra },
        }, (res) => {
          let raw = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => { raw += chunk })
          res.on('error', reject)
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as T }) }
            catch (error) { reject(error) }
          })
        })
        req.on('error', reject)
        req.setTimeout(8000, () => req.destroy(new Error('Remote-policy loopback fixture timed out')))
        req.end(body === undefined ? undefined : JSON.stringify(body))
      })
    }
    const response = await fetch(base + route, {
      method, headers: { ...headers, 'content-type': 'application/json', ...extra },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000),
    })
    return { status: response.status, body: await response.json() as T }
  }
  const post = <T = Record<string, unknown>>(route: string, body: unknown = {}, extra: Record<string, string> = {}) => request<T>(route, 'POST', body, extra)
  const get = <T = Record<string, unknown>>(route: string, extra: Record<string, string> = {}) => request<T>(route, 'GET', undefined, extra)
  const state = async (extra: Record<string, string> = {}) => {
    const response = await get<State>('/api/state', extra)
    expect(response.status).toBe(200)
    return response.body
  }
  const settle = () => Promise.all(handle.harness.ctx.agents.list().map((agent) => agent.wait()))
  const users = async (sessionId: string) => {
    const response = await get<{ records: Array<{ type: string; payload: { content?: string } }> }>(`/api/sessions/${sessionId}/records`)
    expect(response.status).toBe(200)
    return response.body.records.filter((record) => record.type === 'user/message').map((record) => record.payload.content)
  }
  return { handle, base, cwd, calls, post, get, state, settle, users }
}

type Fixture = Awaited<ReturnType<typeof boot>>
const experts = (state: State) => state.agents.filter((agent) => agent.expert)
const main = (state: State) => state.agents.find((agent) => agent.role === 'main')!
function expectRecipients(calls: ModelCall[], ids: string[]) {
  expect(calls.map((call) => call.id).sort()).toEqual([...ids].sort())
}
function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

/** Leave the final JSON byte unsent until after a completed session switch. */
async function slowPost(fixture: Fixture, route: string, body: unknown, workspaceId: string) {
  const raw = Buffer.from(JSON.stringify(body))
  const entered = barrier()
  const marker = `slow-${route}`
  const observe = (req: http.IncomingMessage) => {
    if (req.headers['x-expert-test'] !== marker) return
    // The server's earlier request listener has already captured the epoch and is awaiting the body.
    fixture.handle.server.off('request', observe)
    entered.release()
  }
  fixture.handle.server.on('request', observe)
  let req!: http.ClientRequest
  const response = new Promise<Response<{ error?: string }>>((resolve, reject) => {
    req = http.request(fixture.base + route, {
      method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': raw.length,
        'x-sakura-workspace': workspaceId, 'x-expert-test': marker,
      },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { data += chunk })
      res.on('error', reject)
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as { error?: string } }) }
        catch (error) { reject(error) }
      })
    })
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('Slow-body fixture timed out')))
    req.flushHeaders()
    req.write(raw.subarray(0, -1))
  })
  void response.catch(() => {}) // finish() still observes failures; cleanup must not leave an unhandled rejection.
  try {
    await Promise.race([entered.promise, response.then(() => { throw new Error('Request ended before the switch barrier') })])
  } catch (error) {
    fixture.handle.server.off('request', observe)
    req.destroy()
    throw error
  }
  return {
    finish() { req.end(raw.subarray(-1)); return response },
    async close() {
      fixture.handle.server.off('request', observe)
      req.destroy()
      await response.catch(() => {})
    },
  }
}

describe('expert session — offline REST integration', () => {
  it('enables without a task, stops future fan-out and reuses the same IDs and history on restart', async () => {
    const f = await boot()
    const started = await f.post<StartResult>('/api/experts/start')
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ expertMode: true, started: EXPERT_NAMES, reused: [], skipped: [], queued: false })
    expect(f.calls).toHaveLength(0)
    expect((await f.post('/api/message', { text: 'before stop' })).status).toBe(202)
    await f.settle()
    const before = await f.state()
    expectRecipients(f.calls, before.agents.map((agent) => agent.id))
    const team = experts(before)
    expect(team).toHaveLength(3)
    const stopped = await f.post('/api/experts/stop')
    expect(stopped).toEqual({ status: 200, body: { ok: true, stopped: true } })
    expect(await f.state()).toMatchObject({ expertMode: false, expertIds: before.expertIds })
    expect((await f.post('/api/experts/stop')).body).toMatchObject({ stopped: false })
    await f.post('/api/message', { text: 'main only while off' })
    await f.settle()
    expectRecipients(f.calls.filter((call) => call.input === 'main only while off'), [main(before).id])

    const restarted = await f.post<StartResult>('/api/experts/start')
    expect(restarted.status).toBe(200)
    expect(restarted.body).toMatchObject({ expertMode: true, started: [], reused: EXPERT_NAMES, skipped: [], queued: false })
    const after = await f.state()
    expect(experts(after).map((agent) => [agent.id, agent.sessionId])).toEqual(team.map((agent) => [agent.id, agent.sessionId]))
    expect(after.expertIds).toEqual(before.expertIds)
    await f.post('/api/message', { text: 'after restart' })
    await f.settle()
    expectRecipients(f.calls.filter((call) => call.input === 'after restart'), before.agents.map((agent) => agent.id))
    for (const agent of team) expect(await f.users(agent.sessionId)).toEqual(['before stop', 'after restart'])
    expect(await f.users(main(before).sessionId)).toEqual(['before stop', 'main only while off', 'after restart'])
  })

  it('repeated start and subset selection reuse members and deliver each requested task exactly once', async () => {
    const f = await boot()
    await f.post('/api/experts/start', { task: 'initial task' })
    await f.settle()
    const before = await f.state()
    const reviewer = experts(before).find((agent) => agent.expert === 'reviewer')!
    const idleRepeat = await f.post<StartResult>('/api/experts/start')
    expect(idleRepeat.body).toMatchObject({ started: [], reused: EXPERT_NAMES })
    expect(f.calls).toHaveLength(4)
    for (const task of ['subset opening', 'repeated subset opening']) {
      const response = await f.post<StartResult>('/api/experts/start', { experts: ['reviewer', 'reviewer'], task })
      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ started: [], reused: [reviewer.name], skipped: [] })
      await f.settle()
      expectRecipients(f.calls.filter((call) => call.input === task), [main(before).id, reviewer.id])
    }
    expect(await f.state()).toMatchObject({ expertMode: true, expertIds: [reviewer.id] })
    expect((await f.state()).agents.map((agent) => agent.id)).toEqual(before.agents.map((agent) => agent.id))
    await f.post('/api/message', { text: 'subset follow-up' })
    await f.settle()
    expectRecipients(f.calls.filter((call) => call.input === 'subset follow-up'), [main(before).id, reviewer.id])
  })

  it('keeps ordinary same-name members out of the team and rejects an entirely conflicting roster', async () => {
    const f = await boot()
    const ordinary = await f.post<{ agent: AgentRow }>('/api/agents', { name: '架构师' })
    expect(ordinary.status).toBe(200)
    const started = await f.post<StartResult>('/api/experts/start', { task: 'partial team task' })
    expect(started.status).toBe(200)
    expect(started.body).toMatchObject({ started: ['实现者', '审查者'], reused: [], skipped: ['架构师'] })
    await f.settle()
    const state = await f.state()
    expect(state.expertIds).not.toContain(ordinary.body.agent.id)
    expect(state.agents.find((agent) => agent.id === ordinary.body.agent.id)?.expert).toBeUndefined()
    expectRecipients(f.calls, [main(state).id, ...state.expertIds])

    expect((await f.post('/api/sessions')).status).toBe(200)
    for (const name of EXPERT_NAMES) expect((await f.post('/api/agents', { name })).status).toBe(200)
    const before = await f.state()
    const count = f.calls.length
    expect((await f.post('/api/experts/start', { task: 'must not run on conflicts' })).status).toBe(409)
    await f.settle()
    const after = await f.state()
    expect(after).toMatchObject({ expertMode: false, expertIds: [] })
    expect(after.agents).toEqual(before.agents)
    expect(f.calls).toHaveLength(count)
  })

  it('rejects malformed keys, tasks and unknown commands before changing the roster or sending anything', async () => {
    const f = await boot()
    const before = await f.state()
    for (const body of [
      { experts: ['architect', 'unknown-preset'], task: 'must not run' },
      { experts: [] }, { experts: 'reviewer' }, { experts: ['reviewer', 1] }, { experts: [null] },
      { task: '   ' }, { task: 123 }, { task: '/missing-offline-command unused' },
    ]) {
      expect((await f.post('/api/experts/start', body)).status, JSON.stringify(body)).toBe(400)
      expect(await f.state()).toMatchObject({ expertMode: false, expertIds: [], agents: before.agents })
      expect(f.calls).toHaveLength(0)
    }
  })

  it('expands opening and follow-up commands and mentions once for the main agent and each expert', async () => {
    const f = await boot()
    await fs.mkdir(path.join(f.cwd, '.sakura', 'commands'), { recursive: true })
    await fs.writeFile(path.join(f.cwd, '.sakura', 'commands', 'offline-review.md'), '---\ndescription: Offline review\n---\nReview $ARGUMENTS @context.txt')
    await fs.writeFile(path.join(f.cwd, 'context.txt'), 'OPENING_CONTEXT_SENTINEL')
    expect((await f.post('/api/experts/start', { task: '/offline-review opening' })).status).toBe(200)
    await f.settle()
    const ids = (await f.state()).agents.map((agent) => agent.id)
    const opening = f.calls.slice()
    expectRecipients(opening, ids)
    expect(new Set(opening.map((call) => call.input)).size).toBe(1)
    for (const call of opening) {
      expect(call.input).toContain('Review opening @context.txt')
      expect(call.input).toContain('OPENING_CONTEXT_SENTINEL')
      expect(call.input.split('<file path="context.txt">')).toHaveLength(2)
    }
    await fs.writeFile(path.join(f.cwd, 'context.txt'), 'FOLLOWUP_CONTEXT_SENTINEL')
    expect((await f.post('/api/message', { text: '/offline-review follow-up' })).status).toBe(202)
    await f.settle()
    const followup = f.calls.slice(opening.length)
    expectRecipients(followup, ids)
    expect(new Set(followup.map((call) => call.input)).size).toBe(1)
    for (const call of followup) {
      expect(call.input).toContain('Review follow-up @context.txt')
      expect(call.input).toContain('FOLLOWUP_CONTEXT_SENTINEL')
      expect(call.input).not.toContain('OPENING_CONTEXT_SENTINEL')
      expect(call.input.split('<file path="context.txt">')).toHaveLength(2)
    }
  })

  it('summarizes actual unique expert answers only into the main request, both before and after stop', async () => {
    const f = await boot()
    await f.post('/api/experts/start', { task: 'prepare unique evidence' })
    await f.settle()
    const before = await f.state()
    const completed = f.calls.filter((call) => call.expert)
    expect(completed).toHaveLength(3)
    for (const off of [false, true]) {
      if (off) expect((await f.post('/api/experts/stop')).status).toBe(200)
      const count = f.calls.length
      const response = await f.post('/api/experts/summarize')
      expect(response.status).toBe(202)
      await f.settle()
      const added = f.calls.slice(count)
      expectRecipients(added, [main(before).id])
      for (const expert of completed) {
        expect(added[0]!.input).toContain(expert.answer)
        expect(added[0]!.input).toContain(expert.name)
        expect(added[0]!.input).toContain(expert.id)
      }
      expect(f.calls.filter((call) => call.expert)).toHaveLength(3)
      expect((await f.state()).expertIds).toEqual(before.expertIds)
      expect((await f.users(main(before).sessionId)).at(-1)).toBe(added[0]!.input)
    }
  })

  it('does not summarize a failed expert\'s stale success and returns 409 for a failed-only active subset', async () => {
    const f = await boot({ beforeReply: (call) => {
      if (call.expert === 'reviewer' && call.input === 'second task') throw new Error('CURRENT_REVIEW_FAILURE')
    } })
    await f.post('/api/experts/start', { task: 'first task' })
    await f.settle()
    const oldReviewer = f.calls.find((call) => call.expert === 'reviewer')!
    await f.post('/api/message', { text: 'second task' })
    await f.settle()
    const reviewer = f.handle.harness.ctx.agents.get(oldReviewer.id)!
    expect(reviewer.status).toBe('error')
    expect(reviewer.result).toBe(oldReviewer.answer)
    const count = f.calls.length
    expect((await f.post('/api/experts/summarize')).status).toBe(202)
    await f.settle()
    const added = f.calls.slice(count)
    expect(added).toHaveLength(1)
    expect(added[0]!.role).toBe('main')
    expect(added[0]!.input).not.toContain(oldReviewer.answer)
    expect(added[0]!.input).toContain('CURRENT_REVIEW_FAILURE')
    for (const call of f.calls.filter((call) => call.expert && call.expert !== 'reviewer' && call.input === 'second task')) {
      expect(added[0]!.input).toContain(call.answer)
    }
    const afterSummary = f.calls.length
    expect((await f.post('/api/experts/start', { experts: ['reviewer'] })).status).toBe(200)
    expect((await f.post('/api/experts/summarize')).status).toBe(409)
    await f.settle()
    expect(f.calls).toHaveLength(afterSummary)
  })

  it('rejects unfinished summaries and switching while running; stop retains accepted and queued turns', async () => {
    const gate = barrier()
    const f = await boot({ beforeReply: async (call) => {
      if (call.input === 'held task') await gate.promise
    } })
    try {
      expect((await f.post('/api/experts/summarize')).status).toBe(409)
      expect((await f.post('/api/experts/start', { task: 'held task' })).status).toBe(200)
      await vi.waitFor(() => expect(f.calls).toHaveLength(4), { timeout: 5000, interval: 10 })
      const active = await f.state()
      expect((await f.post('/api/experts/summarize')).status).toBe(409)
      const queued = await f.post('/api/message', { text: 'accepted before stop' })
      expect(queued).toMatchObject({ status: 202, body: { queued: true } })
      expect((await f.post('/api/experts/stop')).status).toBe(200)
      expect(await f.state()).toMatchObject({ expertMode: false, expertIds: active.expertIds })
      expect(f.calls.every((call) => !call.signal.aborted)).toBe(true)
      expect((await f.post('/api/message', { text: 'accepted after stop' })).status).toBe(202)
      expect((await f.post('/api/sessions')).status).toBe(409)
      gate.release()
      await f.settle()
      expectRecipients(f.calls.filter((call) => call.input === 'held task'), active.agents.map((agent) => agent.id))
      expectRecipients(f.calls.filter((call) => call.input === 'accepted before stop'), active.agents.map((agent) => agent.id))
      expectRecipients(f.calls.filter((call) => call.input === 'accepted after stop'), [main(active).id])
      expect(f.calls).toHaveLength(9)
    } finally {
      gate.release()
      await f.settle()
    }
  })

  it('allows a remote viewer to read but forbids expert start, stop, summary and message writes', async () => {
    const f = await boot({ remote: true })
    const viewer = { authorization: `Bearer ${VIEWER}` }
    expect((await f.get('/api/auth', viewer)).body).toMatchObject({ remote: true, role: 'viewer', authenticated: true })
    expect((await f.state(viewer)).server.remote).toBe(true)
    expect((await f.post('/api/experts/start', { task: 'operator task' })).status).toBe(200)
    await f.settle()
    const before = await f.state(viewer)
    const count = f.calls.length
    for (const [route, body] of [
      ['/api/experts/start', { task: 'viewer must not start' }], ['/api/experts/stop', {}],
      ['/api/experts/summarize', {}], ['/api/message', { text: 'viewer must not send' }],
    ] as const) expect((await f.post(route, body, viewer)).status, route).toBe(403)
    await f.settle()
    expect(f.calls).toHaveLength(count)
    expect(await f.state(viewer)).toMatchObject({ expertMode: true, expertIds: before.expertIds, agents: before.agents })
  })

  it('clears the team on session switch and rejects all delayed old-session request bodies with 409', async () => {
    const f = await boot()
    for (const [route, body] of [
      ['/api/message', { text: 'STALE_MESSAGE' }], ['/api/experts/start', { task: 'STALE_OPENING' }],
      ['/api/experts/stop', {}], ['/api/experts/summarize', {}],
    ] as const) {
      expect((await f.post('/api/experts/start', { task: `old team ${route}` })).status).toBe(200)
      await f.settle()
      const old = await f.state()
      const pending = await slowPost(f, route, body, old.workspaceId)
      try {
        const switched = await f.post<{ sessionId: string }>('/api/sessions')
        expect(switched.status).toBe(200)
        const cleared = await f.state()
        expect(cleared).toMatchObject({ expertMode: false, expertIds: [], sessionId: switched.body.sessionId })
        expect(cleared.sessionId).not.toBe(old.sessionId)
        expect(cleared.workspaceId).toBe(old.workspaceId)
        expect(cleared.agents).toHaveLength(1)
        for (const id of old.expertIds) expect(f.handle.harness.ctx.agents.get(id)).toBeUndefined()

        // A new completed team makes stale stop/summary distinguishable from a harmless empty-team 409.
        expect((await f.post('/api/experts/start', { task: `new team ${route}` })).status).toBe(200)
        await f.settle()
        const current = await f.state()
        expect(current.expertIds.every((id) => !old.expertIds.includes(id))).toBe(true)
        const count = f.calls.length
        const rejected = await pending.finish()
        expect(rejected.status, route).toBe(409)
        expect(rejected.body.error).toMatch(/session.*changed/i)
        await f.settle()
        expect(f.calls).toHaveLength(count)
        expect(await f.state()).toMatchObject({ sessionId: current.sessionId, expertMode: true, expertIds: current.expertIds })
        expect(await f.users(current.sessionId!)).toEqual([`new team ${route}`])
      } finally { await pending.close() }
    }
  })
})
