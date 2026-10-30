/** Private stdio bridge for the Windows GUI launcher. Secrets never enter argv or URLs. */
import { createInterface } from 'node:readline'
import { stat } from 'node:fs/promises'
import * as path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { loadConfig } from '../config.js'
import { APPROVAL_MODES, type ApprovalMode } from '../core/approval.js'
import { isLoopbackHost } from '../web/access.js'
import { runWebServer, type DesktopSettingsState, type WebServerHandle, type WorkspacePrefs } from '../web/server.js'
import { randomUUID } from 'node:crypto'
import { parseWeixinSaved, type WeixinSaved } from '../integrations/weixin.js'
import { parseSakuraApiSaved, type SakuraApiSaved } from '../integrations/sakuraapi.js'
import { validateContextBudget } from '../util/context.js'
import { parseQuotaDisplay, type DesktopAppearance } from '../util/appearance.js'
import { validateRetryPolicy, type RetryPolicy } from '../util/retry.js'
import { parseUpdateSettings, type UpdateSettings } from '../updates.js'
import { parseDesktopViewport, type DesktopViewport } from '../util/viewport.js'

export interface DesktopLaunch {
  cwd: string
  baseURL?: string
  model?: string
  apiKey?: string
  approvalMode: ApprovalMode
  /** Recent workspaces offered in the settings view (launcher-side state). */
  recentWorkspaces?: string[]
  /** Whether the launcher has an encrypted key saved (initial checkbox state). */
  rememberKey?: boolean
  /** Default parent directory for newly created workspaces. */
  newWorkspaceDir?: string
  /** Per-workspace prefs keyed by absolute path (sessionDir / agents). */
  workspacePrefs?: Record<string, WorkspacePrefs>
  /** Decrypted by the launcher and passed only through the private pipe. */
  weixin?: WeixinSaved
  sakuraApi?: SakuraApiSaved
  appearance?: DesktopAppearance
  retry?: RetryPolicy
  updates?: UpdateSettings
}

