import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '../src/core/session.js'
import { runWebServer } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.() })

async function boot(desktop = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-collaboration-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const other = path.join(cwd, 'other')
  await fs.mkdir(other)
  await fs.writeFile(path.join(other, 'sakura.yml'), 'plugins:\n  core-session:\n    config:\n      dir: saved-history\n')
  const saved = new Session('history-id', path.join(other, 'saved-history', 'history-id'))
  await saved.append({ type: 'user/message', payload: { content: '历史工作任务' } })
  await saved.append({ type: 'assistant/attempt', payload: { error: 'cancelled' } })
  const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('finished')]), token: null, viewerToken: null,
    open: false, quiet: true, updatesAutoCheck: false, recentWorkspaces: [other],
    ...(desktop ? { onPersistSettings() {} } : {}) })
  cleanups.push(() => handle.close())
  return { cwd, other, handle, saved }
}

describe('workspace collaboration overview', () => {
  it('lists real histories and live agents without switching or mounting unopened workspaces', async () => {
    const { handle, other, saved } = await boot()
    await handle.harness.run('当前工作任务')
    const main = handle.harness.main()
    const child = handle.harness.ctx.agents.spawn({ name: 'reviewer', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    await child.turn('review module')
    const response = await fetch(handle.url + 'api/collaboration')
    expect(response.status).toBe(200)
    const data = await response.json() as any
    expect(data.workspaces).toHaveLength(2)
    const current = data.workspaces.find((row: any) => row.active)
    expect(current).toMatchObject({ live: true, running: 0, pending: 0 })
    expect(current.agents.map((row: any) => row.id)).toEqual([main.id, child.id])
    expect(current.sessions.find((row: any) => row.id === main.sessionId)).toMatchObject({ status: 'done', activity: { lastTask: '当前工作任务' } })
    const history = data.workspaces.find((row: any) => row.path === other)
    expect(history).toMatchObject({ active: false, live: false, running: 0, agents: [] })
    expect(history.sessions).toMatchObject([{ id: saved.id, status: 'cancelled', activity: { lastTask: '历史工作任务' } }])
    expect(handle.harness.main()).toBe(main)
    await expect(fs.stat(path.join(other, '.sakura', 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify(data)).not.toContain('system/message')
  })

  it('limits ordinary web servers to their own workspace even when a recent list was supplied', async () => {
    const { handle, cwd } = await boot(false)
    const data = await (await fetch(handle.url + 'api/collaboration')).json() as any
    expect(data.workspaces).toHaveLength(1)
    expect(data.workspaces[0].path).toBe(cwd)
  })

  it('honours per-workspace session-directory overrides and reports inaccessible recent paths', async () => {
    const { handle, other } = await boot()
    const custom = path.join(other, 'alternate')
    await new Session('override-id', path.join(custom, 'override-id')).append({ type: 'user/message', payload: { content: 'override' } })
    expect((await fetch(handle.url + 'api/desktop/settings', { method: 'POST', body: JSON.stringify({ workspace: other, sessionDir: custom }) })).status).toBe(200)
    const first = await (await fetch(handle.url + 'api/collaboration')).json() as any
    expect(first.workspaces.find((row: any) => row.active).sessions.map((row: any) => row.id)).toEqual(['override-id'])
    const previous = first.workspaces.find((row: any) => !row.active).path
    expect((await fetch(handle.url + 'api/desktop/settings', { method: 'POST', body: JSON.stringify({ workspace: previous }) })).status).toBe(200)
    await fs.rm(other, { recursive: true, force: true })
    const missing = await (await fetch(handle.url + 'api/collaboration')).json() as any
    expect(missing.workspaces.find((row: any) => row.path === other)).toMatchObject({ live: false, running: 0, sessions: [], error: expect.any(String) })
  })

  it('does not return a disk listing read before deletion with a newer revision', async () => {
    const { handle } = await boot()
    const history = await handle.harness.ctx.sessions.create()
    const original = handle.harness.ctx.sessions.list.bind(handle.harness.ctx.sessions)
    let entered!: () => void, release!: () => void
    const reading = new Promise<void>(r => { entered = r })
    const pending = new Promise<void>(r => { release = r })
    let first = true
    vi.spyOn(handle.harness.ctx.sessions, 'list').mockImplementation(async () => {
      const rows = await original()
      if (first) { first = false; entered(); await pending }
      return rows
    })
    const response = fetch(handle.url + 'api/collaboration')
    try {
      await reading
      expect((await fetch(handle.url + 'api/sessions/' + history.id, { method: 'DELETE' })).status).toBe(200)
    } finally { release() }
    const data = await (await response).json() as any
    expect(data.workspaces.find((row: any) => row.active).sessions.some((row: any) => row.id === history.id)).toBe(false)
  })
})