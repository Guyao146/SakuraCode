/** Default-enabled desktop usage counts. Never accepts account, workspace or conversation data. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import * as path from 'node:path'
import { isLoopbackHost } from '../web/access.js'

export const DEFAULT_STATISTICS_ENDPOINT = 'https://web.mcylyr.cn/api/collect'
export const DEFAULT_STATISTICS_APP_ID = '00f1f158e0bf1d00e84fd321'
export const STATISTICS_QUEUE_LIMIT = 512
const STATE_LIMIT = 512 * 1024
const RESPONSE_LIMIT = 64 * 1024
const MAX_AGE = 7 * 24 * 60 * 60_000
const ACTIVE_INTERVAL = 5 * 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/

export interface StatisticsSettings {
  enabled: boolean
  endpoint: string
  appId: string
}

export function defaultStatisticsSettings(): StatisticsSettings {
  return { enabled: true, endpoint: DEFAULT_STATISTICS_ENDPOINT, appId: DEFAULT_STATISTICS_APP_ID }
}

export function parseStatisticsSettings(value: unknown): StatisticsSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的匿名统计设置。')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 3 || Object.keys(row).some(key => !['enabled', 'endpoint', 'appId'].includes(key)) ||
      typeof row.enabled !== 'boolean' || typeof row.endpoint !== 'string' || typeof row.appId !== 'string') {
    throw new Error('匿名统计设置必须包含开关、服务地址和应用 ID。')
  }
  const endpoint = row.endpoint.trim(), appId = row.appId.trim()
  if (!endpoint || endpoint.length > 2048 || /[\x00-\x20\x7f\\]/.test(endpoint)) throw new Error('统计地址必须是有效的 HTTPS 采集地址。')
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error('统计地址必须是有效的 HTTPS 采集地址。') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/api/collect' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname)))) {
    throw new Error('统计地址须使用 HTTPS 和 /api/collect，不含凭据、查询或片段；HTTP 仅限本机测试。')
  }
  if (appId && !/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('应用 ID 必须是 1–128 位字母、数字、短横线或下划线。')
  return { enabled: row.enabled, endpoint: url.href, appId }
}

export interface StatisticsEvent {
  schema_version: 1
  event_id: string
  event_type: 'app_start' | 'active'
  occurred_at: string
  anonymous_id: string
  session_id: string
  app_version: string
  platform: string
  sdk_version: 'sakuracode-desktop/1'
}

export interface StatisticsStored {
  schemaVersion: 1
  settings: StatisticsSettings
  anonymousId: string | null
  events: StatisticsEvent[]
  dropped: number
  rejected: number
}

export interface StatisticsStore {
  read(): Promise<unknown | null>
  write(value: StatisticsStored): Promise<void>
}

/** An independent app-data file, not settings.json, account storage or project data. */
export class StatisticsFileStore implements StatisticsStore {
  private readonly file: string
  constructor(private readonly directory: string) {
    if (!path.isAbsolute(directory) || directory.includes('\0')) throw new Error('Statistics storage requires an absolute directory')
    this.file = path.join(directory, 'state.json')
  }
  async read(): Promise<unknown | null> {
    try {
      if ((await stat(this.file)).size > STATE_LIMIT) throw new Error('Statistics state exceeds its size limit')
      const bytes = await readFile(this.file)
      if (bytes.length > STATE_LIMIT) throw new Error('Statistics state exceeds its size limit')
      return JSON.parse(bytes.toString('utf8')) as unknown
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  async write(value: StatisticsStored): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8')
    if (bytes.length > STATE_LIMIT) throw new Error('Statistics state exceeds its size limit')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temp = this.file + '.' + randomUUID() + '.tmp'
    try {
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      await rename(temp, this.file)
    } finally { await unlink(temp).catch(() => {}) }
  }
}

function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function metadataText(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && !!value && Buffer.byteLength(value, 'utf8') <= bytes && !/[\x00-\x1f\x7f]/.test(value)
}

/** Reject tampered/private fields rather than uploading arbitrary persisted JSON. */
export function parseStatisticsStored(value: unknown): StatisticsStored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid statistics state')
  const row = value as Record<string, unknown>
  if (Object.keys(row).length !== 6 || Object.keys(row).some(key => !['schemaVersion', 'settings', 'anonymousId', 'events', 'dropped', 'rejected'].includes(key)) ||
      row.schemaVersion !== 1 || !count(row.dropped) || !count(row.rejected) ||
      !Array.isArray(row.events) || row.events.length > STATISTICS_QUEUE_LIMIT) throw new Error('Invalid statistics state')
  const settings = parseStatisticsSettings(row.settings)
  if (row.anonymousId !== null && (typeof row.anonymousId !== 'string' || !UUID.test(row.anonymousId))) throw new Error('Invalid anonymous identity')
  const collecting = settings.enabled && !!settings.appId
  if ((!collecting && (row.anonymousId !== null || row.events.length)) || (collecting && !row.anonymousId)) throw new Error('Invalid consent state')
  const ids = new Set<string>()
  const events = row.events.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stored event')
    const event = value as Record<string, unknown>
    if (Object.keys(event).length !== 9 || Object.keys(event).some(key => !['schema_version', 'event_id', 'event_type', 'occurred_at',
      'anonymous_id', 'session_id', 'app_version', 'platform', 'sdk_version'].includes(key)) || event.schema_version !== 1 ||
      typeof event.event_type !== 'string' || !['app_start', 'active'].includes(event.event_type) || typeof event.event_id !== 'string' || !UUID.test(event.event_id) || ids.has(event.event_id) ||
      event.anonymous_id !== row.anonymousId || typeof event.session_id !== 'string' || !UUID.test(event.session_id) ||
      typeof event.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.occurred_at) || !Number.isFinite(Date.parse(event.occurred_at)) ||
      new Date(event.occurred_at).toISOString() !== event.occurred_at ||
      !metadataText(event.app_version, 128) || !VERSION.test(event.app_version) || typeof event.platform !== 'string' || !['windows', 'linux', 'macos'].includes(event.platform) || event.sdk_version !== 'sakuracode-desktop/1') {
      throw new Error('Invalid stored event')
    }
    ids.add(event.event_id)
    return { ...event } as unknown as StatisticsEvent
  })
  return { schemaVersion: 1, settings, anonymousId: row.anonymousId as string | null, events, dropped: row.dropped, rejected: row.rejected }
}

