/**
 * tool-browser — Chrome/Edge browser control via the Chrome DevTools
 * Protocol (CDP). Zero npm dependencies: the browser is launched with
 * --remote-debugging-port=0 and the initial page is driven over Node's
 * native WebSocket global (Node >= 22).
 *
 * Lifecycle: one lazy singleton browser per plugin instance. The first tool
 * call resolves the executable (config.chromePath -> $SAKURA_CHROME -> common
 * install paths), spawns it with a throwaway user-data-dir under os.tmpdir(),
 * waits for the DevTools endpoint ("DevTools listening on ws://..." on stderr,
 * with a /json/version readiness poll and the DevToolsActivePort file as
 * backstops), then connects to the initial about:blank page target. Disposing
 * the plugin scope closes the page, kills the browser process tree (taskkill
 * on Windows) and removes the user-data-dir best-effort. browser_close does
 * the same on demand; the next tool call simply relaunches.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, promises as fsp, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '../kernel/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { params, type ToolsService } from '../core/tools.js'

const DEFAULT_TIMEOUT_MS = 15_000
/** Fixed budget for "spawn browser -> DevTools endpoint is up" (spec: 10 s). */
const LAUNCH_TIMEOUT_MS = 10_000
/** Fixed budget for waiting for Page.loadEventFired after a navigation. */
const LOAD_EVENT_TIMEOUT_MS = 15_000

export interface BrowserToolsConfig {
  /** Explicit path to a Chrome-family executable (chrome.exe / msedge.exe / ...). */
  chromePath?: string
  /** Launch headless (default true). */
  headless?: boolean
  /** Default per-command CDP timeout in ms (default 15000). */
  defaultTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Common Chrome-family install paths, per platform, in probe order. */
const CHROME_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/microsoft-edge',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/msedge',
  ],
}

/**
 * Resolve the browser executable: explicit path -> $SAKURA_CHROME -> the
 * first existing entry from the platform's candidate list. Returns null when
 * nothing exists (the caller renders the error).
 */
export function resolveChromePath(explicit?: string): string | null {
  const consider = (p: string | undefined): string | null =>
    p && p.trim() && existsSync(p.trim()) ? p.trim() : null
  const direct = consider(explicit) ?? consider(process.env.SAKURA_CHROME)
  if (direct) return direct
  for (const candidate of CHROME_CANDIDATES[process.platform] ?? []) {
    const found = consider(candidate)
    if (found) return found
  }
  return null
}

/**
 * Read an image's dimensions straight from the PNG header: signature (8 B)
 * then the IHDR chunk whose width sits at bytes 16-19 and height at 20-23
 * (both big-endian). Throws when the buffer is not a PNG image.
 */
export function parsePngSize(buf: Buffer): { w: number; h: number } {
  if (buf.length < 24) throw new Error('not a PNG image (buffer too short)')
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG image (bad signature)')
  }
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}

// ---------------------------------------------------------------------------
// CDP over the native WebSocket
// ---------------------------------------------------------------------------

const WS_OPEN = 1

interface WsMessageEventLike {
  data: unknown
}
interface WsErrorEventLike {
  message?: string
}

/**
 * Structural typing for Node's native WebSocket global (undici). The current
 * @types/node does not declare the global, so we declare the minimal surface
 * the driver uses. Node's WebSocket supports the on* handler properties.
 */
interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((ev: WsMessageEventLike) => void) | null
  onerror: ((ev: WsErrorEventLike) => void) | null
  onclose: (() => void) | null
}

declare var WebSocket: { prototype: WsLike; new (url: string): WsLike }

interface CdpPending {
  method: string
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * One CDP page-session WebSocket: JSON {id, method, params} requests paired
 * by id, plus method-keyed event listeners ({method, params} messages).
 */
class CdpConn {
  private seq = 0
  private readonly pending = new Map<number, CdpPending>()
  private readonly listeners = new Map<string, Set<(params: any) => void>>()
  private readonly ws: WsLike
  closed = false

  private constructor(ws: WsLike) {
    this.ws = ws
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') this.handleData(ev.data)
    }
    ws.onclose = () => {
      if (!this.closed) this.close()
    }
    ws.onerror = () => {
      // Connection failures surface as a close event; nothing to do here.
    }
  }

