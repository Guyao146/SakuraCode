import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
async function directory() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-market-api-')); cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })); return cwd }
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = extra.cwd ?? await directory()
  const server = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, ...extra })
  cleanups.push(() => server.close()); return { server, cwd, base: server.url }
}
const reply = () => new Response(JSON.stringify({ objects: [{ package: { name: 'sakuracode-plugin-review', version: '1.0.0', description: 'Public review plugin', keywords: ['sakuracode-plugin'] } }], total: 1 }))
const post = (base: string, route: string, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })

interface ResourceState {
  plugins: Array<{ name: string; source: string }>
  skills: Array<{ name: string; source: string }>
}

async function state(base: string): Promise<ResourceState> {
  const response = await fetch(base + 'api/state')
  expect(response.status).toBe(200)
  return response.json() as Promise<ResourceState>
}

describe('local plugin marketplace and Skill refresh API', () => {
  it('does not query on startup/state/list inspection and searches public metadata only on request', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply()), persisted = vi.fn()
    const { server, base } = await boot({ pluginMarketplaceFetch: fetcher, onPersistSettings: persisted })
    const before = await state(base)
    expect(fetcher).not.toHaveBeenCalled()
    const response = await fetch(base + 'api/plugins/marketplace?q=review&page=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'npm', query: 'review', items: [{ name: 'sakuracode-plugin-review' }] })
    const after = await state(base)
    expect(after.plugins).toEqual(before.plugins); expect(server.harness.main().status).toBe('idle')
    expect(persisted).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await fetch(base + 'api/plugins/marketplace?q=review&page=1')).status).toBe(200)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect((await post(base, 'api/plugins/marketplace')).status).toBe(404)
  })

  it('blocks unauthenticated and remote operator/viewer network access before querying', async () => {
    const operator = 'market-operator-' + 'a'.repeat(40), viewer = 'market-viewer-' + 'b'.repeat(40)
    const fetcher = vi.fn<typeof fetch>(async () => reply())
    const { base } = await boot({ host: '0.0.0.0', token: operator, viewerToken: viewer, pluginMarketplaceFetch: fetcher })
    expect((await fetch(base + 'api/plugins/marketplace')).status).toBe(401)
    for (const token of [operator, viewer]) {
      const headers = { authorization: 'Bearer ' + token }
      expect((await fetch(base + 'api/plugins/marketplace', { headers })).status).toBe(404)
      expect((await post(base, 'api/skills/reload', headers)).status).toBe(token === viewer ? 403 : 404)
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('reports timeout and invalid search parameters without changing the local plugin set', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Promise(() => {}))
    const { base } = await boot({ pluginMarketplaceFetch: fetcher, pluginMarketplaceTimeoutMs: 30 })
    for (const suffix of ['?page=0', '?page=1.5', '?page=51', '?q=' + 'x'.repeat(121), '?q=%0A']) {
      expect((await fetch(base + 'api/plugins/marketplace' + suffix)).status).toBe(400)
    }
    expect(fetcher).not.toHaveBeenCalled()
    const response = await fetch(base + 'api/plugins/marketplace')
    expect(response.status).toBe(504); expect(await response.text()).toContain('超时')
    expect((await state(base)).plugins.length).toBeGreaterThan(0)
  })

  it('reloads newly added Skill metadata and its prompt section without executing a file or persisting desktop settings', async () => {
    const persisted = vi.fn(), { cwd, base, server } = await boot({ onPersistSettings: persisted })
    const before = await state(base)
    expect(before.skills.some(skill => skill.name === 'fresh-skill')).toBe(false)
    const dir = path.join(cwd, '.sakura', 'skills', 'fresh-skill')
    await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: fresh-skill\ndescription: Fresh discovery\n---\nBODY_NOT_AUTOMATICALLY_INJECTED')
    const response = await post(base, 'api/skills/reload')
    expect(response.status).toBe(200)
    const reloaded = await response.json() as ResourceState
    expect(reloaded.skills).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'fresh-skill', source: 'project' })]))
    expect(server.harness.ctx.systemPrompt.assemble()).toContain('fresh-skill')
    expect(server.harness.ctx.systemPrompt.assemble()).not.toContain('BODY_NOT_AUTOMATICALLY_INJECTED')
    expect(await (await fetch(base + 'api/skills/fresh-skill')).json()).toMatchObject({ body: 'BODY_NOT_AUTOMATICALLY_INJECTED' })
    expect(persisted).not.toHaveBeenCalled()
  })
})