import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SakuraApiAccount, parseSakuraApiSaved, SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL, type SakuraApiSaved, type SakuraApiStatus } from '../src/integrations/sakuraapi.js'
import { parseSakuraApiUsage } from '../src/integrations/sakuraapi-usage.js'
import { runWebServer } from '../src/web/server.js'
import { authorized, authorizedKey, envelope, modelIds, sakuraApiResponse, usage } from './sakuraapi-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks(); vi.useRealTimers() })
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}
function fixture(extra: Partial<ConstructorParameters<typeof SakuraApiAccount>[0]> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return sakuraApiResponse(url, init)
  })
  const window = { readAuthorization: vi.fn(async (): Promise<unknown> => authorized), close: vi.fn(async () => {}) }
  const persist = vi.fn(async (_value: SakuraApiSaved | null) => {})
  const account = new SakuraApiAccount({ fetch: fetcher as typeof globalThis.fetch, openLogin: async () => window, persist, ...extra })
  cleanups.push(() => account.close())
  const connect = async (remember = true) => { const login = await account.beginLogin(remember); return account.pollLogin(login.login!.id) }
  return { account, calls, fetcher, window, persist, connect }
}

describe('SakuraAPI official Key authorization', () => {
  it('waits for official consent, then synchronizes Key models and quotas without exposing credentials', async () => {
    const { account, calls, window, persist } = fixture()
    const login = await account.beginLogin(true)
    expect(window.readAuthorization).not.toHaveBeenCalled()
    window.readAuthorization.mockResolvedValueOnce(null)
    expect((await account.pollLogin(login.login!.id)).phase).toBe('login')
    expect(persist).not.toHaveBeenCalled()
    const connected = await account.pollLogin(login.login!.id)
    expect(connected).toMatchObject({ phase: 'connected', remember: true, authorization: 'official-key-consent', models: modelIds,
      balance: 5.09, subscriptions: [{ windows: [{ period: 'daily', remaining: 8 }, { period: 'weekly', remaining: 35 }, { period: 'monthly', limit: 0 }] }] })
    expect(connected.subscriptions![0]!.windows[2]!.remaining).toBeUndefined()
    expect(connected.user).toEqual({ username: 'SakuraAPI 已授权' })
    expect(JSON.stringify(connected)).not.toMatch(/sk-SYNTHETIC|UNRELATED_PRIVATE_FIELD|auth_token|refresh_token/)
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ apiKey: authorizedKey, model: 'gpt-test' }))
    expect(window.close).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call.init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' })
      expect(new Headers(call.init!.headers).get('authorization')).toBe(call.url.startsWith(SAKURA_MODEL_BASE_URL) ? 'Bearer ' + authorizedKey : null)
    }
  })

  it('routes only website models with fixed origin/protocol and never accepts a pinned external model', async () => {
    const { account, calls, connect } = fixture()
    await connect()
    await account.selectModel('responses-test')
    const chunks = []
    for await (const chunk of account.adapter().stream({ messages: [{ role: 'user', content: 'synthetic' }], thinking: 'high' })) chunks.push(chunk)
    expect(chunks.some(row => row.type === 'text')).toBe(true)
    const modelCall = calls.find(row => row.url.endsWith('/responses'))!
    expect(modelCall.url).toBe(SAKURA_MODEL_BASE_URL + '/responses')
    expect(JSON.parse(String(modelCall.init!.body))).toMatchObject({ model: 'responses-test', reasoning: { effort: 'high' } })
    expect(modelCall.init).toMatchObject({ redirect: 'error', credentials: 'omit' })
    await expect(account.adapter().stream({ messages: [], model: 'outside-model' })[Symbol.asyncIterator]().next()).rejects.toThrow('可用列表')
    await expect(account.selectModel('evil-model')).rejects.toMatchObject({ status: 400 })
  })

  it('denial, cancellation and stale polling cannot connect or create a Key', async () => {
    const { account, calls, persist, window } = fixture()
    const login = await account.beginLogin()
    window.readAuthorization.mockResolvedValueOnce({ event: 'denied' })
    expect((await account.pollLogin(login.login!.id)).phase).toBe('signed-out')
    expect(calls).toHaveLength(0); expect(persist).not.toHaveBeenCalled()
    await expect(account.pollLogin(login.login!.id)).rejects.toMatchObject({ status: 409 })
    const next = await account.beginLogin()
    await account.cancelLogin()
    await expect(account.pollLogin(next.login!.id)).rejects.toMatchObject({ status: 409 })
    expect(window.close).toHaveBeenCalledTimes(2)
  })

  it('requires explicit retry after persistence failure and never automatically resubmits consent', async () => {
    const { account, persist, window } = fixture()
    persist.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'))
    const login = await account.beginLogin(true)
    await expect(account.pollLogin(login.login!.id)).rejects.toMatchObject({ status: 502 })
    expect(account.status()).toMatchObject({ phase: 'login', login: { failed: true } })
    const reads = window.readAuthorization.mock.calls.length
    await account.pollLogin(login.login!.id)
    expect(window.readAuthorization).toHaveBeenCalledTimes(reads)
    expect((await account.pollLogin(login.login!.id, true)).phase).toBe('connected')
  })

  it('rejects consent that expires during secure storage and removes the late saved Key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture()
    const login = await f.account.beginLogin(true)
    f.persist.mockImplementationOnce(async () => { vi.setSystemTime(login.login!.expiresAt + 1) })
    await expect(f.account.pollLogin(login.login!.id)).rejects.toMatchObject({ status: 409 })
    expect(f.account.status()).toMatchObject({ phase: 'signed-out', models: [] })
    expect(f.account.status().login).toBeUndefined()
    expect(f.persist).toHaveBeenLastCalledWith(null)
    expect(f.window.close).toHaveBeenCalledOnce()
    await expect(f.account.adapter().stream({ messages: [] })[Symbol.asyncIterator]().next()).rejects.toThrow('请先授权')
  })

  it('validates saved Key data and never sends legacy account credentials to model APIs', async () => {
    for (const invalid of [null, [], { apiKey: 'bad token' }, { apiKey: 'x', model: 'bad name' }, { apiKey: 'x', accessToken: 'y' },
      { apiKey: 'x', keyName: 'bad\nname' }, { accessToken: 'x', expiresAt: NaN }]) expect(() => parseSakuraApiSaved(invalid)).toThrow()
    expect(parseSakuraApiSaved({ apiKey: authorizedKey, unexpected: 'private' })).toEqual({ apiKey: authorizedKey })
    const old = fixture({ saved: { accessToken: 'OLD_ACCOUNT_JWT', refreshToken: 'OLD_REFRESH', expiresAt: Date.now() + 10000 } })
    expect(old.account.status().phase).toBe('expired')
    await old.account.refresh()
    expect(old.calls).toHaveLength(0)
    await expect(old.account.adapter().stream({ messages: [] })[Symbol.asyncIterator]().next()).rejects.toThrow('请先授权')
    await old.account.logout()
    expect(old.persist).toHaveBeenCalledWith(null)
  })

  it('keeps encrypted deletion failures connected, and logout deletes only local authorization', async () => {
    const { account, persist, calls, connect } = fixture()
    await connect()
    persist.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'))
    await expect(account.logout()).rejects.toMatchObject({ status: 502 })
    expect(account.status().phase).toBe('connected')
    const state = await account.logout()
    expect(state).toMatchObject({ phase: 'signed-out', models: [], remember: false })
    expect(state.message).toContain('未撤销')
    expect(calls.every(call => call.init!.method === 'GET')).toBe(true)
  })

  it('single-flights refresh, retains old data on network failure and disables expired credentials', async () => {
    const { account, fetcher, connect } = fixture()
    await connect()
    const entered = barrier(), hold = barrier()
    fetcher.mockImplementationOnce(async (url, init) => { entered.release(); await hold.promise; return sakuraApiResponse(url, init) })
    const first = account.refresh()
    try { await entered.promise; expect(account.refresh()).toBe(first); await expect(account.logout()).rejects.toMatchObject({ status: 409 }) }
    finally { hold.release() }
    await first
    fetcher.mockRejectedValueOnce(new Error('private transport failure'))
    await expect(account.refresh()).rejects.toMatchObject({ status: 502 })
    expect(account.status()).toMatchObject({ phase: 'connected', balance: 5.09, models: modelIds })
    fetcher.mockResolvedValueOnce(new Response('', { status: 401 }))
    await expect(account.refresh()).rejects.toMatchObject({ status: 401 })
    expect(account.status()).toMatchObject({ phase: 'expired', models: [] })
    expect(account.status().balance).toBeUndefined()
  })

  it('keeps consent balance explicitly stale when the Key query omits a balance, and never invents amounts', async () => {
    const { account, fetcher, connect } = fixture()
    fetcher.mockImplementation(async (url, init) => String(url).endsWith('/usage') ? new Response(JSON.stringify({ subscription: usage.subscription })) : sakuraApiResponse(url, init))
    expect(await connect()).toMatchObject({ balance: 5.09, balanceSource: 'authorization' })
    await account.refresh()
    expect(account.status().balanceSource).toBe('authorization')
    const info = parseSakuraApiUsage({ subscription: { daily_limit_usd: 10, weekly_limit_usd: 0, monthly_limit_usd: 1, monthly_usage_usd: 2 },
      balance: Infinity, usage: { total: { requests: -1, actual_cost: NaN } } })
    expect(info.balance).toBeUndefined()
    expect(info.subscriptions![0]!.windows.map(row => row.remaining)).toEqual([undefined, undefined, 0])
    expect(info.usage!.requests).toBeUndefined()
  })

  it('rejects malformed, oversized and redirected responses without leaking upstream content', async () => {
    for (const response of [new Response('PRIVATE_NON_JSON'), new Response('x'.repeat(1024 * 1024 + 1)),
      new Response('', { status: 302, headers: { location: 'https://evil.test/' } }), envelope({ data: [] })]) {
      const f = fixture()
      f.fetcher.mockResolvedValueOnce(response)
      await expect(f.connect()).rejects.toBeInstanceOf(Error)
      expect(JSON.stringify(f.account.status())).not.toContain('PRIVATE_NON_JSON')
    }
  })

  it('filters known non-chat models and treats catalog capability failures as optional metadata', async () => {
    const f = fixture()
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'embedding-test' }, { id: 'audio-tts' }] }))
      if (String(url).endsWith('/models/available')) throw new Error('metadata unavailable')
      return sakuraApiResponse(url, init)
    })
    expect((await f.connect()).models).toEqual(['gpt-test'])
  })

  it('serializes consent/cancellation and tears down a late browser launch during shutdown', async () => {
    const entered = barrier(), hold = barrier()
    const f = fixture({ openLogin: async () => { entered.release(); await hold.promise; return { readAuthorization: async () => null, close: async () => {} } } })
    const launching = f.account.beginLogin()
    let closing!: Promise<void>
    try { await entered.promise; await expect(f.account.cancelLogin()).rejects.toMatchObject({ status: 409 }); closing = f.account.close() }
    finally { hold.release() }
    await expect(launching).rejects.toMatchObject({ status: 503 }); await closing
  })

  it('rolls back persistence when shutdown wins and does not republish late account data', async () => {
    const f = fixture(), entered = barrier(), hold = barrier()
    const login = await f.account.beginLogin(true)
    f.persist.mockImplementationOnce(async () => { entered.release(); await hold.promise })
    const connecting = f.account.pollLogin(login.login!.id)
    let closing!: Promise<void>
    try { await entered.promise; closing = f.account.close() }
    finally { hold.release() }
    await expect(connecting).rejects.toMatchObject({ status: 503 }); await closing
    expect(f.persist).toHaveBeenLastCalledWith(null)
    expect(f.account.status().user).toBeUndefined()
    expect(f.window.close).toHaveBeenCalledOnce()
  })
})

