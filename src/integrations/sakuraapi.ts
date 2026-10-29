/** Official client-account grant, with read compatibility for older Key consent. */
import { randomUUID } from 'node:crypto'
import { openSakuraApiAuthorization, SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL, type SiteAuthorizationWindow } from './sakuraapi-authorization.js'
import { SakuraApiModelAdapter, type SakuraApiModel } from './sakuraapi-models.js'
import { parseSakuraApiUsage, record, validToken, type SakuraApiUsageInfo } from './sakuraapi-usage.js'
import { accountText, exchangeSakuraClientCode, parseSakuraClientSession, positiveId, SakuraApiClient, SakuraApiError,
  type SakuraApiClientSession, type SakuraApiClientUser } from './sakuraapi-client.js'
import { parseSakuraAccountSubscriptions, parseSakuraAccountUsage, parseSakuraGroups, parseSakuraKeyPage, parseSakuraProfile, parseSakuraVip,
  selectedSakuraKey, type SakuraApiGroupChoice, type SakuraApiKeyPage, type SakuraApiVip } from './sakuraapi-profile.js'

export { SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL }
export { SakuraApiError }
export type { SakuraApiQuotaWindow, SakuraApiSubscription } from './sakuraapi-usage.js'

export interface SakuraApiClientSaved {
  client: SakuraApiClientSession
  apiKey?: string
  keyId?: number
  keyName?: string
  model?: string
}

