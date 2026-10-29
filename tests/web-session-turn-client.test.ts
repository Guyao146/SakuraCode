/** Real isolated Chromium regressions for session status, replaceable notices, native viewport evidence and turn summaries. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ModelAdapter, TurnMetrics } from '../src/core/types.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { MockAdapter, text, toolCall } from './helpers.js'
import { BrowserClient } from './browser-client.js'

const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }

suite('session and turn refinements — real browser', () => {
  const browser = new BrowserClient(), directories: string[] = [], servers: WebServerHandle[] = [], releases: Array<() => void> = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    while (releases.length) releases.pop()!()
    const errors = [...browser.errors]
    await browser.navigate('about:blank')
    while (servers.length) await servers.pop()!.close()
    while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })
  async function boot(extra: Partial<WebServerOptions> = {}) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-session-turn-ui-')); directories.push(cwd)
    const server = await runWebServer({ cwd, adapter: new MockAdapter([text('DONE')]), open: false, quiet: true, updatesAutoCheck: false,
      token: null, viewerToken: null, ...extra }); servers.push(server)
    browser.errors.length = 0; await browser.resize(1440, 900); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    return server
  }
  async function send(task: string) { await browser.fill('#input', task); await browser.click('#sendBtn') }
  async function screenshot(name: string) { if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png')) }

  it('shows leading accessible status for every session and never calls an unfinished disk history running', async () => {
    const hold = barrier(); releases.push(hold.release)
    const server = await boot({ approvalMode: 'default', adapter: { id: 'held-status', defaultModel: 'fixture', async *stream() { await hold.promise; yield* text('FINISHED') } } })
    server.harness.ctx.tools.register({ name: 'status_wait_fixture', kind: 'write', description: 'Synthetic status approval', parameters: { type: 'object' }, async execute() { return 'approved fixture' } })
    const session = await server.harness.ctx.sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'UNFINISHED_HISTORICAL_TASK' } })
    server.harness.ctx.emit('agent/status', { id: server.harness.main().id, status: 'idle' })
    await browser.waitFor(`document.querySelector('[data-session-id="${session.id}"] .session-status')?.dataset.status === 'unfinished'`)
    await send('LIVE_TASK')
    await browser.waitFor("document.querySelector('.session-item.active .session-status')?.dataset.status === 'running'")
    const main = server.harness.main()
    const approval = server.harness.ctx.tools.execute('status-wait', 'status_wait_fixture', '{}', { agentId: main.id, sessionId: main.sessionId, signal: new AbortController().signal })
    await browser.waitFor("document.querySelector('.session-item.active .session-status')?.dataset.status === 'waiting'")
    await browser.click('.approval-card .ap-actions .btn-soft'); await approval
    hold.release(); await main.wait()
    await browser.waitFor("document.querySelector('.session-item.active .session-status')?.dataset.status === 'done'")
    expect(await browser.evaluate("[...document.querySelectorAll('.session-open')].every(button => button.firstElementChild.classList.contains('session-status') && !!button.firstElementChild.getAttribute('aria-label'))")).toBe(true)
    expect(await browser.evaluate(`document.querySelector('[data-session-id="${session.id}"] .session-status').dataset.status`)).toBe('unfinished')
    await screenshot('session-leading-status')
  })

  it('replaces repeated expert-mode notices in one dismissible status rather than appending chat lines', async () => {
    await boot(); await browser.fill('#input', '保留切换专家时的草稿')
    for (let cycle = 0; cycle < 4; cycle++) {
      await browser.click('#expertChip')
      await browser.waitFor(`document.getElementById('expertChip').getAttribute('aria-pressed') === '${cycle % 2 === 0}' && !document.getElementById('expertChip').disabled`)
    }
    expect(await browser.evaluate("document.querySelectorAll('#expertModeNotice').length")).toBe(1)
    expect(await browser.evaluate("document.getElementById('expertModeNoticeText').textContent")).toContain('已关闭')
    expect(await browser.evaluate("document.querySelectorAll('#chatCol .sys-line').length")).toBe(0)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留切换专家时的草稿')
    await browser.click('#expertModeNoticeClose')
    expect(await browser.evaluate("document.getElementById('expertModeNotice').hidden")).toBe(true)
  })

  it('updates the same turn summary after slow experts finish, keeps folded answers one line and restores metrics and shared peer cards on reload', async () => {
    const hold = barrier(); releases.push(hold.release)
    const adapter: ModelAdapter = { id: 'slow-metrics', defaultModel: 'fixture', async *stream(request) {
      const expert = String(request.messages[0]?.content).includes('你是 SakuraCode 专家团队成员')
      if (expert) { yield { type: 'text', delta: 'EXPERT_RESULT' }; await hold.promise; yield { type: 'usage', inputTokens: 20, outputTokens: 5 }; yield { type: 'done', reason: 'stop' }; return }
      yield* text('主回答很长'.repeat(180)); yield { type: 'usage', inputTokens: 30, outputTokens: 10 }
    } }
    const server = await boot({ adapter }); await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && !document.getElementById('sendBtn').disabled")
    await send('SHARED_METRICS_TASK')
    await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.dataset.pending === 'true' && document.querySelector('.msg-assist.message-folded')")
    await browser.evaluate("window.originalTurnSummary = document.querySelector('#chatCol > .turn-summary')")
    expect(await browser.evaluate("document.querySelector('.msg-assist').getBoundingClientRect().height")).toBeLessThanOrEqual(36)
    expect(await browser.evaluate("document.querySelector('.session-item.active .session-status').dataset.status")).toBe('running')
    hold.release(); await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.dataset.scope === 'team'")
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary') === window.originalTurnSummary")).toBe(true)
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').textContent")).toContain('115 tokens')
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').textContent")).toContain('总耗时')
    expect(await browser.evaluate("document.querySelectorAll('#chatCol > .turn-summary').length")).toBe(1)
    const before = await browser.evaluate<string>("document.querySelector('#chatCol > .turn-summary').textContent")
    await browser.reload(); await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.dataset.scope === 'team' && document.querySelectorAll('[data-collaboration]').length === 3")
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').textContent")).toBe(before)
    expect(await browser.evaluate("document.querySelectorAll('.msg-user-row').length")).toBe(1)
    await screenshot('team-turn-summary-replayed')
  })

  it('keeps summaries separate for queued turns when an older team summary arrives late', async () => {
    const server = await boot(); await send('FIRST_TASK'); await server.harness.main().wait()
    await browser.waitFor("document.querySelectorAll('#chatCol > .turn-summary').length === 1")
    await send('SECOND_TASK'); await server.harness.main().wait()
    await browser.waitFor("document.querySelectorAll('#chatCol > .turn-summary').length === 2")
    const session = await server.harness.ctx.sessions.open(server.harness.main().sessionId)
    const rows = session.events.filter(event => event.type === 'session/note' && event.payload.note === 'turn-summary')
    const first = rows[0]!.payload as { userSeq: number; metrics: TurnMetrics }
    server.harness.ctx.emit('ui/turn/summary', { agentId: server.harness.main().id, sessionId: session.id, userSeq: first.userSeq, main: true,
      metrics: { ...first.metrics, scope: 'team', members: 4, totalTokens: 999 } })
    await browser.waitFor("document.querySelector('#chatCol > .turn-summary').textContent.includes('999 tokens')")
    expect(await browser.evaluate("document.querySelectorAll('#chatCol > .turn-summary').length")).toBe(2)
    expect(await browser.evaluate("[...document.querySelectorAll('#chatCol > .turn-summary')][1].dataset.scope")).toBe('agent')
  })

  it('waits for expert mailbox follow-ups and includes their tokens in the same original user turn', async () => {
    const hold = barrier(); releases.push(hold.release)
    let server: WebServerHandle, delegated = false
    const adapter: ModelAdapter = { id: 'mailbox-metrics', defaultModel: 'fixture', async *stream(request) {
      const expert = String(request.messages[0]?.content).includes('你是 SakuraCode 专家团队成员')
      const mailbox = String([...request.messages].reverse().find(message => message.role === 'user')?.content).includes('[message from parent]')
      if (mailbox) { await hold.promise; yield* text('MAILBOX_FOLLOWUP'); yield { type: 'usage', inputTokens: 20, outputTokens: 3 }; return }
      if (!expert && !delegated) {
        delegated = true
        const target = server.harness.ctx.agents.list().find(agent => !!agent.meta.expert)!
        yield* toolCall('send_message', JSON.stringify({ agent_id: target.id, message: 'FOLLOWUP_DIRECTIONS' }), 'followup-mail')
      } else yield* text(expert ? 'EXPERT_DONE' : 'MAIN_DONE')
      yield { type: 'usage', inputTokens: 10, outputTokens: 2 }
    } }
    server = await boot({ adapter, approvalMode: 'yolo' }); await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && !document.getElementById('sendBtn').disabled")
    await send('ONE_USER_TASK_WITH_MAIL')
    await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.dataset.pending === 'true'")
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').dataset.scope")).toBe('agent')
    hold.release(); await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.dataset.scope === 'team'")
    expect(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').textContent")).toContain('83 tokens')
    const session = await server.harness.ctx.sessions.open(server.harness.main().sessionId)
    const team = session.events.filter(event => event.type === 'session/note' && event.payload.note === 'turn-summary' &&
      (event.payload.metrics as TurnMetrics)?.scope === 'team')
    expect(team).toHaveLength(1)
    expect((team[0]!.payload as { metrics: TurnMetrics }).metrics).toMatchObject({ members: 4, requests: 6, totalTokens: 83 })
    expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
  })

  it('bounds a stale large renderer to private native evidence, animates reflow only when enabled and preserves DOM, focus, caret, attachments and drafts', async () => {
    const actions: string[] = [], server = await boot({ onWindowAction: action => { actions.push(action) } })
    await browser.fill('#input', '浏览器切换后保留中文草稿与焦点')
    await browser.evaluate(`(() => {
      window.savedComposer = document.getElementById('input'); window.savedWelcome = document.getElementById('welcome');
      window.savedComposer.focus(); window.savedComposer.setSelectionRange(3, 5);
      const transfer=new DataTransfer(); transfer.items.add(new File(['VISIBLE_AREA_ATTACHMENT'], 'visible.txt', {type:'text/plain'}));
      const event=new Event('paste',{bubbles:true,cancelable:true}); Object.defineProperty(event,'clipboardData',{value:transfer}); window.savedComposer.dispatchEvent(event);
    })()`)
    await browser.waitFor("document.getElementById('attachRow').textContent.includes('visible.txt')")
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    server.updateDesktopViewport({ width: 1090, height: 720, dpi: 96, version: 1 })
    await browser.waitFor("getComputedStyle(document.documentElement).getPropertyValue('--visible-width').trim() === '1090px'")
    expect(await browser.evaluate("document.body.getBoundingClientRect().width")).toBe(1090)
    expect(await browser.evaluate("document.getElementById('mainWorkspace').getBoundingClientRect().right <= 1091")).toBe(true)
    expect(actions).toContain('reflow')
    server.updateDesktopViewport({ width: 490, height: 620, dpi: 96, version: 2 })
    await browser.waitFor("document.body.classList.contains('visible-compact') && document.body.classList.contains('viewport-settling')")
    expect(await browser.evaluate("getComputedStyle(document.getElementById('chatScroll')).animationName")).toBe('viewport-settle')
    await browser.waitFor("!document.body.classList.contains('viewport-settling')")
    expect(await browser.evaluate("document.getElementById('input') === window.savedComposer && document.getElementById('welcome') === window.savedWelcome && document.activeElement === window.savedComposer && window.savedComposer.selectionStart === 3 && window.savedComposer.selectionEnd === 5")).toBe(true)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('浏览器切换后保留中文草稿与焦点')
    expect(await browser.evaluate("document.getElementById('attachRow').textContent")).toContain('visible.txt')
    expect(await browser.evaluate("document.getElementById('sendBtn').getBoundingClientRect().right <= 491 && document.getElementById('sendBtn').getBoundingClientRect().bottom <= 621")).toBe(true)
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    server.updateDesktopViewport({ width: 1000, height: 700, dpi: 96, version: 3 })
    await browser.waitFor("document.body.getBoundingClientRect().width === 1000")
    expect(await browser.evaluate("getComputedStyle(document.getElementById('chatScroll')).animationName")).toBe('none')
    await screenshot('native-visible-area-constraint')
  })
})