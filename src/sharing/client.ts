/** Explicit, workspace-bound owner connection to the restricted sharing relay. */
import { isSessionId } from '../core/session.js'
import { projectSharedWorkspace, sanitizeSharedText } from '../web/sharing.js'
import {
  SHARE_LIMITS, isShareId, registrationToken, shareDigest, shareOrigin, shareSecret, validShareRole,
  type ShareCreated, type ShareDevice, type ShareEvent, type SharePublish, type ShareReply,
  type ShareRequest, type ShareRole, type ShareStatus, type SharedHistory, type SharedWorkspace,
} from './protocol.js'

export interface WorkspaceShareClientOptions {
  fetch?: typeof fetch
  workspace(): Promise<SharedWorkspace>
  request(request: ShareRequest, assertActive: () => void): Promise<ShareReply>
  changed(status: ShareStatus): void
  now?: () => number
  inviteMs?: number
  shareMs?: number
}

class InactiveShare extends Error {
  constructor() { super('工作区连接已失效。') }
}
class RelayFailure extends Error {
  constructor(readonly status?: number) { super('中转请求未能完成。') }
}
interface Operation {
  signature: string
  pending: boolean
  result: Promise<ShareReply>
}
interface Connection {
  generation: number
  controller: AbortController
  origin: string
  workspaceId: string
  expiresAt: number
  roomId?: string
  ownerToken?: string
  phase: ShareStatus['phase']
  error?: string
  inviteUrl?: string
  inviteExpiresAt?: number
  inviteVersion: number
  devices: Map<string, ShareDevice>
  roles: Map<string, ShareRole>
  revoked: Set<string>
  knownDevices: Set<string>
  versions: Map<string, number>
  operations: Map<string, Operation>
  publishTail: Promise<void>
  controlTail: Promise<void>
  snapshotWanted: boolean
  eventWanted?: ShareEvent
  refreshing?: Promise<void>
  subscription?: AbortController
  reader?: ReadableStreamDefaultReader<Uint8Array>
  reconnectAttempt: number
  expiryTimer?: ReturnType<typeof setTimeout>
  inviteTimer?: ReturnType<typeof setTimeout>
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !value.includes('..')
}
function duration(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum
  if (!Number.isFinite(value) || value <= 0) throw new Error('工作区连接有效期无效。')
  return Math.min(value, maximum)
}
function publicText(value: unknown, limit: number): string {
  return typeof value === 'string' ? sanitizeSharedText(value.slice(0, limit)).slice(0, limit) : ''
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(new InactiveShare()) }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(new InactiveShare()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => {
      signal.removeEventListener('abort', abort); reject(error)
    })
  })
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new InactiveShare()); return }
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new InactiveShare()) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Line/frame limits apply across chunks, including split CRLF and UTF-8 sequences. */
class OwnerSseParser {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private line = ''
  private lineBytes = 0
  private frameBytes = 0
  private skipLf = false
  private data: string[] = []
  private event = ''
  constructor(private readonly receive: (value: unknown) => void) {}
  push(chunk: Uint8Array): void {
    // Decode bounded slices rather than materializing an arbitrarily large transport chunk.
    for (let offset = 0; offset < chunk.length; offset += 4096) {
      const text = this.decoder.decode(chunk.subarray(offset, offset + 4096), { stream: true })
      let start = 0
      for (let i = 0; i < text.length; i++) {
        const character = text[i]
        if (this.skipLf) {
          this.skipLf = false
          if (character === '\n') { start = i + 1; continue }
        }
        if (character !== '\n' && character !== '\r') continue
        this.append(text.slice(start, i))
        this.finishLine()
        this.skipLf = character === '\r'
        start = i + 1
      }
      this.append(text.slice(start))
    }
  }
  private append(value: string): void {
    this.lineBytes += Buffer.byteLength(value)
    if (this.lineBytes + this.frameBytes > SHARE_LIMITS.frameBytes) throw new RelayFailure()
    this.line += value
  }
  private finishLine(): void {
    const line = this.line
    this.frameBytes += this.lineBytes + 1
    this.line = ''; this.lineBytes = 0
    if (this.frameBytes > SHARE_LIMITS.frameBytes) throw new RelayFailure()
    if (!line) {
      const data = this.data.join('\n'), event = this.event
      this.data = []; this.event = ''; this.frameBytes = 0
      if (!data) return
      let value: unknown
      try { value = JSON.parse(data) } catch { throw new RelayFailure() }
      const record = object(value)
      if (event && event !== 'message') {
        if (!['hello', 'device', 'request', 'closed'].includes(event)) return
        if (record.type !== undefined && record.type !== event) throw new RelayFailure()
        value = { ...record, type: event }
      }
      this.receive(value)
      return
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    else if (field === 'event') this.event = value
  }
}

export class WorkspaceShareClient {
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private readonly inviteMs: number
  private readonly shareMs: number
  private generation = 0
  private permanentlyClosed = false
  private active?: Connection
  private state: ShareStatus = { phase: 'idle', devices: [] }

