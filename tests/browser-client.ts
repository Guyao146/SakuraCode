/** Minimal real-browser driver for GUI regressions. Uses the same native CDP
 * transport as the browser tools; no Playwright, DOM emulator or CDN needed. */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { resolveChromePath } from '../src/tools/browser.js'

interface Socket {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onclose: (() => void) | null
  onerror: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
}
declare const WebSocket: { new (url: string): Socket }

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** CDP is a loopback control endpoint, not page navigation. Chromium may pick
 * a port Fetch refuses; node:http does not apply browser navigation restrictions. */
export async function readCdpJson<T>(port: string, route: '/json/list' | '/json/version'): Promise<T> {
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid CDP port')
  return new Promise<T>((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: Number(port), path: route,
      signal: AbortSignal.timeout(5_000) }, response => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`CDP ${route} returned HTTP ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 1024 * 1024) response.destroy(new Error('CDP discovery response too large'))
        else chunks.push(chunk)
      })
      response.once('error', reject)
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T) }
        catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
  })
}

export class BrowserClient {
  readonly errors: string[] = []
  browserDebuggerUrl = ''
  private eventListeners = new Map<string, Set<(params: any, sessionId?: string) => void>>()
  private child?: ChildProcess
  private profile = ''
  private socket?: Socket
  private seq = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private loadedDocuments = new Set<string>()
  private javascriptDialog?: { type: string; message: string }

  async start(options: { headless?: boolean } = {}): Promise<void> {
    const exe = resolveChromePath()
    if (!exe) throw new Error('Chrome/Edge is not installed')
    this.profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ui-browser-'))
    this.child = spawn(exe, [
      ...(options.headless !== false ? ['--headless=new'] : ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling']),
      '--remote-debugging-port=0', `--user-data-dir=${this.profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--window-size=1440,960', 'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let launchError: Error | undefined
    let launchLog = ''
    this.child.stderr?.on('data', (chunk) => { launchLog = (launchLog + String(chunk)).slice(-4000) })
    this.child.on('error', (error) => { launchError = error })
    let port = ''
    const deadline = Date.now() + 15_000
    while (!port) {
      if (launchError) throw launchError
      if (this.child.exitCode !== null) throw new Error(`browser exited before CDP was ready (${this.child.exitCode}): ${launchLog}`)
      if (Date.now() > deadline) throw new Error(`browser launch timed out (${exe}): ${launchLog}`)
      port = (await fs.readFile(path.join(this.profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? ''
      if (!port) await delay(60)
    }
    const pages = await readCdpJson<Array<{ type: string; webSocketDebuggerUrl: string }>>(port, '/json/list')
    const page = pages.find((entry) => entry.type === 'page')
    if (!page) throw new Error('no page target')
    const version = await readCdpJson<{ webSocketDebuggerUrl: string }>(port, '/json/version')
    this.browserDebuggerUrl = version.webSocketDebuggerUrl
    await this.connect(page.webSocketDebuggerUrl)
  }

  /** Attach to the real app window in opt-in desktop smoke tests, without launching a second browser. */
  async connect(webSocketDebuggerUrl: string, kind: 'page' | 'browser' = 'page'): Promise<void> {
    const socket = this.socket = new WebSocket(webSocketDebuggerUrl)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connection timed out')), 5_000)
      socket.onopen = () => { clearTimeout(timer); resolve() }
      socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }
    })
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data))
      if (frame.id) {
        const request = this.pending.get(frame.id)
        if (!request) return
        this.pending.delete(frame.id)
        if (frame.error) request.reject(new Error(frame.error.message))
        else request.resolve(frame.result)
      } else if (frame.method === 'Runtime.exceptionThrown') {
        const details = frame.params.exceptionDetails
        this.errors.push(details.exception?.description ?? details.text)
      } else if (frame.method === 'Page.lifecycleEvent' && frame.params.name === 'load') {
        this.loadedDocuments.add(frame.params.loaderId)
      } else if (frame.method === 'Page.javascriptDialogOpening') {
        this.javascriptDialog = { type: frame.params.type, message: frame.params.message }
      } else if (frame.method === 'Page.javascriptDialogClosed') {
        this.javascriptDialog = undefined
      }
      if (frame.method) for (const listener of this.eventListeners.get(frame.method) ?? []) listener(frame.params, frame.sessionId)
    }
    socket.onclose = () => {
      for (const request of this.pending.values()) request.reject(new Error('browser closed'))
      this.pending.clear()
    }
    if (kind === 'browser') return
    await this.send('Page.enable')
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
    await this.send('Runtime.enable')
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }

  onEvent(method: string, listener: (params: any, sessionId?: string) => void): () => void {
    const listeners = this.eventListeners.get(method) ?? new Set()
    listeners.add(listener); this.eventListeners.set(method, listeners)
    return () => { listeners.delete(listener) }
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, 12_000)
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      try { this.socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result?.value as T
  }

  async waitFor(expression: string, timeout = 8_000): Promise<void> {
    const deadline = Date.now() + timeout
    for (;;) {
      const ready = await this.evaluate(expression).catch((error: Error) => {
        // The app window can still be navigating when CDP attaches. Retry only
        // the retiring-context condition, never real page errors or timeouts.
        if (/execution context was destroyed|cannot find context with specified id/i.test(error.message)) return false
        throw error
      })
      if (ready) return
      if (Date.now() > deadline) throw new Error(`UI did not settle: ${expression}\n${await this.describePage()}\n${this.errors.join('\n')}`)
      await delay(40)
    }
  }

  async navigate(url: string): Promise<void> {
    await this.loadDocument('Page.navigate', { url })
  }

  async reload(): Promise<void> {
    await this.loadDocument('Page.reload')
  }

  /** CDP may acknowledge navigation while the old document is still visible.
   * Match the new loader's load event before querying or tearing down a page. */
  private async loadDocument(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const { frameTree } = await this.send('Page.getFrameTree')
    const previousLoader = frameTree.frame.loaderId
    const marker = `sakura-navigation-${Date.now()}-${this.seq}`
    await this.evaluate(`document.__sakuraNavigationMarker = ${JSON.stringify(marker)}`)
    this.loadedDocuments.clear()
    const result = await this.send(method, params)
    if (result.errorText) throw new Error(`${method} failed: ${result.errorText}`)
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const { frameTree: current } = await this.send('Page.getFrameTree')
      const loader = current.frame.loaderId
      if (loader !== previousLoader && this.loadedDocuments.has(loader) && (!result.loaderId || loader === result.loaderId)) {
        // The frame can already name the new loader while Runtime.evaluate
        // still runs in the retiring execution context. Check the document too.
        const ready = await this.evaluate<boolean>(`document.readyState === 'complete' && document.__sakuraNavigationMarker !== ${JSON.stringify(marker)}`)
          .catch((error: Error) => {
            if (/execution context|Cannot find context|context.*destroyed/i.test(error.message)) return false
            throw error
          })
        if (ready) return
      }
      await delay(40)
    }
    throw new Error(`${method} did not load a new document: ${await this.describePage()}`)
  }

  private async describePage(): Promise<string> {
    return this.evaluate<string>(`JSON.stringify({
      url: location.href, readyState: document.readyState,
      text: document.body?.innerText.slice(0, 1500)
    })`).catch((error) => String(error))
  }

  async resize(width: number, height = 900): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await this.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }

  /** Restore the real browser surface after responsive emulation. An attached
   * native desktop must never keep a wider virtual viewport after the test. */
  async resetViewport(): Promise<void> {
    await this.send('Emulation.clearDeviceMetricsOverride')
    await this.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }

  private async pointerTarget(selector: string): Promise<{ x: number; y: number }> {
    let point: { x: number; y: number } | null = null
    const deadline = Date.now() + 2_000
    while (!point && Date.now() < deadline) {
      point = await this.evaluate<{ x: number; y: number } | null>(`(async () => {
        const selector = ${JSON.stringify(selector)};
        document.querySelector(selector)?.scrollIntoView({block: 'center'});
        await new Promise(resolve => requestAnimationFrame(resolve));
        // SSE renders may replace the whole session list during the frame.
        // Never use the bounds of a detached, formerly matching element.
        const element = document.querySelector(selector);
        if (!element) return null;
        const r = element.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (!element.contains(document.elementFromPoint(x, y))) return null;
        return {x, y};
      })()`)
      if (!point) await delay(40)
    }
    if (!point) throw new Error(`click target is not visible or is covered: ${selector}`)
    return point
  }

  async hover(selector: string): Promise<void> {
    const point = await this.pointerTarget(selector)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  }

  async tap(selector: string): Promise<void> {
    const point = await this.pointerTarget(selector)
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 0, radiusX: 2, radiusY: 2 }] })
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  async click(selector: string): Promise<void> {
    const point = await this.pointerTarget(selector)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }

  async fill(selector: string, text: string): Promise<void> {
    await this.evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      input.focus(); input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', {bubbles: true}));
    })()`)
  }

  /** Browser input, not a DOM value assignment: disabled/inert/unfocused fields
   * must fail rather than letting a regression falsely appear editable. Appends. */
  async typeText(selector: string, text: string): Promise<void> {
    await this.click(selector)
    const editable = await this.evaluate<boolean>(`(() => {
      const field = document.querySelector(${JSON.stringify(selector)});
      return field && document.activeElement === field && !field.disabled && !field.readOnly && !field.closest('[inert]');
    })()`)
    if (!editable) throw new Error('input target is not editable/focused: ' + selector)
    await this.send('Input.insertText', { text })
  }

  async key(key: string, modifiers = 0): Promise<void> {
    const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Home: 36, End: 35 }
    const code = codes[key]
    const event = { key, code: key, windowsVirtualKeyCode: code, modifiers }
    await this.send('Input.dispatchKeyEvent', key === 'Enter'
      ? { type: 'keyDown', ...event, text: '\r', unmodifiedText: '\r' }
      : { type: 'rawKeyDown', ...event })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  async screenshot(file: string): Promise<void> {
    const result = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.from(result.data, 'base64'))
  }

  /** Handle the actual Chromium confirmation dialog, not a window.confirm stub. */
  async confirm(action: () => Promise<unknown>, accept: boolean): Promise<string> {
    if (this.javascriptDialog) throw new Error('a JavaScript dialog is already open')
    let failure: unknown
    const triggered = action().catch(error => { failure = error; throw error })
    void triggered.catch(() => {})
    try {
      const deadline = Date.now() + 8_000
      while (!this.javascriptDialog) {
        if (failure) throw failure
        if (Date.now() > deadline) throw new Error('confirmation dialog did not open')
        await delay(40)
      }
      const dialog = this.javascriptDialog as { type: string; message: string }
      if (dialog.type !== 'confirm') throw new Error(`expected confirm, received ${dialog.type}`)
      await this.send('Page.handleJavaScriptDialog', { accept })
      await triggered
      return dialog.message
    } finally {
      if (this.javascriptDialog) await this.send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {})
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      await this.send('Browser.close').catch(() => {})
      this.socket.close()
    }
    const child = this.child
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), delay(2_000)])
      if (child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolve) => {
            const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
            kill.once('exit', () => resolve()); kill.once('error', () => resolve())
          })
        } else child.kill('SIGKILL')
      }
    }
    if (this.profile) await fs.rm(this.profile, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 }).catch(() => {})
  }
}