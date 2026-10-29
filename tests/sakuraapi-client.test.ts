import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { SakuraApiAccount, parseSakuraApiSaved, SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL, type SakuraApiSaved } from '../src/integrations/sakuraapi.js'
import { parseSakuraClientSession, parseSakuraClientTokens, SakuraApiClient } from '../src/integrations/sakuraapi-client.js'
import { parseSakuraAccountSubscriptions, parseSakuraGroups, parseSakuraKeyChoice, parseSakuraVip } from '../src/integrations/sakuraapi-profile.js'
import { runWebServer } from '../src/web/server.js'
import { clientAuthorization, clientDraft, clientKey, clientSaved, clientTokens, clientUser, clientVip, envelope,
  authorizedKey, clientAccessToken, clientRefreshToken, modelIds, noClientSecrets, rotatedAccessToken, sakuraClientResponse } from './sakuraapi-client-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); vi.restoreAllMocks(); vi.useRealTimers() })

function fixture(saved?: SakuraApiSaved) {
  const draft = clientDraft(), calls: Array<{ url: string; init?: RequestInit }> = []
  const window = { draft, readAuthorization: vi.fn(async (): Promise<unknown> => clientAuthorization(draft.state)), close: vi.fn(async () => {}) }
  const fetcher = vi.fn(sakuraClientResponse)
  const transport: typeof fetch = async (url, init) => { calls.push({ url: String(url), init }); return fetcher(url, init) }
  const persist = vi.fn(async (_saved: SakuraApiSaved | null) => {})
  const account = new SakuraApiAccount({ saved, fetch: transport, openLogin: async () => window, persist })
  cleanups.push(() => account.close())
  const connect = async () => { const login = await account.beginLogin(true); return account.pollLogin(login.login!.id) }
  return { account, calls, fetcher, persist, window, connect }
}

