/** Pure in-memory update regressions: no server, browser, credentials, or external requests. */
import { getEventListeners } from 'node:events'
import { ReadableStream } from 'node:stream/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, DEFAULT_UPDATES_URL, UpdateChecker } from '../src/updates.js'

const instances = new Set<UpdateChecker>()
const SOURCE = 'https://updates.invalid/releases/latest'
const OFFICIAL = 'https://github.com/Guyao146/SakuraCode/releases/tag/'
const LIMIT = 1024 * 1024

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => { throw new Error('network disabled in update unit tests') }))
})

afterEach(() => {
  for (const instance of instances) instance.close()
  instances.clear()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function checker(fetcher: typeof fetch, current = '0.7.2', timeoutMs = 1000): UpdateChecker {
  const instance = new UpdateChecker(current, SOURCE, { fetch: fetcher, timeoutMs })
  instances.add(instance)
  return instance
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

const release = (tag = 'v0.8.0', extra: Record<string, unknown> = {}): Response => json({ tag_name: tag, ...extra })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

// An intentionally non-cooperative fetch also exercises late responses after timeout/close.
function heldFetch() {
  const pending = deferred<Response>()
  let signal!: AbortSignal
  const fetcher = vi.fn<typeof fetch>((_input, init) => {
    signal = init!.signal!
    return pending.promise
  })
  return { fetcher, pending, signal: () => signal }
}

describe('update version comparison', () => {
  it.each([
    ['0.9.0', '0.10.0', -1], ['2.0.0', '1.99.99', 1],
    ['v1.2.3', ' V1.2.3+build.7 ', 0], ['1.2.3+one', '1.2.3+two', 0],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1], ['1.0.0-alpha.1', '1.0.0-alpha.beta', -1],
    ['1.0.0-beta.2', '1.0.0-beta.11', -1], ['1.0.0-rc.1', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1], ['1.0.0-beta', '1.0.0-alpha', 1],
    ['9007199254740992.0.0', '9007199254740993.0.0', -1],
    ['1.0.0-9007199254740993', '1.0.0-9007199254740992', 1],
    ['1.0.0-rc.1', '1.0.0-rc.1+build', 0],
  ])('compares %s and %s', (a, b, order) => {
    expect(compareVersions(a as string, b as string)).toBe(order)
  })

  it.each(['', 'v', '1', '1.2', '1.2.3.4', '01.2.3', '-1.2.3', '1.2.x', '1.2.3tail',
    '1.2.3-01', '1.2.3-rc.01', '1.2.3+', '1.2.3+bad..id', '1.2.3\ntrailing', '1.2.3/path'])('rejects invalid version %j', value => {
    expect(() => compareVersions(value, '1.2.3')).toThrow('invalid semantic version')
    expect(() => compareVersions('1.2.3', value)).toThrow('invalid semantic version')
  })
})

describe('update state and notification ownership', () => {
  it('notifies once per version across repeats, failures, recovery and later releases', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release())
      .mockRejectedValueOnce(new Error('offline fixture'))
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release('v0.9.0'))
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release('v0.9.0'))
    const instance = checker(fetcher)
    const outcomes = []
    for (let i = 0; i < 7; i++) outcomes.push(await instance.checkAndDetectChange())
    expect(outcomes.map(result => result.isNew)).toEqual([true, false, false, false, true, false, false])
    expect(outcomes[2]!.info).toMatchObject({ latest: '0.8.0', hasUpdate: true, error: 'offline fixture' })
    expect(outcomes[3]!.info.error).toBeUndefined()
    expect(instance.notifiedOfUpdate()).toBe(true)
  })

  it('keeps manual checks separate from notification claims and normalizes version identity', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release('V0.8.0+build.1'))
      .mockResolvedValueOnce(release('0.8.0+build.2'))
    const instance = checker(fetcher)
    await instance.check()
    expect(instance.notifiedOfUpdate()).toBe(false)
    expect((await instance.checkAndDetectChange()).isNew).toBe(true)
    expect((await instance.checkAndDetectChange()).isNew).toBe(false)
    expect((await instance.checkAndDetectChange()).isNew).toBe(false)
  })

  it('retains last-known release fields on failure and removes the error on recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(release())
    const instance = checker(fetcher)
    const first = await instance.check()
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
    const failed = await instance.check()
    expect(failed).toEqual({ ...first, error: 'offline', checkedAt: '2026-01-02T00:00:00.000Z' })
    expect(instance.cached()).toEqual(failed)
    expect((await instance.check()).error).toBeUndefined()
    expect(instance.notifiedOfUpdate()).toBe(false)
  })

  it.each(['v0.7.2', 'v0.6.0'])('does not notify for equal or older version %s', async tag => {
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValue(release(tag)))
    expect(await instance.checkAndDetectChange()).toMatchObject({ info: { hasUpdate: false }, isNew: false })
    expect(instance.notifiedOfUpdate()).toBe(false)
  })

  it('coalesces manual and detecting calls into one fetch with exactly one notification winner', async () => {
    const held = heldFetch()
    const instance = checker(held.fetcher)
    const manual = instance.check()
    const detections = Array.from({ length: 10 }, () => instance.checkAndDetectChange())
    expect(instance.check()).toBe(manual)
    await Promise.resolve()
    expect(held.fetcher).toHaveBeenCalledTimes(1)
    held.pending.resolve(release())
    expect((await manual).latest).toBe('0.8.0')
    expect((await Promise.all(detections)).filter(result => result.isNew)).toHaveLength(1)
  })

  it('does not expose the mutable cache through returned snapshots or successful results', async () => {
    const instance = checker(vi.fn<typeof fetch>().mockImplementation(async () => release()))
    const result = await instance.check()
    result.latest = '99.0.0'
    instance.cached()!.hasUpdate = false
    expect(instance.cached()).toMatchObject({ latest: '0.8.0', hasUpdate: true })
  })
})

