/** Isolated browser coverage for persistent login, compact messages and the top workbench progress. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ModelAdapter } from '../src/core/types.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import type { SakuraApiSaved } from '../src/integrations/sakuraapi.js'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text, toolCall } from './helpers.js'
import { clientAuthorization, clientDraft, clientUser, noClientSecrets, sakuraClientResponse } from './sakuraapi-client-fixture.js'

const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
const longAnswer = Array.from({ length: 18 }, (_, index) => `段落 ${index}：保留完整历史，不把界面折叠当作上下文删除。`).join('\n\n') + '\n\nLATEST_OUTPUT';
const barrier = () => {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

suite('conversation disclosures — real browser', () => {
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
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-disclosure-ui-')); directories.push(cwd)
    const server = await runWebServer({ cwd, open: false, quiet: true, adapter: new MockAdapter([text(longAnswer)]),
      updatesAutoCheck: false, token: null, viewerToken: null, ...extra }); servers.push(server)
    browser.errors.length = 0
    await browser.resize(1440, 900); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    return server
  }
  async function send(task = '测试紧凑对话') {
    await browser.waitFor("!document.getElementById('sendBtn').disabled")
    await browser.fill('#input', task); await browser.click('#sendBtn')
  }
  async function screenshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }

  it('defaults to secure remembered login, changes retention without consent and restores selected credentials on restart', async () => {
    const persisted: Array<SakuraApiSaved | null> = []
    let fail = false
    const draft = clientDraft(), open = vi.fn(async () => ({ draft, readAuthorization: async () => clientAuthorization(draft.state), close: async () => {} }))
    const persist = async (saved: SakuraApiSaved | null) => { if (fail) throw new Error('synthetic locked storage'); persisted.push(saved) }
    const server = await boot({ sakuraApiOnly: true, sakuraApiOpenLogin: open, sakuraApiFetch: sakuraClientResponse, onPersistSakuraApi: persist })
    await browser.click('#sakuraAccountBtn'); await browser.waitFor("!document.getElementById('sakuraLogin').disabled")
    expect(await browser.evaluate("document.getElementById('sakuraRemember').checked")).toBe(true)
    await browser.click('#sakuraLogin'); await browser.waitFor('document.getElementById("accountUsername").textContent === ' + JSON.stringify(clientUser.username))
    await browser.waitFor("!document.getElementById('sakuraRemember').disabled")
    expect(persisted[0]).not.toBeNull()
    await browser.click('#sakuraRemember'); await browser.waitFor("!document.getElementById('sakuraRemember').checked && !document.getElementById('sakuraRemember').disabled")
    expect(persisted.at(-1)).toBeNull()
    fail = true
    await browser.click('#sakuraRemember'); await browser.waitFor("!document.getElementById('sakuraAccountError').hidden && !document.getElementById('sakuraRemember').disabled")
    expect(await browser.evaluate("document.getElementById('sakuraRemember').checked")).toBe(false)
    fail = false
    await browser.click('#sakuraRemember'); await browser.waitFor("document.getElementById('sakuraRemember').checked && !document.getElementById('sakuraRemember').disabled")
    const response = await fetch(server.url + 'api/account/sakura/key-select', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 101 }) })
    expect(response.status).toBe(200)
    const saved = persisted.at(-1)!
    await browser.navigate('about:blank'); await server.close()
    const resumed = await boot({ sakuraApiOnly: true, sakuraApi: saved!, sakuraApiOpenLogin: open, sakuraApiFetch: sakuraClientResponse, onPersistSakuraApi: persist })
    await browser.waitFor('document.getElementById("accountUsername").textContent === ' + JSON.stringify(clientUser.username))
    const status = await (await fetch(resumed.url + 'api/account/sakura')).json()
    expect(status).toMatchObject({ phase: 'connected', remember: true, keyId: 101, model: 'gpt-test' })
    expect(open).toHaveBeenCalledOnce()
    expect(noClientSecrets(await browser.evaluate('JSON.stringify(localStorage) + document.body.innerHTML'))).toBe(true)
  })

  it('folds long input/output to one line, expands with keyboard, keeps full copy/history and does not overflow at 320px', async () => {
    const server = await boot()
    await send('长任务内容\n'.repeat(14) + 'LATEST_TASK')
    await browser.waitFor("document.querySelector('.msg-assist.message-folded') && document.getElementById('stopBtn').hidden && document.querySelector('[data-user-seq]')")
    expect(await browser.evaluate("document.querySelector('.msg-assist .message-fold-preview').textContent")).toBe('LATEST_OUTPUT')
    expect(await browser.evaluate("document.querySelector('.msg-user-row .message-fold-preview').textContent")).toBe('LATEST_TASK')
    const session = await server.harness.ctx.sessions.open(server.harness.main().sessionId), before = await fs.readFile(session.file, 'utf8')
    expect(await browser.evaluate("document.querySelector('.msg-assist').getBoundingClientRect().height")).toBeLessThanOrEqual(36)
    await browser.evaluate("document.querySelector('.msg-assist .message-fold-head').focus()")
    await browser.key('Enter')
    expect(await browser.evaluate("document.querySelector('.msg-assist .message-fold-head').getAttribute('aria-expanded')")).toBe('true')
    expect(await browser.evaluate("document.querySelector('.msg-assist .md').checkVisibility()")).toBe(true)
    expect(await browser.evaluate("document.querySelector('.msg-assist').dataset.raw")).toBe(longAnswer)
    await browser.click('#foldLongMessages'); await browser.click('#expandMessages')
    expect(await browser.evaluate("document.querySelectorAll('#chatCol .message-folded').length")).toBe(0)
    await browser.click('#foldLongMessages')
    for (const theme of ['night', 'day']) for (const width of [1440, 768, 390, 320]) {
      await browser.resize(width, 900); await browser.evaluate('document.documentElement.dataset.theme = ' + JSON.stringify(theme))
      expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true)
      expect(await browser.evaluate("document.querySelector('.msg-assist').getBoundingClientRect().height")).toBeLessThanOrEqual(36)
    }
    await screenshot('conversation-folded-320')
    await browser.reload(); await browser.waitFor("document.querySelector('.msg-assist .message-fold-preview')?.textContent === 'LATEST_OUTPUT'")
    expect(await fs.readFile(session.file, 'utf8')).toBe(before)
  })

  it('updates a folded stream with the latest tail and never resets an explicit expansion during output or disk reconciliation', async () => {
    const second = barrier(), end = barrier(); releases.push(second.release, end.release)
    const adapter: ModelAdapter = { id: 'disclosure-stream', defaultModel: 'fixture-model', async *stream() {
      yield { type: 'text', delta: longAnswer + '\nSTREAM_FIRST' }; await second.promise
      yield { type: 'text', delta: '\nSTREAM_SECOND' }; await end.promise; yield { type: 'done', reason: 'stop' }
    } }
    const server = await boot({ adapter }); await send()
    await browser.waitFor("document.querySelector('.msg-assist .message-fold-preview')?.textContent === 'STREAM_FIRST'")
    expect(await browser.evaluate("document.querySelector('.msg-assist').classList.contains('message-folded')")).toBe(true)
    second.release(); await browser.waitFor("document.querySelector('.msg-assist .message-fold-preview').textContent === 'STREAM_SECOND'")
    await browser.click('.msg-assist .message-fold-head')
    end.release(); await server.harness.main().wait()
    await browser.waitFor("document.getElementById('stopBtn').hidden && document.querySelector('[data-user-seq]')")
    expect(await browser.evaluate("document.querySelector('.msg-assist .message-fold-head').getAttribute('aria-expanded')")).toBe('true')
    expect(await browser.evaluate("document.querySelector('.msg-assist').dataset.raw")).toContain('STREAM_SECOND')
  })

  it('shows three compact experts inside one conversation, preserves live cards across main replay and offers internal records after reload', async () => {
    const server = await boot(); await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && !document.getElementById('sendBtn').disabled")
    await send('同一任务交给专家协作')
    await browser.waitFor("document.querySelectorAll('#chatCol .sub-card[data-agent-id]').length === 3 && document.getElementById('stopBtn').hidden")
    await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    await browser.waitFor("document.getElementById('expertSessionCount').textContent === '3' && document.querySelectorAll('#sessionList .session-item').length === 1")
    expect(await browser.evaluate("document.querySelectorAll('#chatCol .sub-card.message-folded').length")).toBe(3)
    const state = await (await fetch(server.url + 'api/state')).json() as { sessions: unknown[]; expertSessions: unknown[] }
    expect(state.sessions).toHaveLength(1); expect(state.expertSessions).toHaveLength(3)
    await browser.click('#chatCol .sub-card .message-fold-head')
    expect(await browser.evaluate("document.querySelector('#chatCol .sub-card .md').checkVisibility()")).toBe(true)
    await screenshot('expert-conversation-disclosures')
    await browser.reload(); await browser.waitFor("document.getElementById('expertSessionCount').textContent === '3'")
    if (await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')") !== 'true') await browser.click('#inspectorBtn')
    await browser.click('#teamTab'); await browser.click('#expertSessionHistory summary'); await browser.click('#expertSessionList button')
    await browser.waitFor("document.querySelector('#agentReaderBody .thread-message .message-fold-head') && !document.getElementById('agentReader').hasAttribute('aria-busy')")
    expect(await browser.evaluate("document.querySelector('#agentReaderBody .thread-message').classList.contains('message-folded')")).toBe(true)
    await browser.click('#agentReaderBody .thread-message .message-fold-head')
    expect(await browser.evaluate("document.querySelector('#agentReaderBody .thread-message p').checkVisibility()")).toBe(true)
    expect((await (await fetch(server.url + 'api/state')).json() as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it('keeps still-running expert streams attached when the faster main agent replays its persisted transcript', async () => {
    const hold = barrier(); releases.push(hold.release)
    const adapter: ModelAdapter = { id: 'slow-experts', defaultModel: 'fixture-model', async *stream(request) {
      const expert = String(request.messages[0]?.content).includes('你是 SakuraCode 专家团队成员')
      if (!expert) { yield* text('FAST_MAIN_DONE'); return }
      yield { type: 'text', delta: 'EXPERT_FIRST' }; await hold.promise
      yield { type: 'text', delta: '\nEXPERT_LATEST' }; yield { type: 'done', reason: 'stop' }
    } }
    const server = await boot({ adapter }); await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && !document.getElementById('sendBtn').disabled")
    await send('主智能体先结束，专家继续输出')
    await browser.waitFor("document.querySelector('[data-user-seq]') && document.querySelectorAll('#chatCol .sub-card[data-agent-id]').length === 3 && document.getElementById('stopBtn').hidden")
    await browser.click('#chatCol .sub-card .message-fold-head')
    hold.release(); await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    await browser.waitFor("[...document.querySelectorAll('#chatCol .sub-card .message-fold-preview')].every(preview => preview.textContent === 'EXPERT_LATEST')")
    expect(await browser.evaluate("document.querySelectorAll('#chatCol .sub-card[data-agent-id]').length")).toBe(3)
    expect(await browser.evaluate("document.querySelector('#chatCol .sub-card .message-fold-head').getAttribute('aria-expanded')")).toBe('true')
    expect(await browser.evaluate("document.querySelectorAll('#chatCol .sub-card.message-folded').length")).toBe(2)
  })

  it('keeps task progress at the workbench top in both tabs, independently scrolls a long list and reports real counts', async () => {
    const todos = Array.from({ length: 30 }, (_, index) => ({ content: `任务 ${index}`, status: index < 7 ? 'completed' : 'pending', priority: 'medium' }))
    await boot({ adapter: new MockAdapter([toolCall('todo_write', JSON.stringify({ todos })), text('进度已更新')]) })
    await send('更新任务进度');
    if (await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')") !== 'true') await browser.click('#inspectorBtn')
    await browser.waitFor("document.getElementById('todoCount').textContent === '7/30' && document.getElementById('stopBtn').hidden")
    for (const tab of ['teamTab', 'changesTab']) {
      await browser.click('#' + tab)
      const layout = await browser.evaluate<{ parent: string; visible: boolean; first: boolean; max: number; value: number; bounded: boolean }>(`(() => {
        const section=document.getElementById('todoSection'), list=document.getElementById('todoList'), progress=document.getElementById('todoProgress');
        return {parent:section.parentElement.id,visible:section.checkVisibility(),first:section.getBoundingClientRect().bottom<=document.querySelector('.inspector-tabs').getBoundingClientRect().top+1,
          max:progress.max,value:progress.value,bounded:list.clientHeight<=200 && list.scrollHeight>list.clientHeight};
      })()`)
      expect(layout).toEqual({ parent: 'inspector', visible: true, first: true, max: 30, value: 7, bounded: true })
    }
    await screenshot('workbench-top-progress')
  })
})