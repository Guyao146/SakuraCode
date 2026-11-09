import { createHash } from 'node:crypto'
import { Agent, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ClientRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { runWorkspaceRelay, type WorkspaceRelay, type WorkspaceRelayOptions } from '../src/sharing/relay.js'
import { SHARE_LIMITS, shareDigest, shareId, shareSecret } from '../src/sharing/protocol.js'

const REGISTRATION = 'registration-test-'.repeat(4)
const HTML = '<!doctype html><style>body{color:#123}</style><script>window.ready=true</script><main>Mobile relay</main>'
let agent = new Agent({ keepAlive: true, maxSockets: 96 })
const relays: WorkspaceRelay[] = []
const streams: Stream[] = []
type Result = { status: number; headers: IncomingHttpHeaders; body: any }
type Frame = Record<string, any>
const pause = (ms = 15): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function headers(relay: WorkspaceRelay, extra: Record<string, string> = {}): Record<string, string> {
  return { host: new URL(relay.url).host, origin: relay.url, ...extra }
}
async function fixture(options: Partial<WorkspaceRelayOptions> = {}): Promise<WorkspaceRelay> {
  const relay = await runWorkspaceRelay({ registrationToken: REGISTRATION, port: 0, mobileHtml: HTML, ...options })
  relays.push(relay)
  return relay
}
function api(relay: WorkspaceRelay, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, raw?: string): Promise<Result> {
  const wire = raw ?? (body === undefined ? '' : JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port: relay.port, method, path, agent,
      headers: { ...headers(relay, extra), ...(wire ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(wire)) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.once('error', reject)
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed: unknown = text
        if (res.headers['content-type']?.startsWith('application/json')) {
          try { parsed = JSON.parse(text || '{}') } catch (error) { reject(error); return }
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
      })
    })
    req.once('error', reject)
    req.setTimeout(6000, () => req.destroy(new Error('loopback request timed out')))
    req.end(wire)
  })
}
async function room(relay: WorkspaceRelay, now = Date.now()): Promise<{ id: string; ownerToken: string; invite: string; expiresAt: number }> {
  const invite = shareSecret()
  const result = await api(relay, 'POST', '/api/rooms', {
    inviteHash: shareDigest(invite), inviteExpiresAt: now + 60_000, expiresAt: now + 120_000,
  }, { authorization: `Bearer ${REGISTRATION}` })
  expect(result.status).toBe(201)
  expect(result.body.roomId).toMatch(/^[0-9a-f]{32}$/)
  expect(result.body.ownerToken).toMatch(/^[0-9a-f]{64}$/)
  return { id: result.body.roomId, ownerToken: result.body.ownerToken, invite, expiresAt: result.body.expiresAt }
}
type Room = Awaited<ReturnType<typeof room>>
const path = (room: Room, suffix: string): string => `/api/rooms/${room.id}${suffix ? `/${suffix}` : ''}`
function ownerApi(relay: WorkspaceRelay, room: Room, suffix: string, body?: unknown, method = 'POST'): Promise<Result> {
  return api(relay, method, path(room, suffix), body, { authorization: `Bearer ${room.ownerToken}` })
}
async function join(relay: WorkspaceRelay, room: Room, token = room.invite, name = 'phone'): Promise<{ cookie: string; device: any }> {
  const result = await api(relay, 'POST', path(room, 'join'), { token, name })
  expect(result.status).toBe(200)
  const cookie = result.headers['set-cookie']?.[0]?.split(';')[0]
  expect(cookie).toBeTruthy()
  return { cookie: cookie!, device: result.body.device }
}
async function rotate(relay: WorkspaceRelay, room: Room, now = Date.now()): Promise<string> {
  const token = shareSecret()
  expect((await ownerApi(relay, room, 'invite', { inviteHash: shareDigest(token), inviteExpiresAt: now + 30_000 })).status).toBe(200)
  return token
}