  /** Open the socket and wait (bounded) for it to become writable. */
  static connect(url: string, timeoutMs: number): Promise<CdpConn> {
    return new Promise((resolve, reject) => {
      let ws: WsLike
      try {
        ws = new WebSocket(url)
      } catch (error) {
        reject(new Error(`failed to open the browser page socket: ${(error as Error).message}`))
        return
      }
      let done = false
      const finish = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
        if (error) {
          try {
            ws.close()
          } catch {
            // already dead
          }
          reject(error)
          return
        }
        resolve(new CdpConn(ws))
      }
      const timer = setTimeout(
        () => finish(new Error(`timed out connecting to the browser page after ${timeoutMs} ms`)),
        timeoutMs,
      )
      ws.onopen = () => finish()
      ws.onerror = (ev) => finish(new Error(`browser page socket error${ev?.message ? `: ${ev.message}` : ''}`))
      ws.onclose = () => finish(new Error('browser page socket closed before it opened'))
    })
  }

  /** Send one CDP command; resolves with `result`, rejects on CDP error / timeout / abort / close. */
  send(
    method: string,
    commandParams: Record<string, unknown> = {},
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<any> {
    if (this.closed || this.ws.readyState !== WS_OPEN) {
      return Promise.reject(new Error('browser connection is closed'))
    }
    const id = ++this.seq
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let entry!: CdpPending
      const settle = (error?: Error, value?: any) => {
        clearTimeout(entry.timer)
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
        if (error) reject(error)
        else resolve(value)
      }
      entry = {
        method,
        resolve,
        reject,
        timer: setTimeout(() => settle(new Error(`CDP ${method} timed out after ${timeoutMs} ms`)), timeoutMs),
        signal: opts.signal,
      }
      entry.onAbort = () => settle(new Error('cancelled'))
      this.pending.set(id, entry)
      if (entry.signal?.aborted) {
        entry.onAbort()
        return
      }
      entry.signal?.addEventListener('abort', entry.onAbort, { once: true })
      try {
        this.ws.send(JSON.stringify({ id, method, params: commandParams }))
      } catch (error) {
        settle(new Error(`browser connection send failed: ${(error as Error).message}`))
      }
    })
  }

  /** Listen for a CDP event method; returns a disposer. */
  on(method: string, cb: (params: any) => void): () => void {
    const set = this.listeners.get(method) ?? new Set<(params: any) => void>()
    this.listeners.set(method, set)
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  /** Wait once for a CDP event; resolves true if seen, false when the timeout lapses. */
  waitEvent(method: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let off: () => void = () => {}
      const timer = setTimeout(() => {
        off()
        resolve(false)
      }, timeoutMs)
      off = this.on(method, () => {
        clearTimeout(timer)
        off()
        resolve(true)
      })
    })
  }

  /** Close the socket and reject everything still in flight. */
  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new Error('browser connection closed')
    for (const entry of [...this.pending.values()]) {
      clearTimeout(entry.timer)
      if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
      entry.reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
    try {
      if (this.ws.readyState === WS_OPEN) this.ws.close()
    } catch {
      // ignore
    }
    this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null
  }

  private handleData(raw: string): void {
    let msg: {
      id?: number
      method?: string
      params?: any
      result?: any
      error?: { message?: string; data?: string }
    }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id)
      if (!entry) return
      this.pending.delete(msg.id)
      if (msg.error) {
        const detail = [msg.error.message, msg.error.data].filter(Boolean).join(' — ')
        entry.reject(new Error(`CDP ${entry.method} failed${detail ? `: ${detail}` : ''}`))
      } else {
        entry.resolve(msg.result)
      }
    } else if (typeof msg.method === 'string') {
      const set = this.listeners.get(msg.method)
      if (set) for (const cb of [...set]) cb(msg.params)
    }
  }
}

// ---------------------------------------------------------------------------
// Browser process plumbing
// ---------------------------------------------------------------------------

interface ResolvedBrowserConfig {
  chromePath?: string
  headless: boolean
  defaultTimeoutMs: number
}

