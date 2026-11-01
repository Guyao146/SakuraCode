/** Private host/app-data wiring: no live statistics, browser, account credentials or native input. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseDesktopLaunch, runDesktopHost, startDesktopHost } from '../src/desktop/host.js'
import { StatisticsFileStore, defaultStatisticsSettings, parseStatisticsStored, type StatisticsStatus } from '../src/desktop/statistics.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks() })
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-statistics-private-host-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return dir
}
const read = async (url: string) => await (await fetch(url + 'api/desktop/statistics')).json() as StatisticsStatus

describe('desktop statistics private host binding', () => {
  it('accepts only an absolute private app-data path, never an inline credential or project configuration', async () => {
    const cwd = await directory(), statisticsDir = path.join(cwd, 'private-data', 'usage-statistics')
    expect(parseDesktopLaunch({ cwd, statisticsDir }).statisticsDir).toBe(statisticsDir)
    for (const value of ['relative/path', statisticsDir + '\0', 42, {}]) expect(() => parseDesktopLaunch({ cwd, statisticsDir: value })).toThrow()
    const source = readFileSync(new URL('../scripts/desktop/Launcher.cs', import.meta.url), 'utf8')
    expect(source).toContain('statisticsDir = Path.Combine(options.DataDir, "usage-statistics")')
    const host = readFileSync(new URL('../src/desktop/host.ts', import.meta.url), 'utf8')
    expect(host).toContain('appVersion: WEB_VERSION')
  })

  it('automatically records startup through the private pipe and independently saves opt-out without changing account/settings files', async () => {
    const originalFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const target = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('Public transport forbidden in private-host test')
      return originalFetch(input, init)
    })
    const cwd = await directory(), data = path.join(cwd, 'isolated-app-data'), statisticsDir = path.join(data, 'usage-statistics')
    await fs.mkdir(data); await fs.writeFile(path.join(data, 'sakuraapi.json'), 'UNCHANGED_ACCOUNT'); await fs.writeFile(path.join(data, 'settings.json'), 'UNCHANGED_SETTINGS')
    const input = new PassThrough(), output = new PassThrough(), frames: Array<{ type: string; url?: string }> = []
    let buffered = ''
    output.on('data', chunk => {
      buffered += String(chunk); let index: number
      while ((index = buffered.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffered.slice(0, index))); buffered = buffered.slice(index + 1) }
    })
    const running = runDesktopHost(input, output)
    input.write(JSON.stringify({ cwd, statisticsDir, updates: { feedUrl: '', autoCheck: false } }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      await vi.waitFor(async () => expect((await read(url)).ready).toBe(true))
      expect((await read(url)).settings).toEqual(defaultStatisticsSettings())
      const initial = parseStatisticsStored(await new StatisticsFileStore(statisticsDir).read())
      expect(initial.events).toHaveLength(1); expect(initial.events[0]?.event_type).toBe('app_start')
      expect(initial.anonymousId).toBeTruthy()
      const saved = await fetch(url + 'api/desktop/statistics', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, endpoint: 'http://127.0.0.1:4500/api/collect', appId: 'private_fixture' }) })
      expect(saved.status).toBe(200)
      expect(parseStatisticsStored(await new StatisticsFileStore(statisticsDir).read())).toMatchObject({ anonymousId: null, events: [] })
      const state = await (await fetch(url + 'api/state')).json()
      expect(JSON.stringify(state)).not.toContain(statisticsDir)
      expect(frames.filter(frame => frame.type === 'desktop/settings')).toHaveLength(0)
      expect(await fs.readFile(path.join(data, 'sakuraapi.json'), 'utf8')).toBe('UNCHANGED_ACCOUNT')
      expect(await fs.readFile(path.join(data, 'settings.json'), 'utf8')).toBe('UNCHANGED_SETTINGS')
    } finally { input.end('shutdown\n'); await running; output.destroy() }
  })

  it('reuses saved disabled preferences after restart on another port without importing project statistics', async () => {
    const cwd = await directory(), data = path.join(cwd, 'app-data'), statisticsDir = path.join(data, 'usage-statistics')
    await fs.writeFile(path.join(cwd, 'sakura.yml'), 'statistics:\n  enabled: true\n  appId: malicious_project_value\n')
    const settings = { ...defaultStatisticsSettings(), enabled: false, endpoint: 'https://offline-statistics.invalid/api/collect', appId: 'restart_fixture' }
    const store = new StatisticsFileStore(statisticsDir)
    await store.write({ schemaVersion: 1, settings, anonymousId: null, events: [], dropped: 0, rejected: 0 })
    const first = await startDesktopHost({ cwd, approvalMode: 'default', statisticsDir, updates: { feedUrl: '', autoCheck: false } }, () => {})
    try { await vi.waitFor(async () => expect((await read(first.url)).settings).toEqual(settings)) }
    finally { await first.close() }
    const second = await startDesktopHost({ cwd, approvalMode: 'default', statisticsDir, updates: { feedUrl: '', autoCheck: false } }, () => {})
    try {
      await vi.waitFor(async () => expect((await read(second.url)).settings).toEqual(settings))
      expect(second.port).not.toBe(first.port)
      expect(parseStatisticsStored(await store.read()).settings.enabled).toBe(false)
    } finally { await second.close() }
  })
})