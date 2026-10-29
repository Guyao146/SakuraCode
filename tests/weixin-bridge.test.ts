import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { WeixinBridge, WeixinBridgeError, parseWeixinSaved, type WeixinSaved } from '../src/integrations/weixin.js'
import type { WeixinCredentials, WeixinMessage, WeixinQr, WeixinQrStatus, WeixinTransport, WeixinUpdates } from '../src/integrations/weixin-client.js'

const credentials: WeixinCredentials = { botToken: 'bot-token-1234567890', botId: 'bot-1', userId: 'wx-user-1', baseUrl: 'https://ilinkai.weixin.qq.com' }
const code = (workspaceId: string): string => createHash('sha256').update(workspaceId).digest('hex').slice(0, 6)

class FakeTransport implements WeixinTransport {
  sent: Array<{ text: string; token: string }> = []
  qrResponse: WeixinQr = { qrcode: 'qr-1', content: 'https://ilinkai.weixin.qq.com/qr' }
  statusSequence: WeixinQrStatus[] = [{ status: 'wait' }, { status: 'scaned' }, { status: 'confirmed', bot_token: credentials.botToken, ilink_bot_id: credentials.botId, ilink_user_id: credentials.userId, baseurl: credentials.baseUrl }]
  incoming: WeixinMessage[] = []
  cursor = 'cursor-1'
  failures = 0

  async getQr(): Promise<WeixinQr> { return { ...this.qrResponse } }
  async pollQr(_qrcode: string, _baseUrl: string, signal: AbortSignal): Promise<WeixinQrStatus> {
    await new Promise((resolve) => setTimeout(resolve, 5))
    if (signal.aborted) throw signal.reason
    return this.statusSequence.shift() ?? { status: 'wait' }
  }
  async getUpdates(_credentials: WeixinCredentials, _cursor: string, signal: AbortSignal): Promise<WeixinUpdates> {
    if (this.failures-- > 0) throw new Error('temporary outage')
    await new Promise((resolve) => setTimeout(resolve, 2))
    if (signal.aborted) throw signal.reason
    const msgs = this.incoming.splice(0)
    return { msgs, get_updates_buf: this.cursor, longpolling_timeout_ms: 35000 }
  }
  async sendText(creds: WeixinCredentials, text: string, token: string): Promise<void> { this.sent.push({ text, token }) }
}

function incoming(text: string, contextToken = 'ctx-1'): WeixinMessage {
  return { message_id: Math.floor(Math.random() * 1e9), from_user_id: credentials.userId, to_user_id: credentials.botId,
    message_type: 1, message_state: 2, create_time_ms: Date.now(), context_token: contextToken,
    item_list: [{ type: 1, text_item: { text } }] }
}

async function bind(transport: FakeTransport) {
  const saved: WeixinSaved[] = []
  const workspace = { id: 'workspace-1', name: 'demo', agents: [{ id: 'agent-1', name: 'main', role: 'main', status: 'running', model: 'm' }], pendingCount: 0 }
  const bridge = new WeixinBridge({
    saved: undefined, transport,
    persist: async (value) => { saved.push(value) },
    workspace: () => workspace,
    command: () => '已发送',
    redact: (text) => text,
    changed: () => {}, pollIntervalMs: 2, notificationDelayMs: 1, loginTtlMs: 10_000,
  })
  await bridge.beginLogin()
  for (let i = 0; i < 20 && bridge.status().phase !== 'confirm'; i++) await new Promise((resolve) => setTimeout(resolve, 5))
  await bridge.confirm(bridge.status().login!.id)
  return { bridge, saved, workspace }
}

