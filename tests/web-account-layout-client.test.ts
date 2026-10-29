/** Authorization must not move settings outside the available workspace.
 * All account requests and authorization results use the fixed-origin fixture. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer } from '../src/web/server.js'
import { BrowserClient } from './browser-client.js'
import { clientAuthorization, clientDraft, clientUser, noClientSecrets, sakuraClientResponse } from './sakuraapi-client-fixture.js'

const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

suite('account authorization layout — real browser', () => {
  it('keeps connected identity, cards, balance and actions inside settings after authorization, refresh, reload, resizing and reauthorization', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-account-layout-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const handle = await runWebServer({ cwd, open: false, quiet: true, sakuraApiOnly: true, updatesAutoCheck: false,
      sakuraApiOpenLogin: async () => {
        const draft = clientDraft()
        return { draft, readAuthorization: async () => clientAuthorization(draft.state), close: async () => {} }
      },
      sakuraApiFetch: sakuraClientResponse as typeof fetch })
    cleanups.push(() => handle.close())
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()

    const bounds = () => browser.evaluate<{ main: number[]; content: number[]; panel: number[]; overflow: string[]; pageOverflow: boolean; scrolls: number[] }>(`(() => {
      const main = document.getElementById('mainWorkspace'), view = document.getElementById('settingsView');
      const content = document.querySelector('.settings-inner'), panel = document.getElementById('settings-accountPanel');
      const rect = e => {const r = e.getBoundingClientRect(); return [r.x, r.width, r.right];};
      const elements = [document.documentElement, document.body, main, view, content, panel,
        ...panel.querySelectorAll('.settings-card, .settings-account-summary .account-copy, button, a, #sakuraBalance')].filter(e => e.checkVisibility());
      return {main:rect(main),content:rect(content),panel:rect(panel),
        pageOverflow:document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        overflow:elements.filter(e => {const r=e.getBoundingClientRect();return r.left < main.getBoundingClientRect().left - 1 || r.right > innerWidth + 1 || e.scrollWidth > e.clientWidth + 1;})
          .filter(e => e !== document.documentElement && e !== document.body).map(e => e.id || e.className),
        scrolls:[document.documentElement.scrollLeft,document.body.scrollLeft,main.scrollLeft,view.scrollLeft]};
    })()`)
    async function assertLayout(label: string) {
      const size = await bounds()
      expect(size.overflow, label).toEqual([])
      expect(size.pageOverflow, label).toBe(false)
      expect(size.scrolls, label).toEqual([0, 0, 0, 0])
      expect(size.content[0]!, label).toBeGreaterThanOrEqual(size.main[0]! - 1)
      expect(size.content[2]!, label).toBeLessThanOrEqual(size.main[2]! + 1)
      expect(size.content[1]!, label).toBeLessThanOrEqual(960)
      return size
    }
    async function screenshot(name: string) {
      if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
    }

    await browser.resize(1454, 974)
    await browser.navigate(handle.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.click('#sakuraAccountBtn')
    await browser.waitFor("!document.getElementById('sakuraLogin').disabled")
    const before = await assertLayout('signed out')
    await browser.click('#sakuraLogin')
    await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
    await browser.waitFor("document.querySelector('#sakuraVipBadge img')?.complete && document.querySelector('#sakuraVipBadge img').naturalWidth > 0")
    const connected = await assertLayout('authorized')
    expect(connected.main).toEqual(before.main)
    expect(connected.content).toEqual(before.content)
    expect(connected.panel).toEqual(before.panel)
    await screenshot('account-authorized-desktop')
    await browser.click('#sakuraRefresh')
    await browser.waitFor("!document.getElementById('sakuraRefresh').disabled")
    expect((await assertLayout('refreshed')).content).toEqual(before.content)

    for (const theme of ['day', 'night']) {
      await browser.evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
      for (const width of [2560, 1920, 1454, 1100, 790, 761, 640, 390, 320]) {
        await browser.resize(width, 974)
        await assertLayout(theme + ' / ' + width + 'px')
        if (width === 1454 || width === 390) await screenshot('account-layout-' + theme + '-' + width)
      }
    }
    await browser.resize(1454, 974)
    await browser.reload()
    await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
    await browser.click('#sakuraAccountBtn')
    expect((await assertLayout('reloaded')).content).toEqual(before.content)
    expect(await browser.evaluate("document.getElementById('settingsAccountEmail').textContent")).toBe(clientUser.email)
    expect(await browser.evaluate("document.getElementById('sakuraBalance').textContent")).toBe('5.09')
    expect(noClientSecrets(await browser.evaluate('document.body.innerHTML + JSON.stringify(localStorage)'))).toBe(true)
    await browser.click('#sakuraLogout')
    await browser.waitFor("document.getElementById('sakuraLogin').checkVisibility() && !document.getElementById('sakuraLogin').disabled")
    expect((await assertLayout('signed out again')).content).toEqual(before.content)
    await browser.click('#sakuraLogin')
    await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
    expect((await assertLayout('reauthorized')).content).toEqual(before.content)
    expect(browser.errors).toEqual([])
  })
})