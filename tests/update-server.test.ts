/** Update-check server integration: single-flight checks, error retention, notification semantics, lifecycle. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

interface Call {
  tag: string | null
  ok: boolean
  body: string
  delay: number
  release: (() => void) | null
}

/** Scripted fake feed: one `Call` is consumed per request, in order. */
async function scriptedFeed(calls: Call[]): Promise<{ url: string; requests: number }> {
  const requests = { count: 0 }
  const server = http.createServer((req, res) => {
    requests.count += 1
    const call = calls[Math.min(requests.count - 1, calls.length - 1)]!
    const timer = setTimeout(() => {
      if (!call.ok) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'feed unavailable' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: call.tag ?? '', html_url: 'https://example.com/never-trusted' }))
    }, call.delay)
    req.on('close', () => clearTimeout(timer))
    if (call.release) call.release()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const port = (server.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/releases/latest`, get requests() { return requests.count } }
}

const releaseTag = 'https://github.com/Guyao146/SakuraCode/releases/tag/'

async function boot(options: { fetch?: typeof fetch; baseUrl?: string; initialDelay?: number; interval?: number; auto?: boolean } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-update-server-'))
  const fetchScript = options.fetch
  const handle = await runWebServer({
    cwd: tmpDir, adapter: new MockAdapter([text('ok')]), approvalMode: 'yolo', quiet: true, open: false,
    updatesAutoCheck: options.auto ?? true,
    updatesBaseUrl: options.baseUrl,
    updatesInitialDelayMs: options.initialDelay ?? 100,
    updatesIntervalMs: options.interval ?? 60_000,
    ...(fetchScript ? { updatesFetch: fetchScript } : {}),
  })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  })
  return handle
}

const post = (url: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
interface UpdateInfo { current: string; latest?: string; hasUpdate: boolean; releaseUrl?: string; error?: string }
interface SseFrame { type?: string; update?: UpdateInfo; notify?: boolean }

/** Subscribe to the SSE stream; keep collecting frames until stop(). */
function sseCollect(base: string, timeoutMs = 30_000): { frames: SseFrame[]; stop(): Promise<void> } {
  const frames: SseFrame[] = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const reading = (async () => {
    const response = await fetch(base + 'api/events', { signal: controller.signal })
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split('\n\n')
      buffer = events.pop() ?? ''
      for (const event of events) {
        const data = event.split('\n').find((line) => line.startsWith('data: '))
        if (data) frames.push(JSON.parse(data.slice(6)) as SseFrame)
      }
    }
  })().catch(() => {})
  return {
    frames,
    async stop() {
      clearTimeout(timer)
      controller.abort()
      await reading.catch(() => {})
    },
  }
}

describe('web server — update integration', () => {
  it('coalesces concurrent manual checks into one feed request and notifies once', async () => {
    const calls: Call[] = [{ tag: 'v99.0.0', ok: true, body: '', delay: 0, release: null }]
    const feed = await scriptedFeed(calls)
    const handle = await boot({ baseUrl: feed.url, fetch: undefined, initialDelay: 60_000, interval: 60_000, auto: true })
    const sse = sseCollect(handle.url)
    cleanups.push(async () => { await sse.stop() })
    // Fire two manual checks while the flight is still pending.
    const first = post(handle.url + 'api/updates/check')
    const second = post(handle.url + 'api/updates/check')
    await vi.waitFor(() => expect(feed.requests).toBe(1), { timeout: 5_000 })
    const [a, b] = await Promise.all([first, second])
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const infoA = (await a.json()) as UpdateInfo
    const infoB = (await b.json()) as UpdateInfo
    expect(infoA).toEqual(infoB)
    expect(infoA).toMatchObject({ latest: '99.0.0', hasUpdate: true, releaseUrl: releaseTag + 'v99.0.0' })
    expect(feed.requests).toBe(1)
    expect((await (await fetch(handle.url + 'api/state')).json() as { update?: UpdateInfo }).update).toMatchObject({ latest: '99.0.0', hasUpdate: true })
    // First emission for a version carries notify=true; a repeat detection does not.
    await vi.waitFor(() => {
      expect(sse.frames.filter((f) => f.type === 'update' && f.notify === true)).toHaveLength(1)
      expect(sse.frames.filter((f) => f.type === 'update')).toHaveLength(1)
    }, { timeout: 5_000 })
    await post(handle.url + 'api/updates/check')
    await vi.waitFor(() => expect(sse.frames.filter((f) => f.type === 'update')).toHaveLength(2), { timeout: 5_000 })
    expect(sse.frames.filter((f) => f.type === 'update' && f.notify === true)).toHaveLength(1)
    expect(sse.frames.filter((f) => f.type === 'notice')).toHaveLength(0)
    expect(feed.requests).toBe(2)
  })

  it('retains the last known release through a temporary feed failure', async () => {
    const calls = [
      { tag: 'v99.0.0', ok: true, body: '', delay: 0, release: null },
      { tag: null, ok: false, body: '', delay: 0, release: null },
    ]
    const feed = await scriptedFeed(calls)
    const handle = await boot({ baseUrl: feed.url, auto: false, initialDelay: 60_000, interval: 60_000 })
    const first = (await (await post(handle.url + 'api/updates/check')).json()) as UpdateInfo
    expect(first).toMatchObject({ latest: '99.0.0', hasUpdate: true })
    const failed = (await (await post(handle.url + 'api/updates/check')).json()) as UpdateInfo
    // A temporary failure keeps the last-known release fields and reports the error.
    expect(filled(failed.error)).toBe(true)
    expect(failed.latest).toBe('99.0.0')
    const state = (await (await fetch(handle.url + 'api/state')).json()) as { update?: UpdateInfo }
    expect(state.update?.latest).toBe('99.0.0')
    expect(state.update?.error).toBeTruthy()
  })

  it('recovery after an error does not re-notify the same version', async () => {
    const calls = [
      { tag: 'v99.0.0', ok: true, body: '', delay: 0, release: null },
      { tag: null, ok: false, body: '', delay: 0, release: null },
      { tag: 'v99.0.0', ok: true, body: '', delay: 0, release: null },
    ]
    const feed = await scriptedFeed(calls)
    const handle = await boot({ baseUrl: feed.url, auto: false })
    const sse = sseCollect(handle.url)
    cleanups.push(async () => { await sse.stop() })
    await post(handle.url + 'api/updates/check')
    await post(handle.url + 'api/updates/check')
    const recovered = (await (await post(handle.url + 'api/updates/check')).json()) as UpdateInfo
    expect(recovered).toMatchObject({ latest: '99.0.0', hasUpdate: true })
    expect(sse.frames.filter((f) => f.type === 'update' && f.notify === true)).toHaveLength(1)
  })

  it('uses the injected fetch for the default feed and never reaches a real network', async () => {
    const used: string[] = []
    const injected = ((input: RequestInfo | URL, init?: RequestInit) => {
      used.push(String(input))
      return Promise.resolve(new Response(JSON.stringify({ tag_name: 'v0.0.1' }), { status: 200, headers: { 'content-type': 'application/json' } }))
    }) as typeof fetch
    const handle = await boot({ fetch: injected, auto: true, initialDelay: 50, interval: 60_000 })
    const info = (await (await post(handle.url + 'api/updates/check')).json()) as UpdateInfo
    expect(info.hasUpdate).toBe(false)
    expect(used.length).toBeGreaterThan(0)
    expect(used.every((url) => url === 'https://api.github.com/repos/Guyao146/SakuraCode/releases/latest')).toBe(true)
  })

  it('lets a read-only viewer check for updates while expert start stays forbidden', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-update-viewer-'))
    const viewerToken = 'viewer'.repeat(8)
    const token = 'operator'.repeat(8)
    const handle = await runWebServer({
      cwd: tmpDir, adapter: new MockAdapter([text('ok')]), approvalMode: 'yolo', quiet: true, open: false,
      token, viewerToken, updatesAutoCheck: false,
    })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })
    const asOperator = (await fetch(handle.url + 'api/updates/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' })).status
    expect(asOperator).toBe(200)
    const asViewer = (await fetch(handle.url + 'api/updates/check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${viewerToken}` }, body: '{}' })).status
    expect(asViewer).toBe(200)
    const expert = (await fetch(handle.url + 'api/experts/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${viewerToken}` }, body: '{}' })).status
    expect(expert).toBe(403)
  })

  it('stops all update work on close: no further feed poll after shutdown', async () => {
    const calls = [{ tag: 'v99.0.0', ok: true, body: '', delay: 0, release: null }]
    const feed = await scriptedFeed(calls)
    const handle = await boot({ baseUrl: feed.url, auto: true, initialDelay: 40, interval: 50 })
    await handle.close()
    const before = feed.requests
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(feed.requests).toBe(before)
  })
})

function filled(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
