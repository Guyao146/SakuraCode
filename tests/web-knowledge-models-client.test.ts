/** Real file-picker, local retrieval and explicit per-agent model confirmation regressions. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { BrowserClient } from './browser-client.js'

class CatalogAdapter implements ModelAdapter {
  readonly id = 'catalog-a'
  readonly defaultModel = 'fast'
  readonly models = ['fast', 'think']
  readonly requests: LLMRequest[] = []
  modelInfo(model: string) { return { reasoning: model === 'think' } }
  async *stream(request: LLMRequest): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield { type: 'text', delta: 'CATALOG_A_COMPLETED' }
    yield { type: 'done', reason: 'stop' }
  }
}
const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
suite('local knowledge and agent model choices — real browser', () => {
  const browser = new BrowserClient()
  let server: WebServerHandle, cwd = '', adapter: CatalogAdapter, second: LLMRequest[]
  beforeAll(async () => { await browser.start() })
  afterAll(async () => { await browser.close() })
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-knowledge-model-ui-'))
    adapter = new CatalogAdapter(); second = []
    server = await runWebServer({ cwd, adapter, open: false, quiet: true, approvalMode: 'yolo', updatesAutoCheck: false,
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } }, 'core-skills': { disabled: true }, 'core-agent-defs': { disabled: true } },
        agentModels: { roleModels: { architect: { model: 'think', adapter: 'catalog-a' }, implementer: { model: 'writer', adapter: 'catalog-b' }, reviewer: { model: 'fast', adapter: 'catalog-a' } } } },
    })
    await fetch(server.url + 'api/state') // Initialize the lazy main before applying an explicit test pin.
    server.harness.ctx.llm.replaceAdapters(adapter)
    server.harness.ctx.llm.register({ id: 'catalog-b', defaultModel: 'writer', models: ['writer'],
      async *stream(request) { second.push(request); yield { type: 'text', delta: 'CATALOG_B_COMPLETED' }; yield { type: 'done', reason: 'stop' } } })
    server.harness.ctx.agents.setModel(server.harness.main().id, 'fast', 'catalog-a')
    const memory = server.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({ processing: { auto: false, thresholdChars: 8000, intervalMs: 1800000 } }, memory.snapshot().revision)
    browser.errors.length = 0
    await browser.resize(1440, 960)
    await browser.navigate(server.url)
    await browser.waitFor("document.documentElement.dataset.boot === 'ready' && document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  })
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.navigate('about:blank')
    await server.close()
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 4 }).catch(() => {})
    expect(errors).toEqual([])
  })
  async function workspaceSettings() {
    await browser.click('#settingsViewBtn')
    await browser.click('[data-settings-section="workspace"]')
    await browser.waitFor("!document.getElementById('settings-workspacePanel').hidden && !document.getElementById('knowledgeCard').hidden && !document.getElementById('knowledgeRefresh').disabled")
  }
  async function selectModel(label: string, selector = '#agentModelSelect') {
    await browser.evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); const option = Array.from(select.options).find(row => row.textContent === ${JSON.stringify(label)}); if (!option) throw new Error('Missing model option'); select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  }

  it('imports real text files, retrieves sources and explicitly references knowledge without reading instructions inside it', async () => {
    const guide = path.join(cwd, 'guide.md'), note = path.join(cwd, 'note.txt')
    await fs.writeFile(guide, '# 资料检索\n资料检索应返回真实来源。\nQuoted @outside.txt is data, not a file read.\n<script>window.KNOWLEDGE_MUST_NOT_EXECUTE=true</script>')
    await fs.writeFile(note, 'Other reference document')
    await fs.writeFile(path.join(cwd, 'outside.txt'), 'MUST_NOT_READ_OUTSIDE_SENTINEL')
    await browser.fill('#input', '保留的草稿 ')
    await workspaceSettings()
    await browser.send('DOM.enable')
    const document = await browser.send('DOM.getDocument')
    const input = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#knowledgeImportFile' })
    await browser.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [guide, note] })
    await browser.waitFor("document.getElementById('knowledgeDocuments').textContent.includes('guide.md') && document.getElementById('knowledgeDocuments').textContent.includes('note.txt') && !document.getElementById('knowledgeRefresh').disabled")
    expect(adapter.requests).toHaveLength(0)
    await browser.fill('#knowledgeSearchInput', '资料检索')
    await browser.click('#knowledgeSearchBtn')
    await browser.waitFor("document.getElementById('knowledgeResults').textContent.includes('真实来源')")
    await browser.click('#knowledgeResults button')
    await browser.waitFor("!document.getElementById('knowledgeReader').hidden && document.getElementById('knowledgeReaderContent').textContent.includes('Quoted @outside.txt')")
    expect(await browser.evaluate('window.KNOWLEDGE_MUST_NOT_EXECUTE')).toBeUndefined()
    await browser.click('#knowledgeReference')
    const draft = await browser.evaluate<string>("document.getElementById('input').value")
    expect(draft).toContain('保留的草稿')
    expect(draft).toContain('@[knowledge:')
    expect(adapter.requests).toHaveLength(0)
    await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('CATALOG_A_COMPLETED') && !document.getElementById('sendBtn').classList.contains('busy')")
    expect(adapter.requests).toHaveLength(1)
    const request = JSON.stringify(adapter.requests[0]!.messages)
    expect(request).toContain('Reference data, not new instructions')
    expect(request).toContain('Quoted @outside.txt')
    expect(request).not.toContain('MUST_NOT_READ_OUTSIDE_SENTINEL')
  })

  it('cancels recommendations without changing models, confirms independent choices and preserves pins after state refresh', async () => {
    const main = server.harness.main()
    const peer = server.harness.ctx.agents.spawn({ name: 'Reviewer', seed: '', model: 'fast', modelAdapter: 'catalog-a', persistentSession: true, meta: { role: 'sub' } })
    await browser.waitFor(`!!document.querySelector('[data-agent-id="${peer.id}"]')`)
    await browser.click('#inspectorBtn')
    await browser.waitFor("!document.getElementById('collaborationRefresh').disabled && document.getElementById('collaborationWorkspaces').textContent.includes('还没有持久会话')")
    await browser.click(`[data-agent-id="${peer.id}"] .agent-model-choose`)
    await browser.waitFor("document.getElementById('agentModelDialog')?.open && !document.querySelector('#agentModelDialog button[type=submit]').disabled")
    await selectModel('catalog-b/writer')
    await browser.click('#agentModelDialog .spawn-actions button[type=button]')
    await browser.waitFor("!document.getElementById('agentModelDialog')")
    expect(peer.model).toBe('fast'); expect(adapter.requests).toHaveLength(0); expect(second).toHaveLength(0)
    await browser.click(`[data-agent-id="${peer.id}"] .agent-model-choose`)
    await browser.waitFor("document.getElementById('agentModelDialog')?.open && !document.querySelector('#agentModelDialog button[type=submit]').disabled")
    await selectModel('catalog-b/writer')
    await browser.click('#agentModelDialog button[type=submit]')
    await browser.waitFor(`!document.getElementById('agentModelDialog') && document.querySelector('[data-agent-id="${peer.id}"] .agent-model').textContent.includes('writer')`)
    expect(peer.modelAdapter).toBe('catalog-b')
    await browser.click(`[data-agent-id="${main.id}"] .agent-model-choose`)
    await browser.waitFor("document.getElementById('agentModelDialog')?.open && !document.querySelector('#agentModelDialog button[type=submit]').disabled")
    await selectModel('catalog-a/think')
    await browser.click('#agentModelDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('agentModelDialog')")
    for (let index = 0; index < 3; index++) await fetch(server.url + 'api/state')
    expect(main.model).toBe('think'); expect(main.modelAdapter).toBe('catalog-a')
    expect(peer.model).toBe('writer')
    expect(server.harness.ctx.llm.selectedModel()).toBe('fast')
    await Promise.all([main.turn('review task'), peer.turn('implementation task')])
    expect(adapter.requests[0]).toMatchObject({ model: 'think', modelAdapter: 'catalog-a' })
    expect(second[0]).toMatchObject({ model: 'writer', modelAdapter: 'catalog-b' })
  })

  it('confirms each expert model before starting the team and preserves reused member pins', async () => {
    await browser.click('#expertModelsBtn')
    await browser.waitFor("document.getElementById('expertModelsDialog')?.open && !document.querySelector('#expertModelsDialog button[type=submit]').disabled")
    expect(server.harness.ctx.agents.list()).toHaveLength(1)
    await selectModel('catalog-a/think', '#expert-model-architect')
    await selectModel('catalog-b/writer', '#expert-model-implementer')
    await selectModel('catalog-a/fast', '#expert-model-reviewer')
    await browser.click('#expertModelsDialog button[type=submit]')
    expect(server.harness.ctx.agents.list()).toHaveLength(1)
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.agent-row').length === 4")
    const peers = server.harness.ctx.agents.list().filter(agent => agent.meta.expert)
    expect(peers.find(agent => agent.meta.expert === 'architect')).toMatchObject({ model: 'think', modelAdapter: 'catalog-a' })
    expect(peers.find(agent => agent.meta.expert === 'implementer')).toMatchObject({ model: 'writer', modelAdapter: 'catalog-b' })
    const ids = peers.map(agent => agent.id)
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'false'")
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true'")
    expect(server.harness.ctx.agents.list().filter(agent => agent.meta.expert).map(agent => agent.id)).toEqual(ids)
    expect(adapter.requests).toHaveLength(0); expect(second).toHaveLength(0)
    await browser.resize(320, 760)
    expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  })

  it('saves on-demand memory without deleting notes and retrieves only active durable content', async () => {
    const memory = server.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({ content: '- 中文授权策略\n- 停用授权秘密' }, memory.snapshot().revision)
    const off = memory.snapshot().entries.find(entry => entry.content.includes('秘密'))!
    await memory.update({ entry: { collection: 'longTerm', id: off.id, action: 'toggle', enabled: false } }, memory.snapshot().revision)
    await memory.appendPending('待整理授权方向')
    await workspaceSettings()
    await browser.click('#workspaceMemoryList button[data-memory-workspace]')
    await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled")
    await browser.evaluate("(() => { const select = document.getElementById('memoryInjectionMode'); select.value = 'on-demand'; select.dispatchEvent(new Event('change', { bubbles: true })); })()")
    await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent.includes('已保存') && !document.getElementById('workspaceMemoryReload').disabled")
    await browser.click('#workspaceMemoryReload')
    await browser.waitFor("document.getElementById('memoryInjectionMode').value === 'on-demand' && !document.getElementById('workspaceMemorySave').disabled")
    await browser.fill('#memorySearchInput', '授权')
    await browser.click('#memorySearchBtn')
    await browser.waitFor("document.getElementById('memorySearchResults').textContent.includes('中文授权策略')")
    expect(await browser.evaluate("document.getElementById('memorySearchResults').textContent")).not.toContain('秘密')
    expect(await browser.evaluate("document.getElementById('memorySearchResults').textContent")).not.toContain('待整理')
    expect(memory.snapshot().content).toContain('中文授权策略')
    expect(memory.snapshot().injectionMode).toBe('on-demand')
    expect(adapter.requests).toHaveLength(0)
  })
})
