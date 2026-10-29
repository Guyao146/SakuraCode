/** Native Chrome/Edge coverage for retry confirmation, Skill upload and explicit references. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerOptions, type WebServerHandle } from '../src/web/server.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { DEFAULT_RETRY_POLICY } from '../src/util/retry.js'
import { MockAdapter, text } from './helpers.js'
import type { LLMRequest } from '../src/core/types.js'

const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
suite('productivity settings — real browser', () => {
  const browser = new BrowserClient(), dirs: string[] = [], servers: WebServerHandle[] = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => { while (servers.length) { const server = servers.pop()!; server.harness.ctx.agents.disposeAll(); await server.close() } while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
  async function directory() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-productivity-ui-')); dirs.push(cwd); return cwd }
  async function boot(extra: Partial<WebServerOptions> = {}) {
    const cwd = extra.cwd ?? await directory()
    const server = await runWebServer({ cwd, adapter: new MockAdapter([text('ANSWER')]), open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, onPersistSettings() {}, ...extra })
    servers.push(server); browser.errors.length = 0
    await browser.resize(1440); await browser.navigate(server.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && !document.getElementById('sendBtn').disabled")
    return { cwd, server }
  }
  async function settings(section: string) { await browser.click('#settingsViewBtn'); await browser.click('#settings-' + section + 'Tab') }

  it('edits retry timing/count and requires explicit confirmation after the limit, including browser reload', async () => {
    let calls = 0
    const { server } = await boot({ adapter: { id: 'ui-retry', defaultModel: 'ui-retry-model', async *stream() {
      calls++; if (calls < 3) yield { type: 'error', error: 'HTTP 503 temporarily unavailable' }; else yield* text('CONFIRMED_RECOVERY')
    } } })
    await settings('general')
    await browser.fill('#retryWindow', '30'); await browser.fill('#retryCount', '1'); await browser.fill('#retryDelay', '0')
    await browser.click('#retrySave'); await browser.waitFor("document.getElementById('retryMessage').textContent.includes('已保存') && !document.getElementById('retrySave').disabled")
    expect(await (await fetch(server.url + 'api/retry/settings')).json()).toEqual({ enabled: true, windowMs: 30000, maxRetries: 1, delayMs: 0 })
    await browser.click('#settingsBack'); await browser.fill('#input', 'single task'); await browser.click('#sendBtn')
    await browser.waitFor("document.querySelector('.retry-card:not(.resolved)') && !document.getElementById('stopBtn').hidden")
    expect(calls).toBe(2)
    await browser.reload(); await browser.waitFor("document.querySelector('.retry-card:not(.resolved) button:not(:disabled)')")
    expect(calls).toBe(2)
    await browser.click('.retry-card:not(.resolved) .btn-accent')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('CONFIRMED_RECOVERY') && document.getElementById('stopBtn').hidden")
    expect(calls).toBe(3)
    expect(browser.errors).toEqual([])
  })

  it('keeps the previous retry policy after a failed desktop save and preserves the form draft', async () => {
    const persist = vi.fn(async () => { throw new Error('disk locked') })
    const { server } = await boot({ onPersistRetry: persist })
    await settings('general'); await browser.fill('#retryCount', '7'); await browser.click('#retrySave')
    await browser.waitFor("document.getElementById('retryMessage').classList.contains('error') && !document.getElementById('retrySave').disabled")
    expect(await browser.evaluate("document.getElementById('retryCount').value")).toBe('7')
    expect(await (await fetch(server.url + 'api/retry/settings')).json()).toEqual(DEFAULT_RETRY_POLICY)
    expect(persist).toHaveBeenCalledTimes(1); expect(browser.errors).toEqual([])
  })

  it('imports an actual SKILL.md file and selects it using the keyboard @ menu', async () => {
    const requests: LLMRequest[] = [], { cwd, server } = await boot({ adapter: new MockAdapter([request => { requests.push(request); return text('SKILL_USED') }]) })
    const file = path.join(cwd, 'SKILL.md')
    await fs.writeFile(file, '---\nname: keyboard-skill\ndescription: 键盘选取技能\n---\nSKILL_BODY_SELECTED')
    await browser.click('#settingsViewBtn'); await browser.click('#settings-skillsTab')
    const document = await browser.send('DOM.getDocument')
    const node = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#skillImportFile' })
    await browser.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] })
    await browser.waitFor("document.getElementById('skillImportMessage').textContent.includes('已导入 keyboard-skill')")
    expect(await fs.readFile(path.join(cwd, '.sakura', 'skills', 'keyboard-skill', 'SKILL.md'), 'utf8')).toContain('SKILL_BODY_SELECTED')
    await browser.click('#settingsBack'); await browser.fill('#input', '@keyboard-skill')
    await browser.waitFor("document.querySelector('#mentionMenu [data-reference-kind=" + JSON.stringify('skill') + "]')")
    await browser.key('Enter')
    expect(await browser.evaluate("document.getElementById('input').value")).toContain('@[skill:keyboard-skill]')
    await browser.click('#sendBtn'); await browser.waitFor("document.getElementById('chatCol').textContent.includes('SKILL_USED') && document.getElementById('stopBtn').hidden")
    expect(JSON.stringify(requests[0]?.messages)).toContain('SKILL_BODY_SELECTED')
    expect(browser.errors).toEqual([])
    await server.harness.main().wait()
  })

  it('supports real automatic size-triggered memory consolidation and manual settings management', async () => {
    const requests: LLMRequest[] = []
    const { server } = await boot({ adapter: new MockAdapter([
      request => { requests.push(request); return text('CONFIRMED_TASK_ANSWER') },
      request => { requests.push(request); return text('# CONSOLIDATED_LONG_TERM\n- Confirmed useful preference.') },
    ]) })
    await settings('workspace'); await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
    await browser.click('#workspaceMemoryList [data-memory-workspace]'); await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled")
    await browser.fill('#memoryThreshold', '1000'); await browser.fill('#memoryInterval', '0'); await browser.click('#workspaceMemorySave')
    await browser.waitFor("document.getElementById('workspaceMemoryMessage').textContent.includes('已保存') && !document.getElementById('workspaceMemorySave').disabled")
    expect(await (await fetch(server.url + 'api/workspace/memory')).json()).toMatchObject({ processing: { auto: true, thresholdChars: 1000, intervalMs: 0 } })
    await browser.click('#settingsBack'); await browser.fill('#input', '已确认的长期约定 '.repeat(130)); await browser.click('#sendBtn')
    await vi.waitFor(() => expect(requests).toHaveLength(2), { timeout: 8000 })
    await browser.waitFor("document.getElementById('stopBtn').hidden && !document.getElementById('sendBtn').disabled")
    await settings('workspace'); await browser.click('#workspaceMemoryList [data-memory-workspace]')
    await browser.waitFor("document.getElementById('workspaceMemoryContent').value.includes('CONSOLIDATED_LONG_TERM') && document.getElementById('memoryPendingStatus').textContent.includes('待整理 0 字')")
    expect(JSON.stringify(requests[1]?.messages)).toContain('Consolidate durable workspace memory')
    expect(server.harness.ctx.systemPrompt.assemble()).toContain('CONSOLIDATED_LONG_TERM')
    for (const width of [1440, 390, 320]) {
      await browser.resize(width)
      expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')).toBe(true)
    }
    expect(browser.errors).toEqual([])
  })

  it('shows memory metadata first, manages another workspace on demand, and explicitly @ references it', async () => {
    const cwd = await directory(), other = await directory(), requests: LLMRequest[] = []
    await new WorkspaceMemoryStore(other).update({ content: 'CROSS_WORKSPACE_DURABLE_FACT' }, 0)
    await boot({ cwd, recentWorkspaces: [other], adapter: new MockAdapter([request => { requests.push(request); return text('MEMORY_USED') }]) })
    await settings('workspace'); await browser.waitFor("document.querySelectorAll('#workspaceMemoryList [data-memory-workspace]').length === 2")
    expect(await browser.evaluate("document.getElementById('workspaceMemoryEditor').hidden")).toBe(true)
    expect(await browser.evaluate("document.getElementById('workspaceMemoryContent').value")).toBe('')
    await browser.evaluate(`Array.from(document.querySelectorAll('[data-memory-workspace]')).find(node => node.dataset.memoryWorkspace === ${JSON.stringify(other)}).click()`)
    await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'CROSS_WORKSPACE_DURABLE_FACT'")
    await browser.click('#workspaceMemoryEditorClose'); await browser.click('#settingsBack')
    await browser.fill('#input', '@记忆'); await browser.waitFor("document.querySelectorAll('#mentionMenu [data-reference-kind=" + JSON.stringify('memory') + "]').length === 2")
    await browser.evaluate(`Array.from(document.querySelectorAll('#mentionMenu [role="option"]')).find(node => node.textContent.includes(${JSON.stringify(other)})).click()`)
    await browser.click('#sendBtn'); await browser.waitFor("document.getElementById('chatCol').textContent.includes('MEMORY_USED') && document.getElementById('stopBtn').hidden")
    expect(JSON.stringify(requests[0]?.messages)).toContain('CROSS_WORKSPACE_DURABLE_FACT')
    expect(browser.errors).toEqual([])
  })
})