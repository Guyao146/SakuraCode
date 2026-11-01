/** Local HTTP access/persistence contract; injected sender never reaches a public collector. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { DesktopStatistics, defaultStatisticsSettings, type StatisticsStatus, type StatisticsStore, type StatisticsStored } from '../src/desktop/statistics.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks() })
const setting = (enabled = true) => ({ enabled, endpoint: 'https://statistics.invalid/api/collect', appId: 'http_desktop_fixture' })
const operator = 'statistics-operator-' + 'a'.repeat(40), viewer = 'statistics-viewer-' + 'b'.repeat(40)
async function directory() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-statistics-http-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return cwd
}
function memory(initial: unknown | null = { schemaVersion: 1, settings: setting(false), anonymousId: null, events: [], dropped: 0, rejected: 0 }) {
  let state: unknown | null = initial
  const store: StatisticsStore = { read: vi.fn(async () => state), write: vi.fn(async value => { state = JSON.parse(JSON.stringify(value)) as StatisticsStored }) }
  return { store, saved: () => state as StatisticsStored }
}
async function boot(extra: Partial<WebServerOptions> = {}, mem = memory()) {
  const cwd = extra.cwd ?? await directory()
  const fetcher = vi.fn<typeof fetch>(() => { throw new Error('Public statistics transport forbidden') })
  const statistics = new DesktopStatistics({ store: mem.store, fetch: fetcher, appVersion: '1.1.0', autoFlush: false })
  cleanups.push(() => statistics.close())
  const handle = await runWebServer({ cwd, open: false, quiet: true, token: null, viewerToken: null,
    updatesAutoCheck: false, onPersistSettings() {}, adapter: new MockAdapter([text('task completed')]), statistics, ...extra })
  cleanups.push(() => handle.close())
  await statistics.start()
  return { handle, base: handle.url, statistics, fetcher, mem }
}
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const read = async (base: string, headers: Record<string, string> = {}) => await (await fetch(base + 'api/desktop/statistics', { headers })).json() as StatisticsStatus

async function events(base: string, token: string) {
  const frames: Array<{ type: string; state?: Record<string, unknown> }> = []
  await new Promise<void>((resolve, reject) => {
    const request = http.get(base + 'api/events', { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000) }, response => {
      let buffered = ''
      response.on('data', (bytes: Buffer) => {
        buffered += bytes.toString('utf8'); let end: number
        while ((end = buffered.indexOf('\n\n')) >= 0) {
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 2)
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)))
        }
      })
      response.on('error', reject)
      resolve()
    })
    request.on('error', reject)
    cleanups.push(() => { request.destroy() })
  })
  return frames
}

describe('desktop statistics local API', () => {
  it('defaults enabled, persists a startup without configuration and never exposes installation/session ids or sends to the public app', async () => {
    const { base, handle, statistics, mem, fetcher } = await boot({}, memory(null))
    expect((await read(base)).settings).toEqual(defaultStatisticsSettings())
    expect(mem.saved().events).toHaveLength(1)
    expect(mem.saved().events[0]?.event_type).toBe('app_start')
    expect(mem.store.write).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled()
    const original = handle.harness
    expect((await post(base, 'api/desktop/statistics', setting())).status).toBe(200)
    expect((await read(base)).settings).toEqual(setting()); expect(mem.saved().events).toHaveLength(1)
    expect((await post(base, 'api/desktop/statistics/activity', {})).status).toBe(200)
    await statistics.whenIdle(); expect(mem.saved().events).toHaveLength(2)
    const state = await (await fetch(base + 'api/state')).json() as { statistics: StatisticsStatus }
    expect(state.statistics.settings.enabled).toBe(true)
    expect(JSON.stringify(state.statistics)).not.toContain(mem.saved().anonymousId!)
    expect(JSON.stringify(state.statistics)).not.toContain(mem.saved().events[0]!.session_id)
    expect(fetcher).not.toHaveBeenCalled(); expect(handle.harness).toBe(original)
    expect((await post(base, 'api/desktop/statistics', setting(false))).status).toBe(200)
    expect(mem.saved()).toMatchObject({ anonymousId: null, events: [] })
  })

  it('rejects private/unknown fields, invalid ids, cleartext destinations and cross-origin settings or activity', async () => {
    const { base, mem } = await boot()
    for (const body of [{ ...setting(), apiKey: 'PRIVATE' }, { ...setting(), appId: 'has space' },
      { ...setting(), endpoint: 'http://outside.invalid/api/collect' }, { ...setting(), enabled: 'yes' }]) {
      expect((await post(base, 'api/desktop/statistics', body)).status).toBe(400)
    }
    expect((await post(base, 'api/desktop/statistics/activity', { path: 'PRIVATE_PATH' })).status).toBe(400)
    expect((await post(base, 'api/desktop/statistics', setting(), { origin: 'https://unrelated.invalid' })).status).toBe(403)
    expect((await post(base, 'api/desktop/statistics/activity', {}, { origin: 'https://unrelated.invalid' })).status).toBe(403)
    expect((await fetch(base + 'api/desktop/statistics', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await post(base, 'api/desktop/statistics', { ...setting(), extra: 'x'.repeat(4096) })).status).toBe(413)
    expect(mem.store.write).not.toHaveBeenCalled()
  })

  it('waits for a real store confirmation, rejects overlapping saves and preserves old settings on failure', async () => {
    const mem = memory(), { base, fetcher } = await boot({}, mem)
    let accept!: () => void, reject!: (error: Error) => void
    const originalWrite = mem.store.write
    mem.store.write = vi.fn(value => new Promise<void>((resolve, fail) => {
      accept = () => { void originalWrite(value).then(resolve, fail) }; reject = fail
    }))
    const attempt = post(base, 'api/desktop/statistics', setting())
    await vi.waitFor(() => expect(mem.store.write).toHaveBeenCalledTimes(1))
    expect((await read(base)).settings.enabled).toBe(false)
    expect((await post(base, 'api/desktop/statistics', setting(false))).status).toBe(409)
    reject(new Error('PRIVATE_STORAGE_PATH'))
    const failed = await attempt; expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('PRIVATE_STORAGE_PATH')
    expect((await read(base)).settings.enabled).toBe(false); expect(fetcher).not.toHaveBeenCalled()
    const retry = post(base, 'api/desktop/statistics', setting())
    await vi.waitFor(() => expect(mem.store.write).toHaveBeenCalledTimes(2)); accept()
    expect((await retry).status).toBe(200); expect((await read(base)).settings.enabled).toBe(true)
  })

  it('keeps one statistics lifecycle across workspace remounts and allows opt-out during an active task', async () => {
    const other = await directory(), { handle, base, mem } = await boot()
    await post(base, 'api/desktop/statistics', setting())
    const before = mem.saved(), original = handle.harness
    expect((await post(base, 'api/desktop/settings', { workspace: other })).status).toBe(200)
    expect(handle.harness).not.toBe(original); expect(mem.saved()).toEqual(before)
    let finish!: () => void, started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    handle.harness.ctx.llm.replaceAdapters({ id: 'paused', defaultModel: 'paused-model', async *stream() {
      started(); await new Promise<void>(resolve => { finish = resolve }); yield* text('finished')
    } })
    const task = handle.harness.run('PRIVATE_TASK_CONTENT')
    try {
      await began
      expect((await post(base, 'api/desktop/statistics', setting(false))).status).toBe(200)
      expect(mem.saved()).toMatchObject({ settings: { enabled: false }, events: [] })
      expect(JSON.stringify(mem.saved())).not.toContain('PRIVATE_TASK_CONTENT')
    } finally { finish(); await task }
  })

  it('does not block server readiness on statistics disk I/O, and exposes no API to ordinary Web or remote users', async () => {
    const cwd = await directory()
    const ordinary = await runWebServer({ cwd, open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, adapter: new MockAdapter([text('ok')]) })
    cleanups.push(() => ordinary.close())
    for (const route of ['api/desktop/statistics', 'api/desktop/statistics/activity']) {
      expect((await fetch(ordinary.url + route)).status).toBe(404)
      expect((await post(ordinary.url, route, setting())).status).toBe(404)
    }
    const remote = await runWebServer({ cwd, open: false, quiet: true, host: '0.0.0.0', token: operator, viewerToken: viewer, updatesAutoCheck: false, adapter: new MockAdapter([text('ok')]) })
    cleanups.push(() => remote.close())
    for (const token of [operator, viewer]) expect((await fetch(remote.url + 'api/desktop/statistics', { headers: { authorization: 'Bearer ' + token } })).status).toBe(404)
    let release!: () => void
    const mem = memory(); mem.store.read = vi.fn(() => new Promise<null>(resolve => { release = () => resolve(null) }))
    const service = new DesktopStatistics({ store: mem.store, appVersion: '1.1.0', autoFlush: false })
    cleanups.push(() => service.close())
    const desktop = await runWebServer({ cwd, onPersistSettings() {}, statistics: service, quiet: true, open: false, updatesAutoCheck: false, adapter: new MockAdapter([text('ok')]) })
    cleanups.push(() => desktop.close())
    expect((await fetch(desktop.url + 'api/state')).status).toBe(200)
    expect((await read(desktop.url)).ready).toBe(false)
    expect((await post(desktop.url, 'api/desktop/statistics', setting())).status).toBe(409)
    release(); await service.start(); expect((await read(desktop.url)).ready).toBe(true)
  })

  it('requires a local operator even when a desktop service is protected by tokens', async () => {
    const { base } = await boot({ token: operator, viewerToken: viewer })
    expect((await fetch(base + 'api/desktop/statistics')).status).toBe(401)
    expect((await fetch(base + 'api/desktop/statistics', { headers: { authorization: 'Bearer ' + viewer } })).status).toBe(404)
    expect((await post(base, 'api/desktop/statistics/activity', {}, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    expect((await post(base, 'api/desktop/statistics', setting(false), { authorization: 'Bearer ' + operator })).status).toBe(200)
    const viewerState = await (await fetch(base + 'api/state', { headers: { authorization: 'Bearer ' + viewer } })).json()
    expect(viewerState).not.toHaveProperty('statistics')
  })

  it('omits preferences from initial and refreshed viewer SSE snapshots and sends statistics notifications only to the operator', async () => {
    const { base } = await boot({ token: operator, viewerToken: viewer })
    const viewerFrames = await events(base, viewer), operatorFrames = await events(base, operator)
    await vi.waitFor(() => {
      expect(viewerFrames.some(frame => frame.type === 'state')).toBe(true)
      expect(operatorFrames.some(frame => frame.type === 'state')).toBe(true)
    })
    expect(viewerFrames.find(frame => frame.type === 'state')!.state).not.toHaveProperty('statistics')
    expect(operatorFrames.find(frame => frame.type === 'state')!.state).toHaveProperty('statistics')
    expect((await post(base, 'api/desktop/statistics', setting(false), { authorization: 'Bearer ' + operator })).status).toBe(200)
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'settings' }, { authorization: 'Bearer ' + operator })).status).toBe(200)
    await vi.waitFor(() => {
      expect(viewerFrames.filter(frame => frame.type === 'state').length).toBeGreaterThan(1)
      expect(operatorFrames.some(frame => frame.type === 'desktop/statistics')).toBe(true)
    })
    expect(viewerFrames.some(frame => frame.type === 'desktop/statistics')).toBe(false)
    for (const frame of viewerFrames.filter(frame => frame.type === 'state')) expect(frame.state).not.toHaveProperty('statistics')
  })
})