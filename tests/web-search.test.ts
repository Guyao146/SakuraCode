/**
 * tests/web-search.test.ts — web_search: parseResults/decodeEntities pure
 * functions against a fixed DuckDuckGo-style fixture, and the full tool
 * pipeline against a local node:http stub (port 0).
 */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { webSearchToolsPlugin, parseResults, decodeEntities } from '../src/tools/web-search.js'
import type { ToolContext } from '../src/core/types.js'

const servers: http.Server[] = []
const contexts: Context[] = []

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  while (contexts.length) contexts.pop()?.dispose()
})

const tc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

/** A DuckDuckGo-HTML-style results page: one uddg-redirect result, one direct link. */
const FIXTURE = `<!doctype html><html><head><title>results</title></head><body>
<div class="result results_links results_links_deep">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fintro&amp;rut=abc123">Example Docs &amp; Guides</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%2Fintro&amp;rut=abc123">How to install &amp; configure the <b>thing</b> quickly.</a>
</div>
<div class="result results_links results_links_deep">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="https://direct.example.org/page?q=1">Direct &#x27;Quoted&#x27; Link</a></h2>
  <a class="result__snippet" href="#">A plain snippet with &lt;tags&gt; escaped &amp; folded.</a>
</div>
</body></html>`

interface Captured {
  method?: string
  body: string
  contentType: string
  userAgent: string
}

/** Start an ephemeral-port http server answering every POST with the page. */
async function startServer(status: number, html: string): Promise<{ base: string; captured: Captured }> {
  const captured: Captured = { body: '', contentType: '', userAgent: '' }
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    req.on('end', () => {
      captured.method = req.method
      captured.body = body
      captured.contentType = String(req.headers['content-type'] ?? '')
      captured.userAgent = String(req.headers['user-agent'] ?? '')
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, captured }
}

async function mountWebSearch(endpoint: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(webSearchToolsPlugin, { endpoint })
  return ctx
}

describe('parseResults / decodeEntities (pure)', () => {
  it('extracts title/url/snippet, unwraps uddg redirects and decodes entities', () => {
    const results = parseResults(FIXTURE)

    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({
      title: 'Example Docs & Guides',
      url: 'https://example.com/docs/intro',
      snippet: 'How to install & configure the thing quickly.',
    })
    expect(results[1]!.url).toBe('https://direct.example.org/page?q=1')
    expect(results[1]!.title).toBe("Direct 'Quoted' Link")
    expect(results[1]!.snippet).toBe('A plain snippet with <tags> escaped & folded.')
  })

  it('decodes the required entity set and numeric references', () => {
    expect(decodeEntities('&amp;&lt;&gt;&quot;&#x27;&nbsp;')).toBe(`&<>"' `)
    expect(decodeEntities('&#65;&#x42;')).toBe('AB')
  })

  it('falls back to loose anchor extraction when no result__a markup exists', () => {
    const results = parseResults(
      '<div><a href="https://fallback.example.net/x">Fallback &amp; Title</a><a href="/relative">skip me</a></div>',
    )
    expect(results).toEqual([{ title: 'Fallback & Title', url: 'https://fallback.example.net/x', snippet: '' }])
  })
})

describe('web_search tool', () => {
  it('posts the query and returns a numbered list through ctx.tools', async () => {
    const { base, captured } = await startServer(200, FIXTURE)
    const ctx = await mountWebSearch(`${base}/`)
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c1', 'web_search', JSON.stringify({ query: 'test query' }), tc())

    expect(result.isError).toBeFalsy()
    expect(captured.method).toBe('POST')
    expect(captured.body).toBe('q=test%20query')
    expect(captured.contentType).toContain('application/x-www-form-urlencoded')
    expect(captured.userAgent).toContain('Mozilla/5.0')
    expect(result.output).toContain('1. Example Docs & Guides')
    expect(result.output).toContain('https://example.com/docs/intro')
    expect(result.output).toContain('2. Direct \'Quoted\' Link')
    expect(result.output).toContain('https://direct.example.org/page?q=1')
  })

  it('honors max_results=1 by returning only the first hit', async () => {
    const { base } = await startServer(200, FIXTURE)
    const ctx = await mountWebSearch(`${base}/`)
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c2', 'web_search', JSON.stringify({ query: 'test', max_results: 1 }), tc())

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('1. Example Docs & Guides')
    expect(result.output).not.toContain("Direct 'Quoted' Link")
  })

  it("returns '(no results)' for a page without anchors", async () => {
    const { base } = await startServer(
      200,
      '<html><body><div class="result"><span class="result__nothing">no anchors here</span></div></body></html>',
    )
    const ctx = await mountWebSearch(`${base}/`)
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c3', 'web_search', JSON.stringify({ query: 'test' }), tc())

    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('(no results)')
  })

  it('surfaces a server error as isError with the status code', async () => {
    const { base } = await startServer(500, 'boom')
    const ctx = await mountWebSearch(`${base}/`)
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c4', 'web_search', JSON.stringify({ query: 'test' }), tc())

    expect(result.isError).toBe(true)
    expect(result.output).toContain('500')
  })
})
