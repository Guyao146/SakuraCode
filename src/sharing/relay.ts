/** Memory-only, same-origin workspace relay. It never forwards arbitrary HTTP requests. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { isSessionId } from '../core/session.js'
import { isLoopbackHost } from '../web/access.js'
import { HttpError, readJson } from '../web/http.js'
import { projectSharedWorkspace, sanitizeSharedText } from '../web/sharing.js'
import {
  SHARE_LIMITS, isShareId, isShareSecret, registrationToken as validateRegistrationToken,
  shareDigest, shareId, shareOrigin, shareSecret, validShareRole,
  type ShareDevice, type ShareEvent, type SharedHistory, type SharedWorkspace, type ShareRequest,
} from './protocol.js'

export interface WorkspaceRelayOptions {
  registrationToken: string
  host?: string
  port?: number
  publicOrigin?: string
  mobileHtml?: string
  clock?: () => number
  requestTimeoutMs?: number
  heartbeatMs?: number
}

export interface WorkspaceRelay {
  url: string
  port: number
  server: Server
  sweep(): void
  close(): Promise<void>
}

type Reply = { status: number; body: unknown; wire: string }
type Peer = { res: ServerResponse; closed: boolean; onClose: () => void }
type Device = { public: ShareDevice; cookieHash: Buffer; streams: Set<Peer> }
type Operation = { fingerprint: string; pending?: Pending; reply?: Reply }
type Pending = {
  request: ShareRequest
  operation: Operation
  waiters: Map<ServerResponse, () => void>
  deadline: number
  timer: ReturnType<typeof setTimeout>
}
type Room = {
  id: string
  ownerHash: Buffer
  expiresAt: number
  inviteHash?: Buffer
  inviteExpiresAt: number
  owner?: Peer
  snapshot?: SharedWorkspace
  devices: Map<string, Device>
  pending: Map<string, Pending>
  operations: Map<string, Operation>
  cacheBytes: number
  reading: number
  mobileReading: number
}
type Session = { authenticated: boolean; device: ShareDevice | null; online: boolean; expiresAt: number }

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const ownObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const cleanText = (value: unknown, limit: number): string =>
  typeof value === 'string' ? sanitizeSharedText(value.slice(0, limit)).slice(0, limit) : ''
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !value.includes('..')
const timestamp = (value: unknown): string =>
  typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : ''
const MAX_CACHE_BYTES = SHARE_LIMITS.frameBytes * 4
const MAX_STREAMS_PER_DEVICE = 4

function keys(body: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HttpError(400, 'unsupported request field')
}
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) throw new Error('relay timeouts must be positive')
  return Math.min(value, fallback)
}
function encode(value: unknown): string {
  const wire = JSON.stringify(value)
  if (wire === undefined || Buffer.byteLength(wire) > SHARE_LIMITS.frameBytes) throw new HttpError(413, 'relay frame too large')
  return wire
}
function reply(status: number, body: unknown): Reply { return { status, body, wire: encode(body) } }
function workspace(value: unknown): SharedWorkspace {
  const source = object(value)
  // In particular, never pass cwd: the desktop projector otherwise derives the name from it.
  return projectSharedWorkspace({
    workspaceId: source.workspaceId, name: source.name, revision: source.revision,
    sessionId: source.sessionId, busy: source.busy, expertMode: source.expertMode,
    sessions: source.sessions, agents: source.agents, todos: source.todos,
  })
}
function history(value: unknown): SharedHistory {
  const source = object(value)
  const result: SharedHistory = {
    sessionId: isSessionId(source.sessionId) ? source.sessionId : '', entries: [], truncated: source.truncated === true,
  }
  const entries = Array.isArray(source.entries) ? source.entries : []
  let chars = 0, bytes = 0
  const kinds = new Set(['user', 'assistant', 'expert', 'tool', 'note'])
  // The input is already a history DTO, not SessionEventRecord[]. Rebuild its fields directly.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = object(entries[i])
    if (typeof entry.kind !== 'string' || !kinds.has(entry.kind) || typeof entry.text !== 'string') continue
    if (result.entries.length >= SHARE_LIMITS.historyEntries || chars >= SHARE_LIMITS.historyChars || bytes >= SHARE_LIMITS.historyChars) {
      result.truncated = true
      break
    }
    const limit = Math.min(SHARE_LIMITS.taskChars, SHARE_LIMITS.historyChars - chars)
    let text = cleanText(entry.text, limit)
    if (entry.text.length > limit) result.truncated = true
    if (Buffer.byteLength(text) > SHARE_LIMITS.historyChars - bytes) {
      let prefix = '', used = 0
      for (const character of text) {
        const size = Buffer.byteLength(character)
        if (used + size > SHARE_LIMITS.historyChars - bytes) break
        prefix += character
        used += size
      }
      text = prefix
      result.truncated = true
    }
    if (!text) continue
    const projected: SharedHistory['entries'][number] = {
      seq: typeof entry.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0 ? entry.seq : 0,
      time: timestamp(entry.time), kind: entry.kind as SharedHistory['entries'][number]['kind'], text,
    }
    if (typeof entry.label === 'string') projected.label = cleanText(entry.label, SHARE_LIMITS.nameChars)
    result.entries.push(projected)
    chars += text.length
    bytes += Buffer.byteLength(text)
  }
  result.entries.reverse()
  return result
}
function event(value: unknown): ShareEvent {
  const source = object(value)
  if (!['changed', 'text', 'turn', 'tool'].includes(String(source.type))) throw new HttpError(400, 'invalid share event')
  const result: ShareEvent = { type: source.type as ShareEvent['type'] }
  if (isSessionId(source.sessionId)) result.sessionId = source.sessionId
  if (identifier(source.agentId)) result.agentId = source.agentId
  if (typeof source.text === 'string') result.text = cleanText(source.text, SHARE_LIMITS.taskChars)
  if (typeof source.name === 'string') result.name = cleanText(source.name, SHARE_LIMITS.nameChars)
  return result
}
function request(body: Record<string, unknown>, deviceId: string): ShareRequest {
  keys(body, ['operationId', 'kind', 'sessionId', 'text'])
  if (!isShareId(body.operationId) || !['state', 'history', 'message', 'stop'].includes(String(body.kind))) {
    throw new HttpError(400, 'invalid workspace request')
  }
  if (body.sessionId !== undefined && !isSessionId(body.sessionId)) throw new HttpError(400, 'invalid session id')
  if (body.kind === 'history' && !isSessionId(body.sessionId)) throw new HttpError(400, 'history requires a session id')
  if (body.kind === 'message') {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > SHARE_LIMITS.taskChars) {
      throw new HttpError(400, 'message must contain 1-8000 characters')
    }
  } else if (body.text !== undefined) throw new HttpError(400, 'text is only supported for messages')
  const result: ShareRequest = {
    requestId: shareId(), deviceId, operationId: body.operationId, kind: body.kind as ShareRequest['kind'],
  }
  if (body.sessionId !== undefined) result.sessionId = body.sessionId as string
  if (body.text !== undefined) result.text = body.text as string
  return result
}
function htmlPolicy(html: string): string {
  const hashes = (tag: string): string[] => {
    const result: string[] = []
    const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')
    for (const match of html.matchAll(pattern)) {
      if (tag === 'script' && /\bsrc\s*=/i.test(match[1] ?? '')) continue
      result.push(`'sha256-${createHash('sha256').update(match[2] ?? '').digest('base64')}'`)
    }
    return [...new Set(result)]
  }
  return `default-src 'none'; script-src ${hashes('script').join(' ') || "'none'"}; style-src ${hashes('style').join(' ') || "'none'"}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'`
}

export async function runWorkspaceRelay(opts: WorkspaceRelayOptions): Promise<WorkspaceRelay> {
  const registrationHash = digest(validateRegistrationToken(opts.registrationToken))
  const host = (opts.host ?? '127.0.0.1').toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host))) throw new Error('relay host must be an IP address or hostname')
  const requestedPort = opts.port ?? 8787
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error('invalid relay port')
  let url = opts.publicOrigin === undefined ? '' : shareOrigin(opts.publicOrigin)
  if (!isLoopbackHost(host) && (!url || new URL(url).protocol !== 'https:')) {
    throw new Error('external relay binding requires an HTTPS publicOrigin')
  }
  if (opts.mobileHtml !== undefined && typeof opts.mobileHtml !== 'string') throw new Error('mobileHtml must be a string')
  if (opts.clock !== undefined && typeof opts.clock !== 'function') throw new Error('relay clock must be a function')
  const clock = opts.clock ?? Date.now
  const requestMs = positive(opts.requestTimeoutMs, SHARE_LIMITS.requestMs)
  const heartbeatMs = positive(opts.heartbeatMs, SHARE_LIMITS.heartbeatMs)
  const rooms = new Map<string, Room>()
  const attempts = new Map<string, { count: number; until: number }>()
  let registrations = 0, closing = false, closePromise: Promise<void> | undefined
  let mobilePage: Promise<{ html: string; policy: string }> | undefined

  const sendReply = (res: ServerResponse, result: Reply): void => {
    if (res.destroyed || res.writableEnded) return
    res.setTimeout(requestMs, () => res.destroy())
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(result.wire)
  }
  const json = (res: ServerResponse, status: number, body: unknown): void => sendReply(res, reply(status, body))
  const publicDevice = (device: Device): ShareDevice => ({ ...device.public })
  const session = (room: Room, device?: Device): Session => ({
    authenticated: !!device, device: device ? publicDevice(device) : null,
    online: !!room.owner && !room.owner.closed, expiresAt: room.expiresAt,
  })
  const endPeer = (peer: Peer): void => {
    if (peer.closed) return
    peer.closed = true
    peer.onClose()
    if (!peer.res.destroyed && !peer.res.writableEnded) peer.res.end()
  }
  const send = (peer: Peer | undefined, data: unknown): boolean => {
    if (!peer || peer.closed || peer.res.destroyed || peer.res.writableEnded) {
      if (peer) endPeer(peer)
      return false
    }
    const wire = `data: ${encode(data)}\n\n`
    if (Buffer.byteLength(wire) > SHARE_LIMITS.frameBytes || peer.res.writableLength + Buffer.byteLength(wire) > SHARE_LIMITS.frameBytes) {
      endPeer(peer)
      peer.res.destroy()
      return false
    }
    try { peer.res.write(wire); return true } catch { endPeer(peer); return false }
  }
  const notifyDevice = (room: Room, device: Device): void => {
    send(room.owner, { type: 'device', device: publicDevice(device) })
  }
  const statuses = (room: Room): void => {
    for (const device of room.devices.values()) {
      for (const peer of [...device.streams]) send(peer, { type: 'status', ...session(room, device) })
    }
  }
  const trimOperations = (room: Room, reserve = false, keep?: Operation): void => {
    for (const [key, operation] of room.operations) {
      if (room.operations.size < SHARE_LIMITS.operations + (reserve ? 0 : 1) && room.cacheBytes <= MAX_CACHE_BYTES) break
      if (operation.pending || operation === keep) continue
      if (operation.reply) room.cacheBytes -= Buffer.byteLength(operation.reply.wire)
      room.operations.delete(key)
    }
  }
  const complete = (room: Room, pending: Pending, result: Reply): void => {
    if (room.pending.get(pending.request.requestId) !== pending) return
    room.pending.delete(pending.request.requestId)
    clearTimeout(pending.timer)
    pending.operation.pending = undefined
    pending.operation.reply = result
    room.cacheBytes += Buffer.byteLength(result.wire)
    for (const [res, detach] of pending.waiters) {
      res.off('close', detach)
      sendReply(res, result)
    }
    pending.waiters.clear()
    trimOperations(room, false, pending.operation)
  }
  const failPending = (room: Room, status: number, error: string, filter: (pending: Pending) => boolean = () => true): void => {
    for (const pending of [...room.pending.values()]) if (filter(pending)) complete(room, pending, reply(status, { error }))
  }
  const ownerOffline = (room: Room, peer: Peer): void => {
    if (room.owner !== peer) return
    room.owner = undefined
    failPending(room, 503, 'workspace owner is offline')
    statuses(room)
  }
  const revoke = (room: Room, device: Device): void => {
    room.devices.delete(device.public.id)
    device.public.role = 'viewer'
    device.public.online = false
    failPending(room, 401, 'device access revoked', (pending) => pending.request.deviceId === device.public.id)
    for (const peer of [...device.streams]) {
      send(peer, { type: 'status', ...session(room) })
      endPeer(peer)
    }
    notifyDevice(room, device)
    for (const [key, operation] of room.operations) {
      if (key.startsWith(`${device.public.id}:`)) {
        if (operation.reply) room.cacheBytes -= Buffer.byteLength(operation.reply.wire)
        room.operations.delete(key)
      }
    }
    device.cookieHash.fill(0)
  }
  const closeRoom = (room: Room, reason: string, status = 410): void => {
    if (rooms.get(room.id) !== room) return
    rooms.delete(room.id)
    const owner = room.owner
    room.owner = undefined
    failPending(room, status, reason === 'expired' ? 'room expired' : 'room closed')
    send(owner, { type: 'closed', reason })
    if (owner) endPeer(owner)
    for (const device of room.devices.values()) {
      device.public.online = false
      for (const peer of [...device.streams]) {
        send(peer, { type: 'status', ...session(room) })
        endPeer(peer)
      }
      device.cookieHash.fill(0)
    }
    room.ownerHash.fill(0)
    room.inviteHash = undefined
    room.snapshot = undefined
    room.devices.clear()
    room.operations.clear()
    room.cacheBytes = 0
  }
  const sweep = (): void => {
    const now = clock()
    for (const room of [...rooms.values()]) {
      if (room.expiresAt <= now) { closeRoom(room, 'expired'); continue }
      if (room.inviteExpiresAt <= now) room.inviteHash = undefined
      for (const pending of [...room.pending.values()]) {
        if (pending.deadline <= now) complete(room, pending, reply(504, { error: 'workspace request timed out' }))
      }
    }
    for (const [address, attempt] of attempts) if (attempt.until <= now) attempts.delete(address)
  }
  const active = (room: Room): void => {
    if (room.expiresAt <= clock()) closeRoom(room, 'expired')
    if (closing || rooms.get(room.id) !== room) throw new HttpError(410, 'room is closed')
  }
  const getRoom = (id: string): Room => {
    const room = rooms.get(id)
    if (!room) throw new HttpError(404, 'room not found')
    active(room)
    return room
  }
  const bearer = (req: IncomingMessage, expected: Buffer, secret = false): void => {
    const value = req.headers.authorization
    const match = typeof value === 'string' && value.length <= 263 ? /^Bearer (\S+)$/i.exec(value) : null
    const token = match?.[1]
    if (!token || (secret && !isShareSecret(token)) || !timingSafeEqual(digest(token), expected)) {
      throw new HttpError(401, 'invalid authorization')
    }
  }
  const cookieName = (room: Room): string => `sakura_share_${room.id}`
  const cookie = (room: Room, token: string): string =>
    `${cookieName(room)}=${token}; Path=/api/rooms/${room.id}; HttpOnly; SameSite=Strict${url.startsWith('https:') ? '; Secure' : ''}${token ? `; Max-Age=${Math.max(1, Math.ceil((room.expiresAt - clock()) / 1000))}` : '; Max-Age=0'}`
  const deviceFor = (req: IncomingMessage, room: Room): Device | undefined => {
    const values = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${cookieName(room)}=`))
    if (values.length !== 1) return undefined
    const token = values[0]!.slice(cookieName(room).length + 1)
    if (!isShareSecret(token)) return undefined
    const hash = digest(token)
    for (const device of room.devices.values()) if (timingSafeEqual(hash, device.cookieHash)) return device
    return undefined
  }
  const requireDevice = (req: IncomingMessage, room: Room): Device => {
    const device = deviceFor(req, room)
    if (!device) throw new HttpError(401, 'device authentication required')
    return device
  }
  const beginJoin = (req: IncomingMessage, room: Room): void => {
    const now = clock(), address = `${room.id}:${req.socket.remoteAddress ?? 'unknown'}`
    for (const [key, attempt] of attempts) if (attempt.until <= now) attempts.delete(key)
    const attempt = attempts.get(address) ?? { count: 0, until: now + 60_000 }
    if (attempt.count >= 10 || (!attempts.has(address) && attempts.size >= 1024)) throw new HttpError(429, 'too many join attempts')
    attempt.count++
    attempts.set(address, attempt)
  }
  const expiry = (value: unknown, limit: number, roomExpiresAt = Infinity): number => {
    const now = clock()
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now || value > now + limit || value > roomExpiresAt) {
      throw new HttpError(400, 'invalid expiry')
    }
    return value
  }
  const bodyFor = async (req: IncomingMessage, room: Room, owner = false): Promise<Record<string, unknown>> => {
    // Reserve four body readers for revocation/control when mobile clients stall uploads.
    if (room.reading >= SHARE_LIMITS.pending || !owner && room.mobileReading >= SHARE_LIMITS.pending - 4) {
      throw new HttpError(429, 'too many concurrent requests')
    }
    room.reading++
    if (!owner) room.mobileReading++
    try {
      const body = await readJson(req, requestMs, SHARE_LIMITS.frameBytes)
      active(room)
      return body
    } finally { room.reading--; if (!owner) room.mobileReading-- }
  }
  const openPeer = (res: ServerResponse, onClose: () => void): Peer => {
    res.setTimeout(0)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    const peer: Peer = { res, closed: false, onClose }
    res.once('close', () => endPeer(peer))
    res.once('error', () => endPeer(peer))
    return peer
  }
  const waitersCount = (room: Room): number => {
    let count = 0
    for (const pending of room.pending.values()) count += pending.waiters.size
    return count
  }
  const addWaiter = (room: Room, pending: Pending, res: ServerResponse): void => {
    if (waitersCount(room) >= SHARE_LIMITS.pending) throw new HttpError(429, 'too many pending requests')
    const detach = (): void => { pending.waiters.delete(res) }
    pending.waiters.set(res, detach)
    res.once('close', detach)
  }
  const queue = (room: Room, device: Device, body: Record<string, unknown>, res: ServerResponse): void => {
    const task = request(body, device.public.id)
    const key = `${task.deviceId}:${task.operationId}`
    const fingerprint = shareDigest(JSON.stringify({ kind: task.kind, sessionId: task.sessionId, text: task.text }))
    const prior = room.operations.get(key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new HttpError(409, 'operation id already used with different payload')
      if (prior.reply) sendReply(res, prior.reply)
      else if (prior.pending) addWaiter(room, prior.pending, res)
      return
    }
    if ((task.kind === 'message' || task.kind === 'stop') && device.public.role !== 'controller') {
      throw new HttpError(403, 'controller access required')
    }
    if (!room.owner || room.owner.closed) throw new HttpError(503, 'workspace owner is offline')
    if (room.pending.size >= SHARE_LIMITS.pending || waitersCount(room) >= SHARE_LIMITS.pending) {
      throw new HttpError(429, 'too many pending requests')
    }
    trimOperations(room, true)
    if (room.operations.size >= SHARE_LIMITS.operations) throw new HttpError(429, 'too many operations')
    const operation: Operation = { fingerprint }
    const pending: Pending = {
      request: task, operation, waiters: new Map(), deadline: clock() + requestMs,
      timer: setTimeout(() => complete(room, pending, reply(504, { error: 'workspace request timed out' })), requestMs),
    }
    pending.timer.unref()
    operation.pending = pending
    room.operations.set(key, operation)
    room.pending.set(task.requestId, pending)
    addWaiter(room, pending, res)
    if (!send(room.owner, { type: 'request', request: task })) {
      complete(room, pending, reply(503, { error: 'workspace owner is offline' }))
    }
  }
  const projectReply = (pending: Pending, value: Record<string, unknown>): Reply => {
    if (typeof value.status !== 'number' || !Number.isInteger(value.status) || value.status < 200 || value.status > 599) {
      throw new HttpError(400, 'invalid response status')
    }
    if (value.status >= 300) return reply(value.status, { error: 'workspace request failed' })
    if (!ownObject(value.data)) throw new HttpError(400, 'response data must be an object')
    if (pending.request.kind === 'state') return reply(value.status, workspace(value.data))
    if (pending.request.kind === 'history') return reply(value.status, history(value.data))
    return reply(value.status, {
      ok: value.data.ok === true, queued: value.data.queued === true, message: cleanText(value.data.message, 200),
    })
  }
  const guard = (req: IncomingMessage): void => {
    const counts = new Map<string, number>()
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i]!.toLowerCase()
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    if (counts.get('host') !== 1 || (counts.get('origin') ?? 0) > 1 || (counts.get('authorization') ?? 0) > 1) {
      throw new HttpError(403, 'invalid request headers')
    }
    const expected = new URL(url)
    const hostHeader = req.headers.host ?? ''
    let target: URL
    try {
      if (!hostHeader || /[\s\\/?#@]/.test(hostHeader)) throw new Error()
      target = new URL(`${expected.protocol}//${hostHeader}`)
    } catch { throw new HttpError(403, 'invalid Host header') }
    if (target.origin !== expected.origin) throw new HttpError(403, 'Host does not match relay origin')
    if (req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site') {
      throw new HttpError(403, 'cross-origin request rejected')
    }
    if (req.headers.origin !== undefined) {
      let source: URL
      try { source = new URL(req.headers.origin) } catch { throw new HttpError(403, 'invalid Origin header') }
      if (source.origin !== expected.origin || source.username || source.password || source.pathname !== '/' || source.search || source.hash) {
        throw new HttpError(403, 'cross-origin request rejected')
      }
    }
    // Forwarded / X-Forwarded-* are deliberately ignored, including for address rate limits.
  }
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
    // readJson owns the input deadline; each pending owner reply owns its own timer.
    // An independent socket timeout here would race the 504 reply and abort the client.
    res.setTimeout(0)
    guard(req)
    if (closing) throw new HttpError(503, 'relay is closed')
    sweep()
    const path = req.url ?? ''
    if (!path.startsWith('/') || path.startsWith('//') || /[?#%\\]/.test(path)) throw new HttpError(400, 'invalid request path')
    if (path === '/api/rooms') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      bearer(req, registrationHash)
      if (rooms.size + registrations >= SHARE_LIMITS.rooms) throw new HttpError(429, 'room limit reached')
      registrations++
      try {
        const body = await readJson(req, requestMs, SHARE_LIMITS.frameBytes)
        if (closing) throw new HttpError(503, 'relay is closed')
        keys(body, ['inviteHash', 'inviteExpiresAt', 'expiresAt'])
        if (!isShareSecret(body.inviteHash)) throw new HttpError(400, 'invalid invite hash')
        const expiresAt = expiry(body.expiresAt, SHARE_LIMITS.shareMs)
        const inviteExpiresAt = expiry(body.inviteExpiresAt, SHARE_LIMITS.inviteMs, expiresAt)
        let id = shareId()
        while (rooms.has(id)) id = shareId()
        const ownerToken = shareSecret()
        rooms.set(id, {
          id, ownerHash: digest(ownerToken), expiresAt, inviteHash: Buffer.from(body.inviteHash, 'hex'), inviteExpiresAt,
          devices: new Map(), pending: new Map(), operations: new Map(), cacheBytes: 0, reading: 0, mobileReading: 0,
        })
        json(res, 201, { roomId: id, ownerToken, expiresAt })
      } finally { registrations-- }
      return
    }
    const connect = /^\/connect\/([0-9a-f]{32})$/.exec(path)
    if (connect) {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      const room = getRoom(connect[1]!)
      mobilePage ??= (async () => {
        const html = (opts.mobileHtml ?? await readFile(new URL('../web/mobile.html', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n')
        if (Buffer.byteLength(html) > SHARE_LIMITS.frameBytes) throw new HttpError(413, 'mobile page too large')
        return { html, policy: htmlPolicy(html) }
      })().catch(() => { mobilePage = undefined; throw new HttpError(503, 'mobile page unavailable') })
      const page = await mobilePage
      active(room)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': page.policy, 'cache-control': 'no-store' })
      res.end(page.html)
      return
    }
    const match = /^\/api\/rooms\/([0-9a-f]{32})(?:\/(owner\/events|publish|invite|device|join|session|events|request|logout))?$/.exec(path)
    if (!match) throw new HttpError(404, 'route not found')
    const room = getRoom(match[1]!), action = match[2]
    if (!action || ['owner/events', 'publish', 'invite', 'device'].includes(action)) {
      bearer(req, room.ownerHash, true)
      if (!action) {
        if (req.method !== 'DELETE') throw new HttpError(405, 'method not allowed')
        closeRoom(room, 'deleted')
        json(res, 200, { ok: true })
        return
      }
      if (action === 'owner/events') {
        if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
        if (room.owner) endPeer(room.owner)
        let peer: Peer
        peer = openPeer(res, () => ownerOffline(room, peer))
        room.owner = peer
        send(peer, { type: 'hello' })
        for (const device of room.devices.values()) notifyDevice(room, device)
        statuses(room)
        return
      }
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      const body = await bodyFor(req, room, true)
      if (action === 'invite') {
        keys(body, ['inviteHash', 'inviteExpiresAt'])
        if (!isShareSecret(body.inviteHash)) throw new HttpError(400, 'invalid invite hash')
        const until = expiry(body.inviteExpiresAt, SHARE_LIMITS.inviteMs, room.expiresAt)
        room.inviteHash = Buffer.from(body.inviteHash, 'hex')
        room.inviteExpiresAt = until
      } else if (action === 'device') {
        keys(body, ['id', 'role', 'revoke'])
        if (!isShareId(body.id) || (body.revoke !== true && !validShareRole(body.role)) ||
            (body.revoke !== undefined && body.revoke !== true) || (body.revoke === true && body.role !== undefined)) {
          throw new HttpError(400, 'invalid device update')
        }
        const device = room.devices.get(body.id)
        if (!device) throw new HttpError(404, 'device not found')
        if (body.revoke === true) revoke(room, device)
        else {
          device.public.role = body.role as ShareDevice['role']
          if (body.role === 'viewer') failPending(room, 403, 'controller access required', (pending) =>
            pending.request.deviceId === device.public.id && (pending.request.kind === 'message' || pending.request.kind === 'stop'))
          notifyDevice(room, device)
          for (const peer of [...device.streams]) send(peer, { type: 'status', ...session(room, device) })
        }
      } else {
        keys(body, ['snapshot', 'event', 'response'])
        if (body.snapshot === undefined && body.event === undefined && body.response === undefined) throw new HttpError(400, 'empty publication')
        if (body.snapshot !== undefined && !ownObject(body.snapshot)) throw new HttpError(400, 'invalid snapshot')
        if (body.event !== undefined && !ownObject(body.event)) throw new HttpError(400, 'invalid share event')
        const snapshot = body.snapshot === undefined ? undefined : workspace(body.snapshot)
        const sharedEvent = body.event === undefined ? undefined : event(body.event)
        if (snapshot) encode({ type: 'snapshot', snapshot })
        if (sharedEvent) encode({ type: 'event', event: sharedEvent })
        let pending: Pending | undefined, response: Reply | undefined
        if (body.response !== undefined) {
          if (!ownObject(body.response) || !isShareId(body.response.requestId)) throw new HttpError(400, 'invalid response')
          keys(body.response, ['requestId', 'status', 'data', 'error'])
          pending = room.pending.get(body.response.requestId)
          // Late replies are deliberately ignored, never resurrecting a timed-out/revoked operation.
          if (pending) response = projectReply(pending, body.response)
        }
        if (snapshot) room.snapshot = snapshot
        for (const device of room.devices.values()) {
          for (const peer of [...device.streams]) {
            if (snapshot) send(peer, { type: 'snapshot', snapshot })
            if (sharedEvent) send(peer, { type: 'event', event: sharedEvent })
          }
        }
        if (pending && response) complete(room, pending, response)
      }
      json(res, 200, { ok: true })
      return
    }
    if (action === 'join') {
      if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
      beginJoin(req, room)
      const body = await bodyFor(req, room)
      keys(body, ['token', 'name'])
      if (!isShareSecret(body.token) || !room.inviteHash || room.inviteExpiresAt <= clock() ||
          !timingSafeEqual(digest(body.token), room.inviteHash)) throw new HttpError(401, 'invalid or expired invite')
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > SHARE_LIMITS.nameChars) throw new HttpError(400, 'invalid device name')
      if (room.devices.size >= SHARE_LIMITS.devices) throw new HttpError(429, 'device limit reached')
      const token = shareSecret(), id = shareId()
      const device: Device = {
        public: { id, name: cleanText(body.name.trim(), SHARE_LIMITS.nameChars) || 'mobile', role: 'viewer', online: false, connectedAt: clock() },
        cookieHash: digest(token), streams: new Set(),
      }
      room.inviteHash = undefined // Reserve/consume before any response or notification can yield.
      room.devices.set(id, device)
      res.setHeader('set-cookie', cookie(room, token))
      notifyDevice(room, device)
      json(res, 200, { device: publicDevice(device) })
      return
    }
    if (action === 'session') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      json(res, 200, session(room, deviceFor(req, room)))
      return
    }
    const device = requireDevice(req, room)
    if (action === 'events') {
      if (req.method !== 'GET') throw new HttpError(405, 'method not allowed')
      if (device.streams.size >= MAX_STREAMS_PER_DEVICE) throw new HttpError(429, 'too many device streams')
      let peer: Peer
      peer = openPeer(res, () => {
        device.streams.delete(peer)
        if (room.devices.get(device.public.id) === device && device.streams.size === 0 && device.public.online) {
          device.public.online = false
          notifyDevice(room, device)
        }
      })
      device.streams.add(peer)
      const first = !device.public.online
      device.public.online = true
      send(peer, { type: 'status', ...session(room, device) })
      if (room.snapshot) send(peer, { type: 'snapshot', snapshot: room.snapshot })
      if (first) notifyDevice(room, device)
      return
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await bodyFor(req, room)
    if (room.devices.get(device.public.id) !== device || requireDevice(req, room) !== device) throw new HttpError(401, 'device access revoked')
    if (action === 'logout') {
      keys(body, [])
      revoke(room, device)
      res.setHeader('set-cookie', cookie(room, ''))
      json(res, 200, { ok: true })
    } else queue(room, device, body, res)
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return
      if (res.headersSent) { res.destroy(); return }
      const status = error instanceof HttpError ? error.status : 500
      // Never log or return raw exceptions, request bodies, registration/owner/invite/cookie tokens.
      json(res, status, { error: error instanceof HttpError ? error.message : 'relay request failed' })
      req.resume()
    })
  })
  server.requestTimeout = requestMs
  server.headersTimeout = requestMs
  server.keepAliveTimeout = Math.min(5000, requestMs)
  server.maxHeadersCount = 32
  server.maxConnections = 1024
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n')
    else socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => reject(error)
    server.once('error', failed)
    server.listen(requestedPort, host, () => { server.off('error', failed); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') { server.close(); throw new Error('relay listener unavailable') }
  const port = address.port
  if (!url) url = shareOrigin(`http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`)
  const heartbeat = setInterval(() => {
    sweep()
    for (const room of rooms.values()) {
      const peers = [room.owner, ...[...room.devices.values()].flatMap((device) => [...device.streams])]
      for (const peer of peers) {
        if (!peer || peer.closed) continue
        if (peer.res.destroyed || peer.res.writableEnded || peer.res.writableLength > SHARE_LIMITS.frameBytes) { endPeer(peer); continue }
        try { peer.res.write(': heartbeat\n\n') } catch { endPeer(peer) }
      }
    }
  }, heartbeatMs)
  heartbeat.unref()
  const close = (): Promise<void> => {
    closePromise ??= new Promise<void>((resolve, reject) => {
      closing = true
      clearInterval(heartbeat)
      for (const room of [...rooms.values()]) closeRoom(room, 'relay closed', 503)
      attempts.clear()
      registrationHash.fill(0)
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
    return closePromise
  }
  return { url, port, server, sweep, close }
}
