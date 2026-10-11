import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  WEIXIN_BASE_URL, WeixinApiError, WeixinClient, validateWeixinBaseUrl, validateWeixinCredentials,
  type WeixinCredentials, type WeixinTransport,
} from '../src/integrations/weixin-client.js'

const credentials: WeixinCredentials = {
  botToken: 'bot-token-0123456789', botId: 'bot-1', userId: 'wx-user-1', baseUrl: WEIXIN_BASE_URL,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recordingFetch(body: unknown = { ret: 0 }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: typeof globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(jsonResponse(body))
  }
  return { fetcher, calls }
}

describe('weixin client — protocol shape', () => {
  it('requests the QR code with the published POST contract and no bearer', async () => {
    const { fetcher, calls } = recordingFetch({ qrcode: 'qr-value', qrcode_img_content: 'https://ilinkai.weixin.qq.com/qr' })
    const client = new WeixinClient({ fetch: fetcher })
    const qr = await client.getQr(new AbortController().signal, ['token-a'])
    expect(qr).toEqual({ qrcode: 'qr-value', content: 'https://ilinkai.weixin.qq.com/qr' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${WEIXIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`)
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = new Headers(calls[0]!.init!.headers as HeadersInit)
    expect(headers.get('Authorization')).toBeNull()
    expect(headers.get('AuthorizationType')).toBe('ilink_bot_token')
    expect(headers.get('iLink-App-Id')).toBe('bot')
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ local_token_list: ['token-a'] })
  })

  it('sends bot credentials, base_info and the text item on sendMessage', async () => {
    const { fetcher, calls } = recordingFetch()
    const client = new WeixinClient({ fetch: fetcher })
    await client.sendText(credentials, '已完成', 'ctx-1', 'client-1', new AbortController().signal)
    const headers = new Headers(calls[0]!.init!.headers as HeadersInit)
    expect(headers.get('Authorization')).toBe(`Bearer ${credentials.botToken}`)
    const body = JSON.parse(String(calls[0]!.init!.body))
    expect(body.msg).toMatchObject({ to_user_id: 'wx-user-1', client_id: 'client-1', message_type: 2, message_state: 2, context_token: 'ctx-1' })
    expect(body.msg.item_list).toEqual([{ type: 1, text_item: { text: '已完成' } }])
    expect(body.base_info.bot_agent).toBe('SakuraCode/0.7.1')
  })

  it('returns the polling cursor and recognizes business error codes', async () => {
    const { fetcher, calls } = recordingFetch({ ret: 0, msgs: [], get_updates_buf: 'cursor-2' })
    const client = new WeixinClient({ fetch: fetcher })
    const updates = await client.getUpdates(credentials, 'cursor-1', new AbortController().signal)
    expect(updates.get_updates_buf).toBe('cursor-2')
    expect(updates.msgs).toEqual([])
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ get_updates_buf: 'cursor-1', base_info: { channel_version: '2.4.10', bot_agent: 'SakuraCode/0.7.1' } })
  })

  it('maps provider failures to expired errors without echoing credentials', async () => {
    const client = new WeixinClient({ fetch: () => Promise.resolve(jsonResponse({ ret: -14 })) })
    const error = await client.getUpdates(credentials, '', new AbortController().signal).catch((e) => e)
    expect(error).toBeInstanceOf(WeixinApiError)
    expect((error as WeixinApiError).expired).toBe(true)
    expect((error as WeixinApiError).message).not.toContain(credentials.botToken)
  })

  it('rejects non-HTTPS or non-weixin base URLs', () => {
    expect(() => validateWeixinBaseUrl('http://ilinkai.weixin.qq.com')).toThrow()
    expect(() => validateWeixinBaseUrl('https://evil.example.com')).toThrow()
    expect(() => validateWeixinBaseUrl('https://ilinkai.weixin.qq.com/path')).toThrow()
    expect(validateWeixinBaseUrl('https://ilinkai.weixin.qq.com')).toBe('https://ilinkai.weixin.qq.com')
  })

  it('validates credentials structurally', () => {
    expect(() => validateWeixinCredentials({ botToken: 'x', botId: 'b', userId: 'u', baseUrl: 'https://evil.example.com' })).toThrow()
    expect(validateWeixinCredentials({ botToken: 'token-1234567890', botId: 'bot-1', userId: 'wx-user', baseUrl: WEIXIN_BASE_URL }))
      .toEqual({ botToken: 'token-1234567890', botId: 'bot-1', userId: 'wx-user', baseUrl: WEIXIN_BASE_URL })
  })

  it('forwards caller cancellation', async () => {
    let rejectFetch: (error: Error) => void = () => {}
    const client = new WeixinClient({ fetch: () => new Promise<Response>((_, reject) => { rejectFetch = reject }) })
    const controller = new AbortController()
    const promise = client.getQr(controller.signal).catch((error: unknown) => error)
    controller.abort(new Error('client cancelled'))
    rejectFetch(new Error('unreachable'))
    const error = await promise as Error
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('client cancelled')
  })
})
