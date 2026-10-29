import { Script, runInNewContext } from 'node:vm'
import { request } from 'node:http'
import { Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openSakuraApiAuthorization, openSakuraApiPage, SAKURA_API_ORIGIN, SAKURA_AUTHORIZATION_URL } from '../src/integrations/sakuraapi-authorization.js'
import { clientAuthorization } from './sakuraapi-client-fixture.js'
import { createHash } from 'node:crypto'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks() })

async function fixture() {
  let url = ''
  const window = await openSakuraApiAuthorization({ openBrowser: async target => { url = target } })
  cleanups.push(() => window.close())
  const response = await fetch(url)
  return { url, origin: new URL(url).origin, window, response, html: await response.text(), authorized: clientAuthorization(window.draft!.state) }
}

describe('SakuraAPI official consent receiver', () => {
  it('uses an unguessable local one-shot receiver and never reads a browser profile', async () => {
    const f = await fixture()
    const authorized = f.authorized
    expect(f.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/)
    expect(f.response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(f.response.headers.get('cache-control')).toBe('no-store')
    expect(f.html).toContain(SAKURA_AUTHORIZATION_URL)
    const authorizationUrl = new URL(f.window.draft!.authorizeUrl)
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(createHash('sha256').update(f.window.draft!.verifier).digest('base64url'))
    expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(f.url)
    expect(authorizationUrl.searchParams.get('from')).toBe(f.origin)
    expect(f.html).not.toContain(f.window.draft!.verifier)
    expect(f.html).not.toMatch(/readAuthentication|auth_token|refresh_token|user-data-dir|localStorage/)
    const script = f.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!
    expect(() => new Script(script)).not.toThrow()
    const post = (body: unknown, origin?: string) => fetch(f.url + '/complete', { method: 'POST', headers: {
      'content-type': 'application/json', ...(origin ? { origin } : {}),
    }, body: JSON.stringify(body) })
    expect((await post(authorized)).status).toBe(403)
    expect((await post(authorized, 'https://evil.test')).status).toBe(403)
    expect((await post({ ...authorized, data: { code: 'bad code' } }, f.origin)).status).toBe(400)
    expect((await post({ ...authorized, state: 'x'.repeat(43) }, f.origin)).status).toBe(400)
    expect((await post(authorized, f.origin)).status).toBe(200)
    expect(await f.window.readAuthorization()).toEqual(authorized)
    expect((await post(authorized, f.origin)).status).toBe(200)
    expect((await post({ ...authorized, data: { ...authorized.data, code: 'd'.repeat(43) } }, f.origin)).status).toBe(409)
    expect(await f.window.readAuthorization()).toEqual(authorized)
    await f.window.close()
    await expect(fetch(f.url)).rejects.toThrow()
    await expect(f.window.readAuthorization()).rejects.toThrow()
  })

  it('rejects wrong Host even if the secret path is known', async () => {
    const f = await fixture()
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.url, { headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode!) })
      req.on('error', reject); req.end()
    })
    expect(status).toBe(403)
  })

  it('reallocates a Chromium-restricted random port before opening the browser', async () => {
    const address = Server.prototype.address
    vi.spyOn(Server.prototype, 'address').mockImplementationOnce(function (this: Server) {
      const bound = address.call(this)
      expect(bound && typeof bound !== 'string').toBe(true)
      return { ...(bound as { address: string; family: string; port: number }), port: 10080 }
    })
    const f = await fixture()
    expect(new URL(f.url).port).not.toBe('10080')
    expect(f.response.ok).toBe(true)
  })

  it('accepts only the exact official-origin AND exact popup source in the real callback script', async () => {
    const f = await fixture()
    const authorized = f.authorized
    const script = f.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!
    let click!: () => void, message!: (event: any) => Promise<void>
    const popup = { closed: false, focus: vi.fn() }, status = { textContent: '' }, button = { disabled: false, addEventListener: (_: string, listener: () => void) => { click = listener } }
    const sent: unknown[] = []
    runInNewContext(script, { document: { getElementById: (id: string) => id === 'authorize' ? button : status },
      window: { open: vi.fn(() => popup), setTimeout: vi.fn(), addEventListener: (_: string, listener: typeof message) => { message = listener } },
      location: { pathname: new URL(f.url).pathname }, fetch: async (_: unknown, init: any) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ received: true }) } } })
    click()
    const event = { origin: SAKURA_API_ORIGIN, source: popup, data: { source: 'sakura-client-authorization', ...authorized } }
    for (const invalid of [{ ...event, origin: 'https://sakuraapi.top.evil.test' }, { ...event, source: {} },
      { ...event, data: { ...event.data, source: 'other' } }, { ...event, data: { ...event.data, state: 'x'.repeat(43) } },
      { ...event, data: { ...event.data, data: { code: 'bad token', clientId: 'sakuracode' } } }]) await message(invalid)
    expect(sent).toEqual([])
    await message(event)
    expect(sent).toEqual([authorized])
    await message(event)
    expect(sent).toHaveLength(1)
    expect(status.textContent).toContain('安全回传')
  })

  it('official page commands cannot open arbitrary destinations or add credentials to a URL', async () => {
    const opened: string[] = []
    for (const page of ['purchase', 'keys', 'profile'] as const) await openSakuraApiPage(page, async url => { opened.push(url) })
    expect(opened).toEqual(['https://sakuraapi.top/purchase', 'https://sakuraapi.top/keys', 'https://sakuraapi.top/profile'])
    await expect(openSakuraApiPage('https://evil.test' as any, async () => {})).rejects.toThrow()
  })

  it('retries the same sanitized consent on callback failure without opening or creating another Key', async () => {
    const f = await fixture()
    const authorized = f.authorized
    const script = f.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!
    let click!: () => void, message!: (event: any) => Promise<void>
    const popup = { closed: false, focus: vi.fn() }, status = { textContent: '' }
    const button = { disabled: false, textContent: '', addEventListener: (_: string, listener: () => void) => { click = listener } }
    const open = vi.fn(() => popup), sent: unknown[] = []
    const post = vi.fn(async (_: unknown, init: any) => { sent.push(JSON.parse(init.body)); return { ok: sent.length > 1, json: async () => ({ received: true }) } })
    runInNewContext(script, { document: { getElementById: (id: string) => id === 'authorize' ? button : status },
      window: { open, setTimeout: vi.fn(), addEventListener: (_: string, listener: typeof message) => { message = listener } },
      location: { pathname: new URL(f.url).pathname }, fetch: post })
    click()
    await message({ origin: SAKURA_API_ORIGIN, source: popup, data: { source: 'sakura-client-authorization', ...authorized } })
    expect(button.disabled).toBe(false)
    expect(button.textContent).toBe('重试回传')
    expect(status.textContent).toContain('不会重复授权或创建 Key')
    await message({ origin: SAKURA_API_ORIGIN, source: popup, data: { source: 'sakura-client-authorization', state: authorized.state, event: 'denied' } })
    expect(sent).toHaveLength(1)
    popup.closed = true
    click()
    await vi.waitFor(() => expect(button.disabled).toBe(true))
    expect(open).toHaveBeenCalledOnce()
    expect(sent).toEqual([authorized, authorized])
    click()
    expect(sent).toHaveLength(2)
  })

  it('closes only its own pages after a successful authorized delivery is acknowledged, with manual fallback', async () => {
    const f = await fixture()
    let click!: () => void, message!: (event: any) => Promise<void>, acknowledge!: (value: unknown) => void
    const callbacks: Array<() => void> = [], popup = { closed: false, close: vi.fn(() => { throw new Error('blocked popup close') }) }
    const close = vi.fn(() => { throw new Error('ordinary tab close blocked') }), status = { textContent: '' }
    const button = { disabled: false, addEventListener: (_: string, listener: () => void) => { click = listener } }
    runInNewContext(f.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, {
      document: { getElementById: (id: string) => id === 'authorize' ? button : status },
      window: { open: () => popup, close, setTimeout: (callback: () => void) => { callbacks.push(callback) }, addEventListener: (_: string, listener: typeof message) => { message = listener } },
      location: { pathname: new URL(f.url).pathname }, fetch: async () => ({ ok: true, json: () => new Promise(resolve => { acknowledge = resolve }) }),
    })
    click()
    const delivery = message({ origin: SAKURA_API_ORIGIN, source: popup, data: { source: 'sakura-client-authorization', ...f.authorized } })
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'))
    expect(callbacks).toHaveLength(0)
    expect(close).not.toHaveBeenCalled(); expect(popup.close).not.toHaveBeenCalled()
    acknowledge({ received: true }); await delivery
    expect(callbacks).toHaveLength(1)
    expect(close).not.toHaveBeenCalled()
    expect(() => callbacks[0]!()).not.toThrow()
    expect(popup.close).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
    expect(status.textContent).toContain('手动关闭此页')
    expect(status.textContent).toContain('模型设置')
  })

  it.each(['denied', 'error', 'missing-ack', 'network-error'])('keeps %s states open without closing any page', async kind => {
    const f = await fixture()
    let click!: () => void, message!: (event: any) => Promise<void>
    const popup = { closed: false, close: vi.fn() }, close = vi.fn(), timer = vi.fn(), status = { textContent: '' }
    const button = { disabled: false, textContent: '', addEventListener: (_: string, listener: () => void) => { click = listener } }
    runInNewContext(f.html.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!, {
      document: { getElementById: (id: string) => id === 'authorize' ? button : status },
      window: { open: () => popup, close, setTimeout: timer, addEventListener: (_: string, listener: typeof message) => { message = listener } },
      location: { pathname: new URL(f.url).pathname }, fetch: async () => {
        if (kind === 'network-error') throw new Error('synthetic lost acknowledgement')
        return { ok: true, json: async () => kind === 'missing-ack' ? {} : { received: true } }
      },
    })
    click()
    await message({ origin: SAKURA_API_ORIGIN, source: popup, data: { source: 'sakura-client-authorization', ...f.authorized,
      ...(kind === 'denied' || kind === 'error' ? { event: kind } : {}) } })
    expect(timer).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled(); expect(popup.close).not.toHaveBeenCalled()
    if (kind === 'missing-ack' || kind === 'network-error') {
      expect(button.disabled).toBe(false); expect(button.textContent).toBe('重试回传')
    } else expect(button.disabled).toBe(true)
  })
})