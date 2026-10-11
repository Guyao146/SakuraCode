/**
 * tests/browser.test.ts — CDP browser tools (real Chrome-family browser).
 *
 * Skipped entirely when resolveChromePath() finds no Chrome/Edge on this
 * machine; otherwise the suite launches the REAL browser (headless) against
 * a local node:http stub page and exercises navigate / evaluate / type+click
 * / screenshot / key end-to-end over the DevTools protocol. The browser is
 * closed explicitly in afterAll (browser_close), and ctx.dispose() runs the
 * plugin disposer as a second net.
 */

import { createServer, type Server } from 'node:http'
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { HarnessContext } from '../src/core/index.js'
import { toolsPlugin } from '../src/core/tools.js'
import type { ToolContext } from '../src/core/types.js'
import { browserToolsPlugin, parsePngSize, resolveChromePath } from '../src/tools/browser.js'

// -- helpers ------------------------------------------------------------------

const chromePath = resolveChromePath()
const suite = chromePath ? describe : describe.skip

function mkTc(): ToolContext {
  return { sessionId: 's', agentId: 'a', signal: new AbortController().signal }
}

const PAGE_HTML =
  '<html><title>Stub Page</title><body>' +
  '<input id="box">' +
  '<button id="btn" onclick="document.getElementById(\'box\').value=\'clicked\'">go</button>' +
  '<div id="out">hello</div>' +
  '</body></html>'

// -- pure helpers (run regardless of browser availability) --------------------

describe('parsePngSize', () => {
  it('reads width/height from the IHDR header', () => {
    const png = Buffer.alloc(33)
    png.writeUInt32BE(0x89504e47, 0)
    png.writeUInt32BE(0x0d0a1a0a, 4)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(0x000003c0, 16) // 960
    png.writeUInt32BE(0x000002d0, 20) // 720
    expect(parsePngSize(png)).toEqual({ w: 960, h: 720 })
  })

  it('rejects non-PNG buffers', () => {
    expect(() => parsePngSize(Buffer.from('<html>'))).toThrow(/not a PNG/)
    expect(() => parsePngSize(Buffer.alloc(10))).toThrow(/not a PNG/)
  })
})

describe('resolveChromePath', () => {
  it('falls through to the probe chain when the explicit path does not exist', () => {
    // Missing explicit paths chain on to $SAKURA_CHROME and the candidate
    // probe, so the result equals the default resolution (null when this
    // machine has no browser at all).
    expect(resolveChromePath('C:/definitely/not/a/browser.exe')).toBe(chromePath)
  })

  it('honors an existing explicit path', () => {
    if (!chromePath) return // nothing installed on this machine
    expect(resolveChromePath(chromePath)).toBe(chromePath)
  })
})

// -- end-to-end against a real browser ----------------------------------------

suite('browserToolsPlugin (real browser)', () => {
  let ctx: HarnessContext | undefined
  let server: Server | undefined
  let baseUrl = ''

  let callSeq = 0
  async function call(name: string, args: Record<string, unknown>) {
    callSeq++
    return ctx!.tools.execute(`browser-${callSeq}`, name, JSON.stringify(args), mkTc())
  }

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(PAGE_HTML)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const addr = server!.address()
    const port = addr && typeof addr === 'object' ? addr.port : 0
    baseUrl = `http://127.0.0.1:${port}/`

    ctx = new HarnessContext()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(browserToolsPlugin)
  }, 30_000)

  afterAll(async () => {
    if (ctx) {
      // Explicit close (the disposer via ctx.dispose() is the second net).
      const result = await ctx.tools.execute('browser-close', 'browser_close', '{}', mkTc())
      expect(result.isError).toBeFalsy()
      ctx.dispose()
      ctx = undefined
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()))
      server = undefined
    }
  }, 30_000)

  it('registers the browser tools', () => {
    for (const name of [
      'browser_navigate',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_key',
      'browser_evaluate',
    ]) {
      expect(ctx!.tools.get(name)?.name).toBe(name)
    }
    // The close-type tool used for teardown is registered too.
    expect(ctx!.tools.get('browser_close')?.name).toBe('browser_close')
  })

  it('browser_navigate loads the stub page and reports its title', async () => {
    const result = await call('browser_navigate', { url: baseUrl })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain(baseUrl)
    expect(result.output).toContain('Stub Page')
  }, 60_000)

  it('browser_evaluate reads DOM state', async () => {
    const result = await call('browser_evaluate', { expression: "document.getElementById('out').textContent" })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.output)).toBe('hello')
  }, 60_000)

  it('browser_type + browser_click drive the page', async () => {
    const typed = await call('browser_type', { text: 'hello from sakura', selector: '#box' })
    expect(typed.isError).toBeFalsy()
    expect(typed.output).toContain('#box')

    const clicked = await call('browser_click', { selector: '#btn' })
    expect(clicked.isError).toBeFalsy()

    const value = await call('browser_evaluate', { expression: "document.getElementById('box').value" })
    expect(JSON.parse(value.output)).toBe('clicked')
  }, 60_000)

  it('browser_screenshot returns a PNG data URL with sane dimensions', async () => {
    const result = await call('browser_screenshot', {})
    expect(result.isError).toBeFalsy()
    expect(result.output).toMatch(/screenshot \d+x\d+/)
    expect(result.images).toHaveLength(1)
    const img = result.images?.[0] ?? ''
    expect(img).toMatch(/^data:image\/png;base64,/)
    const size = parsePngSize(Buffer.from(img.slice(img.indexOf(',') + 1), 'base64'))
    expect(size.w).toBeGreaterThan(0)
    expect(size.h).toBeGreaterThan(0)
  }, 60_000)

  it('browser_key presses a key without error', async () => {
    const focus = await call('browser_evaluate', { expression: "document.getElementById('box').focus()" })
    expect(focus.isError).toBeFalsy()
    const pressed = await call('browser_key', { key: 'End' })
    expect(pressed.isError).toBeFalsy()
  }, 60_000)
})
