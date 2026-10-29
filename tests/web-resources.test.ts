import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { resourceToken } from '../src/mentions/resources.js'
import { MockAdapter, text } from './helpers.js'
import type { LLMRequest } from '../src/core/types.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
async function directory() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-resources-api-')); cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })); return cwd }
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = extra.cwd ?? await directory()
  const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('ok')]), open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, ...extra })
  cleanups.push(() => handle.close())
  return { cwd, handle, base: handle.url }
}
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

describe('Skill import and resource mention API', () => {
  it('imports a Skill and includes its real body only when explicitly selected', async () => {
    const requests: LLMRequest[] = [], { handle, base } = await boot({ adapter: new MockAdapter([request => { requests.push(request); return text('ok') }]) })
    expect((await post(base, 'api/skills/import', { scope: 'project', files: [{ path: 'SKILL.md', content: '---\nname: imported\ndescription: Imported skill\n---\nIMPORTED_BODY @secret.txt' }] })).status).toBe(200)
    await handle.harness.run('no Skill selected')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('IMPORTED_BODY')
    const catalog = await (await fetch(base + 'api/mentions')).json() as { candidates: Array<{ kind: string; id: string }> }
    expect(catalog.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'skill', id: 'imported' })]))
    expect((await post(base, 'api/message', { text: 'use @[skill:imported]' })).status).toBe(202)
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    await handle.harness.main().wait()
    expect(JSON.stringify(requests[1]?.messages)).toContain('IMPORTED_BODY @secret.txt')
    expect(JSON.stringify(requests[1]?.messages)).not.toContain('<file path=')
  })

  it('lists all known memory metadata without revealing bodies and permits explicit cross-workspace references only', async () => {
    const cwd = await directory(), other = await directory(), unknown = await directory()
    await new WorkspaceMemoryStore(cwd).update({ content: 'CURRENT_PRIVATE_NOTES' }, 0)
    await new WorkspaceMemoryStore(other).update({ content: 'OTHER_PRIVATE_NOTES' }, 0)
    const requests: LLMRequest[] = [], { base, handle } = await boot({ cwd, recentWorkspaces: [other], onPersistSettings() {},
      adapter: new MockAdapter([request => { requests.push(request); return text('done') }]) })
    const catalogResponse = await fetch(base + 'api/workspace/memories'), raw = await catalogResponse.text()
    expect(raw).not.toContain('OTHER_PRIVATE_NOTES'); expect(raw).not.toContain('CURRENT_PRIVATE_NOTES')
    const catalog = JSON.parse(raw) as { workspaces: unknown[] }; expect(catalog.workspaces).toHaveLength(2)
    expect((await fetch(base + 'api/workspace/memory?workspace=' + encodeURIComponent(unknown))).status).toBe(404)
    expect((await post(base, 'api/message', { text: 'use ' + resourceToken('memory', unknown) })).status).toBe(404)
    await handle.harness.run('only current memory')
    expect(JSON.stringify(requests[0]?.messages)).not.toContain('OTHER_PRIVATE_NOTES')
    expect((await post(base, 'api/message', { text: 'compare ' + resourceToken('memory', other) })).status).toBe(202)
    await handle.harness.main().wait()
    expect(JSON.stringify(requests[1]?.messages)).toContain('OTHER_PRIVATE_NOTES')
    const external = await (await fetch(base + 'api/workspace/memory?workspace=' + encodeURIComponent(other))).json() as { revision: number }
    expect((await post(base, 'api/workspace/memory?workspace=' + encodeURIComponent(other), { content: 'OTHER_EDITED', revision: external.revision })).status).toBe(200)
    expect((await new WorkspaceMemoryStore(other).reload()).content).toBe('OTHER_EDITED')
    expect(handle.harness.ctx.systemPrompt.assemble()).not.toContain('OTHER_EDITED')
    expect(await (await fetch(base + 'api/workspace/memory/export?workspace=' + encodeURIComponent(other))).text()).toContain('OTHER_EDITED')
  })

  it('includes session context and registered agent identity without changing the live session', async () => {
    const requests: LLMRequest[] = [], { handle, base } = await boot({ adapter: new MockAdapter([request => { requests.push(request); return text('answer') }]) })
    const history = await handle.harness.ctx.sessions.create({ title: 'reference history' })
    await history.append({ type: 'user/message', payload: { content: 'HISTORY_REFERENCE_DATA' } })
    const main = handle.harness.main(), member = handle.harness.ctx.agents.spawn({ seed: '', name: 'reviewer', autoStart: false, persistentSession: true, meta: { role: 'sub', description: 'Review changes' } })
    expect((await post(base, 'api/message', { text: `review ${resourceToken('session', history.id)} ${resourceToken('agent', member.id)}` })).status).toBe(202)
    await main.wait()
    expect(main.sessionId).not.toBe(history.id)
    expect(JSON.stringify(requests[0]?.messages)).toContain('HISTORY_REFERENCE_DATA')
    expect(JSON.stringify(requests[0]?.messages)).toContain(member.id)
    expect((await post(base, 'api/message', { text: '@[agent:does-not-exist]' })).status).toBe(400)
  })

  it('hides local import and memory management from remote operators/viewers', async () => {
    const operator = 'resources-operator-' + 'a'.repeat(40), viewer = 'resources-viewer-' + 'b'.repeat(40)
    const { base } = await boot({ host: '0.0.0.0', token: operator, viewerToken: viewer, onPersistSettings() {} })
    for (const token of [operator, viewer]) {
      const headers = { authorization: 'Bearer ' + token }
      expect((await fetch(base + 'api/workspace/memories', { headers })).status).toBe(404)
      expect((await post(base, 'api/skills/import', { scope: 'project', files: [] }, headers)).status).toBe(token === viewer ? 403 : 404)
      const catalog = await (await fetch(base + 'api/mentions', { headers })).json() as { candidates: Array<{ kind: string }> }
      expect(catalog.candidates.some(row => row.kind === 'memory')).toBe(false)
    }
  })

  it('rejects every competing task/write while automatic memory processing owns the model request', async () => {
    let began!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { began = resolve }), finish = new Promise<void>(resolve => { release = resolve })
    const { base, handle } = await boot({ onPersistSettings() {}, adapter: { id: 'held-summary', defaultModel: 'held', async *stream() { began(); await finish; yield* text('finished memory') } } })
    const memory = handle.harness.ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({ processing: { auto: true, thresholdChars: 1000, intervalMs: 0 } }, 0)
    await memory.appendPending('facts '.repeat(200))
    const processing = handle.harness.ctx.get<import('../src/plugins/memory-processing.js').MemoryProcessingService>('memoryProcessing').maybeProcess()
    await entered
    try {
      expect((await post(base, 'api/message', { text: 'cannot race' })).status).toBe(409)
      expect((await post(base, 'api/settings', { model: 'held' })).status).toBe(409)
      expect((await post(base, 'api/workspace/memory', { content: 'cannot replace', revision: memory.snapshot().revision })).status).toBe(409)
      expect((await post(base, 'api/agents', { name: 'new worker' })).status).toBe(409)
      expect((await post(base, 'api/desktop/settings', {})).status).toBe(409)
    } finally { release(); await processing }
    expect(memory.snapshot().content).toBe('finished memory')
  })
})