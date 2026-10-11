/** Minimal real-browser driver for GUI regressions. Uses the same native CDP
 * transport as the browser tools; no Playwright, DOM emulator or CDN needed. */
import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
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

export class BrowserClient {
  readonly errors: string[] = []
  private child?: ChildProcess
  private profile = ''
  private socket?: Socket
  private seq = 0
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  private loadedDocuments = new Set<string>()

  async start(): Promise<void> {
    const exe = resolveChromePath()
    if (!exe) throw new Error('Chrome/Edge is not installed')
    this.profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ui-browser-'))
    this.child = spawn(exe, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${this.profile}`,
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
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000) })
    const pages = await response.json() as Array<{ type: string; webSocketDebuggerUrl: string }>
    const page = pages.find((entry) => entry.type === 'page')
    if (!page) throw new Error('no page target')
    await this.connect(page.webSocketDebuggerUrl)
  }

  /** Attach to the real app window in opt-in desktop smoke tests, without launching a second browser. */
  async connect(webSocketDebuggerUrl: string): Promise<void> {
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
      }
    }
    socket.onclose = () => {
      for (const request of this.pending.values()) request.reject(new Error('browser closed'))
      this.pending.clear()
    }
    await this.send('Page.enable')
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
    await this.send('Runtime.enable')
    await this.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
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
      try { this.socket!.send(JSON.stringify({ id, method, params })) }
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
    while (!await this.evaluate(expression)) {
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
    this.loadedDocuments.clear()
    const result = await this.send(method, params)
    if (result.errorText) throw new Error(`${method} failed: ${result.errorText}`)
    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const { frameTree: current } = await this.send('Page.getFrameTree')
      const loader = current.frame.loaderId
      if (loader !== previousLoader && this.loadedDocuments.has(loader) && (!result.loaderId || loader === result.loaderId)) return
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

  async click(selector: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number }>(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) throw new Error('missing click target');
      element.scrollIntoView({block: 'center'});
      const r = element.getBoundingClientRect();
      return {x: r.x + r.width / 2, y: r.y + r.height / 2};
    })()`)
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

  async key(key: string, modifiers = 0): Promise<void> {
    const codes: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38 }
    const code = codes[key]
    const event = { key, code: key, windowsVirtualKeyCode: code, modifiers }
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
  }

  async screenshot(file: string): Promise<void> {
    const result = await this.send('Page.captureScreenshot', { format: 'png' })
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, Buffer.from(result.data, 'base64'))
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