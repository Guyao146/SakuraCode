/** Real Chromium split-panel resizing, using the app's local storage and CDP
 * pointer/keyboard input. No DOM emulator or extra browser framework. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text } from './helpers.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')
type Panel = 'sidebar' | 'inspector'
interface Layout { sidebarWidth?: unknown; inspectorWidth?: unknown; widthPriority?: Panel }
interface WidthRules {
  boundedPanelWidth(name: Panel, value: unknown): number
  fitPanelWidths(layout: Layout, viewport: number, sideInline: boolean, rightInline: boolean): Record<Panel, number>
}

describe('split-panel width constraints', () => {
  const scope = {} as WidthRules
  const start = html.indexOf('/* Panel width constraints are pure;')
  const end = html.indexOf('/* End pure panel width constraints. */', start)
  new Script(html.slice(start, end)).runInNewContext(scope)

  it('provides labelled keyboard-accessible separators and valid single-file JavaScript', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!
    expect(() => new Script(script)).not.toThrow()
    for (const panel of ['sidebar', 'inspector']) {
      const element = html.match(new RegExp(`<div[^>]+id="${panel}Resizer"[^>]*>`))![0]
      expect(element).toContain('role="separator"')
      expect(element).toContain('tabindex="0"')
      expect(element).toContain('aria-orientation="vertical"')
      expect(element).toContain(`aria-controls="${panel}"`)
      expect(element).toContain('aria-describedby="panelResizeHint"')
    }
  })

  it('migrates legacy or invalid preferences without accepting CSS/text injection', () => {
    for (const invalid of [undefined, null, NaN, Infinity, -Infinity, '999px', '0;display:none', {}, []]) {
      expect(scope.boundedPanelWidth('sidebar', invalid)).toBe(248)
      expect(scope.boundedPanelWidth('inspector', invalid)).toBe(312)
    }
    expect(scope.boundedPanelWidth('sidebar', -999)).toBe(224)
    expect(scope.boundedPanelWidth('inspector', 99999)).toBe(600)
    expect(scope.boundedPanelWidth('sidebar', 300.6)).toBe(301)
    expect(scope.fitPanelWidths({}, 1440, true, true)).toEqual({ sidebar: 248, inspector: 312 })
  })

  it('fits both large panels while reserving the conversation and not mutating saved widths', () => {
    const layout = { sidebarWidth: 480, inspectorWidth: 600 }
    for (const viewport of [1201, 1280, 1366, 1440, 1920]) {
      const widths = scope.fitPanelWidths(layout, viewport, true, true)
      expect(widths.sidebar).toBeGreaterThanOrEqual(224)
      expect(widths.inspector).toBeGreaterThanOrEqual(280)
      expect(widths.sidebar + widths.inspector).toBeLessThanOrEqual(viewport - 400)
    }
    expect(layout).toEqual({ sidebarWidth: 480, inspectorWidth: 600 })
    expect(scope.fitPanelWidths(layout, 1920, true, true)).toEqual({ sidebar: 480, inspector: 600 })
  })

  it('does not charge overlay or collapsed panels against the main area', () => {
    const layout = { sidebarWidth: 480, inspectorWidth: 600 }
    expect(scope.fitPanelWidths(layout, 761, true, false)).toEqual({ sidebar: 361, inspector: 600 })
    expect(scope.fitPanelWidths(layout, 1000, false, false)).toEqual({ sidebar: 480, inspector: 600 })
    expect(scope.fitPanelWidths(layout, 1201, false, true)).toEqual({ sidebar: 480, inspector: 600 })
  })

  it('keeps the actively adjusted column stable when both saved widths do not fit', () => {
    expect(scope.fitPanelWidths({ sidebarWidth: 480, inspectorWidth: 600, widthPriority: 'sidebar' }, 1201, true, true))
      .toEqual({ sidebar: 480, inspector: 321 })
    expect(scope.fitPanelWidths({ sidebarWidth: 480, inspectorWidth: 600, widthPriority: 'inspector' }, 1201, true, true))
      .toEqual({ sidebar: 224, inspector: 577 })
  })
})

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})