export interface StatisticsStatus {
  ready: boolean
  settings: StatisticsSettings
  pending: number
  dropped: number
  rejected: number
  lastError: string | null
  lastSentAt: string | null
}

export interface DesktopStatisticsOptions {
  directory?: string
  store?: StatisticsStore
  appVersion: string
  fetch?: typeof globalThis.fetch
  changed?: (status: StatisticsStatus) => void
  /** Offline tests only; the product uses a bounded background sender. */
  autoFlush?: boolean
  clock?: { now(): number; monotonic(): number }
  timeoutMs?: number
}

function freshState(settings = defaultStatisticsSettings()): StatisticsStored {
  return { schemaVersion: 1, settings, anonymousId: settings.enabled && settings.appId ? randomUUID() : null, events: [], dropped: 0, rejected: 0 }
}

/** Only errors created here may carry a diagnostic message to the settings UI. */
class StatisticsDeliveryError extends Error {}

/** HTTP 200 alone is not an acknowledgement. Invalid/partial replies retain the batch. */
export function validateStatisticsAcknowledgement(value: unknown, ids: readonly string[]): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collect acknowledgement')
  const row = value as Record<string, unknown>
  if (!count(row.accepted) || !count(row.duplicates) || !Array.isArray(row.rejected) ||
      row.accepted + row.duplicates + row.rejected.length !== ids.length) throw new Error('Incomplete collect acknowledgement')
  const rejected = new Set<string>()
  for (const value of row.rejected) {
    const entry = value as Record<string, unknown> | null
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.event_id !== 'string' ||
        !ids.includes(entry.event_id) || rejected.has(entry.event_id) || typeof entry.code !== 'string' || !/^[a-z0-9_]{1,64}$/.test(entry.code)) {
      throw new Error('Invalid rejected event acknowledgement')
    }
    rejected.add(entry.event_id)
  }
  return rejected.size
}

