/** The official client-account grant. These credentials never authorize model inference. */
import { SAKURA_API_ORIGIN, type SakuraApiAuthorizationDraft } from './sakuraapi-authorization.js'
import { record, validToken } from './sakuraapi-usage.js'

export const SAKURA_CLIENT_ID = 'sakuracode'
export const SAKURA_CLIENT_SCOPE = 'account:read keys:read keys:create usage:read'
export const SAKURA_CLIENT_IDLE_SECONDS = 432000

export class SakuraApiError extends Error {
  constructor(message: string, readonly status = 400, readonly reason = '') { super(message) }
}

export interface SakuraApiClientUser { id: number; username: string; email: string }
export interface SakuraApiClientSession {
  clientId: typeof SAKURA_CLIENT_ID
  scope: typeof SAKURA_CLIENT_SCOPE
  accessToken: string
  refreshToken: string
  accessExpiresAt: number
  idleTimeoutSeconds: typeof SAKURA_CLIENT_IDLE_SECONDS
  /** A server snapshot, not a local deadline: real use can extend it on the server. */
  idleExpiresAt: string
  user: SakuraApiClientUser
}

export const positiveId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export const accountText = (value: unknown, max = 160): string => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max).trim() : ''

export function parseSakuraClientUser(value: unknown, expectedId?: number): SakuraApiClientUser {
  const user = record(value)
  if (!user || !positiveId(user.id) || expectedId !== undefined && user.id !== expectedId ||
    typeof user.username !== 'string' || typeof user.email !== 'string') throw new SakuraApiError('SakuraAPI 返回了无效账号资料。', 502)
  return { id: user.id, username: accountText(user.username), email: accountText(user.email, 320) }
}

export function parseSakuraClientSession(value: unknown): SakuraApiClientSession {
  const row = record(value)
  if (!row || row.clientId !== SAKURA_CLIENT_ID || row.scope !== SAKURA_CLIENT_SCOPE ||
    !validToken(row.accessToken, 8192) || !/^[\x21-\x7e]+$/.test(row.accessToken) ||
    typeof row.refreshToken !== 'string' || !/^rt_[a-f0-9]{64}$/.test(row.refreshToken) ||
    typeof row.accessExpiresAt !== 'number' || !Number.isSafeInteger(row.accessExpiresAt) || row.accessExpiresAt < 0 ||
    row.idleTimeoutSeconds !== SAKURA_CLIENT_IDLE_SECONDS || typeof row.idleExpiresAt !== 'string' ||
    row.idleExpiresAt.length > 80 || !Number.isFinite(Date.parse(row.idleExpiresAt))) throw new SakuraApiError('无效的 SakuraAPI 客户端授权。', 400)
  return { clientId: SAKURA_CLIENT_ID, scope: SAKURA_CLIENT_SCOPE, accessToken: row.accessToken,
    refreshToken: row.refreshToken, accessExpiresAt: row.accessExpiresAt, idleTimeoutSeconds: SAKURA_CLIENT_IDLE_SECONDS,
    idleExpiresAt: new Date(row.idleExpiresAt).toISOString(), user: parseSakuraClientUser(row.user) }
}

export function parseSakuraClientTokens(value: unknown, expectedId?: number): SakuraApiClientSession {
  const row = record(value)
  if (!row || row.token_type !== 'Bearer' || !Number.isSafeInteger(row.expires_in) || row.expires_in < 1 || row.expires_in > 3600) {
    throw new SakuraApiError('SakuraAPI 返回了无效客户端令牌。', 502)
  }
  try {
    return parseSakuraClientSession({ clientId: row.client_id, scope: row.scope, accessToken: row.access_token,
      refreshToken: row.refresh_token, accessExpiresAt: Date.now() + row.expires_in * 1000,
      idleTimeoutSeconds: row.idle_timeout_seconds, idleExpiresAt: row.idle_expires_at,
      user: parseSakuraClientUser(row.user, expectedId) })
  } catch { throw new SakuraApiError('SakuraAPI 返回了无效客户端令牌。', 502) }
}

