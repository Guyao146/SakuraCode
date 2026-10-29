/** Screenshot/layout, actual browser focus/motion, and explicit custom-update settings coverage. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { type UpdateSettings } from '../src/updates.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text } from './helpers.js'
import { clientGroups, clientSaved, clientUser, envelope, sakuraClientResponse } from './sakuraapi-client-fixture.js'

const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
const source = 'https://updates.example.test/sakuracode/latest.json'
suite('desktop UI/update refinements — real browser', () => {
  const browser = new BrowserClient(), directories: string[] = [], servers: WebServerHandle[] = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await browser.navigate('about:blank')
    while (servers.length) await servers.pop()!.close()
    while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })
  async function boot(extra: Partial<WebServerOptions> = {}) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ui-update-')); directories.push(cwd)
    const server = await runWebServer({ cwd, adapter: new MockAdapter([text('UI_INPUT_OK')]), quiet: true, open: false,
      token: null, viewerToken: null, onPersistSettings() {}, updatesAutoCheck: false, ...extra })
    servers.push(server); browser.errors.length = 0
    await browser.resize(1440, 900); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    return server
  }
  async function settings(section: string) {
    await browser.evaluate(`document.getElementById('settingsViewBtn').click(); document.querySelector('[data-settings-section="${section}"]').click()`)
  }
  async function screenshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }
  const gap = (selector: string, button: string) => browser.evaluate<number>(`(() => { const card=document.querySelector(${JSON.stringify(selector)}), description=card.querySelector('.panel-note'), action=card.querySelector(${JSON.stringify(button)}); return action.getBoundingClientRect().top-description.getBoundingClientRect().bottom; })()`)

  it('keeps title/count close and new/multiselect inline, with explicit 20px action gaps in both pictured cards', async () => {
    await boot({ sakuraApiOnly: true, sakuraApi: clientSaved(true), sakuraApiFetch: sakuraClientResponse })
    await browser.waitFor('document.getElementById("accountUsername").textContent === ' + JSON.stringify(clientUser.username))
    const layout = await browser.evaluate<{ countGap: number; sameRow: boolean; buttonOrder: boolean; overflow: boolean }>(`(() => {
      const title=document.querySelector('.side-sessions-head .side-title'), count=document.getElementById('sessionCount'), create=document.getElementById('newSessionBtn'), batch=document.getElementById('sessionBatchBtn'), head=document.querySelector('.side-sessions-head');
      const a=title.getBoundingClientRect(), b=count.getBoundingClientRect(), c=create.getBoundingClientRect(), d=batch.getBoundingClientRect();
      return {countGap:b.left-a.right,sameRow:Math.abs(c.top-d.top)<1 && Math.abs((a.top+a.height/2)-(c.top+c.height/2))<2,buttonOrder:c.right<=d.left && create.nextElementSibling===batch,overflow:head.scrollWidth>head.clientWidth};
    })()`)
    expect(layout.countGap).toBeGreaterThanOrEqual(5); expect(layout.countGap).toBeLessThanOrEqual(9)
    expect(layout.sameRow).toBe(true); expect(layout.buttonOrder).toBe(true); expect(layout.overflow).toBe(false)
    await screenshot('home-inline-sessions')
    await settings('general')
    expect(await gap('#layoutSettingsCard', '#resetLayout')).toBeGreaterThanOrEqual(18)
    await browser.evaluate('document.getElementById("layoutSettingsCard").scrollIntoView({block:"center"})')
    await screenshot('settings-layout-spacing')
    await settings('models')
    expect(await gap('#sakuraModelAccountCard', '#sakuraModelAccount')).toBeGreaterThanOrEqual(18)
    await screenshot('settings-model-account-spacing')
    await settings('account')
    expect(await browser.evaluate('document.getElementById("sakuraOpenModels")')).toBeNull()
    expect(await browser.evaluate('document.getElementById("sakuraSubscriptions").textContent')).toContain('日')
    await screenshot('settings-account-without-navigation-button')
  })

  it('renders three model groups per row, rounds two decimal places, excludes subscription metadata and preserves checkbox/draft focus', async () => {
    const groups = [
      ...clientGroups.map((group, index) => ({ ...group, rate_multiplier: index ? 0.7200000000000001 : 0.855 })),
      { id: 9, name: 'Synthetic 第三模型', platform: 'openai', status: 'active', subscription_type: 'standard', rate_multiplier: 0.045000000000000005 },
      { id: 10, name: '普通名称订阅组', platform: 'openai', status: 'active', subscription_type: 'subscription', rate_multiplier: 0.9 },
      { id: 11, name: 'Synthetic 第四模型', platform: 'gemini', status: 'active', subscription_type: 'standard', rate_multiplier: 1.8900000000000001 },
    ]
    await boot({ sakuraApi: clientSaved(true), sakuraApiOnly: true, sakuraApiFetch: async (url, init) => {
      if (String(url).endsWith('/groups/available')) return envelope(groups)
      if (String(url).endsWith('/groups/rates')) return envelope({})
      return sakuraClientResponse(url, init)
    } })
    await browser.waitFor('document.getElementById("accountUsername").textContent === ' + JSON.stringify(clientUser.username))
    await settings('models')
    expect(await browser.evaluate('[...document.querySelectorAll("#sakuraKeyGroups input")].map(input=>input.value)')).toEqual(['7', '8', '9', '11'])
    expect(await browser.evaluate('[...document.querySelectorAll("#sakuraKeyGroups .account-key-group-rate")].map(node=>node.textContent)')).toEqual(['×0.86', '×0.72', '×0.05', '×1.89'])
    expect(await browser.evaluate('document.getElementById("sakuraKeyGroups").textContent')).not.toContain('普通名称订阅组')
    const rows = await browser.evaluate<number[]>('[...document.querySelectorAll("#sakuraKeyGroups label")].map(node=>node.getBoundingClientRect().top)')
    expect(rows[0]).toBe(rows[1]); expect(rows[1]).toBe(rows[2]); expect(rows[3]).toBeGreaterThan(rows[0]!)
    await browser.click('#sakuraKeyGroups input[value="7"]')
    await browser.typeText('#sakuraKeyName', ' 中文输入草稿')
    await browser.waitFor('!document.getElementById("sakuraKeyName").disabled')
    expect(await browser.evaluate('document.querySelector("#sakuraKeyGroups input").checked')).toBe(true)
    expect(await browser.evaluate('document.getElementById("sakuraKeyName").value')).toContain('中文输入草稿')
    await screenshot('settings-new-key-three-columns')
    for (const [width, columns] of [[700, 2], [390, 1], [320, 1]]) {
      await browser.resize(width!, 850)
      expect(await browser.evaluate('getComputedStyle(document.getElementById("sakuraKeyGroups")).gridTemplateColumns.split(" ").length')).toBe(columns)
      expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true)
    }
    await screenshot('settings-new-key-mobile')
  })

  it('enables subtle entrances without delaying input, preserves focused draft across rapid views, and disables motion on request', async () => {
    await boot()
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await browser.typeText('#input', '动画切换后的草稿')
    await settings('general')
    expect(await browser.evaluate('getComputedStyle(document.getElementById("settings-generalPanel")).animationName')).toBe('surface-enter')
    for (const section of ['models', 'account', 'general', 'about', 'general']) {
      await browser.evaluate(`document.querySelector('[data-settings-section="${section}"]').click()`)
    }
    await browser.click('#settingsBack')
    expect(await browser.evaluate('document.activeElement.id')).toBe('input')
    expect(await browser.evaluate('document.getElementById("input").value')).toBe('动画切换后的草稿')
    await browser.click('#approvalSelBottomTrigger')
    await browser.waitFor('document.getElementById("approvalSelBottomTriggerMenu")?.contains(document.activeElement)')
    expect(await browser.evaluate('getComputedStyle(document.getElementById("approvalSelBottomTriggerMenu")).animationName')).toBe('surface-enter')
    await browser.key('Escape')
    expect(await browser.evaluate('document.activeElement.id')).toBe('approvalSelBottomTrigger')
    await browser.click('#newSessionBtn')
    expect(await browser.evaluate('document.getElementById("newSessionDialog").open')).toBe(true)
    expect(await browser.evaluate('getComputedStyle(document.getElementById("newSessionDialog")).animationName')).toBe('dialog-enter')
    await browser.key('Escape')
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await settings('general')
    expect(await browser.evaluate('getComputedStyle(document.getElementById("settings-generalPanel")).animationName')).toBe('none')
    await browser.click('#settingsBack'); await browser.typeText('#input', ' 继续输入')
    expect(await browser.evaluate('document.getElementById("input").value')).toContain('继续输入')
  })

  it('saves a custom source, rolls back failures, exposes only safe text/links/hash and keeps last-known results after offline errors', async () => {
    const persist = vi.fn<(value: UpdateSettings) => Promise<void>>().mockResolvedValue(undefined)
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ schemaVersion: 1, project: 'SakuraCode', platform: 'windows-x64',
      version: '99.0.0', releaseUrl: 'https://updates.example.test/sakuracode/99.0.0/', downloadUrl: 'https://updates.example.test/sakuracode/99.0.0/SakuraCode%20Desktop.exe',
      sha256: 'a'.repeat(64), size: 98765432, notes: '<img src=x onerror=alert(1)> 更新说明\n- 不自动安装' })))
    const server = await boot({ updatesFetch: fetcher, onPersistUpdates: persist })
    await settings('about')
    await browser.typeText('#settingsUpdateSource', source)
    persist.mockRejectedValueOnce(new Error('synthetic disk full'))
    await browser.click('#settingsUpdateSourceSave')
    await browser.waitFor('document.getElementById("settingsUpdateSourceMessage").classList.contains("error") && !document.getElementById("settingsUpdateSourceSave").disabled')
    expect(await browser.evaluate('document.getElementById("settingsUpdateSource").value')).toBe(source)
    expect(await (await fetch(server.url + 'api/updates/settings')).json()).toEqual({ feedUrl: '', autoCheck: true })
    await browser.click('#settingsUpdateSourceSave')
    await browser.waitFor('document.getElementById("settingsUpdateSourceMessage").textContent.includes("已保存") && !document.getElementById("settingsUpdateSourceSave").disabled')
    expect(fetcher).not.toHaveBeenCalled()
    await browser.click('#settingsCheckUpdates')
    await browser.waitFor('document.getElementById("settingsUpdateStatus").textContent.includes("最新 v99.0.0") && !document.getElementById("settingsCheckUpdates").disabled')
    expect(await browser.evaluate('document.getElementById("settingsUpdateDownload").href')).toBe('https://updates.example.test/sakuracode/99.0.0/SakuraCode%20Desktop.exe')
    expect(await browser.evaluate('document.getElementById("settingsUpdateIntegrity").textContent')).toContain('a'.repeat(64))
    expect(await browser.evaluate('document.querySelectorAll("#settingsUpdateNotes img, #settingsUpdateNotes script").length')).toBe(0)
    expect(await browser.evaluate('document.getElementById("settingsUpdateNotes").textContent')).toContain('<img src=x')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await screenshot('settings-self-hosted-update')
    fetcher.mockRejectedValueOnce(new Error('offline fixture'))
    await browser.click('#settingsCheckUpdates')
    await browser.waitFor('document.getElementById("settingsUpdateHint").textContent.includes("检查失败") && !document.getElementById("settingsCheckUpdates").disabled')
    expect(await browser.evaluate('document.getElementById("settingsUpdateDownload").hidden')).toBe(false)
    await browser.click('#settingsUpdateSourceReset')
    await browser.waitFor('document.getElementById("settingsUpdateSource").value === "" && !document.getElementById("settingsUpdateSourceSave").disabled')
    expect(await browser.evaluate('document.getElementById("settingsUpdateDownload").hidden')).toBe(true)
    expect(await browser.evaluate('document.getElementById("settingsUpdateStatus").textContent')).toBe('尚未检查。')
  })
})