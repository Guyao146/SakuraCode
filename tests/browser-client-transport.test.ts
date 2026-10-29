import * as http from 'node:http'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserClient, readCdpJson } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'

describe('browser test driver CDP discovery', () => {
  it('waits through an initial retiring execution context, but propagates unrelated errors', async () => {
    const browser = new BrowserClient()
    const evaluate = vi.spyOn(browser, 'evaluate')
      .mockRejectedValueOnce(new Error('Execution context was destroyed.'))
      .mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await expect(browser.waitFor('document.readyState === "complete"')).resolves.toBeUndefined()
    expect(evaluate).toHaveBeenCalledTimes(3)
    evaluate.mockRejectedValueOnce(new Error('ReferenceError: real page bug'))
    await expect(browser.waitFor('broken()')).rejects.toThrow('real page bug')
    evaluate.mockRestore()
  })

  it('reads a loopback control endpoint on a Fetch-restricted port without weakening page requests', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/json/list' ? 200 : 503, { 'content-type': 'application/json' })
      res.end(req.url === '/json/list' ? JSON.stringify([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/test' }]) : '{}')
    })
    let port: number | undefined
    try {
      for (const candidate of [10080, 6667, 6000, 5060]) {
        try {
          await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => reject(error)
            server.once('error', failed)
            server.listen(candidate, '127.0.0.1', () => { server.off('error', failed); resolve() })
          })
          port = candidate
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
        }
      }
      if (!port) throw new Error('no available restricted loopback test port')
      await expect(fetch(`http://127.0.0.1:${port}/json/list`)).rejects.toThrow('fetch failed')
      await expect(readCdpJson(String(port), '/json/list')).resolves.toEqual([{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1/test' }])
      await expect(readCdpJson(String(port), '/json/version')).rejects.toThrow('HTTP 503')
    } finally {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('rejects invalid or non-loopback port input before connecting', async () => {
    for (const port of ['', '0', '65536', '-1', 'example.com:80', '80/path']) {
      await expect(readCdpJson(port, '/json/list')).rejects.toThrow('invalid CDP port')
    }
  })
})

const browserSuite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip

browserSuite('browser test driver viewport lifecycle', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  it('restores actual window bounds after rapid responsive emulation and viewport screenshots', async () => {
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()
    await browser.navigate('data:text/html,<style>html,body{margin:0;height:100%}main{width:100%;height:100%;background:%231a1c22}</style><main>Viewport lifecycle</main>')
    const metrics = () => browser.evaluate<{ width: number; height: number; content: number }>('({width:innerWidth,height:innerHeight,content:document.querySelector("main").getBoundingClientRect().width})')
    const actual = await metrics()
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-viewport-test-'))
    cleanups.unshift(() => fs.rm(directory, { recursive: true, force: true }))
    for (const width of [390, 1920, 1000, 1440]) {
      await browser.resize(width, 760)
      expect(await metrics()).toEqual({ width, height: 760, content: width })
    }
    await browser.screenshot(path.join(directory, 'emulated.png'))
    await browser.resetViewport()
    expect(await metrics()).toEqual(actual)
    const screenshot = path.join(directory, 'actual.png')
    await browser.screenshot(screenshot)
    const png = await fs.readFile(screenshot)
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([actual.width, actual.height])
    expect(await metrics()).toEqual(actual)
    await browser.reload()
    expect(await metrics()).toEqual(actual)
    expect(browser.errors).toEqual([])
  })

  it('clears a responsive override in failure cleanup without changing the next page viewport', async () => {
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()
    const actual = await browser.evaluate('({width:innerWidth,height:innerHeight})')
    await expect((async () => {
      try { await browser.resize(390, 720); throw new Error('synthetic responsive test failure') }
      finally { await browser.resetViewport() }
    })()).rejects.toThrow('synthetic responsive test failure')
    expect(await browser.evaluate('({width:innerWidth,height:innerHeight})')).toEqual(actual)
    await browser.navigate('data:text/html,<title>After responsive test</title>')
    expect(await browser.evaluate('({width:innerWidth,height:innerHeight})')).toEqual(actual)
    expect(browser.errors).toEqual([])
  })
})