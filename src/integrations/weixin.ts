import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import QRCode from 'qrcode'
import {
  WEIXIN_BASE_URL, WeixinApiError, WeixinClient, validateWeixinBaseUrl, validateWeixinCredentials,
  type WeixinCredentials, type WeixinMessage, type WeixinTransport,
} from './weixin-client.js'

export interface WeixinSaved {
  enabled: boolean
  allowControl: boolean
  notifications: boolean
  credentials?: WeixinCredentials
}

export interface WeixinWorkspace {
  id: string
  name: string
  agents: Array<{ id: string; name: string; role: string; status: string; model: string }>
  pendingCount: number
}

export interface WeixinStatus {
  available: true
  phase: 'unbound' | 'qr' | 'scanned' | 'verify' | 'confirm' | 'connected' | 'paused' | 'reconnecting' | 'expired' | 'error'
  enabled: boolean
  bound: boolean
  allowControl: boolean
  notifications: boolean
  message: string
  userLabel?: string
  botLabel?: string
  login?: { id: string; qrDataUrl?: string; expiresAt: number }
  lastSeenAt?: number
  lastNotificationAt?: number
  activity: Array<{ at: number; text: string }>
}

export interface WeixinBridgeOptions {
  saved?: WeixinSaved
  transport?: WeixinTransport
  persist(value: WeixinSaved): Promise<void>
  workspace(): WeixinWorkspace
  command(action: { type: 'task' | 'stop'; text?: string; agentId?: string; workspaceId: string }): string
  redact(text: string): string
  changed(state: WeixinStatus): void
  pollIntervalMs?: number
  notificationDelayMs?: number
  loginTtlMs?: number
}

export class WeixinBridgeError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function parseWeixinSaved(value: unknown): WeixinSaved {
  if (value === undefined || value === null) return { enabled: false, allowControl: false, notifications: true }
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid Weixin settings')
  const row = value as Record<string, unknown>
  for (const key of ['enabled', 'allowControl', 'notifications']) {
    if (typeof row[key] !== 'boolean') throw new Error('invalid Weixin settings')
  }
  const credentials = row.credentials == null ? undefined : validateWeixinCredentials(row.credentials)
  return { enabled: !!credentials && row.enabled as boolean, allowControl: row.allowControl as boolean,
    notifications: row.notifications as boolean, ...(credentials ? { credentials } : {}) }
}

function masked(value: string): string { return value.length > 8 ? `${value.slice(0, 3)}…${value.slice(-4)}` : '已绑定账号' }
function workspaceCode(id: string): string { return createHash('sha256').update(id).digest('hex').slice(0, 6) }

export class WeixinBridge {
  private saved: WeixinSaved
  private readonly transport: WeixinTransport
  private phase: WeixinStatus['phase']
  private message: string
  private login?: {
    id: string; qrcode: string; qrDataUrl?: string; expiresAt: number; baseUrl: string
    controller: AbortController; timer: NodeJS.Timeout; candidate?: WeixinCredentials; code?: string
  }
  private worker?: { controller: AbortController; task: Promise<void> }
  private readonly tasks = new Set<Promise<void>>()
  private closed = false
  private changing = false
  private contextToken = ''
  private phoneWorkspace = ''
  private liveSince = Date.now()
  private cursor = ''
  private lastSeenAt?: number
  private lastNotificationAt?: number
  private readonly seen = new Set<string>()
  private activity: Array<{ at: number; text: string }> = []
  private buffered: string[] = []
  private notificationTimer?: NodeJS.Timeout
  private sending: Promise<void> = Promise.resolve()
  private queuedSends = 0
  private sendGeneration = 0
  private sendController = new AbortController()
  private receiveWindow = { start: Date.now(), count: 0 }
  private readonly activeTools = new Map<string, string>()

  constructor(private readonly options: WeixinBridgeOptions) {
    this.saved = parseWeixinSaved(options.saved)
    this.transport = options.transport ?? new WeixinClient()
    this.phase = this.saved.credentials ? (this.saved.enabled ? 'reconnecting' : 'paused') : 'unbound'
    this.message = this.saved.credentials ? '微信连接已保存；发送“状态”查看当前工作区。' : '尚未绑定微信。扫码后还需在此确认绑定。'
  }