  constructor(private readonly options: WorkspaceShareClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.inviteMs = duration(options.inviteMs, SHARE_LIMITS.inviteMs)
    this.shareMs = duration(options.shareMs, SHARE_LIMITS.shareMs)
  }

  status(): ShareStatus {
    const run = this.active
    if (run && this.now() >= run.expiresAt) void this.stop()
    else if (run?.inviteUrl && this.now() >= (run.inviteExpiresAt ?? 0)) this.clearInvite(run)
    return { ...this.state, devices: this.state.devices.map(device => ({ ...device })) }
  }

  async start(input: { relayOrigin: string; registrationToken: string; workspaceId: string }): Promise<ShareStatus> {
    if (this.permanentlyClosed) throw new InactiveShare()
    const origin = shareOrigin(input.relayOrigin), token = registrationToken(input.registrationToken)
    if (!identifier(input.workspaceId)) throw new Error('工作区标识无效。')
    // stop() invalidates synchronously; cleanup of the previous room cannot write new status.
    void this.stop()
    const run: Connection = {
      generation: ++this.generation, controller: new AbortController(), origin, workspaceId: input.workspaceId,
      expiresAt: this.now() + this.shareMs, phase: 'connecting', inviteVersion: 0,
      devices: new Map(), roles: new Map(), revoked: new Set(), knownDevices: new Set(), versions: new Map(),
      operations: new Map(), publishTail: Promise.resolve(), controlTail: Promise.resolve(), snapshotWanted: false, reconnectAttempt: 0,
    }
    this.active = run
    this.emit(run)
    this.armExpiry(run)
    const secret = shareSecret(), inviteExpiresAt = Math.min(this.now() + this.inviteMs, run.expiresAt)
    try {
      await this.workspace(run)
      const raw = object(await this.json(`${origin}/api/rooms`, 'POST', token, {
        inviteHash: shareDigest(secret), inviteExpiresAt, expiresAt: run.expiresAt,
      }, run.controller.signal))
      this.assertSession(run)
      if (!isShareId(raw.roomId) || typeof raw.ownerToken !== 'string' ||
          !/^[\x21-\x7e]{1,2048}$/.test(raw.ownerToken) || typeof raw.expiresAt !== 'number' ||
          !Number.isFinite(raw.expiresAt) || raw.expiresAt <= this.now()) throw new RelayFailure()
      const created = raw as unknown as ShareCreated
      run.roomId = created.roomId; run.ownerToken = created.ownerToken
      run.expiresAt = Math.min(run.expiresAt, created.expiresAt)
      run.inviteExpiresAt = Math.min(inviteExpiresAt, run.expiresAt)
      run.inviteUrl = `${origin}/connect/${run.roomId}#invite=${secret}`
      this.armExpiry(run); this.armInvite(run); this.emit(run)
      void this.subscribe(run)
      await this.refresh()
      this.assertSession(run)
      return this.status()
    } catch (error) {
      if (this.current(run)) {
        if (run.roomId) this.offline(run)
        else {
          await this.stop()
          if (!this.active && this.generation === run.generation + 1 && !this.permanentlyClosed) {
            this.state = { phase: 'error', error: '无法创建工作区连接，请检查中转地址、网络和注册凭据。', devices: [] }
            this.notify()
          }
        }
      }
      throw error instanceof InactiveShare ? error : new RelayFailure()
    }
  }

