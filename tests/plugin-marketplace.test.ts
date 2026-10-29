import { afterEach, describe, expect, it, vi } from 'vitest'
import { PluginMarketplace } from '../src/web/plugin-marketplace.js'

const catalogs: PluginMarketplace[] = []
afterEach(() => { while (catalogs.length) catalogs.pop()!.close(); vi.useRealTimers(); vi.unstubAllGlobals() })
const item = (name = 'sakuracode-plugin-review', extra: Record<string, unknown> = {}) => ({ package: {
  name, version: '1.2.3', description: '<img src=x onerror=alert(1)> review', keywords: ['sakuracode-plugin'],
  links: { npm: 'javascript:alert(1)', repository: 'https://untrusted.invalid/repo' }, ...extra } })
const reply = (objects: unknown[] = [item()], total = objects.length) => new Response(JSON.stringify({ objects, total }), { headers: { 'content-type': 'application/json' } })
function boot(fetcher: typeof fetch, timeoutMs = 1000) { const catalog = new PluginMarketplace({ fetch: fetcher, timeoutMs }); catalogs.push(catalog); return catalog }

describe('public npm plugin marketplace', () => {
  it('uses a fixed HTTPS registry/plugin scope, strips unsafe links, and sends no local credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply([item(), item('@team/sakura-plugin'), item('../bad'), item('unrelated', { keywords: ['other'] }), item()]))
    const result = await boot(fetcher).search(' review keywords:malicious ', 2)
    const [target, init] = fetcher.mock.calls[0]!
    const url = new URL(String(target))
    expect(url.origin).toBe('https://registry.npmjs.org'); expect(url.pathname).toBe('/-/v1/search')
    expect(url.searchParams.get('text')).toBe('keywords:sakuracode-plugin "review keywords:malicious"')
    expect(url.searchParams.get('size')).toBe('20'); expect(url.searchParams.get('from')).toBe('20')
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error', headers: { accept: 'application/json' } })
    expect(init?.body).toBeUndefined(); expect(JSON.stringify(init)).not.toMatch(/authorization|cookie|workspace|apiKey/i)
    expect(result).toMatchObject({ source: 'npm', query: 'review keywords:malicious', page: 2, pageSize: 20 })
    expect(result.items.map(row => row.npmUrl)).toEqual(['https://www.npmjs.com/package/sakuracode-plugin-review', 'https://www.npmjs.com/package/@team/sakura-plugin'])
    expect(result.items[0]?.description).toContain('<img')
    expect(JSON.stringify(result)).not.toContain('javascript:'); expect(result.checkedAt).toMatch(/^\d{4}-/)
  })

  it('resolves the default network transport after plugins mount without overriding an explicitly injected transport', async () => {
    const catalog = new PluginMarketplace(); catalogs.push(catalog)
    const instrumented = vi.fn<typeof fetch>(async () => reply()), pinned = vi.fn<typeof fetch>(async () => reply())
    vi.stubGlobal('fetch', instrumented)
    await catalog.search('plugin-network-instrumentation')
    await boot(pinned).search('pinned-test-transport')
    expect(instrumented).toHaveBeenCalledTimes(1); expect(pinned).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent searches, returns independent cached values and expires old cache', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(async () => reply()), catalog = boot(fetcher)
    const results = await Promise.all([catalog.search('review'), catalog.search('review')])
    expect(fetcher).toHaveBeenCalledTimes(1)
    results[0]!.items[0]!.name = 'changed'
    expect(results[1]!.items[0]!.name).toBe('sakuracode-plugin-review')
    expect((await catalog.search('review')).items[0]!.name).toBe('sakuracode-plugin-review')
    expect(fetcher).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5 * 60_000 + 1)
    await catalog.search('review'); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('validates query/page before networking and accepts a genuinely empty market', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply([], 0)), catalog = boot(fetcher)
    for (const query of ['a'.repeat(121), 'line\nbreak', { url: 'http://localhost' }]) expect(() => catalog.search(query)).toThrow()
    for (const page of [0, 51, 1.5, NaN, '2']) expect(() => catalog.search('', page)).toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    expect(await catalog.search()).toMatchObject({ items: [], total: 0 })
  })

  it('bounds oversized response headers and streaming bodies', async () => {
    for (const response of [
      new Response('{}', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      new Response('x'.repeat(1024 * 1024 + 1)),
    ]) await expect(boot(async () => response).search()).rejects.toMatchObject({ status: 502 })
  })

  it('rejects redirects/HTTP errors/malformed data without reflecting external secrets', async () => {
    for (const fetcher of [
      async () => { throw new Error('SYNTHETIC_SECRET http://private.invalid') },
      async () => new Response('SYNTHETIC_SECRET', { status: 302, headers: { location: 'http://localhost' } }),
      async () => new Response('SYNTHETIC_SECRET', { status: 429 }),
      async () => new Response('not json'),
      async () => new Response(JSON.stringify({ objects: [], total: -1 })),
      async () => new Response(JSON.stringify({ objects: [], total: '999' })),
    ]) {
      const error = await boot(fetcher).search().catch(error => error as Error)
      expect(error).toMatchObject({ status: 502 }); expect(String(error)).not.toContain('SYNTHETIC_SECRET')
    }
  })

  it('times out non-cooperating transports and allows an explicit retry', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(() => {})).mockImplementation(async () => reply())
    const catalog = boot(fetcher, 50), first = catalog.search()
    const checked = expect(first).rejects.toMatchObject({ status: 504 })
    await vi.advanceTimersByTimeAsync(51); await checked
    expect((await catalog.search()).items).toHaveLength(1); expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('closes in-flight searches and cannot be reused after shutdown', async () => {
    const catalog = boot(async () => new Promise(() => {})), request = catalog.search()
    const checked = expect(request).rejects.toMatchObject({ status: 503 })
    catalog.close(); catalog.close(); await checked
    await expect(catalog.search()).rejects.toMatchObject({ status: 503 })
  })

  it('limits unrelated in-flight searches without rejecting a shared request', async () => {
    const catalog = boot(async () => new Promise(() => {}))
    const pending = ['one', 'two', 'three', 'one'].map(query => catalog.search(query).catch(error => error))
    await expect(catalog.search('four')).rejects.toMatchObject({ status: 429 })
    catalog.close(); expect((await Promise.all(pending)).every(error => error.status === 503)).toBe(true)
  })
})