export type SakuraApiSaved = SakuraApiClientSaved | {
  apiKey: string
  keyName?: string
  model?: string
} | {
  /** Read compatibility only. Legacy account JWTs are never used as API Keys. */
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

export interface SakuraApiStatus extends SakuraApiUsageInfo {
  available: true
  authorization: 'client-account-pkce' | 'official-key-consent'
  phase: 'signed-out' | 'saved' | 'login' | 'connected' | 'expired'
  remember: boolean
  user?: { username: string; id?: number; email?: string }
  vip?: SakuraApiVip
  keyId?: number
  keys?: SakuraApiKeyPage
  groups?: SakuraApiGroupChoice[]
  accountUpdatedAt?: string
  clientSession?: { idleTimeoutSeconds: number; idleExpiresAt: string }
  keyCreation?: { id: string; name: string; groupNames: string[] }
  keyName?: string
  models: string[]
  model?: string
  login?: { id: string; expiresAt: number; failed: boolean }
  message: string
}

export interface SakuraApiOptions {
  saved?: SakuraApiSaved
  persist?: (saved: SakuraApiSaved | null) => Promise<void>
  fetch?: typeof globalThis.fetch
  openLogin?: () => Promise<SiteAuthorizationWindow>
}

export function parseSakuraApiSaved(value: unknown): SakuraApiSaved {
  const row = record(value)
  if (!row) throw new Error('invalid SakuraAPI saved account')
  if (row.client !== undefined) {
    if (row.accessToken !== undefined || row.refreshToken !== undefined || row.apiKey !== undefined && !validToken(row.apiKey) ||
      row.keyId !== undefined && !positiveId(row.keyId) || (row.apiKey !== undefined) !== (row.keyId !== undefined) ||
      row.keyName !== undefined && (typeof row.keyName !== 'string' || row.keyName.length > 160 || /[\x00-\x1f\x7f]/.test(row.keyName)) ||
      row.model !== undefined && !validToken(row.model, 200)) throw new Error('invalid SakuraAPI client account')
    return { client: parseSakuraClientSession(row.client), ...(row.apiKey ? { apiKey: row.apiKey, keyId: row.keyId } : {}),
      ...(row.keyName ? { keyName: row.keyName } : {}), ...(row.model ? { model: row.model } : {}) }
  }
  if (row.apiKey !== undefined) {
    if (!validToken(row.apiKey) || row.accessToken !== undefined || row.refreshToken !== undefined ||
      row.keyName !== undefined && (typeof row.keyName !== 'string' || row.keyName.length > 160 || /[\x00-\x1f\x7f]/.test(row.keyName)) ||
      row.model !== undefined && !validToken(row.model, 200)) throw new Error('invalid SakuraAPI authorized Key')
    return { apiKey: row.apiKey, ...(row.keyName ? { keyName: row.keyName } : {}), ...(row.model ? { model: row.model } : {}) }
  }
  if (!validToken(row.accessToken, 16384) || row.refreshToken !== undefined && !validToken(row.refreshToken, 16384) ||
    typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt < 0) throw new Error('invalid SakuraAPI saved credentials')
  return { accessToken: row.accessToken, ...(row.refreshToken ? { refreshToken: row.refreshToken } : {}), expiresAt: row.expiresAt }
}

export class SakuraApiAccount {
  private credentials?: SakuraApiSaved
  private phase: SakuraApiStatus['phase'] = 'signed-out'
  private remember = false
  private message = '连接 SakuraAPI 账号后同步资料、VIP 和额度，再选择已有 Key 或确认创建新 Key。'
  private catalog: SakuraApiModel[] = []
  private selected?: string
  private info: SakuraApiUsageInfo = {}
  private client?: SakuraApiClient
  private profile?: SakuraApiClientUser
  private vip?: SakuraApiVip
  private keys?: SakuraApiKeyPage
  private groups?: SakuraApiGroupChoice[]
  private accountUpdatedAt?: string
  private keyOperation?: { id: string; body: string; name: string; groupNames: string[]; result?: unknown }
  private login?: { id: string; expiresAt: number; window: SiteAuthorizationWindow; remember: boolean; failed: boolean; timer: NodeJS.Timeout;
    exchangeStarted?: boolean; candidate?: SakuraApiClientSaved }
  private closed = false
  private changing = false
  private changeFinished?: Promise<void>
  private refreshing?: Promise<SakuraApiStatus>
  private activity?: Promise<void>
  private closing?: Promise<void>
  private readonly controller = new AbortController()

  constructor(private readonly options: SakuraApiOptions = {}) {
    if (options.saved) {
      this.credentials = parseSakuraApiSaved(options.saved)
      this.remember = true
      if ('client' in this.credentials) { this.phase = 'saved'; this.selected = this.credentials.model; this.bindClient(); this.message = '已加密保存客户端账号，等待验证与同步。' }
      else if ('apiKey' in this.credentials) { this.phase = 'saved'; this.selected = this.credentials.model; this.message = '已加密保存授权 Key，等待验证与同步。' }
      else { this.phase = 'expired'; this.message = '旧版账号登录不是 Key 授权。请退出旧登录后重新授权；不会把账号令牌发给模型接口。' }
    }
  }

  status(): SakuraApiStatus {
    if (this.client?.expired) { this.phase = 'expired'; this.catalog = []; this.selected = undefined; this.info = {}; this.vip = undefined; this.message = '客户端授权已失效或令牌轮换未确认，请退出后重新授权。' }
    const saved = this.credentials && 'client' in this.credentials ? this.credentials : undefined
    const user = this.profile ?? saved?.client.user
    const legacy = this.credentials ? !saved : this.login && !this.login.window.draft
    return { available: true, authorization: legacy ? 'official-key-consent' : 'client-account-pkce', phase: this.phase, remember: this.remember,
      ...(this.phase === 'connected' ? { user: saved ? { ...user!, username: user?.username || user?.email || '用户 ' + user?.id } : { username: 'SakuraAPI 已授权' } } : {}),
      ...(saved ? { clientSession: { idleTimeoutSeconds: saved.client.idleTimeoutSeconds, idleExpiresAt: saved.client.idleExpiresAt },
        ...(saved.keyId ? { keyId: saved.keyId } : {}), ...(this.keys ? { keys: structuredClone(this.keys) } : {}),
        ...(this.groups ? { groups: structuredClone(this.groups) } : {}), ...(this.vip ? { vip: structuredClone(this.vip) } : {}),
        ...(this.accountUpdatedAt ? { accountUpdatedAt: this.accountUpdatedAt } : {}) } : {}),
      ...(this.keyOperation ? { keyCreation: { id: this.keyOperation.id, name: this.keyOperation.name, groupNames: [...this.keyOperation.groupNames] } } : {}),
      ...(this.credentials && 'apiKey' in this.credentials && this.credentials.keyName ? { keyName: this.credentials.keyName } : {}),
      ...structuredClone(this.info), models: this.catalog.map(row => row.id), ...(this.selected ? { model: this.selected } : {}),
      message: this.message, ...(this.login ? { login: { id: this.login.id, expiresAt: this.login.expiresAt, failed: this.login.failed } } : {}) }
  }

  /** Private harness handoff; never serialized to REST, SSE, logs or settings. */
  adapter(): SakuraApiModelAdapter {
    return new SakuraApiModelAdapter(this.phase === 'connected' && !this.client?.expired && this.credentials && 'apiKey' in this.credentials ? this.credentials.apiKey : undefined,
      this.phase === 'connected' ? this.catalog : [], this.selected ?? '', this.options.fetch)
  }

  private bindClient(): void {
    const saved = this.credentials
    if (!saved || !('client' in saved)) return
    this.client?.close()
    this.client = new SakuraApiClient(saved.client, { fetch: this.options.fetch, signal: this.controller.signal,
      persist: async client => {
        const current = this.credentials
        if (!current || !('client' in current)) throw new SakuraApiError('账号连接已改变。', 409)
        const candidate = { ...current, client }
        if (this.remember && this.options.persist) await this.options.persist(candidate)
        this.check(); this.credentials = candidate
      } })
  }

  private clientSaved(): SakuraApiClientSaved {
    if (!this.credentials || !('client' in this.credentials) || !this.client || this.phase === 'expired') throw new SakuraApiError('请先通过客户端接口连接 SakuraAPI 账号。', 409)
    return this.credentials
  }

  private async optionalAccountQuery(route: string): Promise<unknown> {
    try { return await this.client!.request(route) }
    catch (error) {
      if (this.client!.expired || error instanceof SakuraApiError && error.status === 401) throw error
      return undefined
    }
  }

  private async synchronizeAccount(): Promise<void> {
    const current = this.clientSaved()
    await this.client!.retryPendingSave()
    const profile = parseSakuraProfile(await this.client!.request('/user/profile'), current.client.user.id)
    const [vipData, stats, subscriptions, progress, groups, rates, keys] = await Promise.all([
      this.optionalAccountQuery('/usage/dashboard/snapshot-v2?include_trend=false&include_model_stats=false&include_group_stats=false'),
      this.optionalAccountQuery('/usage/dashboard/stats'), this.optionalAccountQuery('/subscriptions/active'),
      this.optionalAccountQuery('/subscriptions/progress'), this.optionalAccountQuery('/groups/available'),
      this.optionalAccountQuery('/groups/rates'), this.optionalAccountQuery('/keys?page=1&page_size=20'),
    ])
    this.check()
    const now = new Date().toISOString()
    const warnings: string[] = []
    const vip = parseSakuraVip(record(vipData)?.vip)
    if (!vip) warnings.push('VIP 未能同步')
    let parsedKeys: SakuraApiKeyPage | undefined, parsedGroups: SakuraApiGroupChoice[] | undefined
    let parsedSubscriptions: SakuraApiUsageInfo['subscriptions'], parsedUsage: SakuraApiUsageInfo['usage']
    try { if (keys !== undefined) parsedKeys = parseSakuraKeyPage(keys, current.client.user.id) } catch { warnings.push('Key 列表响应无效') }
    try { if (groups !== undefined) parsedGroups = parseSakuraGroups(groups, rates) } catch { warnings.push('分组响应无效') }
    try { if (subscriptions !== undefined) parsedSubscriptions = parseSakuraAccountSubscriptions(subscriptions, current.client.user.id, progress) } catch { warnings.push('订阅响应无效') }
    try { if (stats !== undefined) parsedUsage = parseSakuraAccountUsage(stats) } catch { warnings.push('用量响应无效') }
    if ([keys, groups, subscriptions, stats].some(value => value === undefined)) warnings.push('部分账号数据未能同步')
    this.profile = profile.user; this.vip = vip; this.keys = parsedKeys; this.groups = parsedGroups; this.accountUpdatedAt = now
    this.info = { ...this.info, balance: profile.balance, balanceSource: profile.balance !== undefined ? 'account' : undefined,
      balanceUpdatedAt: profile.balance !== undefined ? now : undefined, subscriptions: parsedSubscriptions, usage: parsedUsage,
      usageSource: 'account', updatedAt: now, warning: warnings.length ? warnings.join('；') : undefined }
    const selected = this.clientSaved()
    if (!selected.apiKey || !selected.keyId) { this.catalog = []; this.selected = undefined; this.info.quota = undefined; return }
    try {
      const key = selectedSakuraKey(await this.client!.request('/keys/' + selected.keyId), selected.client.user.id, selected.keyId)
      if (key.apiKey !== selected.apiKey) throw new SakuraApiError('选定 Key 已变化，请重新选择。', 409)
      const synchronized = await this.synchronize(selected.apiKey)
      this.catalog = synchronized.catalog
      this.selected = this.catalog.some(row => row.id === this.selected) ? this.selected : this.catalog[0]!.id
      this.info.quota = synchronized.info.quota
    } catch (error) {
      this.catalog = []; this.selected = undefined; this.info.quota = undefined
      if (this.client!.expired) throw error
      this.info.warning = [this.info.warning, '选定 Key 未能验证，请重新选择 Key 或同步。'].filter(Boolean).join('；')
    }
  }

  async keyPage(page: number): Promise<SakuraApiStatus> {
    if (!positiveId(page) || page > 100000) throw new SakuraApiError('无效 Key 页码。')
    const finish = this.startChange()
    try { const saved = this.clientSaved(); this.keys = parseSakuraKeyPage(await this.client!.request('/keys?page=' + page + '&page_size=20'), saved.client.user.id); return this.status() }
    finally { finish() }
  }

  private async applyKey(value: unknown, expectedId?: number): Promise<SakuraApiStatus> {
    const current = this.clientSaved(), key = selectedSakuraKey(value, current.client.user.id, expectedId)
    const { catalog, info } = await this.synchronize(key.apiKey)
    const model = catalog.find(row => row.id === current.model)?.id ?? catalog.find(row => /(?:codex|gpt)/i.test(row.id))?.id ?? catalog[0]!.id
    const saved = { ...this.clientSaved(), apiKey: key.apiKey, keyId: key.choice.id, keyName: key.choice.name, model }
    if (this.remember && this.options.persist) await this.options.persist(saved)
    this.check(); this.credentials = saved; this.catalog = catalog; this.selected = model; this.info.quota = info.quota
    this.message = '已选择 Key 并同步可用模型；账号令牌不会发给模型接口。'
    return this.status()
  }

  async selectKey(id: number): Promise<SakuraApiStatus> {
    if (!positiveId(id)) throw new SakuraApiError('无效 Key ID。')
    const finish = this.startChange()
    try { this.clientSaved(); return await this.applyKey(await this.client!.request('/keys/' + id), id) }
    catch (error) { throw error instanceof SakuraApiError ? error : new SakuraApiError('Key 选择或安全保存失败，原选择未改变。', 502) }
    finally { finish() }
  }

  prepareKey(name: string, groupIds: number[]): { id: string; name: string; groupNames: string[] } {
    this.check(); this.clientSaved()
    if (this.changing || this.refreshing) throw new SakuraApiError('账号请求正在处理，请稍后重试。', 409)
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\x00-\x1f\x7f]/.test(name) ||
      !Array.isArray(groupIds) || !groupIds.length || groupIds.length > 32 || new Set(groupIds).size !== groupIds.length ||
      groupIds.some(id => !positiveId(id) || !this.groups?.some(group => group.id === id))) throw new SakuraApiError('请输入 Key 名称，并选择 1–32 个当前账号可用的分组。')
    if (this.keyOperation) throw new SakuraApiError('已有待确认或待重试的 Key 创建操作，请先完成或取消。', 409)
    const id = randomUUID(), groupNames = groupIds.map(id => this.groups!.find(group => group.id === id)!.name)
    const body = JSON.stringify({ name: name.trim(), group_bindings: groupIds.map((group_id, priority) => ({ group_id, priority })),
      quota: 0, ip_whitelist: [], ip_blacklist: [], rate_limit_5h: 0, rate_limit_1d: 0, rate_limit_7d: 0 })
    this.keyOperation = { id, body, name: name.trim(), groupNames }
    return { id, name: name.trim(), groupNames }
  }

  cancelKeyCreation(id: string): void {
    this.check()
    if (this.changing || this.refreshing) throw new SakuraApiError('账号请求正在处理。', 409)
    if (this.keyOperation?.id !== id) throw new SakuraApiError('Key 创建操作已失效。', 409)
    this.keyOperation = undefined
  }

  async createKey(id: string): Promise<SakuraApiStatus> {
    const finish = this.startChange()
    try {
      this.clientSaved()
      const operation = this.keyOperation
      if (!operation || operation.id !== id) throw new SakuraApiError('Key 创建操作已失效，请重新选择。', 409)
      if (!operation.result) operation.result = await this.client!.request('/keys', { method: 'POST',
        headers: { 'content-type': 'application/json', 'Idempotency-Key': operation.id }, body: operation.body })
      await this.applyKey(operation.result)
      this.keyOperation = undefined
      this.message = '已按你确认的分组创建并选择 Key，模型已同步。'
      return this.status()
    } catch (error) { throw error instanceof SakuraApiError ? error : new SakuraApiError('创建或安全保存 Key 失败，请明确重试同一操作。', 502) }
    finally { finish() }
  }

  /** Called only by real foreground actions, never by a timer. */
  foregroundActivity(): Promise<void> {
    if (!this.client || this.phase !== 'connected') return Promise.resolve()
    if (this.changing || this.refreshing) return Promise.reject(new SakuraApiError('账号请求正在处理，请稍后重试。', 409))
    if (this.activity) return this.activity
    const work = this.client.request('/auth/client/activity', { method: 'POST' }).then(() => {})
    this.activity = work
    void work.finally(() => { if (this.activity === work) this.activity = undefined }).catch(() => {})
    return work
  }

  private check(): void { if (this.closed) throw new SakuraApiError('账号连接已关闭。', 503) }

  private startChange(): () => void {
    this.check()
    if (this.changing || this.refreshing || this.activity) throw new SakuraApiError('正在处理账号请求，请稍后重试。', 409)
    this.changing = true
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    this.changeFinished = pending
    return () => { this.changing = false; if (this.changeFinished === pending) this.changeFinished = undefined; finish() }
  }

  private async request(url: string, key?: string): Promise<any> {
    this.check()
    if (![SAKURA_MODEL_BASE_URL + '/models', SAKURA_MODEL_BASE_URL + '/usage', SAKURA_API_ORIGIN + '/api/v1/models/available'].includes(url)) {
      throw new SakuraApiError('拒绝向非官方接口发送授权。', 400)
    }
    let response: Response
    try {
      response = await (this.options.fetch ?? globalThis.fetch)(url, { method: 'GET', headers: { accept: 'application/json', 'accept-language': 'zh-CN',
        ...(key ? { authorization: 'Bearer ' + key } : {}) },
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]), redirect: 'error', credentials: 'omit' })
    } catch { throw new SakuraApiError('无法连接 SakuraAPI，请检查网络后重试。', 502) }
    if (!response.ok || response.redirected) {
      await response.body?.cancel()
      throw new SakuraApiError(response.status === 401 ? 'SakuraAPI 授权 Key 已失效，请重新授权。' : 'SakuraAPI 暂时无法响应，请稍后重试。', response.status === 401 ? 401 : 502)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new SakuraApiError('SakuraAPI 返回了空响应。', 502)
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        bytes += value.length
        if (bytes > 1024 * 1024) throw new SakuraApiError('SakuraAPI 响应过大。', 502)
        chunks.push(value)
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (record(payload) && Object.hasOwn(payload, 'code')) {
        if (payload.code !== 0 || payload.data == null) throw new SakuraApiError('SakuraAPI 拒绝了本次查询。', 502)
        return payload.data
      }
      return payload
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error instanceof SakuraApiError ? error : new SakuraApiError('SakuraAPI 返回了无效响应。', 502)
    } finally { reader.releaseLock() }
  }

  private async synchronize(key: string) {
    const [modelData, usageData, metadata] = await Promise.all([
      this.request(SAKURA_MODEL_BASE_URL + '/models', key), this.request(SAKURA_MODEL_BASE_URL + '/usage', key),
      this.request(SAKURA_API_ORIGIN + '/api/v1/models/available').catch(() => undefined),
    ])
    this.check()
    const models = Array.isArray(modelData?.data) ? modelData.data : undefined
    if (!models || models.length > 4096) throw new SakuraApiError('SakuraAPI 返回了无效模型列表。', 502)
    const facts = new Map<string, { endpoints: Set<string>; reasoning: boolean; tools?: boolean }>()
    if (Array.isArray(metadata?.groups)) for (const group of metadata.groups.slice(0, 200)) {
      if (!Array.isArray(group?.models)) continue
      for (const model of group.models.slice(0, 512)) {
        if (!validToken(model?.name, 200) || !record(model.metadata)) continue
        const fact = facts.get(model.name) ?? { endpoints: new Set<string>(), reasoning: false }
        for (const endpoint of Array.isArray(model.metadata.supported_endpoints) ? model.metadata.supported_endpoints : []) {
          if (typeof endpoint === 'string') fact.endpoints.add(endpoint)
        }
        fact.reasoning ||= model.metadata.supports_reasoning === true
        if (typeof model.metadata.supports_tools === 'boolean') fact.tools = fact.tools === true || model.metadata.supports_tools
        facts.set(model.name, fact)
      }
    }
    const catalog = [...new Set<string>(models.flatMap((row: unknown) => validToken(record(row)?.id, 200) ? [record(row)!.id as string] : []))]
      .sort().slice(0, 512).flatMap(id => {
        const fact = facts.get(id)
        if (fact?.tools === false || /(?:embedding|rerank|whisper|(?:^|[-_])(?:tts|asr|image|audio)(?:[-_]|$))/i.test(id)) return []
        const chat = fact?.endpoints.has('/v1/chat/completions'), responses = fact?.endpoints.has('/v1/responses')
        if (fact?.endpoints.size && !chat && !responses) return []
        return [{ id, format: responses && !chat ? 'responses' as const : 'chat-completions' as const, reasoning: fact?.reasoning ?? false }]
      })
    if (!catalog.length) throw new SakuraApiError('授权 Key 没有可用于对话的模型，请在官网检查分组或订阅。', 409)
    if (usageData?.isValid === false && usageData.status !== 'quota_exhausted') throw new SakuraApiError('SakuraAPI 授权 Key 已失效，请重新授权。', 401)
    let info: SakuraApiUsageInfo
    try { info = parseSakuraApiUsage(usageData) } catch { throw new SakuraApiError('SakuraAPI 返回了无效 Key 用量信息。', 502) }
    return { catalog, info }
  }

  async beginLogin(remember = !!this.options.persist): Promise<SakuraApiStatus> {
    if (this.credentials) throw new SakuraApiError('请先退出已有授权，再授权其他账号。', 409)
    if (remember && !this.options.persist) throw new SakuraApiError('当前环境不支持安全保存授权，请取消记住登录。')
    const finish = this.startChange()
    try {
      await this.detachLogin()
      const window = await (this.options.openLogin ?? openSakuraApiAuthorization)()
      if (this.closed) { await window.close(); throw new SakuraApiError('账号连接已关闭。', 503) }
      const id = randomUUID(), expiresAt = window.draft?.expiresAt ?? Date.now() + 10 * 60_000
      const timer = setTimeout(() => { if (!this.changing) void this.cancelLogin().catch(() => {}) }, expiresAt - Date.now())
      timer.unref()
      this.login = { id, expiresAt, window, remember, failed: false, timer }
      this.phase = 'login'
      this.message = '请在系统浏览器中确认账号并点击「同意并连接账号」。只连接账号，不自动创建或选择 Key。'
      return this.status()
    } catch (error) {
      throw error instanceof SakuraApiError ? error : new SakuraApiError('无法打开官网授权，请检查系统默认浏览器后重试。', 502)
    } finally { finish() }
  }

  async pollLogin(id: string, retry = false): Promise<SakuraApiStatus> {
    this.check()
    const login = this.login
    if (!login || login.id !== id || login.expiresAt <= Date.now()) throw new SakuraApiError('本次授权已过期，请重新开始。', 409)
    if (login.failed && !retry) return this.status()
    const finish = this.startChange()
    let storing = false
    try {
      if (login.window.draft) {
        const draft = login.window.draft
        if (!login.candidate) {
          if (login.exchangeStarted) throw new SakuraApiError('一次性换码结果未确认，请取消并重新授权。不会重复提交已使用的授权码。', 409)
          const raw = record(await login.window.readAuthorization())
          if (!raw) return this.status()
          if (raw.state !== draft.state) throw new SakuraApiError('官网授权状态不匹配。', 409)
          if (raw.event !== 'authorized') {
            await this.detachLogin()
            this.message = raw.event === 'denied' ? '你已拒绝账号授权，没有连接或创建 Key。' : '官网未能完成授权，请重新尝试。'
            return this.status()
          }
          const data = record(raw.data)
          if (!data || data.clientId !== draft.clientId || typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.code)) throw new SakuraApiError('官网返回了无效客户端授权码。', 409)
          login.exchangeStarted = true
          login.candidate = { client: await exchangeSakuraClientCode(draft, data.code, { fetch: this.options.fetch, signal: this.controller.signal }) }
        }
        const candidate = login.candidate
        this.check()
        if (this.login !== login || login.expiresAt <= Date.now()) throw new SakuraApiError('本次授权已取消或过期。', 409)
        if (this.options.persist) { storing = login.remember; await this.options.persist(login.remember ? candidate : null) }
        this.check()
        if (this.login !== login || login.expiresAt <= Date.now()) throw new SakuraApiError('本次授权已取消或过期。', 409)
        this.credentials = candidate; this.remember = login.remember; this.bindClient()
        // The code has already been consumed. A later query failure keeps this
        // account connected; explicit refresh must not perform another exchange.
        storing = false
        await this.detachLogin(); this.check(); this.phase = 'connected'
        try { await this.synchronizeAccount() }
        catch (error) {
          if (this.client!.expired) { this.phase = 'expired'; this.catalog = []; this.info = {}; this.message = '客户端授权已失效，请退出后重新授权。' }
          else { this.info.warning = '账号已连接，资料同步失败，请点击同步重试。'; this.message = this.info.warning }
          throw error
        }
        this.message = this.remember ? '账号已连接，客户端凭据已由 Windows 加密保存。请在「模型设置」选择已有 Key 或确认模型分组创建新 Key。'
          : '账号已连接，仅本次运行保留客户端凭据。请在「模型设置」选择已有 Key 或确认模型分组创建新 Key。'
        return this.status()
      }
      const raw = record(await login.window.readAuthorization())
      if (!raw) return this.status()
      if (raw.event !== 'created') {
        await this.detachLogin()
        this.message = raw.event === 'denied' ? '你已拒绝官网授权，没有连接账号。' : '官网未能完成授权，请重新尝试。'
        return this.status()
      }
      const data = record(raw.data)
      if (!data || !validToken(data.key)) throw new SakuraApiError('官网授权返回了无效 Key。', 409)
      const { catalog, info } = await this.synchronize(data.key)
      const model = catalog.find(row => /(?:codex|gpt)/i.test(row.id))?.id ?? catalog[0]!.id
      const candidate = parseSakuraApiSaved({ apiKey: data.key,
        keyName: typeof data.name === 'string' ? data.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 160) : undefined, model })
      this.check()
      if (this.login !== login || login.expiresAt <= Date.now()) throw new SakuraApiError('本次授权已取消或过期。', 409)
      if (this.options.persist) { storing = login.remember; await this.options.persist(login.remember ? candidate : null) }
      this.check()
      if (this.login !== login || login.expiresAt <= Date.now()) throw new SakuraApiError('本次授权已取消或过期。', 409)
      this.credentials = candidate; this.remember = login.remember; this.catalog = catalog; this.selected = model
      const now = new Date().toISOString()
      const consentBalance = typeof data.balance === 'number' && Number.isFinite(data.balance) ? data.balance : undefined
      this.info = { ...info, updatedAt: now,
        ...(info.balance !== undefined ? { balanceSource: 'usage', balanceUpdatedAt: now }
          : consentBalance !== undefined ? { balance: consentBalance, balanceSource: 'authorization', balanceUpdatedAt: now } : {}) }
      await this.detachLogin()
      this.check()
      this.phase = 'connected'
      this.message = this.remember ? '已授权，Key 使用 Windows 当前用户加密保存；模型与额度已同步。' : '已授权，仅本次运行保留 Key；模型与额度已同步。'
      return this.status()
    } catch (error) {
      if (storing && this.options.persist) await this.options.persist(null).catch(() => {})
      if (this.login === login) { login.failed = true; this.message = login.exchangeStarted && !login.candidate
        ? '换码结果未确认，请取消并重新授权；不会重复提交一次性授权码。'
        : '授权处理已暂停，请点击「重试连接」。不会自动重复授权或创建 Key。' }
      throw error instanceof SakuraApiError ? error : new SakuraApiError('无法安全保存授权，账号未连接。请重试。', 502)
    } finally {
      try { if (this.login === login && login.expiresAt <= Date.now()) await this.detachLogin() }
      finally { finish() }
    }
  }

  async cancelLogin(): Promise<SakuraApiStatus> {
    const finish = this.startChange()
    try { await this.detachLogin(); this.message = '已取消本机授权接收，没有自动创建 Key。'; return this.status() }
    finally { finish() }
  }

  private async detachLogin(): Promise<void> {
    const login = this.login
    this.login = undefined
    if (login) { clearTimeout(login.timer); await login.window.close().catch(() => {}) }
    if (!this.credentials) this.phase = 'signed-out'
  }

  refresh(): Promise<SakuraApiStatus> {
    this.check()
    if (this.changing || this.activity) return Promise.reject(new SakuraApiError('正在处理授权，请稍后刷新。', 409))
    if (this.refreshing) return this.refreshing
    const work = this.doRefresh()
    this.refreshing = work
    void work.finally(() => { if (this.refreshing === work) this.refreshing = undefined }).catch(() => {})
    return work
  }

  private async doRefresh(): Promise<SakuraApiStatus> {
    const current = this.credentials
    if (current && 'client' in current) {
      if (this.phase === 'expired') throw new SakuraApiError('客户端授权已失效，请退出后重新授权。', 401)
      try {
        await this.synchronizeAccount(); this.check(); this.phase = 'connected'
        this.message = this.catalog.length ? '已同步账号资料、VIP、订阅、用量与所选 Key 的模型。' : '账号已连接，请在「模型设置」选择已有 Key 或确认模型分组创建新 Key。'
        return this.status()
      } catch (error) {
        if (this.client!.expired) { this.phase = 'expired'; this.catalog = []; this.info = {}; this.vip = undefined; this.message = '客户端授权已失效，请退出后重新授权。' }
        else { this.info.warning = '同步失败，当前显示上次数据，请明确重试。'; this.message = '账号资料同步失败，已保留旧数据。' }
        throw error instanceof SakuraApiError ? error : new SakuraApiError('无法同步 SakuraAPI 客户端账号，请重试。', 502)
      }
    }
    if (!current || !('apiKey' in current)) return this.status()
    try {
      const { catalog, info } = await this.synchronize(current.apiKey)
      this.check()
      this.catalog = catalog
      this.selected = catalog.some(row => row.id === this.selected) ? this.selected : catalog[0]!.id
      const now = new Date().toISOString()
      this.info = { ...this.info, ...info, subscriptions: info.subscriptions, quota: info.quota, usage: info.usage, warning: info.warning, updatedAt: now,
        ...(info.balance !== undefined ? { balanceSource: 'usage', balanceUpdatedAt: now } : {}) }
      this.phase = 'connected'
      this.message = '已同步授权 Key 的可用模型与额度。未提供的数据请在官网查看。'
      return this.status()
    } catch (error) {
      if (error instanceof SakuraApiError && error.status === 401) { this.phase = 'expired'; this.catalog = []; this.info = {}; this.message = '授权 Key 已失效，请退出后重新授权。' }
      else { this.info.warning = '同步失败，当前显示上次数据，请稍后刷新。'; this.message = '同步失败，已保留上次可用配置。' }
      throw error instanceof SakuraApiError ? error : new SakuraApiError('无法同步 SakuraAPI，请重试。', 502)
    }
  }

  async selectModel(model: string): Promise<SakuraApiStatus> {
    const finish = this.startChange()
    try {
      if (this.phase !== 'connected' || !this.credentials || !('apiKey' in this.credentials) || !this.catalog.some(row => row.id === model)) {
        throw new SakuraApiError('请选择已同步的 SakuraAPI 模型。', 400)
      }
      const saved = { ...this.credentials, model }
      if (this.remember && this.options.persist) await this.options.persist(saved)
      this.check()
      this.credentials = saved; this.selected = model
      return this.status()
    } catch (error) { throw error instanceof SakuraApiError ? error : new SakuraApiError('无法安全保存模型选择，已保留原设置。', 502) }
    finally { finish() }
  }

  /** Change disk retention without revoking or repeating the current grant. */
  async setRemember(remember: boolean): Promise<SakuraApiStatus> {
    if (typeof remember !== 'boolean') throw new SakuraApiError('记住登录必须为布尔值。', 400)
    if (!this.options.persist) throw new SakuraApiError('当前环境不支持安全保存授权。', 409)
    const finish = this.startChange()
    try {
      if (!this.credentials || this.status().phase !== 'connected') throw new SakuraApiError('请先连接有效账号，再更改记住登录。', 409)
      // A paused token rotation may still hold the only usable refresh token.
      // Commit it before retaining credentials; never save the consumed token.
      await this.client?.retryPendingSave()
      await this.options.persist(remember ? this.credentials : null)
      this.check()
      this.remember = remember
      this.message = remember ? '已使用 Windows 当前用户加密记住登录；下次启动自动恢复有效授权。'
        : '已移除本机保存的授权；当前连接保留，仅本次运行有效。'
      return this.status()
    } catch (error) { throw error instanceof SakuraApiError ? error : new SakuraApiError('无法更改加密保存状态，已保留原设置。', 502) }
    finally { finish() }
  }

  async logout(): Promise<SakuraApiStatus> {
    const finish = this.startChange()
    let clientRevokeAttempted = false
    try {
      if (this.client && this.credentials && 'client' in this.credentials) { clientRevokeAttempted = true; await this.client.revoke() }
      if (this.options.persist) await this.options.persist(null)
      this.check()
      this.client?.close(); this.client = undefined; this.profile = undefined; this.vip = undefined; this.keys = undefined; this.groups = undefined; this.accountUpdatedAt = undefined; this.keyOperation = undefined
      this.credentials = undefined; this.catalog = []; this.selected = undefined; this.info = {}; this.remember = false
      await this.detachLogin()
      this.phase = 'signed-out'
      this.message = '已退出并移除本机加密授权。客户端账号会话已单独撤销；模型 Key 未撤销，需要时到官网 Key 管理页删除。'
      return this.status()
    } catch (error) {
      if (clientRevokeAttempted) { this.phase = 'expired'; this.catalog = []; this.info = {}; this.vip = undefined; this.message = '退出未完成，本机授权仍被保留；模型调用已暂停。请重试退出或检查存储权限。' }
      throw error instanceof SakuraApiError ? error : new SakuraApiError('无法移除本机加密授权，账号仍被保留。请检查存储权限后重试。', 502)
    }
    finally { finish() }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.controller.abort()
    this.closing = (async () => {
      await this.detachLogin(); await this.changeFinished; await this.refreshing?.catch(() => {}); await this.activity?.catch(() => {})
      this.client?.close(); this.client = undefined; this.profile = undefined; this.vip = undefined; this.keys = undefined; this.groups = undefined; this.accountUpdatedAt = undefined; this.keyOperation = undefined
      this.credentials = undefined; this.catalog = []; this.info = {}; this.selected = undefined; this.remember = false; this.phase = 'signed-out'
    })()
    return this.closing
  }
}