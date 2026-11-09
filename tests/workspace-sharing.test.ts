import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceShareClient } from '../src/sharing/client.js'
import {
  SHARE_LIMITS, shareDigest, type RelayOwnerEvent, type ShareDevice, type SharePublish, type ShareReply,
  type ShareRequest, type ShareStatus, type SharedWorkspace,
} from '../src/sharing/protocol.js'

const ORIGIN = 'https://relay.example'
const REGISTRATION = 'registration-test-token-0123456789abcdef'
const OWNER = 'opaque-owner-capability/not-a-share-secret'
const ROOM = 'a'.repeat(32)
const DEVICE = 'b'.repeat(32)
const DEVICE_TWO = 'c'.repeat(32)
const START = { relayOrigin: ORIGIN, registrationToken: REGISTRATION, workspaceId: 'workspace-a' }

function snapshot(): SharedWorkspace {
  return {
    workspaceId: START.workspaceId, name: 'Safe workspace', revision: 1, sessionId: 'session-a',
    busy: false, expertMode: false, sessions: [], agents: [], todos: [],
  }
}
function device(id = DEVICE, role: ShareDevice['role'] = 'viewer'): RelayOwnerEvent {
  return { type: 'device', device: { id, name: 'Phone', role, online: true, connectedAt: 1000 } }
}
function request(number: number, kind: ShareRequest['kind'], extra: Partial<ShareRequest> = {}): RelayOwnerEvent {
  return { type: 'request', request: {
    requestId: number.toString(16).padStart(32, '0'), operationId: (number + 10000).toString(16).padStart(32, '0'),
    deviceId: DEVICE, kind, ...(kind === 'message' ? { text: 'Do the task', sessionId: 'session-a' } : {}),
    ...(kind === 'stop' ? { sessionId: 'session-a' } : {}), ...extra,
  } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function settle() {
  for (let i = 0; i < 90; i++) await Promise.resolve()
}
function json(value?: unknown, status = 200) {
  return new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

interface Call { url: string; method: string; body?: unknown; signal: AbortSignal; headers: Headers }
class FakeRelay {
  calls: Call[] = []
  streams: Array<{ push(text: string | Uint8Array): void; end(): void; signal: AbortSignal; cancelled: boolean }> = []
  publishes: SharePublish[] = []
  deviceReply?: (call: Call) => Promise<Response>
  publishReply?: (call: Call) => Promise<Response>
  createReply?: (call: Call) => Promise<Response>
  deleteReply?: (call: Call) => Promise<Response>
  now = 1000
  readonly fetch: typeof fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    expect(url.startsWith(`${ORIGIN}/api/rooms`)).toBe(true)
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.has('cookie')).toBe(false)
    const call: Call = {
      url, method: init?.method ?? 'GET', headers, signal: init!.signal!,
      ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
    }
    this.calls.push(call)
    if (url === `${ORIGIN}/api/rooms` && call.method === 'POST') {
      expect(headers.get('authorization')).toBe(`Bearer ${REGISTRATION}`)
      return this.createReply ? this.createReply(call) : json({ roomId: ROOM, ownerToken: OWNER, expiresAt: this.now + SHARE_LIMITS.shareMs })
    }
    expect(headers.get('authorization')).toBe(`Bearer ${OWNER}`)
    if (url.endsWith('/owner/events') && call.method === 'GET') {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const entry = {
        push: (text: string | Uint8Array) => controller.enqueue(typeof text === 'string' ? new TextEncoder().encode(text) : text),
        end: () => controller.close(), signal: call.signal, cancelled: false,
      }
      const stream = new ReadableStream<Uint8Array>({ start: value => { controller = value }, cancel: () => { entry.cancelled = true } })
      this.streams.push(entry)
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    }
    if (url.endsWith('/publish') && call.method === 'POST') {
      this.publishes.push(call.body as SharePublish)
      return this.publishReply ? this.publishReply(call) : json({ ok: true })
    }
    if (url.endsWith('/device') && call.method === 'POST') return this.deviceReply ? this.deviceReply(call) : json({ ok: true })
    if (url.endsWith('/invite') && call.method === 'POST') return json({ ok: true })
    if (url === `${ORIGIN}/api/rooms/${ROOM}` && call.method === 'DELETE') return this.deleteReply ? this.deleteReply(call) : json({ ok: true })
    throw new Error(`Unexpected relay endpoint: ${call.method} ${url}`)
  }) as typeof fetch

  event(value: RelayOwnerEvent | Record<string, unknown>, index = this.streams.length - 1) {
    this.streams[index]!.push(`data: ${JSON.stringify(value)}\r\n\r\n`)
  }
  responses() { return this.publishes.flatMap(value => value.response ? [value.response] : []) }
}

