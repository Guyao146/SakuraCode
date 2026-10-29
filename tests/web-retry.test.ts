import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../src/util/retry.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-retry-api-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, ...extra })
  cleanups.push(() => handle.close())
  return handle
}
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
interface State { pendingRequests: Array<{ id: string; type: string; retries: number }>; retryPolicy: RetryPolicy; retries: unknown[]; busy: boolean }
const state = async (base: string) => await (await fetch(base + 'api/state')).json() as State

describe('retry settings and confirmation API', () => {
  it('waits for persistence acknowledgement and rolls back failed saves', async () => {
    let accept!: () => void, reject!: (error: Error) => void
    const persist = vi.fn(() => new Promise<void>((resolve, decline) => { accept = resolve; reject = decline }))
    const handle = await boot({ onPersistSettings() {}, onPersistRetry: persist })
    const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2, delayMs: 0 }
    let completed = false
    const first = post(handle.url, 'api/retry/settings', policy).then(response => { completed = true; return response })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(completed).toBe(false)
    expect((await state(handle.url)).retryPolicy).toEqual(DEFAULT_RETRY_POLICY)
    expect((await post(handle.url, 'api/retry/settings', policy)).status).toBe(409)
    reject(new Error('disk locked')); expect((await first).status).toBe(500)
    expect((await state(handle.url)).retryPolicy).toEqual(DEFAULT_RETRY_POLICY)
    const second = post(handle.url, 'api/retry/settings', policy)
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2)); accept()
    expect((await second).status).toBe(200)
    expect((await state(handle.url)).retryPolicy).toEqual(policy)
  })

  it('keeps exhausted requests paused across reload, accepts one winner, and never duplicates task submission', async () => {
    let calls = 0
    const handle = await boot({ retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 1, delayMs: 0 }, adapter: {
      id: 'retry-api', defaultModel: 'retry-model', async *stream() { calls++; if (calls <= 2) yield { type: 'error', error: 'HTTP 503 temporary' }; else yield* text('confirmed recovery') },
    } })
    expect((await post(handle.url, 'api/message', { text: 'single user task' })).status).toBe(202)
    let request: State['pendingRequests'][number] | undefined
    await vi.waitFor(async () => { request = (await state(handle.url)).pendingRequests.find(row => row.type === 'retry/request'); expect(request).toBeDefined() })
    expect(calls).toBe(2)
    expect((await state(handle.url)).busy).toBe(true)
    expect((await state(handle.url)).pendingRequests).toEqual(expect.arrayContaining([expect.objectContaining({ id: request!.id })]))
    const responses = await Promise.all([post(handle.url, 'api/retries/' + request!.id, { allow: true }), post(handle.url, 'api/retries/' + request!.id, { allow: true })])
    expect(responses.map(response => response.status).sort()).toEqual([200, 404])
    await vi.waitFor(async () => expect((await state(handle.url)).busy).toBe(false))
    expect(calls).toBe(3)
    const session = await handle.harness.ctx.sessions.open(handle.harness.main().sessionId)
    expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect((await state(handle.url)).retries).toEqual([])
  })

  it('requires operator access for confirmation and retry settings; interrupt cancels pending retry', async () => {
    const operator = 'retry-operator-' + 'a'.repeat(40), viewer = 'retry-viewer-' + 'b'.repeat(40)
    const handle = await boot({ host: '0.0.0.0', token: operator, viewerToken: viewer,
      retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 0 }, adapter: new MockAdapter([[{ type: 'error', error: 'HTTP 503 temporary' }]]) })
    const operatorHeaders = { authorization: 'Bearer ' + operator }, viewerHeaders = { authorization: 'Bearer ' + viewer }
    expect((await post(handle.url, 'api/retry/settings', DEFAULT_RETRY_POLICY, viewerHeaders)).status).toBe(403)
    await post(handle.url, 'api/message', { text: 'pause' }, operatorHeaders)
    let id = ''
    await vi.waitFor(async () => { const snapshot = await (await fetch(handle.url + 'api/state', { headers: operatorHeaders })).json() as State; id = snapshot.pendingRequests.find(row => row.type === 'retry/request')?.id ?? ''; expect(id).not.toBe('') })
    expect((await post(handle.url, 'api/retries/' + id, { allow: true }, viewerHeaders)).status).toBe(403)
    expect((await post(handle.url, 'api/interrupt', {}, operatorHeaders)).status).toBe(200)
    expect((await post(handle.url, 'api/retries/' + id, { allow: true }, operatorHeaders)).status).toBe(404)
  })
})