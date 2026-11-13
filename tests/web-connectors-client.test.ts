/** Real browser connector management uses only synthetic loopback software. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'

const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
suite('external software connectors — real browser', () => {
  const browser = new BrowserClient()
  let cwd = '', web: WebServerHandle, external: Server, url = '', requests: string[]
  beforeAll(async () => browser.start())
  afterAll(async () => browser.close())
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-connectors-ui-')); requests = []
    external = createServer(async (req, res) => {
      const parts = []; for await (const chunk of req) parts.push(chunk)
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {}
      requests.push(req.url!)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url === '/capabilities' ? { version: 1, actions: [{ name: 'query', description: 'Synthetic outside software query', parameters: { type: 'object' } }], knowledge: { search: true, read: true } } :
        req.url === '/knowledge/search' ? { results: [{ id: 'doc1', source: 'synthetic:outside', snippet: 'External 中文授权资料 <script>window.OUTSIDE_EXECUTED=true</script>' }], truncated: false } :
          { id: body.id, source: 'synthetic:outside', content: 'External reference <script>window.OUTSIDE_EXECUTED=true</script>', truncated: false }))
    })
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve)); url = 'http://127.0.0.1:' + (external.address() as { port: number }).port
    web = await runWebServer({ cwd, adapter: new MockAdapter([text('offline')]), open: false, quiet: true, approvalMode: 'yolo', updatesAutoCheck: false,
      config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    browser.errors.length = 0; await browser.resize(1440, 960); await browser.navigate(web.url)
    await browser.waitFor("document.documentElement.dataset.boot === 'ready'")
    await browser.fill('#input', 'KEEP_CONNECTOR_DRAFT')
    await browser.click('#settingsViewBtn'); await browser.click('[data-settings-section="integrations"]')
    await browser.waitFor("!document.getElementById('connectorsCard').hidden && !document.getElementById('connectorsRefresh').disabled")
  })
  afterEach(async () => {
    const errors = [...browser.errors]; await browser.navigate('about:blank'); await web.close()
    await new Promise<void>(resolve => { external.closeAllConnections(); external.close(() => resolve()) })
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}); expect(errors).toEqual([])
  })
  async function editor() {
    await browser.click('#connectorsAdd'); await browser.waitFor("document.getElementById('connectorDialog')?.open")
    await browser.fill('#connectorId', 'demo'); await browser.fill('#connectorName', 'Synthetic outside knowledge'); await browser.fill('#connectorUrl', url)
    await browser.evaluate("(() => { const select = document.getElementById('connectorCategory'); select.value = 'knowledge'; select.dispatchEvent(new Event('change', {bubbles:true})); })()")
  }
  async function save() {
    await editor(); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && document.querySelector('[data-connector-id=demo]')")
  }
  async function cardButton(label: string) {
    const selector = await browser.evaluate<string>(`(() => { const buttons = Array.from(document.querySelector('[data-connector-id=demo]').querySelectorAll('button')); const index = buttons.findIndex(button => button.textContent === ${JSON.stringify(label)}); if (index < 0) throw Error('missing connector action'); return '[data-connector-id=demo] button:nth-child(' + (index+1) + ')'; })()`)
    await browser.click(selector)
  }
  it('saves without connecting, cancels network consent, enables real capabilities and explicitly searches/reads safe reference text', async () => {
    await save(); expect(requests).toEqual([])
    await cardButton('连接'); await browser.waitFor("document.getElementById('connectorDialog')?.open")
    await browser.click('#connectorDialog .spawn-actions button[type=button]'); expect(requests).toEqual([])
    await cardButton('连接'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && document.querySelector('[data-connector-id=demo]').textContent.includes('已连接')")
    expect(requests).toEqual(['/capabilities']); expect(web.harness.ctx.tools.get('connector__demo__query')).toBeUndefined()
    await cardButton('启用能力'); await browser.click('#capability-query'); await browser.click('#connectorKnowledgeEnabled'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && !document.getElementById('externalKnowledgePanel').hidden")
    expect(web.harness.ctx.tools.get('connector__demo__query')?.kind).toBe('execute')
    await browser.fill('#externalKnowledgeQuery', '中文授权'); await browser.click('#externalKnowledgeSearch')
    await browser.click('#connectorDialog .spawn-actions button[type=button]'); expect(requests).toEqual(['/capabilities'])
    await browser.click('#externalKnowledgeSearch'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && document.getElementById('externalKnowledgeResults').textContent.includes('中文授权资料')")
    expect(requests).toEqual(['/capabilities', '/knowledge/search']); expect(await browser.evaluate('window.OUTSIDE_EXECUTED')).toBeUndefined()
    await browser.click('#externalKnowledgeResults button'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && !document.getElementById('externalKnowledgeReader').hidden")
    expect(await browser.evaluate('window.OUTSIDE_EXECUTED')).toBeUndefined()
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('KEEP_CONNECTOR_DRAFT')
    await browser.resize(320, 760); expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
  })
  it('shows the original approval card for external knowledge and sends nothing when denied', async () => {
    await save(); await cardButton('连接'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && document.querySelector('[data-connector-id=demo]').textContent.includes('已连接')")
    await cardButton('启用能力'); await browser.click('#connectorKnowledgeEnabled'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && !document.getElementById('externalKnowledgePanel').hidden")
    await fetch(web.url + 'api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalMode: 'default' }) })
    await browser.waitFor("document.getElementById('approvalSelBottom').value === 'default'")
    await browser.fill('#externalKnowledgeQuery', '中文授权'); await browser.click('#externalKnowledgeSearch'); await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('connectorDialog') && Array.from(document.querySelectorAll('.ap-actions button')).some(button => button.textContent.includes('拒绝'))")
    expect(requests).toEqual(['/capabilities'])
    await browser.evaluate("Array.from(document.querySelectorAll('.ap-actions button')).find(button => button.textContent.includes('拒绝')).click()")
    await browser.waitFor("document.getElementById('connectorsStatus').textContent.includes('未完成') || document.getElementById('connectorsStatus').textContent.includes('批准')")
    expect(requests).toEqual(['/capabilities'])
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('KEEP_CONNECTOR_DRAFT')
  })
  it('keeps an invalid metadata draft and uses keyboard cancellation without starting software', async () => {
    await editor(); await browser.fill('#connectorHeaders', '{"Authorization":"Bearer literal-token"}')
    await browser.click('#connectorDialog button[type=submit]')
    await browser.waitFor("!document.querySelector('#connectorDialog .form-error').hidden")
    expect(await browser.evaluate("document.getElementById('connectorName').value")).toBe('Synthetic outside knowledge')
    expect(requests).toEqual([])
    await browser.key('Escape'); await browser.waitFor("!document.getElementById('connectorDialog')")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('KEEP_CONNECTOR_DRAFT')
  })
})
