/** Authenticated dashboard workflows in real Chrome/Edge, including a second browser. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import type { InteractionService } from '../src/plugins/ask-user.js'
import type { PlanService } from '../src/tools/plan.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { BrowserClient } from './browser-client.js'

const OPERATOR = 'remote-browser-operator-' + 'a'.repeat(40)
const VIEWER = 'remote-browser-viewer-' + 'b'.repeat(40)
const browserSuite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip

class RemoteAdapter implements ModelAdapter {
  id = 'remote-model'
  defaultModel = 'remote-chat'
  requests: LLMRequest[] = []
  finish: (() => void) | undefined

  async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    this.requests.push(req)
    const message = String([...req.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '')
    if (message.includes('[slow]')) {
      yield { type: 'text', delta: '开始检查，' }
      await new Promise<void>((resolve) => {
        const done = () => { req.signal?.removeEventListener('abort', done); resolve() }
        this.finish = done
        if (req.signal?.aborted) done()
        else req.signal?.addEventListener('abort', done, { once: true })
      })
    }
    yield { type: 'text', delta: '远端完成：' + message }
    yield { type: 'done', reason: 'stop' }
  }
}

browserSuite('remote dashboard — real browser', () => {
  const browser = new BrowserClient()
  let server: WebServerHandle
  let workspace = ''
  let adapter: RemoteAdapter

  beforeAll(async () => { await browser.start() })
  afterAll(async () => { await browser.close() })
  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-remote-ui-'))
    adapter = new RemoteAdapter()
    server = await runWebServer({ cwd: workspace, adapter, host: '0.0.0.0', token: OPERATOR, viewerToken: VIEWER, open: false, quiet: true })
    browser.errors.length = 0
    await browser.resize(1440)
    await browser.navigate(server.url + 'dashboard')
    await browser.waitFor("document.getElementById('authDialog')?.open")
  })
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
    await browser.navigate('about:blank')
    adapter.finish?.()
    await server.close()
    await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })

  async function login(client = browser, token = OPERATOR): Promise<void> {
    await client.fill('#authToken', token)
    await client.click('#authSubmit')
    await client.waitFor("!document.getElementById('authDialog').open && document.getElementById('connectionLabel').textContent === '远端服务已连接'")
    await client.waitFor("document.querySelectorAll('#dashboardAgents .dashboard-agent').length >= 1")
  }

  async function snapshot(name: string): Promise<void> {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }

  it('keeps data behind login, accepts an operator, persists only an HttpOnly session and logs out cleanly', async () => {
    expect(await browser.evaluate("document.querySelectorAll('.agent-row').length")).toBe(0)
    expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(true)
    await browser.fill('#authToken', 'invalid-' + 'x'.repeat(40))
    await browser.click('#authSubmit')
    await browser.waitFor("document.getElementById('authError').textContent.includes('不正确')")
    await login()
    expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(false)
    expect(await browser.evaluate("document.getElementById('authToken').value")).toBe('')
    expect(await browser.evaluate('document.cookie')).not.toContain('sakura_session')
    const storage = await browser.evaluate<string>('JSON.stringify({local: {...localStorage}, session: {...sessionStorage}, url: location.href})')
    expect(storage).not.toContain(OPERATOR)
    expect(storage).not.toContain(VIEWER)
    await browser.click('#chatViewBtn')
    await browser.fill('#input', '检查远端工作区')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('远端完成：检查远端工作区')")
    await browser.reload()
    await browser.waitFor("!document.getElementById('authDialog').open && document.getElementById('connectionLabel').textContent === '远端服务已连接'")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('检查远端工作区')")
    await browser.click('#logoutBtn')
    await browser.waitFor("document.getElementById('authDialog').open")
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('检查远端工作区')
    expect(await browser.evaluate("document.querySelectorAll('.agent-row').length")).toBe(0)
    expect(await browser.evaluate("fetch('/api/state').then(res => res.status)")).toBe(401)
  })

  it('renders a responsive viewer dashboard and reads history without switching the live session', async () => {
    await server.harness.run('较早的会话')
    const oldId = server.harness.main().sessionId
    const current = await server.harness.ctx.sessions.create()
    server.harness.main({ resumeSessionId: current.id })
    await server.harness.run('当前协作会话')
    const ctx = server.harness.ctx
    ctx.agents.spawn({ name: '只读审查员', seed: '', autoStart: false, meta: { role: 'sub', description: '<img src=x onerror=alert(1)> 检查模块边界' } })
    const tc = { agentId: server.harness.main().id, sessionId: current.id, signal: new AbortController().signal }
    await ctx.tools.execute('dashboard-todos', 'todo_write', JSON.stringify({ todos: [
      { content: '梳理架构', status: 'completed', priority: 'high' },
      { content: '验证远端访问', status: 'in_progress', priority: 'high' },
      { content: '整理交付说明', status: 'pending', priority: 'medium' },
    ] }), tc)
    await login(browser, VIEWER)
    expect(await browser.evaluate("document.getElementById('dashboardRole').textContent")).toContain('只读访客')
    expect(await browser.evaluate("['input', 'sendBtn', 'newSessionBtn', 'spawnBtn', 'modelSel', 'approvalSelBottom'].every(id => document.getElementById(id).disabled)")).toBe(true)
    expect(await browser.evaluate("document.querySelectorAll('#dashboardAgents img').length")).toBe(0)
    expect(await browser.evaluate("document.getElementById('dashTasks').textContent")).toBe('1/3')
    expect(await browser.evaluate("document.querySelectorAll('#taskBoard .task-card').length")).toBe(3)
    expect(await browser.evaluate("[...document.querySelectorAll('#dashboardAgents button')].every(button => button.disabled)")).toBe(true)
    expect(await browser.evaluate("fetch('/api/settings', {method:'POST',body:JSON.stringify({approvalMode:'yolo'})}).then(res => res.status)")).toBe(403)
    await snapshot('remote-dashboard-desktop')
    for (const width of [1280, 1024, 768, 390, 320]) {
      await browser.resize(width, 844)
      expect(await browser.evaluate('document.documentElement.scrollWidth === innerWidth'), `${width}px page`).toBe(true)
      expect(await browser.evaluate("document.getElementById('dashboard').scrollWidth <= document.getElementById('dashboard').clientWidth"), `${width}px dashboard`).toBe(true)
    }
    await browser.resize(390, 844)
    await snapshot('remote-dashboard-mobile')
    await browser.resize(1440)
    await browser.fill('#sessionSearch', '较早的会话')
    await browser.click('.session-open')
    await browser.waitFor("!document.getElementById('historyNotice').hidden && document.getElementById('chatCol').textContent.includes('较早的会话')")
    expect(server.harness.main().sessionId).toBe(current.id)
    expect(server.harness.main().sessionId).not.toBe(oldId)
    await browser.click('#returnLiveBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('当前协作会话')")
  })

  it('lets a viewer read an independent child session without changing the main session or roster', async () => {
    await server.harness.run('MAIN_SESSION_UNCHANGED')
    const mainId = server.harness.main().sessionId
    const child = server.harness.ctx.agents.spawn({ name: '独立审查员', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    await child.turn('READ_ONLY_CHILD_RECORDS')
    const roster = server.harness.ctx.agents.list().map(agent => agent.id)
    await login(browser, VIEWER)
    await browser.click('#chatViewBtn')
    await browser.click('#inspectorBtn')
    const selector = `[data-agent-id="${child.id}"] .agent-view`
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`)).toBe(false)
    await browser.click(selector)
    await browser.waitFor("document.getElementById('agentReaderBody').textContent.includes('READ_ONLY_CHILD_RECORDS')")
    expect(server.harness.main().sessionId).toBe(mainId)
    expect(server.harness.ctx.agents.list().map(agent => agent.id)).toEqual(roster)
    expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(true)
    await browser.click('#dashboardBtn')
    await browser.click('#logoutBtn')
    await browser.waitFor("document.getElementById('authDialog').open")
    expect(await browser.evaluate("document.getElementById('agentReader').hidden")).toBe(true)
    expect(await browser.evaluate("document.getElementById('agentReaderBody').textContent")).toBe('')
  })

  it('restores all pending cards after reload and synchronizes resolutions with a second browser', async () => {
    await server.harness.run('审批前的上下文')
    const ctx = server.harness.ctx
    const approval = ctx.approval.check({ tool: ctx.tools.get('write')!, args: { file_path: 'review.txt', content: 'review' }, agentId: server.harness.main().id })
    const question = ctx.peek<InteractionService>('interaction')!.ask({ question: '选择检查范围', options: ['全部', '核心'] })
    const plan = ctx.peek<PlanService>('plan')!.propose('先只读审查，再整理测试结果。')
    await login()
    await browser.waitFor("document.getElementById('dashPending').textContent === '3'")
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '远端服务已连接' && document.querySelectorAll('.approval-card').length === 1 && document.querySelectorAll('.ask-card').length === 1 && document.querySelectorAll('.plan-card').length === 1")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('审批前的上下文')")
    expect(await browser.evaluate("document.getElementById('dashPending').textContent")).toBe('3')
    await snapshot('remote-pending-dashboard')
    const observer = new BrowserClient()
    try {
      await observer.start()
      await observer.navigate(server.url + 'dashboard')
      await observer.waitFor("document.getElementById('authDialog')?.open")
      await login(observer, VIEWER)
      await observer.waitFor("document.getElementById('dashPending').textContent === '3'")
      expect(await observer.evaluate("[...document.querySelectorAll('.approval-card button, .ask-card button, .plan-card button')].every(button => button.disabled)")).toBe(true)
      await browser.click('#dashboardPending .pending-link')
      await browser.click('.approval-card .btn-accent')
      await browser.click('.ask-actions button')
      await browser.click('.plan-card .btn-soft')
      expect(await approval).toEqual({ allowed: true })
      expect((await question).answer).toBe('全部')
      expect((await plan).decision).toBe('reject')
      await observer.waitFor("document.getElementById('dashPending').textContent === '0'")
      await browser.waitFor("document.getElementById('approvalBanner').hidden")
      expect(observer.errors).toEqual([])
    } finally { await observer.close() }
  })

  it('restores a switched session before sending any new task, including after a reload', async () => {
    await server.harness.run('切回后应显示的历史')
    const oldId = server.harness.main().sessionId
    const current = await server.harness.ctx.sessions.create()
    server.harness.main({ resumeSessionId: current.id })
    await server.harness.run('另一个会话的历史')
    await login()
    await browser.fill('#sessionSearch', '切回后应显示的历史')
    await browser.click('.session-open')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('远端完成：切回后应显示的历史')")
    expect(server.harness.main().sessionId).toBe(oldId)
    expect(adapter.requests).toHaveLength(2)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '远端服务已连接'")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('远端完成：切回后应显示的历史')")
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('另一个会话的历史')
    expect(adapter.requests).toHaveLength(2)
  })

  it('recovers after an offline turn without resending it and restores outstanding requests', async () => {
    await login()
    await browser.click('#chatViewBtn')
    await browser.fill('#input', '[slow] 网络恢复检查')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('开始检查')")
    await browser.fill('#input', '保留这份未发送草稿')
    await browser.send('Network.enable')
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    server.server.closeAllConnections()
    await browser.waitFor("document.getElementById('connectionLabel').textContent.includes('断开') && document.getElementById('input').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留这份未发送草稿')
    adapter.finish?.()
    await server.harness.main().wait()
    const question = server.harness.ctx.peek<InteractionService>('interaction')!.ask({ question: '断线期间的新问题', options: ['继续', '暂停'] })
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '远端服务已连接'")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('远端完成：[slow] 网络恢复检查') && document.querySelectorAll('.ask-card').length === 1")
    expect(adapter.requests).toHaveLength(1)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留这份未发送草稿')
    expect(await browser.evaluate("document.querySelectorAll('.msg-user-row').length")).toBe(1)
    await browser.click('.ask-actions button')
    expect((await question).answer).toBe('继续')
    expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(false)
  })
})