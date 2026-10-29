import { createSakuraAuthorizationDraft } from '../src/integrations/sakuraapi-authorization.js'
import { SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL, type SakuraApiClientSaved } from '../src/integrations/sakuraapi.js'
import { SAKURA_CLIENT_ID, SAKURA_CLIENT_SCOPE, parseSakuraClientTokens, type SakuraApiClientSession } from '../src/integrations/sakuraapi-client.js'
import { authorizedKey, envelope, modelIds, sakuraApiResponse, usage } from './sakuraapi-fixture.js'

export const clientAccessToken = 'SYNTHETIC_CLIENT_ACCESS_TOKEN'
export const clientRefreshToken = 'rt_' + 'a'.repeat(64)
export const rotatedAccessToken = 'SYNTHETIC_CLIENT_ROTATED_ACCESS_TOKEN'
export const rotatedRefreshToken = 'rt_' + 'b'.repeat(64)
export const clientUser = { id: 73, username: '<img src=x> Sakura 客户端', email: 'synthetic@example.test' }
export const clientTokens = (rotated = false) => ({ access_token: rotated ? rotatedAccessToken : clientAccessToken,
  refresh_token: rotated ? rotatedRefreshToken : clientRefreshToken, expires_in: 3600, token_type: 'Bearer',
  scope: SAKURA_CLIENT_SCOPE, client_id: SAKURA_CLIENT_ID, user: clientUser,
  idle_timeout_seconds: 432000, idle_expires_at: '2099-01-01T00:00:00Z', secret: 'UNRELATED_CLIENT_PRIVATE_FIELD' })
export const clientSaved = (selected = false): SakuraApiClientSaved => ({ client: parseSakuraClientTokens(clientTokens()),
  ...(selected ? { apiKey: authorizedKey, keyId: 101, keyName: 'Synthetic chosen Key', model: 'gpt-test' } : {}) })
export const clientKey = { id: 101, user_id: clientUser.id, key: authorizedKey, name: 'Synthetic chosen Key', group_id: 7,
  group_bindings: [{ group_id: 7, priority: 0 }], status: 'active', quota: 0, quota_used: 0.4, expires_at: null,
  unrelated: 'UNRELATED_CLIENT_PRIVATE_FIELD' }
export const clientVip = { enabled: true, level: 7, effective_level: 7, natural_level: 2, manual_level: 7,
  discount: 0.9, total_recharged: 600, currency: 'CNY', progress_recharged: 100, progress_required: 1000,
  next_level: { level: 8 }, admin_notes: 'UNRELATED_CLIENT_PRIVATE_FIELD' }
export const clientGroups = [{ id: 7, name: '<img src=x> 可用分组', platform: 'openai', status: 'active', subscription_type: 'standard', rate_multiplier: 1 },
  { id: 8, name: 'Synthetic backup group', platform: 'openai', status: 'active', subscription_type: 'standard', rate_multiplier: 1.2 }]
export const clientSubscriptions = [{ id: 301, user_id: clientUser.id, status: 'active', expires_at: '2099-01-01T00:00:00Z',
  group: { name: usage.planName, daily_limit_usd: 10, weekly_limit_usd: 40, monthly_limit_usd: 0 },
  daily_usage_usd: 2, weekly_usage_usd: 5, monthly_usage_usd: 8 }]
export const clientStatistics = { total_requests: 12, total_input_tokens: 150, total_output_tokens: 30, total_actual_cost: 0.4,
  total_account_cost: 1000, unrelated: 'UNRELATED_CLIENT_PRIVATE_FIELD' }
export const clientDraft = () => createSakuraAuthorizationDraft('http://127.0.0.1:48321/synthetic-client-callback')
export const clientAuthorization = (state: string) => ({ event: 'authorized', state, data: { code: 'c'.repeat(43), clientId: SAKURA_CLIENT_ID } })

/** Synthetic fixed-origin contract, no real account access. */
export async function sakuraClientResponse(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url), parsed = new URL(target), route = parsed.pathname.replace(/^\/api\/v1/, '')
  if (target.startsWith(SAKURA_MODEL_BASE_URL) || target === SAKURA_API_ORIGIN + '/api/v1/models/available') return sakuraApiResponse(url, init)
  if (parsed.origin !== SAKURA_API_ORIGIN) throw new Error('unexpected external client request: ' + target)
  const authorization = new Headers(init?.headers).get('authorization')
  if (route === '/auth/client/token') {
    if (authorization) throw new Error('account token must not accompany exchange')
    const body = JSON.parse(String(init?.body))
    if (body.client_id !== SAKURA_CLIENT_ID) throw new Error('wrong client identity')
    return envelope(clientTokens(body.grant_type === 'refresh_token'))
  }
  if (route === '/auth/client/revoke') return envelope({ revoked: true })
  if (![clientAccessToken, rotatedAccessToken].some(token => authorization === 'Bearer ' + token)) throw new Error('wrong synthetic client credential')
  if (route === '/user/profile') return envelope({ ...clientUser, balance: 5.09,
    api_keys: [clientKey], auth_bindings: { secret: 'UNRELATED_CLIENT_PRIVATE_FIELD' } })
  if (route === '/usage/dashboard/snapshot-v2') return envelope({ vip: clientVip, unrelated: 'UNRELATED_CLIENT_PRIVATE_FIELD' })
  if (route === '/usage/dashboard/stats') return envelope(clientStatistics)
  if (route === '/subscriptions/active') return envelope(clientSubscriptions)
  if (route === '/subscriptions/progress') return envelope([])
  if (route === '/groups/available') return envelope(clientGroups)
  if (route === '/groups/rates') return envelope({ 7: 0.95 })
  if (route === '/keys' && init?.method === 'POST') return envelope({ ...clientKey, id: 102, name: JSON.parse(String(init.body)).name })
  if (route === '/keys') return envelope({ items: [clientKey], total: 1, page: Number(parsed.searchParams.get('page') || 1), page_size: 20, pages: 1 })
  if (route === '/keys/101' || route === '/keys/102') return envelope({ ...clientKey, id: Number(route.split('/').pop()) })
  if (route === '/auth/client/activity') return envelope({ active: true, idle_timeout_seconds: 432000 })
  throw new Error('unexpected synthetic client route: ' + target)
}

export const noClientSecrets = (value: unknown): boolean => !new RegExp([clientAccessToken, clientRefreshToken, rotatedAccessToken,
  rotatedRefreshToken, authorizedKey, 'UNRELATED_CLIENT_PRIVATE_FIELD'].join('|')).test(JSON.stringify(value))
export { authorizedKey, envelope, modelIds }
export type { SakuraApiClientSession }