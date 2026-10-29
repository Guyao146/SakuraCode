/** Remote transport security; uses only Node HTTP and the existing mock Harness. */
import { promises as fs } from 'node:fs'
import { request } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebAccess } from '../src/web/access.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const OPERATOR = 'operator-test-' + 'a'.repeat(40)
const VIEWER = 'viewer-test-' + 'b'.repeat(40)
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllEnvs()
  while (cleanups.length) await cleanups.pop()?.()
})

async function boot(extra: WebServerOptions = {}): Promise<{ handle: WebServerHandle; base: string }> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-remote-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('remote answer')]), open: false,
    quiet: true, host: '0.0.0.0', token: OPERATOR, viewerToken: VIEWER, ...extra })
  cleanups.push(() => handle.close())
  return { handle, base: `http://127.0.0.1:${handle.port}` }
}

const bearer = (token = OPERATOR) => ({ authorization: `Bearer ${token}` })
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

/** Native fetch normalizes Host. Exercise proxy/DNS-rebinding headers on the actual wire. */
function rawRequest(url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; cookie: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: body === undefined ? 'GET' : 'POST', headers }, (res) => {
      res.resume()
      res.on('end', () => resolve({ status: res.statusCode ?? 0, cookie: (res.headers['set-cookie'] ?? []).join(';') }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function login(base: string, token = OPERATOR): Promise<string> {
  const response = await post(base, '/api/auth/login', { token })
  expect(response.status).toBe(200)
  const header = response.headers.get('set-cookie')!
  expect(header).toContain('HttpOnly')
  expect(header).toContain('SameSite=Strict')
  expect(header).not.toContain(token)
  return header.split(';')[0]!
}

describe('remote Web — access policy', () => {
  it('fails closed before mounting a Harness for unsafe listeners or invalid options', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'workstation']) {
      expect(() => new WebAccess({ host })).toThrow(/requires SAKURA_WEB_TOKEN/)
    }
    expect(() => new WebAccess({ host: '127.0.0.1', token: 'short' })).toThrow(/32-256/)
    expect(() => new WebAccess({ host: '127.0.0.1', token: OPERATOR, viewerToken: OPERATOR })).toThrow(/different/)
    expect(() => new WebAccess({ host: 'http://localhost', token: OPERATOR })).toThrow(/hostname/)
    for (const publicOrigin of ['http://remote.test', 'https://remote.test/path', 'https://user:pass@remote.test', 'https://remote.test?token=x']) {
      expect(() => new WebAccess({ host: '127.0.0.1', token: OPERATOR, publicOrigin })).toThrow(/HTTPS origin/)
    }
    expect(new WebAccess({ host: '[::1]' }).required).toBe(false)
  })

  it('serves only a public login shell, protecting every data, stream and write endpoint', async () => {
    const { base } = await boot()
    const page = await fetch(base + '/dashboard')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('authDialog')
    expect(page.headers.get('content-security-policy')).toContain("script-src 'sha256-")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    for (const route of ['/api/state', '/api/events', '/api/commands', '/api/mcp', '/api/sessions/example/records', '/api/sessions/example/export']) {
      const response = await fetch(base + route)
      expect(response.status, route).toBe(401)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
    expect((await post(base, '/api/message', { text: 'must not run' })).status).toBe(401)
    expect((await fetch(base + '/api/state?token=' + OPERATOR)).status).toBe(401)
    expect(await (await fetch(base + '/api/auth')).json()).toMatchObject({ required: true, authenticated: false, role: null, remote: true })
  })

  it('logs in with an opaque cookie, supports bearer API clients and never serializes secrets', async () => {
    const { base } = await boot()
    expect((await post(base, '/api/auth/login', { token: 'not valid' })).status).toBe(401)
    const cookie = await login(base)
    const auth = await (await fetch(base + '/api/auth', { headers: { cookie } })).json()
    expect(auth).toMatchObject({ authenticated: true, role: 'operator' })
    for (const headers of [{ cookie }, bearer()]) {
      const state = await fetch(base + '/api/state', { headers })
      expect(state.status).toBe(200)
      const body = await state.text()
      expect(body).not.toContain(OPERATOR)
      expect(body).not.toContain(VIEWER)
      expect(body).toContain('core-agent')
    }
    expect((await fetch(base + '/api/state', { headers: { cookie, ...bearer('invalid') } })).status).toBe(401)
    expect((await post(base, '/api/settings', { approvalMode: 'plan' }, bearer())).status).toBe(200)
  })

  it('permits viewer reads and SSE but rejects all workspace mutations on the server', async () => {
    const { handle, base } = await boot()
    await handle.harness.run('existing history')
    const cookie = await login(base, VIEWER)
    expect(await (await fetch(base + '/api/auth', { headers: { cookie } })).json()).toMatchObject({ role: 'viewer' })
    const sid = handle.harness.main().sessionId
    for (const route of ['/api/state', '/api/collaboration', '/api/commands', '/api/mcp', `/api/sessions/${sid}/records`, `/api/sessions/${sid}/export`]) {
      expect((await fetch(base + route, { headers: { cookie } })).status, route).toBe(200)
    }
    const stream = await fetch(base + '/api/events', { headers: { cookie }, signal: AbortSignal.timeout(5000) })
    expect(stream.status).toBe(200)
    expect(stream.headers.get('x-accel-buffering')).toBe('no')
    await stream.body?.cancel()
    for (const route of ['/api/message', '/api/interrupt', '/api/settings', '/api/sessions', '/api/sessions/batch-delete', '/api/account/sakura/login', '/api/account/sakura/poll', '/api/account/sakura/retry', '/api/account/sakura/page', '/api/account/sakura/logout', '/api/agents', '/api/agents/a/message', '/api/agents/a/interrupt', '/api/approvals/a', '/api/questions/a', '/api/plans/a', '/api/mcp/a/reconnect']) {
      expect((await post(base, route, {}, { cookie })).status, route).toBe(403)
      expect((await post(base, route, {}, bearer(VIEWER))).status, route + ' bearer').toBe(403)
    }
    for (const headers of [{ cookie }, bearer(VIEWER)]) {
      expect((await fetch(base + `/api/sessions/${sid}`, { method: 'DELETE', headers })).status).toBe(403)
      expect((await fetch(base + `/api/sessions/${sid}`, { method: 'PATCH', headers, body: JSON.stringify({ title: 'not allowed' }) })).status).toBe(403)
    }
    expect(handle.harness.main().sessionId).toBe(sid)
    expect((await fetch(base + `/api/sessions/${sid}`, { method: 'DELETE' })).status).toBe(401)
    expect((await fetch(base + `/api/sessions/${sid}`, { method: 'DELETE', headers: bearer() })).status).toBe(200)
    expect((await fetch(base + `/api/sessions/${sid}/records`, { headers: { cookie } })).status).toBe(404)
  })

  it('revokes a logged-out cookie and its already-open SSE stream', async () => {
    const { base } = await boot()
    const cookie = await login(base)
    const controller = new AbortController()
    const stream = await fetch(base + '/api/events', { headers: { cookie }, signal: controller.signal })
    const reader = stream.body!.getReader()
    await reader.read()
    const ended = (async () => {
      try { while (!(await reader.read()).done) { /* drain */ } } catch { /* revoked socket */ }
    })()
    const response = await post(base, '/api/auth/logout', {}, { cookie })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await fetch(base + '/api/state', { headers: { cookie } })).status).toBe(401)
    try {
      await Promise.race([ended, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream was not revoked')), 1500).unref())])
    } finally { controller.abort() }
  })

  it('expires browser sessions without expiring the configured operator token', async () => {
    const { base } = await boot({ authSessionTtlMs: 50 })
    const cookie = await login(base)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await fetch(base + '/api/state', { headers: { cookie } })).status).toBe(401)
    expect((await fetch(base + '/api/state', { headers: bearer() })).status).toBe(200)
  })

  it('rejects cross-site requests, invalid schemes and spoofed local hosts', async () => {
    const { base } = await boot()
    for (const origin of ['https://' + new URL(base).host, 'http://evil.test', 'null', base + '/path']) {
      expect((await post(base, '/api/auth/login', { token: OPERATOR }, { origin })).status, origin).toBe(403)
    }
    expect((await post(base, '/api/auth/login', { token: OPERATOR }, { origin: base, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post(base, '/api/auth/login', { token: OPERATOR }, { origin: base })).status).toBe(200)
    const local = await boot({ host: '127.0.0.1', token: undefined, viewerToken: undefined })
    expect((await rawRequest(local.base + '/api/state', { host: 'evil.test:' + local.handle.port })).status).toBe(403)
    expect((await fetch(local.base + '/api/state')).status).toBe(200)
  })

  it('accepts an explicitly configured HTTPS proxy origin and does not trust forwarding headers', async () => {
    const { base } = await boot({ host: '127.0.0.1', publicOrigin: 'https://dashboard.example:8443' })
    const headers = { host: 'dashboard.example:8443', origin: 'https://dashboard.example:8443' }
    const response = await rawRequest(base + '/api/auth/login', headers, { token: OPERATOR })
    expect(response.status).toBe(200)
    expect(response.cookie).toContain('; Secure')
    expect((await rawRequest(base + '/api/state', { ...headers, ...bearer() })).status).toBe(200)
    expect((await fetch(base + '/api/state', { headers: { ...bearer(), 'x-forwarded-host': 'dashboard.example:8443', 'x-forwarded-proto': 'https' } })).status).toBe(403)
    expect((await post(base, '/api/settings', {}, { ...headers, ...bearer(), origin: 'https://evil.test' })).status).toBe(403)
  })

  it('caps login attempts including malformed bodies and returns actionable client errors', async () => {
    const { base } = await boot()
    for (const raw of ['{', 'null', '[]', '"string"']) {
      const response = await fetch(base + '/api/auth/login', { method: 'POST', body: raw })
      expect(response.status).toBe(400)
    }
    for (let i = 0; i < 6; i++) expect((await post(base, '/api/auth/login', { token: 'wrong' })).status).toBe(401)
    const limited = await post(base, '/api/auth/login', { token: OPERATOR })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('60')
    expect((await fetch(base + '/api/state', { headers: bearer() })).status).toBe(200)
  })

  it('reads token environment names from configuration and lets explicit options override it', async () => {
    vi.stubEnv('SAKURA_TEST_OPERATOR', OPERATOR)
    vi.stubEnv('SAKURA_TEST_VIEWER', VIEWER)
    const { base } = await boot({ host: undefined, token: undefined, viewerToken: undefined, config: {
      web: { host: '0.0.0.0', port: 0, tokenEnv: 'SAKURA_TEST_OPERATOR', viewerTokenEnv: 'SAKURA_TEST_VIEWER' },
    } })
    expect((await fetch(base + '/api/state')).status).toBe(401)
    expect((await fetch(base + '/api/state', { headers: bearer(VIEWER) })).status).toBe(200)
  })
})