/** Offline custom-source validation. No account credentials, downloads or external requests. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UPDATES_URL, MAX_UPDATE_DOWNLOAD_BYTES, parseUpdateFeedUrl, parseUpdateSettings, UpdateChecker } from '../src/updates.js'

const source = 'https://updates.example.test/sakuracode/latest.json'
const manifest = (patch: Record<string, unknown> = {}) => ({ schemaVersion: 1, project: 'SakuraCode', platform: 'windows-x64',
  version: '0.7.5', releaseUrl: 'https://updates.example.test/sakuracode/0.7.5/',
  downloadUrl: 'https://updates.example.test/sakuracode/0.7.5/SakuraCode%20Desktop.exe', sha256: 'a'.repeat(64), size: 98_000_000,
  notes: '<img src=x> 更新说明\n- 保留数据', publishedAt: '2026-10-27T05:00:00Z', ...patch })
const instances: UpdateChecker[] = []
afterEach(() => { instances.forEach(instance => instance.close()); instances.length = 0; vi.restoreAllMocks() })
function checker(fetcher: typeof fetch, url = source) {
  const instance = new UpdateChecker('0.7.4', url, { fetch: fetcher }); instances.push(instance); return instance
}
const reply = (body: unknown) => new Response(JSON.stringify(body))

describe('explicitly configured update sources', () => {
  it('accepts a same-origin stable manifest and never fetches or executes the offered binary', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => reply(manifest()))
    const result = await checker(fetcher).checkAndDetectChange()
    expect(result).toMatchObject({ isNew: true, info: { current: '0.7.4', latest: '0.7.5', hasUpdate: true, sourceUrl: source,
      sha256: 'a'.repeat(64), size: 98_000_000, notes: '<img src=x> 更新说明\n- 保留数据', publishedAt: '2026-10-27T05:00:00.000Z' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe(source)
    const init = fetcher.mock.calls[0]![1]!
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
    expect(Object.fromEntries(new Headers(init.headers).entries())).toEqual({ accept: 'application/json', 'user-agent': 'SakuraCode/0.7.4' })
    expect(init.body).toBeUndefined()
  })

  it('allows a release-page-only manifest without inventing a download or hash', async () => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(reply(manifest({ downloadUrl: undefined, sha256: undefined, size: undefined })))).check()
    expect(result.error).toBeUndefined(); expect(result.hasUpdate).toBe(true)
    expect(result.downloadUrl).toBeUndefined(); expect(result.sha256).toBeUndefined()
  })

  it('retains last valid same-origin metadata on a malformed later reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(manifest())).mockResolvedValueOnce(reply(manifest({ downloadUrl: 'https://evil.test/download.exe' })))
    const instance = checker(fetcher), first = await instance.check()
    expect(await instance.check()).toMatchObject({ latest: first.latest, downloadUrl: first.downloadUrl, sha256: first.sha256, error: expect.any(String) })
  })

  it.each([
    { schemaVersion: 2 }, { project: 'OtherProject' }, { platform: 'linux-x64' }, { version: '0.7.5-rc.1' }, { version: '0.7' },
    { draft: true }, { prerelease: true }, { releaseUrl: 'https://updates.example.test.evil.test/release' },
    { releaseUrl: 'javascript:alert(1)' }, { downloadUrl: 'https://evil.test/download.exe' }, { downloadUrl: 'http://updates.example.test/download.exe' },
    { downloadUrl: 'https://user:secret@updates.example.test/download.exe' }, { downloadUrl: 'https://updates.example.test/download.exe?token=secret' },
    { downloadUrl: 'https://updates.example.test/download.exe#fragment' }, { sha256: 'bad' }, { sha256: undefined },
    { downloadUrl: undefined }, { size: 0 }, { size: MAX_UPDATE_DOWNLOAD_BYTES + 1 }, { size: 1.5 },
    { notes: 'x'.repeat(16001) }, { notes: 'bad\0notes' }, { publishedAt: 'invalid' },
  ])('rejects unsafe or incomplete manifest fields %j', async patch => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(reply(manifest(patch)))).checkAndDetectChange()
    expect(result.info.error).toBeTruthy(); expect(result.info.hasUpdate).toBe(false); expect(result.isNew).toBe(false)
    expect(result.info.downloadUrl).toBeUndefined()
  })

  it('does not let the default GitHub source change its canonical release-link trust policy', async () => {
    const result = await checker(vi.fn<typeof fetch>().mockResolvedValue(reply(manifest())), DEFAULT_UPDATES_URL).check()
    expect(result.error).toContain('invalid SakuraCode manifest')
  })

  it.each(['', 'https://updates.example.test/latest.json', 'http://127.0.0.1:48321/latest.json', 'http://[::1]:48321/latest.json'])('accepts explicit feed %j', value => {
    expect(parseUpdateFeedUrl(value)).toBe(value)
    expect(parseUpdateSettings({ feedUrl: value, autoCheck: false })).toEqual({ feedUrl: value, autoCheck: false })
  })

  it.each([undefined, null, 1, 'not-a-url', 'javascript:alert(1)', 'file:///C:/private', 'http://example.test/latest.json',
    'https://user:secret@example.test/latest.json', 'https://example.test/latest.json?token=secret', 'https://example.test/latest.json#hash',
    'https://example.test\\latest.json', 'https://example.test/\nlatest.json'])('rejects invalid feed %j without any fetch', value => {
    expect(() => parseUpdateFeedUrl(value)).toThrow()
  })

  it('rejects unknown preference fields and wrong autoCheck types', () => {
    for (const value of [null, [], {}, { feedUrl: '', autoCheck: 'true' }, { feedUrl: '', autoCheck: true, token: 'secret' }]) {
      expect(() => parseUpdateSettings(value)).toThrow()
    }
  })
})