class Stream {
  readonly seen: Frame[] = []
  readonly frames: Frame[] = []
  private waiting: Array<{ type: string; predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = []
  private buffer = ''
  private ended = false
  constructor(readonly req: ClientRequest, readonly res: IncomingMessage) {
    res.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let end: number
      while ((end = this.buffer.indexOf('\n\n')) >= 0) {
        const block = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 2)
        const data = block.split('\n').find((line) => line.startsWith('data: '))
        if (!data) continue
        const frame = JSON.parse(data.slice(6)) as Frame
        this.seen.push(frame)
        const index = this.waiting.findIndex((waiter) => waiter.type === frame.type && waiter.predicate(frame))
        if (index >= 0) {
          const waiter = this.waiting.splice(index, 1)[0]!
          clearTimeout(waiter.timer)
          waiter.resolve(frame)
        } else this.frames.push(frame)
      }
    })
    const ended = (): void => {
      this.ended = true
      for (const waiter of this.waiting.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('SSE stream closed'))
      }
    }
    res.once('close', ended)
    res.once('error', ended)
  }
  next(type: string, predicate: (frame: Frame) => boolean = () => true): Promise<Frame> {
    const index = this.frames.findIndex((frame) => frame.type === type && predicate(frame))
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]!)
    if (this.ended) return Promise.reject(new Error('SSE stream closed'))
    return new Promise((resolve, reject) => {
      const waiter = { type, predicate, resolve, reject, timer: setTimeout(() => {
        this.waiting = this.waiting.filter((entry) => entry !== waiter)
        reject(new Error(`missing SSE ${type} frame`))
      }, 2000) }
      this.waiting.push(waiter)
    })
  }
  close(): Promise<void> {
    if (this.ended) return Promise.resolve()
    return new Promise((resolve) => {
      this.res.once('close', resolve)
      this.res.destroy()
      this.req.destroy()
    })
  }
}
function sse(relay: WorkspaceRelay, path: string, extra: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: relay.port, path, headers: headers(relay, extra), agent }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`SSE status ${res.statusCode}`)); return }
      const stream = new Stream(req, res)
      streams.push(stream)
      resolve(stream)
    })
    req.once('error', reject)
    req.end()
  })
}
async function ownerStream(relay: WorkspaceRelay, room: Room): Promise<Stream> {
  const stream = await sse(relay, path(room, 'owner/events'), { authorization: `Bearer ${room.ownerToken}` })
  expect(await stream.next('hello')).toEqual({ type: 'hello' })
  return stream
}
const mobileRequest = (relay: WorkspaceRelay, room: Room, cookie: string, body: unknown): Promise<Result> =>
  api(relay, 'POST', path(room, 'request'), body, { cookie })
async function answer(relay: WorkspaceRelay, room: Room, stream: Stream, operation: Promise<Result>, data: unknown, status = 200): Promise<Result> {
  const frame = await stream.next('request')
  expect((await ownerApi(relay, room, 'publish', { response: { requestId: frame.request.requestId, status, data } })).status).toBe(200)
  return operation
}

afterEach(async () => {
  await Promise.all(streams.splice(0).map((stream) => stream.close()))
  await Promise.all(relays.splice(0).map((relay) => relay.close()))
  agent.destroy()
  agent = new Agent({ keepAlive: true, maxSockets: 96 })
})