const clients: WorkspaceShareClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()))
  vi.useRealTimers()
})
function setup(overrides: {
  workspace?: () => Promise<SharedWorkspace>
  request?: (request: ShareRequest, assertActive: () => void) => Promise<ShareReply>
  shareMs?: number
} = {}) {
  const relay = new FakeRelay()
  let current = snapshot()
  const changed = vi.fn((_: ShareStatus) => {})
  const workspace = vi.fn(overrides.workspace ?? (async () => current))
  const action = vi.fn(overrides.request ?? (async (value: ShareRequest, assertActive: () => void): Promise<ShareReply> => {
    assertActive()
    if (value.kind === 'state') return { status: 200, data: current }
    if (value.kind === 'history') return { status: 200, data: { sessionId: 'session-a', entries: [], truncated: false } }
    return { status: 202, data: { ok: true, queued: true, message: 'Queued' } }
  }))
  const client = new WorkspaceShareClient({ fetch: relay.fetch, workspace, request: action, changed, now: () => relay.now, shareMs: overrides.shareMs })
  clients.push(client)
  return { relay, client, workspace, action, changed, setWorkspace(value: SharedWorkspace) { current = value } }
}
async function online(value: ReturnType<typeof setup>, role: ShareDevice['role'] = 'viewer') {
  await value.client.start(START)
  value.relay.event({ type: 'hello' })
  value.relay.event(device(DEVICE, role))
  await settle()
  await value.client.refresh()
}