  async stop(): Promise<void> {
    const run = this.active
    this.active = undefined
    this.generation++
    if (!run) {
      if (this.state.phase !== 'idle') { this.state = { phase: 'idle', devices: [] }; this.notify() }
      return
    }
    run.controller.abort()
    run.subscription?.abort()
    if (run.reader) void run.reader.cancel().catch(() => {})
    clearTimeout(run.expiryTimer); clearTimeout(run.inviteTimer)
    run.operations.clear(); run.roles.clear(); run.devices.clear(); run.snapshotWanted = false
    run.inviteUrl = undefined; run.eventWanted = undefined
    this.state = { phase: 'idle', devices: [] }
    this.notify()
    if (run.roomId && run.ownerToken) {
      // A stopped share is never restarted/retried, even when deletion fails.
      try { await this.json(`${run.origin}/api/rooms/${run.roomId}`, 'DELETE', run.ownerToken, undefined, undefined, 5000) } catch {}
    }
    run.ownerToken = undefined
  }

  async close(): Promise<void> {
    this.permanentlyClosed = true
    await this.stop()
  }

  async rotateInvite(): Promise<ShareStatus> {
    const run = this.requireSession(), version = ++run.inviteVersion, secret = shareSecret()
    const inviteExpiresAt = Math.min(this.now() + this.inviteMs, run.expiresAt)
    this.clearInvite(run)
    await this.control(run, async () => {
      if (version !== run.inviteVersion) throw new InactiveShare()
      await this.ownerJson(run, '/invite', { inviteHash: shareDigest(secret), inviteExpiresAt })
    })
    this.assertSession(run)
    if (version !== run.inviteVersion) throw new InactiveShare()
    run.inviteUrl = `${run.origin}/connect/${run.roomId}#invite=${secret}`
    run.inviteExpiresAt = inviteExpiresAt
    this.armInvite(run); this.emit(run)
    return this.status()
  }

  async setDevice(input: { id: string; role?: ShareRole; revoke?: boolean }): Promise<ShareStatus> {
    const run = this.requireSession()
    if (!isShareId(input.id) || !(input.revoke === true || validShareRole(input.role))) throw new Error('设备或权限无效。')
    const device = run.devices.get(input.id)
    if (!device && !run.revoked.has(input.id)) throw new Error('设备不存在。')
    if (input.revoke !== true && input.role === 'controller' && (!device?.online || run.phase !== 'online' || run.revoked.has(input.id))) {
      throw new InactiveShare()
    }
    const version = this.bump(run, input.id)
    // Local authority is removed before any await, and only a guarded successful POST can grant it.
    run.roles.delete(input.id)
    if (input.revoke === true) { run.revoked.add(input.id); run.devices.delete(input.id) }
    else if (device) run.devices.set(input.id, { ...device, role: 'viewer' })
    this.emit(run)
    await this.control(run, async () => {
      if (run.versions.get(input.id) !== version) throw new InactiveShare()
      await this.ownerJson(run, '/device', input.revoke === true ? { id: input.id, revoke: true } : { id: input.id, role: input.role })
    })
    this.assertSession(run)
    if (run.versions.get(input.id) !== version) throw new InactiveShare()
    if (input.revoke !== true && input.role === 'controller') {
      const current = run.devices.get(input.id)
      if (!current?.online || run.phase !== 'online' || run.revoked.has(input.id)) throw new InactiveShare()
      run.roles.set(input.id, 'controller')
      run.devices.set(input.id, { ...current, role: 'controller' })
    }
    this.emit(run)
    return this.status()
  }

  observe(_event: ShareEvent): void {
    const run = this.active
    if (!run) return
    // Phone notifications are invalidations, never raw streaming text/tool payloads.
    run.eventWanted = { type: 'changed' }
    void this.refresh().catch(() => {})
  }