describe('SakuraAPI-only desktop HTTP policy', () => {
  async function server() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-exclusive-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const calls: string[] = [], pages: string[] = []
    const handle = await runWebServer({ cwd, open: false, quiet: true, sakuraApiOnly: true, baseURL: 'https://evil.test/v1', apiKey: 'OLD_KEY',
      config: { models: { evil: { baseURL: 'https://evil.test/v1', apiKey: 'OTHER_KEY', model: 'evil-model' } } },
      onPersistSettings: () => {}, onPersistSakuraApi: async () => {}, sakuraApiOpenLogin: async () => ({ readAuthorization: async () => authorized, close: async () => {} }),
      sakuraApiFetch: (async (url, init) => { calls.push(String(url)); return sakuraApiResponse(url, init) }) as typeof fetch,
      sakuraApiOpenPage: async page => { pages.push(page) }, updatesAutoCheck: false })
    cleanups.push(() => handle.close())
    const post = (route: string, body: unknown) => fetch(handle.url + 'api/' + route, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    return { handle, cwd, post, calls, pages }
  }

  it('enforces fixed origin in the backend, including YAML/environment providers and manual request bypasses', async () => {
    const f = await server()
    const initial = await (await fetch(f.handle.url + 'api/state')).json() as { sakuraApiOnly: boolean; providers: Array<{ id: string }>; modelStatus: { baseURL: string; configured: boolean } }
    expect(initial.sakuraApiOnly).toBe(true)
    expect(initial.providers.map((row: any) => row.id)).toEqual(['sakuraapi'])
    expect(initial.modelStatus).toMatchObject({ baseURL: SAKURA_MODEL_BASE_URL, configured: false })
    for (const body of [{ baseURL: 'https://evil.test/v1' }, { apiKey: 'MANUAL_KEY' }, { model: 'gpt-test' }, { provider: 'evil' }, { format: 'responses' }, { rememberKey: true }]) {
      expect((await f.post('desktop/settings', body)).status).toBe(400)
    }
    expect((await f.post('models/upstream', { baseURL: 'https://evil.test', apiKey: 'X' })).status).toBe(400)
    expect((await f.post('settings', { apiKey: 'X' })).status).toBe(400)
    expect(f.calls).toHaveLength(0)
    const login = await (await f.post('account/sakura/login', { remember: true })).json() as SakuraApiStatus
    const connected = await (await f.post('account/sakura/poll', { id: login.login!.id })).json() as SakuraApiStatus
    expect(connected.phase).toBe('connected')
    expect((await f.post('settings', { model: 'evil-model' })).status).toBe(400)
    expect((await f.post('settings', { model: 'responses-test' })).status).toBe(200)
    const output = await f.handle.harness.run('synthetic acceptance')
    expect(output.error).toBeUndefined(); expect(output.output).toContain('SYNTHETIC_MODEL_REPLY')
    expect(f.calls).toContain(SAKURA_MODEL_BASE_URL + '/responses')
    for (const route of ['state', 'collaboration', 'account/sakura']) expect(await (await fetch(f.handle.url + 'api/' + route)).text()).not.toMatch(/sk-SYNTHETIC|OLD_KEY|OTHER_KEY/)
    expect((await f.post('account/sakura/page', { page: 'purchase' })).status).toBe(200)
    expect((await f.post('account/sakura/page', { page: 'https://evil.test' })).status).toBe(400)
    expect(f.pages).toEqual(['purchase'])
    expect((await f.post('account/sakura/logout', {})).status).toBe(200)
    const signedOut = await (await fetch(f.handle.url + 'api/state')).json() as { modelStatus: { configured: boolean } }
    expect(signedOut.modelStatus.configured).toBe(false)
  })

  it('keeps all authorization routes unavailable to remote operators and does not publish secrets in SSE', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-remote-authorization-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const remote = await runWebServer({ cwd, host: '0.0.0.0', token: 'operator-token-012345678901234567890123', open: false, quiet: true })
    cleanups.push(() => remote.close())
    for (const action of ['login', 'poll', 'retry', 'cancel', 'refresh', 'logout', 'remember', 'page', 'keys', 'key-select', 'key-prepare', 'key-create', 'key-cancel', 'activity']) {
      expect((await fetch(remote.url + 'api/account/sakura/' + action, { method: 'POST', body: '{}', headers: { authorization: 'Bearer operator-token-012345678901234567890123' } })).status).toBe(404)
    }
    const f = await server(), events = await fetch(f.handle.url + 'api/events', { signal: AbortSignal.timeout(3000) })
    const reader = events.body!.getReader()
    try { expect(new TextDecoder().decode((await reader.read()).value)).not.toMatch(/sk-SYNTHETIC|OLD_KEY|OTHER_KEY/) }
    finally { await reader.cancel() }
  })
})