interface BrowserSession {
  child: ChildProcess
  userDataDir: string
  conn: CdpConn
  /** The child exited on its own (crash or external kill). */
  dead: boolean
  /** Teardown already ran (idempotence guard). */
  torndown: boolean
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function findDevToolsPort(stderrText: string, userDataDir: string): number | null {
  const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderrText)
  if (m && m[1]) return Number(m[1])
  // Backstop: Chrome writes the port as the first line of DevToolsActivePort.
  try {
    const firstLine = readFileSync(join(userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]
    const port = firstLine ? Number(firstLine.trim()) : NaN
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    // not written yet
  }
  return null
}

async function devtoolsResponds(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) })
    return res.ok
  } catch {
    return false
  }
}

/** Wait (bounded) for the browser to expose its DevTools HTTP endpoint. */
async function waitForDevToolsPort(child: ChildProcess, userDataDir: string): Promise<number> {
  const startup: { error: string | null } = { error: null }
  let stderrText = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderrText.length < 16_000) stderrText += chunk.toString('utf8')
  })
  child.once('error', (error) => {
    startup.error = error.message
  })
  child.once('exit', (code) => {
    startup.error ??= `browser exited during startup (code ${code ?? 'signal'})`
  })
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (typeof startup.error === 'string') throw new Error(`failed to start the browser: ${startup.error}`)
    const port = findDevToolsPort(stderrText, userDataDir)
    if (port !== null && (await devtoolsResponds(port))) return port
    await delay(100)
  }
  throw new Error(`the browser did not expose a DevTools endpoint within ${LAUNCH_TIMEOUT_MS} ms`)
}

/** Find the initial page target and attach a CDP connection to it. */
async function acquirePageConn(port: number, timeoutMs: number): Promise<CdpConn> {
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('could not attach to the browser page target within 10 s')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2_000) })
      if (res.ok) {
        const targets = (await res.json()) as Array<{ type?: string; webSocketDebuggerUrl?: string }>
        const page = targets.find((t) => t.type === 'page')
        const wsUrl = page?.webSocketDebuggerUrl
        if (typeof wsUrl === 'string' && wsUrl) {
          const conn = await CdpConn.connect(wsUrl, timeoutMs)
          try {
            await conn.send('Page.enable', {}, { timeoutMs: 5_000 })
          } catch {
            // Page events are best-effort; navigate only reports load state.
          }
          return conn
        }
      }
    } catch {
      // browser still warming up — retry until the deadline
    }
    await delay(100)
  }
}

/** Kill the browser and its process tree (grandchildren survive a bare kill on Windows). */
function killBrowserProcess(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
  const pid = child.pid
  if (pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }
  return Promise.race([exited, delay(3_000)])
}

/** Best-effort recursive removal of the throwaway user-data-dir. */
async function removeUserDataDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true })
      return
    } catch {
      // Windows may still hold file locks right after exit — retry briefly.
      await delay(300)
    }
  }
}

/** Close the page gracefully, then kill the process tree and clean the profile. */
async function teardownBrowser(s: BrowserSession): Promise<void> {
  if (s.torndown) return
  s.torndown = true
  try {
    await s.conn.send('Page.close', {}, { timeoutMs: 1_000 })
  } catch {
    // page may already be gone — the kill below settles it
  }
  s.conn.close()
  await killBrowserProcess(s.child)
  await removeUserDataDir(s.userDataDir)
}

async function launchBrowser(cfg: ResolvedBrowserConfig): Promise<BrowserSession> {
  const exe = resolveChromePath(cfg.chromePath)
  if (!exe) {
    throw new Error(
      'no Chrome or Edge executable found — set the browser config "chromePath" or the SAKURA_CHROME environment variable',
    )
  }
  const userDataDir = join(tmpdir(), `sakura-browser-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(userDataDir, { recursive: true })
  } catch {
    // Chrome creates it anyway
  }
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
  ]
  if (cfg.headless) args.push('--headless=new')
  args.push('about:blank')
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  try {
    const port = await waitForDevToolsPort(child, userDataDir)
    const conn = await acquirePageConn(port, cfg.defaultTimeoutMs)
    const session: BrowserSession = { child, userDataDir, conn, dead: false, torndown: false }
    child.once('exit', () => {
      session.dead = true
      void teardownBrowser(session)
    })
    return session
  } catch (error) {
    await killBrowserProcess(child)
    await removeUserDataDir(userDataDir)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

function errorResult(message: string): ToolResult {
  return { output: `error: ${message}`, isError: true }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Strict integer argument; returns Error (render as isError) instead of throwing. */
function getInt(args: Record<string, unknown>, name: string, min = Number.NEGATIVE_INFINITY): number | Error {
  const raw = args[name]
  if (raw === undefined || raw === null) return new Error(`${name} is required`)
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n)) return new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`)
  if (n < min) return new Error(`${name} must be >= ${min}, got ${n}`)
  return n
}