  refresh(): Promise<void> {
    const run = this.active
    if (!run) return Promise.resolve()
    try { this.assertSession(run) } catch { return Promise.resolve() }
    if (!run.roomId) { run.snapshotWanted = true; return Promise.resolve() }
    run.snapshotWanted = true
    if (run.refreshing) return run.refreshing
    const task = (async (): Promise<void> => {
      await Promise.resolve() // Coalesce changes in the current event/microtask batch.
      let first = true
      while (run.snapshotWanted && this.current(run)) {
        if (!first) await delay(50, run.controller.signal)
        first = false
        run.snapshotWanted = false
        const event = run.eventWanted
        run.eventWanted = undefined
        await this.publish(run, event ? { event } : {}, undefined, true)
      }
    })()
    run.refreshing = task
    void task.then(() => { if (run.refreshing === task) run.refreshing = undefined }, () => {
      if (run.refreshing === task) run.refreshing = undefined
      if (this.current(run)) { run.snapshotWanted = true; this.offline(run) }
    })
    return task
  }

  private current(run: Connection): boolean {
    return this.active === run && this.generation === run.generation && !run.controller.signal.aborted && !this.permanentlyClosed
  }
  private assertSession(run: Connection): void {
    if (!this.current(run)) throw new InactiveShare()
    if (this.now() >= run.expiresAt) { void this.stop(); throw new InactiveShare() }
  }
  private requireSession(): Connection {
    const run = this.active
    if (!run?.roomId || !run.ownerToken) throw new InactiveShare()
    this.assertSession(run)
    return run
  }
  private emit(run: Connection): void {
    if (!this.current(run)) return
    this.state = {
      phase: run.phase, relayOrigin: run.origin, roomId: run.roomId, workspaceId: run.workspaceId,
      expiresAt: run.expiresAt, inviteExpiresAt: run.inviteExpiresAt, inviteUrl: run.inviteUrl,
      devices: [...run.devices.values()].map(device => ({ ...device })), ...(run.error ? { error: run.error } : {}),
    }
    this.notify()
  }
  private notify(): void {
    try { this.options.changed({ ...this.state, devices: this.state.devices.map(device => ({ ...device })) }) } catch {}
  }
  private bump(run: Connection, id: string): number {
    const version = (run.versions.get(id) ?? 0) + 1
    run.versions.set(id, version)
    return version
  }
  private offline(run: Connection): void {
    if (!this.current(run)) return
    for (const [id, device] of run.devices) {
      if (device.online) this.bump(run, id)
      run.devices.set(id, { ...device, online: false })
    }
    run.phase = 'offline'; run.error = '与中转的连接已中断，正在等待重新连接。'
    this.emit(run)
    run.subscription?.abort()
  }
  private armExpiry(run: Connection): void {
    clearTimeout(run.expiryTimer)
    if (!this.current(run)) return
    run.expiryTimer = setTimeout(() => {
      if (!this.current(run)) return
      if (this.now() >= run.expiresAt) void this.stop()
      else this.armExpiry(run)
    }, Math.max(1, run.expiresAt - this.now()))
    run.expiryTimer.unref?.()
  }
  private clearInvite(run: Connection): void {
    clearTimeout(run.inviteTimer)
    run.inviteUrl = undefined; run.inviteExpiresAt = undefined
    this.emit(run)
  }
  private armInvite(run: Connection): void {
    clearTimeout(run.inviteTimer)
    run.inviteTimer = setTimeout(() => {
      if (!this.current(run)) return
      if (this.now() >= (run.inviteExpiresAt ?? 0)) this.clearInvite(run)
      else this.armInvite(run)
    }, Math.max(1, (run.inviteExpiresAt ?? 0) - this.now()))
    run.inviteTimer.unref?.()
  }
  private async workspace(run: Connection): Promise<SharedWorkspace> {
    this.assertSession(run)
    const value = await abortable(this.options.workspace(), run.controller.signal)
    this.assertSession(run)
    // Check the source identity BEFORE projecting/uploading any other context.
    if (value.workspaceId !== run.workspaceId) { void this.stop(); throw new InactiveShare() }
    return projectSharedWorkspace(value as unknown as Record<string, unknown>)
  }

