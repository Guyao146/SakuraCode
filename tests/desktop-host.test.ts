/** Regressions for the desktop launch pipe: settings parsing, the harness
 *  getter (it must follow workspace switches) and the persist callback that
 *  keeps DPAPI key storage on the launcher side. */
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from "vitest"
import { parseDesktopLaunch, runDesktopHost, startDesktopHost, type DesktopLaunch } from "../src/desktop/host.js"
import type { DesktopSettingsState } from "../src/web/server.js"
import type { DesktopAppearance } from '../src/util/appearance.js'
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from '../src/util/retry.js'
import { clientSaved } from './sakuraapi-client-fixture.js'
import type { UpdateSettings } from '../src/updates.js'
async function makeWorkspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }))
  return dir
}


function baseLaunch(cwd: string): DesktopLaunch {
  return { cwd, approvalMode: 'default' }
}

describe('desktop host', () => {
  it('waits for workspace disk acknowledgement and leaves the live workspace and prefs unchanged on failure', async () => {
    const workspace = await makeWorkspace('sakura-host-workspace-save-'), other = await makeWorkspace('sakura-host-workspace-other-')
    const input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; id?: string; url?: string; settings?: DesktopSettingsState }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk); let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const originalPrefs = { sessionDir: 'saved-sessions', agents: [] }
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify({ ...baseLaunch(workspace), newWorkspaceDir: workspace, workspacePrefs: { [workspace]: originalPrefs },
      updates: { feedUrl: '', autoCheck: false } }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const read = async () => await (await fetch(url + 'api/state')).json() as { cwd: string; desktop: DesktopSettingsState }
      const save = () => fetch(url + 'api/desktop/settings', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: other, sessionDir: 'candidate-sessions', newWorkspaceDir: other }) })
      let completed = false
      const first = save().then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'desktop/settings')).toHaveLength(1))
      const attempt = frames.find(frame => frame.type === 'desktop/settings')!
      expect(attempt.id).toEqual(expect.any(String))
      expect(attempt.settings).toMatchObject({ workspace: other, recentWorkspaces: [other, workspace], newWorkspaceDir: other,
        workspacePrefs: { [workspace]: originalPrefs, [other]: { sessionDir: 'candidate-sessions' } } })
      input.write(JSON.stringify({ type: 'desktop/context-settings/saved', id: attempt.id, ok: true }) + '\n')
      input.write(JSON.stringify({ type: 'desktop/settings/saved', id: 'wrong-id', ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completed).toBe(false)
      expect((await fetch(url + 'api/state')).status).toBe(409)
      input.write(JSON.stringify({ type: 'desktop/settings/saved', id: attempt.id, ok: false }) + '\n')
      expect((await first).status).toBe(500)
      expect(await read()).toMatchObject({ cwd: workspace, desktop: { workspace, recentWorkspaces: [workspace],
        newWorkspaceDir: workspace, sessionDir: originalPrefs.sessionDir } })
      const retry = save()
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'desktop/settings')).toHaveLength(2))
      const accepted = frames.filter(frame => frame.type === 'desktop/settings')[1]!
      input.write(JSON.stringify({ type: 'desktop/settings/saved', id: accepted.id, ok: true }) + '\n')
      expect((await retry).status).toBe(200)
      expect(await read()).toMatchObject({ cwd: other, desktop: { workspace: other, recentWorkspaces: [other, workspace],
        sessionDir: 'candidate-sessions', newWorkspaceDir: other } })
    } finally {
      input.end('shutdown\n'); await host; output.destroy()
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('accepts only increasing numerical viewport evidence on the private pipe and forwards reflow without exposing settings', async () => {
    const workspace = await makeWorkspace('sakura-host-viewport-'), input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; url?: string; action?: string }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk); let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify({ ...baseLaunch(workspace), updates: { feedUrl: '', autoCheck: false } }) + '\n')
    const viewport = { width: 1090, height: 810, dpi: 120, version: 1 }
    input.write(JSON.stringify({ type: 'desktop/viewport', viewport }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const state = async () => await (await fetch(url + 'api/state')).json() as { desktopViewport: unknown }
      expect((await state()).desktopViewport).toEqual(viewport)
      input.write(JSON.stringify({ type: 'desktop/viewport', viewport: { ...viewport, width: 9999, version: 1 } }) + '\n')
      input.write(JSON.stringify({ type: 'desktop/viewport', viewport: { ...viewport, width: -1, version: 2 } }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect((await state()).desktopViewport).toEqual(viewport)
      input.write(JSON.stringify({ type: 'desktop/viewport', viewport: { ...viewport, width: 1300, version: 3 } }) + '\n')
      await vi.waitFor(async () => expect((await state()).desktopViewport).toEqual({ ...viewport, width: 1300, version: 3 }))
      expect((await fetch(url + 'api/desktop/window', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reflow' }) })).status).toBe(200)
      expect(frames.find(frame => frame.type === 'desktop/window')).toMatchObject({ action: 'reflow' })
    } finally { input.end('shutdown\n'); await host; output.destroy(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
  })

  it('validates update sources and commits only its matching native persistence acknowledgement', async () => {
    const workspace = await makeWorkspace('sakura-host-updates-'), input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; id?: string; url?: string; settings?: UpdateSettings }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const initial = { feedUrl: '', autoCheck: false }, candidate = { feedUrl: 'https://updates.example.test/latest.json', autoCheck: false }
    expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), updates: { ...candidate, feedUrl: 'http://external.test/latest.json' } })).toThrow()
    const host = runDesktopHost(input, output); input.write(JSON.stringify({ ...baseLaunch(workspace), updates: initial }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const save = () => fetch(url + 'api/updates/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(candidate) })
      let completed = false
      const first = save().then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/updates')).toBe(true))
      const frame = frames.find(frame => frame.type === 'desktop/updates')!
      expect(frame.settings).toEqual(candidate)
      input.write(JSON.stringify({ type: 'desktop/retry/saved', id: frame.id, ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30)); expect(completed).toBe(false)
      input.write(JSON.stringify({ type: 'desktop/updates/saved', id: frame.id, ok: false }) + '\n')
      expect((await first).status).toBe(500)
      expect(await (await fetch(url + 'api/updates/settings')).json()).toEqual(initial)
      const second = save()
      await vi.waitFor(() => expect(frames.filter(row => row.type === 'desktop/updates')).toHaveLength(2))
      input.write(JSON.stringify({ type: 'desktop/updates/saved', id: frames.filter(row => row.type === 'desktop/updates')[1]!.id, ok: true }) + '\n')
      expect((await second).status).toBe(200)
      expect(await (await fetch(url + 'api/updates/settings')).json()).toEqual(candidate)
    } finally { input.end('shutdown\n'); await host; output.destroy(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) }
  })

  it('validates the retry policy and requires its matching save acknowledgement with failure rollback', async () => {
    const workspace = await makeWorkspace('sakura-host-retry-'), input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; id?: string; url?: string; settings?: RetryPolicy }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), retry: { ...DEFAULT_RETRY_POLICY, maxRetries: 30 } })).toThrow()
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify({ ...baseLaunch(workspace), retry: DEFAULT_RETRY_POLICY }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const policy = { ...DEFAULT_RETRY_POLICY, maxRetries: 2, delayMs: 0 }
      const save = () => fetch(url + 'api/retry/settings', { method: 'POST', body: JSON.stringify(policy) })
      let completed = false
      const first = save().then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/retry')).toBe(true))
      const frame = frames.find(frame => frame.type === 'desktop/retry')!
      expect(frame.settings).toEqual(policy)
      input.write(JSON.stringify({ type: 'desktop/appearance/saved', id: frame.id, ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30)); expect(completed).toBe(false)
      input.write(JSON.stringify({ type: 'desktop/retry/saved', id: frame.id, ok: false }) + '\n')
      expect((await first).status).toBe(500)
      expect(await (await fetch(url + 'api/retry/settings')).json()).toEqual(DEFAULT_RETRY_POLICY)
      const second = save()
      await vi.waitFor(() => expect(frames.filter(row => row.type === 'desktop/retry')).toHaveLength(2))
      input.write(JSON.stringify({ type: 'desktop/retry/saved', id: frames.filter(row => row.type === 'desktop/retry')[1]!.id, ok: true }) + '\n')
      expect((await second).status).toBe(200)
      expect(await (await fetch(url + 'api/retry/settings')).json()).toEqual(policy)
    } finally {
      input.end('shutdown\n'); await host; output.destroy()
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('parses recent workspaces and the remember flag', async () => {
    const workspace = await makeWorkspace('sakura-host-parse-')
    try {
      const launch = await parseDesktopLaunch({
        ...baseLaunch(workspace),
        recentWorkspaces: [path.join(workspace, 'a'), path.join(workspace, 'b')],
        rememberKey: true,
      })
      expect(launch.recentWorkspaces).toEqual([path.resolve(workspace, 'a'), path.resolve(workspace, 'b')])
      expect(launch.rememberKey).toBe(true)
      const budget = { contextWindowTokens: 128000, thresholdPercent: 75, autoThreshold: 0 }
      expect(parseDesktopLaunch({ ...baseLaunch(workspace), workspacePrefs: { [workspace]: { contextBudget: budget } } }).workspacePrefs?.[workspace]?.contextBudget).toEqual(budget)
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), workspacePrefs: { [workspace]: { contextBudget: { ...budget, thresholdPercent: -1 } } } })).toThrow()
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), recentWorkspaces: ['relative/path'] })).toThrow()
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), recentWorkspaces: [path.join(workspace, 'x') + '\0'] })).toThrow()
      expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), rememberKey: 'yes' as unknown as boolean })).toThrow()
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('exposes a live harness through workspace switches and forwards persisted settings', async () => {
    const workspace = await makeWorkspace('sakura-host-persist-')
    const other = await makeWorkspace('sakura-host-persist-other-')
    const persisted: DesktopSettingsState[] = []
    try {
      const handle = await startDesktopHost({ ...baseLaunch(workspace), recentWorkspaces: [] }, (settings) => persisted.push(settings))
      try {
        const post = (body: unknown) => fetch(handle.url + 'api/desktop/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const initial = handle.harness
        expect(initial).toBeDefined()

        // The product now owns the upstream: manual credentials cannot ride
        // the settings pipe, and existing user files are not imported.
        expect((await post({ apiKey: 'host-secret', rememberKey: true })).status).toBe(400)
        expect((await post({ rememberKey: false })).status).toBe(400)
        expect(persisted).toEqual([])

        await (await post({ workspace: other })).json()
        expect(handle.harness).not.toBe(initial)
        expect(persisted.at(-1)?.workspace).toBe(other)
        // The recent list starts with the current workspace.
        expect(persisted.at(-1)?.recentWorkspaces).toEqual([other, workspace])
      } finally {
        await handle.close()
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('parses account credentials only on the private pipe and requires the matching secure-storage acknowledgement', async () => {
    const workspace = await makeWorkspace('sakura-host-account-')
    const credentials = { apiKey: 'sk-PIPE_ACCOUNT_KEY', keyName: 'Pipe authorization' }
    expect(parseDesktopLaunch({ ...baseLaunch(workspace), sakuraApi: credentials }).sakuraApi).toEqual(credentials)
    const clientCredentials = clientSaved(true)
    expect(parseDesktopLaunch({ ...baseLaunch(workspace), sakuraApi: clientCredentials }).sakuraApi).toEqual(clientCredentials)
    expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), sakuraApi: { ...clientCredentials, client: { ...clientCredentials.client, scope:'admin' } } })).toThrow()
    expect(() => parseDesktopLaunch({ ...baseLaunch(workspace), sakuraApi: { accessToken: 'bad token' } })).toThrow()
    const input = new PassThrough(), output = new PassThrough()
    const frames: Array<Record<string, any>> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        frames.push(JSON.parse(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
    })
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify({ ...baseLaunch(workspace), sakuraApi: credentials }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url
      expect(await (await fetch(url + 'api/state')).text()).not.toContain('PIPE_ACCOUNT')
      expect(((await (await fetch(url + 'api/account/sakura')).json()) as { phase: string }).phase).toBe('saved')
      let completed = false
      const logout = fetch(url + 'api/account/sakura/logout', { method: 'POST', body: '{}' }).then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/sakuraapi')).toBe(true))
      const request = frames.find(frame => frame.type === 'desktop/sakuraapi')!
      expect(request.settings).toBeNull()
      input.write(JSON.stringify({ type: 'desktop/weixin/saved', id: request.id, ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completed).toBe(false)
      input.write(JSON.stringify({ type: 'desktop/sakuraapi/saved', id: request.id, ok: false }) + '\n')
      expect((await logout).status).toBe(502)
      expect(((await (await fetch(url + 'api/account/sakura')).json()) as { phase: string }).phase).toBe('saved')
    } finally {
      input.end('shutdown\n')
      await host
      output.destroy()
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('acknowledges appearance only on its own pipe, rolls back failures and preserves it during workspace changes', async () => {
    const workspace = await makeWorkspace('sakura-host-appearance-'), other = await makeWorkspace('sakura-host-appearance-other-')
    const input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; id?: string; url?: string; settings?: DesktopAppearance & Partial<DesktopSettingsState> }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify({ ...baseLaunch(workspace), appearance: { quotaDisplay: 'settings' } }) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const read = async () => await (await fetch(url + 'api/desktop/appearance')).json()
      const save = () => fetch(url + 'api/desktop/appearance', { method: 'POST', body: JSON.stringify({ quotaDisplay: 'hover' }) })
      expect(await read()).toEqual({ quotaDisplay: 'settings' })
      let completed = false
      const attempt = save().then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/appearance')).toBe(true))
      const frame = frames.find(frame => frame.type === 'desktop/appearance')!
      expect(frame.settings).toEqual({ quotaDisplay: 'hover' })
      input.write(JSON.stringify({ type: 'desktop/context-settings/saved', id: frame.id, ok: true }) + '\n')
      input.write(JSON.stringify({ type: 'desktop/appearance/saved', id: 'wrong-id', ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completed).toBe(false)
      expect(await read()).toEqual({ quotaDisplay: 'settings' })
      input.write(JSON.stringify({ type: 'desktop/appearance/saved', id: frame.id, ok: false }) + '\n')
      expect((await attempt).status).toBe(500)
      expect(await read()).toEqual({ quotaDisplay: 'settings' })
      const retry = save()
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'desktop/appearance')).toHaveLength(2))
      const second = frames.filter(frame => frame.type === 'desktop/appearance')[1]!
      input.write(JSON.stringify({ type: 'desktop/appearance/saved', id: second.id, ok: true }) + '\n')
      expect((await retry).status).toBe(200)
      expect(await read()).toEqual({ quotaDisplay: 'hover' })
      const workspaceSave = fetch(url + 'api/desktop/settings', { method: 'POST', body: JSON.stringify({ workspace: other }) })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/settings')).toBe(true))
      const workspaceFrame = frames.find(frame => frame.type === 'desktop/settings')!
      expect(workspaceFrame.settings?.appearance).toEqual({ quotaDisplay: 'hover' })
      input.write(JSON.stringify({ type: 'desktop/settings/saved', id: workspaceFrame.id, ok: true }) + '\n')
      expect((await workspaceSave).status).toBe(200)
      expect(await read()).toEqual({ quotaDisplay: 'hover' })
    } finally {
      input.end('shutdown\n'); await host; output.destroy()
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
      await fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })

  it('acknowledges context threshold persistence on its own pipe and keeps old thresholds after a failed save', async () => {
    const workspace = await makeWorkspace('sakura-host-context-'), input = new PassThrough(), output = new PassThrough()
    const frames: Array<{ type: string; id?: string; url?: string; settings?: DesktopSettingsState }> = []
    let buffer = ''
    output.on('data', chunk => {
      buffer += String(chunk)
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, newline))); buffer = buffer.slice(newline + 1) }
    })
    const host = runDesktopHost(input, output)
    input.write(JSON.stringify(baseLaunch(workspace)) + '\n')
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/ready')).toBe(true))
      const url = frames.find(frame => frame.type === 'desktop/ready')!.url!
      const budget = { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 }
      const save = () => fetch(url + 'api/context/settings', { method: 'POST', body: JSON.stringify(budget) })
      let completed = false
      const first = save().then(response => { completed = true; return response })
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'desktop/context-settings')).toBe(true))
      const attempt = frames.find(frame => frame.type === 'desktop/context-settings')!
      expect(attempt.settings?.workspacePrefs?.[workspace]?.contextBudget).toEqual(budget)
      input.write(JSON.stringify({ type: 'desktop/settings/saved', id: attempt.id, ok: true }) + '\n')
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(completed).toBe(false)
      input.write(JSON.stringify({ type: 'desktop/context-settings/saved', id: attempt.id, ok: false }) + '\n')
      expect((await first).status).toBe(500)
      const afterFailure = await (await fetch(url + 'api/state')).json() as { contextBudget: { autoTokensThreshold: number } }
      expect(afterFailure.contextBudget.autoTokensThreshold).toBe(48000)
      const second = save()
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'desktop/context-settings')).toHaveLength(2))
      const retry = frames.filter(frame => frame.type === 'desktop/context-settings')[1]!
      input.write(JSON.stringify({ type: 'desktop/context-settings/saved', id: retry.id, ok: true }) + '\n')
      expect((await second).status).toBe(200)
      const saved = await (await fetch(url + 'api/state')).json() as { contextBudget: { autoTokensThreshold: number } }
      expect(saved.contextBudget.autoTokensThreshold).toBe(89600)
    } finally {
      input.end('shutdown\n'); await host; output.destroy()
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    }
  })
})