  status(): WeixinStatus {
    const credentials = this.login?.candidate ?? this.saved.credentials
    return {
      available: true, phase: this.phase, enabled: this.saved.enabled, bound: !!this.saved.credentials,
      allowControl: this.saved.allowControl, notifications: this.saved.notifications, message: this.message,
      ...(credentials ? { userLabel: masked(credentials.userId), botLabel: masked(credentials.botId) } : {}),
      ...(this.login ? { login: { id: this.login.id, qrDataUrl: this.login.qrDataUrl, expiresAt: this.login.expiresAt } } : {}),
      lastSeenAt: this.lastSeenAt, lastNotificationAt: this.lastNotificationAt,
      activity: this.activity.map(row => ({ ...row })),
    }
  }

  start(): void { if (this.saved.enabled && this.saved.credentials && !this.closed) this.startWorker() }
  private publish(): void { if (!this.closed) this.options.changed(this.status()) }
  private track(task: Promise<void>): void {
    const handled = task.catch(() => {}).finally(() => this.tasks.delete(handled))
    this.tasks.add(handled)
  }
  private check(): void { if (this.closed) throw new WeixinBridgeError('微信连接已关闭', 503) }
  private clearLogin(): void {
    if (!this.login) return
    clearTimeout(this.login.timer)
    this.login.controller.abort()
    this.login = undefined
  }
  private invalidateSends(): void {
    this.sendGeneration++
    this.sendController.abort()
    this.sendController = new AbortController()
    clearTimeout(this.notificationTimer)
    this.notificationTimer = undefined
    this.buffered = []
  }
  private stopWorker(): void {
    this.worker?.controller.abort()
    this.worker = undefined
    this.contextToken = ''
    this.phoneWorkspace = ''
    this.invalidateSends()
  }

  async beginLogin(): Promise<WeixinStatus> {
    this.check()
    if (this.changing) throw new WeixinBridgeError('正在保存微信设置，请稍后重试', 409)
    if (this.saved.credentials && this.phase !== 'expired' && this.phase !== 'error') {
      throw new WeixinBridgeError('请先解除已有绑定，再连接另一个微信号', 409)
    }
    this.clearLogin()
    this.stopWorker()
    const controller = new AbortController()
    const expiresAt = Date.now() + (this.options.loginTtlMs ?? 5 * 60_000)
    const id = randomUUID()
    const timer = setTimeout(() => {
      if (this.login?.id !== id) return
      this.clearLogin()
      this.phase = 'expired'
      this.message = '二维码已过期，请点击重新扫码。'
      this.publish()
    }, Math.max(1, expiresAt - Date.now()))
    timer.unref()
    this.login = { id, qrcode: '', expiresAt, baseUrl: WEIXIN_BASE_URL, controller, timer }
    this.phase = 'qr'
    this.message = '正在获取微信二维码…'
    this.publish()
    try {
      const qr = await this.transport.getQr(controller.signal, this.saved.credentials ? [this.saved.credentials.botToken] : [])
      const svg = await QRCode.toString(qr.content, { type: 'svg', margin: 4, width: 260, errorCorrectionLevel: 'M' })
      if (this.login?.id !== id || controller.signal.aborted) throw new WeixinBridgeError('本次扫码已取消', 409)
      this.login.qrcode = qr.qrcode
      this.login.qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
      this.message = '请用手机微信扫一扫，按手机提示确认连接。'
      this.publish()
      this.track(this.pollLogin(id))
      return this.status()
    } catch (error) {
      if (this.login?.id === id) {
        this.clearLogin()
        this.phase = 'error'
        this.message = '获取二维码失败，请检查网络后重新扫码。'
        this.publish()
      }
      throw new WeixinBridgeError(error instanceof WeixinBridgeError ? error.message : '无法获取微信二维码，请稍后重试', 502)
    }
  }

