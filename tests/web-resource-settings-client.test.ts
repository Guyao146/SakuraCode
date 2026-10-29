/** Resource separation, genuine browser text input, IME and numeric-field styles. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})

const browserSuite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
browserSuite('separate resource settings and composer — real browser', () => {
  const browser = new BrowserClient(), dirs: string[] = [], servers: WebServerHandle[] = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {})
    await browser.navigate('about:blank')
    while (servers.length) await servers.pop()!.close()
    while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })
  async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-resource-ui-')); dirs.push(dir); return dir }
  async function skill(root: string, name: string, body: string, description = 'Skill description') {
    const dir = path.join(root, '.sakura', 'skills', name); await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`)
  }
  async function boot(extra: Partial<WebServerOptions> = {}) {
    state.home = await directory()
    const cwd = extra.cwd ?? await directory()
    const server = await runWebServer({ cwd, adapter: new MockAdapter([text('TYPED_TASK_ACCEPTED')]), open: false, quiet: true, token: null, viewerToken: null,
      updatesAutoCheck: false, onPersistSettings() {}, ...extra })
    servers.push(server); browser.errors.length = 0
    await browser.resize(1440); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    return { cwd, server }
  }
  async function settings(section: string) {
    await browser.evaluate(`document.getElementById('settingsViewBtn').click(); document.querySelector('[data-settings-section="${section}"]').click()`)
  }
  async function snapshot(name: string) { if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png')) }
  const marketResponse = (name = 'sakuracode-plugin-public-review', total = 1) => new Response(JSON.stringify({ total, objects: [{ package: {
    name, version: '1.2.0', keywords: ['sakuracode-plugin'], description: '<img src=x onerror=alert(1)> registry metadata', links: { npm: 'javascript:alert(1)' },
  } }] }))

  it('separates real loaded Skill, MCP and local plugins; refreshing Skill keeps the correct source/body', async () => {
    const cwd = await directory()
    await skill(cwd, 'project-skill', 'PROJECT_SKILL_BODY', '<img src=x> project Skill')
    await fs.mkdir(path.join(cwd, 'plugins'))
    await fs.writeFile(path.join(cwd, 'plugins', 'local-review.cjs'), `module.exports = {
      name: 'local-review-plugin', description: 'LOCAL_PLUGIN_ONLY', inject: ['tools'], apply(ctx) {
        ctx.get('tools').register({ name: 'local_review', kind: 'read', description: 'LOCAL_TOOL_ONLY', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: 'done' }) });
        ctx.provide('mcp'); ctx.set('mcp', { status: () => [{ name: 'separate-mcp', state: 'error', toolCount: 1, error: 'MCP_ERROR_DETAIL' }], async reconnect() {}, async stopAll() {} });
        ctx.get('tools').register({ name: 'mcp__separate__tool', kind: 'read', description: 'MCP_TOOL_ONLY', parameters: { type: 'object', properties: {} }, execute: async () => ({ output: 'mcp' }) });
      }
    }`)
    const { server } = await boot({ cwd, config: { pluginsDir: 'plugins', plugins: { 'mcp-manager': { disabled: true } } } })
    await skill(state.home, 'user-skill', 'USER_SKILL_BODY')
    await skill(state.home, 'project-skill', 'SHADOWED_USER_BODY')
    await settings('skills'); await browser.click('#skillsReload')
    await browser.waitFor("document.getElementById('skillsMessage').textContent.includes('已刷新')")
    expect(await browser.evaluate("document.getElementById('skillCount').textContent")).toBe('2')
    expect(await browser.evaluate("document.querySelector('#settings-skillsPanel #skillImportCard') !== null")).toBe(true)
    expect(await browser.evaluate("document.querySelector('#settings-skillsPanel #pluginList, #settings-skillsPanel #mcpList')")).toBe(null)
    await browser.fill('#skillsSearch', 'project-skill'); await browser.click('#skillsBody .market-skill-toggle')
    await browser.waitFor("document.querySelector('#skillsBody .skill-body').textContent.includes('PROJECT_SKILL_BODY')")
    expect(await browser.evaluate("document.querySelector('#skillsBody .skill-body').textContent")).not.toContain('SHADOWED_USER_BODY')
    expect(await browser.evaluate("document.querySelector('#skillsBody .extension-badge').textContent")).toBe('项目')
    expect(await browser.evaluate("document.querySelectorAll('#skillsBody img').length")).toBe(0)
    server.harness.ctx.emit('agent/status', { id: server.harness.main().id, status: 'idle' })
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    expect(await browser.evaluate("document.querySelector('#skillsBody .skill-body').hidden")).toBe(false)
    await snapshot('settings-skills')
    await settings('mcp')
    expect(await browser.evaluate("document.getElementById('settings-mcpPanel').textContent")).toContain('MCP_ERROR_DETAIL')
    expect(await browser.evaluate("document.getElementById('mcpToolList').textContent")).toContain('mcp__separate__tool')
    expect(await browser.evaluate("document.querySelector('#settings-mcpPanel #pluginList, #settings-mcpPanel #skillsBody')")).toBe(null)
    await snapshot('settings-mcp')
    await settings('market'); await browser.fill('#pluginSearch', 'local-review-plugin')
    expect(await browser.evaluate("document.getElementById('pluginList').textContent")).toContain('local-review-plugin')
    expect(await browser.evaluate("document.getElementById('toolList').textContent")).not.toContain('mcp__separate__tool')
    expect(await browser.evaluate("document.querySelector('#settings-marketPanel #skillsBody, #settings-marketPanel #mcpList, #settings-marketPanel #skillImportCard')")).toBe(null)
    expect(await browser.evaluate("document.getElementById('settingsClose')")).toBe(null)
    await snapshot('settings-local-plugins')
  })

  it('does not network just by opening the market, searches real API metadata and keeps metadata inert', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => marketResponse('sakuracode-plugin-public-review', 21))
    await boot({ pluginMarketplaceFetch: fetcher })
    await settings('market'); await browser.click('#pluginsMarketTab')
    expect(fetcher).not.toHaveBeenCalled()
    await browser.typeText('#marketSearch', 'review'); await browser.key('Enter')
    await browser.waitFor("document.querySelector('.plugin-market-card') && !document.getElementById('pluginMarketSearch').disabled")
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await browser.evaluate("document.querySelector('.plugin-market-card').textContent")).toContain('未安装')
    expect(await browser.evaluate("document.querySelector('.plugin-market-card a').href")).toBe('https://www.npmjs.com/package/sakuracode-plugin-public-review')
    expect(await browser.evaluate("document.querySelectorAll('#marketBody img, #marketBody script').length")).toBe(0)
    expect(await browser.evaluate("document.getElementById('pluginMarketNext').disabled")).toBe(false)
    await browser.click('#pluginMarketNext'); await browser.waitFor("document.getElementById('pluginMarketPage').textContent.includes('第 2 页')")
    expect(fetcher).toHaveBeenCalledTimes(2)
    await browser.click('#pluginsLocalTab'); expect(await browser.evaluate("document.getElementById('pluginsLocalPanel').hidden")).toBe(false)
    await browser.click('#pluginsMarketTab'); expect(fetcher).toHaveBeenCalledTimes(2)
    await snapshot('settings-online-plugin-market')
  })

  it('shows network failure and explicit retry without replacing the local plugin catalog', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_FAILURE')).mockImplementation(async () => marketResponse())
    await boot({ pluginMarketplaceFetch: fetcher })
    await settings('market'); await browser.click('#pluginsMarketTab'); await browser.click('#pluginMarketSearch')
    await browser.waitFor("document.getElementById('pluginMarketMessage').classList.contains('error') && !document.getElementById('pluginMarketSearch').disabled")
    expect(await browser.evaluate("document.getElementById('pluginMarketMessage').textContent")).not.toContain('SYNTHETIC_PRIVATE_FAILURE')
    await browser.click('#pluginMarketSearch'); await browser.waitFor("document.querySelector('.plugin-market-card')")
    await browser.click('#pluginsLocalTab'); expect(await browser.evaluate("document.querySelectorAll('#pluginList .extension-card').length")).toBeGreaterThan(0)
  })

  it('uses real text input while offline/processing, blocks sending, restores focus after settings and supports Chinese IME', async () => {
    const requests: import('../src/core/types.js').LLMRequest[] = []
    const { server } = await boot({ adapter: new MockAdapter([request => { requests.push(request); return text('TYPED_TASK_ACCEPTED') }]) })
    await browser.typeText('#input', '中文草稿')
    await settings('skills'); await browser.click('#settingsBack')
    expect(await browser.evaluate('document.activeElement.id')).toBe('input')
    await browser.send('Input.insertText', { text: '继续输入' })
    await browser.send('Network.enable')
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    server.server.closeAllConnections()
    await browser.waitFor("document.getElementById('connectionLabel').textContent.includes('连接断开')")
    expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(false)
    expect(await browser.evaluate("document.getElementById('sendBtn').disabled")).toBe(true)
    await browser.typeText('#input', '离线也能写'); await browser.key('Enter'); expect(requests).toHaveLength(0)
    await browser.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.evaluate("document.getElementById('input').dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}))")
    await browser.send('Input.insertText', { text: '输入法候选' }); await browser.key('Enter'); expect(requests).toHaveLength(0)
    await browser.evaluate("document.getElementById('input').dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}))")
    expect(await browser.evaluate("document.getElementById('input').value")).toContain('离线也能写')
    await browser.key('Enter'); await browser.waitFor("document.getElementById('chatCol').textContent.includes('TYPED_TASK_ACCEPTED')")
    expect(requests).toHaveLength(1); expect(JSON.stringify(requests[0]?.messages)).toContain('输入法候选')
  })

  it('keeps the draft editable during an actual held context compaction and does not send competing work', async () => {
    let calls = 0, release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), finish = new Promise<void>(resolve => { release = resolve })
    const { server } = await boot({ adapter: { id: 'held-context-ui', defaultModel: 'held-context', async *stream() {
      calls++; if (calls === 1) { yield* text('CONTEXT_SEED'); return }
      entered(); await finish; yield* text('COMPACTED_CONTEXT')
    } } })
    await server.harness.run('small context seed')
    await browser.reload(); await browser.waitFor("document.getElementById('chatCol').textContent.includes('CONTEXT_SEED')")
    await browser.click('#contextViewerBtn'); await browser.click('#contextCompact'); await started
    try {
      await browser.waitFor("document.getElementById('sendBtn').disabled && document.getElementById('composerStatus').textContent.includes('上下文')")
      await browser.typeText('#input', '压缩期间的草稿'); await browser.key('Enter')
      expect(calls).toBe(2)
      expect(await browser.evaluate("document.getElementById('input').value")).toBe('压缩期间的草稿')
    } finally { release(); await finish }
    await browser.waitFor("!document.getElementById('sendBtn').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('压缩期间的草稿')
  })

  it('keeps an actual memory consolidation draft editable without allowing a competing model request', async () => {
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve }), finish = new Promise<void>(resolve => { release = resolve })
    const { server } = await boot({ adapter: { id: 'held-memory-ui', defaultModel: 'held-memory', async *stream() { entered(); await finish; yield* text('CONSOLIDATED') } } })
    const memory = server.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({ processing: { auto: true, thresholdChars: 1000, intervalMs: 0 } }, 0); await memory.appendPending('confirmed facts '.repeat(100))
    const task = server.harness.ctx.get<import('../src/plugins/memory-processing.js').MemoryProcessingService>('memoryProcessing').maybeProcess()
    await started
    try {
      await browser.waitFor("document.getElementById('sendBtn').disabled && document.getElementById('composerStatus').textContent.includes('整理长期记忆')")
      await browser.typeText('#input', '整理期间不会丢的草稿')
      await browser.key('Enter')
      expect(await browser.evaluate("document.getElementById('input').value")).toBe('整理期间不会丢的草稿')
    } finally { release(); await task }
    await browser.waitFor("!document.getElementById('sendBtn').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('整理期间不会丢的草稿')
  })

  it('styles every numeric setting consistently across themes/sizes and keeps hidden inspector state from making settings inert', async () => {
    await boot()
    await browser.click('#inspectorBtn'); await browser.resize(1000)
    await settings('general')
    await browser.evaluate("document.body.classList.add('inspector-open'); document.getElementById('menuBtn').click()")
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(false)
    await browser.evaluate("document.getElementById('menuBtn').click()")
    for (const theme of ['night', 'day']) {
      if (await browser.evaluate("document.documentElement.dataset.theme") !== theme) await browser.click('#themeBtn')
      for (const width of [1440, 1000, 390, 320]) {
        await browser.resize(width)
        const styles = await browser.evaluate<Array<{ radius: string; height: number; width: number; parent: number; padding: string }>>(`Array.from(document.querySelectorAll('#retrySettingsCard input[type=number]')).map(input => {const r=input.getBoundingClientRect(),s=getComputedStyle(input);return {radius:s.borderRadius,height:r.height,width:r.width,parent:input.parentElement.getBoundingClientRect().width,padding:s.paddingLeft}})`)
        expect(styles).toHaveLength(3)
        for (const style of styles) { expect(style.radius).toBe('8px'); expect(style.height).toBeGreaterThanOrEqual(40); expect(style.width).toBeCloseTo(style.parent, 0); expect(style.padding).toBe('12px') }
        expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true)
        await snapshot('settings-number-fields-' + theme + '-' + width)
      }
    }
  })
})