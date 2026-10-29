import { SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL } from '../src/integrations/sakuraapi.js'

export const authorizedKey = 'sk-SYNTHETIC_SAKURA_AUTHORIZED_KEY'
export const authorized = { event: 'created', data: { key: authorizedKey, name: '<img src=x> 合成授权 Key', balance: 5.09 } }
export const modelIds = ['chat-test', 'gpt-test', 'responses-test']
export const usage = { balance: 5.09, planName: '<img src=x> 订阅', subscription: {
  daily_limit_usd: 10, daily_usage_usd: 2, weekly_limit_usd: 40, weekly_usage_usd: 5,
  monthly_limit_usd: 0, monthly_usage_usd: 8, expires_at: '2099-01-01T00:00:00Z',
}, usage: { total: { requests: 12, input_tokens: 150, output_tokens: 30, actual_cost: 0.4 } }, secret: 'UNRELATED_PRIVATE_FIELD' }
export const metadata = { groups: [{ models: modelIds.map(id => ({ name: id, metadata: {
  supported_endpoints: [id === 'responses-test' ? '/v1/responses' : '/v1/chat/completions'],
  supports_tools: true, supports_reasoning: id === 'responses-test',
} })) }] }
export const envelope = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { status: 200 })

/** Fixed real URL assertions with synthetic responses. Never touches a live account. */
export async function sakuraApiResponse(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const target = String(url)
  if (target === SAKURA_API_ORIGIN + '/api/v1/models/available') return envelope(metadata)
  if (target === SAKURA_MODEL_BASE_URL + '/models') return new Response(JSON.stringify({ data: modelIds.map(id => ({ id })) }))
  if (target === SAKURA_MODEL_BASE_URL + '/usage') return new Response(JSON.stringify(usage))
  if (target === SAKURA_MODEL_BASE_URL + '/chat/completions' || target === SAKURA_MODEL_BASE_URL + '/responses') {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer ' + authorizedKey) throw new Error('wrong synthetic model credential')
    return new Response(target.endsWith('/responses')
      ? 'data: ' + JSON.stringify({ type: 'response.completed', response: { output_text: 'SYNTHETIC_MODEL_REPLY', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n\n'
      : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'SYNTHETIC_MODEL_REPLY' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } })
  }
  throw new Error('unexpected external request: ' + target)
}