  private async pollLogin(id: string): Promise<void> {
    let failures = 0
    let redirects = 0
    while (!this.closed && this.login?.id === id && !this.login.controller.signal.aborted) {
      const current = this.login
      if (current.candidate) return
      if (this.phase === 'verify' && !current.code) {
        await delay(this.options.pollIntervalMs ?? 900, undefined, { signal: current.controller.signal })
        continue
      }
      try {
        const code = current.code
        current.code = undefined
        const result = await this.transport.pollQr(current.qrcode, current.baseUrl, current.controller.signal, code)
        if (this.login !== current || current.controller.signal.aborted) return
        failures = 0
        switch (result.status) {
          case 'wait': break
          case 'scaned': this.phase = 'scanned'; this.message = '已扫码，请在微信完成确认。'; break
          case 'need_verifycode': this.phase = 'verify'; this.message = '请输入手机微信显示的配对验证码。'; break
          case 'confirmed': {
            current.candidate = validateWeixinCredentials({ botToken: result.bot_token, botId: result.ilink_bot_id,
              userId: result.ilink_user_id, baseUrl: result.baseurl || current.baseUrl })
            current.qrDataUrl = undefined
            this.phase = 'confirm'
            this.message = '微信已确认。核对账号后点击“确认绑定”，工作状态将发送给这个微信号。'
            this.publish()
            return
          }
          case 'scaned_but_redirect': {
            if (!result.redirect_host || ++redirects > 3) throw new Error('invalid QR redirect')
            current.baseUrl = validateWeixinBaseUrl(result.redirect_host.includes('://') ? result.redirect_host : `https://${result.redirect_host}`)
            break
          }
          case 'binded_redirect':
            this.clearLogin(); this.phase = 'error'; this.message = '这个机器人已被绑定，请使用已有连接或在微信解除旧绑定后重试。'; this.publish(); return
          case 'expired':
          case 'verify_code_blocked':
            this.clearLogin(); this.phase = 'expired'; this.message = '二维码已过期或验证码尝试次数过多，请重新扫码。'; this.publish(); return
          default: throw new Error('unsupported QR status')
        }
        this.publish()
        await delay(this.options.pollIntervalMs ?? 900, undefined, { signal: current.controller.signal })
      } catch {
        if (current.controller.signal.aborted || this.login !== current) return
        if (++failures >= 5) {
          this.clearLogin(); this.phase = 'error'; this.message = '微信扫码服务暂时不可用，请稍后重新扫码。'; this.publish(); return
        }
        await delay(Math.min(5000, failures * 1000), undefined, { signal: current.controller.signal })
      }
    }
  }

  verify(loginId: string, code: string): WeixinStatus {
    this.check()
    if (this.login?.id !== loginId || this.phase !== 'verify') throw new WeixinBridgeError('本次验证已失效，请重新扫码', 409)
    if (!/^\d{4,12}$/.test(code)) throw new WeixinBridgeError('请输入手机显示的 4–12 位数字验证码')
    this.login.code = code
    this.message = '正在验证配对码…'
    this.publish()
    return this.status()
  }

  cancel(loginId: string): WeixinStatus {
    this.check()
    if (this.changing) throw new WeixinBridgeError('正在保存绑定，请稍后重试', 409)
    if (!this.login || this.login.id !== loginId) throw new WeixinBridgeError('二维码会话已失效', 409)
    this.clearLogin()
    this.phase = this.saved.credentials ? 'paused' : 'unbound'
    this.message = '已取消扫码。'
    this.publish()
    return this.status()
  }

  private async save(value: WeixinSaved): Promise<void> {
    this.check()
    if (this.changing) throw new WeixinBridgeError('正在保存微信设置，请稍后重试', 409)
    this.changing = true
    try {
      await this.options.persist(value)
      this.check()
      this.saved = value
    } catch (error) {
      if (error instanceof WeixinBridgeError) throw error
      throw new WeixinBridgeError('微信设置未能安全保存，未启用新的绑定或权限', 500)
    } finally { this.changing = false }
  }

  async confirm(loginId: string): Promise<WeixinStatus> {
    const current = this.login
    if (!current || current.id !== loginId || !current.candidate || this.phase !== 'confirm' || Date.now() >= current.expiresAt) {
      throw new WeixinBridgeError('扫码确认已失效，请重新扫码', 409)
    }
    await this.save({ enabled: true, allowControl: false, notifications: true, credentials: current.candidate })
    this.clearLogin()
    this.seen.clear()
    this.cursor = ''
    this.phase = 'connected'
    this.message = '已绑定。请在微信给机器人发送“状态”，建立回复通道。'
    this.startWorker()
    this.publish()
    return this.status()
  }