export function parseDesktopLaunch(value: unknown): DesktopLaunch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid desktop launch settings')
  const row = value as Record<string, unknown>
  if (typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || row.cwd.includes('\0')) {
    throw new Error('desktop workspace must be an absolute directory path')
  }
  const result: DesktopLaunch = { cwd: path.resolve(row.cwd), approvalMode: 'default' }
  if (row.baseURL !== undefined && row.baseURL !== '') {
    if (typeof row.baseURL !== 'string') throw new Error('invalid model API URL')
    let url: URL
    try { url = new URL(row.baseURL) } catch { throw new Error('invalid model API URL') }
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
      url.username || url.password || url.search || url.hash) {
      throw new Error('model API URL must use HTTPS (HTTP is allowed only for a local model), without credentials, query or fragment')
    }
    result.baseURL = url.href.replace(/\/$/, '')
  }
  if (row.model !== undefined && row.model !== '') {
    if (typeof row.model !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(row.model)) throw new Error('invalid model name')
    result.model = row.model
  }
  if (row.apiKey !== undefined && row.apiKey !== '') {
    if (typeof row.apiKey !== 'string' || row.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(row.apiKey)) {
      throw new Error('invalid model API key')
    }
    result.apiKey = row.apiKey
  }
  if (row.approvalMode !== undefined) {
    if (!APPROVAL_MODES.includes(row.approvalMode as ApprovalMode)) throw new Error('invalid desktop approval mode')
    result.approvalMode = row.approvalMode as ApprovalMode
  }
  if (row.recentWorkspaces !== undefined) {
    if (row.recentWorkspaces === null || !Array.isArray(row.recentWorkspaces) || row.recentWorkspaces.some((entry) => typeof entry !== 'string' || !path.isAbsolute(entry) || entry.includes('\0'))) {
      throw new Error('invalid recent workspaces')
    }
    result.recentWorkspaces = row.recentWorkspaces.map((entry) => path.resolve(entry))
  }
  if (row.rememberKey !== undefined) {
    if (typeof row.rememberKey !== 'boolean') throw new Error('invalid rememberKey flag')
    result.rememberKey = row.rememberKey
  }
  if (row.newWorkspaceDir !== undefined && row.newWorkspaceDir !== '') {
    if (typeof row.newWorkspaceDir !== 'string' || !path.isAbsolute(row.newWorkspaceDir) || row.newWorkspaceDir.includes('\0')) {
      throw new Error('invalid new workspace directory')
    }
    result.newWorkspaceDir = path.resolve(row.newWorkspaceDir)
  }
  if (row.workspacePrefs !== undefined && row.workspacePrefs !== null) {
    if (typeof row.workspacePrefs !== 'object' || Array.isArray(row.workspacePrefs)) throw new Error('invalid workspace prefs')
    const prefs: Record<string, WorkspacePrefs> = {}
    for (const [key, value] of Object.entries(row.workspacePrefs as Record<string, unknown>)) {
      if (typeof key !== 'string' || !path.isAbsolute(key) || key.includes('\0')) throw new Error('invalid workspace prefs key')
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid workspace prefs entry')
      const entry = value as Record<string, unknown>
      const parsed: WorkspacePrefs = {}
      if (entry.sessionDir !== undefined && entry.sessionDir !== '') {
        if (typeof entry.sessionDir !== 'string' || /[\x00-\x1f\x7f]/.test(entry.sessionDir)) throw new Error('invalid sessionDir')
        parsed.sessionDir = entry.sessionDir
      }
      if (entry.agents !== undefined && entry.agents !== null) {
        if (!Array.isArray(entry.agents) || entry.agents.some((name) => typeof name !== 'string' || !name)) throw new Error('invalid workspace agents')
        parsed.agents = entry.agents as string[]
      }
      if (entry.contextBudget !== undefined) parsed.contextBudget = validateContextBudget(entry.contextBudget)
      prefs[path.resolve(key)] = parsed
    }
    result.workspacePrefs = prefs
  }
  if (row.weixin != null) result.weixin = parseWeixinSaved(row.weixin)
  if (row.sakuraApi != null) result.sakuraApi = parseSakuraApiSaved(row.sakuraApi)
  if (row.appearance != null) {
    if (typeof row.appearance !== 'object' || Array.isArray(row.appearance)) throw new Error('invalid desktop appearance')
    const appearance = row.appearance as Record<string, unknown>
    if (Object.keys(appearance).some(key => key !== 'quotaDisplay')) throw new Error('invalid desktop appearance fields')
    result.appearance = { quotaDisplay: parseQuotaDisplay(appearance.quotaDisplay) }
  }
  if (row.retry != null) result.retry = validateRetryPolicy(row.retry)
  if (row.updates != null) result.updates = parseUpdateSettings(row.updates)
  return result
}

/**
 * Start the web server for one workspace. `onPersistSettings` receives the
 * settings view's changes so the launcher can persist them (DPAPI for the
 * key) over the private stdout pipe.
 */
export async function startDesktopHost(
  launch: DesktopLaunch,
  onPersistSettings?: (settings: DesktopSettingsState) => void,
  onPersistWeixin?: (settings: WeixinSaved) => Promise<void>,
  onWindowAction?: (action: 'minimize' | 'maximize' | 'close' | 'drag' | 'reflow' | 'ready') => void,
  onPersistSakuraApi?: (settings: SakuraApiSaved | null) => Promise<void>,
  onPersistContextBudget?: (settings: DesktopSettingsState) => Promise<void>,
  onPersistAppearance?: (settings: DesktopAppearance) => Promise<void>,
  onPersistRetry?: (settings: RetryPolicy) => Promise<void>,
  onPersistUpdates?: (settings: UpdateSettings) => Promise<void>,
): Promise<WebServerHandle> {
  // Validate again for callers other than the stdio transport.
  const settings = parseDesktopLaunch(launch)
  if (!(await stat(settings.cwd)).isDirectory()) throw new Error('desktop workspace is not a directory')
  const config = await loadConfig({ cwd: settings.cwd })
  return runWebServer({
    ...settings,
    // An old saved key/URL is preserved on disk but never used by this product.
    sakuraApiOnly: true,
    config: { ...config, web: undefined },
    host: '127.0.0.1', port: 0, token: null, viewerToken: null,
    open: false, quiet: true,
    recentWorkspaces: settings.recentWorkspaces,
    desktopRememberKey: settings.rememberKey,
    onPersistSettings,
    onPersistWeixin,
    onWindowAction,
    onPersistSakuraApi,
    onPersistContextBudget,
    onPersistAppearance,
    onPersistRetry,
    onPersistUpdates,
  })
}

