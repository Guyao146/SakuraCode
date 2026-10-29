/** The hidden team panel must not load every known workspace at startup. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { runWebServer } from '../src/web/server.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip

suite('client startup work', () => {
  it('defers collaboration until the visible team panel and preserves the preference after reload', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-startup-client-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('done')]), open: false, quiet: true,
      token: null, viewerToken: null, updatesAutoCheck: false })
    cleanups.push(() => handle.close())
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.startupCollaborationReads = 0;
      const originalStartupFetch = window.fetch;
      window.fetch = function(resource, options) {
        if (String(resource) === '/api/collaboration') window.startupCollaborationReads++;
        return originalStartupFetch.call(this, resource, options);
      };` })
    await browser.navigate(handle.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    expect(await browser.evaluate('window.startupCollaborationReads')).toBe(0)
    await browser.click('#inspectorBtn')
    await browser.waitFor('window.startupCollaborationReads === 1')
    await browser.waitFor("document.querySelector('.collaboration-workspace')")
    await browser.click('#changesTab')
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    expect(await browser.evaluate('window.startupCollaborationReads')).toBe(0)
    await browser.click('#teamTab')
    await browser.waitFor('window.startupCollaborationReads === 1')
    await browser.reload()
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接' && window.startupCollaborationReads === 1")
    expect(browser.errors).toEqual([])
  })

  it('keeps unchanged agent action nodes across unrelated state frames and still renders changed status', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-stable-agents-'))
    cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('done')]), open: false, quiet: true,
      token: null, viewerToken: null, updatesAutoCheck: false })
    cleanups.push(() => handle.close())
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `
      window.agentStateFrames = 0;
      const originalAgentEventSource = window.EventSource;
      window.EventSource = function(url, options) {
        const stream = new originalAgentEventSource(url, options);
        stream.addEventListener('message', function(event) {
          try { if (JSON.parse(event.data).type === 'state') window.agentStateFrames++; } catch {}
        });
        return stream;
      };
      window.EventSource.prototype = originalAgentEventSource.prototype;
    ` })
    await browser.navigate(handle.url)
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    const child = handle.harness.ctx.agents.spawn({ name: 'stable actions', seed: '', autoStart: false,
      persistentSession: true, meta: { role: 'sub' } })
    await child.turn('synthetic task')
    await browser.waitFor(`document.getElementById('totalAgents').textContent === '2' && document.querySelector('#agentList [data-agent-id="${child.id}"]')?.dataset.status === 'done'`)
    await browser.click('#inspectorBtn')
    const selector = `#agentList [data-agent-id="${child.id}"] .agent-view`
    await browser.evaluate(`(() => {
      window.stableAgentAction = document.querySelector(${JSON.stringify(selector)});
    })()`)
    const stateFrames = await browser.evaluate<number>('window.agentStateFrames')
    for (let n = 0; n < 24; n++) handle.harness.ctx.emit('agent/status', { id: child.id, status: child.status })
    await browser.waitFor('window.agentStateFrames > ' + stateFrames)
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}) === window.stableAgentAction && window.stableAgentAction.isConnected`)).toBe(true)
    child.error = 'SYNTHETIC_STATUS_CHANGED'; child.status = 'error'
    handle.harness.ctx.emit('agent/status', { id: child.id, status: 'error', error: child.error })
    await browser.waitFor(`document.querySelector('#agentList [data-agent-id="${child.id}"]').textContent.includes('SYNTHETIC_STATUS_CHANGED')`)
    expect(await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}) === window.stableAgentAction`)).toBe(false)
    expect(browser.errors).toEqual([])
  })
})