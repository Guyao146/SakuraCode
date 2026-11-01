/** Offline usage statistics regressions. Never send events to the production application. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DesktopStatistics, StatisticsFileStore, STATISTICS_QUEUE_LIMIT, defaultStatisticsSettings,
  parseStatisticsSettings, parseStatisticsStored, validateStatisticsAcknowledgement,
  type StatisticsEvent, type StatisticsStore, type StatisticsStored } from '../src/desktop/statistics.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.useRealTimers(); vi.restoreAllMocks()
})
const settings = (enabled = true) => ({ enabled, endpoint: 'https://statistics.invalid/api/collect', appId: 'offline_desktop_fixture' })
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const response = (accepted = 1) => new Response(JSON.stringify({ accepted, duplicates: 0, rejected: [] }))
function memory(initial: unknown | null = { schemaVersion: 1, settings: settings(false), anonymousId: null, events: [], dropped: 0, rejected: 0 }) {
  // Lifecycle fixtures begin with an explicit opt-out; default-on tests pass null.
  let value: unknown | null = copy(initial)
  const store: StatisticsStore = { read: vi.fn(async () => copy(value)), write: vi.fn(async next => { value = copy(next) }) }
  return { store, saved: () => copy(value) as StatisticsStored, put: (next: unknown) => { value = copy(next) } }
}
function clock() {
  let wall = Date.parse('2026-10-31T12:00:00Z'), tick = 0
  return { now: () => wall, monotonic: () => tick, advance: (ms: number) => { wall += ms; tick += ms },
    wall: (value: string) => { wall = Date.parse(value) } }
}
function client(store: StatisticsStore, transport: typeof fetch = vi.fn(() => { throw new Error('External network forbidden') }), time = clock(), autoFlush = false, timeoutMs = 5000) {
  const instance = new DesktopStatistics({ store, fetch: transport, appVersion: '1.1.0', autoFlush, clock: time, timeoutMs })
  cleanups.push(() => { instance.close() })
  return { instance, transport, time }
}
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-statistics-offline-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return dir
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('desktop statistics configuration and privacy', () => {
  it('ships the provided public application id enabled and accepts HTTPS or loopback-only fixtures', () => {
    expect(defaultStatisticsSettings()).toEqual({ enabled: true, endpoint: 'https://web.mcylyr.cn/api/collect', appId: '00f1f158e0bf1d00e84fd321' })
    expect(parseStatisticsSettings(settings())).toEqual(settings())
    expect(parseStatisticsSettings({ ...settings(), endpoint: 'http://127.0.0.1:4500/api/collect' }).endpoint).toBe('http://127.0.0.1:4500/api/collect')
    for (const value of [null, [], {}, { ...settings(), token: 'DO_NOT_TRANSMIT' }, { ...settings(), enabled: 'yes' },
      { ...settings(), appId: 'has space' }, { ...settings(), appId: 'x'.repeat(129) }]) expect(() => parseStatisticsSettings(value)).toThrow()
    for (const endpoint of ['http://remote.invalid/api/collect', 'https://user:password@statistics.invalid/api/collect',
      'https://statistics.invalid/api/collect?token=secret', 'https://statistics.invalid/api/collect#fragment',
      'https://statistics.invalid/wrong', 'ftp://statistics.invalid/api/collect', 'https://statistics.invalid\\api/collect']) {
      expect(() => parseStatisticsSettings({ ...settings(), endpoint })).toThrow()
    }
  })

  it('automatically persists one startup for missing preferences and sends without a configure call', async () => {
    const mem = memory(null), fetcher = vi.fn<typeof fetch>(async () => response()), { instance } = client(mem.store, fetcher)
    expect(instance.status().ready).toBe(false)
    instance.markActive(); await instance.start(); await instance.start()
    expect(instance.status()).toMatchObject({ ready: true, settings: defaultStatisticsSettings(), pending: 1 })
    expect(mem.saved().events).toHaveLength(1)
    expect(mem.saved().events[0]).toMatchObject({ event_type: 'app_start', anonymous_id: mem.saved().anonymousId })
    expect(mem.store.write).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled()
    expect(await instance.flushOnce()).toBe(true)
    expect(fetcher.mock.calls[0]?.[0]).toBe(defaultStatisticsSettings().endpoint)
    expect(instance.status().pending).toBe(0)
  })

  it('keeps the automatically created installation identity and creates a fresh session on restart', async () => {
    const mem = memory(null), { instance: first } = client(mem.store)
    await first.start(); const original = mem.saved(); first.close()
    const { instance: restarted } = client(mem.store); await restarted.start(); await restarted.start()
    expect(mem.saved().anonymousId).toBe(original.anonymousId)
    expect(mem.saved().events).toHaveLength(2)
    expect(mem.saved().events[1]?.session_id).not.toBe(original.events[0]?.session_id)
    expect(mem.saved().events.map(event => event.event_type)).toEqual(['app_start', 'app_start'])
  })

  it('does not send after automatic startup persistence fails and recovers only after an explicit successful save', async () => {
    const mem = memory(null), fetcher = vi.fn<typeof fetch>(async () => response()), { instance } = client(mem.store, fetcher)
    vi.mocked(mem.store.write).mockRejectedValueOnce(new Error('PRIVATE_STARTUP_STORAGE_ERROR'))
    await instance.start(); instance.markActive(); await instance.whenIdle()
    expect(instance.status()).toMatchObject({ ready: true, pending: 0 })
    expect(instance.status().lastError).toContain('暂停发送')
    expect(instance.status().lastError).not.toContain('PRIVATE_STARTUP_STORAGE_ERROR')
    expect(await instance.flushOnce()).toBe(false); expect(fetcher).not.toHaveBeenCalled(); expect(mem.saved()).toBeNull()
    await instance.configure(defaultStatisticsSettings())
    expect(mem.saved().events).toHaveLength(1); expect(instance.status().lastError).toBeNull()
    expect(await instance.flushOnce()).toBe(true)
  })

  it('does not create identity, storage or network traffic when disabled, even with user actions or flush calls', async () => {
    const mem = memory(), { instance, transport } = client(mem.store)
    instance.markActive()
    await instance.start(); await instance.start()
    instance.markActive(); await instance.whenIdle(); await instance.flushOnce()
    expect(instance.status()).toMatchObject({ ready: true, settings: { enabled: false }, pending: 0 })
    expect(mem.store.write).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled()
    const root = await directory(), data = path.join(root, 'saved-disabled'), store = new StatisticsFileStore(data)
    await store.write(mem.saved())
    const before = await fs.readFile(path.join(data, 'state.json'), 'utf8')
    const disk = new DesktopStatistics({ directory: data, appVersion: '1.1.0', fetch: transport, autoFlush: false })
    cleanups.push(() => disk.close()); await disk.start()
    expect(disk.status().settings.enabled).toBe(false)
    expect(await fs.readFile(path.join(data, 'state.json'), 'utf8')).toBe(before)
    expect(await fs.readdir(data)).toEqual(['state.json']); expect(transport).not.toHaveBeenCalled()
  })

  it('sends only the allowed random identifiers and product metadata without authentication, Origin or private data', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response())
    const mem = memory(), { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings())
    const saved = mem.saved(), event = saved.events[0]!
    expect(event.event_type).toBe('app_start')
    expect(Object.keys(event).sort()).toEqual(['anonymous_id', 'app_version', 'event_id', 'event_type', 'occurred_at', 'platform', 'schema_version', 'sdk_version', 'session_id'].sort())
    for (const id of [event.event_id, event.anonymous_id, event.session_id]) expect(id).toMatch(/^[a-f0-9-]{36}$/)
    expect(event.app_version).toBe('1.1.0'); expect(event.sdk_version).toBe('sakuracode-desktop/1')
    expect(instance.status()).not.toHaveProperty('anonymousId'); expect(instance.status()).not.toHaveProperty('sessionId')
    expect(await instance.flushOnce()).toBe(true)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(settings().endpoint)
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', method: 'POST' })
    const headers = new Headers(init!.headers)
    expect([...headers.keys()].sort()).toEqual(['content-type', 'user-agent'])
    expect(JSON.parse(String(init!.body))).toEqual({ app_id: settings().appId, events: [event] })
    expect(instance.status()).toMatchObject({ pending: 0, lastError: null })
  })

  it('commits consent before sending and preserves previous preferences after storage failure', async () => {
    const mem = memory(), { instance, transport } = client(mem.store)
    await instance.start()
    vi.mocked(mem.store.write).mockRejectedValueOnce(new Error('private path C:\\Users\\name token=PRIVATE'))
    await expect(instance.configure(settings())).rejects.toThrow('原设置保留')
    expect(instance.status().settings.enabled).toBe(false)
    expect(instance.status().pending).toBe(0); expect(transport).not.toHaveBeenCalled()
    await instance.configure(settings()); const before = mem.saved()
    vi.mocked(mem.store.write).mockRejectedValueOnce(new Error('disk full'))
    await expect(instance.configure(settings(false))).rejects.toThrow('无法保存')
    expect(mem.saved()).toEqual(before); expect(instance.status().settings).toEqual(settings())
  })

  it('stores an empty application id without creating identity/events or making requests, including after restart', async () => {
    const mem = memory(), { instance, transport } = client(mem.store)
    await instance.start()
    await instance.configure({ ...settings(), appId: '' })
    instance.markActive(); await instance.whenIdle(); expect(await instance.flushOnce()).toBe(false)
    expect(mem.saved()).toMatchObject({ anonymousId: null, events: [], settings: { enabled: true, appId: '' } })
    expect(parseStatisticsStored(mem.saved()).anonymousId).toBeNull()
    instance.close()
    const { instance: restarted } = client(mem.store, transport)
    await restarted.start(); restarted.markActive(); await restarted.whenIdle(); await restarted.flushOnce()
    expect(mem.saved().events).toHaveLength(0); expect(transport).not.toHaveBeenCalled()
    await restarted.configure(settings())
    expect(mem.saved().events).toHaveLength(1); expect(mem.saved().anonymousId).not.toBeNull()
  })

  it('retains malformed local state for explicit recovery without uploading arbitrary fields', async () => {
    const mem = memory(); mem.put({ settings: settings(), events: [{ apiKey: 'DO_NOT_TRANSMIT' }] })
    const { instance, transport } = client(mem.store)
    await instance.start(); expect(instance.status().lastError).toContain('暂停发送')
    expect(mem.store.write).not.toHaveBeenCalled(); expect(await instance.flushOnce()).toBe(false)
    await instance.configure(settings(false)); expect(instance.status().lastError).toBeNull()
    expect(mem.saved()).toMatchObject({ anonymousId: null, events: [], settings: { enabled: false } })
    expect(transport).not.toHaveBeenCalled()
  })
})

describe('desktop statistics identity and real activity lifecycle', () => {
  it('keeps installation identity across restarts, creates one session/start per process and rotates on opt-out/re-enable', async () => {
    const mem = memory(), { instance: first } = client(mem.store)
    await first.start(); await first.configure(settings()); await first.configure(settings())
    const original = mem.saved(); expect(original.events).toHaveLength(1)
    first.close()
    const { instance: second } = client(mem.store)
    await second.start(); await second.start()
    const restarted = mem.saved(); expect(restarted.events).toHaveLength(2)
    expect(restarted.anonymousId).toBe(original.anonymousId)
    expect(restarted.events[1]!.session_id).not.toBe(original.events[0]!.session_id)
    await second.configure(settings(false))
    expect(mem.saved()).toMatchObject({ anonymousId: null, events: [] })
    await second.configure(settings())
    expect(mem.saved().anonymousId).not.toBe(original.anonymousId)
    expect(mem.saved().events).toHaveLength(0) // Opt-in mid-process is not another launch.
    second.markActive(); await second.whenIdle()
    expect(mem.saved().events[0]!.event_type).toBe('active')
  })

  it('merges real actions for five monotonic minutes, counts cross-day actions and never invents an idle heartbeat', async () => {
    const mem = memory(), { instance, time } = client(mem.store)
    await instance.start(); await instance.configure(settings())
    time.wall('2026-10-31T15:59:50Z')
    instance.markActive(); await instance.whenIdle()
    for (let n = 0; n < 30; n++) instance.markActive()
    await instance.whenIdle(); expect(mem.saved().events).toHaveLength(2)
    time.advance(299_999); instance.markActive(); await instance.whenIdle()
    // Crossing midnight in Asia/Shanghai immediately allows the next real action.
    expect(mem.saved().events).toHaveLength(3)
    time.advance(300_000); await instance.whenIdle()
    expect(mem.saved().events).toHaveLength(3)
    instance.markActive(); await instance.whenIdle(); expect(mem.saved().events).toHaveLength(4)
    time.wall('2026-11-01T02:00:00Z'); instance.markActive(); await instance.whenIdle()
    expect(mem.saved().events).toHaveLength(4) // A wall clock jump cannot bypass same-day monotonic merging.
  })

  it('clears old queues and identities on endpoint/app changes, rather than forwarding old events to another service', async () => {
    const mem = memory(), { instance } = client(mem.store)
    await instance.start(); await instance.configure(settings()); const original = mem.saved()
    const replacement = { ...settings(), appId: 'different_fixture' }
    await instance.configure(replacement)
    const next = mem.saved(); expect(next.events).toHaveLength(1)
    expect(next.anonymousId).not.toBe(original.anonymousId)
    expect(next.events[0]!.event_id).not.toBe(original.events[0]!.event_id)
    expect(next.settings).toEqual(replacement)
  })
})

describe('desktop statistics acknowledgement and retry safety', () => {
  it('requires complete nonnegative counts and valid unique rejected ids', () => {
    expect(validateStatisticsAcknowledgement({ accepted: 1, duplicates: 0, rejected: [] }, ['one'])).toBe(0)
    expect(validateStatisticsAcknowledgement({ accepted: 0, duplicates: 0, rejected: [{ event_id: 'one', code: 'invalid_time' }] }, ['one'])).toBe(1)
    for (const value of [null, [], {}, { accepted: true, duplicates: 0, rejected: [] }, { accepted: -1, duplicates: 2, rejected: [] },
      { accepted: 0, duplicates: 0, rejected: [] }, { accepted: 1, duplicates: 1, rejected: [] },
      { accepted: 0, duplicates: 0, rejected: [{ event_id: 'other', code: 'invalid_time' }] },
      { accepted: 0, duplicates: 0, rejected: [{ event_id: 'one', code: '' }] },
      { accepted: 0, duplicates: 0, rejected: [{ event_id: 'one', code: 'invalid_time' }, { event_id: 'one', code: 'invalid_time' }] }]) {
      expect(() => validateStatisticsAcknowledgement(value, ['one'])).toThrow()
    }
  })

  it('retries byte-identical original events after response loss and accepts duplicate confirmations', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('response lost PRIVATE'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 0, duplicates: 1, rejected: [] })))
    const mem = memory(), { instance, time } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings()); const original = mem.saved()
    expect(await instance.flushOnce()).toBe(false)
    expect(mem.saved()).toEqual(original); expect(instance.status().lastError).not.toContain('PRIVATE')
    expect(await instance.flushOnce()).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1)
    time.advance(70_000); expect(await instance.flushOnce()).toBe(true)
    expect(fetcher.mock.calls[1]![1]!.body).toBe(fetcher.mock.calls[0]![1]!.body)
    expect(instance.status().pending).toBe(0)
  })

  it('keeps malformed acknowledgements and HTTP failures queued and does not let new actions bypass backoff', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(0))
      .mockResolvedValueOnce(new Response('SECRET_RESPONSE', { status: 403 })).mockResolvedValueOnce(response(2))
    const mem = memory(), { instance, time } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings())
    expect(await instance.flushOnce()).toBe(false); expect(instance.status().pending).toBe(1)
    instance.markActive(); await instance.whenIdle(); expect(instance.status().pending).toBe(2)
    expect(await instance.flushOnce()).toBe(false); expect(fetcher).toHaveBeenCalledTimes(1)
    time.advance(70_000); expect(await instance.flushOnce()).toBe(false)
    expect(instance.status().lastError).toContain('HTTP 403'); expect(instance.status().lastError).not.toContain('SECRET_RESPONSE')
    time.advance(70_000); expect(await instance.flushOnce()).toBe(true)
    expect(instance.status().pending).toBe(0)
  })

  it('redacts arbitrary transport exception text even when it looks like a statistics diagnostic', async () => {
    const mem = memory(), fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('统计服务 PRIVATE_TOKEN C:\\Users\\private\\project'))
    const { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings()); expect(await instance.flushOnce()).toBe(false)
    expect(instance.status().lastError).toBe('匿名统计网络请求失败或超时，原批次保留；主任务不受影响。')
  })

  it('bounds response streams, rejects oversized acknowledgements and retains the original batch', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
      .mockResolvedValueOnce(new Response('x'.repeat(64 * 1024 + 1)))
    const mem = memory(), { instance, time } = client(mem.store, fetcher, clock(), false, 50)
    await instance.start(); await instance.configure(settings()); const original = mem.saved()
    const flight = instance.flushOnce(); await vi.advanceTimersByTimeAsync(51)
    expect(await flight).toBe(false); expect(cancel).toHaveBeenCalled()
    expect(mem.saved()).toEqual(original); time.advance(70_000)
    expect(await instance.flushOnce()).toBe(false); expect(mem.saved()).toEqual(original)
  })

  it('preserves newly queued events while acknowledging a snapshot and never creates two concurrent requests', async () => {
    const pending = deferred<Response>(), fetcher = vi.fn<typeof fetch>(() => pending.promise)
    const mem = memory(), { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings())
    const first = instance.flushOnce(), duplicate = instance.flushOnce(); expect(first).toBe(duplicate)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    instance.markActive(); await instance.whenIdle(); expect(mem.saved().events).toHaveLength(2)
    pending.resolve(response()); expect(await first).toBe(true)
    expect(mem.saved().events).toHaveLength(1); expect(mem.saved().events[0]!.event_type).toBe('active')
  })

  it('removes explicitly rejected events only on complete confirmation and never displays server text', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init!.body)) as { events: StatisticsEvent[] }
      return new Response(JSON.stringify({ accepted: 0, duplicates: 0, rejected: [{ event_id: body.events[0]!.event_id, code: 'invalid_time', message: 'PRIVATE_SERVER_TEXT' }] }))
    })
    const mem = memory(), { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings())
    expect(await instance.flushOnce()).toBe(true)
    expect(instance.status()).toMatchObject({ pending: 0, rejected: 1 })
    expect(instance.status().lastError).not.toContain('PRIVATE_SERVER_TEXT')
  })

  it('retains the original batch when acknowledgement cannot be durably saved and pauses sending', async () => {
    const mem = memory(), { instance, transport } = client(mem.store, vi.fn<typeof fetch>(async () => response()))
    await instance.start(); await instance.configure(settings()); const original = mem.saved()
    vi.mocked(mem.store.write).mockRejectedValueOnce(new Error('PRIVATE_PATH disk failure'))
    expect(await instance.flushOnce()).toBe(false); expect(mem.saved()).toEqual(original)
    expect(instance.status().lastError).toContain('本地保存失败')
    expect(await instance.flushOnce()).toBe(false); expect(transport).toHaveBeenCalledTimes(1)
  })

  it('clears identity/queue and aborts in-flight sends on disable; late replies cannot recreate them', async () => {
    const pending = deferred<Response>(), fetcher = vi.fn<typeof fetch>(() => pending.promise)
    const mem = memory(), { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings()); const flight = instance.flushOnce()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    const signal = fetcher.mock.calls[0]![1]!.signal!
    await instance.configure(settings(false)); expect(signal.aborted).toBe(true)
    expect(await flight).toBe(false); pending.resolve(response()); await instance.whenIdle()
    expect(mem.saved()).toMatchObject({ anonymousId: null, events: [], settings: { enabled: false } })
    instance.markActive(); await instance.whenIdle(); expect(mem.saved().events).toHaveLength(0)
  })

  it('bounds noncooperative requests and response bodies, clears abort listeners and closes without flush', async () => {
    vi.useFakeTimers()
    const pending = deferred<Response>(), fetcher = vi.fn<typeof fetch>(() => pending.promise)
    const mem = memory(), { instance } = client(mem.store, fetcher, clock(), false, 50)
    await instance.start(); await instance.configure(settings())
    const flight = instance.flushOnce(); await vi.advanceTimersByTimeAsync(1)
    const signal = fetcher.mock.calls[0]![1]!.signal!
    await vi.advanceTimersByTimeAsync(50)
    expect(await flight).toBe(false); expect(signal.aborted).toBe(true)
    expect(getEventListeners(signal, 'abort')).toHaveLength(0)
    expect(mem.saved().events).toHaveLength(1)
    instance.close(); expect(vi.getTimerCount()).toBe(0); expect(fetcher).toHaveBeenCalledTimes(1)
    pending.resolve(response()); await vi.advanceTimersByTimeAsync(0)
    expect(mem.saved().events).toHaveLength(1)
  })

  it('does not wait on network during close and leaves unconfirmed events for restart', async () => {
    const pending = deferred<Response>(), fetcher = vi.fn<typeof fetch>(() => pending.promise)
    const mem = memory(), { instance } = client(mem.store, fetcher)
    await instance.start(); await instance.configure(settings()); const flight = instance.flushOnce()
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1)); const before = mem.saved()
    instance.close(); instance.close()
    expect(await flight).toBe(false); expect(mem.saved()).toEqual(before)
    await expect(instance.configure(settings())).rejects.toThrow('closed')
    pending.resolve(response()); await instance.whenIdle(); expect(mem.saved()).toEqual(before)
  })

  it('caps pending events and discards old events without transmitting them', async () => {
    const mem = memory(), { instance: seed } = client(mem.store)
    await seed.start(); await seed.configure(settings()); const saved = mem.saved(), event = saved.events[0]!
    seed.close(); saved.events = Array.from({ length: STATISTICS_QUEUE_LIMIT }, () => ({ ...event, event_id: randomUUID() }))
    mem.put(saved)
    const { instance } = client(mem.store); await instance.start()
    expect(instance.status()).toMatchObject({ pending: STATISTICS_QUEUE_LIMIT, dropped: 1 })
    instance.markActive(); await instance.whenIdle(); expect(instance.status()).toMatchObject({ pending: STATISTICS_QUEUE_LIMIT, dropped: 2 })
    instance.close()
    saved.events = [{ ...event, occurred_at: '2026-10-01T00:00:00.000Z' }]; mem.put(saved)
    const { instance: expired, transport } = client(mem.store, vi.fn<typeof fetch>(async () => response()))
    await expired.start(); expect(expired.status()).toMatchObject({ pending: 1, dropped: 1 })
    await expired.flushOnce(); const request = JSON.parse(String(vi.mocked(transport).mock.calls[0]![1]!.body)) as { events: StatisticsEvent[] }
    expect(request.events).toHaveLength(1); expect(request.events[0]!.event_id).not.toBe(event.event_id)
  })

  it('keeps a corrupt or overlarge persisted event from carrying arbitrary payloads to the sender', async () => {
    const mem = memory(), { instance } = client(mem.store)
    await instance.start(); await instance.configure(settings()); const saved = mem.saved()
    expect(parseStatisticsStored(saved)).toEqual(saved)
    for (const patch of [{ path: '/PRIVATE_PROJECT' }, { app_version: 'user@example.com' }, { event_type: 'page_view' },
      { event_type: ['active'] }, { platform: ['windows'] },
      { occurred_at: '2026-02-30T00:00:00.000Z' }, { anonymous_id: randomUUID() }, { sdk_version: 'other' }]) {
      expect(() => parseStatisticsStored({ ...saved, events: [{ ...saved.events[0], ...patch }] })).toThrow()
    }
    const root = await directory(), store = new StatisticsFileStore(root)
    await fs.writeFile(path.join(root, 'state.json'), 'x'.repeat(512 * 1024 + 1))
    await expect(store.read()).rejects.toThrow('size limit')
    expect(await fs.readFile(path.join(root, 'state.json'), 'utf8')).toHaveLength(512 * 1024 + 1)
  })
})

describe('desktop statistics disk and scheduling', () => {
  it('re-arms failure backoff after an action arrives during an in-flight background send', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const pending = deferred<Response>()
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline one'))
      .mockRejectedValueOnce(new Error('offline two'))
      .mockRejectedValueOnce(new Error('offline three'))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(response(2))
    const mem = memory(), { instance, time } = client(mem.store, fetcher, clock(), true)
    await instance.start(); await instance.configure(settings())
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await instance.flushOnce()).toBe(false)
      time.advance(70_000)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(4)
    const flight = instance.flushOnce()
    instance.markActive(); await instance.whenIdle()
    expect(instance.status().pending).toBe(2)
    pending.resolve(new Response('', { status: 503 }))
    expect(await flight).toBe(false)
    time.advance(10_000); await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(4) // Do not bypass the 16-second fourth backoff.
    time.advance(6_000); await vi.advanceTimersByTimeAsync(6_000)
    expect(fetcher).toHaveBeenCalledTimes(5) // Retry even without another user action.
    expect(instance.status().pending).toBe(0)
    instance.close(); expect(vi.getTimerCount()).toBe(0)
  })

  it('atomically persists only its own file and reuses identity in an independent directory', async () => {
    const root = await directory(), data = path.join(root, 'usage-statistics')
    await fs.writeFile(path.join(root, 'sakuraapi.json'), 'PROTECTED_ACCOUNT_UNCHANGED')
    const store = new StatisticsFileStore(data), { instance } = client(store)
    await instance.start(); await instance.configure(settings())
    const original = parseStatisticsStored(await store.read()); instance.close()
    const { instance: restarted } = client(new StatisticsFileStore(data)); await restarted.start()
    const next = parseStatisticsStored(await store.read())
    expect(next.anonymousId).toBe(original.anonymousId); expect(next.events).toHaveLength(2)
    expect(await fs.readdir(data)).toEqual(['state.json'])
    expect(await fs.readFile(path.join(root, 'sakuraapi.json'), 'utf8')).toBe('PROTECTED_ACCOUNT_UNCHANGED')
    await restarted.configure(settings(false)); expect(parseStatisticsStored(await store.read()).anonymousId).toBeNull()
  })

  it('schedules one unrefed sender automatically and never manufactures background activity', async () => {
    vi.useFakeTimers()
    const mem = memory(null), fetcher = vi.fn<typeof fetch>(async () => response()), { instance } = client(mem.store, fetcher, clock(), true)
    await instance.start(); expect(vi.getTimerCount()).toBe(1); expect(fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(9999); expect(fetcher).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); expect(fetcher).toHaveBeenCalledTimes(1)
    expect(instance.status().pending).toBe(0); instance.close(); expect(vi.getTimerCount()).toBe(0)
  })
})