  async configure(patch: { enabled?: boolean; allowControl?: boolean; notifications?: boolean }): Promise<WeixinStatus> {
    if (this.login) throw new WeixinBridgeError('请先完成或取消扫码绑定', 409)
    for (const value of Object.values(patch)) if (typeof value !== 'boolean') throw new WeixinBridgeError('微信设置必须为布尔值')
    if (!this.saved.credentials) throw new WeixinBridgeError('请先扫码绑定微信', 409)
    if (patch.enabled === true && this.phase === 'expired') throw new WeixinBridgeError('微信凭据已失效，请重新扫码', 409)
    const previous = this.saved
    await this.save({ ...this.saved, ...patch })
    if (!this.saved.enabled) {
      this.stopWorker(); this.phase = 'paused'; this.message = '微信连接已暂停，不再收发工作区消息。'
    } else {
      if (!previous.enabled) this.startWorker()
      if (previous.allowControl !== this.saved.allowControl) { this.phoneWorkspace = ''; this.invalidateSends() }
      if (!this.saved.notifications) { clearTimeout(this.notificationTimer); this.notificationTimer = undefined; this.buffered = [] }
      this.message = this.saved.allowControl ? '已允许手机任务控制；仍使用本机审批策略。手机先发送“状态”并确认工作区。' : '只读模式：可查询状态，不接受手机发任务或停止任务。'
    }
    this.publish()
    return this.status()
  }

  async disconnect(): Promise<WeixinStatus> {
    this.check()
    this.clearLogin()
    this.stopWorker()
    try { await this.save({ enabled: false, allowControl: false, notifications: true }) }
    catch (error) {
      this.phase = 'error'; this.message = '已停止本次连接，但未能清除磁盘绑定。请重试解除绑定。'; this.publish(); throw error
    }
    this.activity = []; this.activeTools.clear(); this.seen.clear(); this.cursor = ''
    this.lastSeenAt = undefined; this.lastNotificationAt = undefined
    this.phase = 'unbound'; this.message = '已解除本机绑定并清除保存的微信凭据。微信端机器人可在手机中自行移除。'
    this.publish()
    return this.status()
  }

  private startWorker(): void {
    if (this.closed || this.worker || !this.saved.credentials || !this.saved.enabled) return
    this.liveSince = Date.now()
    this.phoneWorkspace = ''
    const controller = new AbortController()
    const task = this.receive(controller.signal)
    this.worker = { controller, task }
    this.track(task)
  }