const browserSuite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
interface PanelBounds { side: number; right: number; main: number; viewport: number; overflow: boolean; sideHandle: boolean; rightHandle: boolean }
browserSuite('resizable conversation sidebar and workbench — real browser', () => {
  const browser = new BrowserClient()
  const dirs: string[] = []
  let server: WebServerHandle | undefined
  const windowActions: string[] = []
  let modelCalls = 0

  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.navigate('about:blank')
    await server?.close(); server = undefined
    while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })

  async function directory() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-panel-resize-'))
    dirs.push(dir); return dir
  }
  async function boot(layout?: unknown) {
    state.home = await directory()
    const cwd = await directory(); modelCalls = 0; windowActions.length = 0
    server = await runWebServer({ cwd, adapter: new MockAdapter([() => { modelCalls++; return text('RESIZE_CHAT_OK') }]),
      token: null, viewerToken: null, open: false, quiet: true, updatesAutoCheck: false, onPersistSettings() {},
      onWindowAction: action => { if (action !== 'ready') windowActions.push(action) } })
    browser.errors.length = 0; await browser.resize(1440); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.documentElement.dataset.boot === 'ready' && document.getElementById('appBoot').hidden")
    await browser.evaluate(layout === undefined ? "localStorage.removeItem('sakura-layout')" : `localStorage.setItem('sakura-layout', ${JSON.stringify(JSON.stringify(layout))})`)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.documentElement.dataset.boot === 'ready' && document.getElementById('appBoot').hidden")
    return { cwd, server }
  }
  function bounds() {
    return browser.evaluate<PanelBounds>(`(() => {
      const width = id => document.getElementById(id).getBoundingClientRect().width;
      return {side: width('sidebar'), right: width('inspector'), main: width('mainWorkspace'), viewport: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
        sideHandle: document.getElementById('sidebarResizer').checkVisibility(), rightHandle: document.getElementById('inspectorResizer').checkVisibility()};
    })()`)
  }
  async function startDrag(name: Panel) {
    const point = await browser.evaluate<{ x: number; y: number }>(`(() => {
      const handle = document.getElementById('${name}Resizer'), r = handle.getBoundingClientRect();
      const x = r.x + r.width / 2, y = Math.min(200, r.y + r.height / 2);
      if (!handle.checkVisibility() || !handle.contains(document.elementFromPoint(x, y))) throw Error('resizer is hidden or covered');
      return { x, y };
    })()`)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...point })
    await browser.waitFor("document.body.classList.contains('panel-resizing')")
    return point
  }
  async function move(point: { x: number; y: number }) {
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...point })
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
  }
  async function release(point: { x: number; y: number }) {
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...point })
    await browser.waitFor("!document.body.classList.contains('panel-resizing')")
  }
  async function drag(name: Panel, delta: number) {
    const point = await startDrag(name), end = { x: point.x + delta, y: point.y }
    await move(end); await release(end)
  }
  async function doubleClick(name: Panel) {
    const point = await browser.evaluate<{ x: number; y: number }>(`(() => { const r = document.getElementById('${name}Resizer').getBoundingClientRect(); return {x:r.x+r.width/2,y:220}; })()`)
    for (const count of [1, 2]) {
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: count, ...point })
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: count, ...point })
    }
  }
  async function screenshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }

  it('drags both borders in opposite directions, persists widths, and preserves drafts/files without moving the native window', async () => {
    await boot()
    expect(await bounds()).toMatchObject({ side: 248, right: 0, sideHandle: true, rightHandle: false, overflow: false })
    await browser.click('#inspectorBtn')
    await browser.fill('#input', '拖动后继续编辑的草稿')
    await browser.evaluate(`(() => {
      document.getElementById('input').setSelectionRange(3, 5);
      const transfer = new DataTransfer(); transfer.items.add(new File(['RESIZE_ATTACHMENT_KEEP'], 'resize-keep.txt', {type:'text/plain'}));
      document.getElementById('fileInput').files = transfer.files;
      document.getElementById('fileInput').dispatchEvent(new Event('change', {bubbles:true}));
    })()`)
    await browser.waitFor("document.querySelector('#attachRow .file-chip[data-state=ready]') && !document.getElementById('sendBtn').disabled")
    await drag('sidebar', 92); await drag('inspector', -108)
    expect(await bounds()).toMatchObject({ side: 340, right: 420, main: 680, overflow: false })
    expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-layout'))")).toMatchObject({ sidebarWidth: 340, inspectorWidth: 420, inspector: true })
    expect(await browser.evaluate("({text:document.getElementById('input').value,start:document.getElementById('input').selectionStart,end:document.getElementById('input').selectionEnd})"))
      .toEqual({ text: '拖动后继续编辑的草稿', start: 3, end: 5 })
    expect(await browser.evaluate("document.querySelector('#attachRow .file-chip').textContent")).toContain('resize-keep.txt')
    expect(windowActions).toEqual([]); expect(modelCalls).toBe(0)
    await screenshot('panels-resized-desktop')
    await browser.click('#sidebarBrandBtn')
    expect((await bounds()).sideHandle).toBe(false)
    await browser.click('#menuBtn')
    await browser.click('#closeInspectorBtn'); await browser.click('#inspectorBtn')
    expect(await bounds()).toMatchObject({ side: 340, right: 420 })
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('拖动后继续编辑的草稿')
    await browser.reload(); await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    expect(await bounds()).toMatchObject({ side: 340, right: 420, overflow: false })
  })

  it('clamps extreme drags, supports accessible keyboard steps, and resets each pane on double-click', async () => {
    await boot(); await browser.click('#inspectorBtn')
    await drag('sidebar', -150); expect((await bounds()).side).toBe(224)
    await drag('inspector', 800); expect((await bounds()).right).toBe(280)
    await browser.click('#sidebarResizer'); await browser.key('End')
    expect((await bounds()).side).toBe(480)
    await browser.click('#inspectorResizer'); await browser.key('End')
    const full = await bounds(); expect(full.right).toBe(560); expect(full.main).toBe(400); expect(full.overflow).toBe(false)
    expect(await browser.evaluate("document.getElementById('inspectorResizer').getAttribute('aria-valuemax')")).toBe('560')
    await browser.key('ArrowRight'); expect((await bounds()).right).toBe(550)
    await browser.key('ArrowRight', 8); expect((await bounds()).right).toBe(510)
    await browser.key('ArrowLeft'); expect((await bounds()).right).toBe(520)
    await browser.key('Home'); expect((await bounds()).right).toBe(280)
    await browser.key('Enter'); expect((await bounds()).right).toBe(312)
    await doubleClick('sidebar'); expect((await bounds()).side).toBe(248)
    await drag('inspector', -88); expect((await bounds()).right).toBe(400)
    await doubleClick('inspector'); expect((await bounds()).right).toBe(312)
    expect(await browser.evaluate("document.getElementById('inspectorResizer').getAttribute('aria-valuenow')")).toBe('312')
    expect(windowActions).toEqual([])
  })

  it('cancels on Escape, pointer cancellation, lost capture and viewport changes without saving or sticking in drag mode', async () => {
    await boot(); await browser.click('#inspectorBtn')
    const before = await browser.evaluate<string>("localStorage.getItem('sakura-layout')")
    const first = await startDrag('sidebar'); await move({ x: first.x + 70, y: first.y })
    expect((await bounds()).side).toBe(318)
    await browser.key('Escape'); await release({ x: first.x + 70, y: first.y })
    expect((await bounds()).side).toBe(248)
    expect(await browser.evaluate('document.activeElement.id')).toBe('sidebarResizer')
    for (const cancel of ['pointercancel', 'lostpointercapture']) {
      const point = await startDrag('inspector'); await move({ x: point.x - 50, y: point.y })
      await browser.evaluate(`(() => {const h=document.getElementById('inspectorResizer');h.dispatchEvent(new PointerEvent('${cancel}',{pointerId:1,bubbles:true}));})()`)
      expect(await browser.evaluate("document.body.classList.contains('panel-resizing')")).toBe(false)
      await release({ x: point.x - 50, y: point.y })
      expect((await bounds()).right).toBe(312)
    }
    const next = await startDrag('sidebar'); await move({ x: next.x + 55, y: next.y })
    await browser.resize(1280); await release({ x: next.x + 55, y: next.y })
    expect((await bounds()).side).toBe(248)
    expect(await browser.evaluate("localStorage.getItem('sakura-layout')")).toBe(before)
    expect(await browser.evaluate("document.querySelectorAll('[data-resizing]').length")).toBe(0)
    await browser.typeText('#input', '取消后正常编辑')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('取消后正常编辑')
  })

  it('keeps resets exact on a constrained desktop and does not let mouse buttons or interrupted captures corrupt the layout', async () => {
    await boot({ sidebar: true, inspector: true, panel: 'team', sidebarWidth: 480, inspectorWidth: 600, widthPriority: 'inspector' })
    await browser.resize(1201)
    expect(await bounds()).toMatchObject({ side: 224, right: 577 })
    await doubleClick('sidebar'); expect((await bounds()).side).toBe(248)
    expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-layout')).sidebarWidth")).toBe(248)
    await browser.resize(1920); await browser.resize(1201)
    await browser.click('#inspectorResizer'); await browser.key('Enter')
    expect((await bounds()).right).toBe(312)
    expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-layout')).inspectorWidth")).toBe(312)
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', buttons: 2, x: 248, y: 200, clickCount: 1 })
    expect(await browser.evaluate("document.body.classList.contains('panel-resizing')")).toBe(false)
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right', buttons: 0, x: 248, y: 200, clickCount: 1 })
    const before = await bounds(), saved = await browser.evaluate<string>("localStorage.getItem('sakura-layout')")
    for (const interrupt of ["window.dispatchEvent(new Event('blur'))", "document.getElementById('closeInspectorBtn').click()", "document.getElementById('settingsViewBtn').click()"] ) {
      const point = await startDrag('inspector'); await move({ x: point.x - 60, y: point.y })
      await browser.evaluate(interrupt)
      expect(await browser.evaluate("document.body.classList.contains('panel-resizing')")).toBe(false)
      await release({ x: point.x - 60, y: point.y })
      if (await browser.evaluate("document.body.classList.contains('settings-view')")) await browser.click('#settingsBack')
      if (!(await bounds()).rightHandle) await browser.click('#inspectorBtn')
      expect((await bounds()).right).toBe(before.right)
    }
    expect(await browser.evaluate("localStorage.getItem('sakura-layout')")).toBe(saved)
    expect(windowActions).toEqual([])
  })

  it('fits saved widths across viewports, resizes a desktop drawer, and preserves the mobile focus trap', async () => {
    await boot({ sidebar: true, inspector: true, panel: 'team', sidebarWidth: 480, inspectorWidth: 600 })
    for (const width of [1920, 1440, 1280, 1201]) {
      await browser.resize(width)
      const current = await bounds(); expect(current.main).toBeGreaterThanOrEqual(400); expect(current.overflow).toBe(false)
      expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-layout'))")).toMatchObject({ sidebarWidth: 480, inspectorWidth: 600 })
    }
    await browser.resize(1920); expect(await bounds()).toMatchObject({ side: 480, right: 600 })
    await browser.resize(1000); expect((await bounds()).rightHandle).toBe(false)
    await browser.click('#inspectorBtn'); expect((await bounds()).rightHandle).toBe(true)
    expect(await browser.evaluate("({main:document.getElementById('mainWorkspace').inert,side:document.getElementById('sidebar').inert})")).toEqual({ main: true, side: true })
    await drag('inspector', 100); expect((await bounds()).right).toBe(500)
    await browser.key('Escape'); expect(await browser.evaluate('document.activeElement.id')).toBe('inspectorBtn')
    await browser.resize(390)
    await browser.click('#menuBtn')
    expect(await bounds()).toMatchObject({ sideHandle: false, rightHandle: false, overflow: false })
    await browser.key('Tab', 8); await browser.key('Tab')
    expect(await browser.evaluate("document.getElementById('sidebar').contains(document.activeElement)")).toBe(true)
    await browser.key('Escape'); expect(await browser.evaluate('document.activeElement.id')).toBe('menuBtn')
    await browser.click('#inspectorBtn'); expect((await bounds()).rightHandle).toBe(false)
    expect((await bounds()).right).toBe(358)
    await browser.resize(320); expect((await bounds()).overflow).toBe(false)
    await screenshot('panels-resize-mobile-drawer')
    await browser.key('Escape'); await browser.resize(1920)
    expect(await bounds()).toMatchObject({ side: 480, right: 500, overflow: false })
  })

  it('keeps layout local when storage is unavailable and resets widths through settings without losing a draft', async () => {
    await boot({ sidebar: true, inspector: false, panel: 'changes', sidebarWidth: 'bad', inspectorWidth: '999px' })
    expect((await bounds()).side).toBe(248)
    await browser.fill('#input', '恢复布局也保留草稿')
    await browser.click('#inspectorBtn')
    await browser.evaluate("window.originalPanelStorage = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if(key === 'sakura-layout') throw new Error('storage blocked'); return window.originalPanelStorage.call(this, key, value); }")
    try { await drag('sidebar', 52); expect((await bounds()).side).toBe(300) }
    finally { await browser.evaluate('Storage.prototype.setItem = window.originalPanelStorage; delete window.originalPanelStorage') }
    await drag('inspector', -88)
    await browser.click('#settingsViewBtn'); await browser.click('#settings-generalTab'); await browser.click('#resetLayout')
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(false)
    await browser.click('#settingsBack')
    expect(await bounds()).toMatchObject({ side: 248, right: 0, overflow: false })
    await browser.click('#inspectorBtn'); expect((await bounds()).right).toBe(312)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('恢复布局也保留草稿')
    expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-layout'))")).toMatchObject({ sidebarWidth: 248, inspectorWidth: 312, panel: 'team' })
    expect(modelCalls).toBe(0); expect(windowActions).toEqual([])
  })
})