/** Session deletion: real storage, loopback REST/SSE, and deterministic I/O barriers. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../src/core/session.js'
import type { ModelAdapter } from '../src/core/types.js'
import type { CompactionService } from '../src/plugins/compaction.js'
import type { InteractionService } from '../src/plugins/ask-user.js'
import type { PlanService } from '../src/tools/plan.js'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length) await cleanups.pop()?.()
})

function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-session-delete-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const handle = await runWebServer({
    cwd, sessionDir: 'sessions', jobsDir: 'jobs', open: false, quiet: true,
    token: null, viewerToken: null, updatesAutoCheck: false,
    adapter: new MockAdapter([text('session deletion fixture answer')]),
    config: { pluginsDir: 'no-plugins', bundles: [], plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } },
    ...extra,
  })
  cleanups.push(() => handle.close())
  return { handle, cwd, base: handle.url.replace(/\/$/, '') }
}

interface State {
  workspaceId: string
  revision: number
  sessionId: string | null
  busy: boolean
  model: string
  thinking: string
  approvalMode: string
  contextTokens: number
  todos: unknown[]
  pendingRequests: Array<{ type: string; id: string }>
  sessions: Array<{ id: string; deleteBlocked: 'running' | 'bound' | 'compacting' | 'pending' | null }>
  agents: Array<{ id: string; status: string }>
}

async function state(base: string): Promise<State> {
  const response = await fetch(base + '/api/state')
  expect(response.status).toBe(200)
  return response.json() as Promise<State>
}

const post = (base: string, route: string, body: unknown = {}) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const remove = (base: string, id: string, workspaceId?: string) => fetch(base + '/api/sessions/' + encodeURIComponent(id), {
  method: 'DELETE', ...(workspaceId ? { headers: { 'x-sakura-workspace': workspaceId } } : {}),
})

async function collect(base: string) {
  const controller = new AbortController()
  const response = await fetch(base + '/api/events', { signal: controller.signal })
  expect(response.status).toBe(200)
  const frames: Array<Record<string, any>> = []
  const reader = response.body!.getReader()
  const reading = (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (data) frames.push(JSON.parse(data.slice(6)))
      }
    }
  })()
  cleanups.push(async () => { controller.abort(); await reading.catch(() => {}) })
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'state')).toBe(true))
  return frames
}

function pausedAdapter() {
  const started = barrier()
  const finish = barrier()
  const signals: AbortSignal[] = []
  const adapter: ModelAdapter = {
    id: 'session-delete-paused', defaultModel: 'delete-model',
    async *stream(request) {
      if (request.signal) signals.push(request.signal)
      yield { type: 'text', delta: 'started, ' }
      started.release()
      await new Promise<void>(resolve => {
        const done = () => { request.signal?.removeEventListener('abort', done); resolve() }
        void finish.promise.then(done)
        if (request.signal?.aborted) done()
        else request.signal?.addEventListener('abort', done, { once: true })
      })
      request.signal?.throwIfAborted()
      yield* text('finished normally')
    },
  }
  return { adapter, signals, started: started.promise, release: finish.release }
}

describe('web server — safe session deletion', () => {
  it.each([6000, 4190, 6679])('rebinds an automatic port if the OS selects browser-restricted %s', async restrictedPort => {
    const originalAddress = http.Server.prototype.address
    let automatic: http.Server | undefined
    let calls = 0
    const address = vi.spyOn(http.Server.prototype, 'address').mockImplementation(function (this: http.Server) {
      const actual = originalAddress.call(this)
      if (actual && typeof actual === 'object') {
        automatic ??= this
        if (this === automatic && ++calls === 1) return { ...actual, port: restrictedPort }
      }
      return actual
    })
    try {
      const { base, handle } = await boot()
      expect(calls).toBeGreaterThanOrEqual(2)
      expect(handle.port).not.toBe(restrictedPort)
      expect((await fetch(base + '/api/state')).status).toBe(200)
    } finally { address.mockRestore() }
  })

  it('deletes the current idle session, broadcasts once to each client, and creates the next session lazily', async () => {
    const { handle, base, cwd } = await boot({ model: 'mock-model' })
    await handle.harness.run('delete this current session')
    const originalMain = handle.harness.main()
    const session = await handle.harness.ctx.sessions.open(originalMain.sessionId)
    const kept = await handle.harness.ctx.sessions.create()
    await fs.mkdir(path.join(session.dir, 'attachments'))
    await fs.writeFile(path.join(session.dir, 'attachments', 'saved.txt'), 'attachment')
    await fs.writeFile(path.join(cwd, 'project.txt'), 'project files must survive')
    const before = await state(base)
    expect(before.contextTokens).toBeGreaterThan(0)
    expect(before.model).toBe('mock-model')
    const clearAllows = vi.spyOn(handle.harness.ctx.approval.engine, 'clearSessionAllows')
    const todos = handle.harness.ctx.peek<{ todos: unknown[] }>('todos')!
    todos.todos = [{ content: 'old todo', status: 'pending', priority: 'high' }]
    const first = await collect(base)
    const second = await collect(base)
    const response = await remove(base, session.id, before.workspaceId)
    expect(response.status).toBe(200)
    const result = await response.json() as { revision: number }
    expect(result).toMatchObject({ ok: true, deletedId: session.id, sessionId: null, workspaceId: before.workspaceId, revision: expect.any(Number) })
    const after = await state(base)
    expect(after).toMatchObject({ sessionId: null, busy: false, model: before.model, contextTokens: 0, todos: [], pendingRequests: [] })
    expect(after.sessions.map(row => row.id)).toEqual([kept.id])
    expect(handle.harness.main().id).not.toBe(originalMain.id)
    expect(clearAllows).toHaveBeenCalledOnce()
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(handle.harness.ctx.sessions.open(session.id)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(session.append({ type: 'session/note', payload: { late: true } })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(cwd, 'project.txt'), 'utf8')).toBe('project files must survive')
    expect((await fetch(base + `/api/sessions/${session.id}/records`)).status).toBe(404)
    expect((await fetch(base + `/api/sessions/${session.id}/export`)).status).toBe(404)
    for (const frames of [first, second]) {
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'session/deleted')).toHaveLength(1))
      expect(frames.find(frame => frame.type === 'session/deleted')).toMatchObject({ deletedId: session.id, sessionId: null, workspaceId: before.workspaceId })
      expect(frames.filter(frame => frame.type === 'state' && frame.state.revision >= result.revision)
        .some(frame => frame.state.sessions.some((row: { id: string }) => row.id === session.id))).toBe(false)
    }
    expect((await post(base, '/api/message', { text: 'a new conversation' })).status).toBe(202)
    await handle.harness.main().wait()
    const next = await state(base)
    expect(next.sessionId).toBeTruthy()
    expect(next.sessionId).not.toBe(session.id)
    expect(next.sessions).toHaveLength(2)
  })

  it('deletes unrelated history even while the live session is running, without touching the roster or task', async () => {
    const paused = pausedAdapter()
    const { handle, base } = await boot({ adapter: paused.adapter })
    const history = await handle.harness.ctx.sessions.create()
    await history.append({ type: 'user/message', payload: { content: 'old history' } })
    const main = handle.harness.main()
    const turn = main.turn('continue live work')
    await paused.started
    try {
      expect((await state(base)).sessions.find(row => row.id === history.id)?.deleteBlocked).toBeNull()
      const response = await remove(base, history.id)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ deletedId: history.id, sessionId: main.sessionId })
      expect(handle.harness.main()).toBe(main)
      expect(main.status).toBe('running')
      expect(paused.signals[0]?.aborted).toBe(false)
      expect((await state(base)).busy).toBe(true)
    } finally { paused.release(); await turn }
    expect(main.result).toContain('finished normally')
  })

  it.each(['main', 'collaboration', 'parent history'] as const)('protects a session used by a running %s task', async role => {
    const paused = pausedAdapter()
    const { handle, base } = await boot({ adapter: paused.adapter })
    const target = await handle.harness.ctx.sessions.create()
    const mainSession = role === 'parent history' ? await handle.harness.ctx.sessions.create() : target
    const main = handle.harness.main({ resumeSessionId: mainSession.id })
    const agent = role === 'main' ? main : handle.harness.ctx.agents.spawn({
      name: 'collaborator', seed: '', autoStart: false, persistentSession: true,
      meta: { role: 'sub', parentSession: target.id },
    })
    const turn = agent.turn('protected work')
    await paused.started
    try {
      const before = await state(base)
      expect(before.sessions.find(row => row.id === target.id)?.deleteBlocked).toBe('running')
      const response = await remove(base, target.id)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/running/) })
      expect(handle.harness.main()).toBe(main)
      expect(agent.status).toBe('running')
      expect(paused.signals[0]?.aborted).toBe(false)
      expect((await fs.stat(target.file)).isFile()).toBe(true)
      if (role === 'main') {
        expect((await post(base, '/api/message', { text: 'queued follow-up' })).status).toBe(202)
        expect((await remove(base, target.id)).status).toBe(409)
      }
    } finally { paused.release(); await agent.wait(); await turn }
    expect(agent.error).toBeUndefined()
  })

  it('protects an idle collaboration binding until a main-session switch releases the roster', async () => {
    const { handle, base } = await boot()
    const session = await handle.harness.ctx.sessions.create()
    const child = handle.harness.ctx.agents.spawn({ name: 'idle child', seed: '', autoStart: false,
      persistentSession: true, resumeSessionId: session.id, meta: { role: 'sub' } })
    expect(child.status).toBe('idle')
    expect((await state(base)).sessions.find(row => row.id === session.id)?.deleteBlocked).toBe('bound')
    expect((await remove(base, session.id)).status).toBe(409)
    expect((await post(base, '/api/sessions')).status).toBe(200)
    const main = handle.harness.main()
    expect((await remove(base, session.id)).status).toBe(200)
    expect(handle.harness.main()).toBe(main)
  })

  it.each(['approval', 'question', 'plan'] as const)('protects an idle session with a pending %s', async kind => {
    const { handle, base } = await boot({ approvalMode: 'default' })
    await handle.harness.run('pending interaction context')
    const ctx = handle.harness.ctx
    const id = handle.harness.main().sessionId
    const answer = kind === 'approval'
      ? ctx.approval.check({ tool: ctx.tools.get('write')!, args: { file_path: 'x', content: 'x' }, agentId: handle.harness.main().id })
      : kind === 'question'
        ? ctx.peek<InteractionService>('interaction')!.ask({ question: 'which scope?', options: ['all', 'core'] })
        : ctx.peek<PlanService>('plan')!.propose('review first')
    const before = await state(base)
    expect(before.busy).toBe(false)
    expect(before.sessions.find(row => row.id === id)?.deleteBlocked).toBe('pending')
    expect((await remove(base, id)).status).toBe(409)
    const pending = before.pendingRequests[0]!
    const route = kind === 'approval' ? 'approvals' : kind === 'question' ? 'questions' : 'plans'
    const body = kind === 'approval' ? { allow: false } : kind === 'question' ? { answer: 'core' } : { decision: 'reject' }
    expect((await post(base, `/api/${route}/${pending.id}`, body)).status).toBe(200)
    await answer
    expect((await remove(base, id)).status).toBe(200)
  })

  it.each(['manual', 'auto'] as const)('protects %s compaction from its initial disk read until the summary is saved', async kind => {
    const paused = pausedAdapter()
    const { handle, base } = await boot({ adapter: paused.adapter,
      config: { pluginsDir: 'no-plugins', bundles: [], plugins: { 'core-compaction': { config: { auto: kind === 'auto' ? 1 : 0, autoTokens: 0 } } } } })
    const session = await handle.harness.ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'summarize this history' } })
    const compaction = handle.harness.ctx.get<CompactionService>('compaction')
    const frames = await collect(base)
    const attempt = kind === 'manual' ? compaction.compact(session.id) : compaction.maybeAutoCompact(session.id)
    expect(compaction.isCompacting(session.id)).toBe(true)
    await paused.started
    try {
      expect((await state(base)).sessions.find(row => row.id === session.id)?.deleteBlocked).toBe('compacting')
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'state' &&
        frame.state.sessions.some((row: State['sessions'][number]) => row.id === session.id && row.deleteBlocked === 'compacting'))).toBe(true))
      expect((await remove(base, session.id)).status).toBe(409)
    } finally { paused.release(); await attempt }
    expect(compaction.isCompacting(session.id)).toBe(false)
    expect(session.events.some(event => event.type === 'session/note' && event.payload.note === 'compaction')).toBe(true)
    await vi.waitFor(() => {
      const latest = frames.filter(frame => frame.type === 'state').at(-1)!.state as State
      expect(latest.sessions.find(row => row.id === session.id)?.deleteBlocked).toBeNull()
    })
    expect(frames.filter(frame => frame.type === 'compaction/status').at(-1)).toMatchObject({ sessionId: session.id, active: false })
    expect((await remove(base, session.id)).status).toBe(200)
  })

  it('excludes concurrent deletion, switching, settings and writes, but reports temporarily locked records as 409', async () => {
    const { handle, base, cwd } = await boot({ onPersistSettings() {} })
    await handle.harness.run('hold removal on disk')
    const session = await handle.harness.ctx.sessions.open(handle.harness.main().sessionId)
    const entered = barrier()
    const finish = barrier()
    const originalRm = fs.rm.bind(fs)
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === session.dir) { entered.release(); await finish.promise }
      return originalRm(target, options)
    })
    const deleting = remove(base, session.id)
    await entered.promise
    try {
      expect((await remove(base, session.id)).status).toBe(409)
      expect((await post(base, '/api/sessions')).status).toBe(409)
      expect((await post(base, '/api/desktop/settings', { workspace: cwd })).status).toBe(409)
      expect((await post(base, '/api/message', { text: 'must not start' })).status).toBe(409)
      expect((await fetch(base + `/api/sessions/${session.id}/records`)).status).toBe(409)
      expect((await fetch(base + `/api/sessions/${session.id}/export`)).status).toBe(409)
      expect(handle.harness.main().sessionId).toBe(session.id)
    } finally { finish.release(); await deleting; spy.mockRestore() }
    expect((await deleting).status).toBe(200)
    expect((await state(base)).sessionId).toBeNull()
  })

  it('rejects deletion during a session switch without silently cancelling either conversation', async () => {
    const { handle, base } = await boot()
    await handle.harness.run('old current')
    const id = handle.harness.main().sessionId
    const target = await handle.harness.ctx.sessions.create()
    const entered = barrier()
    const finish = barrier()
    const originalOpen = handle.harness.ctx.sessions.open.bind(handle.harness.ctx.sessions)
    const spy = vi.spyOn(handle.harness.ctx.sessions, 'open').mockImplementation(async sid => {
      if (sid === target.id) { entered.release(); await finish.promise }
      return originalOpen(sid)
    })
    const switching = post(base, '/api/sessions', { id: target.id })
    await entered.promise
    try {
      expect((await remove(base, id)).status).toBe(409)
      expect((await remove(base, target.id)).status).toBe(409)
      expect(handle.harness.main().sessionId).toBe(id)
    } finally { finish.release(); await switching; spy.mockRestore() }
    expect((await switching).status).toBe(200)
    expect((await state(base)).sessionId).toBe(target.id)
    expect((await remove(base, id)).status).toBe(200)
  })

  it('discards a disk listing captured before deletion instead of stamping it with the new revision', async () => {
    const { handle, base } = await boot()
    const session = await handle.harness.ctx.sessions.create()
    const entered = barrier()
    const finish = barrier()
    const originalList = handle.harness.ctx.sessions.list.bind(handle.harness.ctx.sessions)
    const spy = vi.spyOn(handle.harness.ctx.sessions, 'list').mockImplementationOnce(async () => {
      const rows = await originalList()
      entered.release()
      await finish.promise
      return rows
    })
    const reading = fetch(base + '/api/state')
    await entered.promise
    try {
      expect((await remove(base, session.id)).status).toBe(200)
    } finally { finish.release() }
    const response = await reading
    spy.mockRestore()
    expect(response.status).toBe(200)
    expect((await response.json() as State).sessions.some(row => row.id === session.id)).toBe(false)
  })

  it('bounds state-snapshot retries under sustained revision changes and recovers on the next read', async () => {
    const { handle, base } = await boot()
    await state(base) // Settle the initial main-agent spawn and its background snapshot first.
    const originalList = handle.harness.ctx.sessions.list.bind(handle.harness.ctx.sessions)
    let attempts = 0
    const spy = vi.spyOn(handle.harness.ctx.sessions, 'list').mockImplementation(async () => {
      const rows = await originalList()
      if (++attempts <= 8) handle.harness.ctx.emit('ui/text', { delta: 'snapshot churn', main: true })
      return rows
    })
    try {
      const response = await fetch(base + '/api/state')
      expect(response.status).toBe(503)
      expect(attempts).toBeLessThanOrEqual(5)
    } finally { spy.mockRestore() }
    expect((await fetch(base + '/api/state')).status).toBe(200)
  })

  it('batch-deletes idle selected histories and the current conversation, keeping unselected history and project files', async () => {
    const { handle, base, cwd } = await boot()
    await handle.harness.run('current batch target')
    const current = handle.harness.main().sessionId
    const history = await handle.harness.ctx.sessions.create()
    const kept = await handle.harness.ctx.sessions.create()
    await fs.writeFile(path.join(cwd, 'project.txt'), 'preserve project')
    const before = await state(base)
    const response = await fetch(base + '/api/sessions/batch-delete', { method: 'POST',
      headers: { 'x-sakura-workspace': before.workspaceId }, body: JSON.stringify({ ids: [history.id, current, history.id] }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, deletedIds: [history.id, current], failed: [], sessionId: null })
    expect((await state(base)).sessions.map(s => s.id)).toEqual([kept.id])
    expect(await fs.readFile(path.join(cwd, 'project.txt'), 'utf8')).toBe('preserve project')
  })

  it('preflights every selected session and rejects blocked, missing, unsafe or stale batches without partial deletion', async () => {
    const { handle, base } = await boot()
    const history = await handle.harness.ctx.sessions.create()
    const bound = await handle.harness.ctx.sessions.create()
    handle.harness.ctx.agents.spawn({ name: 'batch-bound', seed: '', autoStart: false, persistentSession: true,
      resumeSessionId: bound.id, meta: { role: 'sub' } })
    expect((await post(base, '/api/sessions/batch-delete', { ids: [history.id, bound.id] })).status).toBe(409)
    expect((await post(base, '/api/sessions/batch-delete', { ids: [history.id, 'missing'] })).status).toBe(404)
    for (const ids of [[], ['../unsafe'], ['CON'], Array(101).fill(history.id), 'not-array']) {
      expect((await post(base, '/api/sessions/batch-delete', { ids })).status).toBe(400)
    }
    expect((await fetch(base + '/api/sessions/batch-delete', { method: 'POST', headers: { 'x-sakura-workspace': 'old' },
      body: JSON.stringify({ ids: [history.id] }) })).status).toBe(409)
    expect((await fs.stat(history.file)).isFile()).toBe(true)
  })

  it('reports partial disk failures in a batch instead of claiming success or resurrecting deleted sessions', async () => {
    const { handle, base } = await boot()
    const first = await handle.harness.ctx.sessions.create()
    const second = await handle.harness.ctx.sessions.create()
    const original = handle.harness.ctx.sessions.delete.bind(handle.harness.ctx.sessions)
    vi.spyOn(handle.harness.ctx.sessions, 'delete').mockImplementation(async (id, guard) => {
      if (id === second.id) throw Object.assign(new Error('disk-denied'), { code: 'EACCES' })
      await original(id, guard)
    })
    const response = await post(base, '/api/sessions/batch-delete', { ids: [first.id, second.id] })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: false, deletedIds: [first.id], failed: [{ id: second.id }] })
    expect((await state(base)).sessions.map(s => s.id)).toEqual([second.id])
  })

  it('holds the batch write gate during preflight and rejects a session bound by an agent before removal', async () => {
    const { handle, base } = await boot({ onPersistSettings() {} })
    const main = handle.harness.main()
    const selected = await handle.harness.ctx.sessions.create()
    const finish = barrier(), started = barrier()
    const original = handle.harness.ctx.sessions.validateDeletion.bind(handle.harness.ctx.sessions)
    vi.spyOn(handle.harness.ctx.sessions, 'validateDeletion').mockImplementation(async id => {
      await original(id); started.release(); await finish.promise
    })
    const request = post(base, '/api/sessions/batch-delete', { ids: [selected.id] })
    try {
      await started.promise
      for (const route of ['/api/sessions', '/api/message', '/api/desktop/settings']) {
        expect((await post(base, route, { text: 'must not interleave' })).status, route).toBe(409)
      }
      handle.harness.ctx.agents.spawn({ name: 'late-owner', seed: '', autoStart: false, persistentSession: true,
        resumeSessionId: selected.id, meta: { role: 'sub' } })
    } finally { finish.release() }
    expect((await request).status).toBe(409)
    expect((await fs.stat(selected.file)).isFile()).toBe(true)
    expect(handle.harness.main()).toBe(main)
  })

  it('rejects missing and unsafe IDs and refuses to follow a session junction', async () => {
    const { handle, base, cwd } = await boot()
    expect((await remove(base, 'missing')).status).toBe(404)
    for (const encoded of ['a%2Fb', 'a%5Cb', 'a%3Astream', '%00', '%E0%A4%A', 'CON.txt', 'a..b']) {
      expect((await fetch(base + '/api/sessions/' + encoded, { method: 'DELETE' })).status, encoded).toBe(400)
    }
    const outside = path.join(cwd, 'outside')
    const session = new Session('outside', outside)
    await session.append({ type: 'user/message', payload: { content: 'outside sentinel' } })
    await fs.mkdir(path.join(cwd, 'sessions'), { recursive: true })
    await fs.symlink(outside, path.join(cwd, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await remove(base, 'linked')).status).toBe(400)
    expect(await fs.readFile(session.file, 'utf8')).toContain('outside sentinel')
    expect((await handle.harness.ctx.sessions.list()).some(row => row.id === 'linked')).toBe(false)
  })

  it('rejects stale workspace deletion and isolates identical IDs on different storage roots', async () => {
    const { base, cwd } = await boot({ onPersistSettings() {} })
    const other = path.join(cwd, 'other-workspace')
    await fs.mkdir(other)
    const first = new Session('same-id', path.join(cwd, 'sessions', 'same-id'))
    const second = new Session('same-id', path.join(other, 'sessions', 'same-id'))
    await first.append({ type: 'user/message', payload: { content: 'first workspace sentinel' } })
    await second.append({ type: 'user/message', payload: { content: 'second workspace sentinel' } })
    const before = await state(base)
    expect((await post(base, '/api/desktop/settings', { workspace: other })).status).toBe(200)
    const after = await state(base)
    expect(after.workspaceId).not.toBe(before.workspaceId)
    expect((await remove(base, second.id, before.workspaceId)).status).toBe(409)
    expect(await fs.readFile(second.file, 'utf8')).toContain('second workspace sentinel')
    expect((await remove(base, second.id, after.workspaceId)).status).toBe(200)
    expect(await fs.readFile(first.file, 'utf8')).toContain('first workspace sentinel')
    await expect(fs.stat(second.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not return records from a workspace that remounted while a disk read was pending', async () => {
    const { handle, base, cwd } = await boot({ onPersistSettings() {} })
    const other = path.join(cwd, 'other-workspace')
    await fs.mkdir(other)
    const session = await handle.harness.ctx.sessions.create()
    await state(base)
    const entered = barrier()
    const finish = barrier()
    const originalOpen = handle.harness.ctx.sessions.open.bind(handle.harness.ctx.sessions)
    let intercepted = false
    const spy = vi.spyOn(handle.harness.ctx.sessions, 'open').mockImplementation(async id => {
      const opened = await originalOpen(id)
      // Background state refreshes may also open the current main session;
      // the I/O barrier belongs only to this records request, not those reads.
      if (id !== session.id || intercepted) return opened
      intercepted = true
      entered.release()
      await finish.promise
      return opened
    })
    const reading = fetch(base + `/api/sessions/${session.id}/records`)
    await entered.promise
    try {
      expect((await post(base, '/api/desktop/settings', { workspace: other })).status).toBe(200)
    } finally { finish.release() }
    const response = await reading
    spy.mockRestore()
    expect(response.status).toBe(503)
    expect((await fs.stat(session.file)).isFile()).toBe(true)
  })

  it('restores usable storage and the live session after a filesystem failure, without broadcasting deletion', async () => {
    const { handle, base } = await boot()
    await handle.harness.run('retry failed removal')
    const main = handle.harness.main()
    const session = await handle.harness.ctx.sessions.open(main.sessionId)
    const frames = await collect(base)
    const spy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('DELETE_DISK_DENIED'), { code: 'EACCES' }))
    try {
      const response = await remove(base, session.id)
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: 'DELETE_DISK_DENIED' })
    } finally { spy.mockRestore() }
    expect(handle.harness.main()).toBe(main)
    expect((await state(base)).sessionId).toBe(session.id)
    expect((await fetch(base + `/api/sessions/${session.id}/records`)).status).toBe(200)
    expect(frames.some(frame => frame.type === 'session/deleted')).toBe(false)
    await session.append({ type: 'session/note', payload: { recovered: true } })
    expect((await remove(base, session.id)).status).toBe(200)
  })

  it.each([
    ['/api/message', { text: 'must not be sent to a new conversation' }],
    ['/api/approvals/obsolete', { allow: true, always: true }],
    ['/api/questions/obsolete', { answer: 'stale answer' }],
    ['/api/plans/obsolete', { decision: 'approve' }],
    ['/api/settings', { thinking: 'high', approvalMode: 'yolo' }],
  ])('rejects a delayed %s body after current-session deletion instead of acting on the blank session', async (route, body) => {
    const { handle, base } = await boot()
    await handle.harness.run('old session')
    const before = await state(base)
    const entered = barrier()
    const marker = 'delayed-message'
    const onRequest = (req: http.IncomingMessage) => { if (req.headers['x-delete-test'] === marker) entered.release() }
    handle.server.on('request', onRequest)
    const raw = JSON.stringify(body)
    let request!: http.ClientRequest
    const reading = new Promise<number>((resolve, reject) => {
      request = http.request(base + route, { method: 'POST', headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
        'x-sakura-workspace': before.workspaceId, 'x-delete-test': marker,
      } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode ?? 0)) })
      request.on('error', reject)
      request.write(raw.slice(0, 4))
    })
    try {
      await entered.promise
      expect((await remove(base, before.sessionId!)).status).toBe(200)
      request.end(raw.slice(4))
      expect(await reading).toBe(409)
      expect(await state(base)).toMatchObject({ sessionId: null, thinking: before.thinking, approvalMode: before.approvalMode })
    } finally { request.destroy(); handle.server.off('request', onRequest) }
  })
})