  private async receive(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted && !this.closed && this.saved.enabled && this.saved.credentials) {
      const scope = this.options.workspace().id
      try {
        const result = await this.transport.getUpdates(this.saved.credentials, this.cursor, signal)
        if (signal.aborted || this.closed) return
        failures = 0
        this.phase = 'connected'
        this.message = '微信连接已就绪；发送“状态”查看当前工作区。'
        if (result.get_updates_buf) this.cursor = result.get_updates_buf
        for (const message of result.msgs ?? []) {
          if (signal.aborted) return
          this.handleIncoming(message, scope)
        }
        this.publish()
        await delay(this.options.pollIntervalMs ?? 800, undefined, { signal })
      } catch (error) {
        if (signal.aborted || this.closed) return
        if (error instanceof WeixinApiError && error.expired) {
          this.stopWorker(); this.phase = 'expired'; this.message = '微信登录已失效，请重新扫码绑定。'; this.publish(); return
        }
        failures++
        this.phase = 'reconnecting'
        this.message = '微信连接暂时中断，正在退避重连；不会重发手机任务。'
        this.publish()
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), undefined, { signal })
      }
    }
  }

  private safe(text: string, max = 1600): string {
    let value = this.options.redact(String(text))
    for (const secret of [this.saved.credentials?.botToken, this.contextToken]) if (secret) value = value.split(secret).join('[已隐藏]')
    value = value.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+)/gi, '[凭据已隐藏]')
      .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, '$1[已隐藏]')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    return value.length > max ? value.slice(0, max) + '\n…更多内容请在电脑查看。' : value
  }

  private handleIncoming(message: WeixinMessage, polledWorkspace: string): void {
    const credentials = this.saved.credentials
    if (!credentials || !message || message.from_user_id !== credentials.userId || message.message_type !== 1 ||
      message.message_state !== 2 || message.group_id || (message.to_user_id && message.to_user_id !== credentials.botId)) return
    const identity = message.message_id ?? message.client_id ?? message.seq
    if (identity === undefined) return
    const key = `${credentials.botId}:${identity}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    if (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
    if (typeof message.create_time_ms !== 'number' || message.create_time_ms < this.liveSince ||
      message.create_time_ms > Date.now() + 30_000 || Date.now() - message.create_time_ms > 120_000) return
    if (typeof message.context_token !== 'string' || !message.context_token || message.context_token.length > 8192) return
    this.contextToken = message.context_token
    this.lastSeenAt = Date.now()
    if (Date.now() - this.receiveWindow.start > 60_000) this.receiveWindow = { start: Date.now(), count: 0 }
    if (++this.receiveWindow.count > 20) return
    const text = (message.item_list ?? []).filter(item => item.type === 1 && typeof item.text_item?.text === 'string')
      .map(item => item.text_item!.text).join('\n').trim()
    if (!text || text.length > 8000) { this.reply('目前支持文字消息，请发送“帮助”查看命令。'); return }
    const workspace = this.options.workspace()
    if (workspace.id !== polledWorkspace) {
      this.reply('电脑上的工作区已切换，请发送“状态”重新核对。'); return
    }
    const code = workspaceCode(workspace.id)
    if (/^(?:状态|工作区|\/status)$/i.test(text)) {
      const active = workspace.agents.filter(agent => agent.status === 'running').length
      this.reply(`SakuraCode · ${workspace.name}\n${active} 个 Agent 正在运行，共 ${workspace.agents.length} 个成员\n等待确认：${workspace.pendingCount} 项\n手机权限：${this.saved.allowControl ? '允许发任务（保留本机审批）' : '只读'}\n${this.saved.allowControl ? `执行前发送“连接 ${code}”确认当前工作区。\n` : ''}发送“成员”或“进度”查看详情。`)
    } else if (/^(?:成员|智能体|\/agents)$/i.test(text)) {
      const labels: Record<string, string> = { idle: '空闲', running: '工作中', done: '已完成', error: '失败' }
      this.reply(`${workspace.name} · Agent 列表\n` + workspace.agents.slice(0, 24).map(agent =>
        `${agent.id} · ${agent.name} · ${labels[agent.status] ?? agent.status}${agent.role === 'main' ? '（主 Agent）' : ''}`).join('\n'))
    } else if (/^(?:进度|\/progress)$/i.test(text)) {
      this.reply(`${workspace.name} · 最近进度\n` + (this.activity.slice(-10).map(row => row.text).join('\n') || '暂无新工作事件。任务开始后会在这里显示。'))
    } else if (/^(?:帮助|help|\/help)$/i.test(text)) {
      this.reply('SakuraCode 微信助手\n状态：当前工作区和待审批数量\n成员：主 Agent 与协作成员\n进度：最近工作步骤\n连接 <工作区码>：确认手机控制的工作区\n任务 <内容>：向主 Agent 发任务\n任务 @agent-id <内容>：给指定成员发任务\n停止 [agent-id]：只停止当前回合，不清空排队\n控制需先在电脑开启；审批、问答和计划确认仍在电脑完成。')
    } else if (/^(?:连接|\/use)\s+/i.test(text)) {
      if (!this.saved.allowControl) this.reply('当前为只读连接，请在电脑微信设置中允许手机任务控制。')
      else if (text.split(/\s+/)[1]?.toLowerCase() !== code) this.reply('工作区码不匹配，请发送“状态”核对最新工作区。')
      else { this.phoneWorkspace = workspace.id; this.reply(`手机控制已确认：${workspace.name}。可以发送“任务 <内容>”。`) }
    } else {
      const task = text.match(/^(?:任务|\/task)\s+(?:@(agent-[\w-]+)\s+)?([\s\S]+)$/i)
      const stop = text.match(/^(?:停止|\/stop)(?:\s+(agent-[\w-]+))?$/i)
      if (!task && !stop) { this.reply('请发送“帮助”查看命令。发任务请使用“任务 <内容>”，避免把聊天误当作本机指令。'); return }
      if (!this.saved.allowControl) { this.reply('当前为只读连接，没有执行任务。请先在电脑允许手机任务控制。'); return }
      if (this.phoneWorkspace !== workspace.id) { this.reply(`尚未确认当前工作区，没有执行任务。发送“连接 ${code}”确认 ${workspace.name}。`); return }
      try {
        const result = this.options.command(task ? { type: 'task', text: task[2]!, agentId: task[1], workspaceId: workspace.id }
          : { type: 'stop', agentId: stop?.[1], workspaceId: workspace.id })
        this.reply(result)
      } catch { this.reply('操作未执行：工作区忙、成员已变化或正在切换设置。请发送“状态”核对后重试。') }
    }
  }

  private reply(text: string): void {
    if (!this.saved.enabled || !this.saved.credentials || !this.contextToken || this.closed || this.queuedSends >= 12) return
    const credentials = this.saved.credentials
    const context = this.contextToken
    const generation = this.sendGeneration
    const signal = this.sendController.signal
    const body = this.safe(text)
    this.queuedSends++
    this.sending = this.sending.catch(() => {}).then(async () => {
      if (generation !== this.sendGeneration || signal.aborted || this.closed || !this.saved.enabled) return
      try {
        await this.transport.sendText(credentials, body, context, `sakura-${randomUUID()}`, signal)
        if (generation !== this.sendGeneration) return
        this.lastNotificationAt = Date.now()
        this.publish()
      } catch (error) {
        if (signal.aborted || generation !== this.sendGeneration || this.closed) return
        if (error instanceof WeixinApiError && error.expired) {
          this.stopWorker(); this.phase = 'expired'; this.message = '微信登录已失效，请重新扫码绑定。'
        } else {
          this.message = '一条微信通知未送达，未自动重发；请在微信发送“状态”刷新回复通道。'
        }
        this.publish()
      }
    }).finally(() => { this.queuedSends-- })
  }

  observe(event: Record<string, unknown>): void {
    if (this.closed || !this.saved.enabled || !this.saved.credentials) return
    const type = event.type
    if (type === 'state' || type === 'weixin/state' || type === 'ui/thinking' || type === 'ui/text') return
    const workspace = this.options.workspace()
    const agent = workspace.agents.find(row => row.id === event.agentId)
    const label = this.safe(agent?.name || String(event.agentId || 'Agent'), 60)
    let text = ''
    const toolKey = JSON.stringify([event.sessionId, event.agentId, event.callId])
    if (type === 'ui/turn/start') text = `${label} 开始工作`
    else if (type === 'ui/tool/call') {
      const name = this.safe(String(event.name || '工具'), 60)
      this.activeTools.set(toolKey, name)
      if (this.activeTools.size > 256) this.activeTools.delete(this.activeTools.keys().next().value!)
      text = `${label} 正在执行 ${name}`
    } else if (type === 'ui/tool/result') {
      const name = this.activeTools.get(toolKey) || this.safe(String(event.name || '工具'), 60)
      this.activeTools.delete(toolKey)
      text = `${label} · ${name}${event.isError ? ' 执行失败' : ' 已完成'}`
    } else if (type === 'ui/turn/end') {
      text = `${label}${event.cancelled ? ' 已停止当前回合' : event.error ? ' 工作失败，请在电脑查看错误' : ' 工作完成'}`
      if (!event.error && !event.cancelled && typeof event.output === 'string' && event.output.trim()) text += '\n' + this.safe(event.output, 1000)
    } else if (type === 'approval/request' || type === 'interaction/request' || type === 'plan/propose') {
      text = `${label} 等待${type === 'approval/request' ? '工具审批' : type === 'plan/propose' ? '计划确认' : '问题回答'}，请回到电脑处理（微信不会自动批准）。`
    } else if (type === 'compaction/done') text = '上下文压缩已完成'
    else if (type === 'ui/todos') {
      const todos = Array.isArray(event.todos) ? event.todos : []
      if (todos.length) text = `任务清单：${todos.filter(row => row?.status === 'completed').length}/${todos.length} 已完成`
    }
    if (!text) return
    text = this.safe(text)
    this.activity.push({ at: Date.now(), text })
    this.activity = this.activity.slice(-30)
    this.publish()
    if (!this.saved.notifications || !this.contextToken) return
    this.buffered.push(text)
    if (this.buffered.length > 12) this.buffered.splice(0, this.buffered.length - 12)
    if (!this.notificationTimer) {
      this.notificationTimer = setTimeout(() => {
        this.notificationTimer = undefined
        const lines = this.buffered.splice(0)
        if (lines.length && this.saved.notifications) this.reply(`SakuraCode · ${workspace.name}\n${lines.join('\n')}`)
      }, this.options.notificationDelayMs ?? 5000)
      this.notificationTimer.unref()
    }
  }

  workspaceChanged(): void {
    this.clearLogin()
    this.phoneWorkspace = ''
    this.liveSince = Date.now()
    this.invalidateSends()
    this.activity = []
    this.activeTools.clear()
    if (this.saved.credentials && this.saved.enabled) {
      this.message = '工作区已切换，手机发任务前需重新确认工作区；连接仍保持。'
      if (this.saved.notifications) this.reply('电脑上的工作区已切换，请发送“状态”查看。手机任务控制需重新确认。')
    } else if (!this.saved.credentials) { this.phase = 'unbound'; this.message = '工作区已切换；尚未绑定微信。' }
    this.publish()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearLogin()
    this.stopWorker()
    await Promise.allSettled([...this.tasks, this.sending])
  }
}
