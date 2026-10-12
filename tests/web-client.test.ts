/** Real GUI regressions against the local harness, with a scripted model only.
 * Set SAKURA_UI_SCREENSHOTS to a directory to keep desktop/mobile previews. */
import { promises as fs, readFileSync } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type DesktopSettingsState, type WebServerHandle } from '../src/web/server.js'
import { BrowserClient } from './browser-client.js'

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')

describe('web client — single-file contract', () => {
  it('contains valid JavaScript and unique static element IDs', () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    expect(scripts).toHaveLength(1)
    expect(() => new Script(scripts[0]![1]!)).not.toThrow()
    const markup = html.slice(0, html.indexOf('<script>'))
    const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps runtime assets local and exposes labelled panel relationships', () => {
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:/)
    for (const name of ['team', 'changes', 'extensions']) {
      expect(html).toContain(`aria-controls="${name}Panel"`)
      expect(html).toContain(`aria-labelledby="${name}Tab"`)
    }
  })
})

describe('desktop settings endpoints', () => {
  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('keeps workspace settings hidden on remote servers', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-remote-'))
    await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}')
    try {
      const server = await runWebServer({ cwd: workspace, open: false, quiet: true })
      try {
        const state = await (await fetch(server.url + 'api/state')).json() as { desktop?: unknown }
        expect(state.desktop).toBeUndefined()
        const denied = await post(server.url + 'api/desktop/settings', {})
        expect(denied.status).toBe(404)
      } finally {
        await server.close()
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('rejects invalid desktop settings before touching the workspace', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-validate-'))
    await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}')
    const persisted: DesktopSettingsState[] = []
    try {
      const server = await runWebServer({ cwd: workspace, open: false, quiet: true, onPersistSettings: (s) => persisted.push(s) })
      try {
        expect((await post(server.url + 'api/desktop/settings', { workspace: 'relative/path' })).status).toBe(400)
        expect((await post(server.url + 'api/desktop/settings', { baseURL: 'ftp://example.com' })).status).toBe(400)
        expect((await post(server.url + 'api/desktop/settings', { baseURL: 'http://example.com' })).status).toBe(400)
        expect((await post(server.url + 'api/desktop/settings', { model: 'has space' })).status).toBe(400)
        expect((await post(server.url + 'api/desktop/settings', { apiKey: 'has\ttab' })).status).toBe(400)
        expect((await post(server.url + 'api/desktop/settings', { rememberKey: 'yes' })).status).toBe(400)
        expect(persisted).toEqual([])
      } finally {
        await server.close()
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('switches workspaces in desktop mode, remounting the harness and persisting settings', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-switch-'))
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-switch-other-'))
    await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(other, 'package.json'), '{"type":"module"}')
    const persisted: DesktopSettingsState[] = []
    try {
      const server = await runWebServer({ cwd: workspace, open: false, quiet: true, onPersistSettings: (s) => persisted.push(s) })
      try {
        const before = server.harness
        const beforeState = await (await fetch(server.url + 'api/state')).json() as { cwd: string; desktop?: DesktopSettingsState }
        expect(beforeState.cwd).toBe(workspace)
        expect(beforeState.desktop?.workspace).toBe(workspace)
        // A missing directory fails while the live workspace keeps running.
        expect((await post(server.url + 'api/desktop/settings', { workspace: path.join(workspace, 'missing') })).status).toBe(400)
        const applied = await (await post(server.url + 'api/desktop/settings', { workspace: other })).json() as DesktopSettingsState
        expect(applied.workspace).toBe(other)
        expect(applied.recentWorkspaces).toEqual([other, workspace])
        const after = await (await fetch(server.url + 'api/state')).json() as { cwd: string; desktop?: DesktopSettingsState }
        expect(after.cwd).toBe(other)
        expect(after.desktop?.workspace).toBe(other)
        expect(server.harness).not.toBe(before)
        expect(persisted.map((s) => s.workspace)).toEqual([other])
        expect(persisted[0]?.apiKey).toBeUndefined()
      } finally {
        await server.close()
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })
})

class GuiAdapter implements ModelAdapter {
  id = 'gui-model'
  defaultModel = 'gui-chat'
  models = ['gui-chat', 'gui-reasoner']
  requests: LLMRequest[] = []

  async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    this.requests.push(req)
    const message = String([...req.messages].reverse().find((entry) => entry.role === 'user')?.content ?? '')
    if (message.includes('[fail]')) throw new Error('GUI_FAILURE_FIXTURE')
    if (message.includes('[slow]')) {
      yield { type: 'text', delta: '正在独立审查…' }
      await new Promise<void>((resolve) => {
        if (req.signal?.aborted) resolve()
        else req.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      yield { type: 'done', reason: 'cancelled' }
      return
    }
    yield { type: 'thinking', delta: '先梳理上下文，再验证结论。' }
    yield { type: 'text', delta: '已完成：' + message }
    yield { type: 'usage', inputTokens: 120, outputTokens: 32 }
    yield { type: 'done', reason: 'stop' }
  }
}

const browserSuite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip

browserSuite('web client — real browser', () => {
  const browser = new BrowserClient()
  let server: WebServerHandle | undefined
  let workspace = ''
  let adapter: GuiAdapter

  beforeAll(async () => { await browser.start() })
  afterAll(async () => { await browser.close() })

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-workspace-'))
    await fs.mkdir(path.join(workspace, 'plugins'), { recursive: true })
    await fs.mkdir(path.join(workspace, '.sakura', 'commands'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(workspace, 'plugins', 'review-check.js'), `
      export const name = 'review-check'
      export const description = '<img src=x onerror=alert(1)> local review extension'
      export const inject = ['tools']
      export function apply(ctx) {
        ctx.get('tools').register({ name: 'review_check', kind: 'read', description: 'Review workspace',
          parameters: {type: 'object', properties: {}}, execute: async () => ({output: 'reviewed'}) })
      }
    `)
    await fs.writeFile(path.join(workspace, '.sakura', 'commands', 'review.md'), '---\ndescription: Review the workspace\n---\nReview this workspace: $ARGUMENTS')
    await fs.mkdir(path.join(workspace, '.sakura', 'skills', 'repo-review'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.sakura', 'skills', 'repo-review', 'SKILL.md'), '---\nname: repo-review\ndescription: 审查仓库变更\nwhenToUse: 提交前审查\n---\n按清单逐项审查变更与测试。\n')
    adapter = new GuiAdapter()
    server = await runWebServer({ cwd: workspace, adapter, config: { pluginsDir: 'plugins' }, open: false, quiet: true, approvalMode: 'default' })
    browser.errors.length = 0
    await browser.resize(1440)
    await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接' && document.querySelectorAll('.agent-row').length === 1")
    // The first SSE connection schedules an initial history load after 80ms.
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
  })

  afterEach(async () => {
    const errors = [...browser.errors]
    try {
      await browser.navigate('about:blank')
      await server?.close()
    } finally {
      server = undefined
      if (workspace) await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
    expect(errors).toEqual([])
  })

  async function snapshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) {
      await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
    }
  }

  async function dimensions() {
    return browser.evaluate<{ viewport: number; page: number; chat: number; composer: number; side: number; panel: number }>(`(() => {
      const width = selector => document.querySelector(selector).getBoundingClientRect().width;
      return {viewport: innerWidth, page: document.documentElement.scrollWidth,
        chat: width('.main'), composer: width('.composer'), side: width('.sidebar'), panel: width('.inspector')};
    })()`)
  }

  it('renders three columns and restores the desktop panel preferences', async () => {
    const initial = await dimensions()
    expect(initial.page).toBe(initial.viewport)
    expect(initial.side).toBe(248)
    // The focused workbench starts with the inspector panel closed by default.
    expect(initial.panel).toBe(0)
    expect(initial.chat).toBe(1192)
    expect(initial.composer).toBeLessThan(initial.chat)
    expect(await browser.evaluate("getComputedStyle(document.getElementById('closeSidebarBtn')).display")).toBe('none')
    await snapshot('workspace-desktop')
    await browser.click('#menuBtn')
    // Sidebar off + inspector still closed → chat takes the full width.
    expect((await dimensions()).chat).toBe(1440)
    await browser.reload()
    await browser.waitFor("document.querySelector('#menuBtn')?.getAttribute('aria-expanded') === 'false'")
    expect(await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')")).toBe('false')
    await browser.click('#menuBtn')
    await browser.click('#inspectorBtn')
    expect((await dimensions()).chat).toBe(880)
    await browser.click('#themeBtn')
    expect(await browser.evaluate('document.documentElement.dataset.theme')).toBe('day')
    await snapshot('workspace-day')
  })

  it('makes Changes a clickable keyboard-accessible tab and restores it after reload', async () => {
    await browser.click('#inspectorBtn')
    await browser.click('#changesTab')
    expect(await browser.evaluate("document.getElementById('changesPanel').hidden")).toBe(false)
    expect(await browser.evaluate("document.getElementById('changesTab').getAttribute('aria-selected')")).toBe('true')
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    expect(await browser.evaluate("document.getElementById('changesPanel').hidden")).toBe(false)
    await browser.evaluate("document.getElementById('changesTab').focus()")
    await browser.key('ArrowRight')
    expect(await browser.evaluate('document.activeElement.id')).toBe('extensionsTab')
  })

  it('queues from the visible send button without interrupting the running turn', async () => {
    await browser.fill('#input', '[slow] main task')
    await browser.click('#sendBtn')
    await browser.waitFor("!document.getElementById('stopBtn').hidden && !document.getElementById('sendBtn').disabled")
    expect(await browser.evaluate("document.getElementById('modelSel').disabled && document.getElementById('thinkingSel').disabled")).toBe(true)
    expect(await browser.evaluate("document.getElementById('approvalSelBottom').disabled")).toBe(false)
    expect(await browser.evaluate("document.getElementById('sendBtn').hidden")).toBe(false)
    expect(await browser.evaluate("document.getElementById('sendBtn').textContent")).toContain('排队')
    await browser.fill('#input', 'queued follow-up')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('input').value === '' && !document.getElementById('sendBtn').disabled")
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(await browser.evaluate("document.getElementById('queueCount').textContent")).toContain('1')
    await browser.fill('#input', 'second queued follow-up')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('queueCount').textContent.includes('2')")
    await browser.click('#stopBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：second queued follow-up') && document.getElementById('stopBtn').hidden")
    expect(adapter.requests).toHaveLength(3)
    expect(await browser.evaluate("document.getElementById('queueCount').textContent")).toBe('')
    expect(await browser.evaluate("document.getElementById('runStrip').hidden")).toBe(true)
    expect(await browser.evaluate("document.getElementById('modelSel').disabled")).toBe(false)
  })

  it('clears a failed outcome when the next main task starts and keeps a rejected draft', async () => {
    await browser.fill('#input', '[fail] deliberate model failure')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('runLabel').textContent === '上次回合失败'")
    expect(adapter.requests).toHaveLength(1)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('[fail] deliberate model failure') && document.getElementById('chatCol').textContent.includes('GUI_FAILURE_FIXTURE') && document.getElementById('runLabel').textContent === '上次回合失败'")
    await browser.fill('#input', '/not-a-command keep this draft')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('发送失败') && !document.getElementById('sendBtn').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('/not-a-command keep this draft')
    expect(adapter.requests).toHaveLength(1)
    await browser.fill('#input', '[slow] retry safely')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('runLabel').textContent === '主智能体运行中'")
    expect(await browser.evaluate("document.getElementById('runState').classList.contains('failed')")).toBe(false)
    await browser.click('#stopBtn')
    await browser.waitFor("document.getElementById('stopBtn').hidden")
    expect(await browser.evaluate("document.getElementById('runLabel').textContent")).toBe('就绪')
  })

  it('keeps tool cards separate across agents and jumps from successful changes to their diff', async () => {
    const main = server!.harness.main()
    await main.turn('prepare session')
    const child = server!.harness.ctx.agents.spawn({ name: 'child', autoStart: false, seed: '', persistentSession: true, meta: { role: 'sub' } })
    await child.turn('prepare child')
    await browser.waitFor("document.getElementById('totalAgents').textContent === '2'")
    const emit = (type: string, payload: Record<string, unknown>) => server!.harness.ctx.emit(type, payload)
    emit('ui/tool/call', { agentId: main.id, sessionId: main.sessionId, main: true, callId: 'same-id', name: 'edit', argsRaw: JSON.stringify({ file_path: 'main.ts', old_string: 'old', new_string: 'new' }) })
    emit('ui/tool/call', { agentId: child.id, sessionId: child.sessionId, main: false, callId: 'same-id', name: 'write', argsRaw: JSON.stringify({ file_path: 'child.ts', content: 'child' }) })
    emit('ui/tool/result', { agentId: main.id, sessionId: main.sessionId, main: true, callId: 'same-id', name: 'edit', output: 'MAIN_RESULT', durationMs: 2 })
    emit('ui/tool/result', { agentId: child.id, sessionId: child.sessionId, main: false, callId: 'same-id', name: 'write', output: 'CHILD_FAILED', isError: true, durationMs: 3 })
    await browser.waitFor("document.querySelectorAll('.tool-card').length === 2 && document.getElementById('chatCol').textContent.includes('MAIN_RESULT') && document.getElementById('chatCol').textContent.includes('CHILD_FAILED')")
    const cards = await browser.evaluate<Array<{ name: string; output: string }>>("[...document.querySelectorAll('.tool-card')].map(card => ({name:card.querySelector('.tool-name').textContent, output:card.querySelector('.tool-out-sec').textContent}))")
    expect(cards.find(card => card.name === 'edit')?.output).toContain('MAIN_RESULT')
    expect(cards.find(card => card.name === 'write')?.output).toContain('CHILD_FAILED')
    await browser.click('#inspectorBtn')
    await browser.click('#changesTab')
    expect(await browser.evaluate("document.getElementById('changesCount').textContent")).toBe('1')
    expect(await browser.evaluate("document.querySelector('#changesList .change-path').textContent")).toBe('main.ts')
    await browser.click('#changesList .change-row')
    expect(await browser.evaluate("document.querySelector('.tool-card .tool-name').closest('.tool-card').classList.contains('open')")).toBe(true)
    expect(await browser.evaluate("document.querySelector('.diff-unified').textContent")).toContain('-old')
  })

  it('loads the last selected child when switching readers during an in-flight request', async () => {
    const first = server!.harness.ctx.agents.spawn({ name: 'first', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    const second = server!.harness.ctx.agents.spawn({ name: 'second', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    await first.turn('FIRST_SESSION')
    await second.turn('SECOND_SESSION')
    await browser.waitFor("document.getElementById('totalAgents').textContent === '3'")
    const originalOpen = server!.harness.ctx.sessions.open.bind(server!.harness.ctx.sessions)
    let release!: () => void
    let entered!: () => void
    const holding = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const spy = vi.spyOn(server!.harness.ctx.sessions, 'open').mockImplementation(async id => {
      if (id === first.sessionId) { entered(); await holding }
      return originalOpen(id)
    })
    try {
      await browser.click('#inspectorBtn')
      await browser.click(`[data-agent-id="${first.id}"] .agent-view`)
      await Promise.race([started, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('reader request was not sent')), 2000))])
      await browser.click(`[data-agent-id="${second.id}"] .agent-view`)
      release()
      await browser.waitFor("document.getElementById('agentReaderBody').textContent.includes('SECOND_SESSION')")
      expect(await browser.evaluate("document.getElementById('agentReaderBody').textContent")).not.toContain('FIRST_SESSION')
    } finally { release(); spy.mockRestore() }
  })

  it('reports copy failure instead of pretending a blocked clipboard succeeded', async () => {
    await browser.fill('#input', 'copy test')
    await browser.click('#sendBtn')
    await browser.waitFor("!!document.querySelector('.msg-assist .message-action')")
    await browser.evaluate("Object.defineProperty(navigator, 'clipboard', {value:{writeText:async()=>{throw new Error('denied')}}, configurable:true}); document.execCommand=()=>false")
    await browser.click('.msg-assist .message-action')
    await browser.waitFor("document.querySelector('.msg-assist .message-action').textContent.includes('失败')")
  })

  it('renders icon-led empty states instead of bare placeholders', async () => {
    expect(await browser.evaluate("document.querySelectorAll('#sessionList .panel-empty svg.icon').length")).toBe(1)
    expect(await browser.evaluate("document.querySelector('#sessionList .panel-empty strong')?.textContent")).toBe('还没有会话')
    expect(await browser.evaluate("document.querySelectorAll('#todoList .panel-empty svg.icon').length")).toBe(1)
    expect(await browser.evaluate("document.querySelectorAll('#mcpList .panel-empty svg.icon').length")).toBe(1)
    expect(await browser.evaluate("document.querySelectorAll('#sessionList .session-open svg.icon').length")).toBe(0)
    await browser.fill('#sessionSearch', '不存在的会话')
    expect(await browser.evaluate("document.querySelector('#sessionList .panel-empty strong')?.textContent")).toBe('没有匹配的会话')
    expect(await browser.evaluate("document.querySelector('#sessionList .panel-empty p')?.textContent")).toBe('换个关键词试试。')
    await browser.fill('#sessionSearch', '')
    expect(await browser.evaluate("document.querySelector('.run-state')?.textContent?.trim()")).toBe('就绪')
  })

  it('shows real mounted plugins/tools and keeps metadata as text', async () => {
    await browser.click('#inspectorBtn')
    await browser.click('#extensionsTab')
    await browser.fill('#pluginSearch', 'review')
    expect(await browser.evaluate("document.querySelectorAll('#pluginList .extension-card').length")).toBe(1)
    expect(await browser.evaluate("document.querySelector('#pluginList').textContent")).toContain('review-check')
    expect(await browser.evaluate("document.querySelectorAll('#pluginList img').length")).toBe(0)
    expect(await browser.evaluate("document.querySelector('#toolList').textContent")).toContain('review_check')
    expect(await browser.evaluate("document.querySelector('#externalCount').textContent")).toBe('1 外部')
    await browser.fill('#pluginSearch', 'no-such-extension')
    expect(await browser.evaluate("document.querySelector('#pluginList').textContent")).toContain('没有匹配')
    await browser.fill('#pluginSearch', '')
    await snapshot('workspace-extensions')
    await browser.evaluate("document.getElementById('extensionsTab').focus()")
    await browser.key('ArrowLeft')
    expect(await browser.evaluate('document.activeElement.id')).toBe('changesTab')
    expect(await browser.evaluate("document.getElementById('changesPanel').hidden")).toBe(false)
  })

  it('switches a model within one adapter and completes thinking without a client error', async () => {
    await browser.evaluate(`(() => {
      const select = document.getElementById('modelSel');
      select.value = 'gui-reasoner'; select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`)
    await browser.waitFor("document.getElementById('modelSel').value === 'gui-reasoner'")
    await browser.fill('#input', '检查这个项目')
    await browser.key('Enter')
    await browser.waitFor("document.querySelector('.msg-assist')?.textContent.includes('已完成') && !document.getElementById('sendBtn').classList.contains('busy')")
    expect(adapter.requests.at(-1)?.model).toBe('gui-reasoner')
    expect(await browser.evaluate("document.querySelector('.msg-think').classList.contains('collapsed')")).toBe(true)
    expect(await browser.evaluate("document.querySelector('.think-head').textContent")).toContain('字')
    expect(await browser.evaluate("document.getElementById('usageChip').hidden")).toBe(false)
    expect(await browser.evaluate("document.getElementById('sessionHeading').textContent")).toContain('检查这个项目')
    await browser.fill('#sessionSearch', '检查这个项目')
    expect(await browser.evaluate("document.querySelectorAll('.session-open').length")).toBe(1)
    await browser.fill('#sessionSearch', 'no-session-matches')
    expect(await browser.evaluate("document.getElementById('sessionList').textContent")).toContain('没有匹配')
    await browser.fill('#sessionSearch', '')
    await snapshot('workspace-chat')
  })

  it('pins compaction to a dedicated model and restores follow-selection', async () => {
    // The select is only offered with more than one registered model.
    await browser.waitFor("!document.getElementById('compactModelSel').hidden")
    expect(await browser.evaluate("document.getElementById('compactModelSel').value")).toBe('')

    await browser.evaluate(`(() => {
      const select = document.getElementById('compactModelSel');
      select.value = 'gui-reasoner'; select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`)
    await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).compactModel === 'gui-reasoner')()")
    // The picker keeps showing the pinned choice after the state round-trip.
    expect(await browser.evaluate("document.getElementById('compactModelSel').value")).toBe('gui-reasoner')

    await browser.evaluate(`(() => {
      const select = document.getElementById('compactModelSel');
      select.value = ''; select.dispatchEvent(new Event('change', {bubbles: true}));
    })()`)
    await browser.waitFor("(async () => !(await (await fetch('/api/state')).json()).compactModel)()")
    expect(await browser.evaluate("document.getElementById('compactModelSel').value")).toBe('')
  })

  it('opens configured agents with a workspace and creates one from the default location', async () => {
    const agentsWs = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-agents-ui-'))
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-newws-ui-'))
    await fs.writeFile(path.join(agentsWs, 'package.json'), '{"type":"module"}')
    await fs.mkdir(path.join(agentsWs, '.sakura', 'agents'), { recursive: true })
    await fs.writeFile(path.join(agentsWs, '.sakura', 'agents', 'researcher.md'), '---\ndescription: 研究员\n---\n你是研究员。')
    const persisted: DesktopSettingsState[] = []
    const desktop = await runWebServer({
      cwd: agentsWs,
      adapter: new GuiAdapter(),
      config: { pluginsDir: 'no-plugins' },
      open: false, quiet: true,
      newWorkspaceDir: parent,
      workspacePrefs: { [agentsWs]: { agents: ['researcher'] } },
      onPersistSettings: (s) => persisted.push(s),
    })
    try {
      await browser.navigate(desktop.url)
      await browser.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
      // main + the workspace's configured agent are on the roster at mount.
      await browser.waitFor("document.querySelectorAll('.agent-row').length === 2")
      expect(await browser.evaluate<string[]>("[...document.querySelectorAll('.agent-row .agent-name')].map((n) => n.textContent)")).toContain('researcher')
      // The settings form shows the agent's checkbox pre-checked.
      await browser.evaluate("document.getElementById('settingsViewBtn').click()")
      await browser.waitFor("!document.getElementById('settingsView').hidden")
      expect(await browser.evaluate<string[]>("[...document.querySelectorAll('#settingsAgents input[type=checkbox]')].map((b) => b.value + ':' + b.checked)")).toContain('researcher:true')
      // The new-workspace dialog previews and creates <default dir>/<name>.
      await browser.evaluate("document.getElementById('chatViewBtn').click()")
      await browser.evaluate("document.getElementById('projectPicker').click()")
      await browser.waitFor("!document.getElementById('newWorkspaceBtn').hidden")
      await browser.evaluate("document.getElementById('newWorkspaceBtn').click()")
      await browser.waitFor("document.getElementById('newWorkspaceDialog').open")
      await browser.fill('#newWorkspaceName', 'fresh-project')
      const fresh = path.join(parent, 'fresh-project')
      expect(await browser.evaluate<string>("document.getElementById('newWorkspacePreview').textContent")).toContain(fresh)
      await browser.evaluate("document.getElementById('newWorkspaceConfirm').click()")
      await browser.waitFor(`(async () => (await (await fetch('/api/state')).json()).cwd === ${JSON.stringify(fresh)})()`)
      expect((await fs.stat(fresh)).isDirectory()).toBe(true)
      // The switch persisted the frame with the prefs map.
      expect(persisted.at(-1)?.workspace).toBe(fresh)
      expect(Object.keys(persisted.at(-1)?.workspacePrefs ?? {})).toContain(path.resolve(fresh))
    } finally {
      await desktop.close()
      await fs.rm(agentsWs, { recursive: true, force: true, retryDelay: 100 }).catch(() => {})
      await fs.rm(parent, { recursive: true, force: true, retryDelay: 100 }).catch(() => {})
    }
  })

  it('creates concurrent subagents, sends a follow-up and interrupts without marking main busy', async () => {
    await browser.click('#inspectorBtn')
    for (const name of ['审查员', '测试员']) {
      await browser.click('#spawnBtn')
      await browser.waitFor("document.getElementById('spawnModal')?.open")
      await browser.fill('#spawnName', name)
      await browser.fill('#spawnTask', '[slow] 独立检查')
      await browser.click('#spawnModal button[type="submit"]')
      await browser.waitFor("!document.getElementById('spawnModal')")
    }
    await browser.waitFor("document.getElementById('runningAgents').textContent === '2'")
    expect(await browser.evaluate("document.getElementById('sendBtn').classList.contains('busy')")).toBe(false)
    expect(await browser.evaluate("document.querySelectorAll('.sub-card .err-bar').length")).toBe(0)
    expect(await browser.evaluate("document.getElementById('totalAgents').textContent")).toBe('3')
    await snapshot('workspace-agents')
    await browser.click('.agent-row[data-status="running"] .agent-action.danger')
    await browser.waitFor("document.getElementById('runningAgents').textContent === '1'")
    await browser.click('.agent-row[data-status="running"] .agent-action.danger')
    await browser.waitFor("document.getElementById('runningAgents').textContent === '0'")
    await browser.click('.agent-message')
    await browser.fill('#agentMessageInput', '请汇总结果')
    await browser.click('#agentMessageModal button[type="submit"]')
    await browser.waitFor("!document.getElementById('agentMessageModal') && document.getElementById('chatCol').textContent.includes('已完成：')")
    expect(adapter.requests.some((request) => request.messages.some((entry) => String(entry.content).includes('请汇总结果')))).toBe(true)
    expect(await browser.evaluate("document.getElementById('sendBtn').classList.contains('busy')")).toBe(false)
    await browser.click('#spawnBtn')
    await browser.key('Escape')
    await browser.waitFor("!document.getElementById('spawnModal')")
    expect(await browser.evaluate('document.activeElement.id')).toBe('spawnBtn')
  })

  it('shows task progress from harness events and keeps slash selection from sending', async () => {
    server!.harness.ctx.emit('ui/todos', {
      todos: [{ content: '梳理入口', status: 'completed', priority: 'high' }, { content: '验证结果', status: 'in_progress', priority: 'medium' }],
    })
    await browser.waitFor("document.getElementById('todoCount').textContent === '1/2'")
    expect(await browser.evaluate("document.getElementById('todoProgress').value")).toBe(1)
    expect(await browser.evaluate("document.getElementById('todoProgress').max")).toBe(2)
    await browser.fill('#input', '/rev')
    await browser.waitFor("!document.getElementById('slashMenu').hidden")
    await browser.key('ArrowDown')
    await browser.key('Enter')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('/review ')
    expect(adapter.requests).toHaveLength(0)
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：')")
    expect(adapter.requests).toHaveLength(1)
  })

  it('has no narrow-screen overflow and keeps drawer focus, scrim and desktop state coherent', async () => {
    for (const width of [1280, 1024, 768, 760, 390, 320]) {
      await browser.resize(width, 844)
      const size = await dimensions()
      expect(size.page, `overflow at ${width}px`).toBe(size.viewport)
      expect(size.composer).toBeLessThan(size.chat)
    }
    await browser.resize(390, 844)
    await snapshot('workspace-mobile')
    expect(await browser.evaluate("document.getElementById('sidebar').inert")).toBe(true)
    expect(await browser.evaluate("document.getElementById('inspector').inert")).toBe(true)
    await browser.click('#menuBtn')
    expect(await browser.evaluate('document.activeElement.id')).toBe('closeSidebarBtn')
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(true)
    await browser.key('Tab', 8)
    expect(await browser.evaluate("document.getElementById('sidebar').contains(document.activeElement)")).toBe(true)
    await browser.key('Escape')
    expect(await browser.evaluate('document.activeElement.id')).toBe('menuBtn')
    await browser.click('#inspectorBtn')
    expect(await browser.evaluate('document.activeElement.id')).toBe('teamTab')
    await browser.click('#spawnBtn')
    await browser.key('Escape')
    await browser.waitFor("!document.getElementById('spawnModal')")
    expect(await browser.evaluate("document.body.classList.contains('inspector-open')")).toBe(true)
    await browser.click('#extensionsTab')
    await snapshot('workspace-mobile-extensions')
    await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 400, button: 'left', clickCount: 1 })
    await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 400, button: 'left', clickCount: 1 })
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(false)
    await browser.resize(1440)
    await browser.click('#inspectorBtn')
    expect(await browser.evaluate("document.getElementById('inspector').inert")).toBe(false)
    expect(await browser.evaluate("document.getElementById('sidebar').inert")).toBe(false)
  })

  it('mounts the workspace section in desktop mode and switches workspaces from the sidebar', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-ui-'))
    await fs.writeFile(path.join(other, 'package.json'), '{"type":"module"}')
    const persisted: DesktopSettingsState[] = []
    const desktop = await runWebServer({
      cwd: other,
      adapter: new GuiAdapter(),
      config: { pluginsDir: 'plugins' },
      open: false, quiet: true,
      recentWorkspaces: [workspace],
      onPersistSettings: (s) => persisted.push(s),
    })
    try {
      await browser.navigate(desktop.url)
      await browser.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
      // Remote servers hide the workspace UI; desktop mode mounts it behind the project picker.
      await browser.waitFor("!document.getElementById('settingsViewBtn').hidden")
      await browser.evaluate("document.getElementById('projectPicker').click()")
      await browser.waitFor("!document.getElementById('workspaceSection').hidden")
      await browser.fill('#input', '切换工作区之前')
      await browser.evaluate("document.getElementById('sendBtn').click()")
      await browser.waitFor("document.querySelector('#chatCol .msg-user-row')")
      const items = await browser.evaluate<string[]>("[...document.querySelectorAll('#workspaceList .workspace-item')].map((item) => item.title)")
      expect(items).toEqual([other, workspace])
      // Switching asks for confirmation, then the SSE state frame resets the chat.
      await browser.evaluate("document.querySelector('#workspaceList .workspace-item:not(.active)').click()")
      await browser.waitFor("document.getElementById('workspaceDialog').open")
      await browser.evaluate("document.getElementById('workspaceDialogConfirm').click()")
      await browser.waitFor("!document.getElementById('workspaceDialog').open")
      await browser.waitFor(`document.querySelector('#workspaceList .workspace-item.active')?.title === ${JSON.stringify(workspace)}`)
      await browser.waitFor("!document.querySelector('#chatCol .msg-user-row')")
      // The settings view reflects the new workspace and saving works.
      await browser.evaluate("document.getElementById('settingsViewBtn').click()")
      await browser.waitFor("!document.getElementById('settingsView').hidden")
      await browser.waitFor(`document.getElementById('settingsWorkspace').value === ${JSON.stringify(workspace)}`)
      await browser.fill('#settingsBaseUrl', '')
      await browser.evaluate("document.getElementById('settingsSave').click()")
      await browser.waitFor("document.getElementById('settingsMessage')?.textContent === '已保存。'")
      expect(persisted.at(-1)?.workspace).toBe(workspace)
    } finally {
      await desktop.close()
      await fs.rm(other, { recursive: true, force: true, retryDelay: 100 }).catch(() => {})
    }
  })

  it('names new sessions from a dialog, renames inline and keeps the welcome screen unscrolled', async () => {
    // The welcome screen must fit without vertical scrolling at normal window heights.
    const scrollInfo = await browser.evaluate<{ overflow: boolean; welcomeVisible: boolean }>(`(() => {
      const scroller = document.getElementById('chatScroll');
      return {overflow: scroller.scrollHeight > scroller.clientHeight + 1,
        welcomeVisible: !document.getElementById('welcome').hidden};
    })()`)
    expect(scrollInfo.welcomeVisible).toBe(true)
    expect(scrollInfo.overflow).toBe(false)
    await browser.resize(1440, 700)
    // Short windows compact the welcome block instead of adding a scrollbar.
    expect(await browser.evaluate("document.getElementById('chatScroll').scrollHeight <= document.getElementById('chatScroll').clientHeight + 1")).toBe(true)
    await browser.resize(1440, 900)
    // 新建会话 sits between the 最近会话 title row and the search box, nothing between them.
    const placement = await browser.evaluate<{ headBeforeButton: boolean; buttonBeforeSearch: boolean; onlyChild: boolean }>(`(() => {
      const button = document.getElementById('newSessionBtn');
      const head = document.querySelector('.side-sessions-head');
      const title = head.querySelector('.side-title');
      const search = document.getElementById('sessionSearch');
      const pos = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {headBeforeButton: pos(title, button), buttonBeforeSearch: pos(button, search),
        onlyChild: head.querySelectorAll('.side-head').length === 1};
    })()`)
    expect(placement.headBeforeButton).toBe(true)
    expect(placement.buttonBeforeSearch).toBe(true)
    expect(placement.onlyChild).toBe(true)
    // Creating a session prompts for a name first; the title lands in the session list.
    await browser.click('#newSessionBtn')
    expect(await browser.evaluate("document.getElementById('newSessionDialog').open")).toBe(true)
    await browser.fill('#newSessionTitle', '登录页回归')
    await browser.evaluate("document.getElementById('newSessionConfirm').click()")
    await browser.waitFor("document.getElementById('newSessionDialog').open === false")
    await browser.waitFor("[...document.querySelectorAll('.session-item .session-title')].some((t) => t.textContent === '登录页回归')")
    const state = await (await fetch(server.url + 'api/state')).json() as { sessionId: string }
    expect(state.sessionId).toBeTruthy()
    // The ✎ button renames the same session through PATCH.
    await browser.evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find((n) => n.dataset.sessionId === ${JSON.stringify(state.sessionId)});
      item.querySelector('.session-rename').click();
    })()`)
    await browser.waitFor("document.getElementById('renameSessionDialog').open")
    expect(await browser.evaluate<string>("document.getElementById('renameSessionTitle').value")).toBe('登录页回归')
    await browser.fill('#renameSessionTitle', '登录页回归 v2')
    await browser.evaluate("document.getElementById('renameSessionConfirm').click()")
    await browser.waitFor("document.getElementById('renameSessionDialog').open === false")
    await browser.waitFor("[...document.querySelectorAll('.session-item .session-title')].some((t) => t.textContent === '登录页回归 v2')")
    const renamed = await (await fetch(server.url + 'api/state')).json() as { sessions: Array<{ id: string; title?: string }> }
    expect(renamed.sessions.find((s) => s.id === state.sessionId)?.title).toBe('登录页回归 v2')
    // An empty rename is rejected inline instead of clearing the title.
    await browser.evaluate(`(() => {
      const item = [...document.querySelectorAll('.session-item')].find((n) => n.dataset.sessionId === ${JSON.stringify(state.sessionId)});
      item.querySelector('.session-rename').click();
    })()`)
    await browser.fill('#renameSessionTitle', '')
    await browser.evaluate("document.getElementById('renameSessionConfirm').click()")
    await browser.waitFor("!document.getElementById('renameSessionError').hidden")
    expect(await browser.evaluate("document.getElementById('renameSessionDialog').open")).toBe(true)
    await browser.evaluate("document.getElementById('renameSessionCancel').click()")
  })

  it('checks for updates from the settings card and badges the settings button', async () => {
    const updatesWs = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-updates-ui-'))
    await fs.writeFile(path.join(updatesWs, 'package.json'), '{"type":"module"}')
    const feed = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://example.com/releases/v99.0.0' }))
    })
    await new Promise<void>((resolve) => feed.listen(0, '127.0.0.1', resolve))
    const feedPort = (feed.address() as { port: number }).port
    const updates = await runWebServer({
      cwd: updatesWs,
      adapter: new GuiAdapter(),
      config: { pluginsDir: 'no-plugins' },
      open: false, quiet: true,
      updatesBaseUrl: `http://127.0.0.1:${feedPort}/releases/latest`,
    })
    try {
      await browser.navigate(updates.url)
      await browser.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
      // No check yet: the card waits and the settings button has no badge.
      await browser.evaluate("document.getElementById('settingsViewBtn').click()")
      await browser.waitFor("!document.getElementById('settingsView').hidden")
      expect(await browser.evaluate("document.getElementById('settingsUpdateStatus').textContent")).toBe('尚未检查。')
      expect(await browser.evaluate("document.getElementById('settingsViewBtn').classList.contains('update-dot')")).toBe(false)
      // A manual check renders latest/current and sets the badge.
      await browser.evaluate("document.getElementById('settingsCheckUpdates').click()")
      await browser.waitFor("document.getElementById('settingsUpdateStatus').textContent.includes('最新 v99.0.0')")
      expect(await browser.evaluate<string>("document.getElementById('settingsUpdateStatus').textContent")).toContain('当前 v')
      expect(await browser.evaluate("document.getElementById('settingsViewBtn').classList.contains('update-dot')")).toBe(true)
    } finally {
      await updates.close()
      feed.closeAllConnections()
      feed.close()
      await fs.rm(updatesWs, { recursive: true, force: true, retryDelay: 100 }).catch(() => {})
    }
  })

  it('toggles the expert session and browses the plugin market from the brand button', async () => {
    await browser.waitFor("!document.getElementById('expertChip').hidden")
    expect(await browser.evaluate("document.getElementById('expertChip').textContent")).toBe('专家 · 关闭')
    // The toggle spawns the built-in team and turns the chip into an active mode.
    await browser.fill('#input', '评审这个仓库的测试覆盖')
    await browser.evaluate("document.getElementById('expertChip').click()")
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 协同中'")
    await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).expertMode === true)()")
    // The draft became the opening task and left the composer.
    expect(await browser.evaluate<string>("document.getElementById('input').value")).toBe('')
    await browser.waitFor("document.querySelectorAll('.agent-row').length === 4")
    const names = await browser.evaluate<string[]>("[...document.querySelectorAll('.agent-row .agent-name')].map((n) => n.textContent)")
    expect(names.sort()).toEqual(['main', '实现者', '架构师', '审查者'].sort())
    // Experts wear a highlighted badge in the roster.
    expect(await browser.evaluate<string[]>(
      "[...document.querySelectorAll('.agent-row .role-badge')].map((b) => b.textContent)"
    )).toContain('专家')
    // Once the experts finish, the summarize action appears and reaches the main agent.
    await browser.waitFor("document.querySelectorAll('.agent-row[data-status=done]').length >= 3")
    expect(await browser.evaluate("document.getElementById('summarizeBtn').hidden")).toBe(false)
    await browser.evaluate("document.getElementById('summarizeBtn').click()")
    await browser.waitFor("document.querySelector('#chatCol .msg-user-row')")
    // The market dialog opens from the top-left brand area and lists plugins + skills.
    expect(await browser.evaluate("document.getElementById('marketBtn').checkVisibility()")).toBe(true)
    await browser.evaluate("document.getElementById('marketBtn').click()")
    await browser.waitFor("document.getElementById('marketDialog').open")
    expect((await browser.evaluate<string>("document.querySelector('#marketBody .market-section h1, #marketBody .market-section h2')?.textContent")).trim()).toContain('已挂载插件')
    const counts = await browser.evaluate<{ plugins: number; skills: number }>(`(() => {
      const badges = [...document.querySelectorAll('#marketBody .count-badge')].map((b) => Number(b.textContent));
      return {plugins: badges[0], skills: badges[1]};
    })()`)
    expect(counts.plugins).toBeGreaterThan(0)
    // Search filters both sections in place.
    await browser.fill('#marketSearch', 'compaction')
    const filtered = await browser.evaluate<number>("[...document.querySelectorAll('#marketBody .market-card')].length")
    expect(filtered).toBeLessThan(counts.plugins + counts.skills)
    // A skill card expands the full SKILL.md body.
    await browser.fill('#marketSearch', 'repo-review')
    await browser.waitFor("[...document.querySelectorAll('#marketBody .market-card')].length === 1")
    await browser.evaluate("document.querySelector('#marketBody .market-card').click()")
    await browser.waitFor("document.querySelector('#marketBody .skill-body') !== null")
    expect(await browser.evaluate<string>("document.querySelector('#marketBody .skill-body').textContent")).toContain('按清单逐项审查变更与测试。')
    await browser.evaluate("document.getElementById('marketClose').click()")
    // Turning the mode off keeps the experts on the roster.
    await browser.evaluate("document.getElementById('expertChip').click()")
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 关闭'")
    await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).expertMode === false)()")
    expect(await browser.evaluate("document.querySelectorAll('.agent-row').length")).toBe(4)
  })

})
