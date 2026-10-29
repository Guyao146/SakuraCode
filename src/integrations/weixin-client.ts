import { randomBytes } from 'node:crypto'

export const WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com'
const CHANNEL_VERSION = '2.4.10'
const MAX_RESPONSE_BYTES = 1024 * 1024

export interface WeixinCredentials {
  botToken: string
  botId: string
  userId: string
  baseUrl: string
}

export interface WeixinMessage {
  message_id?: number | string
  seq?: number | string
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  create_time_ms?: number
  message_type?: number
  message_state?: number
  group_id?: string
  context_token?: string
  item_list?: Array<{ type?: number; text_item?: { text?: string } }>
}

export interface WeixinQr { qrcode: string; content: string }
export interface WeixinQrStatus {
  status: string
  bot_token?: string
  ilink_bot_id?: string
  ilink_user_id?: string
  baseurl?: string
  redirect_host?: string
}
export interface WeixinUpdates {
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface WeixinTransport {
  getQr(signal: AbortSignal, tokens?: string[]): Promise<WeixinQr>
  pollQr(qrcode: string, baseUrl: string, signal: AbortSignal, verifyCode?: string): Promise<WeixinQrStatus>
  getUpdates(credentials: WeixinCredentials, cursor: string, signal: AbortSignal): Promise<WeixinUpdates>
  sendText(credentials: WeixinCredentials, text: string, contextToken: string, clientId: string, signal: AbortSignal): Promise<void>
}

export class WeixinApiError extends Error {
  constructor(message: string, readonly expired = false, readonly status?: number) { super(message) }
}

export function validateWeixinBaseUrl(input: string): string {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('invalid Weixin API address') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')) ||
    url.username || url.password || url.search || url.hash || (url.port && url.port !== '443') || url.pathname !== '/') {
    throw new Error('Weixin API must use an official weixin.qq.com HTTPS origin')
  }
  return url.origin
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x20\x7f]/.test(value)
}

export function validateWeixinCredentials(value: unknown): WeixinCredentials {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Weixin credentials')
  const row = value as Record<string, unknown>
  if (!boundedString(row.botToken, 4096) || !boundedString(row.botId, 256) || !boundedString(row.userId, 256) || typeof row.baseUrl !== 'string') {
    throw new Error('incomplete Weixin binding credentials')
  }
  return { botToken: row.botToken, botId: row.botId, userId: row.userId, baseUrl: validateWeixinBaseUrl(row.baseUrl) }
}

/** Independent client for Tencent's published iLink bot protocol (2.4.10). */
export class WeixinClient implements WeixinTransport {
  private readonly fetcher: typeof globalThis.fetch
  constructor(options: { fetch?: typeof globalThis.fetch } = {}) { this.fetcher = options.fetch ?? globalThis.fetch }