export class DesktopStatistics {
  private readonly store: StatisticsStore
  private readonly fetcher: typeof globalThis.fetch
  private readonly clock: { now(): number; monotonic(): number }
  private readonly listeners = new Set<(status: StatisticsStatus) => void>()
  private readonly sessionId = randomUUID()
  private readonly platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'
  // Do not create an installation identity before loading an existing opt-out.
  private state = freshState({ ...defaultStatisticsSettings(), enabled: false })
  private ready = false
  private closed = false
  private paused = false
  private storageBlocked = false
  private readonly started = new Set<string>()
  private activePending = false
  private lastActive: { day: string; tick: number } | null = null
  private lastError: string | null = null
  private lastSentAt: string | null = null
  private generation = 0
  private failures = 0
  private nextAttempt = 0
  private tail: Promise<void> = Promise.resolve()
  private initialization?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private flight?: Promise<boolean>
  private controller?: AbortController

  constructor(private readonly options: DesktopStatisticsOptions) {
    if (!options.store && !options.directory) throw new Error('Statistics require an isolated app-data store')
    if (!metadataText(options.appVersion, 128) || !VERSION.test(options.appVersion)) {
      throw new Error('Statistics require the product version, not user-supplied metadata')
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 10_000)) {
      throw new Error('Statistics timeout must be between zero and ten seconds')
    }
    this.store = options.store ?? new StatisticsFileStore(options.directory!)
    this.fetcher = options.fetch ?? globalThis.fetch
    this.clock = options.clock ?? { now: Date.now, monotonic: () => performance.now() }
    if (options.changed) this.listeners.add(options.changed)
  }

  status(): StatisticsStatus {
    return { ready: this.ready, settings: { ...this.state.settings }, pending: this.state.events.length,
      dropped: this.state.dropped, rejected: this.state.rejected, lastError: this.lastError, lastSentAt: this.lastSentAt }
  }

  onChange(listener: (status: StatisticsStatus) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    if (this.closed) return
    for (const listener of this.listeners) { try { listener(this.status()) } catch { /* Statistics cannot break its host. */ } }
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run)
    this.tail = next.then(() => {}, () => {})
    return next
  }

  /** Tests and diagnostics can await local I/O; the GUI and exit path never wait on network. */
  whenIdle(): Promise<void> { return this.tail }

  private event(type: StatisticsEvent['event_type']): StatisticsEvent {
    return { schema_version: 1, event_id: randomUUID(), event_type: type, occurred_at: new Date(this.clock.now()).toISOString(),
      anonymous_id: this.state.anonymousId!, session_id: this.sessionId, app_version: this.options.appVersion,
      platform: this.platform, sdk_version: 'sakuracode-desktop/1' }
  }

  private prune(state: StatisticsStored): StatisticsStored {
    const events = state.events.filter(event => this.clock.now() - Date.parse(event.occurred_at) <= MAX_AGE)
    return { ...state, events, dropped: state.dropped + state.events.length - events.length }
  }

  private async commit(state: StatisticsStored): Promise<void> {
    await this.store.write(state)
    if (this.closed) return
    this.state = state
    this.storageBlocked = false
  }

  /** Missing preferences use product defaults; persisted opt-out and empty IDs remain silent. */
  start(): Promise<void> {
    if (this.initialization) return this.initialization
    if (this.closed) return Promise.resolve()
    this.initialization = this.serial(async () => {
      try {
        const saved = await this.store.read()
        if (this.closed) return
        this.state = saved === null ? freshState() : parseStatisticsStored(saved)
        if (this.state.settings.enabled && this.state.settings.appId) {
          const next = this.prune(this.state)
          if (next.events.length < STATISTICS_QUEUE_LIMIT) next.events = [...next.events, this.event('app_start')]
          else next.dropped++
          await this.commit(next)
          if (!this.closed) this.started.add(this.state.settings.endpoint + '\n' + this.state.settings.appId)
        }
      } catch {
        this.storageBlocked = true
        this.lastError = '匿名统计本地状态无法读取或保存，已暂停发送；可明确保存设置重试。'
      } finally {
        this.ready = true
        this.changed()
        this.schedule()
      }
    })
    return this.initialization
  }

  private stopSending(): void {
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort(new Error('Statistics sending cancelled'))
  }

  /** Preferences are committed before a sender starts; failed writes retain previous choices. */
  async configure(value: unknown): Promise<StatisticsStatus> {
    const settings = parseStatisticsSettings(value)
    if (this.closed) throw new Error('Statistics are closed')
    if (!this.ready || this.paused) throw new Error('Statistics settings are not ready')
    this.paused = true
    this.stopSending()
    try {
      await this.serial(async () => {
        if (this.closed) throw new Error('Statistics are closed')
        const before = this.state
        const same = settings.endpoint === before.settings.endpoint && settings.appId === before.settings.appId
        let next = settings.enabled && before.settings.enabled && same ? this.prune({ ...before, settings }) : freshState(settings)
        const target = settings.endpoint + '\n' + settings.appId
        const needsStart = settings.enabled && !!settings.appId && !this.started.has(target)
        if (needsStart) {
          const event = { ...this.event('app_start'), anonymous_id: next.anonymousId! }
          if (next.events.length < STATISTICS_QUEUE_LIMIT) next = { ...next, events: [...next.events, event] }
          else next = { ...next, dropped: next.dropped + 1 }
        }
        await this.commit(next)
        if (this.closed) throw new Error('Statistics are closed')
        if (!settings.enabled || !same || !before.settings.enabled) this.lastActive = null
        if (needsStart) this.started.add(target)
        this.lastError = null
        this.lastSentAt = same && settings.enabled ? this.lastSentAt : null
        this.failures = 0
        this.nextAttempt = 0
      })
      return this.status()
    } catch {
      throw new Error('无法保存匿名统计设置，原设置保留；未启用新的发送。')
    } finally {
      this.paused = false
      this.changed()
      this.schedule()
    }
  }

  /** Called only by a real visible user action. No automatic active heartbeat. */
  markActive(): void {
    if (!this.ready || this.closed || this.paused || this.storageBlocked || !this.state.settings.enabled || !this.state.settings.appId || this.activePending) return
    this.activePending = true
    void this.serial(async () => {
      try {
        if (this.closed || this.paused || !this.state.settings.enabled || !this.state.settings.appId) return
        const day = new Date(this.clock.now() + 8 * 60 * 60_000).toISOString().slice(0, 10)
        const tick = this.clock.monotonic()
        if (this.lastActive?.day === day && tick - this.lastActive.tick < ACTIVE_INTERVAL) return
        let next = this.prune(this.state)
        if (next.events.length < STATISTICS_QUEUE_LIMIT) next = { ...next, events: [...next.events, this.event('active')] }
        else next = { ...next, dropped: next.dropped + 1 }
        await this.commit(next)
        if (!this.closed) this.lastActive = { day, tick }
        this.changed()
        this.schedule()
      } catch {
        this.storageBlocked = true
        this.lastError = '匿名统计本地保存失败，已暂停发送；主任务不受影响。'
        this.changed()
      } finally { this.activePending = false }
    })
  }

  private canSend(generation: number): boolean {
    return !this.closed && !this.paused && !this.storageBlocked && this.ready &&
      this.state.settings.enabled && !!this.state.settings.appId && generation === this.generation
  }

  private async collect(settings: StatisticsSettings, events: StatisticsEvent[], signal: AbortSignal): Promise<number> {
    signal.throwIfAborted()
    const response = await this.fetcher(settings.endpoint, { method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'SakuraCode/' + this.options.appVersion },
      body: JSON.stringify({ app_id: settings.appId, events }), credentials: 'omit', redirect: 'error', signal })
    if (signal.aborted) { void response.body?.cancel().catch(() => {}); signal.throwIfAborted() }
    if (response.status !== 200 || response.redirected) {
      void response.body?.cancel().catch(() => {})
      throw new StatisticsDeliveryError('统计服务返回 HTTP ' + response.status + '；原批次保留，稍后退避重试。')
    }
    if (Number(response.headers.get('content-length')) > RESPONSE_LIMIT || !response.body) {
      void response.body?.cancel().catch(() => {})
      throw new StatisticsDeliveryError('统计服务确认超出限制或缺失，原批次保留。')
    }
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    const cancel = (): void => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let size = 0, text = ''
    try {
      for (;;) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > RESPONSE_LIMIT) throw new Error('Statistics acknowledgement too large')
        text += decoder.decode(value, { stream: true })
      }
      text += decoder.decode()
      return validateStatisticsAcknowledgement(JSON.parse(text) as unknown, events.map(event => event.event_id))
    } catch {
      cancel()
      throw new StatisticsDeliveryError('统计服务确认不完整或无效，原批次保留。')
    } finally {
      signal.removeEventListener('abort', cancel)
      reader.releaseLock()
    }
  }

  /** One bounded attempt. Concurrent calls share it; new events cannot bypass failure backoff. */
  flushOnce(): Promise<boolean> {
    if (this.flight) return this.flight
    const generation = this.generation
    if (!this.canSend(generation)) return Promise.resolve(false)
    if (this.clock.monotonic() < this.nextAttempt) {
      // A timer may fire just before the monotonic deadline. Retain a wakeup
      // instead of leaving offline events stalled until the next interaction.
      this.schedule(Math.max(1, Math.ceil(this.nextAttempt - this.clock.monotonic())))
      return Promise.resolve(false)
    }
    if (!this.state.events.length) return Promise.resolve(true)
    const controller = new AbortController()
    this.controller = controller
    const attempt = this.sendBatch(generation, controller)
    const flight = attempt.finally(() => {
      if (this.flight === flight) this.flight = undefined
      if (this.controller === controller) this.controller = undefined
      // Actions can arm a normal timer while the request is in flight. Replace
      // that timer with the now-known backoff (or the next normal batch delay).
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.schedule()
    })
    this.flight = flight
    return flight
  }

  private async sendBatch(generation: number, controller: AbortController): Promise<boolean> {
    let storageFailure = false
    try {
      const batch = await this.serial(async () => {
        if (!this.canSend(generation)) return null
        const next = this.prune(this.state)
        if (next.dropped !== this.state.dropped) {
          try { await this.commit(next) } catch { storageFailure = true; throw new Error('Statistics storage failed') }
        }
        return { settings: { ...this.state.settings }, events: this.state.events.slice(0, 50).map(event => ({ ...event })) }
      })
      if (!batch || !this.canSend(generation)) return false
      if (!batch.events.length) { this.changed(); return true }
      const timer = setTimeout(() => controller.abort(new Error('Statistics request timed out')), this.options.timeoutMs ?? 5_000)
      timer.unref()
      let stop!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = (): void => reject(new Error('Statistics request cancelled or timed out'))
        controller.signal.addEventListener('abort', stop, { once: true })
        if (controller.signal.aborted) stop()
      })
      let rejected: number
      try { rejected = await Promise.race([this.collect(batch.settings, batch.events, controller.signal), aborted]) }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', stop) }
      if (!this.canSend(generation)) return false
      return await this.serial(async () => {
        if (!this.canSend(generation)) return false
        const ids = new Set(batch.events.map(event => event.event_id))
        const next = { ...this.state, events: this.state.events.filter(event => !ids.has(event.event_id)), rejected: this.state.rejected + rejected }
        try { await this.commit(next) } catch { storageFailure = true; throw new Error('Statistics storage failed') }
        if (!this.canSend(generation)) return false
        this.failures = 0; this.nextAttempt = 0
        this.lastSentAt = new Date(this.clock.now()).toISOString()
        this.lastError = rejected ? '统计服务明确拒绝了 ' + rejected + ' 条事件，已从待发队列移除。' : null
        this.changed()
        return true
      })
    } catch (error) {
      if (this.closed || this.paused || generation !== this.generation) return false
      if (storageFailure) {
        this.storageBlocked = true
        this.lastError = '匿名统计本地保存失败，未删除原批次；已暂停发送，主任务不受影响。'
      } else {
        // Never surface provider response text, system paths, cookies or exception causes.
        this.lastError = error instanceof StatisticsDeliveryError ? error.message : '匿名统计网络请求失败或超时，原批次保留；主任务不受影响。'
        this.failures = Math.min(6, this.failures + 1)
        const delay = Math.min(60_000, 1000 * 2 ** this.failures)
        this.nextAttempt = this.clock.monotonic() + delay + Math.floor(Math.random() * delay * .2)
      }
      this.changed()
      return false
    }
  }

  private schedule(delay = 10_000): void {
    if (this.options.autoFlush === false || this.timer || !this.ready || this.closed || this.paused || this.storageBlocked ||
        !this.state.settings.enabled || !this.state.settings.appId || !this.state.events.length) return
    this.timer = setTimeout(() => { this.timer = undefined; void this.flushOnce() }, Math.max(delay, this.nextAttempt - this.clock.monotonic()))
    this.timer.unref()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stopSending()
    this.listeners.clear()
    // Already persisted, unacknowledged events remain for the next enabled launch.
    // No exit flush, waiting for HTTP, or new app-exit event.
  }
}