describe('official client-account credentials', () => {
  it('remembers by default with secure storage and restores a selected model without reopening consent', async () => {
    const f = fixture()
    const login = await f.account.beginLogin()
    expect((await f.account.pollLogin(login.login!.id)).remember).toBe(true)
    await f.account.selectKey(101); await f.account.selectModel('responses-test')
    const saved = f.persist.mock.calls.at(-1)![0]!
    await f.account.close()
    const open = vi.fn(async () => f.window), persist = vi.fn(async (_value: SakuraApiSaved | null) => {})
    const resumed = new SakuraApiAccount({ saved, persist, openLogin: open, fetch: sakuraClientResponse })
    cleanups.push(() => resumed.close())
    expect((await resumed.refresh())).toMatchObject({ phase: 'connected', remember: true, model: 'responses-test', keyId: 101 })
    expect(open).not.toHaveBeenCalled()
    expect(noClientSecrets(resumed.status())).toBe(true)
  })

  it('changes retention of the current grant only after storage acknowledgement and rolls back save/remove errors', async () => {
    const f = fixture()
    const login = await f.account.beginLogin(false); await f.account.pollLogin(login.login!.id)
    await f.account.selectKey(101)
    const networkCalls = f.calls.length
    f.persist.mockRejectedValueOnce(new Error('synthetic full disk'))
    await expect(f.account.setRemember(true)).rejects.toMatchObject({ status: 502 })
    expect(f.account.status().remember).toBe(false)
    expect((await f.account.setRemember(true)).remember).toBe(true)
    expect(f.persist).toHaveBeenLastCalledWith(expect.objectContaining({ client: expect.any(Object), keyId: 101 }))
    f.persist.mockRejectedValueOnce(new Error('synthetic removal error'))
    await expect(f.account.setRemember(false)).rejects.toMatchObject({ status: 502 })
    expect(f.account.status().remember).toBe(true)
    expect((await f.account.setRemember(false))).toMatchObject({ phase: 'connected', remember: false, keyId: 101 })
    expect(f.persist).toHaveBeenLastCalledWith(null)
    expect(f.calls).toHaveLength(networkCalls)
  })

  it('defaults to memory-only without a secure persistence provider', async () => {
    const draft = clientDraft(), account = new SakuraApiAccount({ fetch: sakuraClientResponse,
      openLogin: async () => ({ draft, readAuthorization: async () => clientAuthorization(draft.state), close: async () => {} }) })
    cleanups.push(() => account.close())
    const login = await account.beginLogin()
    expect((await account.pollLogin(login.login!.id)).remember).toBe(false)
    await expect(account.setRemember(true)).rejects.toMatchObject({ status: 409 })
  })

  it('excludes subscription and unknown billing groups by server metadata, not their names, without rounding billing rates', () => {
    const groups = parseSakuraGroups([
      { id: 1, name: '普通模型', status: 'active', platform: 'openai', subscription_type: 'standard', rate_multiplier: 0.855 },
      { id: 2, name: '普通名称的订阅组', status: 'active', subscription_type: 'subscription' },
      { id: 3, name: '订阅迁移模型', status: 'active', subscription_type: 'standard', rate_multiplier: 0.7200000000000001 },
      { id: 4, name: '兼容旧接口', status: 'active', rate_multiplier: 1 },
      { id: 5, name: '未知计费方式', status: 'active', subscription_type: 'future-type' },
      { id: 6, name: '停用组', status: 'inactive', subscription_type: 'standard' },
      { id: 1, name: '重复组', status: 'active' },
    ])
    expect(groups.map(group => group.id)).toEqual([1, 3, 4])
    expect(groups.map(group => group.rateMultiplier)).toEqual([0.855, 0.7200000000000001, 1])
    expect(JSON.stringify(groups)).not.toContain('subscription_type')
  })

  it('keeps account subscription quota but refuses a subscription group in new-Key preparation', async () => {
    const f = fixture()
    f.fetcher.mockImplementation(async (url, init) => String(url).endsWith('/groups/available') ? envelope([
      { id: 7, name: '普通模型', platform: 'openai', status: 'active', subscription_type: 'standard', rate_multiplier: 1 },
      { id: 10, name: '普通名称订阅组', platform: 'openai', status: 'active', subscription_type: 'subscription', rate_multiplier: 0.9 },
    ]) : sakuraClientResponse(url, init))
    const status = await f.connect()
    expect(status.groups?.map(group => group.id)).toEqual([7])
    expect(status.subscriptions?.length).toBeGreaterThan(0)
    expect(() => f.account.prepareKey('明确创建', [10])).toThrow()
    expect(f.calls.some(call => call.url.endsWith('/api/v1/keys') && call.init?.method === 'POST')).toBe(false)
  })

  it('validates fixed client identity, scope, lifetime and user while rejecting website JWTs and secret extras', () => {
    const saved = clientSaved(true)
    expect(parseSakuraApiSaved({ ...saved, private: 'DROP_ME' })).toEqual(saved)
    expect(parseSakuraClientTokens(clientTokens()).user).toEqual(clientUser)
    for (const patch of [{ scope: 'admin' }, { client_id: 'other' }, { expires_in: 3601 }, { expires_in: 0 },
      { refresh_token: 'WEBSITE_REFRESH' }, { token_type: 'Unknown' }, { user: { ...clientUser, id: 0 } }, { idle_timeout_seconds: 1 }]) {
      expect(() => parseSakuraClientTokens({ ...clientTokens(), ...patch })).toThrow()
    }
    for (const patch of [{ accessToken: 'bad token' }, { refreshToken: 'bad' }, { accessExpiresAt: -1 }, { idleExpiresAt: 'invalid' }]) {
      expect(() => parseSakuraClientSession({ ...clientSaved().client, ...patch })).toThrow()
    }
    expect(() => parseSakuraApiSaved({ ...clientSaved(), apiKey: authorizedKey })).toThrow()
    expect(() => parseSakuraApiSaved({ ...clientSaved(), accessToken: 'WEBSITE_JWT' })).toThrow()
  })

  it('serializes token rotation, persists once and never sends client tokens to model/foreign routes', async () => {
    const saved = clientSaved().client; saved.accessExpiresAt = 0
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const persist = vi.fn(async (_session: ReturnType<typeof parseSakuraClientSession>) => {})
    const client = new SakuraApiClient(saved, { signal: new AbortController().signal, persist,
      fetch: (async (url, init) => { calls.push({ url: String(url), init }); return sakuraClientResponse(url, init) }) as typeof fetch })
    await Promise.all([client.request('/user/profile'), client.request('/groups/available'), client.request('/auth/client/activity', {method:'POST'})])
    expect(calls.filter(row => row.url.endsWith('/auth/client/token'))).toHaveLength(1)
    expect(persist).toHaveBeenCalledOnce()
    expect(persist.mock.calls[0]![0]).toMatchObject({ accessToken: rotatedAccessToken })
    for (const row of calls) {
      expect(row.init).toMatchObject({ redirect: 'error', credentials: 'omit' })
      expect(new Headers(row.init!.headers).get('user-agent')).toBe('SakuraCode Desktop')
    }
    const count = calls.length
    for (const route of ['https://evil.test/user/profile', '//evil.test/x', '/v1/models', '/user/password', '/keys/1?redirect=evil', '/user/vip', '/auth/client/token']) {
      await expect(client.request(route)).rejects.toMatchObject({ status: 400 })
    }
    expect(calls).toHaveLength(count)
    client.close()
  })

  it('pauses after rotated-token disk failure, and an explicit save retry does not consume refresh twice', async () => {
    const session = clientSaved().client; session.accessExpiresAt = 0
    let exchanges = 0
    const persist = vi.fn(async () => {})
    persist.mockRejectedValueOnce(new Error('PRIVATE_STORAGE_ERROR'))
    const client = new SakuraApiClient(session, { signal: new AbortController().signal, persist,
      fetch: (async (url, init) => { if (String(url).endsWith('/auth/client/token')) exchanges++; return sakuraClientResponse(url, init) }) as typeof fetch })
    await expect(client.request('/user/profile')).rejects.toMatchObject({status:502})
    await expect(client.request('/groups/available')).rejects.toMatchObject({status:502})
    expect(persist).toHaveBeenCalledOnce(); expect(exchanges).toBe(1)
    await client.retryPendingSave()
    await client.request('/user/profile')
    expect(persist).toHaveBeenCalledTimes(2); expect(exchanges).toBe(1)
    client.close()
  })

  it('refuses an uncertain rotation rather than reusing a consumed token, even with an old idle snapshot', async () => {
    const session = clientSaved().client; session.accessExpiresAt = 0; session.idleExpiresAt = '2000-01-01T00:00:00Z'
    const fetcher = vi.fn(async () => { throw new Error(clientRefreshToken) })
    const client = new SakuraApiClient(session, { signal: new AbortController().signal, persist: async () => {}, fetch: fetcher as typeof fetch })
    await expect(client.request('/user/profile')).rejects.toMatchObject({status:401})
    await expect(client.request('/user/profile')).rejects.toMatchObject({status:401})
    expect(client.expired).toBe(true); expect(fetcher).toHaveBeenCalledOnce()
    client.close()
  })

  it('rejects a forbidden endpoint before touching an expired credential', async () => {
    const session = clientSaved().client; session.accessExpiresAt = 0
    const fetcher = vi.fn(sakuraClientResponse)
    const client = new SakuraApiClient(session, { signal:new AbortController().signal, persist:async()=>{}, fetch:fetcher as typeof fetch })
    await expect(client.request('/user/vip')).rejects.toMatchObject({status:400})
    expect(fetcher).not.toHaveBeenCalled(); expect(client.expired).toBe(false)
    client.close()
  })
})