/** A closed parent pipe is also a shutdown request, including during asynchronous startup. */
export async function runDesktopHost(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const lines = createInterface({ input, crlfDelay: Infinity })
  let received = false
  let stopping = false
  let accept!: (settings: DesktopLaunch) => void
  let fail!: (error: Error) => void
  let stop!: () => void
  let handle: WebServerHandle | undefined
  let lastViewport: DesktopViewport | null = null
  const writes = new Map<string, { type: string; resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  const persistSecure = (type: string, settings: unknown): Promise<void> => new Promise((resolve, reject) => {
    const id = randomUUID()
    const timer = setTimeout(() => { writes.delete(id); reject(new Error('desktop secure storage acknowledgement timed out')) }, 10_000)
    timer.unref()
    writes.set(id, { type, resolve, reject, timer })
    try { output.write(JSON.stringify({ type, id, settings }) + '\n') }
    catch { clearTimeout(timer); writes.delete(id); reject(new Error('desktop secure storage pipe closed')) }
  })
  const launch = new Promise<DesktopLaunch>((resolve, reject) => { accept = resolve; fail = reject })
  const stopped = new Promise<void>((resolve) => { stop = resolve })
  const shutdown = () => {
    stopping = true
    for (const pending of writes.values()) { clearTimeout(pending.timer); pending.reject(new Error('desktop launcher disconnected')) }
    writes.clear()
    stop()
    if (!received) fail(new Error('desktop launcher disconnected before startup'))
  }
  const timer = setTimeout(() => fail(new Error('desktop launch handshake timed out')), 15_000)
  lines.on('line', (line) => {
    if (received) {
      if (line === 'shutdown') { shutdown(); return }
      if (line.length <= 4096) {
        try {
          const reply = JSON.parse(line) as { type?: string; id?: string; ok?: boolean; viewport?: unknown }
          if (reply.type === 'desktop/viewport') {
            const viewport = parseDesktopViewport(reply.viewport)
            if (viewport && viewport.version > (lastViewport?.version ?? 0)) { lastViewport = viewport; handle?.updateDesktopViewport(viewport) }
            return
          }
          if (typeof reply.type === 'string' && typeof reply.id === 'string') {
            const pending = writes.get(reply.id)
            if (pending && reply.type === pending.type + '/saved') {
              writes.delete(reply.id)
              clearTimeout(pending.timer)
              if (reply.ok === true) pending.resolve()
              else pending.reject(new Error('desktop secure storage failed'))
            }
          }
        } catch { /* Other parent messages cannot acknowledge a settings write. */ }
      }
      return
    }
    received = true
    clearTimeout(timer)
    try {
      if (line.length > 65_536) throw new Error('desktop launch settings are too large')
      let value: unknown
      try { value = JSON.parse(line) } catch { throw new Error('invalid desktop launch JSON') }
      accept(parseDesktopLaunch(value))
    } catch (error) { fail(error instanceof Error ? error : new Error('invalid desktop launch settings')) }
  })
  lines.once('close', shutdown)
  input.once('error', shutdown)
  output.once('error', shutdown)
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  try {
    const settings = await launch
    if (stopping) return
    // A workspace must not be committed or reported as saved until the
    // launcher confirms its atomic disk write on this private pipe.
    handle = await startDesktopHost(settings, settings => persistSecure('desktop/settings', settings),
    settings => persistSecure('desktop/weixin', settings), action => {
      output.write(JSON.stringify({ type: 'desktop/window', action }) + '\n')
    }, settings => persistSecure('desktop/sakuraapi', settings), settings => persistSecure('desktop/context-settings', settings),
    settings => persistSecure('desktop/appearance', settings), settings => persistSecure('desktop/retry', settings),
    settings => persistSecure('desktop/updates', settings))
    if (stopping) return
    if (lastViewport) handle.updateDesktopViewport(lastViewport)
    output.write(JSON.stringify({ type: 'desktop/ready', url: handle.url, pid: process.pid }) + '\n')
    await stopped
  } finally {
    clearTimeout(timer)
    lines.off('close', shutdown)
    lines.close()
    input.off('error', shutdown)
    output.off('error', shutdown)
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    await handle?.close()
  }
}