interface ClientTransportOptions { fetch?: typeof globalThis.fetch; signal: AbortSignal }

function allowedClientRequest(route: string, method: string): boolean {
  if (!route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x20\x7f]/.test(route)) return false
  const url = new URL(route, SAKURA_API_ORIGIN + '/api/v1/')
  if (url.origin !== SAKURA_API_ORIGIN || url.hash) return false
  const pathname = route.split('?')[0]
  if (method === 'POST') return ['/auth/client/token', '/auth/client/revoke', '/auth/client/activity', '/keys'].includes(pathname!) && !url.search
  if (method !== 'GET') return false
  if (['/auth/me', '/user/profile', '/groups/available', '/groups/rates', '/subscriptions/active', '/subscriptions/progress',
    '/usage/dashboard/stats'].includes(pathname!)) return !url.search
  if (pathname === '/usage/dashboard/snapshot-v2') return [...url.searchParams].every(([name, value]) =>
    ['include_trend', 'include_model_stats', 'include_group_stats'].includes(name) && value === 'false')
  if (pathname === '/keys') return [...url.searchParams].every(([name, value]) => ['page', 'page_size'].includes(name) && /^[1-9]\d{0,5}$/.test(value))
  return /^\/keys\/[1-9]\d{0,15}$/.test(pathname!) && !url.search
}

/** Fixed destinations, bounded bodies, stable UA, no website cookies or arbitrary error text. */
async function transport(route: string, init: RequestInit, options: ClientTransportOptions): Promise<unknown> {
  const method = init.method ?? 'GET'
  if (!allowedClientRequest(route, method)) throw new SakuraApiError('拒绝向未获准的接口发送客户端授权。', 400)
  const headers = new Headers(init.headers)
  headers.set('accept', 'application/json'); headers.set('accept-language', 'zh-CN'); headers.set('user-agent', 'SakuraCode Desktop')
  headers.set('cache-control', 'no-store')
  let response: Response
  try {
    response = await (options.fetch ?? globalThis.fetch)(SAKURA_API_ORIGIN + '/api/v1' + route, { ...init, method, headers,
      credentials: 'omit', redirect: 'error', signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) })
  } catch { throw new SakuraApiError('无法连接 SakuraAPI 客户端账号接口，请检查网络。', 502) }
  const reader = response.body?.getReader()
  if (!reader || response.redirected) { await response.body?.cancel(); throw new SakuraApiError('SakuraAPI 返回了无效账号响应。', 502) }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 1024 * 1024) throw new SakuraApiError('SakuraAPI 账号响应过大。', 502)
      chunks.push(value)
    }
    const payload = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    if (!response.ok || payload?.code !== 0) {
      const status = [400, 401, 403, 409, 429].includes(response.status) ? response.status : 502
      const reason = typeof payload?.reason === 'string' && /^[A-Z_]{1,80}$/.test(payload.reason) ? payload.reason : ''
      throw new SakuraApiError(status === 401 ? 'SakuraAPI 客户端账号授权已失效，请重新授权。' : 'SakuraAPI 账号查询失败，请稍后重试。', status, reason)
    }
    if (payload.data == null) throw new SakuraApiError('SakuraAPI 返回了空账号响应。', 502)
    return payload.data
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error instanceof SakuraApiError ? error : new SakuraApiError('SakuraAPI 返回了无效账号响应。', 502)
  } finally { reader.releaseLock() }
}

export async function exchangeSakuraClientCode(draft: SakuraApiAuthorizationDraft, code: string, options: ClientTransportOptions): Promise<SakuraApiClientSession> {
  if (draft.clientId !== SAKURA_CLIENT_ID || draft.expiresAt <= Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(code) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(draft.verifier)) throw new SakuraApiError('本次客户端授权无效或已过期。', 409)
  const data = await transport('/auth/client/token', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: SAKURA_CLIENT_ID,
      redirect_uri: draft.redirectUri, code, code_verifier: draft.verifier }) }, options)
  return parseSakuraClientTokens(data)
}