describe('SakuraAPI client-account workflow', () => {
  it('connects true identity/VIP/whole-account quotas without automatically selecting or creating a Key', async () => {
    const f = fixture(), status = await f.connect()
    expect(status).toMatchObject({ phase:'connected', authorization:'client-account-pkce', user:clientUser,
      balance:5.09, balanceSource:'account', usageSource:'account', models:[], vip:{level:7, enabled:true},
      keys:{items:[{id:101, usable:true}]}, groups:[{id:7, rateMultiplier:0.95},{id:8}] })
    expect(status.subscriptions?.[0]?.windows.map(window => window.remaining)).toEqual([8,35,undefined])
    expect(status.keyId).toBeUndefined(); expect(status.model).toBeUndefined()
    expect(noClientSecrets(status)).toBe(true)
    expect(f.calls.filter(row => row.url === SAKURA_API_ORIGIN + '/api/v1/keys' && row.init?.method === 'POST')).toHaveLength(0)
    expect(f.calls.some(row => row.url.startsWith(SAKURA_MODEL_BASE_URL))).toBe(false)
    expect(f.persist).toHaveBeenCalledWith(expect.objectContaining({client:expect.objectContaining({accessToken:clientAccessToken})}))
    await expect(f.account.adapter().stream({messages:[]})[Symbol.asyncIterator]().next()).rejects.toThrow('请先授权')
  })

  it('selects an owned, current Key, keeps client tokens separate and exposes no full Key or private payloads', async () => {
    const f = fixture(); await f.connect(); const selected = await f.account.selectKey(101)
    expect(selected).toMatchObject({keyId:101, models:modelIds, model:'gpt-test'})
    expect(noClientSecrets(selected)).toBe(true)
    const chunks = []
    for await (const chunk of f.account.adapter().stream({messages:[{role:'user',content:'synthetic'}]})) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'text')).toBe(true)
    for (const call of f.calls.filter(row => row.url.startsWith(SAKURA_MODEL_BASE_URL))) expect(new Headers(call.init?.headers).get('authorization')).toBe('Bearer '+authorizedKey)
    expect(new Headers(f.calls.find(row=>row.url.endsWith('/keys/101'))!.init?.headers).get('authorization')).toBe('Bearer '+clientAccessToken)
    const last = f.persist.mock.calls.at(-1)![0]
    expect(last).toMatchObject({keyId:101, apiKey:authorizedKey})
    await f.account.selectModel('responses-test')
    expect(f.persist.mock.calls.at(-1)![0]).toMatchObject({client:expect.any(Object), keyId:101, model:'responses-test'})
  })

  it.each([{user_id:74}, {status:'disabled'}, {expires_at:'2000-01-01T00:00:00Z'}, {quota:1,quota_used:1}, {quota:'1'}, {quota_used:null}])('rejects an unusable or unowned Key without changing the selected model (%j)', async patch => {
    const f = fixture(); await f.connect(); await f.account.selectKey(101)
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith('/keys/102') ? envelope({...clientKey,id:102,...patch}) : sakuraClientResponse(url,init))
    await expect(f.account.selectKey(102)).rejects.toMatchObject({status:expect.any(Number)})
    expect(f.account.status()).toMatchObject({keyId:101,models:modelIds})
  })

  it('requires a prepared, explicit Key creation and reuses the same UUID/body after a lost response', async () => {
    const f = fixture(); await f.connect()
    expect(()=>f.account.prepareKey('invalid',[99])).toThrow()
    const operation=f.account.prepareKey('合成 Key',[8,7])
    expect(f.calls.some(row=>row.init?.method==='POST' && row.url.endsWith('/keys'))).toBe(false)
    expect(()=>f.account.prepareKey('duplicate',[7])).toThrow()
    let first=true
    f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith('/api/v1/keys')&&init?.method==='POST'&&first){first=false;throw new Error('lost')}return sakuraClientResponse(url,init)})
    await expect(f.account.createKey(operation.id)).rejects.toMatchObject({status:502})
    const status=await f.account.createKey(operation.id)
    expect(status.keyId).toBe(102); expect(status.keyCreation).toBeUndefined()
    const creates=f.calls.filter(row=>row.url.endsWith('/api/v1/keys')&&row.init?.method==='POST')
    expect(creates).toHaveLength(2)
    expect(creates[0]!.init!.body).toBe(creates[1]!.init!.body)
    expect(new Headers(creates[0]!.init!.headers).get('Idempotency-Key')).toBe(operation.id)
    expect(new Headers(creates[1]!.init!.headers).get('Idempotency-Key')).toBe(operation.id)
    expect(JSON.parse(String(creates[0]!.init!.body)).group_bindings).toEqual([{group_id:8,priority:0},{group_id:7,priority:1}])
    await expect(f.account.createKey(operation.id)).rejects.toMatchObject({status:409})
    expect(noClientSecrets(status)).toBe(true)
  })

  it('keeps a consumed code result for explicit disk-save retry, never exchanges twice', async () => {
    const f=fixture();f.persist.mockRejectedValueOnce(new Error('disk failure'))
    const login=await f.account.beginLogin(true)
    await expect(f.account.pollLogin(login.login!.id)).rejects.toMatchObject({status:502})
    await f.account.pollLogin(login.login!.id)
    expect((await f.account.pollLogin(login.login!.id,true)).phase).toBe('connected')
    expect(f.calls.filter(row=>row.url.endsWith('/auth/client/token'))).toHaveLength(1)
  })

  it('never resubmits an uncertain one-time code exchange', async () => {
    const f=fixture();f.fetcher.mockImplementation(async(url,init)=>{if(String(url).endsWith('/auth/client/token'))throw new Error('uncertain');return sakuraClientResponse(url,init)})
    const login=await f.account.beginLogin()
    await expect(f.account.pollLogin(login.login!.id)).rejects.toMatchObject({status:502})
    await expect(f.account.pollLogin(login.login!.id,true)).rejects.toMatchObject({status:409})
    expect(f.calls.filter(row=>row.url.endsWith('/auth/client/token'))).toHaveLength(1)
  })

  it('does not manufacture VIP or derive effective membership from recharge, and clears badges on unavailable VIP', async () => {
    const f=fixture();await f.connect()
    f.fetcher.mockImplementation(async(url,init)=>String(url).includes('/snapshot-v2')?envelope({vip:{...clientVip,level:'10'}}):sakuraClientResponse(url,init))
    expect((await f.account.refresh()).vip).toBeUndefined()
    expect(f.account.status().warning).toContain('VIP')
    expect(parseSakuraVip({...clientVip,level:11,effective_level:11})?.level).toBe(11)
    expect(parseSakuraVip({...clientVip,level:10,effective_level:9})).toBeUndefined()
    expect(parseSakuraKeyChoice(clientKey,clientUser.id).groupIds).toEqual([7])
  })

  it('uses server subscription window progress, joins only owned records and never adds periods or reports unlimited as zero', () => {
    const subscription = {id:301,user_id:clientUser.id,status:'active',expires_at:'2099-01-01T00:00:00Z',
      group:{name:'Synthetic progress',daily_limit_usd:10},daily_usage_usd:9}
    const progress = {subscription,progress:{id:301,daily:{limit_usd:10,used_usd:2,remaining_usd:8,resets_at:'2099-01-02T00:00:00Z'},
      monthly:{limit_usd:0,used_usd:20,remaining_usd:0}}}
    const data = parseSakuraAccountSubscriptions([subscription,{...subscription,id:302,user_id:74}],clientUser.id,[progress])
    expect(data).toHaveLength(1)
    expect(data[0]!.windows).toEqual([{period:'daily',limit:10,used:2,remaining:8,resetAt:'2099-01-02T00:00:00.000Z'},
      {period:'monthly',limit:0,used:20}])
  })

  it.each([
    { title: 'zero remaining', window: { limit_usd: 10, used_usd: 12, remaining_usd: 0 }, expected: { limit: 10, used: 12, remaining: 0 } },
    { title: 'server remaining above limit', window: { limit_usd: 10, used_usd: 0, remaining_usd: 25 }, expected: { limit: 10, used: 0, remaining: 25 } },
    { title: 'missing remaining', window: { limit_usd: 10, used_usd: 2 }, expected: { limit: 10, used: 2 } },
    { title: 'missing limit', window: { used_usd: 2, remaining_usd: 8 }, expected: { used: 2 } },
    { title: 'unlimited quota', window: { limit_usd: 0, used_usd: 2, remaining_usd: 0 }, expected: { limit: 0, used: 2 } },
    { title: 'invalid values', window: { limit_usd: '10', used_usd: -1, remaining_usd: Infinity, resets_at: 'invalid' }, expected: {} },
  ])('preserves $title without filling missing or invalid quota fields', ({ window, expected }) => {
    const subscription = { id: 301, user_id: clientUser.id, status: 'active', group: { name: 'Synthetic quota', daily_limit_usd: 99 }, daily_usage_usd: 90 }
    const data = parseSakuraAccountSubscriptions([subscription], clientUser.id, [{ subscription, progress: { id: 301, daily: window } }])
    expect(data[0]!.windows).toEqual([{ period: 'daily', ...expected }])
    expect(data[0]!.windows.some(window => window.period === 'weekly' || window.period === 'monthly')).toBe(false)
  })

  it('retains old data after a failed query, but rejects revoked account tokens and pauses model inference', async () => {
    const f=fixture(clientSaved(true));await f.account.refresh()
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith('/user/profile')?new Response('',{status:503}):sakuraClientResponse(url,init))
    await expect(f.account.refresh()).rejects.toMatchObject({status:502})
    expect(f.account.status()).toMatchObject({phase:'connected',balance:5.09,vip:{level:7}})
    f.fetcher.mockImplementation(async(url,init)=>String(url).endsWith('/user/profile')||String(url).endsWith('/auth/client/token')?new Response(JSON.stringify({code:401}),{status:401}):sakuraClientResponse(url,init))
    await expect(f.account.refresh()).rejects.toMatchObject({status:401})
    expect(f.account.status()).toMatchObject({phase:'expired',models:[]})
    expect(f.account.status().vip).toBeUndefined()
    await expect(f.account.adapter().stream({messages:[]})[Symbol.asyncIterator]().next()).rejects.toThrow('请先授权')
  })

  it('reports activity only when explicitly called, and logout revokes just this client session', async () => {
    const f=fixture();await f.connect();await f.account.foregroundActivity()
    expect(f.calls.filter(row=>row.url.endsWith('/activity'))).toHaveLength(1)
    f.persist.mockRejectedValueOnce(new Error('deletion failed'))
    await expect(f.account.logout()).rejects.toMatchObject({status:502})
    expect(f.account.status().phase).toBe('expired')
    const status=await f.account.logout()
    expect(status).toMatchObject({phase:'signed-out',models:[]});expect(status.vip).toBeUndefined()
    expect(f.persist).toHaveBeenLastCalledWith(null)
    expect(f.calls.some(row=>row.url.includes('/auth/logout')||row.init?.method==='DELETE')).toBe(false)
    const revoke=f.calls.find(row=>row.url.endsWith('/auth/client/revoke'))!
    expect(JSON.parse(String(revoke.init?.body))).toEqual({client_id:'sakuracode',refresh_token:clientRefreshToken})
  })
})