describe('weixin bridge — binding lifecycle', () => {
  it('requires a desktop confirmation step after the phone confirms', async () => {
    const transport = new FakeTransport()
    const { bridge, saved } = await bind(transport)
    const status = bridge.status()
    expect(status.phase).toBe('connected')
    expect(status.bound).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.credentials).toEqual(credentials)
    expect(status.login).toBeUndefined()
    expect(status.userLabel).toContain('…')
    bridge.start()
    expect(status.available).toBe(true)
    await bridge.close()
  })

  it('keeps an unconfirmed login isolated from saved credentials', async () => {
    const transport = new FakeTransport()
    const saved: WeixinSaved[] = []
    const bridge = new WeixinBridge({
      saved: undefined, transport,
      persist: async (value) => { saved.push(value) },
      workspace: () => ({ id: 'w', name: 'w', agents: [], pendingCount: 0 }),
      command: () => '', redact: (text) => text, changed: () => {},
    })
    await bridge.beginLogin()
    expect(saved).toHaveLength(0)
    expect(bridge.status().phase).toBe('qr')
    const loginId = bridge.status().login!.id
    await expect(bridge.confirm('wrong-id')).rejects.toBeInstanceOf(WeixinBridgeError)
    expect(bridge.cancel(loginId).phase).toBe('unbound')
    await bridge.close()
  })

  it('ignores messages from other weixin users and replayed deliveries', async () => {
    const transport = new FakeTransport()
    const { bridge } = await bind(transport)
    bridge.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const other = incoming('状态', 'ctx-other'); other.from_user_id = 'someone-else'
    const first = incoming('状态')
    transport.incoming.push(other, first, { ...first })
    for (let i = 0; i < 40 && transport.sent.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.text).toContain('demo')
    await bridge.close()
  })

  it('rejects phone task control until the workspace is confirmed', async () => {
    const transport = new FakeTransport()
    const { bridge, workspace } = await bind(transport)
    try {
      bridge.start()
      transport.incoming.push(incoming('任务 修好它'))
      await vi.waitFor(() => { expect(transport.sent.at(-1)?.text).toContain('只读连接') }, { timeout: 1000, interval: 5 })
      await bridge.configure({ allowControl: true })
      transport.incoming.push(incoming(`连接 ${code(workspace.id)}`))
      await vi.waitFor(() => { expect(transport.sent.at(-1)?.text).toContain('手机控制已确认') }, { timeout: 1000, interval: 5 })
      transport.incoming.push(incoming('任务 修好它'))
      await vi.waitFor(() => { expect(transport.sent.at(-1)?.text).toContain('已发送') }, { timeout: 1000, interval: 5 })
    } finally { await bridge.close() }
  })

  it('disconnect wipes credentials and stops notifications', async () => {
    const transport = new FakeTransport()
    const { bridge } = await bind(transport)
    bridge.start()
    await new Promise((resolve) => setTimeout(resolve, 5))
    await bridge.disconnect()
    const status = bridge.status()
    expect(status.phase).toBe('unbound')
    expect(status.bound).toBe(false)
    transport.sent.length = 0
    bridge.observe({ type: 'ui/turn/start', agentId: 'agent-1' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(transport.sent).toHaveLength(0)
    await bridge.close()
  })

  it('reconnects after an outage without resending phone tasks', async () => {
    const transport = new FakeTransport()
    const { bridge } = await bind(transport)
    transport.failures = 1
    bridge.start()
    for (let i = 0; i < 100 && bridge.status().phase !== 'reconnecting'; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    for (let i = 0; i < 600 && bridge.status().phase !== 'connected'; i++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(bridge.status().phase).toBe('connected')
    await bridge.close()
  }, 15000)

  it('observes progress but filters thinking and raw tool output', async () => {
    const transport = new FakeTransport()
    const { bridge } = await bind(transport)
    await bridge.configure({ notifications: true })
    bridge.start()
    transport.incoming.push(incoming('状态'))
    for (let i = 0; i < 60 && !bridge.status().lastSeenAt; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    bridge.observe({ type: 'ui/thinking', agentId: 'agent-1', delta: 'secret reasoning' })
    bridge.observe({ type: 'ui/turn/start', agentId: 'agent-1' })
    bridge.observe({ type: 'ui/tool/call', agentId: 'agent-1', sessionId: 's', callId: 'c', name: 'write', argsRaw: '{"path":"/etc/passwd"}' })
    bridge.observe({ type: 'ui/tool/result', agentId: 'agent-1', sessionId: 's', callId: 'c', name: 'write', output: 'raw output content' })
    bridge.observe({ type: 'ui/turn/end', agentId: 'agent-1', output: '最终答复' })
    for (let i = 0; i < 60 && transport.sent.filter(line => line.text.includes('main')).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    const lines = transport.sent.map(line => line.text).join('\n')
    expect(lines).toContain('最终答复')
    expect(lines).not.toContain('secret reasoning')
    expect(lines).not.toContain('/etc/passwd')
    expect(lines).not.toContain('raw output content')
    await bridge.close()
  })

  it('parses saved settings defensively', () => {
    expect(() => parseWeixinSaved({ enabled: 'yes' })).toThrow()
    expect(parseWeixinSaved({ enabled: true, allowControl: false, notifications: true, credentials })).toEqual(
      { enabled: true, allowControl: false, notifications: true, credentials })
  })
})