/** All account traffic shares a queue: refresh tokens rotate at most once.
 * A successful rotation awaiting a disk acknowledgement is retained for an explicit
 * save retry. An uncertain exchange is never repeated with the consumed token. */
export class SakuraApiClient {
  private queue: Promise<void> = Promise.resolve()
  private pending?: SakuraApiClientSession
  private savingPaused = false
  private invalid = false
  private closed = false
  constructor(private session: SakuraApiClientSession, private readonly options: ClientTransportOptions & {
    persist: (session: SakuraApiClientSession) => Promise<void>
  }) { this.session = parseSakuraClientSession(session) }

  get expired(): boolean { return this.invalid }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => {
      if (this.closed || this.options.signal.aborted) throw new SakuraApiError('账号连接已关闭。', 503)
      if (this.invalid) throw new SakuraApiError('客户端令牌轮换未确认或授权已失效，请退出后重新授权。', 401)
      return work()
    })
    this.queue = result.then(() => {}, () => {})
    return result
  }

  private async commitPending(): Promise<void> {
    if (!this.pending) return
    await this.options.persist(this.pending).catch(() => { this.savingPaused = true; throw new SakuraApiError('客户端令牌安全保存失败，账号查询已暂停。点击同步重试保存，不会重复换取令牌。', 502) })
    this.session = this.pending; this.pending = undefined
  }

  retryPendingSave(): Promise<void> {
    return this.serialize(async () => { this.savingPaused = false; await this.commitPending() })
  }

  private async rotate(): Promise<void> {
    if (this.pending) { await this.commitPending(); return }
    try {
      const data = await transport('/auth/client/token', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', client_id: SAKURA_CLIENT_ID, refresh_token: this.session.refreshToken }) }, this.options)
      this.pending = parseSakuraClientTokens(data, this.session.user.id)
    } catch {
      this.invalid = true
      throw new SakuraApiError('客户端令牌轮换未确认或授权已失效，请退出后重新授权。不会重复提交旧刷新令牌。', 401)
    }
    await this.commitPending()
  }

  request(route: string, init: RequestInit = {}): Promise<unknown> {
    if (!allowedClientRequest(route, init.method ?? 'GET')) return Promise.reject(new SakuraApiError('拒绝向未获准的接口发送客户端授权。', 400))
    if (route.startsWith('/auth/client/token') || route.startsWith('/auth/client/revoke')) return Promise.reject(new SakuraApiError('请使用专用客户端授权操作。', 400))
    return this.serialize(async () => {
      if (this.savingPaused) throw new SakuraApiError('客户端令牌安全保存失败，账号查询已暂停。请点击同步重试保存。', 502)
      await this.commitPending()
      if (Date.now() + 30_000 >= this.session.accessExpiresAt) await this.rotate()
      const send = () => {
        const headers = new Headers(init.headers); headers.set('authorization', 'Bearer ' + this.session.accessToken)
        return transport(route, { ...init, headers }, this.options)
      }
      try { return await send() }
      catch (error) {
        if (!(error instanceof SakuraApiError) || error.status !== 401) throw error
        await this.rotate()
        try { return await send() }
        catch (retryError) { if (retryError instanceof SakuraApiError && retryError.status === 401) this.invalid = true; throw retryError }
      }
    })
  }

  /** Does not refresh or touch activity just to revoke. Also works after expiry. */
  async revoke(): Promise<void> {
    await this.queue
    const session = this.pending ?? this.session
    await transport('/auth/client/revoke', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: SAKURA_CLIENT_ID, refresh_token: session.refreshToken }) }, this.options)
  }

  close(): void { this.closed = true; this.pending = undefined }
}