describe('WorkspaceShareClient restricted owner connection', () => {
  it('never autostarts, validates explicit start, hashes a local 64-character invite and keeps owner credentials private', async () => {
    const { relay, client, workspace } = setup()
    client.observe({ type: 'text', text: 'private raw stream' })
    await client.refresh()
    expect(client.status()).toEqual({ phase: 'idle', devices: [] })
    expect(relay.calls).toHaveLength(0)
    expect(workspace).not.toHaveBeenCalled()
    for (const relayOrigin of ['http://relay.example', 'https://relay.example/path', 'https://u:p@relay.example', 'https://relay.example/?x=1']) {
      await expect(client.start({ ...START, relayOrigin })).rejects.toThrow()
    }
    await expect(client.start({ ...START, registrationToken: 'short' })).rejects.toThrow()
    expect(relay.calls).toHaveLength(0)
    await client.start(START)
    const url = new URL(client.status().inviteUrl!)
    expect(url.pathname).toBe(`/connect/${ROOM}`)
    expect(url.search).toBe('')
    const secret = new URLSearchParams(url.hash.slice(1)).get('invite')!
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(relay.calls[0]!.body).toEqual({
      inviteHash: shareDigest(secret), inviteExpiresAt: relay.now + SHARE_LIMITS.inviteMs, expiresAt: relay.now + SHARE_LIMITS.shareMs,
    })
    expect(JSON.stringify(relay.calls.map(value => ({ url: value.url, body: value.body })))).not.toContain(secret)
    expect(JSON.stringify(client.status())).not.toContain(OWNER)
    expect(JSON.stringify(client.status())).not.toContain(REGISTRATION)
    expect(client.status().phase).toBe('connecting')
    expect(relay.publishes.some(value => value.snapshot?.workspaceId === START.workspaceId)).toBe(true)
  })

  it('consumes the invite on a joined device, rotates only hashed invites, and never accepts relay-granted controller authority', async () => {
    const value = setup()
    await online(value, 'controller')
    expect(value.client.status().inviteUrl).toBeUndefined()
    expect(value.client.status().devices[0]!.role).toBe('viewer')
    const first = await value.client.rotateInvite()
    const second = await value.client.rotateInvite()
    expect(first.inviteUrl).not.toBe(second.inviteUrl)
    const invite = value.relay.calls.filter(call => call.url.endsWith('/invite')).at(-1)!
    expect(Object.keys(invite.body as object).sort()).toEqual(['inviteExpiresAt', 'inviteHash'])
    value.relay.event(request(1, 'message'))
    await settle()
    expect(value.action).not.toHaveBeenCalled()
    expect(value.relay.responses().at(-1)).toMatchObject({ status: 403 })
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    expect(value.client.status().devices[0]!.role).toBe('controller')
    value.relay.event(request(2, 'message'))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(1)
    expect(value.relay.calls.find(call => call.url.endsWith('/device'))!.body).toEqual({ id: DEVICE, role: 'controller' })
    value.relay.event(device(DEVICE_TWO, 'controller'))
    await settle()
    expect(value.client.status().inviteUrl).toBeUndefined()
    expect(value.client.status().devices.find(phone => phone.id === DEVICE_TWO)!.role).toBe('viewer')
  })

  it('allows viewer state/history but rejects stale-session mutations and strips all non-DTO reply fields', async () => {
    const value = setup({ request: async (incoming, assertActive) => {
      assertActive()
      if (incoming.kind === 'state') return { status: 200, data: { ...snapshot(), cwd: 'D:\\private\\project', ownerToken: OWNER, config: { key: REGISTRATION } } }
      if (incoming.kind === 'history') return { status: 200, data: {
        sessionId: 'session-a', entries: [{ seq: 1, time: '2026-11-08T12:00:00Z', kind: 'assistant', text: 'See D:\\private\\code.txt token=abcdef', arguments: REGISTRATION }],
        truncated: false, attachments: ['file:///private'],
      } }
      return { status: 202, data: { ok: true, queued: true, message: 'Queued', config: REGISTRATION, ownerToken: OWNER } }
    } })
    await online(value)
    value.relay.event(request(10, 'state'))
    value.relay.event(request(11, 'history', { sessionId: 'session-a' }))
    await settle()
    const state = value.relay.responses().find(reply => reply.requestId === 'a'.padStart(32, '0'))!
    expect(state.status).toBe(200)
    expect(Object.keys(state.data as object).sort()).toEqual(Object.keys(snapshot()).sort())
    const history = value.relay.responses().find(reply => reply.requestId === 'b'.padStart(32, '0'))!
    expect(history.data).toEqual({ sessionId: 'session-a', entries: [{ seq: 1, time: '2026-11-08T12:00:00Z', kind: 'assistant', text: 'See [local path] token=[redacted]' }], truncated: false })
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    value.relay.event(request(12, 'message', { sessionId: 'old-session' }))
    await settle()
    expect(value.relay.responses().at(-1)).toMatchObject({ status: 409 })
    expect(value.action).toHaveBeenCalledTimes(2)
    value.relay.event(request(13, 'message'))
    await settle()
    expect(value.relay.responses().at(-1)!.data).toEqual({ ok: true, queued: true, message: 'Queued' })
    expect(JSON.stringify(value.relay.responses())).not.toContain(REGISTRATION)
    expect(JSON.stringify(value.relay.responses())).not.toContain(OWNER)
  })

  it.each([400, 409, 503])('preserves thrown rejection status %i without exposing callback error details', async status => {
    const value = setup({ request: async (_incoming, assertActive) => {
      assertActive()
      throw Object.assign(new Error(`Do not expose ${OWNER} ${REGISTRATION} D:\\private\\code.txt`), {
        status, data: { ownerToken: OWNER },
      })
    } })
    await online(value)
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    value.relay.event(request(70, 'message', { text: '@file private.txt' }))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(1)
    expect(value.relay.responses().at(-1)).toEqual({
      requestId: (70).toString(16).padStart(32, '0'), status, error: '工作区请求未能完成，请在电脑上检查。',
    })
    expect(JSON.stringify(value.relay.responses())).not.toContain(OWNER)
    expect(JSON.stringify(value.relay.responses())).not.toContain(REGISTRATION)
    expect(JSON.stringify(value.relay.responses())).not.toContain('private.txt')
  })

  it('maps missing or non-integer/non-4xx/5xx thrown statuses to a safe 500', async () => {
    const rejectedStatuses: unknown[] = [undefined, '400', 399, 600, 409.5]
    let next = 0
    const value = setup({ request: async (_incoming, assertActive) => {
      assertActive()
      throw { status: rejectedStatuses[next++], message: OWNER, data: REGISTRATION }
    } })
    await online(value)
    for (let i = 0; i < rejectedStatuses.length; i++) {
      value.relay.event(request(80 + i, 'state'))
      await settle()
      expect(value.relay.responses().at(-1)).toMatchObject({ status: 500, error: '工作区请求未能完成，请在电脑上检查。' })
    }
    expect(value.action).toHaveBeenCalledTimes(rejectedStatuses.length)
    expect(JSON.stringify(value.relay.responses())).not.toContain(OWNER)
    expect(JSON.stringify(value.relay.responses())).not.toContain(REGISTRATION)
  })

  it('invalidates in-flight guards synchronously on downgrade/revoke and cannot grant on a late successful POST', async () => {
    const mutation = deferred<ShareReply>()
    let savedGuard!: () => void
    const value = setup({ request: async (_incoming, assertActive) => { savedGuard = assertActive; return mutation.promise } })
    await online(value)
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    value.relay.event(request(20, 'message'))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(1)
    savedGuard()
    const pendingPost = deferred<Response>()
    value.relay.deviceReply = () => pendingPost.promise
    const downgraded = value.client.setDevice({ id: DEVICE, role: 'viewer' })
    expect(() => savedGuard()).toThrow()
    expect(value.client.status().devices[0]!.role).toBe('viewer')
    await settle()
    mutation.resolve({ status: 202, data: { ok: true } })
    pendingPost.resolve(json({ ok: true }))
    await downgraded
    await settle()
    expect(value.relay.responses().some(reply => reply.requestId === (20).toString(16).padStart(32, '0'))).toBe(false)

    const grantPost = deferred<Response>()
    value.relay.deviceReply = call => (call.body as { role?: string }).role === 'controller' ? grantPost.promise : Promise.resolve(json({ ok: true }))
    const granting = value.client.setDevice({ id: DEVICE, role: 'controller' })
    const grantOutcome = granting.catch(error => error)
    await settle()
    const revoked = value.client.setDevice({ id: DEVICE, revoke: true })
    expect(value.client.status().devices).toEqual([])
    grantPost.resolve(json({ ok: true }))
    await grantOutcome
    await revoked
    value.relay.event(device(DEVICE, 'controller'))
    await settle()
    expect(value.client.status().devices).toEqual([])
  })

  it('deduplicates pending and completed operation IDs per device and rejects conflicting reuse', async () => {
    const pending = deferred<ShareReply>()
    const value = setup({ request: async (_incoming, guard) => { guard(); return pending.promise } })
    await online(value)
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    const operationId = 'd'.repeat(32)
    value.relay.event(request(30, 'message', { operationId }))
    value.relay.event(request(31, 'message', { operationId }))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(1)
    pending.resolve({ status: 202, data: { ok: true, queued: false } })
    await settle()
    expect(value.relay.responses().filter(reply => reply.status === 202)).toHaveLength(2)
    value.relay.event(request(32, 'message', { operationId }))
    value.relay.event(request(33, 'message', { operationId, text: 'Different task' }))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(1)
    expect(value.relay.responses().some(reply => reply.status === 409)).toBe(true)
    value.relay.event(device(DEVICE_TWO))
    await settle()
    await value.client.setDevice({ id: DEVICE_TWO, role: 'controller' })
    value.relay.event(request(34, 'message', { operationId, deviceId: DEVICE_TWO }))
    await settle()
    expect(value.action).toHaveBeenCalledTimes(2)
  })

  it('rebuilds SSE presence after reconnect while retaining only explicit local grants and caps reconnect backoff', async () => {
    vi.useFakeTimers()
    const value = setup()
    await online(value, 'controller')
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    value.relay.streams[0]!.end()
    await settle()
    expect(value.client.status().phase).toBe('offline')
    expect(value.client.status().devices[0]!.online).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(value.relay.streams).toHaveLength(2)
    value.relay.event({ type: 'hello' })
    await settle()
    expect(value.client.status().devices).toEqual([])
    value.relay.event(device(DEVICE, 'viewer'))
    value.relay.event(device(DEVICE_TWO, 'controller'))
    await settle()
    expect(value.client.status().devices.find(phone => phone.id === DEVICE)!.role).toBe('controller')
    expect(value.client.status().devices.find(phone => phone.id === DEVICE_TWO)!.role).toBe('viewer')
    for (const backoff of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
      const previous = value.relay.streams.length
      value.relay.streams.at(-1)!.end()
      await settle()
      await vi.advanceTimersByTimeAsync(backoff - 1)
      expect(value.relay.streams).toHaveLength(previous)
      await vi.advanceTimersByTimeAsync(1)
      expect(value.relay.streams).toHaveLength(previous + 1)
    }
  })

  it('parses bounded split CRLF/UTF-8 frames, ignores unknown events, and never applies a request timeout to a healthy stream', async () => {
    vi.useFakeTimers()
    const value = setup()
    await value.client.start(START)
    const stream = value.relay.streams[0]!
    for (const piece of [': heartbeat\r', '\ndata: {"type":"hello"}\r', '\n\r', '\n']) stream.push(piece)
    const joined = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'device', device: { id: DEVICE, name: '手机', role: 'controller', online: true, connectedAt: 1000 } })}\r\n\r\n`)
    for (let i = 0; i < joined.length; i += 3) {
      stream.push(joined.subarray(i, i + 3))
      await settle() // Drain each transport chunk; one fixed microtask budget cannot consume the whole frame.
    }
    await settle()
    expect(value.client.status().phase).toBe('online')
    expect(value.client.status().devices[0]!.name).toBe('手机')
    value.relay.event({ type: 'invite-consumed' })
    await settle()
    await vi.advanceTimersByTimeAsync(SHARE_LIMITS.requestMs * 2)
    expect(stream.signal.aborted).toBe(false)
    expect(value.relay.streams).toHaveLength(1)
    stream.push(`data: ${'x'.repeat(SHARE_LIMITS.frameBytes + 1)}`)
    await settle()
    expect(value.client.status().phase).toBe('offline')
    expect(stream.cancelled).toBe(true)
  })

  it('coalesces observe/refresh to the latest sanitized snapshot and never forwards raw event payloads', async () => {
    const gate = deferred<Response>()
    const value = setup()
    await online(value)
    value.relay.publishes = []
    const reads = value.workspace.mock.calls.length
    let blocked = false
    value.relay.publishReply = () => {
      if (!blocked) { blocked = true; return gate.promise }
      return Promise.resolve(json({ ok: true }))
    }
    value.setWorkspace({ ...snapshot(), revision: 2 })
    value.client.observe({ type: 'text', text: 'ownerToken=private-raw-secret', agentId: 'raw-secret' })
    const refreshing = value.client.refresh()
    await settle()
    for (let revision = 3; revision <= 30; revision++) {
      value.setWorkspace({ ...snapshot(), revision, name: 'token=private-title' })
      value.client.observe({ type: 'tool', text: 'D:\\private\\raw.txt', name: 'private-tool-arguments' })
    }
    gate.resolve(json({ ok: true }))
    await refreshing
    expect(value.workspace.mock.calls.length - reads).toBe(2)
    expect(value.relay.publishes).toHaveLength(2)
    expect(value.relay.publishes.at(-1)!.snapshot).toMatchObject({ revision: 30, name: 'token=[redacted]' })
    expect(value.relay.publishes.every(publication => JSON.stringify(publication.event) === '{"type":"changed"}')).toBe(true)
    expect(JSON.stringify(value.relay.publishes)).not.toContain('private-raw-secret')
    expect(JSON.stringify(value.relay.publishes)).not.toContain('private-tool-arguments')
  })

  it('stops before publishing a different workspace and rejects the action after a workspace changes during a fresh read', async () => {
    const value = setup()
    await online(value)
    const uploads = value.relay.publishes.length
    value.setWorkspace({ ...snapshot(), workspaceId: 'workspace-b', name: 'Never upload this' })
    await expect(value.client.refresh()).rejects.toThrow()
    expect(value.client.status()).toEqual({ phase: 'idle', devices: [] })
    expect(value.relay.publishes).toHaveLength(uploads)
    expect(value.relay.calls.some(call => call.method === 'DELETE')).toBe(true)
    expect(value.relay.streams[0]!.signal.aborted).toBe(true)

    const read = deferred<SharedWorkspace>()
    let block = false
    const second = setup({ workspace: async () => block ? read.promise : snapshot() })
    await online(second)
    await second.client.setDevice({ id: DEVICE, role: 'controller' })
    block = true
    second.relay.event(request(50, 'message'))
    await settle()
    read.resolve({ ...snapshot(), workspaceId: 'workspace-b' })
    await settle()
    expect(second.action).not.toHaveBeenCalled()
    expect(second.client.status().phase).toBe('idle')
    expect(JSON.stringify(second.relay.publishes)).not.toContain('workspace-b')
  })

  it('stop aborts subscription and queued publications before best-effort bounded deletion; close is permanent and late replies cannot write', async () => {
    vi.useFakeTimers()
    const publish = deferred<Response>(), deletion = deferred<Response>()
    const value = setup()
    await online(value)
    value.relay.publishReply = () => publish.promise
    value.relay.deleteReply = () => deletion.promise
    value.client.observe({ type: 'changed' })
    await settle()
    const inFlight = value.relay.calls.filter(call => call.url.endsWith('/publish')).at(-1)!
    const uploads = value.relay.publishes.length
    const stopped = value.client.stop()
    expect(inFlight.signal.aborted).toBe(true)
    expect(value.relay.streams[0]!.signal.aborted).toBe(true)
    expect(value.client.status()).toEqual({ phase: 'idle', devices: [] })
    value.client.observe({ type: 'changed' })
    await value.client.refresh()
    publish.resolve(json({ ok: true }))
    await settle()
    expect(value.relay.publishes).toHaveLength(uploads)
    await vi.advanceTimersByTimeAsync(4999)
    const removed = value.relay.calls.find(call => call.method === 'DELETE')!
    expect(removed.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopped
    expect(removed.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(30000)
    expect(value.relay.calls.filter(call => call.method === 'DELETE')).toHaveLength(1)
    await value.client.close()
    await expect(value.client.start(START)).rejects.toThrow()
    expect(value.client.status().phase).toBe('idle')
  })

  it('enforces invite/share TTL locally and drops an action that expires while pending', async () => {
    const pending = deferred<ShareReply>()
    let assertActive!: () => void
    const value = setup({ request: async (_incoming, guard) => { assertActive = guard; return pending.promise } })
    await online(value)
    await value.client.rotateInvite()
    value.relay.now += SHARE_LIMITS.inviteMs
    expect(value.client.status().inviteUrl).toBeUndefined()
    await value.client.setDevice({ id: DEVICE, role: 'controller' })
    value.relay.event(request(60, 'message'))
    await settle()
    assertActive()
    value.relay.now = 1000 + SHARE_LIMITS.shareMs
    expect(() => assertActive()).toThrow()
    pending.resolve({ status: 202, data: { ok: true } })
    await settle()
    expect(value.client.status().phase).toBe('idle')
    expect(value.relay.responses()).toHaveLength(0)
  })

  it('bounds JSON bodies and connecting timeouts without leaking error bodies or silently retrying start', async () => {
    vi.useFakeTimers()
    const oversized = setup()
    oversized.relay.createReply = async () => new Response('x'.repeat(SHARE_LIMITS.frameBytes + 1))
    await expect(oversized.client.start(START)).rejects.toThrow()
    expect(oversized.client.status().phase).toBe('error')
    expect(oversized.relay.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(30000)
    expect(oversized.relay.calls).toHaveLength(1)
    const timed = setup()
    timed.relay.createReply = () => new Promise(() => {})
    const outcome = timed.client.start(START).catch(error => error)
    await settle()
    await vi.advanceTimersByTimeAsync(SHARE_LIMITS.requestMs)
    await outcome
    expect(timed.client.status().phase).toBe('error')
    expect(timed.relay.calls[0]!.signal.aborted).toBe(true)
    expect(timed.relay.calls).toHaveLength(1)
  })
})
