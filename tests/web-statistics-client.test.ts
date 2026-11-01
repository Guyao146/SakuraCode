/** Default-on UI in isolated Chromium; only injected in-memory statistics transport is used. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DesktopStatistics, defaultStatisticsSettings, type StatisticsSettings, type StatisticsStore, type StatisticsStored } from '../src/desktop/statistics.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { MockAdapter, text } from './helpers.js'

const suite = resolveChromePath() && typeof WebSocket === 'function' ? describe : describe.skip
const fixture = { enabled: true, endpoint: 'https://statistics.invalid/api/collect', appId: 'browser_desktop_fixture' }
suite('desktop statistics preferences — real browser', () => {
  const browser = new BrowserClient(), directories: string[] = [], servers: WebServerHandle[] = [], services: DesktopStatistics[] = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.navigate('about:blank')
    while (servers.length) await servers.pop()!.close()
    while (services.length) services.pop()!.close()
    while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([]); vi.restoreAllMocks()
  })
  async function boot(withStatistics = true, savedSettings?: StatisticsSettings) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-statistics-browser-')); directories.push(cwd)
    let stored: unknown | null = savedSettings ? { schemaVersion: 1, settings: savedSettings, anonymousId: null, events: [], dropped: 0, rejected: 0 } : null
    const store: StatisticsStore = { read: vi.fn(async () => stored), write: vi.fn(async value => { stored = JSON.parse(JSON.stringify(value)) as StatisticsStored }) }
    const fetcher = vi.fn<typeof fetch>(() => { throw new Error('Public statistics network forbidden') })
    const statistics = new DesktopStatistics({ store, appVersion: '1.1.0', autoFlush: false, fetch: fetcher }); services.push(statistics)
    const server = await runWebServer({ cwd, open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false,
      onPersistSettings: withStatistics ? () => {} : undefined, statistics: withStatistics ? statistics : undefined,
      adapter: new MockAdapter([text('COMPOSER_READY')]) }); servers.push(server)
    await statistics.start()
    browser.errors.length = 0; await browser.resize(1440, 900); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.getElementById('appBoot').hidden")
    return { server, statistics, store, fetcher, saved: () => stored as StatisticsStored }
  }
  async function general() {
    await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-generalTab').click()")
    await browser.waitFor("document.getElementById('statisticsSettingsCard').checkVisibility()")
  }
  async function edit() {
    await browser.click('#statisticsSettingsCard summary')
    await browser.fill('#statisticsEndpoint', fixture.endpoint); await browser.fill('#statisticsAppId', fixture.appId)
  }

  it('automatically records startup without a checkbox, rejects synthetic input and clears identity from advanced settings', async () => {
    const handle = await boot(); await general()
    expect(await browser.evaluate("document.getElementById('statisticsEnabled') === null && document.querySelector('#statisticsSettingsCard input[type=checkbox]') === null")).toBe(true)
    expect(handle.statistics.status().settings).toEqual(defaultStatisticsSettings())
    expect(handle.saved().events).toHaveLength(1); expect(handle.saved().events[0]?.event_type).toBe('app_start')
    expect(handle.store.write).toHaveBeenCalledTimes(1)
    expect(await browser.evaluate("document.getElementById('statisticsEndpoint').value")).toBe(defaultStatisticsSettings().endpoint)
    expect(await browser.evaluate("document.getElementById('statisticsDestination').textContent")).toBe(defaultStatisticsSettings().endpoint)
    expect(await browser.evaluate("document.getElementById('statisticsAppId').value")).toBe(defaultStatisticsSettings().appId)
    expect(handle.store.write).toHaveBeenCalledTimes(1); expect(handle.fetcher).not.toHaveBeenCalled()
    await edit(); await browser.click('#statisticsSave')
    await browser.waitFor("document.getElementById('statisticsMessage').textContent.includes('已保存') && !document.getElementById('statisticsSave').disabled")
    expect(handle.saved().settings).toEqual(fixture); expect(handle.saved().events).toHaveLength(1)
    await browser.evaluate("document.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown', {key:'x',bubbles:true}))")
    await handle.statistics.whenIdle(); expect(handle.saved().events).toHaveLength(1)
    await browser.send('Page.bringToFront')
    await browser.click('#settingsBack')
    await vi.waitFor(() => expect(handle.saved().events).toHaveLength(2))
    await browser.typeText('#input', 'PRIVATE_DRAFT_NEVER_UPLOADED')
    await handle.statistics.whenIdle()
    expect(handle.saved().events.map(event => event.event_type)).toEqual(['app_start', 'active'])
    expect(JSON.stringify(handle.saved())).not.toContain('PRIVATE_DRAFT_NEVER_UPLOADED')
    await general(); await browser.click('#statisticsToggle')
    await browser.waitFor("document.getElementById('statisticsStatus').textContent.includes('已关闭') && !document.getElementById('statisticsSave').disabled")
    expect(handle.saved()).toMatchObject({ anonymousId: null, events: [], settings: { enabled: false } })
    expect(handle.fetcher).not.toHaveBeenCalled()
    await browser.click('#settingsBack'); expect(await browser.evaluate("document.getElementById('input').value")).toBe('PRIVATE_DRAFT_NEVER_UPLOADED')
  })

  it('preserves the draft and original settings on storage failure and accepts one explicit retry', async () => {
    const handle = await boot(); await general(); await edit()
    const write = handle.store.write
    handle.store.write = vi.fn<StatisticsStore['write']>().mockRejectedValueOnce(new Error('PRIVATE_DISK_ERROR')).mockImplementation(write)
    await browser.click('#statisticsSave')
    await browser.waitFor("document.getElementById('statisticsMessage').classList.contains('error') && !document.getElementById('statisticsSave').disabled")
    expect(handle.statistics.status().settings).toEqual(defaultStatisticsSettings())
    expect(await browser.evaluate("document.getElementById('statisticsAppId').value")).toBe(fixture.appId)
    expect(await browser.evaluate("document.getElementById('statisticsMessage').textContent")).not.toContain('PRIVATE_DISK_ERROR')
    // An unrelated real preference save publishes a new SSE snapshot. The
    // statistics draft must survive it without reaching into the app closure.
    const appearance = await fetch(handle.server.url + 'api/desktop/appearance', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quotaDisplay: 'settings' }) })
    expect(appearance.status).toBe(200)
    await browser.waitFor("document.getElementById('quotaDisplaySelect').value === 'settings'")
    expect(await browser.evaluate("document.getElementById('statisticsEndpoint').value")).toBe(fixture.endpoint)
    await browser.click('#statisticsSave')
    await browser.waitFor("document.getElementById('statisticsMessage').textContent.includes('已保存') && !document.getElementById('statisticsSave').disabled")
    expect(handle.saved().settings).toEqual(fixture); expect(handle.fetcher).not.toHaveBeenCalled()
  })

  it('retains an existing opt-out when saving connection settings and restores only by an explicit action', async () => {
    const savedSettings = { ...fixture, enabled: false }
    const handle = await boot(true, savedSettings); await general(); await edit()
    expect(handle.store.write).not.toHaveBeenCalled()
    expect(handle.saved()).toMatchObject({ anonymousId: null, events: [], settings: { enabled: false } })
    expect(await browser.evaluate("document.getElementById('statisticsToggle').textContent")).toBe('恢复匿名统计')
    await browser.click('#statisticsSave')
    await browser.waitFor("document.getElementById('statisticsMessage').textContent.includes('已保存') && !document.getElementById('statisticsSave').disabled")
    expect(handle.saved().settings.enabled).toBe(false)
    await browser.click('#statisticsToggle')
    await browser.waitFor("document.getElementById('statisticsStatus').textContent.includes('已开启') && !document.getElementById('statisticsToggle').disabled")
    expect(handle.saved().events[0]?.event_type).toBe('app_start'); expect(handle.fetcher).not.toHaveBeenCalled()
  })

  it('keeps empty app IDs silent and preserves an unsaved connection draft when stopping statistics', async () => {
    const empty = await boot(true, { ...fixture, appId: '' }); await general()
    expect(empty.store.write).not.toHaveBeenCalled(); expect(empty.saved().anonymousId).toBeNull()
    expect(await browser.evaluate("document.getElementById('statisticsStatus').textContent")).toContain('未配置应用 ID')
    const handle = await boot(); await general(); await edit()
    await browser.click('#statisticsToggle')
    await browser.waitFor("document.getElementById('statisticsStatus').textContent.includes('已关闭') && !document.getElementById('statisticsToggle').disabled")
    expect(handle.saved().settings).toEqual({ ...defaultStatisticsSettings(), enabled: false })
    expect(await browser.evaluate("document.getElementById('statisticsEndpoint').value")).toBe(fixture.endpoint)
    expect(await browser.evaluate("document.getElementById('statisticsAppId').value")).toBe(fixture.appId)
    expect(handle.saved()).toMatchObject({ anonymousId: null, events: [] }); expect(handle.fetcher).not.toHaveBeenCalled()
  })

  it('hides the preference on ordinary Web, loads no external SDK and keeps the desktop card in responsive settings', async () => {
    await boot(false)
    await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-generalTab').click()")
    expect(await browser.evaluate("document.getElementById('statisticsSettingsCard').hidden")).toBe(true)
    const handle = await boot(); await general(); await browser.click('#statisticsSettingsCard summary')
    for (const theme of ['day', 'night']) {
      await browser.evaluate(`document.getElementById('themeSelect').value=${JSON.stringify(theme)}; document.getElementById('themeSelect').dispatchEvent(new Event('change'))`)
      for (const width of [1440, 320]) {
        await browser.resize(width, 850)
        await browser.evaluate("document.getElementById('statisticsSettingsCard').scrollIntoView({block:'start'})")
        expect(await browser.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")).toBe(true)
        expect(await browser.evaluate("document.querySelectorAll('script[src], link[href^=\"https:\"]').length")).toBe(0)
        if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.join(process.env.SAKURA_UI_SCREENSHOTS, `statistics-${theme}-${width}.png`))
      }
    }
    await handle.statistics.whenIdle()
    expect(handle.saved().settings).toEqual(defaultStatisticsSettings())
    expect(handle.saved().events.filter(event => event.event_type === 'app_start')).toHaveLength(1)
    // Opening advanced settings is trusted activity, not an additional startup.
    expect(handle.saved().events.length).toBeLessThanOrEqual(2); expect(handle.fetcher).not.toHaveBeenCalled()
    const source = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')
    expect(source).not.toContain('web.mcylyr.cn'); expect(source).not.toContain('sdk.js')
  })
})