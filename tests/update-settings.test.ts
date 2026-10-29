import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { DEFAULT_UPDATES_URL, type UpdateInfo, type UpdateSettings } from '../src/updates.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.unstubAllEnvs() })
const source = 'https://updates.example.test/latest.json'
const post = (server: WebServerHandle, route: string, body: unknown) => fetch(server.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
async function boot(options: Partial<Parameters<typeof runWebServer>[0]> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-updates-preferences-'))
  const server = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), quiet: true, open: false, token: null, viewerToken: null, updatesAutoCheck: false, ...options })
  cleanups.push(async () => { await server.close(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
  return server
}
interface Snapshot { workspaceId: string; sessionId: string | null; update?: UpdateInfo; desktop: { updates: UpdateSettings; appearance: unknown } }
const json = async <T = Snapshot>(server: WebServerHandle, route: string): Promise<T> => (await (await fetch(server.url + route)).json()) as T

describe('app-scoped update settings', () => {
  it('applies an explicit source without account credentials and keeps workspace data and preferences independent', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ tag_name: 'v99.0.0' })))
    const persisted: UpdateSettings[] = []
    const server = await boot({ updatesFetch: fetcher, onPersistSettings() {}, onPersistUpdates: async value => { persisted.push(value) } })
    const before = await json(server, 'api/state')
    expect(await json<UpdateSettings>(server, 'api/updates/settings')).toEqual({ feedUrl: '', autoCheck: true })
    expect((await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })).status).toBe(200)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await post(server, 'api/updates/check', {})).status).toBe(200)
    expect(fetcher.mock.calls[0]![0]).toBe(source)
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has('authorization')).toBe(false)
    expect(persisted).toEqual([{ feedUrl: source, autoCheck: false }])
    const after = await json(server, 'api/state')
    expect(after.workspaceId).toBe(before.workspaceId); expect(after.sessionId).toBe(before.sessionId)
    expect(after.desktop.updates).toEqual({ feedUrl: source, autoCheck: false })
    expect(after.desktop.appearance).toEqual(before.desktop.appearance)
  })

  it('preserves the old source, cached result and fields on failed disk save, then accepts an explicit retry', async () => {
    const persist = vi.fn<(value: UpdateSettings) => Promise<void>>().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ tag_name: 'v99.0.0' })))
    const server = await boot({ updatesFetch: fetcher, onPersistUpdates: persist })
    await post(server, 'api/updates/check', {})
    const original = (await json(server, 'api/state')).update
    const candidate = { feedUrl: source, autoCheck: false }
    expect((await post(server, 'api/updates/settings', candidate)).status).toBe(500)
    expect(await json<UpdateSettings>(server, 'api/updates/settings')).toEqual({ feedUrl: '', autoCheck: true })
    expect((await json(server, 'api/state')).update).toEqual(original)
    expect((await post(server, 'api/updates/settings', candidate)).status).toBe(200)
    expect((await json(server, 'api/state')).update).toBeUndefined()
  })

  it('locks a source save during a check and a check during an acknowledged preference save', async () => {
    let releaseCheck!: (response: Response) => void, releaseSave!: () => void
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { releaseCheck = resolve }))
    const persist = vi.fn<(settings: UpdateSettings) => Promise<void>>(() => new Promise(resolve => { releaseSave = resolve }))
    const server = await boot({ updatesFetch: fetcher, onPersistUpdates: persist })
    const checking = post(server, 'api/updates/check', {})
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    expect((await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })).status).toBe(409)
    releaseCheck(new Response('{"tag_name":"v99.0.0"}')); expect((await checking).status).toBe(200)
    const saving = post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce())
    expect((await post(server, 'api/updates/check', {})).status).toBe(409)
    releaseSave(); expect((await saving).status).toBe(200)
  })

  it('supports deployment environment defaults without storing a secret or exposing setters to viewers', async () => {
    vi.stubEnv('SAKURA_UPDATES_URL', source)
    const server = await boot({ token: 'operator'.repeat(8), viewerToken: 'viewer'.repeat(8) })
    const request = (route: string, token: string, method = 'GET') => fetch(server.url + route, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{"feedUrl":"","autoCheck":true}' } : {}) })
    expect(await (await request('api/updates/settings', 'operator'.repeat(8))).json()).toEqual({ feedUrl: source, autoCheck: true })
    expect((await request('api/updates/settings', 'viewer'.repeat(8))).status).toBe(404)
    expect((await request('api/updates/settings', 'viewer'.repeat(8), 'POST')).status).toBe(403)
    expect(DEFAULT_UPDATES_URL).toContain('github.com')
  })

  it('keeps automatic polls disabled when the stored preference is off', async () => {
    vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '1')
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"tag_name":"v99.0.0"}'))
    const server = await boot({ updates: { feedUrl: source, autoCheck: false }, updatesAutoCheck: undefined, updatesFetch: fetcher, updatesInitialDelayMs: 10, updatesIntervalMs: 20 })
    await new Promise(resolve => setTimeout(resolve, 70)); expect(fetcher).not.toHaveBeenCalled()
    await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: true })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled(), { timeout: 1000 })
    await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })
    const count = fetcher.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 80)); expect(fetcher).toHaveBeenCalledTimes(count)
  })
})