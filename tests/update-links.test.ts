/** Native update links never accept arbitrary destinations or invoke a real OS browser in tests. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { DEFAULT_UPDATES_PAGE_URL, DEFAULT_UPDATES_URL, type UpdateInfo } from '../src/updates.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
const source = 'https://updates.example.test/sakuracode/latest.json'
const releaseUrl = 'https://updates.example.test/sakuracode/99.0.0/'
const downloadUrl = releaseUrl + 'SakuraCode%20Desktop.exe'
const officialUrl = DEFAULT_UPDATES_PAGE_URL
const githubReleaseUrl = 'https://github.com/Guyao146/SakuraCode/releases/tag/v99.0.0'
const manifest = { schemaVersion: 1, project: 'SakuraCode', platform: 'windows-x64', version: '99.0.0',
  releaseUrl, downloadUrl, sha256: 'a'.repeat(64), size: 98765432 }
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-update-links-'))
  const opener = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ tag_name: 'v99.0.0', html_url: 'https://evil.test/' })))
  const persist = vi.fn()
  const server = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), quiet: true, open: false, token: null,
    viewerToken: null, onPersistSettings: persist, updatesAutoCheck: false, updatesFetch: fetcher, updatesOpenUrl: opener, ...extra })
  cleanups.push(async () => { await server.close(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
  return { server, opener, fetcher, persist }
}
const post = (server: WebServerHandle, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(server.url + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const open = (server: WebServerHandle, target: string, url: string, headers: Record<string, string> = {}) => post(server, 'api/updates/open', { target, url }, headers)
const snapshot = async (server: WebServerHandle) => await (await fetch(server.url + 'api/state')).json() as { update?: UpdateInfo; updatePageUrl?: string; workspaceId: string; sessionId: string | null }

describe('local desktop update-link dispatch', () => {
  it('opens the fixed official download site before a check without fetching, installing, saving or changing the workspace', async () => {
    const { server, opener, fetcher, persist } = await boot()
    expect(officialUrl).toBe('https://download.sakuraapi.top/')
    expect((await snapshot(server)).updatePageUrl).toBe(officialUrl)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect(fetcher).not.toHaveBeenCalled()
    expect((await post(server, 'api/updates/check', {})).status).toBe(200)
    const before = await snapshot(server)
    expect((await open(server, 'release', 'https://evil.test/')).status).toBe(409)
    expect((await open(server, 'release', githubReleaseUrl)).status).toBe(409)
    expect((await open(server, 'download', officialUrl)).status).toBe(409)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect(opener.mock.calls).toEqual([[officialUrl], [officialUrl]])
    expect(fetcher).toHaveBeenCalledOnce(); expect(persist).not.toHaveBeenCalled()
    expect(await snapshot(server)).toEqual(before)
  })

  it('dispatches same-source release and integrity-checked download URLs without forwarding request data', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(manifest)))
    const { server, opener, persist } = await boot({ updates: { feedUrl: source, autoCheck: false }, updatesFetch: fetcher })
    await post(server, 'api/updates/check', {})
    const before = await snapshot(server)
    expect(await (await open(server, 'release', releaseUrl)).json()).toEqual({ opened: true })
    expect(await (await open(server, 'download', downloadUrl)).json()).toEqual({ opened: true })
    expect(opener.mock.calls).toEqual([[releaseUrl], [downloadUrl]])
    expect(fetcher).toHaveBeenCalledOnce(); expect(persist).not.toHaveBeenCalled()
    expect(await snapshot(server)).toEqual(before)
  })

  it('rejects extra fields, unsupported selectors and dangerous destinations before invoking an OS command', async () => {
    const { server, opener } = await boot()
    await post(server, 'api/updates/check', {})
    for (const body of [{}, { target: 'release' }, { target: 'release', url: 42 },
      { target: 'other', url: officialUrl }, { target: ['release'], url: officialUrl },
      { target: 'release', url: officialUrl, command: 'powershell.exe' }]) {
      expect((await post(server, 'api/updates/open', body)).status).toBe(400)
    }
    for (const url of ['javascript:alert(1)', 'file:///C:/Windows/notepad.exe', 'https://user:secret@github.com/',
      officialUrl + '?token=secret', officialUrl + '#fragment', 'https://download.sakuraapi.top.evil.test/',
      officialUrl + '\n', '\\\\server\\share\\program.exe']) {
      expect((await open(server, 'release', url)).status).toBe(409)
    }
    expect(opener).not.toHaveBeenCalled()
  })

  it('reports browser errors without leaking their contents and accepts only an explicit retry', async () => {
    const { server, opener } = await boot()
    opener.mockRejectedValueOnce(new Error('synthetic native failure with PRIVATE_SECRET'))
    await post(server, 'api/updates/check', {})
    const before = await snapshot(server)
    const failed = await open(server, 'release', officialUrl)
    expect(failed.status).toBe(502)
    const error = await failed.text()
    expect(error).toContain('系统默认浏览器'); expect(error).toContain('复制地址'); expect(error).not.toContain('PRIVATE_SECRET')
    expect(opener).toHaveBeenCalledOnce(); expect(await snapshot(server)).toEqual(before)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect(opener).toHaveBeenCalledTimes(2)
  })

  it('prevents concurrent browser launches and releases the gate after acknowledgement', async () => {
    const { server, opener } = await boot()
    let release!: () => void
    opener.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    await post(server, 'api/updates/check', {})
    const opening = open(server, 'release', officialUrl)
    await vi.waitFor(() => expect(opener).toHaveBeenCalledOnce())
    expect((await open(server, 'release', officialUrl)).status).toBe(409)
    release(); expect((await opening).status).toBe(200)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect(opener).toHaveBeenCalledTimes(2)
  })

  it('retains checked links after a failed check but invalidates them when the update source changes', async () => {
    const { server, opener, fetcher } = await boot()
    await post(server, 'api/updates/check', {})
    fetcher.mockRejectedValueOnce(new Error('offline fixture'))
    await post(server, 'api/updates/check', {})
    expect((await snapshot(server)).update?.error).toContain('offline fixture')
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect((await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })).status).toBe(200)
    expect((await open(server, 'release', officialUrl)).status).toBe(409)
    expect(opener.mock.calls).toEqual([[officialUrl]])
  })

  it('keeps the default page available when current, but never invents a direct download without integrity metadata', async () => {
    const { server, opener, fetcher } = await boot()
    fetcher.mockImplementationOnce(async () => new Response('{"tag_name":"v1.0.0"}'))
    await post(server, 'api/updates/check', {})
    expect((await open(server, 'release', 'https://github.com/Guyao146/SakuraCode/releases/tag/v1.0.0')).status).toBe(409)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    await post(server, 'api/updates/settings', { feedUrl: source, autoCheck: false })
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ ...manifest, downloadUrl: undefined, sha256: undefined, size: undefined })))
    await post(server, 'api/updates/check', {})
    expect((await open(server, 'download', downloadUrl)).status).toBe(409)
    expect(opener.mock.calls).toEqual([[officialUrl]])
  })

  it('uses the official page for an explicitly saved GitHub feed and refuses a JSON-source substitution', async () => {
    const { server, opener } = await boot({ updates: { feedUrl: DEFAULT_UPDATES_URL, autoCheck: false } })
    expect((await snapshot(server)).updatePageUrl).toBe(officialUrl)
    expect((await open(server, 'release', officialUrl)).status).toBe(200)
    expect((await open(server, 'release', DEFAULT_UPDATES_URL)).status).toBe(409)
    expect(opener.mock.calls).toEqual([[officialUrl]])
  })

  it('keeps the configured custom source and only opens its checked canonical GitHub fallback', async () => {
    const { server, opener } = await boot({ updates: { feedUrl: source, autoCheck: false } })
    expect((await snapshot(server)).updatePageUrl).toBeUndefined()
    expect((await open(server, 'release', officialUrl)).status).toBe(409)
    await post(server, 'api/updates/check', {})
    expect((await open(server, 'release', githubReleaseUrl)).status).toBe(200)
    expect(opener.mock.calls).toEqual([[githubReleaseUrl]])
  })

  it('requires a local desktop operator and rejects unauthenticated, viewer, cross-site and ordinary Web calls', async () => {
    const operator = 'operator'.repeat(8), viewer = 'viewer'.repeat(8)
    const { server, opener } = await boot({ token: operator, viewerToken: viewer })
    const auth = { authorization: 'Bearer ' + operator }
    await post(server, 'api/updates/check', {}, auth)
    expect((await open(server, 'release', officialUrl)).status).toBe(401)
    expect((await open(server, 'release', officialUrl, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    expect((await open(server, 'release', officialUrl, { ...auth, origin: 'https://evil.test' })).status).toBe(403)
    expect((await open(server, 'release', officialUrl, { ...auth, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect(opener).not.toHaveBeenCalled()
    expect((await open(server, 'release', officialUrl, auth)).status).toBe(200)
    const web = await boot({ onPersistSettings: undefined })
    await post(web.server, 'api/updates/check', {})
    expect((await open(web.server, 'release', officialUrl)).status).toBe(404)
    expect(web.opener).not.toHaveBeenCalled()
    const remote = await boot({ host: '0.0.0.0', token: operator })
    await post(remote.server, 'api/updates/check', {}, auth)
    expect((await open(remote.server, 'release', officialUrl, auth)).status).toBe(404)
    expect(remote.opener).not.toHaveBeenCalled()
  })
})