/** Runtime.evaluate with returnByValue; throws on exceptionDetails. */
async function evalValue(conn: CdpConn, expression: string, signal?: AbortSignal): Promise<any> {
  const res = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { signal })
  if (res && typeof res === 'object' && res.exceptionDetails) {
    const detail = res.exceptionDetails as {
      text?: string
      exception?: { description?: string; value?: unknown }
    }
    const description = detail.exception?.description ?? detail.exception?.value ?? detail.text
    throw new Error(typeof description === 'string' && description ? description : 'evaluation failed')
  }
  return res?.result?.value
}

/** Center of the first element matching a CSS selector, or null when absent. */
async function selectorCenter(
  conn: CdpConn,
  selector: string,
  signal?: AbortSignal,
): Promise<{ x: number; y: number } | null> {
  const expression =
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); ` +
    'if (!el) return null; const r = el.getBoundingClientRect(); ' +
    'return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()'
  const value = await evalValue(conn, expression, signal)
  if (value && typeof value === 'object' && typeof value.x === 'number' && typeof value.y === 'number') {
    return { x: value.x, y: value.y }
  }
  return null
}

async function dispatchClick(
  conn: CdpConn,
  x: number,
  y: number,
  button: 'left' | 'right',
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<void> {
  const base = { x, y, button, clickCount: 1 }
  await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base }, opts)
  await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base }, opts)
}

/** windowsKeyCode table for the supported named keys. */
const KEY_CODES: Record<string, { windowsKeyCode: number; key: string; code: string }> = {
  enter: { windowsKeyCode: 13, key: 'Enter', code: 'Enter' },
  tab: { windowsKeyCode: 9, key: 'Tab', code: 'Tab' },
  escape: { windowsKeyCode: 27, key: 'Escape', code: 'Escape' },
  esc: { windowsKeyCode: 27, key: 'Escape', code: 'Escape' },
  backspace: { windowsKeyCode: 8, key: 'Backspace', code: 'Backspace' },
  arrowup: { windowsKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  arrowdown: { windowsKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  arrowleft: { windowsKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' },
  arrowright: { windowsKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' },
  up: { windowsKeyCode: 38, key: 'ArrowUp', code: 'ArrowUp' },
  down: { windowsKeyCode: 40, key: 'ArrowDown', code: 'ArrowDown' },
  left: { windowsKeyCode: 37, key: 'ArrowLeft', code: 'ArrowLeft' },
  right: { windowsKeyCode: 39, key: 'ArrowRight', code: 'ArrowRight' },
  home: { windowsKeyCode: 36, key: 'Home', code: 'Home' },
  end: { windowsKeyCode: 35, key: 'End', code: 'End' },
  delete: { windowsKeyCode: 46, key: 'Delete', code: 'Delete' },
  del: { windowsKeyCode: 46, key: 'Delete', code: 'Delete' },
  pageup: { windowsKeyCode: 33, key: 'PageUp', code: 'PageUp' },
  pagedown: { windowsKeyCode: 34, key: 'PageDown', code: 'PageDown' },
  space: { windowsKeyCode: 32, key: ' ', code: 'Space' },
}

function mapCdpKey(raw: string): { windowsKeyCode: number; key: string; code: string } | Error {
  const name = raw.trim()
  if (!name) return new Error('key must be a non-empty string')
  const named = KEY_CODES[name.toLowerCase()]
  if (named) return { ...named }
  if (name.length === 1) {
    return { windowsKeyCode: name.toUpperCase().charCodeAt(0), key: name, code: '' }
  }
  return new Error(
    `unknown key "${name}" (supported: enter tab escape backspace arrowup arrowdown arrowleft arrowright home end delete pageup pagedown space, or a single character)`,
  )
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const browserToolsPlugin: Plugin = {
  name: 'tool-browser',
  description: 'Browser control tools (navigate, screenshot, click, type, key, evaluate) via CDP',
  inject: ['tools'],
  apply(ctx, config: BrowserToolsConfig | undefined, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const cfg: ResolvedBrowserConfig = {
      chromePath: typeof config?.chromePath === 'string' && config.chromePath.trim() ? config.chromePath.trim() : undefined,
      headless: config?.headless !== false,
      defaultTimeoutMs:
        typeof config?.defaultTimeoutMs === 'number' && config.defaultTimeoutMs > 0
          ? config.defaultTimeoutMs
          : DEFAULT_TIMEOUT_MS,
    }

    // Lazy singleton state: at most one live browser per plugin instance.
    let session: BrowserSession | null = null
    let launching: Promise<BrowserSession> | null = null
    let disposed = false

    const closeBrowser = async (): Promise<void> => {
      const current = session
      session = null
      launching = null
      if (current) await teardownBrowser(current)
    }

    const getBrowser = (): Promise<BrowserSession> => {
      if (disposed) return Promise.reject(new Error('browser plugin is disposed'))
      if (session && !session.dead && !session.torndown) return Promise.resolve(session)
      if (launching) return launching
      launching = launchBrowser(cfg)
        .then((started) => {
          if (disposed) {
            void teardownBrowser(started)
            throw new Error('browser plugin is disposed')
          }
          session = started
          return started
        })
        .finally(() => {
          launching = null
        })
      return launching
    }

    tools.register({
      name: 'browser_navigate',
      description:
        'Open a URL in the shared browser page and wait up to 15 s for the load event ' +
        '(a slow page is reported in the output, not an error). Returns the page title.',
      kind: 'execute',
      parameters: params({ url: { type: 'string', description: 'Absolute URL to navigate to' } }, ['url']),
      execute: async (args, tc) => {
        const url = String(args.url ?? '').trim()
        if (!url) return errorResult('url must be a non-empty string')
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          // Register the load listener BEFORE navigating so the event cannot slip by.
          const loaded = s.conn.waitEvent('Page.loadEventFired', LOAD_EVENT_TIMEOUT_MS)
          await s.conn.send('Page.navigate', { url }, { timeoutMs: cfg.defaultTimeoutMs, signal: tc.signal })
          const inTime = await loaded
          let title = ''
          try {
            title = String((await evalValue(s.conn, 'document.title', tc.signal)) ?? '')
          } catch {
            // keep the empty title
          }
          return { output: `navigated to ${url} — ${title}${inTime ? '' : ' (page not fully loaded)'}` }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_screenshot',
      description:
        'Capture the browser page as a PNG image (data URL). fullPage: true captures the entire ' +
        'scrollable page instead of just the viewport.',
      kind: 'read',
      parameters: params({
        fullPage: { type: 'boolean', description: 'true to capture the full scrollable page (default: viewport only)' },
      }),
      execute: async (args, tc) => {
        const fullPage = args.fullPage === true || args.fullPage === 'true'
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          const res = await s.conn.send(
            'Page.captureScreenshot',
            { format: 'png', captureBeyondViewport: fullPage },
            { timeoutMs: cfg.defaultTimeoutMs, signal: tc.signal },
          )
          const data = res?.data
          if (typeof data !== 'string' || !data) {
            return errorResult('screenshot failed: no image data returned')
          }
          let size: { w: number; h: number }
          try {
            size = parsePngSize(Buffer.from(data, 'base64'))
          } catch {
            return errorResult('screenshot failed: browser returned invalid PNG data')
          }
          const url = await evalValue(s.conn, 'location.href', tc.signal).catch(() => '')
          return { output: `screenshot ${size.w}x${size.h} (${url})`, images: [`data:image/png;base64,${data}`] }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_click',
      description:
        'Click on the page: either a CSS selector (clicks the element center) or page coordinates ' +
        '(x, y) in CSS pixels. button: "left" (default) or "right".',
      kind: 'execute',
      parameters: params({
        x: { type: 'integer', description: 'X in CSS pixels (>= 0); required unless selector is given' },
        y: { type: 'integer', description: 'Y in CSS pixels (>= 0); required unless selector is given' },
        button: { type: 'string', enum: ['left', 'right'], description: 'default "left"' },
        selector: { type: 'string', description: 'CSS selector — clicks the element center instead of x/y' },
      }),
      execute: async (args, tc) => {
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          const button = args.button === 'right' ? 'right' : 'left'
          let x: number
          let y: number
          let where: string
          const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
          if (selector) {
            const center = await selectorCenter(s.conn, selector, tc.signal)
            if (!center) return errorResult(`no element matches selector "${selector}"`)
            x = center.x
            y = center.y
            where = selector
          } else {
            const ix = getInt(args, 'x', 0)
            if (ix instanceof Error) return errorResult(ix.message)
            const iy = getInt(args, 'y', 0)
            if (iy instanceof Error) return errorResult(iy.message)
            x = ix
            y = iy
            where = `${x}, ${y}`
          }
          await dispatchClick(s.conn, x, y, button, { timeoutMs: cfg.defaultTimeoutMs, signal: tc.signal })
          return { output: `clicked ${button} at ${where}` }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_type',
      description:
        'Type text into the page via Input.insertText (like an IME). With a CSS selector the element ' +
        'is clicked first to give it focus; without one, text goes to the focused element.',
      kind: 'execute',
      parameters: params(
        {
          text: { type: 'string', description: 'Text to type' },
          selector: { type: 'string', description: 'CSS selector of the element to focus before typing' },
        },
        ['text'],
      ),
      execute: async (args, tc) => {
        const text = String(args.text ?? '')
        if (!text) return errorResult('text must be a non-empty string')
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
          let where = 'focused element'
          if (selector) {
            const center = await selectorCenter(s.conn, selector, tc.signal)
            if (!center) return errorResult(`no element matches selector "${selector}"`)
            await dispatchClick(s.conn, center.x, center.y, 'left', {
              timeoutMs: cfg.defaultTimeoutMs,
              signal: tc.signal,
            })
            where = selector
          }
          await s.conn.send('Input.insertText', { text }, { timeoutMs: cfg.defaultTimeoutMs, signal: tc.signal })
          return { output: `typed ${text.length} characters into ${where}` }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_key',
      description:
        'Press a key in the page. Named keys: enter tab escape backspace arrowup arrowdown arrowleft ' +
        'arrowright home end delete pageup pagedown space (aliases: esc, up/down/left/right, del), or any single character.',
      kind: 'execute',
      parameters: params({ key: { type: 'string', description: 'Key name, e.g. "enter", "arrowdown", "end"' } }, ['key']),
      execute: async (args, tc) => {
        const key = String(args.key ?? '')
        const mapped = mapCdpKey(key)
        if (mapped instanceof Error) return errorResult(mapped.message)
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          const event = { key: mapped.key, code: mapped.code, windowsKeyCode: mapped.windowsKeyCode }
          await s.conn.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...event }, {
            timeoutMs: cfg.defaultTimeoutMs,
            signal: tc.signal,
          })
          await s.conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...event }, {
            timeoutMs: cfg.defaultTimeoutMs,
            signal: tc.signal,
          })
          return { output: `pressed ${key.trim() || mapped.key}` }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_evaluate',
      description:
        'Evaluate a JavaScript expression in the page (Runtime.evaluate, returnByValue, awaitPromise) ' +
        'and return the JSON-stringified result. Errors (including rejected promises) come back as tool errors.',
      kind: 'execute',
      parameters: params(
        { expression: { type: 'string', description: 'JavaScript expression to evaluate, e.g. "document.title"' } },
        ['expression'],
      ),
      execute: async (args, tc) => {
        const expression = String(args.expression ?? '')
        if (!expression.trim()) return errorResult('expression must be a non-empty string')
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const s = await getBrowser()
          const value = await evalValue(s.conn, expression, tc.signal)
          if (value === undefined) return { output: 'undefined' }
          return { output: JSON.stringify(value) ?? String(value) }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    tools.register({
      name: 'browser_close',
      description:
        'Close the shared browser: close the page, kill the browser process and delete its temporary ' +
        'profile. Safe to call when the browser is not running; the next browser_* call relaunches it.',
      kind: 'execute',
      parameters: params({}),
      execute: async (_args, tc) => {
        if (tc.signal.aborted) return errorResult('cancelled')
        try {
          const wasRunning = session !== null
          await closeBrowser()
          return { output: wasRunning ? 'browser closed' : 'browser closed (was not running)' }
        } catch (error) {
          return errorResult(toErrorMessage(error))
        }
      },
    })

    ctx.effect(() => () => {
      disposed = true
      void closeBrowser()
    })
  },
}