describe('memory-only workspace relay (loopback only)', () => {
  it('isolates join limits per room behind the same HTTPS reverse proxy', async () => {
    const relay = await fixture({ publicOrigin: 'https://relay.example.test' }), a = await room(relay), b = await room(relay)
    for (let i = 0; i < 10; i++) expect((await api(relay, 'POST', path(a, 'join'), { token: shareSecret(), name: 'invalid' })).status).toBe(401)
    expect((await api(relay, 'POST', path(a, 'join'), { token: a.invite, name: 'blocked' })).status).toBe(429)
    expect((await api(relay, 'POST', path(b, 'join'), { token: b.invite, name: 'valid' })).status).toBe(200)
  })

  it('reserves owner body readers while mobile uploads are stalled, and denies completed uploads after revocation', async () => {
    const relay = await fixture(), created = await room(relay), owner = await ownerStream(relay, created), phone = await join(relay, created)
    await owner.next('device')
    const held: Array<{ req: ClientRequest; tail: string; result: Promise<Result> }> = []
    try {
      for (let i = 0; i < SHARE_LIMITS.pending - 4; i++) {
        const wire = JSON.stringify({ operationId: shareId(), kind: 'state' })
        let req!: ClientRequest
        const result = new Promise<Result>((resolve, reject) => {
          req = httpRequest({ hostname: '127.0.0.1', port: relay.port, method: 'POST', path: path(created, 'request'), agent,
            headers: { ...headers(relay), cookie: phone.cookie, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(wire)) } }, res => {
            const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject)
            res.once('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }))
          })
          req.once('error', reject)
        })
        void result.catch(() => {})
        req.write(wire.slice(0, -1)); held.push({ req, tail: wire.slice(-1), result })
      }
      await pause(40)
      expect((await mobileRequest(relay, created, phone.cookie, { operationId: shareId(), kind: 'state' })).status).toBe(429)
      expect((await ownerApi(relay, created, 'publish', { event: { type: 'changed' } })).status).toBe(200)
      expect((await ownerApi(relay, created, 'device', { id: phone.device.id, revoke: true })).status).toBe(200)
      for (const row of held) row.req.end(row.tail)
      for (const row of held) expect((await row.result).status).toBe(401)
    } finally { for (const row of held) row.req.destroy(); await Promise.allSettled(held.map(row => row.result)) }
  })

  it('validates binding options, authorization, exact Host/Origin, and ignores forwarding headers', async () => {
    await expect(runWorkspaceRelay({ registrationToken: 'short' })).rejects.toThrow()
    await expect(runWorkspaceRelay({ registrationToken: REGISTRATION, host: '0.0.0.0', port: 0 })).rejects.toThrow(/publicOrigin/)
    await expect(runWorkspaceRelay({ registrationToken: REGISTRATION, publicOrigin: 'http://external.test' })).rejects.toThrow()
    await expect(runWorkspaceRelay({ registrationToken: REGISTRATION, publicOrigin: 'https://relay.test/path' })).rejects.toThrow()
    const relay = await fixture()
    expect(relay.url).toBe(`http://127.0.0.1:${relay.port}`)
    const payload = { inviteHash: shareDigest(shareSecret()), inviteExpiresAt: Date.now() + 1000, expiresAt: Date.now() + 60_000 }
    expect((await api(relay, 'POST', '/api/rooms', payload)).status).toBe(401)
    expect((await api(relay, 'POST', '/api/rooms', payload, { authorization: `Bearer ${REGISTRATION}`, host: `localhost:${relay.port}` })).status).toBe(403)
    expect((await api(relay, 'POST', '/api/rooms', payload, { authorization: `Bearer ${REGISTRATION}`, origin: 'https://evil.test' })).status).toBe(403)
    expect((await api(relay, 'POST', '/api/rooms', payload, { authorization: `Bearer ${REGISTRATION}`, host: 'evil.test', 'x-forwarded-host': new URL(relay.url).host })).status).toBe(403)
    const created = await room(relay)
    expect((await api(relay, 'GET', path(created, 'owner/events'), undefined, { authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await api(relay, 'GET', '/https://evil.test')).status).toBe(404)
    expect((await api(relay, 'GET', `${path(created, 'session')}?target=https://evil.test`)).status).toBe(400)
    await relay.close()
    await relay.close()
    expect(relay.server.listening).toBe(false)
  })

  it('enforces invite/share TTLs and reserves the 32-room cap during concurrent registration', async () => {
    let now = 1_700_000_000_000
    const relay = await fixture({ clock: () => now })
    const create = (inviteExpiresAt: number, expiresAt: number): Promise<Result> => api(relay, 'POST', '/api/rooms', {
      inviteHash: shareDigest(shareSecret()), inviteExpiresAt, expiresAt,
    }, { authorization: `Bearer ${REGISTRATION}` })
    expect((await create(now + SHARE_LIMITS.inviteMs + 1, now + SHARE_LIMITS.shareMs)).status).toBe(400)
    expect((await create(now + 1000, now + SHARE_LIMITS.shareMs + 1)).status).toBe(400)
    expect((await create(now, now + 1000)).status).toBe(400)
    expect((await create(now + 2000, now + 1000)).status).toBe(400)
    const results = await Promise.all(Array.from({ length: 33 }, () => create(now + 1000, now + 2000)))
    expect(results.filter((result) => result.status === 201)).toHaveLength(32)
    expect(results.filter((result) => result.status === 429)).toHaveLength(1)
    const first = results.find((result) => result.status === 201)!
    expect((await api(relay, 'DELETE', `/api/rooms/${first.body.roomId}`, undefined, { authorization: `Bearer ${first.body.ownerToken}` })).status).toBe(200)
    expect((await create(now + 1000, now + 2000)).status).toBe(201)
    now += 2001
    relay.sweep()
    expect((await create(now + 1000, now + 2000)).status).toBe(201)
  })

  it('consumes invites once, expires rotations, caps devices, and rate-limits the actual socket address', async () => {
    let now = 1_700_000_000_000
    const relay = await fixture({ clock: () => now })
    const shared = await room(relay, now)
    const concurrent = await Promise.all(['phone', 'tablet'].map((name) => api(relay, 'POST', path(shared, 'join'), { token: shared.invite, name })))
    expect(concurrent.map((result) => result.status).sort()).toEqual([200, 401])
    const expired = await rotate(relay, shared, now)
    now += 30_001
    expect((await api(relay, 'POST', path(shared, 'join'), { token: expired, name: 'late' })).status).toBe(401)
    now += 30_000
    for (let i = 1; i < 8; i++) await join(relay, shared, await rotate(relay, shared, now), `phone-${i}`)
    const ninth = await rotate(relay, shared, now)
    expect((await api(relay, 'POST', path(shared, 'join'), { token: ninth, name: 'ninth' })).status).toBe(429)
    now += 60_001
    const second = await room(relay, now)
    for (let i = 0; i < 10; i++) {
      expect((await api(relay, 'POST', path(second, 'join'), { token: shareSecret(), name: 'bad' }, { 'x-forwarded-for': `192.0.2.${i}` })).status).toBe(401)
    }
    expect((await api(relay, 'POST', path(second, 'join'), { token: second.invite, name: 'good' }, { 'x-forwarded-for': '192.0.2.99' })).status).toBe(429)
    now += 60_001
    await join(relay, second, await rotate(relay, second, now))
  })

  it('serves injected mobile HTML with hash CSP/no-store and isolates Secure room-scoped cookies', async () => {
    const relay = await fixture({ publicOrigin: 'https://relay.test/' })
    expect(relay.url).toBe('https://relay.test')
    const first = await room(relay), second = await room(relay)
    const page = await api(relay, 'GET', `/connect/${first.id}`)
    expect(page.body).toBe(HTML)
    expect(page.headers['cache-control']).toBe('no-store')
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    const hash = createHash('sha256').update('window.ready=true').digest('base64')
    expect(page.headers['content-security-policy']).toContain(`'sha256-${hash}'`)
    expect(page.headers['content-security-policy']).not.toMatch(/unsafe-inline|https:\/\/.*cdn/)
    const result = await api(relay, 'POST', path(first, 'join'), { token: first.invite, name: 'phone' })
    const setCookie = result.headers['set-cookie']![0]!
    expect(setCookie).toContain(`Path=/api/rooms/${first.id}; HttpOnly; SameSite=Strict; Secure`)
    const cookie = setCookie.split(';')[0]!
    expect((await api(relay, 'GET', path(first, 'session'), undefined, { cookie })).body).toMatchObject({ authenticated: true, online: false })
    expect((await api(relay, 'GET', path(second, 'session'), undefined, { cookie })).body).toMatchObject({ authenticated: false, device: null })
    expect((await mobileRequest(relay, first, cookie, { operationId: shareId(), kind: 'state', url: 'https://evil.test' })).status).toBe(400)
    expect((await api(relay, 'POST', path(first, 'logout'), {}, { cookie })).status).toBe(200)
    expect((await api(relay, 'GET', path(first, 'session'), undefined, { cookie })).body.authenticated).toBe(false)
  })

  it('rebuilds snapshot, state/history DTOs and events without cwd, private metadata, or wrappers', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    const snapshot = {
      workspaceId: 'work', name: 'Safe name', cwd: 'D:\\private\\do-not-name', revision: 37, sessionId: 's1', busy: true, expertMode: false,
      sessions: [{ id: 's1', title: 'open D:\\private\\code.ts', updatedAt: '2026-01-01T00:00:00Z', status: 'running', secret: 'hidden' }],
      agents: [{ id: 'main', name: 'Main', status: 'running', role: 'main', prompt: 'hidden' }],
      todos: [{ content: 'Task', status: 'pending', metadata: 'hidden' }], credentials: 'hidden', config: { token: 'hidden' },
    }
    expect((await ownerApi(relay, shared, 'publish', { snapshot })).status).toBe(200)
    const mobile = await sse(relay, path(shared, 'events'), { cookie: phone.cookie })
    expect((await mobile.next('status')).authenticated).toBe(true)
    const published = (await mobile.next('snapshot')).snapshot
    expect(published).toMatchObject({ name: 'Safe name', revision: 37, workspaceId: 'work' })
    expect(JSON.stringify(published)).not.toMatch(/cwd|credentials|config|hidden|do-not-name|private/)
    expect(published.sessions[0].title).toContain('[local path]')
    const state = await answer(relay, shared, owner, mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' }), snapshot)
    expect(state.body).toEqual(published)
    expect(state.body.data).toBeUndefined()
    const visibleHistory = {
      sessionId: 's1', entries: [{ seq: 4, time: '2026-01-01T00:00:00Z', kind: 'assistant', text: 'open D:\\secret\\x and token=supersecret', label: 'Main', reasoning: 'hidden', payload: { content: 'hidden' } }],
      truncated: false, metadata: 'hidden',
    }
    const history = await answer(relay, shared, owner, mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'history', sessionId: 's1' }), visibleHistory)
    expect(history.body.entries).toHaveLength(1)
    expect(history.body.entries[0]).toEqual({ seq: 4, time: '2026-01-01T00:00:00Z', kind: 'assistant', text: 'open [local path] and token=[redacted]', label: 'Main' })
    expect(Object.keys(history.body).sort()).toEqual(['entries', 'sessionId', 'truncated'])
    await ownerApi(relay, shared, 'publish', { event: { type: 'text', sessionId: 's1', text: 'Bearer secret', cwd: 'hidden', args: 'hidden' } })
    expect((await mobile.next('event')).event).toEqual({ type: 'text', sessionId: 's1', text: 'Bearer [redacted]' })
  })

  it('requires controller role for mutations, validates request fields, and returns only acknowledgements', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    expect((await mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'message', text: 'hello' })).status).toBe(403)
    expect((await mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'stop' })).status).toBe(403)
    expect((await ownerApi(relay, shared, 'device', { id: phone.device.id, role: 'controller' })).status).toBe(200)
    for (const body of [
      { operationId: shareId(), kind: 'history', sessionId: '../secret' },
      { operationId: shareId(), kind: 'message', text: ' '.repeat(3) },
      { operationId: shareId(), kind: 'message', text: 'x'.repeat(8001) },
      { operationId: shareId(), kind: 'stop', text: 'unsupported' },
      { operationId: 'bad', kind: 'state' },
      { operationId: shareId(), kind: 'proxy', url: 'https://evil.test' },
    ]) expect((await mobileRequest(relay, shared, phone.cookie, body)).status).toBe(400)
    const operationId = shareId()
    const queued = mobileRequest(relay, shared, phone.cookie, { operationId, kind: 'message', sessionId: 's1', text: 'hello' })
    const frame = await owner.next('request')
    expect(frame.request).toEqual({ requestId: expect.stringMatching(/^[0-9a-f]{32}$/), deviceId: phone.device.id, operationId, kind: 'message', sessionId: 's1', text: 'hello' })
    await ownerApi(relay, shared, 'publish', { response: { requestId: frame.request.requestId, status: 202, data: { ok: true, queued: true, message: 'queued', config: 'hidden', cwd: 'hidden' } } })
    expect((await queued).body).toEqual({ ok: true, queued: true, message: 'queued' })
    const stopped = await answer(relay, shared, owner, mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'stop' }), { ok: true, queued: false, message: 'stopped', secret: 'hidden' })
    expect(stopped.body).toEqual({ ok: true, queued: false, message: 'stopped' })
  })

  it('deduplicates pending/completed operations by device, rejects changed payloads, and never resends', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), first = await join(relay, shared)
    const second = await join(relay, shared, await rotate(relay, shared), 'tablet')
    await ownerApi(relay, shared, 'device', { id: first.device.id, role: 'controller' })
    await ownerApi(relay, shared, 'device', { id: second.device.id, role: 'controller' })
    const payload = { operationId: shareId(), kind: 'message', text: 'once' }
    const pending = mobileRequest(relay, shared, first.cookie, payload)
    const frame = await owner.next('request')
    const duplicate = mobileRequest(relay, shared, first.cookie, payload)
    expect((await mobileRequest(relay, shared, first.cookie, { ...payload, text: 'changed' })).status).toBe(409)
    await ownerApi(relay, shared, 'publish', { response: { requestId: frame.request.requestId, status: 200, data: { ok: true, queued: true, message: 'once' } } })
    expect(await duplicate).toMatchObject({ status: 200, body: { ok: true, queued: true, message: 'once' } })
    expect((await pending).body).toEqual((await mobileRequest(relay, shared, first.cookie, payload)).body)
    expect(owner.seen.filter((entry) => entry.type === 'request')).toHaveLength(1)
    await answer(relay, shared, owner, mobileRequest(relay, shared, second.cookie, payload), { ok: true, queued: true, message: 'other device' })
    expect(owner.seen.filter((entry) => entry.type === 'request')).toHaveLength(2)
  })

  it('marks owner disconnection offline immediately, fails pending requests, and reconnects without replaying mutations', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    await ownerApi(relay, shared, 'device', { id: phone.device.id, role: 'controller' })
    const mobile = await sse(relay, path(shared, 'events'), { cookie: phone.cookie })
    await mobile.next('status', (frame) => frame.online === true)
    const payload = { operationId: shareId(), kind: 'message', text: 'do not replay' }
    const pending = mobileRequest(relay, shared, phone.cookie, payload)
    await owner.next('request')
    await owner.close()
    expect((await pending).status).toBe(503)
    expect((await mobile.next('status', (frame) => frame.online === false)).authenticated).toBe(true)
    expect((await mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' })).status).toBe(503)
    const reconnected = await ownerStream(relay, shared)
    expect((await reconnected.next('device')).device.id).toBe(phone.device.id)
    expect((await mobileRequest(relay, shared, phone.cookie, payload)).status).toBe(503)
    await pause()
    expect(reconnected.seen.filter((frame) => frame.type === 'request')).toHaveLength(0)
  })

  it('counts multiple tabs as one device and revokes streams/pending with an offline viewer notification', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), first = await join(relay, shared)
    const other = await join(relay, shared, await rotate(relay, shared), 'other')
    const a = await sse(relay, path(shared, 'events'), { cookie: first.cookie })
    await a.next('status')
    await owner.next('device', (frame) => frame.device.id === first.device.id && frame.device.online)
    const b = await sse(relay, path(shared, 'events'), { cookie: first.cookie })
    await b.next('status')
    await a.close()
    expect((await api(relay, 'GET', path(shared, 'session'), undefined, { cookie: first.cookie })).body.device.online).toBe(true)
    await pause()
    expect(owner.seen.filter((frame) => frame.type === 'device' && frame.device.id === first.device.id && frame.device.online)).toHaveLength(1)
    await ownerApi(relay, shared, 'device', { id: first.device.id, role: 'controller' })
    const pending = mobileRequest(relay, shared, first.cookie, { operationId: shareId(), kind: 'state' })
    await owner.next('request')
    expect((await ownerApi(relay, shared, 'device', { id: first.device.id, revoke: true })).status).toBe(200)
    expect((await pending).status).toBe(401)
    expect((await b.next('status', (frame) => !frame.authenticated)).device).toBeNull()
    expect((await owner.next('device', (frame) => frame.device.id === first.device.id && frame.device.role === 'viewer' && !frame.device.online)).device.online).toBe(false)
    expect((await api(relay, 'GET', path(shared, 'session'), undefined, { cookie: first.cookie })).body.authenticated).toBe(false)
    expect((await api(relay, 'GET', path(shared, 'session'), undefined, { cookie: other.cookie })).body.authenticated).toBe(true)
    expect((await mobileRequest(relay, shared, first.cookie, { operationId: shareId(), kind: 'state' })).status).toBe(401)
    expect((await api(relay, 'POST', path(shared, 'logout'), {}, { cookie: other.cookie })).status).toBe(200)
  })

  it('fails only pending mutations on controller downgrade and ignores their late owner replies', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    await ownerApi(relay, shared, 'device', { id: phone.device.id, role: 'controller' })
    const payload = { operationId: shareId(), kind: 'stop' }
    const mutation = mobileRequest(relay, shared, phone.cookie, payload)
    const mutationFrame = await owner.next('request')
    const reading = mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' })
    const readFrame = await owner.next('request')
    await ownerApi(relay, shared, 'device', { id: phone.device.id, role: 'viewer' })
    expect((await mutation).status).toBe(403)
    expect((await ownerApi(relay, shared, 'publish', { response: { requestId: mutationFrame.request.requestId, status: 200, data: { ok: true } } })).status).toBe(200)
    expect((await mobileRequest(relay, shared, phone.cookie, payload)).status).toBe(403)
    await ownerApi(relay, shared, 'publish', { response: { requestId: readFrame.request.requestId, status: 200, data: { workspaceId: 'work', name: 'Safe', revision: 9 } } })
    expect((await reading).body.revision).toBe(9)
  })

  it('bounds JSON frames and pending requests and times out/TTL-sweeps without exposing raw errors', async () => {
    let now = 1_700_000_000_000
    const relay = await fixture({ clock: () => now, requestTimeoutMs: 300 })
    const shared = await room(relay, now), owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    expect((await api(relay, 'POST', path(shared, 'request'), undefined, { cookie: phone.cookie }, '{bad-json')).status).toBe(400)
    expect((await api(relay, 'POST', path(shared, 'request'), undefined, { cookie: phone.cookie }, JSON.stringify({ operationId: shareId(), kind: 'message', text: 'x'.repeat(SHARE_LIMITS.frameBytes) }))).status).toBe(413)
    const timed = mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' })
    await owner.next('request')
    expect((await timed).status).toBe(504)
    const pending = Array.from({ length: 32 }, () => mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' }))
    await Promise.all(Array.from({ length: 32 }, () => owner.next('request')))
    expect((await mobileRequest(relay, shared, phone.cookie, { operationId: shareId(), kind: 'state' })).status).toBe(429)
    const mobile = await sse(relay, path(shared, 'events'), { cookie: phone.cookie })
    await mobile.next('status')
    now = shared.expiresAt + 1
    relay.sweep()
    expect((await owner.next('closed')).reason).toBe('expired')
    expect((await Promise.all(pending)).every((result) => result.status === 410)).toBe(true)
    expect((await mobile.next('status', (frame) => !frame.authenticated)).online).toBe(false)
    expect((await api(relay, 'GET', path(shared, 'session'), undefined, { cookie: phone.cookie })).status).toBe(404)
    expect((await ownerApi(relay, shared, 'publish', { snapshot: {} })).status).toBe(404)
  })

  it('evicts old dedupe entries at 1024 operations while retaining recent acknowledgements', async () => {
    const relay = await fixture(), shared = await room(relay)
    const owner = await ownerStream(relay, shared), phone = await join(relay, shared)
    const ids: string[] = []
    for (let i = 0; i < SHARE_LIMITS.operations + 1; i++) {
      const id = shareId()
      ids.push(id)
      const result = await answer(relay, shared, owner, mobileRequest(relay, shared, phone.cookie, { operationId: id, kind: 'state' }), { name: 'Safe', revision: i })
      expect(result.status).toBe(200)
    }
    const count = owner.seen.filter((frame) => frame.type === 'request').length
    const recent = await mobileRequest(relay, shared, phone.cookie, { operationId: ids.at(-1), kind: 'state' })
    expect(recent.body.revision).toBe(SHARE_LIMITS.operations)
    expect(owner.seen.filter((frame) => frame.type === 'request')).toHaveLength(count)
    const evicted = await answer(relay, shared, owner, mobileRequest(relay, shared, phone.cookie, { operationId: ids[0], kind: 'state' }), { name: 'Safe', revision: 2000 })
    expect(evicted.body.revision).toBe(2000)
  }, 20_000)
})
