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
import { openSessionMenu, sessionAction } from './client-session-actions.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { authorized, authorizedKey, modelIds, sakuraApiResponse } from './sakuraapi-fixture.js'
import { clientAccessToken, clientAuthorization, clientDraft, clientSaved, clientUser, clientVip, envelope,
  clientSubscriptions, noClientSecrets, sakuraClientResponse } from './sakuraapi-client-fixture.js'

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

  it('renders ordinary Markdown without depending on pending chat attachments', () => {
    const start = html.indexOf('function escapeHtml(')
    const end = html.indexOf('/* ============================================================\n   REST 客户端', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const scope: { mdLite?: (text: string) => string } = {}
    new Script(html.slice(start, end)).runInNewContext(scope)
    if (!scope.mdLite) throw new Error('Markdown renderer was not loaded')
    const rendered = scope.mdLite('普通文本\n第二行\n\n## 标题\n\n- 项目一\n- **项目二**\n\n```ts\nconst value = "<tag>";\n```')
    expect(rendered).toContain('<p>普通文本<br>第二行</p>')
    expect(rendered).toContain('<h2>标题</h2>')
    expect(rendered).toContain('<ul><li>项目一</li><li><strong>项目二</strong></li></ul>')
    expect(rendered).toContain('const value = &quot;&lt;tag&gt;&quot;;')
    expect(scope.mdLite('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
    expect(scope.mdLite('')).toBe('')
  })

  it('keeps runtime assets local and exposes labelled panel relationships', () => {
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:/)
    for (const name of ['team', 'changes']) {
      expect(html).toContain(`aria-controls="${name}Panel"`)
      expect(html).toContain(`aria-labelledby="${name}Tab"`)
    }
    for (const name of ['skills', 'mcp']) {
      expect(html).toContain(`aria-controls="settings-${name}Panel"`)
      expect(html).toContain(`aria-labelledby="settings-${name}Tab"`)
    }
    expect(html).not.toContain('id="settingsClose"')
    expect(html).not.toContain('id="extensionsPanel"')
  })

  it('does not schedule recurring account queries for the client-account grant', () => {
    const schedule = html.slice(html.indexOf('function scheduleSakuraAccount()'), html.indexOf('function renderVipBadge('))
    expect(schedule.indexOf("state.authorization === 'client-account-pkce') return")).toBeGreaterThan(0)
    expect(schedule.indexOf("state.authorization === 'client-account-pkce') return")).toBeLessThan(schedule.indexOf('app.account.timer = setTimeout'))
  })

  it('keeps exactly one VIP badge and moves Key/group controls into model settings', () => {
    const markup = html.slice(0, html.indexOf('<script>'))
    expect([...markup.matchAll(/class="vip-badge(?: large)?"/g)]).toHaveLength(1)
    expect(html).not.toMatch(/accountVipBadge|settingsVipBadge|settingsAccountVip/)
    const account = markup.slice(markup.indexOf('id="settings-accountPanel"'), markup.indexOf('id="settings-generalPanel"'))
    const models = markup.slice(markup.indexOf('id="settings-modelsPanel"'), markup.indexOf('id="settings-workspacePanel"'))
    for (const id of ['sakuraKeyCard', 'sakuraKeySelect', 'sakuraKeyGroups', 'sakuraSelectedKey', 'sakuraKeyDialog', 'sakuraKeysPage', 'sakuraModelError']) {
      expect(models).toContain('id="' + id + '"')
      expect(account).not.toContain('id="' + id + '"')
    }
    expect(account).toContain('id="sakuraVipBadge"')
    expect(account).toContain('id="sakuraSubscriptions"')
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
    yield { type: 'usage', inputTokens: 120, outputTokens: 32, cachedTokens: 90, reasoningTokens: 8 }
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

  it('shows the context viewer beside thinking without covering the composer, with honest categories and responsive keyboard controls', async () => {
    await browser.fill('#input', '检查这个项目的上下文')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：检查这个项目的上下文') && !document.getElementById('sendBtn').disabled")
    await browser.click('#contextViewerBtn')
    await browser.waitFor("document.getElementById('contextViewer').matches(':popover-open') && document.querySelectorAll('.context-category').length === 7")
    const context = await (await fetch(server!.url + 'api/state')).json() as { contextTokens: number; contextBreakdown: { totalTokens: number; excludedThinkingTokens: number; categories: Array<{ category: string; tokens: number }> } }
    expect(context.contextTokens).toBe(context.contextBreakdown.totalTokens)
    expect(context.contextBreakdown.excludedThinkingTokens).toBeGreaterThan(0)
    expect(context.contextBreakdown.categories.find(row => row.category === 'thinking')!.tokens).toBe(0)
    expect(await browser.evaluate("document.querySelector('.context-category[data-category=thinking]').textContent")).toContain('不计入')
    expect(await browser.evaluate("document.getElementById('contextViewerNote').textContent")).toContain('不代表模型窗口上限')
    expect(await browser.evaluate("(() => { const composer = document.querySelector('.composer'), r = composer.getBoundingClientRect(), button = document.getElementById('contextViewerBtn'); return composer.contains(button) && button.previousElementSibling.querySelector('#thinkingSel') && document.getElementById('contextViewer').getBoundingClientRect().bottom < r.top; })()")).toBe(true)
    await snapshot('context-viewer-category-desktop')
    await browser.key('ArrowRight')
    expect(await browser.evaluate("document.getElementById('contextSequenceTab').getAttribute('aria-pressed')")).toBe('true')
    expect(await browser.evaluate("document.activeElement.id")).toBe('contextSequenceTab')
    expect(await browser.evaluate("document.getElementById('contextBar').getAttribute('aria-label')")).toContain('按请求顺序')
    await browser.click('#contextRefresh')
    await browser.waitFor("document.getElementById('contextStatus').textContent === '已刷新。'")
    expect(adapter.requests).toHaveLength(1)
    await browser.key('Escape')
    await browser.waitFor("document.getElementById('contextViewerBtn').getAttribute('aria-expanded') === 'false'")
    expect(await browser.evaluate('document.activeElement.id')).toBe('contextViewerBtn')
    for (const width of [390, 320]) {
      await browser.resize(width, 760)
      await browser.click('#contextViewerBtn')
      expect(await browser.evaluate("(() => { const r = document.getElementById('contextViewer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth; })()")).toBe(true)
      await snapshot('context-viewer-' + width)
      await browser.key('Escape')
    }
    await browser.resize(1440)
    await openSettings('general')
    await browser.click('#themeBtn')
    await browser.click('#settingsBack')
    await browser.click('#contextViewerBtn')
    await snapshot('context-viewer-day')
    await browser.click('#input')
    expect(await browser.evaluate("document.getElementById('contextViewerBtn').getAttribute('aria-expanded')")).toBe('false')
  })

  it('saves actual compaction thresholds and uses the real summary service without losing history', async () => {
    // This regression counts compaction requests, not the new independent
    // durable-memory summarizer; keep automatic memory enabled elsewhere.
    await server!.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory').update({ processing: { auto: false, thresholdChars: 8000, intervalMs: 1800000 } }, 0)
    await server!.harness.run('上下文内容 '.repeat(1200))
    await browser.reload()
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：上下文内容')")
    await browser.fill('#input', '未发送的草稿')
    await browser.click('#contextViewerBtn')
    await browser.click('#contextSettings')
    await browser.fill('#contextWindowInput', '128000')
    await browser.fill('#contextPercentInput', '70')
    await browser.fill('#contextEventsInput', '0')
    await browser.click('#contextSettingsSave')
    await browser.waitFor("!document.getElementById('contextSettingsDialog')")
    const compaction = server!.harness.ctx.get<import('../src/plugins/compaction.js').CompactionService>('compaction')
    expect(compaction.contextWindowTokens).toBe(128000)
    expect(compaction.autoTokensThreshold).toBe(89600)
    expect(compaction.autoThreshold).toBe(0)
    await browser.click('#contextViewerBtn')
    expect(await browser.evaluate("document.getElementById('contextThreshold').textContent")).toContain('70%')
    const session = await server!.harness.ctx.sessions.open(server!.harness.main().sessionId), original = await fs.readFile(session.file, 'utf8')
    const before = await (await fetch(server!.url + 'api/state')).json() as { contextTokens: number }
    await browser.click('#contextCompact')
    await browser.waitFor("document.getElementById('contextStatus').textContent.includes('压缩完成') && !document.getElementById('contextCompact').disabled")
    const after = await (await fetch(server!.url + 'api/state')).json() as { contextTokens: number }
    expect(after.contextTokens).toBeLessThan(before.contextTokens)
    expect((await fs.readFile(session.file, 'utf8')).startsWith(original)).toBe(true)
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests.at(-1)!.messages[0]!.content).toContain('summarize the conversation')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('未发送的草稿')
    await browser.key('Escape')
  })

  it('requires clear confirmation with cancel focused, keeps history and draft, and omits old context on the next request', async () => {
    await server!.harness.run('CONTEXT_HISTORY_TO_KEEP')
    await browser.reload()
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：CONTEXT_HISTORY_TO_KEEP')")
    const session = await server!.harness.ctx.sessions.open(server!.harness.main().sessionId), original = await fs.readFile(session.file, 'utf8')
    const sentinel = path.join(workspace, 'context-sentinel.txt')
    await fs.writeFile(sentinel, 'project unchanged')
    await browser.fill('#input', '草稿仍然保留')
    await browser.click('#contextViewerBtn')
    await browser.click('#contextClear')
    await browser.waitFor("document.getElementById('contextClearDialog')?.open")
    expect(await browser.evaluate('document.activeElement.id')).toBe('contextClearCancel')
    expect(await browser.evaluate("document.getElementById('contextClearDialog').textContent")).toContain('历史记录、项目文件及工作区记忆均保留')
    await browser.click('#contextClearCancel')
    expect(await fs.readFile(session.file, 'utf8')).toBe(original)
    await browser.click('#contextViewerBtn')
    await browser.click('#contextClear')
    await browser.click('#contextClearConfirm')
    await browser.waitFor("!document.getElementById('contextClearDialog') && document.getElementById('chatCol').textContent.includes('上下文已清空')")
    expect((await fs.readFile(session.file, 'utf8')).startsWith(original)).toBe(true)
    expect(await fs.readFile(sentinel, 'utf8')).toBe('project unchanged')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('草稿仍然保留')
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('CONTEXT_HISTORY_TO_KEEP')
    await browser.reload()
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('上下文已清空')")
    await browser.click('#contextViewerBtn')
    expect(await browser.evaluate("document.getElementById('contextClear').disabled")).toBe(true)
    await browser.key('Escape')
    await browser.fill('#input', 'FRESH_CONTEXT_REQUEST')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：FRESH_CONTEXT_REQUEST')")
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).not.toContain('CONTEXT_HISTORY_TO_KEEP')
    expect(JSON.stringify(adapter.requests.at(-1)!.messages)).toContain('FRESH_CONTEXT_REQUEST')
  })

  it('blocks context actions mid-task and invalidates an outdated clear confirmation', async () => {
    await browser.fill('#input', '[slow] CONTEXT_RUNNING')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('stopBtn').hidden === false")
    await browser.click('#contextViewerBtn')
    expect(await browser.evaluate("['contextSettings', 'contextCompact', 'contextClear'].every(id => document.getElementById(id).disabled)")).toBe(true)
    await browser.key('Escape')
    await browser.click('#stopBtn')
    await browser.waitFor("document.getElementById('stopBtn').hidden && !document.getElementById('sendBtn').disabled")
    await browser.click('#contextViewerBtn')
    await browser.click('#contextClear')
    const session = await server!.harness.ctx.sessions.open(server!.harness.main().sessionId)
    await session.append({ type: 'user/message', payload: { content: 'NEWER_CONTEXT_CONTENT' } })
    server!.harness.ctx.emit('agent/status', { id: server!.harness.main().id, status: 'done' })
    await browser.waitFor("document.getElementById('contextClearConfirm').disabled && document.getElementById('contextClearBlocked').textContent.includes('上下文已更新')")
    await browser.click('#contextClearCancel')
    expect(JSON.stringify(session.deriveMessages())).toContain('NEWER_CONTEXT_CONTENT')
  })

  async function openSettings(section = 'general') {
    await browser.evaluate("document.getElementById('settingsViewBtn').click()")
    await browser.waitFor("!document.getElementById('settingsView').hidden")
    const id = section === 'market' ? 'marketBtn' : 'settings-' + section + 'Tab'
    await browser.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`)
  }

  async function chooseQuotaDisplay(mode: 'always' | 'hover' | 'settings') {
    await browser.click('#quotaDisplaySelectTrigger')
    await browser.key(mode === 'settings' ? 'End' : 'Home')
    if (mode === 'hover') await browser.key('ArrowDown')
    await browser.key('Enter')
  }

  async function saveQuotaDisplay(mode: 'always' | 'hover' | 'settings') {
    await chooseQuotaDisplay(mode)
    await browser.waitFor(`document.getElementById('quotaDisplaySelect').value === '${mode}' && !document.getElementById('quotaDisplaySelect').disabled && !document.getElementById('quotaDisplayMessage').classList.contains('error')`)
  }

  it('moves homepage status information into About settings while retaining account and context entry points', async () => {
    await browser.fill('#input', '状态卡片的用量')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：状态卡片的用量') && !document.getElementById('usageChip').hidden && !document.getElementById('ctxChip').hidden")
    expect(await browser.evaluate("document.querySelector('.statusbar')")).toBeNull()
    expect(await browser.evaluate("document.getElementById('workspaceStatusCard').checkVisibility()")).toBe(false)
    expect(await browser.evaluate("['connectionLabel', 'versionLabel', 'toolCount', 'ctxChip', 'usageChip', 'contextMeter'].every(id => document.getElementById('workspaceStatusCard').contains(document.getElementById(id)))")).toBe(true)
    expect(await browser.evaluate("document.getElementById('settingsViewBtn').parentElement.className")).toBe('account-row')
    expect(await browser.evaluate("document.getElementById('contextViewerBtn').checkVisibility()")).toBe(true)
    expect(await browser.evaluate("(() => { const strip = document.getElementById('sakuraAccountStrip'), composer = document.querySelector('.composer'); return strip.parentElement.id === 'composerSurface' && composer.parentElement === strip.parentElement && strip.getBoundingClientRect().bottom < composer.getBoundingClientRect().top; })()")).toBe(true)
    await openSettings('about')
    expect(await browser.evaluate("document.getElementById('workspaceStatusCard').checkVisibility()")).toBe(true)
    expect(await browser.evaluate("document.getElementById('connectionLabel').textContent")).toBe('本地服务已连接')
    expect(await browser.evaluate("document.getElementById('accessLabel').textContent")).toBe('本地工作区')
    expect(await browser.evaluate("document.getElementById('versionLabel').textContent")).not.toBe('—')
    expect(await browser.evaluate("document.getElementById('usageChip').hidden || document.getElementById('ctxChip').hidden")).toBe(false)
    await snapshot('settings-about-status')
    await browser.resize(320, 760)
    expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    await browser.evaluate("document.getElementById('settingsBack').click()")
    expect(await browser.evaluate("document.getElementById('contextViewerBtn').checkVisibility()")).toBe(true)
  })

  it('restores browser quota preferences, falls back from corrupt storage and rolls back a failed browser save', async () => {
    for (const stored of ['broken-json', '{"quotaDisplay":"never"}', '[]']) {
      await browser.evaluate(`localStorage.setItem('sakura-appearance', ${JSON.stringify(stored)})`)
      await browser.reload()
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      expect(await browser.evaluate("document.getElementById('quotaDisplaySelect').value")).toBe('always')
    }
    await openSettings('general')
    await saveQuotaDisplay('hover')
    expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-appearance'))")).toEqual({ quotaDisplay: 'hover' })
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').dataset.display")).toBe('hover')
    await openSettings('general')
    await browser.evaluate(`(() => {
      window.originalQuotaStorage = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'sakura-appearance') throw new DOMException('Browser storage is blocked', 'SecurityError');
        return window.originalQuotaStorage.call(this, key, value);
      };
    })()`)
    try {
      await chooseQuotaDisplay('settings')
      await browser.waitFor("document.getElementById('quotaDisplayMessage').classList.contains('error') && !document.getElementById('quotaDisplaySelect').disabled")
      expect(await browser.evaluate("document.getElementById('quotaDisplaySelect').value")).toBe('hover')
      expect(await browser.evaluate("document.getElementById('quotaDisplayMessage').textContent")).toContain('原显示方式已保留')
      expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-appearance')).quotaDisplay")).toBe('hover')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').dataset.display")).toBe('hover')
    } finally { await browser.evaluate('Storage.prototype.setItem = window.originalQuotaStorage; delete window.originalQuotaStorage') }
  })

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
    await browser.click('#sidebarBrandBtn')
    // Sidebar off + inspector still closed → chat takes the full width.
    expect((await dimensions()).chat).toBe(1440)
    await browser.reload()
    await browser.waitFor("document.querySelector('#menuBtn')?.getAttribute('aria-expanded') === 'false'")
    expect(await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')")).toBe('false')
    await browser.click('#menuBtn')
    await browser.click('#inspectorBtn')
    expect((await dimensions()).chat).toBe(880)
    await openSettings('general')
    await browser.click('#themeBtn')
    expect(await browser.evaluate('document.documentElement.dataset.theme')).toBe('day')
    await browser.click('#settingsBack')
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
    expect(await browser.evaluate('document.activeElement.id')).toBe('teamTab')
  })

  it('keeps chat/dashboard bounds and uses a full-width responsive settings page without changing inspector preferences', async () => {
    for (const inspector of [false, true]) {
      await browser.resize(1440)
      await browser.evaluate("document.getElementById('chatViewBtn').click()")
      if (await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')") !== String(inspector)) {
        await browser.click('#inspectorBtn')
      }
      for (const width of [1440, 1920, 1000, 390, 320]) {
        await browser.resize(width)
        await browser.evaluate("document.getElementById('chatViewBtn').click()")
        const expanded = await browser.evaluate<string>("document.getElementById('inspectorBtn').getAttribute('aria-expanded')")
        const savedLayout = await browser.evaluate<string | null>("localStorage.getItem('sakura-layout')")
        const sizes: Array<{ main: number[]; content: number[]; padding: string }> = []
        for (const [button, selector] of [['chatViewBtn', '#chatCol'], ['dashboardBtn', '.dashboard-inner'], ['settingsViewBtn', '.settings-inner']]) {
          await browser.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`)
          const size = await browser.evaluate<{
            main: number[]; content: number[]; padding: string; overflow: boolean; bodyPadding: string; inspector: string
          }>(`(() => {
            const content = document.querySelector(${JSON.stringify(selector)});
            const main = document.getElementById('mainWorkspace').getBoundingClientRect();
            const r = content.getBoundingClientRect();
            return {
              main: [main.x, main.y, main.width, main.height], content: [r.x, r.y, r.width],
              padding: getComputedStyle(content).paddingLeft,
              overflow: document.documentElement.scrollWidth > innerWidth || content.scrollWidth > content.clientWidth,
              bodyPadding: getComputedStyle(document.body).padding,
              inspector: document.getElementById('inspectorBtn').getAttribute('aria-expanded')
            };
          })()`)
          expect(size.overflow, `${width}px / ${button} / inspector=${inspector}`).toBe(false)
          expect(size.bodyPadding).toBe('0px')
          expect(size.inspector).toBe(button === 'settingsViewBtn' ? 'false' : expanded)
          expect(await browser.evaluate("localStorage.getItem('sakura-layout')")).toBe(savedLayout)
          expect(size.content[2]).toBeLessThanOrEqual(button === 'settingsViewBtn' ? 960 : 880)
          sizes.push(size)
        }
        for (const size of sizes.slice(1, 2)) {
          expect(size.main).toEqual(sizes[0]!.main)
          expect(size.content).toEqual(sizes[0]!.content)
          expect(size.padding).toBe(sizes[0]!.padding)
        }
        expect(sizes[2]!.main[2]).toBeGreaterThanOrEqual(sizes[0]!.main[2]!)
    await browser.evaluate("document.getElementById('settingsBack').click()")
        expect(await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')")).toBe(expanded)
        expect(await browser.evaluate("localStorage.getItem('sakura-layout')")).toBe(savedLayout)
        expect(await browser.evaluate("(() => { const r = document.getElementById('mainWorkspace').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")).toEqual(sizes[0]!.main)
      }
    }
  })

  it('requires a destructive confirmation, supports Enter/Escape cancellation and returns deleted current sessions to a blank chat', async () => {
    await browser.fill('#input', '需要确认才能删除的会话')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：需要确认才能删除的会话') && document.getElementById('stopBtn').hidden && document.querySelector('.session-more')")
    const id = server!.harness.main().sessionId
    const session = await server!.harness.ctx.sessions.open(id)
    await browser.fill('#input', '保留未发送的草稿')
    await sessionAction(browser, 'delete', id)
    await browser.waitFor("document.getElementById('deleteSessionDialog')?.open")
    const description = await browser.evaluate<string>("document.getElementById('deleteSessionDialog').textContent")
    expect(description).toContain('不可撤销')
    expect(description).toContain('不会删除或回滚项目文件')
    expect(await browser.evaluate('document.activeElement.id')).toBe('deleteSessionCancel')
    await browser.key('Enter')
    await browser.waitFor("!document.getElementById('deleteSessionDialog')")
    expect((await fs.stat(session.file)).isFile()).toBe(true)
    await sessionAction(browser, 'delete', id)
    await browser.key('Escape')
    await browser.waitFor("!document.getElementById('deleteSessionDialog')")
    expect(server!.harness.main().sessionId).toBe(id)
    await sessionAction(browser, 'delete', id)
    await browser.click('#deleteSessionConfirm')
    await browser.waitFor("!document.getElementById('deleteSessionDialog') && !document.querySelector('.session-item') && !document.getElementById('welcome').hidden && !document.getElementById('input').disabled")
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('已完成：需要确认才能删除的会话')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留未发送的草稿')
    expect(await browser.evaluate("document.getElementById('usageChip').hidden && document.getElementById('ctxChip').hidden")).toBe(true)
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && !document.querySelector('.session-item') && !document.getElementById('welcome').hidden")
  })

  it('restores delete controls and keeps the live chat after an API failure, then permits an explicit retry', async () => {
    await server!.harness.run('删除失败后保留上下文')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：删除失败后保留上下文') && document.querySelector('.session-more')")
    const id = server!.harness.main().sessionId
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('DELETE_UI_DENIED'), { code: 'EACCES' }))
    try {
      await sessionAction(browser, 'delete', id)
      await browser.click('#deleteSessionConfirm')
      await browser.waitFor("document.querySelector('#deleteSessionDialog .form-error')?.textContent.includes('DELETE_UI_DENIED') && !document.getElementById('deleteSessionConfirm').disabled && !document.getElementById('deleteSessionCancel').disabled")
      expect(server!.harness.main().sessionId).toBe(id)
      expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('已完成：删除失败后保留上下文')
      expect(await browser.evaluate("document.querySelector('#sessionContextMenu [data-session-action=delete]').disabled")).toBe(false)
    } finally { rm.mockRestore() }
    await browser.click('#deleteSessionConfirm')
    await browser.waitFor("!document.getElementById('deleteSessionDialog') && !document.querySelector('.session-item')")
  })

  it('explains running-session protection and enables deletion only after the task settles', async () => {
    await browser.fill('#input', '[slow] 删除保护检查')
    await browser.click('#sendBtn')
    await browser.waitFor("document.querySelector('.session-more')")
    await openSessionMenu(browser)
    await browser.waitFor("document.querySelector('#sessionContextMenu [data-session-action=delete]')?.title.includes('运行')")
    await browser.click('#sessionContextMenu [data-session-action=delete]')
    await browser.waitFor("document.getElementById('deleteSessionDialog')?.open && document.getElementById('deleteSessionConfirm').disabled")
    expect(await browser.evaluate("document.getElementById('deleteSessionBlocked').textContent")).toContain('仍在运行')
    await browser.click('#deleteSessionCancel')
    await browser.click('#stopBtn')
    await browser.waitFor("document.getElementById('stopBtn').hidden")
    await sessionAction(browser, 'delete')
    expect(await browser.evaluate("document.getElementById('deleteSessionConfirm').disabled")).toBe(false)
    await browser.click('#deleteSessionCancel')
  })

  it('closes an obsolete confirmation on reconnect so it cannot leave an enabled but unresponsive delete button', async () => {
    await server!.harness.run('重连前的确认框')
    await browser.waitFor("document.querySelector('.session-more') && document.getElementById('chatCol').textContent.includes('已完成：重连前的确认框')")
    const id = server!.harness.main().sessionId
    await sessionAction(browser, 'delete', id)
    await browser.waitFor("document.getElementById('deleteSessionDialog')?.open")
    await browser.send('Network.enable')
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    server!.server.closeAllConnections()
    try {
      await browser.waitFor("document.getElementById('connectionLabel').textContent.includes('断开')")
      await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      await browser.waitFor("!document.getElementById('deleteSessionDialog')")
      expect(server!.harness.main().sessionId).toBe(id)
      await sessionAction(browser, 'delete', id)
      await browser.click('#deleteSessionConfirm')
      await browser.waitFor("!document.getElementById('deleteSessionDialog') && !document.querySelector('.session-item')")
    } finally {
      await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    }
  })

  it('ignores a delayed deletion response after another client switches to a new live session', async () => {
    await server!.harness.run('将删除的旧会话')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：将删除的旧会话') && document.querySelector('.session-more')")
    const id = server!.harness.main().sessionId
    const target = await server!.harness.ctx.sessions.create({ title: '新实时会话' })
    await target.append({ type: 'user/message', payload: { content: '新会话历史不得被旧响应清空' } })
    await browser.evaluate(`(() => {
      const nativeFetch = window.fetch.bind(window);
      window.deleteResponseHeld = false;
      window.fetch = async function (url, options) {
        const response = await nativeFetch(url, options);
        if (options?.method === 'DELETE') {
          window.deleteResponseHeld = true;
          await new Promise(resolve => { window.releaseDeleteResponse = resolve; });
        }
        return response;
      };
    })()`)
    try {
      await sessionAction(browser, 'delete', id)
      await browser.waitFor("document.getElementById('deleteSessionDialog')?.open && !document.getElementById('deleteSessionConfirm').disabled")
      await browser.click('#deleteSessionConfirm')
      await browser.waitFor('window.deleteResponseHeld === true')
      expect((await fetch(server!.url + 'api/sessions', { method: 'POST', body: JSON.stringify({ id: target.id }) })).status).toBe(200)
      await browser.waitFor("document.getElementById('chatCol').textContent.includes('新会话历史不得被旧响应清空')")
      await browser.evaluate('window.releaseDeleteResponse()')
      await browser.waitFor("!document.getElementById('deleteSessionDialog') && document.querySelector('.session-more')")
      expect(server!.harness.main().sessionId).toBe(target.id)
      expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('新会话历史不得被旧响应清空')
    } finally { await browser.evaluate('window.releaseDeleteResponse?.()') }
  })

  it('invalidates a deletion dialog and delayed records when the same workspace remounts on a different session root', async () => {
    const desktop = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true,
      updatesAutoCheck: false, onPersistSettings() {} })
    const alternateRoot = path.join(workspace, 'alternate-sessions')
    try {
      const original = await desktop.harness.ctx.sessions.create({ title: 'OLD_ROOT_RECORDS' })
      await original.append({ type: 'user/message', payload: { content: 'OLD_ROOT_RECORDS' } })
      await fs.mkdir(path.join(alternateRoot, original.id), { recursive: true })
      await fs.writeFile(path.join(alternateRoot, original.id, 'session.jsonl'), JSON.stringify({
        seq: 1, time: new Date().toISOString(), type: 'user/message', payload: { content: 'NEW_ROOT_RECORDS' },
      }) + '\n')
      await browser.navigate(desktop.url)
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.querySelector('.session-more')")
      await browser.evaluate(`(() => {
        const nativeFetch = window.fetch.bind(window);
        let held = false;
        window.oldRecordsPending = false;
        window.oldRecordsReleased = false;
        window.fetch = async function (url, options) {
          const response = await nativeFetch(url, options);
          if (!held && String(url).includes('/api/sessions/${original.id}/records')) {
            held = true;
            window.oldRecordsPending = true;
            await new Promise(resolve => { window.releaseOldRecords = resolve; });
            window.oldRecordsReleased = true;
          }
          return response;
        };
      })()`)
      await browser.click(`[data-session-id="${original.id}"] .session-open`)
      await browser.waitFor('window.oldRecordsPending === true')
      await sessionAction(browser, 'delete', original.id)
      await browser.waitFor("document.getElementById('deleteSessionDialog')?.open")
      const response = await fetch(desktop.url + 'api/desktop/settings', {
        method: 'POST', body: JSON.stringify({ sessionDir: alternateRoot }),
      })
      expect(response.status).toBe(200)
      await browser.waitFor("!document.getElementById('deleteSessionDialog') && document.querySelector('.session-more') && document.querySelector('.session-title')?.textContent === 'NEW_ROOT_RECORDS'")
      await browser.click(`[data-session-id="${original.id}"] .session-open`)
      await browser.waitFor("document.getElementById('chatCol').textContent.includes('NEW_ROOT_RECORDS')")
      await browser.evaluate('window.releaseOldRecords()')
      await browser.waitFor('window.oldRecordsReleased === true')
      await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('OLD_ROOT_RECORDS')
      expect((await fs.stat(original.file)).isFile()).toBe(true)
      expect((await fs.stat(path.join(alternateRoot, original.id, 'session.jsonl'))).isFile()).toBe(true)
    } finally {
      await browser.evaluate('window.releaseOldRecords?.()').catch(() => {})
      await desktop.close()
    }
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
    // Synthetic tool frames are not persisted. Reload after the real turns
    // and wait for their disk replay before adding these live-only cards.
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.getElementById('totalAgents').textContent === '2' && document.getElementById('chatCol').textContent.includes('已完成：prepare session')")
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
    // Spawn/status events precede the revision-checked snapshot that carries
    // newly persisted session IDs. A roster count alone can leave the action's
    // closure pointing at the pre-turn session. Start this late-response test
    // from the authoritative settled roster; do not retry a lost click.
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && document.getElementById('totalAgents').textContent === '3'")
    const originalOpen = server!.harness.ctx.sessions.open.bind(server!.harness.ctx.sessions)
    let release!: () => void
    const holding = new Promise<void>(resolve => { release = resolve })
    let readerRequests = 0
    const spy = vi.spyOn(server!.harness.ctx.sessions, 'open').mockImplementation(async id => {
      if (id === first.sessionId) { readerRequests++; await holding }
      return originalOpen(id)
    })
    try {
      await browser.click('#inspectorBtn')
      await browser.waitFor("document.querySelector('.collaboration-workspace') && !document.getElementById('collaborationRefresh').disabled")
      await browser.click(`[data-agent-id="${first.id}"] .agent-view`)
      await vi.waitFor(() => expect(readerRequests).toBe(1), { timeout: 8000 })
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
    await openSettings('market')
    await browser.fill('#pluginSearch', 'review')
    expect(await browser.evaluate("document.querySelectorAll('#pluginList .extension-card').length")).toBe(1)
    expect(await browser.evaluate("document.querySelector('#pluginList').textContent")).toContain('review-check')
    expect(await browser.evaluate("document.querySelectorAll('#pluginList img').length")).toBe(0)
    expect(await browser.evaluate("document.querySelector('#toolList').textContent")).toContain('review_check')
    expect(await browser.evaluate("document.querySelector('#externalCount').textContent")).toBe('1 外部')
    await browser.fill('#pluginSearch', 'no-such-extension')
    expect(await browser.evaluate("document.querySelector('#pluginList').textContent")).toContain('没有匹配')
    await browser.fill('#pluginSearch', '')
    await snapshot('workspace-local-plugins')
    await browser.evaluate("document.getElementById('settings-mcpTab').focus()")
    await browser.key('ArrowUp')
    expect(await browser.evaluate('document.activeElement.id')).toBe('settings-skillsTab')
    expect(await browser.evaluate("document.getElementById('settings-skillsPanel').hidden")).toBe(false)
  })

  it('unifies select popups with keyboard navigation and preserves theme/model behaviour', async () => {
    await browser.click('#approvalSelBottomTrigger')
    await browser.waitFor("document.querySelector('.select-menu:popover-open')")
    await browser.key('ArrowDown')
    await browser.key('Enter')
    await browser.waitFor("document.getElementById('approvalSelBottom').value === 'acceptEdits'")
    const state = await (await fetch(server!.url + 'api/state')).json() as { approvalMode: string }
    expect(state.approvalMode).toBe('acceptEdits')
    expect(await browser.evaluate("document.getElementById('approvalSelBottomTrigger').textContent")).toContain('自动编辑')
    await openSettings('general')
    await browser.click('#themeSelectTrigger')
    await browser.key('End')
    await browser.key('Enter')
    expect(await browser.evaluate('document.documentElement.dataset.theme')).toBe('day')
    await browser.click('#themeSelectTrigger')
    await browser.key('Escape')
    expect(await browser.evaluate('document.activeElement.id')).toBe('themeSelectTrigger')
    expect(await browser.evaluate("document.querySelector('.select-menu')")).toBeNull()
    await snapshot('settings-general-day')
    await browser.resize(390, 844)
    await snapshot('settings-general-mobile-day')
    expect(await browser.evaluate('document.documentElement.scrollWidth === innerWidth')).toBe(true)
    await browser.resize(1440)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    expect(await browser.evaluate('document.documentElement.dataset.theme')).toBe('day')
  })

  it('supports hover quota overlays without reflow, accessible actions, touch dismissal and settings-only account access', async () => {
    const pages: string[] = []
    const account = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true,
      sakuraApi: { apiKey: authorizedKey, keyName: 'synthetic', model: 'gpt-test' },
      sakuraApiFetch: sakuraApiResponse as typeof fetch, sakuraApiOpenPage: async page => { pages.push(page) } })
    try {
      await browser.navigate(account.url)
      await browser.waitFor("document.getElementById('accountUsername').textContent === 'SakuraAPI 已授权' && !document.getElementById('sakuraStripRefresh').disabled")
      await openSettings('general')
      await saveQuotaDisplay('hover')
    await browser.click('#settingsBack')
      await browser.hover('#sessionHeading')
      await browser.evaluate('document.activeElement.blur()')
      await browser.waitFor("document.getElementById('sakuraQuotaBtn').getAttribute('aria-expanded') === 'false'")
      const bounds = () => browser.evaluate<number[]>("(() => { const r = document.querySelector('.composer').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()")
      const before = await bounds()
      await browser.hover('#input')
      await browser.waitFor("document.getElementById('sakuraAccountStrip').matches(':popover-open')")
      await browser.evaluate('new Promise(resolve => setTimeout(resolve, 200))')
      expect(await bounds()).toEqual(before)
      expect(await browser.evaluate("(() => { const strip = document.getElementById('sakuraAccountStrip').getBoundingClientRect(), composer = document.querySelector('.composer').getBoundingClientRect(); return strip.bottom <= composer.top && strip.left >= 8 && strip.right <= innerWidth - 7; })()")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraAccountStripText').textContent")).toContain('周 · 剩余 ¥35.00')
      await snapshot('quota-hover-desktop')
      await browser.click('#sakuraStripRefresh')
      await browser.waitFor("!document.getElementById('sakuraStripRefresh').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').matches(':popover-open')")).toBe(true)
      await browser.click('#sakuraStripPurchase')
      await vi.waitFor(() => expect(pages).toEqual(['purchase']))
      await browser.hover('#sessionHeading')
      await browser.evaluate('document.activeElement.blur()')
      await browser.waitFor("document.getElementById('sakuraQuotaBtn').getAttribute('aria-expanded') === 'false'")
      await browser.evaluate("document.getElementById('sakuraQuotaBtn').focus()")
      await browser.key('ArrowUp')
      expect(await browser.evaluate('document.activeElement.id')).toBe('sakuraStripRefresh')
      await browser.key('Tab')
      expect(await browser.evaluate('document.activeElement.id')).toBe('sakuraStripPurchase')
      await browser.key('Escape')
      expect(await browser.evaluate('document.activeElement.id')).toBe('sakuraQuotaBtn')
      expect(await browser.evaluate("document.getElementById('sakuraQuotaBtn').getAttribute('aria-expanded')")).toBe('false')
      for (const width of [390, 320]) {
        await browser.resize(width, 760)
        await browser.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
        await browser.hover('#sessionHeading')
        await browser.evaluate('document.activeElement.blur()')
        await browser.tap('#sakuraQuotaBtn')
        await browser.waitFor("document.getElementById('sakuraAccountStrip').matches(':popover-open')")
        await browser.evaluate('new Promise(resolve => setTimeout(resolve, 200))')
        expect(await browser.evaluate("(() => { const r = document.getElementById('sakuraAccountStrip').getBoundingClientRect(), c = document.querySelector('.composer').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom < c.top && document.documentElement.scrollWidth <= innerWidth; })()")).toBe(true)
        await snapshot('quota-hover-touch-' + width)
        await browser.tap('#sakuraStripClose')
        expect(await browser.evaluate("document.getElementById('sakuraQuotaBtn').getAttribute('aria-expanded')")).toBe('false')
        await browser.tap('#sakuraQuotaBtn')
        await browser.tap('#sessionHeading')
        expect(await browser.evaluate("document.getElementById('sakuraQuotaBtn').getAttribute('aria-expanded')")).toBe('false')
      }
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await browser.resize(1440)
      await browser.evaluate("document.getElementById('sakuraAccountStrip').showPopover = undefined; document.getElementById('sakuraAccountStrip').hidePopover = undefined")
      await browser.click('#sakuraQuotaBtn')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').classList.contains('quota-fallback-open')")).toBe(true)
      await browser.key('Escape')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').classList.contains('quota-fallback-open')")).toBe(false)
      await openSettings('general')
      await saveQuotaDisplay('settings')
    await browser.click('#settingsBack')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').checkVisibility() || document.getElementById('sakuraQuotaBtn').checkVisibility()")).toBe(false)
      await browser.click('#sakuraAccountBtn')
      expect(await browser.evaluate("document.getElementById('sakuraBalance').textContent")).toBe('5.09')
      expect(await browser.evaluate("document.querySelector('#sakuraSubscriptions [data-period=weekly] .subscription-remaining').textContent")).toBe('剩余 ¥35.00')
      expect(await browser.evaluate("document.querySelector('#sakuraSubscriptions [data-period=weekly] progress').value")).toBe(87.5)
      await browser.click('#sakuraPurchase')
      await vi.waitFor(() => expect(pages).toEqual(['purchase', 'purchase']))
      await browser.click('#sakuraRefresh')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled")
      await openSettings('general')
      await saveQuotaDisplay('always')
    await browser.click('#settingsBack')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').checkVisibility()")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').style.width")).toBe('')
      expect(await browser.evaluate("document.body.innerHTML + JSON.stringify(localStorage)")).not.toContain(authorizedKey)
    } finally {
      await browser.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {})
      await browser.navigate(server!.url)
      await account.close()
    }
  })

  it('uses acknowledged desktop quota persistence instead of browser storage and restores or rolls back the selected mode', async () => {
    let accept: (() => void) | undefined, fail = false
    const persisted: unknown[] = []
    const desktop = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true,
      onPersistSettings() {}, appearance: { quotaDisplay: 'settings' }, onPersistAppearance: async settings => {
        persisted.push(settings)
        await new Promise<void>(resolve => { accept = resolve })
        if (fail) throw new Error('DESKTOP_DISK_FAILURE')
      } })
    try {
      await browser.navigate(desktop.url)
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      await browser.evaluate("localStorage.setItem('sakura-appearance', JSON.stringify({quotaDisplay: 'always'}))")
      await browser.reload()
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      expect(await browser.evaluate("document.getElementById('quotaDisplaySelect').value")).toBe('settings')
      await openSettings('general')
      expect(await browser.evaluate("document.getElementById('quotaDisplayHelp').textContent")).toContain('重启、更换端口')
      await chooseQuotaDisplay('hover')
      await vi.waitFor(() => expect(persisted).toHaveLength(1))
      expect(await browser.evaluate("document.getElementById('quotaDisplaySelect').disabled")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').dataset.display")).toBe('settings')
      expect(await (await fetch(desktop.url + 'api/desktop/appearance')).json()).toEqual({ quotaDisplay: 'settings' })
      accept!()
      await browser.waitFor("!document.getElementById('quotaDisplaySelect').disabled && document.getElementById('sakuraAccountStrip').dataset.display === 'hover'")
      expect(await browser.evaluate("JSON.parse(localStorage.getItem('sakura-appearance')).quotaDisplay")).toBe('always')
      await browser.reload()
      await browser.waitFor("document.getElementById('sakuraAccountStrip').dataset.display === 'hover' && document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      await openSettings('general')
      fail = true
      await chooseQuotaDisplay('always')
      await vi.waitFor(() => expect(persisted).toHaveLength(2))
      accept!()
      await browser.waitFor("document.getElementById('quotaDisplayMessage').classList.contains('error') && !document.getElementById('quotaDisplaySelect').disabled")
      expect(await browser.evaluate("document.getElementById('quotaDisplaySelect').value")).toBe('hover')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').dataset.display")).toBe('hover')
      expect(await (await fetch(desktop.url + 'api/desktop/appearance')).json()).toEqual({ quotaDisplay: 'hover' })
      expect(await browser.evaluate("document.getElementById('quotaDisplayMessage').textContent")).toContain('原显示方式已保留')
    } finally { accept?.(); await browser.navigate(server!.url); await desktop.close() }
  })

  it('connects account PKCE, shows real identity/VIP, requires a Key selection and locks the desktop upstream', async () => {
    const persisted: unknown[] = []
    const pages: string[] = []
    const draft = clientDraft()
    const window = { draft, readAuthorization: async () => clientAuthorization(draft.state), close: async () => {} }
    const accountServer = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true,
      sakuraApiOnly: true, onPersistSettings: () => {},
      onPersistSakuraApi: async value => { persisted.push(value) }, sakuraApiOpenLogin: async () => window,
      sakuraApiFetch: sakuraClientResponse as typeof fetch, sakuraApiOpenPage: async page => { pages.push(page) } })
    try {
      await browser.navigate(accountServer.url)
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      expect(await browser.evaluate("document.getElementById('settingsViewBtn').parentElement.className")).toBe('account-row')
      await browser.click('#sakuraAccountBtn')
      await browser.waitFor("!document.getElementById('settings-accountPanel').hidden && !document.getElementById('sakuraLogin').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraRemember').checked")).toBe(true)
      await browser.click('#sakuraLogin')
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraConfirm')")).toBeNull()
      await browser.waitFor("[...document.querySelectorAll('#settings-accountPanel .vip-badge img')].every(img=>img.complete && img.naturalWidth>0)")
      expect(await browser.evaluate("document.querySelector('#sakuraVipBadge img').getAttribute('src')")).toBe('/assets/vip/vip-7.png')
      expect(await browser.evaluate("document.getElementById('settingsAccountEmail').textContent")).toBe(clientUser.email)
      expect(await browser.evaluate("document.querySelectorAll('#accountUsername img').length")).toBe(0)
      expect(await browser.evaluate("document.getElementById('accountLabel').textContent")).toContain('待选择 Key')
      expect(await browser.evaluate("document.getElementById('sakuraBalance').textContent")).toBe('5.09')
      expect(persisted[0]).toMatchObject({ client: { accessToken: clientAccessToken } })
      expect((persisted[0] as {apiKey?:string}).apiKey).toBeUndefined()
      expect((await (await fetch(accountServer.url + 'api/state')).json()) as {modelStatus:{configured:boolean}}).toMatchObject({modelStatus:{configured:false}})
      expect(noClientSecrets(await browser.evaluate("JSON.stringify(localStorage) + document.body.innerHTML"))).toBe(true)
      expect(await browser.evaluate("document.querySelectorAll('.vip-badge').length")).toBe(1)
      expect(await browser.evaluate("document.querySelectorAll('#sakuraAccountBtn .vip-badge, .settings-account-summary .vip-badge').length")).toBe(0)
      expect(await browser.evaluate("document.querySelector('#settings-accountPanel #sakuraKeyCard')")).toBeNull()
      expect(await browser.evaluate("document.getElementById('sakuraOpenModels')")).toBeNull()
      await browser.click('#settings-modelsTab')
      await browser.waitFor("!document.getElementById('settings-modelsPanel').hidden && document.getElementById('sakuraKeyCard').checkVisibility()")
      await browser.click('#sakuraKeySelectTrigger')
      await browser.key('End')
      await browser.key('Enter')
      await browser.click('#sakuraKeyUse')
      await browser.waitFor("document.getElementById('accountLabel').textContent.includes('已选择 Key') && !document.getElementById('sakuraRefresh').disabled")
      expect(persisted.at(-1)).toMatchObject({apiKey:authorizedKey, keyId:101, model:'gpt-test'})
      await browser.click('#sakuraKeysSync')
      await browser.waitFor("document.getElementById('sakuraRequests').textContent === '12' && !document.getElementById('sakuraKeysSync').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraSubscriptions').textContent")).toContain('剩余 ¥8.00')
      expect(await browser.evaluate("document.querySelectorAll('#sakuraSubscriptions img').length")).toBe(0)
      await browser.click('#sakuraModelAccount')
      await browser.waitFor("!document.getElementById('settings-accountPanel').hidden")
      await snapshot('settings-account')
      await openSettings('models')
      expect(await browser.evaluate("document.getElementById('settingsBaseUrl').checkVisibility()")).toBe(false)
      expect(await browser.evaluate("document.getElementById('settingsApiKey').checkVisibility()")).toBe(false)
      expect(await browser.evaluate("[...document.querySelectorAll('#sakuraModelSelect option')].map(o=>o.value)")).toEqual(modelIds)
      await browser.click('#sakuraModelSelectTrigger')
      await browser.key('End')
      await browser.key('Enter')
      await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).modelStatus.model === 'responses-test')()")
      await snapshot('settings-sakuraapi-models')
    await browser.click('#settingsBack')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStrip').checkVisibility()")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraAccountStripText').textContent")).toContain('余额 ¥5.09')
      expect(await browser.evaluate("document.getElementById('sakuraAccountStripText').textContent")).toContain('周 · 剩余 ¥35.00')
      await browser.fill('#input', '验证授权模型')
      await browser.click('#sendBtn')
      await browser.waitFor("document.getElementById('chatCol').textContent.includes('SYNTHETIC_MODEL_REPLY')")
      await browser.click('#sakuraStripPurchase')
      await vi.waitFor(() => expect(pages).toEqual(['purchase']))
      await browser.resize(390, 844)
      expect(await browser.evaluate('document.documentElement.scrollWidth === innerWidth')).toBe(true)
      await snapshot('sakuraapi-composer-mobile')
      await browser.resize(1440)
      await browser.reload()
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
      await browser.click('#sakuraAccountBtn')
      await browser.waitFor("!document.getElementById('sakuraLogout').disabled")
      await browser.click('#sakuraLogout')
      await browser.waitFor("document.getElementById('accountUsername').textContent === '登录 SakuraAPI'")
      expect(await browser.evaluate("document.getElementById('sakuraVipCard').hidden")).toBe(true)
      expect(persisted.at(-1)).toBeNull()
    } finally { await accountServer.close() }
  })

  it('uses all ten embedded VIP images, falls back safely, and requires a cancel-first creation confirmation', async () => {
    let vip: unknown = clientVip
    const creates: RequestInit[] = []
    const account = await runWebServer({cwd:workspace,open:false,quiet:true,sakuraApi:clientSaved(),
      sakuraApiFetch:(async(url,init)=>{
        if(String(url).includes('/snapshot-v2'))return envelope({vip})
        if(String(url).endsWith('/api/v1/keys')&&init?.method==='POST')creates.push(init)
        return sakuraClientResponse(url,init)
      }) as typeof fetch})
    try {
      await browser.navigate(account.url)
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username))
      await browser.click('#sakuraAccountBtn')
      await browser.waitFor("!document.getElementById('sakuraKeyPrepare').disabled")
      await browser.click('#settings-modelsTab')
      await browser.fill('#sakuraKeyName','<img src=x> 明确创建')
      await browser.click('#sakuraKeyGroups input[value="7"]')
      await browser.click('#sakuraKeyPrepare')
      await browser.waitFor("document.getElementById('sakuraKeyDialog').open && !document.getElementById('sakuraKeyDialogCancel').disabled")
      expect(await browser.evaluate('document.activeElement.id')).toBe('sakuraKeyDialogCancel')
      expect(await browser.evaluate("document.querySelectorAll('#sakuraKeyDialogSummary img').length")).toBe(0)
      expect(creates).toHaveLength(0)
      await browser.click('#sakuraKeyDialogCancel')
      await browser.waitFor("!document.getElementById('sakuraKeyDialog').open && !document.getElementById('sakuraKeyPrepare').disabled")
      expect(creates).toHaveLength(0)
      await browser.click('#sakuraKeyPrepare')
      await browser.waitFor("document.getElementById('sakuraKeyDialog').open && !document.getElementById('sakuraKeyDialogConfirm').disabled")
      await browser.click('#sakuraKeyDialogConfirm')
      await browser.waitFor("!document.getElementById('sakuraKeyDialog').open && document.getElementById('accountLabel').textContent.includes('已选择 Key')")
      expect(creates).toHaveLength(1)
      expect(new Headers(creates[0]!.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
      expect(noClientSecrets(await browser.evaluate("document.body.innerHTML + JSON.stringify(localStorage)"))).toBe(true)
      await browser.click('#sakuraModelAccount')
      for(let level=1;level<=10;level++) {
        vip={...clientVip,level,effective_level:level}
        await browser.click('#sakuraRefresh')
        await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && document.getElementById('sakuraVipBadge').dataset.vipLevel === '"+level+"' && document.querySelector('#sakuraVipBadge img').naturalWidth > 0")
        expect(await browser.evaluate("document.querySelector('#sakuraVipBadge img').getAttribute('src')")).toBe('/assets/vip/vip-'+level+'.png')
        expect(await browser.evaluate("document.querySelectorAll('.vip-badge img').length")).toBe(1)
      }
      for(const invalid of [{...clientVip,level:0,effective_level:0},{...clientVip,level:11,effective_level:11},{...clientVip,enabled:false},{...clientVip,level:'7'}]) {
        vip=invalid;await browser.click('#sakuraRefresh')
        await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && !document.querySelector('#sakuraVipBadge img')")
        expect(await browser.evaluate("document.getElementById('sakuraVipBadge').textContent.length > 0")).toBe(true)
      }
      vip=undefined;await browser.click('#sakuraRefresh')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && document.getElementById('sakuraVipBadge').textContent === 'VIP 信息未提供'")
      for(const theme of ['day','night']) {
        await browser.evaluate("document.documentElement.dataset.theme="+JSON.stringify(theme))
        await browser.resize(390,844)
        expect(await browser.evaluate('document.documentElement.scrollWidth === innerWidth')).toBe(true)
        await snapshot('client-vip-fallback-'+theme+'-mobile')
      }
      await browser.resize(1440)
    } finally {await account.close()}
  })

  it('renders independent daily/weekly/monthly quota bars without fabricating missing or unlimited progress', async () => {
    const subscription = { id: clientSubscriptions[0]!.id, user_id: clientUser.id, status: 'active',
      expires_at: clientSubscriptions[0]!.expires_at, group: { name: '<img src=x> 独立周期订阅' } }
    let progress: Record<string, unknown> = { id: subscription.id,
      daily: { limit_usd: 10, used_usd: 9, remaining_usd: 8, resets_at: '2099-01-02T00:00:00Z' },
      weekly: { limit_usd: 40, used_usd: 5, remaining_usd: 35 },
      monthly: { limit_usd: 100, used_usd: 25, remaining_usd: 75 } }
    const account = await runWebServer({ cwd: workspace, open: false, quiet: true, sakuraApi: clientSaved(),
      sakuraApiFetch: (async (url, init) => {
        if (String(url).endsWith('/subscriptions/active')) return envelope([subscription])
        if (String(url).endsWith('/subscriptions/progress')) return envelope([{ subscription, progress }])
        return sakuraClientResponse(url, init)
      }) as typeof fetch })
    const windows = () => browser.evaluate<Array<{ period: string; amount: string; value: number | null; max: number | null; detail: string; low: string | null }>>(`
      [...document.querySelectorAll('#sakuraSubscriptions .subscription-window')].map(row => ({
        period: row.dataset.period, amount: row.querySelector('.subscription-remaining').textContent,
        value: row.querySelector('progress')?.value ?? null, max: row.querySelector('progress')?.max ?? null,
        detail: row.textContent, low: row.dataset.low ?? null
      }))`)
    try {
      await browser.navigate(account.url)
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraRefresh').disabled")
      await browser.click('#sakuraAccountBtn')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && document.querySelector('#sakuraSubscriptions [data-period=daily] progress')?.value === 80")
      expect(await windows()).toMatchObject([
        { period: 'daily', amount: '剩余 ¥8.00', value: 80, max: 100 },
        { period: 'weekly', amount: '剩余 ¥35.00', value: 87.5, max: 100 },
        { period: 'monthly', amount: '剩余 ¥75.00', value: 75, max: 100 },
      ])
      expect((await windows())[0]!.detail).toContain('重置于')
      expect(await browser.evaluate("document.querySelector('#sakuraSubscriptions [data-period=daily] progress').getAttribute('aria-valuetext')")).toContain('80%')
      expect(await browser.evaluate("document.querySelectorAll('#sakuraSubscriptions img').length")).toBe(0)
      expect(await browser.evaluate("document.getElementById('sakuraSubscriptionSource').textContent")).toContain('不相加')
      for (const theme of ['day', 'night']) {
        await browser.evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme))
        for (const width of [1440, 390]) {
          await browser.resize(width, width === 390 ? 844 : 960)
          await browser.evaluate("document.getElementById('sakuraSubscriptionCard').scrollIntoView({block:'center'})")
          expect(await browser.evaluate('document.documentElement.scrollWidth === innerWidth')).toBe(true)
          expect(await browser.evaluate("[...document.querySelectorAll('#sakuraSubscriptions progress')].every(bar=>bar.checkVisibility() && bar.getBoundingClientRect().width>50)")).toBe(true)
          await snapshot('subscription-periods-' + theme + '-' + width)
        }
      }
      await browser.resize(1440)
      progress = { id: subscription.id, daily: { limit_usd: 10, used_usd: 15, remaining_usd: 0 },
        weekly: { limit_usd: 40, used_usd: 0, remaining_usd: 40 }, monthly: { limit_usd: 100, used_usd: 0, remaining_usd: 175 } }
      await browser.click('#sakuraRefresh')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && document.querySelector('#sakuraSubscriptions [data-period=daily] progress')?.value === 0")
      expect(await windows()).toMatchObject([
        { period: 'daily', amount: '剩余 ¥0.00', value: 0, low: 'true' },
        { period: 'weekly', amount: '剩余 ¥40.00', value: 100, low: 'false' },
        { period: 'monthly', amount: '剩余 ¥175.00', value: 100, low: 'false' },
      ])
      progress = { id: subscription.id, daily: { limit_usd: 10, used_usd: 2 },
        weekly: { limit_usd: 0, used_usd: 20, remaining_usd: 0 }, monthly: { used_usd: 1, remaining_usd: 9 } }
      await browser.click('#sakuraRefresh')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && !document.querySelector('#sakuraSubscriptions progress')")
      expect(await windows()).toMatchObject([
        { period: 'daily', amount: '余量未提供', value: null },
        { period: 'weekly', amount: '不限额', value: null },
        { period: 'monthly', amount: '余量未提供', value: null },
      ])
      expect((await windows())[0]!.detail).toContain('上限 ¥10.00')
      expect((await windows())[1]!.detail).not.toContain('剩余 ¥0.00')
      progress = { id: subscription.id }
      await browser.click('#sakuraRefresh')
      await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && [...document.querySelectorAll('#sakuraSubscriptions .subscription-remaining')].every(row=>row.textContent==='余量未提供')")
      expect(await windows()).toHaveLength(3)
      expect(await browser.evaluate("document.querySelectorAll('#sakuraSubscriptions progress').length")).toBe(0)
    } finally { await account.close() }
  })

  it.each([false, true])('keeps local Key menu focus while foreground activity is pending (failure: %s)', async failActivity => {
    let holdActivity = false
    let releaseActivity: (() => void) | undefined
    let activityCalls = 0
    let keyMutations = 0
    const account = await runWebServer({ cwd: workspace, open: false, quiet: true, sakuraApi: clientSaved(),
      sakuraApiFetch: (async (url, init) => {
        if (String(url).endsWith('/auth/client/activity') && holdActivity) {
          activityCalls++
          await new Promise<void>(resolve => { releaseActivity = resolve })
          if (failActivity) return new Response('', { status: 503 })
        }
        if ((String(url).endsWith('/api/v1/keys') && init?.method === 'POST') || /\/keys\/\d+$/.test(String(url))) keyMutations++
        return sakuraClientResponse(url, init)
      }) as typeof fetch })
    try {
      await browser.navigate(account.url)
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraKeyPrepare').disabled")
      await openSettings('models')
      await browser.click('#sakuraKeySelectTrigger')
      await browser.waitFor("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement)")
      holdActivity = true
      // Pointer activation may already have started a short activity request.
      // Dispatch only when its network lock has cleared, and stop as soon as
      // either that activation or our explicit event reaches the held fixture.
      await vi.waitFor(async () => {
        if (!activityCalls) await browser.evaluate("if (!document.hidden && !document.getElementById('sakuraKeyPrepare').disabled) window.dispatchEvent(new Event('focus'))")
        expect(activityCalls).toBe(1)
      }, { timeout: 5000, interval: 20 })
      await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      expect(await browser.evaluate("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement) === true")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraKeySelectTrigger').disabled")).toBe(false)
      expect(await browser.evaluate("document.getElementById('sakuraKeyName').disabled || [...document.querySelectorAll('#sakuraKeyGroups input')].some(input => input.disabled)")).toBe(false)
      expect(await browser.evaluate("document.getElementById('sakuraKeyPrepare').disabled")).toBe(true)
      await browser.evaluate("window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('focus'))")
      await browser.key('End')
      await browser.waitFor("document.activeElement?.textContent === 'Synthetic chosen Key'")
      releaseActivity?.()
      await browser.waitFor("!document.getElementById('sakuraKeyPrepare').disabled")
      expect(await browser.evaluate("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement) === true")).toBe(true)
      await browser.key('Enter')
      await browser.waitFor("document.getElementById('sakuraKeySelect').value === '101' && !document.getElementById('sakuraKeyUse').disabled")
      expect(activityCalls).toBe(1)
      expect(keyMutations).toBe(0)
      expect(noClientSecrets(await browser.evaluate('document.body.innerHTML + JSON.stringify(localStorage)'))).toBe(true)
    } finally { releaseActivity?.(); await account.close() }
  })

  it('shows Key errors in model settings and retries creation only with the same confirmed operation', async () => {
    let failSelection = true
    const creates: RequestInit[] = []
    const account = await runWebServer({ cwd: workspace, open: false, quiet: true, sakuraApi: clientSaved(),
      sakuraApiFetch: (async (url, init) => {
        if (String(url).endsWith('/keys/101') && failSelection) return new Response('', { status: 503 })
        if (String(url).endsWith('/api/v1/keys') && init?.method === 'POST') {
          creates.push(init)
          if (creates.length === 1) return new Response('', { status: 503 })
        }
        return sakuraClientResponse(url, init)
      }) as typeof fetch })
    try {
      await browser.navigate(account.url)
      await browser.waitFor("document.getElementById('accountUsername').textContent === " + JSON.stringify(clientUser.username) + " && !document.getElementById('sakuraKeyPrepare').disabled")
      await openSettings('models')
      expect(await browser.evaluate("document.getElementById('sakuraKeyCard').checkVisibility()")).toBe(true)
      await browser.waitFor("!document.getElementById('sakuraKeySelectTrigger').disabled")
      await browser.click('#sakuraKeySelectTrigger')
      await browser.waitFor("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement)")
      await browser.key('End')
      await browser.waitFor("document.activeElement?.textContent === 'Synthetic chosen Key'")
      await browser.key('Enter')
      await browser.waitFor("document.getElementById('sakuraKeySelect').value === '101' && !document.getElementById('sakuraKeyUse').disabled && !document.getElementById('sakuraKeySelectTriggerMenu')")
      // Re-opening after bringing a lower settings field into view must not be
      // cancelled by the queued scroll event from that same anchor position.
      await browser.click('#sakuraKeySelectTrigger')
      await browser.waitFor("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement)")
      await browser.evaluate("document.getElementById('settingsView').dispatchEvent(new Event('scroll'))")
      expect(await browser.evaluate("document.getElementById('sakuraKeySelectTriggerMenu')?.contains(document.activeElement)")).toBe(true)
      await browser.key('Escape')
      await browser.click('#sakuraKeyUse')
      await browser.waitFor("!document.getElementById('sakuraModelError').hidden && !document.getElementById('sakuraKeyUse').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraAccountError').hidden")).toBe(true)
      expect(await browser.evaluate("document.getElementById('sakuraModelError').textContent")).toContain('不会自动重试 Key 操作')
      expect(await browser.evaluate("document.getElementById('accountLabel').textContent")).toContain('待选择 Key')
      failSelection = false
      await browser.click('#sakuraKeyPrepare')
      await browser.waitFor("!document.getElementById('sakuraKeyPrepare').disabled && document.getElementById('sakuraModelError').textContent.includes('1–32')")
      expect(creates).toHaveLength(0)
      await browser.click('#sakuraKeyGroups input[value="7"]')
      await browser.fill('#sakuraKeyName', '明确重试的 Key')
      await browser.click('#sakuraKeyPrepare')
      await browser.waitFor("document.getElementById('sakuraKeyDialog').open && !document.getElementById('sakuraKeyDialogConfirm').disabled")
      expect(await browser.evaluate("document.getElementById('sakuraModelError').hidden")).toBe(true)
      expect(await browser.evaluate('document.activeElement.id')).toBe('sakuraKeyDialogCancel')
      await browser.click('#sakuraKeyDialogConfirm')
      await browser.waitFor("!document.getElementById('sakuraKeyDialogConfirm').disabled && !document.getElementById('sakuraKeyDialogError').hidden")
      expect(await browser.evaluate("document.getElementById('sakuraKeyDialogError').textContent")).toContain('不会自动重试 Key 操作')
      expect(await browser.evaluate("document.getElementById('sakuraKeyDialogConfirm').textContent")).toBe('重试同一创建操作')
      await browser.evaluate('new Promise(resolve=>setTimeout(resolve,150))')
      expect(creates).toHaveLength(1)
      await browser.click('#sakuraKeyDialogConfirm')
      await browser.waitFor("!document.getElementById('sakuraKeyDialog').open && document.getElementById('accountLabel').textContent.includes('已选择 Key')")
      expect(creates).toHaveLength(2)
      expect(creates[0]!.body).toBe(creates[1]!.body)
      expect(new Headers(creates[0]!.headers).get('Idempotency-Key')).toBe(new Headers(creates[1]!.headers).get('Idempotency-Key'))
      expect(new Headers(creates[0]!.headers).get('Idempotency-Key')).toMatch(/^[a-f0-9-]{36}$/)
      expect(await browser.evaluate("document.getElementById('sakuraModelError').hidden")).toBe(true)
      expect(noClientSecrets(await browser.evaluate('document.body.innerHTML + JSON.stringify(localStorage)'))).toBe(true)
    } finally { await account.close() }
  })

  it('batch-selects sessions, cancels safely and deletes only confirmed selected history', async () => {
    const first = await server!.harness.ctx.sessions.create({ title: '批量目标一' })
    const second = await server!.harness.ctx.sessions.create({ title: '批量目标二' })
    const kept = await server!.harness.ctx.sessions.create({ title: '保留的历史' })
    const sentinel = path.join(workspace, 'batch-project.txt')
    await fs.writeFile(sentinel, 'project remains')
    await browser.reload()
    await browser.waitFor("document.querySelectorAll('.session-item').length === 3")
    await browser.click('#sessionBatchBtn')
    await browser.click(`[data-session-id="${first.id}"] .session-select`)
    await browser.click(`[data-session-id="${second.id}"] .session-select`)
    expect(await browser.evaluate("document.getElementById('sessionSelectedCount').textContent")).toBe('已选 2')
    await browser.click('#sessionBatchDelete')
    expect(await browser.evaluate('document.activeElement.id')).toBe('deleteSessionsCancel')
    await browser.click('#deleteSessionsCancel')
    expect((await server!.harness.ctx.sessions.list()).length).toBe(3)
    await browser.click('#sessionBatchDelete')
    await browser.click('#deleteSessionsConfirm')
    await browser.waitFor("!document.getElementById('deleteSessionsDialog') && document.querySelectorAll('.session-item').length === 1")
    expect((await server!.harness.ctx.sessions.list()).map(s => s.id)).toEqual([kept.id])
    expect(await fs.readFile(sentinel, 'utf8')).toBe('project remains')
  })

  it('handles a partial batch failure and makes the remaining selection safe to retry explicitly', async () => {
    const first = await server!.harness.ctx.sessions.create({ title: '可删除一' })
    const second = await server!.harness.ctx.sessions.create({ title: '暂时不可删除二' })
    const original = server!.harness.ctx.sessions.delete.bind(server!.harness.ctx.sessions)
    const spy = vi.spyOn(server!.harness.ctx.sessions, 'delete').mockImplementation(async (id, guard) => {
      if (id === second.id) throw new Error('permission denied')
      return original(id, guard)
    })
    try {
      await browser.reload()
      await browser.waitFor("document.querySelectorAll('.session-item').length === 2")
      await browser.click('#sessionBatchBtn')
      await browser.click('#sessionSelectAll')
      expect(await browser.evaluate("document.getElementById('sessionSelectedCount').textContent")).toBe('已选 2')
      await browser.click('#sessionBatchDelete')
      await browser.click('#deleteSessionsConfirm')
      await browser.waitFor("document.getElementById('deleteSessionsDialog')?.textContent.includes('1 个删除失败')")
      expect(await browser.evaluate("document.querySelectorAll('.session-item').length")).toBe(1)
      expect(await browser.evaluate("document.getElementById('deleteSessionsConfirm').hidden")).toBe(true)
      await browser.click('#deleteSessionsCancel')
      expect(await browser.evaluate("document.getElementById('sessionSelectedCount').textContent")).toBe('已选 1')
    } finally { spy.mockRestore() }
  })

  it('invalidates a batch confirmation on explicit reconnect and does not auto-resend deletion', async () => {
    await server!.harness.ctx.sessions.create({ title: '重连保留' })
    await browser.reload()
    await browser.waitFor("document.querySelectorAll('.session-item').length === 1")
    await browser.click('#sessionBatchBtn')
    await browser.click('#sessionSelectAll')
    await browser.click('#sessionBatchDelete')
    await browser.evaluate("window.dispatchEvent(new Event('online'))")
    await browser.waitFor("!document.getElementById('deleteSessionsDialog')")
    expect((await server!.harness.ctx.sessions.list()).length).toBe(1)
  })

  it('shows every known workspace and actual session activity without switching the live harness', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-team-workspace-'))
    const remoteHistory = await new (await import('../src/core/session.js')).SessionService(path.join(other, '.sakura', 'sessions')).create({ title: '其他工作区历史' })
    await remoteHistory.append({ type: 'user/message', payload: { content: '另一个项目的任务' } })
    const team = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true, recentWorkspaces: [other], onPersistSettings() {} })
    try {
      await team.harness.run('当前项目的工作情况')
      const main = team.harness.main()
      await browser.navigate(team.url)
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      await browser.click('#inspectorBtn')
      await browser.click('#collaborationRefresh')
      await browser.waitFor("document.querySelectorAll('.collaboration-workspace').length === 2")
      expect(await browser.evaluate("document.getElementById('collaborationWorkspaces').textContent")).toContain('其他工作区历史')
      expect(await browser.evaluate("document.getElementById('collaborationWorkspaces').textContent")).toContain('当前项目的工作情况')
      expect(await browser.evaluate("document.querySelector('.collaboration-session[data-status=done]') !== null")).toBe(true)
      expect(team.harness.main()).toBe(main)
      await snapshot('collaboration-workspaces')
      await browser.evaluate("document.querySelector('.collaboration-workspace').open = false; document.getElementById('collaborationRefresh').click()")
      await browser.waitFor("!document.getElementById('collaborationRefresh').disabled")
      expect(await browser.evaluate("document.querySelector('.collaboration-workspace').open")).toBe(false)
    } finally {
      await team.close()
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
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
    expect(await browser.evaluate("document.getElementById('usageChip').textContent")).toContain('缓存 75%')
    expect(await browser.evaluate("document.getElementById('usageChip').title")).toContain('缓存命中 90')
    expect(await browser.evaluate("document.getElementById('usageChip').title")).toContain('推理 8')
    // Cumulative session stats ride on the context chip's tooltip.
    expect(await browser.evaluate("document.getElementById('ctxChip').title")).toContain('累计 1 次请求')
    expect(await browser.evaluate("document.getElementById('ctxChip').title")).toContain('缓存命中 90')
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
    // Collaboration is now loaded on first expansion, not hidden at startup.
    // Let that initial section establish its bounds before pointer input below it.
    await browser.waitFor("document.querySelector('.collaboration-workspace') && !document.getElementById('collaborationRefresh').disabled")
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
    await browser.waitFor("document.querySelector('.collaboration-workspace') && !document.getElementById('collaborationRefresh').disabled")
    await browser.click('#spawnBtn')
    await browser.key('Escape')
    await browser.waitFor("!document.getElementById('spawnModal')")
    expect(await browser.evaluate("document.body.classList.contains('inspector-open')")).toBe(true)
    await browser.click('#changesTab')
    await snapshot('workspace-mobile-changes')
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
      // A user bubble appears before the turn ends. Switching during that
      // interval correctly returns 409; wait for the completed, idle turn.
      await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：切换工作区之前') && document.getElementById('stopBtn').hidden && !document.getElementById('sendBtn').disabled")
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

  it('edits local workspace memory, preserves content when disabled, and loads it after browser reload', async () => {
    await openSettings('workspace')
    await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor("!document.getElementById('workspaceMemoryCard').hidden && !document.getElementById('workspaceMemorySave').disabled")
    expect(await browser.evaluate("document.getElementById('workspaceMemoryEnabled').checked")).toBe(true)
    const content = '项目使用严格 TypeScript；优先写测试。<img src=x onerror=alert(1)>'
    await browser.fill('#workspaceMemoryContent', content)
    await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryBadge').textContent === '已启用' && !document.getElementById('workspaceMemorySave').disabled")
    expect((await new WorkspaceMemoryStore(workspace).reload()).content).toBe(content)
    expect(await browser.evaluate("document.querySelectorAll('#workspaceMemoryCard img').length")).toBe(0)
    await browser.click('#settingsBack')
    await browser.fill('#input', '使用当前工作区偏好')
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('已完成：使用当前工作区偏好')")
    expect(String(adapter.requests.at(-1)?.messages[0]?.content)).toContain(content)
    await openSettings('workspace')
    await browser.click('#workspaceMemoryEnabled')
    await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryBadge').textContent === '已关闭' && !document.getElementById('workspaceMemorySave').disabled")
    expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe(content)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await openSettings('workspace')
    await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor(`document.getElementById('workspaceMemoryContent').value === ${JSON.stringify(content)} && !document.getElementById('workspaceMemorySave').disabled`)
    expect(await browser.evaluate("document.getElementById('workspaceMemoryEnabled').checked")).toBe(false)
    await browser.fill('#workspaceMemoryContent', '')
    await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent.includes('内容保留') && !document.getElementById('workspaceMemorySave').disabled")
    expect((await new WorkspaceMemoryStore(workspace).reload()).content).toBe('')
  })

  it('preserves a memory draft on revision conflict instead of overwriting an agent update', async () => {
    await openSettings('workspace')
    await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled")
    await browser.fill('#workspaceMemoryContent', 'UNSAVED_USER_DRAFT')
    await server!.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory').update({ enabled: true, content: 'LATEST_AGENT_NOTES' }, 0)
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent.includes('其他窗口更新')")
    await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent.includes('保存失败') && !document.getElementById('workspaceMemorySave').disabled")
    expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe('UNSAVED_USER_DRAFT')
    expect((await new WorkspaceMemoryStore(workspace).reload()).content).toBe('LATEST_AGENT_NOTES')
  })

  it('requires a real confirmation to clear workspace memory and preserves project files and session history', async () => {
    const memory = server!.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({ enabled: true, content: 'CONFIRMED_DURABLE_NOTES' }, 0)
    await server!.harness.run('history must survive clearing memory')
    const session = await server!.harness.ctx.sessions.open(server!.harness.main().sessionId)
    const history = await fs.readFile(session.file, 'utf8')
    const sentinel = path.join(workspace, 'keep-project.txt')
    await fs.writeFile(sentinel, 'PROJECT_FILE')
    await openSettings('workspace')
    await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'CONFIRMED_DURABLE_NOTES' && !document.getElementById('workspaceMemoryClear').disabled")
    const message = await browser.confirm(() => browser.click('#workspaceMemoryClear'), false)
    expect(message).toContain('不影响会话历史和项目文件')
    expect(memory.snapshot().content).toBe('CONFIRMED_DURABLE_NOTES')
    expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe('CONFIRMED_DURABLE_NOTES')
    await browser.confirm(() => browser.click('#workspaceMemoryClear'), true)
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent === '记忆内容已清空。' && !document.getElementById('workspaceMemorySave').disabled")
    expect((await memory.reload())).toMatchObject({ enabled: true, content: '', pendingContent: '' })
    expect(await fs.readFile(session.file, 'utf8')).toBe(history)
    expect(await fs.readFile(sentinel, 'utf8')).toBe('PROJECT_FILE')
    expect(adapter.requests).toHaveLength(1)
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
    await openSettings('workspace')
    await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled")
    expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe('')
    expect(await browser.evaluate("document.getElementById('workspaceMemoryEnabled').checked")).toBe(true)
  })

  it('invalidates delayed memory responses when switching workspace', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-memory-switch-ui-'))
    const desktop = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true, onPersistSettings() {} })
    try {
      await new WorkspaceMemoryStore(workspace).update({ enabled: true, content: 'OLD_WORKSPACE_MEMORY' }, 0)
      await new WorkspaceMemoryStore(other).update({ enabled: false, content: 'NEW_WORKSPACE_MEMORY' }, 0)
      await browser.navigate(desktop.url)
      await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
      await browser.evaluate(`(() => {
        const original = window.fetch.bind(window); let held = false;
        window.fetch = async function (url, options) {
          const response = await original(url, options);
          if (!held && String(url).startsWith('/api/workspace/memory?') && (!options || options.method === 'GET')) {
            held = true; window.memoryHeld = true;
            await new Promise(resolve => { window.releaseMemory = resolve; });
            window.memoryReleased = true;
          }
          return response;
        };
      })()`)
      await openSettings('workspace')
      await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
      await browser.click('#workspaceMemoryList [data-memory-workspace]')
      await browser.waitFor('window.memoryHeld === true')
      expect((await fetch(desktop.url + 'api/desktop/settings', { method: 'POST', body: JSON.stringify({ workspace: other }) })).status).toBe(200)
      await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')?.dataset.memoryWorkspace === " + JSON.stringify(other))
      await browser.click('#workspaceMemoryList [data-memory-workspace]')
      await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'NEW_WORKSPACE_MEMORY' && !document.getElementById('workspaceMemorySave').disabled")
      await browser.evaluate('window.releaseMemory()')
      await browser.waitFor('window.memoryReleased === true')
      await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))')
      expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe('NEW_WORKSPACE_MEMORY')
      expect(await browser.evaluate("document.getElementById('workspaceMemoryEnabled').checked")).toBe(false)
    } finally {
      await browser.evaluate('window.releaseMemory?.()')
      await desktop.close()
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('integrates desktop window controls without a second titlebar or responsive overflow', async () => {
    const actions: string[] = []
    const desktop = await runWebServer({ cwd: workspace, adapter: new GuiAdapter(), open: false, quiet: true, onPersistSettings() {}, onWindowAction: action => actions.push(action) })
    try {
      await browser.navigate(desktop.url)
      await browser.waitFor("document.body.classList.contains('desktop-shell') && !document.getElementById('desktopWindowControls').hidden")
      for (const width of [1440, 1920, 1000, 390, 320]) {
        await browser.resize(width)
        for (const button of ['chatViewBtn', 'dashboardBtn', 'settingsViewBtn']) {
          await browser.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`)
          expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), `${width}px ${button}`).toBe(true)
          expect(await browser.evaluate("document.querySelector('.topbar').getBoundingClientRect().y")).toBe(0)
          expect(await browser.evaluate("document.getElementById('desktopClose').getBoundingClientRect().right <= innerWidth")).toBe(true)
        }
      }
      await browser.resize(1440)
      await browser.click('#desktopMinimize')
      await browser.click('#desktopMaximize')
      await browser.evaluate("document.querySelector('.topbar').dispatchEvent(new PointerEvent('pointerdown', {button: 0, isPrimary: true, bubbles: true}))")
      await browser.click('#desktopClose')
      await vi.waitFor(() => expect(actions).toEqual(['minimize', 'maximize', 'drag', 'close']))
    } finally { await desktop.close() }
  })

  it('names new sessions from a dialog, renames through the row menu and keeps the welcome screen unscrolled', async () => {
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
    // Title/count stay together; 新建 is inline immediately before 多选.
    const placement = await browser.evaluate<{ headBeforeButton: boolean; buttonBeforeSearch: boolean; onlyChild: boolean }>(`(() => {
      const button = document.getElementById('newSessionBtn');
      const head = document.querySelector('.side-sessions-head');
      const title = head.querySelector('.side-title');
      const search = document.getElementById('sessionSearch');
      const pos = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {headBeforeButton: pos(title, button), buttonBeforeSearch: pos(button, search),
        onlyChild: button.parentElement.className === 'side-title-actions' && button.nextElementSibling.id === 'sessionBatchBtn'};
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
    const state = await (await fetch(server!.url + 'api/state')).json() as { sessionId: string }
    expect(state.sessionId).toBeTruthy()
    // The row menu renames the same session through PATCH.
    await sessionAction(browser, 'rename', state.sessionId)
    await browser.waitFor("document.getElementById('renameSessionDialog').open")
    expect(await browser.evaluate<string>("document.getElementById('renameSessionTitle').value")).toBe('登录页回归')
    await browser.fill('#renameSessionTitle', '登录页回归 v2')
    await browser.evaluate("document.getElementById('renameSessionConfirm').click()")
    await browser.waitFor("document.getElementById('renameSessionDialog').open === false")
    await browser.waitFor("[...document.querySelectorAll('.session-item .session-title')].some((t) => t.textContent === '登录页回归 v2')")
    const renamed = await (await fetch(server!.url + 'api/state')).json() as { sessions: Array<{ id: string; title?: string }> }
    expect(renamed.sessions.find((s) => s.id === state.sessionId)?.title).toBe('登录页回归 v2')
    // An empty rename is rejected inline instead of clearing the title.
    await sessionAction(browser, 'rename', state.sessionId)
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
      await openSettings('about')
      expect(await browser.evaluate("document.getElementById('settingsCheckUpdates').checkVisibility()")).toBe(true)
      expect(await browser.evaluate("document.getElementById('settingsUpdateStatus').textContent")).toBe('尚未检查。')
      expect(await browser.evaluate("document.getElementById('settingsViewBtn').classList.contains('update-dot')")).toBe(false)
      // A manual check renders latest/current and sets the badge.
      await browser.click('#settingsCheckUpdates')
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
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 协同中'")
    await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).expertMode === true)()")
    expect(await browser.evaluate<string>("document.getElementById('input').value")).toBe('评审这个仓库的测试覆盖')
    expect(adapter.requests).toHaveLength(0)
    const ids = await browser.evaluate<string[]>("[...document.querySelectorAll('.agent-row')].map((row) => row.dataset.agentId).sort()")
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 关闭'")
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 协同中'")
    expect(await browser.evaluate<string[]>("[...document.querySelectorAll('.agent-row')].map((row) => row.dataset.agentId).sort()")).toEqual(ids)
    expect(await browser.evaluate<string>("document.getElementById('input').value")).toBe('评审这个仓库的测试覆盖')
    await browser.click('#sendBtn')
    await browser.waitFor("document.querySelectorAll('.agent-row[data-status=done]').length === 4")
    expect(adapter.requests).toHaveLength(4)
    await browser.waitFor("document.querySelectorAll('.agent-row').length === 4")
    const names = await browser.evaluate<string[]>("[...document.querySelectorAll('.agent-row .agent-name')].map((n) => n.textContent)")
    expect(names.sort()).toEqual(['main', '实现者', '架构师', '审查者'].sort())
    // Experts wear a highlighted badge in the roster.
    expect(await browser.evaluate<string[]>(
      "[...document.querySelectorAll('.agent-row .role-badge')].map((b) => b.textContent)"
    )).toContain('专家')
    // Once the experts finish, the summarize action appears and reaches the main agent.
    await browser.waitFor("document.querySelectorAll('.agent-row[data-status=done]').length >= 3")
    await browser.waitFor("!document.getElementById('summarizeBtn').hidden")
    expect(await browser.evaluate("document.getElementById('summarizeBtn').checkVisibility()")).toBe(true)
    await browser.click('#summarizeBtn')
    await vi.waitFor(() => expect(adapter.requests).toHaveLength(5))
    const summary = String(adapter.requests[4]?.messages.at(-1)?.content)
    expect(summary).toContain('已完成：评审这个仓库的测试覆盖')
    expect(summary).toContain('架构师')
    expect(summary).toContain('审查者')
    await browser.waitFor("document.querySelectorAll('.agent-row[data-status=done]').length === 4")
    // Local plugins and the public market share one page; Skill is separate.
    await openSettings('market')
    await browser.waitFor("!document.getElementById('settings-marketPanel').hidden")
    expect(await browser.evaluate("document.querySelector('#pluginsLocalPanel h2').textContent")).toContain('本地插件')
    const count = await browser.evaluate<number>("Number(document.getElementById('pluginCount').textContent)")
    expect(count).toBeGreaterThan(0)
    await browser.fill('#pluginSearch', 'compaction')
    expect(await browser.evaluate<number>("document.querySelectorAll('#pluginList .extension-card').length")).toBeLessThan(count)
    await openSettings('skills')
    await browser.fill('#skillsSearch', 'repo-review')
    await browser.waitFor("document.querySelectorAll('#skillsBody .market-card').length === 1")
    await browser.click('#skillsBody .market-skill-toggle')
    await browser.waitFor("document.querySelector('#skillsBody .skill-body')?.textContent.includes('按清单逐项审查变更与测试。')")
    expect(await browser.evaluate<string>("document.querySelector('#skillsBody .skill-body').textContent")).toContain('按清单逐项审查变更与测试。')
    expect(await browser.evaluate("document.querySelector('#skillsBody .market-skill-toggle').getAttribute('aria-expanded')")).toBe('true')
    expect(await browser.evaluate("document.activeElement.className")).toContain('market-skill-toggle')
    await browser.key('Enter')
    expect(await browser.evaluate("document.querySelector('#skillsBody .skill-body').hidden")).toBe(true)
    await browser.key('Enter')
    expect(await browser.evaluate("document.querySelector('#skillsBody .skill-body').hidden")).toBe(false)
    await browser.evaluate("document.getElementById('settingsBack').click()")
    // Turning the mode off keeps the experts on the roster.
    await browser.evaluate("document.getElementById('expertChip').click()")
    await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 关闭'")
    await browser.waitFor("(async () => (await (await fetch('/api/state')).json()).expertMode === false)()")
    expect(await browser.evaluate("document.querySelectorAll('.agent-row').length")).toBe(4)
  })

})