describe('client-account HTTP projection and embedded badge resources', () => {
  it('requires a boolean and an idle local operator before changing encrypted retention', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-remember-http-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const persist = vi.fn(async (_saved: SakuraApiSaved | null) => {})
    let release!: () => void, streaming = false
    const hold = new Promise<void>(resolve => { release = resolve })
    const handle = await runWebServer({ cwd, open: false, quiet: true, token: null, viewerToken: null,
      sakuraApi: clientSaved(true), onPersistSakuraApi: persist, sakuraApiFetch: sakuraClientResponse, updatesAutoCheck: false,
      adapter: { id: 'held-remember', defaultModel: 'fixture-model', async *stream() {
        streaming = true; await hold; yield { type: 'text', delta: 'complete' }; yield { type: 'done', reason: 'stop' }
      } } })
    cleanups.push(async () => { release(); await handle.close() })
    const post = (action: string, body: unknown) => fetch(handle.url + 'api/account/sakura/' + action, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post('refresh', {})).status).toBe(200)
    for (const body of [{}, { remember: 'yes' }, { remember: null }]) expect((await post('remember', body)).status).toBe(400)
    const turn = handle.harness.main().turn('active task')
    await vi.waitFor(() => expect(streaming).toBe(true))
    expect((await post('remember', { remember: false })).status).toBe(409)
    expect(persist).not.toHaveBeenCalled()
    release(); await turn
    expect((await post('remember', { remember: false })).status).toBe(200)
    expect(persist).toHaveBeenLastCalledWith(null)
    const status = await (await fetch(handle.url + 'api/account/sakura')).json()
    expect(status).toMatchObject({ phase: 'connected', remember: false, keyId: 101 })
    expect(noClientSecrets(status)).toBe(true)
  })

  it('exposes local-only projections, confirms Key creation, and serves all original PNG assets', async () => {
    const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'sakura-client-http-'))
    cleanups.push(()=>fs.rm(cwd,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
    const handle=await runWebServer({cwd,open:false,quiet:true,sakuraApiOnly:true,sakuraApi:clientSaved(),
      sakuraApiFetch:sakuraClientResponse as typeof fetch,onPersistSakuraApi:async()=>{}})
    cleanups.push(()=>handle.close())
    const post=(route:string,body:unknown)=>fetch(handle.url+'api/account/sakura/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    expect((await post('refresh',{})).status).toBe(200)
    const status=await(await fetch(handle.url+'api/account/sakura')).json()
    expect(noClientSecrets(status)).toBe(true)
    const operation=await(await post('key-prepare',{name:'HTTP synthetic',groupIds:[7]})).json() as {id:string}
    expect((await post('key-create',{id:operation.id})).status).toBe(400)
    expect((await post('key-cancel',{id:operation.id})).status).toBe(200)
    expect((await post('key-select',{id:101})).status).toBe(200)
    const events=await fetch(handle.url+'api/events',{signal:AbortSignal.timeout(4000)}),reader=events.body!.getReader()
    try {expect(noClientSecrets(new TextDecoder().decode((await reader.read()).value))).toBe(true)}finally{await reader.cancel()}
    for(let level=1;level<=10;level++) {
      const response=await fetch(handle.url+'assets/vip/vip-'+level+'.png')
      expect(response.headers.get('content-type')).toBe('image/png')
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await fs.readFile(new URL('../src/web/assets/vip/vip-'+level+'.png',import.meta.url)))
    }
    expect((await fetch(handle.url+'assets/vip/vip-11.png')).status).toBe(404)
    expect((await fetch(handle.url+'api/account/sakura?not-a-secret')).status).toBe(200)
  })
})