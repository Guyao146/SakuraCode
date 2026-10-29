import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { WorkspaceMemoryStore, type WorkspaceMemoryService, type WorkspaceMemorySnapshot } from '../src/plugins/workspace-memory.js'
import { MockAdapter, text } from './helpers.js'
import type { ModelAdapter, LLMRequest } from '../src/core/types.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanup.length) await cleanup.pop()?.()
})
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-memory-'))
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return dir
}
async function boot(options: Partial<WebServerOptions> = {}): Promise<{ server: WebServerHandle; cwd: string }> {
  const cwd = options.cwd ?? await directory()
  const server = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), token: null, viewerToken: null,
    open: false, quiet: true, updatesAutoCheck: false, ...options })
  cleanup.push(() => server.close())
  return { server, cwd }
}
const post = (server: WebServerHandle, route: string, body: unknown, headers?: Record<string, string>) => fetch(server.url + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const memory = (server: WebServerHandle) => fetch(server.url + 'api/workspace/memory').then(response => response.json() as Promise<WorkspaceMemorySnapshot & { workspaceId: string }>)

describe('workspace memory API', () => {
  it('persists opt-in notes, keeps the live session, and clears content without deleting history or files', async () => {
    const { server, cwd } = await boot()
    const before = await memory(server)
    expect(before).toMatchObject({ enabled: true, content: '', revision: 0 })
    expect(before.path).toBe(path.join(cwd, '.sakura', 'workspace-memory.md'))
    expect((await post(server, 'api/workspace/memory', { enabled: true, content: 'LOCAL_FACT', revision: 0 })).status).toBe(200)
    await server.harness.run('first task')
    const main = server.harness.main()
    const session = await server.harness.ctx.sessions.open(main.sessionId)
    expect(session.events.filter(event => event.type === 'system/message').at(-1)?.payload).toMatchObject({ content: expect.stringContaining('LOCAL_FACT') })
    await fs.writeFile(path.join(cwd, 'keep.txt'), 'PROJECT_FILE')
    const revision = (await memory(server)).revision
    expect((await post(server, 'api/workspace/memory', { enabled: false, revision })).status).toBe(200)
    expect((await memory(server)).content).toBe('LOCAL_FACT')
    expect(server.harness.main()).toBe(main)
    expect((await post(server, 'api/workspace/memory', { content: '', revision: revision + 1 })).status).toBe(200)
    expect((await memory(server)).content).toBe('')
    expect((await fs.stat(session.file)).isFile()).toBe(true)
    expect(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8')).toBe('PROJECT_FILE')
    const state = await (await fetch(server.url + 'api/state')).json() as { workspaceMemory: Record<string, unknown> }
    expect(state.workspaceMemory).toMatchObject({ enabled: false, chars: 0, revision: revision + 2, updatedAt: expect.any(String) })
    expect(state.workspaceMemory).not.toHaveProperty('content')
  })

  it('rejects malformed input, stale versions and obsolete workspace identities without changes', async () => {
    const { server } = await boot()
    for (const body of [{ enabled: 'yes', revision: 0 }, { content: 7, revision: 0 }, { content: 'x'.repeat(16001), revision: 0 },
      { content: 'x\0y', revision: 0 }, { enabled: true }, { enabled: true, revision: -1 }]) {
      expect((await post(server, 'api/workspace/memory', body)).status).toBe(400)
    }
    expect((await post(server, 'api/workspace/memory', { enabled: true, revision: 0 }, { 'x-sakura-workspace': 'old-workspace' })).status).toBe(409)
    expect((await memory(server)).revision).toBe(0)
    expect((await post(server, 'api/workspace/memory', { enabled: true, content: 'keep', revision: 0 })).status).toBe(200)
    expect((await post(server, 'api/workspace/memory', { content: 'overwrite', revision: 0 })).status).toBe(409)
    expect((await memory(server)).content).toBe('keep')
  })

  it('keeps each workspace independent across switch, return, and host restart', async () => {
    const { server, cwd } = await boot({ onPersistSettings() {} })
    const other = await directory()
    await post(server, 'api/workspace/memory', { enabled: true, content: 'FIRST_WORKSPACE', revision: 0 })
    expect((await post(server, 'api/desktop/settings', { workspace: other })).status).toBe(200)
    expect(await memory(server)).toMatchObject({ enabled: true, content: '', revision: 0 })
    await post(server, 'api/workspace/memory', { content: 'SECOND_WORKSPACE', revision: 0 })
    expect((await post(server, 'api/desktop/settings', { workspace: cwd })).status).toBe(200)
    expect(await memory(server)).toMatchObject({ enabled: true, content: 'FIRST_WORKSPACE', revision: 1 })
    const restarted = await boot({ cwd })
    expect(await memory(restarted.server)).toMatchObject({ enabled: true, content: 'FIRST_WORKSPACE', revision: 1 })
    expect((await new WorkspaceMemoryStore(other).reload()).content).toBe('SECOND_WORKSPACE')
  })

  it('blocks edits while any collaboration agent is running but permits window controls', async () => {
    const started = barrier(), finish = barrier()
    const requests: LLMRequest[] = []
    const adapter: ModelAdapter = { id: 'paused-memory', defaultModel: 'memory-test',
      async *stream(request) { requests.push(request); started.release(); await finish.promise; yield* text('completed') } }
    const actions: string[] = []
    const { server } = await boot({ adapter, onWindowAction: action => actions.push(action) })
    await server.harness.ctx.get<WorkspaceMemoryService>('workspaceMemory').update({ enabled: false }, 0)
    const child = server.harness.ctx.agents.spawn({ name: 'busy collaborator', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    const turn = child.turn('work')
    await started.promise
    try {
      expect((await post(server, 'api/workspace/memory', { enabled: true, revision: 0 })).status).toBe(409)
      expect((await post(server, 'api/desktop/window', { action: 'minimize' })).status).toBe(200)
      expect(actions).toEqual(['minimize'])
      expect((await memory(server)).enabled).toBe(false)
      expect(requests[0]?.tools?.some(tool => tool.name === 'memory_write')).toBe(false)
    } finally { finish.release(); await turn }
  })

  it('excludes competing settings/deletions while a memory save is awaiting storage', async () => {
    const actions: string[] = []
    const { server } = await boot({ onPersistSettings() {}, onWindowAction: action => actions.push(action) })
    const history = await server.harness.ctx.sessions.create()
    const service = server.harness.ctx.get<WorkspaceMemoryService>('workspaceMemory')
    const entered = barrier(), release = barrier()
    const update = service.update.bind(service)
    vi.spyOn(service, 'update').mockImplementation(async (...args) => { entered.release(); await release.promise; return update(...args) })
    const saving = post(server, 'api/workspace/memory', { enabled: true, content: 'saved', revision: 0 })
    await entered.promise
    try {
      expect((await post(server, 'api/workspace/memory', { content: 'competing', revision: 0 })).status).toBe(409)
      expect((await post(server, 'api/desktop/settings', {})).status).toBe(409)
      expect((await fetch(server.url + `api/sessions/${history.id}`, { method: 'DELETE' })).status).toBe(409)
      expect((await post(server, 'api/message', { text: 'must wait' })).status).toBe(409)
      expect((await post(server, 'api/desktop/window', { action: 'minimize' })).status).toBe(200)
      expect((await post(server, 'api/desktop/window', { action: 'close' })).status).toBe(200)
      expect(actions).toEqual(['minimize', 'close'])
    } finally { release.release() }
    expect((await saving).status).toBe(200)
    expect((await memory(server)).content).toBe('saved')
  })

  it('rejects a slow-body edit from the previous workspace instead of writing to the next one', async () => {
    const { server } = await boot({ onPersistSettings() {} })
    const other = await directory()
    const request = http.request(server.url + 'api/workspace/memory', { method: 'POST', headers: { 'content-type': 'application/json' } })
    request.flushHeaders()
    request.write('{"content":"OLD_DELAYED_WRITE",')
    const response = new Promise<number>((resolve, reject) => { request.on('response', res => { res.resume(); resolve(res.statusCode!) }); request.on('error', reject) })
    // A control GET on the same event loop ensures the slow request has entered its body reader.
    await fetch(server.url + 'api/state')
    expect((await post(server, 'api/desktop/settings', { workspace: other })).status).toBe(200)
    request.end('"enabled":true,"revision":0}')
    expect(await response).toBe(503)
    expect(await memory(server)).toMatchObject({ enabled: true, content: '', revision: 0 })
  })

  it('hides memory contents and controls from remote operators and viewers', async () => {
    const cwd = await directory()
    await new WorkspaceMemoryStore(cwd).update({ enabled: true, content: 'PRIVATE_LOCAL_NOTES' }, 0)
    const operator = 'memory-operator-' + 'a'.repeat(40)
    const viewer = 'memory-viewer-' + 'b'.repeat(40)
    const { server } = await boot({ cwd, host: '0.0.0.0', token: operator, viewerToken: viewer })
    expect((await fetch(server.url + 'api/workspace/memory')).status).toBe(401)
    expect((await fetch(server.url + 'api/workspace/memory', { headers: { authorization: 'Bearer ' + operator } })).status).toBe(404)
    expect((await post(server, 'api/workspace/memory', { enabled: false, revision: 1 }, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    const state = await (await fetch(server.url + 'api/state', { headers: { authorization: 'Bearer ' + viewer } })).text()
    expect(state).not.toContain('PRIVATE_LOCAL_NOTES')
    expect((await new WorkspaceMemoryStore(cwd).reload()).enabled).toBe(true)
    expect((await post(server, 'api/desktop/window', { action: 'close' }, { authorization: 'Bearer ' + operator })).status).toBe(404)
    expect((await post(server, 'api/desktop/window', { action: 'close' }, { authorization: 'Bearer ' + viewer })).status).toBe(403)
  })
})

describe('desktop window API', () => {
  it('only exposes whitelisted actions through the private local launcher bridge', async () => {
    const actions: string[] = []
    const { server } = await boot({ onWindowAction: action => actions.push(action) })
    for (const action of ['minimize', 'maximize', 'drag', 'close']) expect((await post(server, 'api/desktop/window', { action })).status).toBe(200)
    expect(actions).toEqual(['minimize', 'maximize', 'drag', 'close'])
    for (const action of ['shell', ['close'], {}, null]) expect((await post(server, 'api/desktop/window', { action })).status).toBe(400)
    expect((await post(server, 'api/desktop/window', { action: 'close' }, { origin: 'http://evil.test' })).status).toBe(403)
    const regular = await boot()
    expect((await post(regular.server, 'api/desktop/window', { action: 'close' })).status).toBe(404)
    expect((await (await fetch(regular.server.url + 'api/state')).json() as { desktopWindow: boolean }).desktopWindow).toBe(false)
  })
})