describe('update lifecycle and deadlines', () => {
  it('combines a caller lifecycle signal with the default ten-second deadline', async () => {
    vi.useFakeTimers()
    const held = heldFetch()
    const instance = new UpdateChecker('0.7.2', SOURCE, { fetch: held.fetcher })
    instances.add(instance)
    const owner = new AbortController()
    const result = instance.check(owner.signal)
    await vi.advanceTimersByTimeAsync(9999)
    expect(held.signal()).not.toBe(owner.signal)
    expect(held.signal().aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ error: 'update check timed out', hasUpdate: false })
    expect(held.signal().aborted).toBe(true)
    expect(owner.signal.aborted).toBe(false)
    expect(getEventListeners(owner.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cannot overwrite a retry with a late response from a timed-out fetch', async () => {
    vi.useFakeTimers()
    const held = heldFetch()
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(held.fetcher).mockResolvedValueOnce(release('v0.9.0'))
    const instance = checker(fetcher, '0.7.2', 25)
    const first = instance.checkAndDetectChange()
    await vi.advanceTimersByTimeAsync(25)
    expect((await first).isNew).toBe(false)
    expect(await instance.checkAndDetectChange()).toMatchObject({ info: { latest: '0.9.0' }, isNew: true })
    held.pending.resolve(release('v0.8.0'))
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.cached()).toMatchObject({ latest: '0.9.0', hasUpdate: true })
    expect(instance.cached()!.error).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the shared request for all callers when any participating lifecycle is aborted', async () => {
    const signals: AbortSignal[] = []
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(release()).mockImplementation((_input, init) => {
      const signal = init!.signal!
      signals.push(signal)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    })
    const instance = checker(fetcher)
    await instance.check()
    const cached = instance.cached()
    const firstOwner = new AbortController()
    const secondOwner = new AbortController()
    const first = instance.checkAndDetectChange(firstOwner.signal)
    const second = instance.checkAndDetectChange(secondOwner.signal)
    await Promise.resolve()
    secondOwner.abort()
    for (const result of await Promise.all([first, second])) {
      expect(result).toMatchObject({ info: { latest: '0.8.0', hasUpdate: true, error: 'update check cancelled' }, isNew: false })
    }
    expect(firstOwner.signal.aborted).toBe(false)
    expect(signals[0]!.aborted).toBe(true)
    expect(instance.cached()).toEqual(cached)
    expect(instance.notifiedOfUpdate()).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(getEventListeners(firstOwner.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(secondOwner.signal, 'abort')).toHaveLength(0)
  })

  it('does not start a check for an already-aborted caller, but such a joiner cancels an existing flight', async () => {
    const held = heldFetch()
    const instance = checker(held.fetcher)
    const owner = new AbortController()
    owner.abort()
    expect((await instance.check(owner.signal)).error).toBe('update check cancelled')
    expect(held.fetcher).not.toHaveBeenCalled()
    expect(instance.cached()).toBeUndefined()
    const first = instance.check()
    await Promise.resolve()
    expect(instance.check(owner.signal)).toBe(first)
    expect((await first).error).toBe('update check cancelled')
    expect(held.signal().aborted).toBe(true)
    expect(instance.cached()).toBeUndefined()
  })

  it('removes completed owner listeners so a former caller cannot cancel a later check', async () => {
    vi.useFakeTimers()
    const held = heldFetch()
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValueOnce(release()).mockImplementationOnce(held.fetcher))
    const owner = new AbortController()
    await instance.check(owner.signal)
    expect(getEventListeners(owner.signal, 'abort')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    const next = instance.check()
    await Promise.resolve()
    owner.abort()
    expect(held.signal().aborted).toBe(false)
    held.pending.resolve(release('v0.9.0'))
    expect((await next).latest).toBe('0.9.0')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes idempotently before a deferred fetch starts and refuses later checks', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(release())
    const instance = checker(fetcher)
    const first = instance.checkAndDetectChange()
    instance.close()
    instance.close()
    expect(await first).toMatchObject({ info: { error: 'update checker is closed' }, isNew: false })
    expect((await instance.check()).error).toBe('update checker is closed')
    expect(fetcher).not.toHaveBeenCalled()
    expect(instance.cached()).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles close without a cooperative fetch and blocks late cache writes or notices', async () => {
    vi.useFakeTimers()
    const held = heldFetch()
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValueOnce(release()).mockImplementationOnce(held.fetcher))
    await instance.check()
    const cached = instance.cached()
    const pending = instance.checkAndDetectChange()
    await Promise.resolve()
    instance.close()
    expect(await pending).toMatchObject({ info: { latest: '0.8.0', error: 'update checker is closed' }, isNew: false })
    expect(held.signal().aborted).toBe(true)
    held.pending.resolve(release('v0.9.0'))
    await vi.advanceTimersByTimeAsync(0)
    expect(instance.cached()).toEqual(cached)
    expect(instance.notifiedOfUpdate()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['timeout', 'close'] as const)('cancels a stalled response body on %s', async action => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{"tag_name":')) }, cancel,
    })
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValue(new Response(body)), '0.7.2', 25)
    const pending = instance.check()
    await vi.advanceTimersByTimeAsync(0)
    if (action === 'close') instance.close()
    else await vi.advanceTimersByTimeAsync(25)
    expect((await pending).error).toBe(action === 'close' ? 'update checker is closed' : 'update check timed out')
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('update source validation and offline transport', () => {
  it.each([null, [], {}, { tag_name: 1 }, { tag_name: '' }, { tag_name: 'v' }, { tag_name: '99.0.nope' },
    { tag_name: '0.8.0tail' }, { tag_name: '1.2' }, { tag_name: '01.2.3' }, { tag_name: '1.2.3.4' }])('reports malformed release %j as an error', async body => {
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValue(json(body)))
    const result = await instance.checkAndDetectChange()
    expect(result.info.error).toBeTruthy()
    expect(result.info.hasUpdate).toBe(false)
    expect(result.isNew).toBe(false)
  })

  it.each([{ tag_name: 'v0.8.0-rc.1' }, { tag_name: 'v0.8.0', draft: true },
    { tag_name: 'v0.8.0', prerelease: true }, { tag_name: 'v0.8.0', prerelease: 'false' }])('rejects unstable release %j', async body => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(json(body))).checkAndDetectChange()
    expect(result.info.error).toContain('stable releases only')
    expect(result.isNew).toBe(false)
  })

  it('offers the stable release to a prerelease installation', async () => {
    const instance = checker(vi.fn<typeof fetch>().mockResolvedValue(release('v0.8.0', { draft: false, prerelease: false })), '0.8.0-rc.1')
    expect(await instance.checkAndDetectChange()).toMatchObject({ info: { latest: '0.8.0', hasUpdate: true }, isNew: true })
  })

  it.each([undefined, 'javascript:alert(1)', 'https://example.invalid/releases/v0.8.0',
    'https://github.com.evil.invalid/Guyao146/SakuraCode/releases/tag/v0.8.0',
    'https://user:secret@github.com/Guyao146/SakuraCode/releases/tag/v0.8.0',
    'http://github.com/Guyao146/SakuraCode/releases/tag/v0.8.0',
    OFFICIAL + 'v99.0.0', OFFICIAL + 'v0.8.0?redirect=elsewhere', OFFICIAL + 'v0.8.0'])('only returns the canonical official release URL for html_url=%j', async html_url => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(release('v0.8.0', { html_url }))).check()
    expect(result.releaseUrl).toBe(OFFICIAL + 'v0.8.0')
  })

  it('encodes a valid tag in the canonical URL without interpreting build metadata as a URL', async () => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(release('v0.8.0+build.7'))).check()
    expect(result.releaseUrl).toBe(OFFICIAL + 'v0.8.0%2Bbuild.7')
  })

  it.each([403, 404, 429, 503])('returns HTTP %s errors and cancels the unused body', async status => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }))).check()
    expect(result.error).toBe(`update source returned ${status}`)
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('reports malformed JSON instead of throwing', async () => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(new Response('{bad'))).check()
    expect(result.error).toBeTruthy()
    expect(result.hasUpdate).toBe(false)
  })

  it('rejects an oversized declared response without reading its body', async () => {
    const response = new Response('small', { headers: { 'content-length': String(LIMIT + 1) } })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(response)).check()
    expect(result.error).toContain('exceeds 1 MiB')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('counts streaming bytes even when content-length is absent or dishonest', async () => {
    const cancel = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(LIMIT))
      controller.enqueue(new Uint8Array(1))
    }, cancel })
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'content-length': '1' } }))).check()
    expect(result.error).toContain('exceeds 1 MiB')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('accepts a valid response exactly at the byte limit', async () => {
    const body = JSON.stringify({ tag_name: 'v0.8.0' }).padEnd(LIMIT, ' ')
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(new Response(body))).check()
    expect(result.error).toBeUndefined()
    expect(result.latest).toBe('0.8.0')
  })

  it('keeps the legacy constructor and default source without sending ambient credentials', async () => {
    vi.stubEnv('SAKURA_API_KEY', 'private-fixture-key')
    vi.stubEnv('SAKURA_WEB_TOKEN', 'private-fixture-token')
    vi.stubEnv('GITHUB_TOKEN', 'private-fixture-github-token')
    const fetcher = vi.mocked(globalThis.fetch).mockResolvedValueOnce(release())
    const instance = new UpdateChecker('0.7.2')
    instances.add(instance)
    await instance.check()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(DEFAULT_UPDATES_URL)
    expect(Object.fromEntries(new Headers(init!.headers).entries())).toEqual({ accept: 'application/vnd.github+json', 'user-agent': 'SakuraCode/0.7.2' })
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(init!.body).toBeUndefined()
  })
})
