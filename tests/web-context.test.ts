/** Context viewer API: counts only, versioned manual actions, persistence and races. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type DesktopSettingsState, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import type { CompactionService } from '../src/plugins/compaction.js'
import type { ContextBreakdown, ContextBudgetSettings } from '../src/util/context.js'
import { SessionService } from '../src/core/session.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-context-'))
  const handle = await runWebServer({ cwd, open: false, quiet: true, updatesAutoCheck: false, approvalMode: 'yolo',
    adapter: new MockAdapter([text('SHORT_SUMMARY')]), config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } }, ...extra })
  cleanups.push(async () => { await handle.close(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
  return { handle, cwd, base: handle.url.replace(/\/$/, '') }
}

interface State {
  workspaceId: string
  sessionId: string | null
  contextTokens: number
  contextRevision: number
  contextBreakdown: ContextBreakdown
  contextBudget: ContextBudgetSettings & { autoTokensThreshold: number; source: string; persisted: boolean }
  contextOperation: { action: string } | null
  contextCompacting: boolean
}
const state = async (base: string) => (await (await fetch(base + '/api/state')).json()) as State
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const action = (s: State) => ({ sessionId: s.sessionId, contextRevision: s.contextRevision })

async function seed(handle: WebServerHandle) {
  const session = await handle.harness.ctx.sessions.create({ title: '保留的历史' })
  await session.append({ type: 'user/message', payload: { content: 'PRIVATE_CONVERSATION '.repeat(2000) } })
  handle.harness.main({ resumeSessionId: session.id })
  return session
}

function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
function pausedAdapter(fail = false) {
  const started = barrier(), finish = barrier()
  const requests: LLMRequest[] = []
  const adapter: ModelAdapter = { id: 'paused-context', defaultModel: 'paused-model', async *stream(request): AsyncIterable<StreamChunk> {
    requests.push(request); started.release(); await finish.promise
    if (fail) throw new Error('SUMMARY_FAILED')
    yield* text('SHORT_SUMMARY')
  } }
  return { adapter, requests, started: started.promise, release: finish.release }
}

describe('context viewer server', () => {
  it('returns truthful empty state and private count-only model context', async () => {
    const { base, handle } = await boot()
    expect(await state(base)).toMatchObject({ contextTokens: 0, contextRevision: 0, contextBreakdown: { totalTokens: 0 } })
    await seed(handle)
    const snapshot = await state(base)
    expect(snapshot.contextTokens).toBe(snapshot.contextBreakdown.totalTokens)
    expect(snapshot.contextBreakdown.toolDefinitionTokens).toBeGreaterThan(0)
    expect(snapshot.contextBreakdown.categories.find(row => row.category === 'system')!.tokens).toBeGreaterThan(0)
    expect(JSON.stringify(snapshot.contextBreakdown)).not.toContain('PRIVATE_CONVERSATION')
    expect(snapshot.contextBudget).toMatchObject({ contextWindowTokens: 64000, source: 'local' })
  })

  it('manual compaction replaces model context with a summary without erasing history', async () => {
    const { base, handle } = await boot()
    const session = await seed(handle), before = await state(base)
    const original = await fs.readFile(session.file, 'utf8')
    const response = await post(base, '/api/context/compact', action(before))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, compactedEvents: 3 })
    const after = await state(base)
    expect(after.contextTokens).toBeLessThan(before.contextTokens)
    expect(after.contextOperation).toBeNull()
    expect(after.contextCompacting).toBe(false)
    expect((await fs.readFile(session.file, 'utf8')).startsWith(original)).toBe(true)
    expect(JSON.stringify(session.deriveMessages())).toContain('SHORT_SUMMARY')
    expect(JSON.stringify(session.deriveMessages())).not.toContain('PRIVATE_CONVERSATION')
  })

  it('requires confirmation, clears the summary too and persists without deleting history or files', async () => {
    const { base, handle, cwd } = await boot()
    const session = await seed(handle)
    await post(base, '/api/context/compact', action(await state(base)))
    const before = await state(base), log = await fs.readFile(session.file, 'utf8')
    await fs.writeFile(path.join(cwd, 'sentinel.txt'), 'project survives')
    expect((await post(base, '/api/context/clear', action(before))).status).toBe(400)
    expect(await fs.readFile(session.file, 'utf8')).toBe(log)
    expect((await post(base, '/api/context/clear', { ...action(before), confirmed: true })).status).toBe(200)
    expect((await fs.readFile(session.file, 'utf8')).startsWith(log)).toBe(true)
    expect(session.deriveMessages()).toEqual([])
    expect(await fs.readFile(path.join(cwd, 'sentinel.txt'), 'utf8')).toBe('project survives')
    const fresh = await new SessionService(path.dirname(session.dir)).open(session.id)
    expect(fresh.deriveMessages()).toEqual([])
    const after = await state(base)
    expect(after.sessionId).toBe(before.sessionId)
    expect(after.contextBreakdown.categories.filter(row => row.tokens > 0).map(row => row.category)).toEqual(['system', 'tools'])
    const compact = vi.spyOn(handle.harness.ctx.get<CompactionService>('compaction'), 'compact')
    await handle.harness.ctx.get<CompactionService>('compaction').maybeAutoCompact(session.id)
    expect(compact).not.toHaveBeenCalled()
  })

  it('rejects stale versions, wrong sessions and wrong workspace headers without changing the log', async () => {
    const { base, handle } = await boot(), session = await seed(handle), before = await state(base)
    await session.append({ type: 'user/message', payload: { content: 'newer task' } })
    const log = await fs.readFile(session.file, 'utf8')
    for (const body of [action(before), { ...action(await state(base)), sessionId: 'other-session' }]) {
      expect((await post(base, '/api/context/clear', { ...body, confirmed: true })).status).toBe(409)
    }
    expect((await post(base, '/api/context/compact', action(await state(base)), { 'x-sakura-workspace': 'old-workspace' })).status).toBe(409)
    expect(await fs.readFile(session.file, 'utf8')).toBe(log)
    expect((await state(base)).contextOperation).toBeNull()
  })

  it('guards running agents and all competing writes during a manual summary', async () => {
    const paused = pausedAdapter(), { base, handle } = await boot({ adapter: paused.adapter }), session = await seed(handle)
    const request = post(base, '/api/context/compact', action(await state(base)))
    try {
      await paused.started
      expect(await state(base)).toMatchObject({ contextOperation: { action: 'compact' }, contextCompacting: true })
      for (const route of ['/api/message', '/api/sessions', '/api/agents', '/api/context/clear', '/api/context/compact', '/api/context/settings', '/api/desktop/settings', '/api/settings']) {
        expect((await post(base, route, { text: 'must not interleave', ...action(await state(base)), confirmed: true })).status, route).toBe(409)
      }
      expect((await fetch(base + '/api/sessions/' + session.id, { method: 'DELETE' })).status).toBe(409)
    } finally { paused.release() }
    expect((await request).status).toBe(200)
    expect((await state(base)).contextOperation).toBeNull()
    const busy = barrier()
    paused.adapter.stream = async function* () { await busy.promise; yield* text('done') }
    const main = handle.harness.main(), running = main.turn('busy task')
    try {
      await vi.waitFor(() => expect(main.status).toBe('running'))
      expect((await post(base, '/api/context/clear', { ...action(await state(base)), confirmed: true })).status).toBe(409)
    } finally { busy.release(); await running }
  })

  it('releases the write gate and preserves context when summarization fails', async () => {
    const paused = pausedAdapter(true), { base, handle } = await boot({ adapter: paused.adapter }), session = await seed(handle)
    const log = await fs.readFile(session.file, 'utf8'), request = post(base, '/api/context/compact', action(await state(base)))
    await paused.started; paused.release()
    expect((await request).status).toBe(500)
    expect(await fs.readFile(session.file, 'utf8')).toBe(log)
    expect(await state(base)).toMatchObject({ contextOperation: null, contextCompacting: false })
  })

  it('a clear persistence failure leaves the old model context and makes an explicit retry safe', async () => {
    const { base, handle } = await boot(), session = await seed(handle), before = await state(base)
    const original = await fs.readFile(session.file, 'utf8')
    const denied = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try { expect((await post(base, '/api/context/clear', { ...action(before), confirmed: true })).status).toBe(500) } finally { denied.mockRestore() }
    expect(await fs.readFile(session.file, 'utf8')).toBe(original)
    expect((await state(base)).contextTokens).toBe(before.contextTokens)
    expect((await state(base)).contextOperation).toBeNull()
    expect((await post(base, '/api/context/clear', { ...action(await state(base)), confirmed: true })).status).toBe(200)
  })

  it('blocks clear while auto-compacting or while an assistant tool call is still unanswered', async () => {
    const paused = pausedAdapter(), { base, handle } = await boot({ adapter: paused.adapter }), session = await seed(handle)
    const compaction = handle.harness.ctx.get<CompactionService>('compaction')
    compaction.autoThreshold = 1
    const attempt = compaction.maybeAutoCompact(session.id)
    try {
      await paused.started
      expect((await post(base, '/api/context/clear', { ...action(await state(base)), confirmed: true })).status).toBe(409)
    } finally { paused.release(); await attempt }
    compaction.autoThreshold = 0
    const calls = [{ id: 'pending-call', type: 'function' as const, function: { name: 'read', arguments: '{}' } }]
    await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: null, tool_calls: calls, stream: { text: '', toolCalls: calls, durationMs: 1 } } })
    const log = await fs.readFile(session.file, 'utf8')
    expect((await post(base, '/api/context/compact', action(await state(base)))).status).toBe(409)
    expect(await fs.readFile(session.file, 'utf8')).toBe(log)
  })

  it('rejects a slow old request that straddles another completed context operation', async () => {
    const { base, handle } = await boot(), session = await seed(handle), before = await state(base)
    const body = JSON.stringify({ ...action(before), confirmed: true })
    let request!: http.ClientRequest
    const completed = new Promise<{ status: number; body: string }>((resolve, reject) => {
      request = http.request(base + '/api/context/clear', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        let result = ''; response.on('data', chunk => { result += chunk }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: result }))
      })
      request.on('error', reject); request.write(body.slice(0, -1))
    })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect((await post(base, '/api/context/compact', action(await state(base)))).status).toBe(200)
      request.end(body.slice(-1))
      expect((await completed).status).toBe(409)
      expect(session.events.some(event => event.type === 'session/note' && event.payload.note === 'context-clear')).toBe(false)
    } finally { request.destroy() }
  })

  it('persists threshold settings per workspace and restores them across restart', async () => {
    const persisted: DesktopSettingsState[] = [], { base, handle, cwd } = await boot({ onPersistSettings: settings => { persisted.push(settings) } })
    const budget = { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 }
    expect((await post(base, '/api/context/settings', budget)).status).toBe(200)
    expect(await state(base)).toMatchObject({ contextBudget: { ...budget, autoTokensThreshold: 89600, persisted: true } })
    expect(persisted.at(-1)?.workspacePrefs?.[cwd]?.contextBudget).toEqual(budget)
    await handle.close()
    const resumed = await runWebServer({ cwd, open: false, quiet: true, updatesAutoCheck: false, workspacePrefs: persisted.at(-1)!.workspacePrefs, adapter: new MockAdapter([text('ok')]) })
    cleanups.push(() => resumed.close())
    expect(await state(resumed.url.replace(/\/$/, ''))).toMatchObject({ contextBudget: { ...budget, autoTokensThreshold: 89600 } })
  })

  it('rolls back a failed persistence and rejects invalid budget settings atomically', async () => {
    const { base } = await boot({ onPersistSettings: () => { throw new Error('storage failed') } }), before = await state(base)
    expect((await post(base, '/api/context/settings', { contextWindowTokens: 128000, thresholdPercent: 75, autoThreshold: 0 })).status).toBe(500)
    expect((await state(base)).contextBudget).toEqual(before.contextBudget)
    expect((await post(base, '/api/context/settings', { contextWindowTokens: 128000, thresholdPercent: -1, autoThreshold: 0 })).status).toBe(400)
    expect((await state(base)).contextBudget).toEqual(before.contextBudget)
  })

  it('keeps independent thresholds when switching away and back and does not leak them into another workspace', async () => {
    const { base, cwd } = await boot({ onPersistSettings: () => {} })
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-context-other-'))
    cleanups.push(() => fs.rm(other, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
    expect((await post(base, '/api/context/settings', { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 })).status).toBe(200)
    expect((await post(base, '/api/desktop/settings', { workspace: other })).status).toBe(200)
    expect((await state(base)).contextBudget).toMatchObject({ contextWindowTokens: 64000, autoTokensThreshold: 48000, autoThreshold: 120 })
    expect((await post(base, '/api/desktop/settings', { workspace: cwd })).status).toBe(200)
    expect((await state(base)).contextBudget).toMatchObject({ contextWindowTokens: 128000, autoTokensThreshold: 89600, autoThreshold: 0 })
  })

  it('offers read-only accounting but rejects every context write for viewers and cross-origin requests', async () => {
    const operator = 'operator-' + 'a'.repeat(40), viewer = 'viewer-' + 'b'.repeat(40)
    const { base, handle } = await boot({ host: '0.0.0.0', token: operator, viewerToken: viewer })
    await seed(handle)
    expect((await fetch(base + '/api/state', { headers: { authorization: 'Bearer ' + viewer } })).status).toBe(200)
    for (const route of ['/api/context/compact', '/api/context/clear', '/api/context/settings']) {
      expect((await post(base, route, {}, { authorization: 'Bearer ' + viewer })).status).toBe(403)
      expect((await post(base, route, {}, { authorization: 'Bearer ' + operator, origin: 'https://evil.test' })).status).toBe(403)
    }
  })
})