/** App-scoped display persistence never changes workspace context or credentials. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type DesktopSettingsState, type WebServerOptions } from '../src/web/server.js'
import type { DesktopAppearance } from '../src/util/appearance.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

async function directory() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-appearance-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return cwd
}

async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = extra.cwd ?? await directory()
  const handle = await runWebServer({ cwd, open: false, quiet: true, updatesAutoCheck: false,
    adapter: new MockAdapter([text('ok')]), onPersistSettings() {}, ...extra })
  cleanups.push(() => handle.close())
  return { cwd, handle, base: handle.url }
}

const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const appearance = async (base: string) => await (await fetch(base + 'api/desktop/appearance')).json() as DesktopAppearance
const state = async (base: string) => await (await fetch(base + 'api/state')).json() as { desktop: DesktopSettingsState; revision: number }

describe('desktop quota display API', () => {
  it('defaults to always, persists all modes on their own hook and keeps credentials/context unchanged', async () => {
    const cwd = await directory(), budget = { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 }
    const saves = vi.fn(async (_settings: DesktopAppearance) => {}), otherSaves = vi.fn()
    const { base, handle } = await boot({ cwd, apiKey: 'SYNTHETIC_LEGACY_KEY', desktopRememberKey: true,
      workspacePrefs: { [cwd]: { sessionDir: 'custom-history', agents: [], contextBudget: budget } },
      onPersistAppearance: saves, onPersistSettings: otherSaves })
    expect(await appearance(base)).toEqual({ quotaDisplay: 'always' })
    const original = handle.harness, before = await state(base)
    for (const quotaDisplay of ['hover', 'settings', 'always'] as const) {
      expect((await post(base, 'api/desktop/appearance', { quotaDisplay })).status).toBe(200)
      expect(await appearance(base)).toEqual({ quotaDisplay })
      expect((await state(base)).desktop).toEqual({ ...before.desktop, appearance: { quotaDisplay } })
      expect(handle.harness).toBe(original)
    }
    expect(saves.mock.calls.map(([value]) => value)).toEqual([{ quotaDisplay: 'hover' }, { quotaDisplay: 'settings' }, { quotaDisplay: 'always' }])
    expect(otherSaves).not.toHaveBeenCalled()
    expect(JSON.stringify(await state(base))).not.toContain('SYNTHETIC_LEGACY_KEY')
    expect((await state(base)).revision).toBeGreaterThan(before.revision)
  })

  it('preserves remembered credentials on the compatibility persistence hook', async () => {
    const saved: DesktopSettingsState[] = []
    const { base, cwd } = await boot({ apiKey: 'SYNTHETIC_LEGACY_KEY', desktopRememberKey: true,
      onPersistSettings: value => { saved.push(value) } })
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' })).status).toBe(200)
    expect(saved.at(-1)).toMatchObject({ workspace: cwd, rememberKey: true, apiKey: 'SYNTHETIC_LEGACY_KEY', appearance: { quotaDisplay: 'hover' } })
    expect(await (await fetch(base + 'api/desktop/appearance')).text()).not.toContain('SYNTHETIC_LEGACY_KEY')
  })

  it('rejects malformed, invalid and mixed fields without invoking storage', async () => {
    const persist = vi.fn(async () => {}), { base } = await boot({ onPersistAppearance: persist })
    for (const body of [null, [], true, 'hover', {}, { quotaDisplay: null }, { quotaDisplay: '' }, { quotaDisplay: 'never' },
      { quotaDisplay: 1 }, { quotaDisplay: ['hover'] }, { quotaDisplay: 'hover', workspace: 'other' }, { quotaDisplay: 'hover', apiKey: 'PRIVATE' }]) {
      expect((await post(base, 'api/desktop/appearance', body)).status, JSON.stringify(body)).toBe(400)
      expect(await appearance(base)).toEqual({ quotaDisplay: 'always' })
    }
    expect((await fetch(base + 'api/desktop/appearance', { method: 'POST', body: '{' })).status).toBe(400)
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover', extra: 'a'.repeat(4096) })).status).toBe(413)
    expect(persist).not.toHaveBeenCalled()
  })

  it('waits for storage, rejects overlapping display saves and rolls back failures', async () => {
    let accept!: () => void, reject!: (error: Error) => void
    const persist = vi.fn(() => new Promise<void>((resolve, fail) => { accept = resolve; reject = fail }))
    const { base } = await boot({ onPersistAppearance: persist })
    const before = await state(base)
    const first = post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1))
    expect(await appearance(base)).toEqual({ quotaDisplay: 'always' })
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'settings' })).status).toBe(409)
    reject(new Error('storage denied PRIVATE_CREDENTIAL'))
    const failed = await first
    expect(failed.status).toBe(500)
    expect(await failed.text()).not.toContain('PRIVATE_CREDENTIAL')
    expect(await state(base)).toEqual(before)
    const retry = post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' })
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(2))
    accept()
    expect((await retry).status).toBe(200)
    expect(await appearance(base)).toEqual({ quotaDisplay: 'hover' })
  })

  it('carries the latest appearance through context/workspace saves and restarts on another port', async () => {
    const saved: DesktopSettingsState[] = [], other = await directory()
    const { base, cwd, handle } = await boot({ onPersistSettings: value => { saved.push(value) } })
    const budget = { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 }
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'settings' })).status).toBe(200)
    expect((await post(base, 'api/context/settings', budget)).status).toBe(200)
    expect(saved.at(-1)?.appearance).toEqual({ quotaDisplay: 'settings' })
    expect(saved.at(-1)?.workspacePrefs?.[cwd]?.contextBudget).toEqual(budget)
    expect((await post(base, 'api/desktop/settings', { workspace: other })).status).toBe(200)
    expect(await appearance(base)).toEqual({ quotaDisplay: 'settings' })
    expect((await post(base, 'api/desktop/settings', { workspace: cwd })).status).toBe(200)
    const prefs = saved.at(-1)!
    expect(prefs.appearance).toEqual({ quotaDisplay: 'settings' })
    await handle.close()
    const resumed = await boot({ cwd, workspacePrefs: prefs.workspacePrefs, appearance: prefs.appearance })
    expect(resumed.handle.port).not.toBe(handle.port)
    expect(await appearance(resumed.base)).toEqual({ quotaDisplay: 'settings' })
    expect((await state(resumed.base)).desktop.sessionDir).toBe(prefs.sessionDir)
  })

  it('allows display saves during an active turn without remounting or cancelling the model', async () => {
    const { base, handle } = await boot()
    let finish!: () => void, started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    handle.harness.ctx.llm.replaceAdapters({ id: 'paused', defaultModel: 'paused-model', async *stream() {
      started(); await new Promise<void>(resolve => { finish = resolve }); yield* text('finished')
    } })
    const running = handle.harness.run('active turn')
    try {
      await began
      expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' })).status).toBe(200)
      expect(await appearance(base)).toEqual({ quotaDisplay: 'hover' })
    } finally { finish(); await running }
  })
})

describe('desktop appearance access restrictions', () => {
  const operator = 'appearance-operator-' + 'a'.repeat(40), viewer = 'appearance-viewer-' + 'b'.repeat(40)

  it('never exposes desktop preferences to ordinary Web or remote operators/viewers', async () => {
    const ordinary = await boot({ onPersistSettings: undefined })
    expect((await fetch(ordinary.base + 'api/desktop/appearance')).status).toBe(404)
    expect((await post(ordinary.base, 'api/desktop/appearance', { quotaDisplay: 'hover' })).status).toBe(404)
    const persist = vi.fn(async () => {}), remote = await boot({ host: '0.0.0.0', token: operator, viewerToken: viewer, onPersistAppearance: persist })
    for (const token of [operator, viewer]) {
      const headers = { authorization: 'Bearer ' + token }
      expect((await fetch(remote.base + 'api/desktop/appearance', { headers })).status).toBe(404)
      expect((await post(remote.base, 'api/desktop/appearance', { quotaDisplay: 'hover' }, headers)).status).toBe(token === viewer ? 403 : 404)
      const snapshot = await (await fetch(remote.base + 'api/state', { headers })).json() as { desktop?: DesktopSettingsState }
      expect(snapshot.desktop).toBeUndefined()
    }
    expect(persist).not.toHaveBeenCalled()
  })

  it('requires a local operator and rejects cross-origin/expired browser saves', async () => {
    const persist = vi.fn(async () => {}), { base } = await boot({ token: operator, viewerToken: viewer,
      authSessionTtlMs: 1000, onPersistAppearance: persist })
    expect((await fetch(base + 'api/desktop/appearance')).status).toBe(401)
    expect((await fetch(base + 'api/desktop/appearance', { headers: { authorization: 'Bearer ' + viewer } })).status).toBe(404)
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' }, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' }, { authorization: 'Bearer ' + operator, origin: 'https://evil.test' })).status).toBe(403)
    const login = await post(base, 'api/auth/login', { token: operator })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(base + 'api/desktop/appearance', { headers: { cookie } })).status).toBe(200)
    await post(base, 'api/auth/logout', {}, { cookie })
    expect((await post(base, 'api/desktop/appearance', { quotaDisplay: 'hover' }, { cookie })).status).toBe(401)
    expect(persist).not.toHaveBeenCalled()
  })
})