  private async json(url: string, method: string, token: string, body?: unknown, parent?: AbortSignal, timeout: number = SHARE_LIMITS.requestMs): Promise<unknown> {
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    if (serialized !== undefined && Buffer.byteLength(serialized) > SHARE_LIMITS.frameBytes) throw new RelayFailure()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    parent?.addEventListener('abort', abort, { once: true })
    if (parent?.aborted) controller.abort()
    const timer = setTimeout(abort, timeout)
    timer.unref?.()
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      const response = await abortable(this.fetcher(url, {
        method, credentials: 'omit', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, ...(serialized === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(serialized === undefined ? {} : { body: serialized }),
      }), controller.signal)
      if (response.redirected) throw new RelayFailure()
      const length = response.headers.get('content-length')
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > SHARE_LIMITS.frameBytes)) throw new RelayFailure()
      const chunks: Uint8Array[] = []
      let bytes = 0
      reader = response.body?.getReader()
      if (reader) {
        for (;;) {
          const chunk = await abortable(reader.read(), controller.signal)
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > SHARE_LIMITS.frameBytes) throw new RelayFailure()
          chunks.push(chunk.value)
        }
      }
      if (!response.ok) throw new RelayFailure(response.status)
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return undefined
      try { return JSON.parse(text) as unknown } catch { throw new RelayFailure() }
    } finally {
      clearTimeout(timer); parent?.removeEventListener('abort', abort)
      if (reader) void reader.cancel().catch(() => {})
    }
  }
  private ownerJson(run: Connection, path: string, body: unknown): Promise<unknown> {
    this.assertSession(run)
    if (!run.roomId || !run.ownerToken) throw new InactiveShare()
    return this.json(`${run.origin}/api/rooms/${run.roomId}${path}`, 'POST', run.ownerToken, body, run.controller.signal)
  }
  private control(run: Connection, action: () => Promise<void>): Promise<void> {
    const task = run.controlTail.then(async () => {
      this.assertSession(run)
      await this.workspace(run)
      this.assertSession(run)
      await action()
    })
    run.controlTail = task.catch(() => {})
    return task
  }
  private publish(run: Connection, payload: SharePublish, guard?: () => void, snapshot = false): Promise<void> {
    const task = run.publishTail.then(async () => {
      this.assertSession(run); guard?.()
      const workspace = await this.workspace(run)
      this.assertSession(run); guard?.()
      await this.ownerJson(run, '/publish', snapshot ? { ...payload, snapshot: workspace } : payload)
      this.assertSession(run); guard?.()
    })
    run.publishTail = task.catch(() => {})
    return task
  }

  private async subscribe(run: Connection): Promise<void> {
    while (this.current(run)) {
      const controller = new AbortController()
      const abort = (): void => controller.abort()
      run.controller.signal.addEventListener('abort', abort, { once: true })
      run.subscription = controller
      const timer = setTimeout(abort, SHARE_LIMITS.requestMs)
      timer.unref?.()
      try {
        this.assertSession(run)
        const response = await abortable(this.fetcher(`${run.origin}/api/rooms/${run.roomId}/owner/events`, {
          method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${run.ownerToken}`, Accept: 'text/event-stream' },
        }), controller.signal)
        // Only connecting has a timeout; a healthy SSE subscription is indefinite.
        clearTimeout(timer)
        if (!response.ok || response.redirected || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw new RelayFailure()
        const reader = response.body.getReader()
        run.reader = reader
        const parser = new OwnerSseParser(value => this.ownerEvent(run, value))
        try {
          while (this.current(run)) {
            const chunk = await abortable(reader.read(), controller.signal)
            if (chunk.done) throw new RelayFailure()
            this.assertSession(run)
            parser.push(chunk.value)
          }
        } finally {
          if (run.reader === reader) run.reader = undefined
          void reader.cancel().catch(() => {})
        }
      } catch {
        if (this.current(run)) this.offline(run)
      } finally {
        clearTimeout(timer)
        run.controller.signal.removeEventListener('abort', abort)
        if (run.subscription === controller) run.subscription = undefined
        controller.abort()
      }
      if (!this.current(run)) return
      const backoff = Math.min(5000, 250 * 2 ** Math.min(run.reconnectAttempt++, 5))
      try { await delay(backoff, run.controller.signal) } catch { return }
    }
  }

  private ownerEvent(run: Connection, value: unknown): void {
    if (!this.current(run)) return
    this.assertSession(run)
    const event = object(value)
    if (event.type === 'hello') {
      for (const id of run.devices.keys()) this.bump(run, id)
      run.devices.clear() // Presence is rebuilt, but explicit local grants survive reconnects.
      run.phase = 'online'; run.error = undefined; run.reconnectAttempt = 0
      this.emit(run)
      void this.refresh().catch(() => {})
    } else if (event.type === 'device') {
      const source = object(event.device)
      if (!isShareId(source.id) || typeof source.name !== 'string' || !validShareRole(source.role) ||
          typeof source.online !== 'boolean' || typeof source.connectedAt !== 'number' || !Number.isFinite(source.connectedAt)) throw new RelayFailure()
      if (run.revoked.has(source.id)) return
      if (!run.devices.has(source.id) && run.devices.size >= SHARE_LIMITS.devices) return
      const previous = run.devices.get(source.id)
      if (!previous || previous.online !== source.online) this.bump(run, source.id)
      if (source.online && !run.knownDevices.has(source.id)) { run.knownDevices.add(source.id); ++run.inviteVersion; this.clearInvite(run) }
      run.devices.set(source.id, {
        id: source.id, name: publicText(source.name, SHARE_LIMITS.nameChars), online: source.online,
        connectedAt: source.connectedAt, role: run.roles.get(source.id) === 'controller' ? 'controller' : 'viewer',
      })
      this.emit(run)
    } else if (event.type === 'request') {
      void this.handleRequest(run, event.request).catch(() => {})
    } else if (event.type === 'closed') void this.stop()
  }

  private requestGuard(run: Connection, request: ShareRequest, version: number, control = true): () => void {
    const workspaceId = run.workspaceId, generation = run.generation
    return () => {
      this.assertSession(run)
      const device = run.devices.get(request.deviceId)
      if (generation !== this.generation || run.workspaceId !== workspaceId || run.phase !== 'online' ||
          !device?.online || run.revoked.has(request.deviceId) || run.versions.get(request.deviceId) !== version ||
          control && (request.kind === 'message' || request.kind === 'stop') && run.roles.get(request.deviceId) !== 'controller') throw new InactiveShare()
    }
  }
  private async handleRequest(run: Connection, value: unknown): Promise<void> {
    const raw = object(value)
    if (!isShareId(raw.requestId) || !isShareId(raw.deviceId) || !isShareId(raw.operationId)) return
    const request: ShareRequest = {
      requestId: raw.requestId, deviceId: raw.deviceId, operationId: raw.operationId,
      kind: raw.kind as ShareRequest['kind'],
      ...(raw.sessionId === undefined ? {} : { sessionId: raw.sessionId as string }),
      ...(raw.kind === 'message' ? { text: raw.text as string } : {}),
    }
    const version = run.versions.get(request.deviceId) ?? 0
    const presence = this.requestGuard(run, request, version, false)
    try { presence() } catch { return }
    let reply: ShareReply
    const guard = this.requestGuard(run, request, version)
    if (!['state', 'history', 'message', 'stop'].includes(request.kind) ||
        request.sessionId !== undefined && !isSessionId(request.sessionId) ||
        request.kind === 'message' && (typeof request.text !== 'string' || !request.text.trim() || request.text.length > SHARE_LIMITS.taskChars)) {
      reply = { status: 400, error: '无效的工作区请求。' }
    } else if ((request.kind === 'message' || request.kind === 'stop') && run.roles.get(request.deviceId) !== 'controller') {
      reply = { status: 403, error: '此设备只有查看权限。' }
    } else {
      const key = `${request.deviceId}:${request.operationId}`
      const signature = JSON.stringify({ kind: request.kind, sessionId: request.sessionId, text: request.text })
      let operation = run.operations.get(key)
      if (operation && operation.signature !== signature) reply = { status: 409, error: '操作标识已用于其他请求。' }
      else {
        if (!operation) {
          if ([...run.operations.values()].filter(item => item.pending).length >= SHARE_LIMITS.pending) {
            reply = { status: 429, error: '待处理请求过多。' }
            await this.publish(run, { response: { requestId: request.requestId, ...reply } }, presence)
            return
          }
          if (run.operations.size >= SHARE_LIMITS.operations) {
            const oldest = [...run.operations].find(([, item]) => !item.pending)
            if (oldest) run.operations.delete(oldest[0])
          }
          operation = { signature, pending: true, result: this.performRequest(run, request, guard) }
          run.operations.set(key, operation)
          const captured = operation
          void captured.result.then(() => { captured.pending = false }, () => { captured.pending = false })
        }
        reply = await operation.result
        guard()
      }
    }
    presence()
    try { await this.publish(run, { response: { requestId: request.requestId, ...reply } }, presence) } catch {
      if (this.current(run)) this.offline(run)
    }
  }
  private async performRequest(run: Connection, request: ShareRequest, guard: () => void): Promise<ShareReply> {
    try {
      guard()
      const workspace = await this.workspace(run) // Revalidate the mounted workspace immediately before the async action.
      guard()
      if ((request.kind === 'message' || request.kind === 'stop') && (request.sessionId ?? null) !== workspace.sessionId) {
        return { status: 409, error: '会话已改变，请刷新后重试。' }
      }
      const reply = await abortable(this.options.request(request, guard), run.controller.signal)
      guard()
      await this.workspace(run)
      guard()
      return this.projectReply(run, request, reply)
    } catch (error) {
      if (error instanceof InactiveShare) throw error
      guard()
      const rejectedStatus = object(error).status
      const status = typeof rejectedStatus === 'number' && Number.isInteger(rejectedStatus) && rejectedStatus >= 400 && rejectedStatus <= 599
        ? rejectedStatus : 500
      return { status, error: '工作区请求未能完成，请在电脑上检查。' }
    }
  }
  private projectReply(run: Connection, request: ShareRequest, reply: ShareReply): ShareReply {
    const status = Number.isInteger(reply.status) && reply.status >= 200 && reply.status <= 599 ? reply.status : 502
    const result: ShareReply = { status }
    if (reply.error) result.error = publicText(reply.error, 1000)
    if (reply.data === undefined || status >= 400) return result
    const source = object(reply.data)
    if (request.kind === 'state') {
      if (source.workspaceId !== run.workspaceId) { void this.stop(); throw new InactiveShare() }
      result.data = projectSharedWorkspace(source)
    } else if (request.kind === 'history') {
      if (!isSessionId(source.sessionId) || request.sessionId !== undefined && source.sessionId !== request.sessionId) return { status: 502, error: '会话记录无效。' }
      const history: SharedHistory = { sessionId: source.sessionId, entries: [], truncated: source.truncated === true }
      let bytes = 0
      for (const value of Array.isArray(source.entries) ? source.entries : []) {
        const entry = object(value)
        if (!['user', 'assistant', 'expert', 'tool', 'note'].includes(String(entry.kind))) continue
        const text = publicText(entry.text, SHARE_LIMITS.taskChars)
        bytes += Buffer.byteLength(text)
        if (history.entries.length >= SHARE_LIMITS.historyEntries || bytes > SHARE_LIMITS.historyChars) { history.truncated = true; break }
        history.entries.push({
          seq: Number.isSafeInteger(entry.seq) && Number(entry.seq) >= 0 ? Number(entry.seq) : 0,
          time: typeof entry.time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(entry.time) && Number.isFinite(Date.parse(entry.time)) ? entry.time : '',
          kind: entry.kind as SharedHistory['entries'][number]['kind'], text,
          ...(typeof entry.label === 'string' ? { label: publicText(entry.label, SHARE_LIMITS.nameChars) } : {}),
        })
      }
      result.data = history
    } else {
      result.data = {
        ok: typeof source.ok === 'boolean' ? source.ok : status < 400,
        ...(typeof source.queued === 'boolean' ? { queued: source.queued } : {}),
        ...(typeof source.message === 'string' ? { message: publicText(source.message, 1000) } : {}),
      }
    }
    return result
  }
}