  private async request(base: string, endpoint: string, signal: AbortSignal, options: {
    body?: Record<string, unknown>; token?: string; timeoutMs?: number
  } = {}): Promise<Record<string, unknown>> {
    const origin = validateWeixinBaseUrl(base)
    const controller = new AbortController()
    const removeListener = () => controller.abort(signal.reason)
    signal.addEventListener('abort', removeListener, { once: true })
    if (signal.aborted) removeListener()
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000)
    timer.unref()
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', removeListener) }
    try {
      if (signal.aborted || controller.signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      const headers: Record<string, string> = {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 10),
      }
      if (options.body) {
        headers['Content-Type'] = 'application/json'
        headers.AuthorizationType = 'ilink_bot_token'
        headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64')
      }
      if (options.token) headers.Authorization = `Bearer ${options.token}`
      const target = `${origin}/${endpoint}`
      let response: Response | undefined
      try {
        response = await this.fetcher(target, {
          method: options.body ? 'POST' : 'GET', headers, redirect: 'error', signal: controller.signal,
          ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        })
      } catch (error) {
        if (signal.aborted || controller.signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
        throw new WeixinApiError(error instanceof Error && error.name === 'AbortError' ? 'Weixin request timed out' : 'Cannot reach the Weixin service')
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new WeixinApiError(`Weixin service returned HTTP ${response.status}`, response.status === 401, response.status)
      }
      if (Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES) {
        await response.body?.cancel()
        throw new WeixinApiError('Weixin response exceeds the size limit')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new WeixinApiError('Weixin returned an empty response')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const result = await reader.read()
          if (result.done) break
          length += result.value.length
          if (length > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new WeixinApiError('Weixin response exceeds the size limit') }
          chunks.push(result.value)
        }
      } finally { reader.releaseLock() }
      let result: unknown
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new WeixinApiError('Weixin returned invalid JSON') }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new WeixinApiError('Weixin returned an invalid response')
      const row = result as Record<string, unknown>
      const codes = [row.ret, row.errcode].filter((code): code is number => typeof code === 'number' && code !== 0)
      if (codes.length) throw new WeixinApiError(`Weixin service error (${codes.join(', ')})`, codes.includes(-14))
      return row
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (error instanceof WeixinApiError) throw error
      // Provider bodies, fetch URLs and cause chains can contain login tokens.
      throw new WeixinApiError('Cannot reach the Weixin service')
    } finally {
      cleanup()
    }
  }

  private botBody(body: Record<string, unknown>): Record<string, unknown> {
    return { ...body, base_info: { channel_version: CHANNEL_VERSION, bot_agent: 'SakuraCode/1.0.0' } }
  }

  async getQr(signal: AbortSignal, tokens: string[] = []): Promise<WeixinQr> {
    const row = await this.request(WEIXIN_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3', signal, {
      body: { local_token_list: tokens.slice(0, 10) },
    })
    if (!boundedString(row.qrcode, 4096) || typeof row.qrcode_img_content !== 'string' ||
      !row.qrcode_img_content || row.qrcode_img_content.length > 4096) throw new WeixinApiError('Weixin did not provide a valid QR code')
    return { qrcode: row.qrcode, content: row.qrcode_img_content }
  }

  async pollQr(qrcode: string, baseUrl: string, signal: AbortSignal, verifyCode?: string): Promise<WeixinQrStatus> {
    const query = new URLSearchParams({ qrcode })
    if (verifyCode) query.set('verify_code', verifyCode)
    const row = await this.request(baseUrl, `ilink/bot/get_qrcode_status?${query}`, signal, { timeoutMs: 40_000 })
    if (typeof row.status !== 'string') throw new WeixinApiError('Weixin returned an invalid login status')
    return row as unknown as WeixinQrStatus
  }

  async getUpdates(credentials: WeixinCredentials, cursor: string, signal: AbortSignal): Promise<WeixinUpdates> {
    const row = await this.request(credentials.baseUrl, 'ilink/bot/getupdates', signal, {
      body: this.botBody({ get_updates_buf: cursor }), token: credentials.botToken, timeoutMs: 40_000,
    })
    if (row.msgs !== undefined && (!Array.isArray(row.msgs) || row.msgs.length > 1000)) throw new WeixinApiError('Weixin returned an invalid message batch')
    if (row.get_updates_buf !== undefined && (typeof row.get_updates_buf !== 'string' || row.get_updates_buf.length > 65_536)) {
      throw new WeixinApiError('Weixin returned an invalid update cursor')
    }
    return row as WeixinUpdates
  }

  async sendText(credentials: WeixinCredentials, text: string, contextToken: string, clientId: string, signal: AbortSignal): Promise<void> {
    if (!contextToken || contextToken.length > 8192) throw new WeixinApiError('Send a new Weixin message to refresh the reply context')
    await this.request(credentials.baseUrl, 'ilink/bot/sendmessage', signal, {
      token: credentials.botToken,
      body: this.botBody({ msg: {
        from_user_id: '', to_user_id: credentials.userId, client_id: clientId,
        message_type: 2, message_state: 2, context_token: contextToken,
        item_list: [{ type: 1, text_item: { text } }],
      } }),
    })
  }
}
