/** Actual HTTP/SSE conversation edit/rewind boundaries, locks and replay. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import type { ModelAdapter, SessionEventRecord, StreamChunk } from '../src/core/types.js'
import type { CompactionService } from '../src/plugins/compaction.js'
import { MockAdapter, text, toolCall } from './helpers.js'
import { startHistoryBackgroundPreview } from './history-background-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.() })
function barrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-history-api-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const handle = await runWebServer({ cwd, open: false, quiet: true, approvalMode: 'yolo', token: null, viewerToken: null, updatesAutoCheck: false,
    adapter: new MockAdapter([text('ANSWER')]), config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } }, ...extra })
  cleanups.push(() => handle.close())
  const base = handle.url.replace(/\/$/, '')
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { cwd, handle, base, post }
}
async function seed(f: Awaited<ReturnType<typeof boot>>) {
  await f.handle.harness.run('kept task')
  await f.handle.harness.run('discarded task')
  const session = await f.handle.harness.ctx.sessions.open(f.handle.harness.main().sessionId)
  const user = session.events.filter(record => record.type === 'user/message').at(-1)!
  const previewResponse = await f.post('/api/sessions/' + session.id + '/history/preview', { turnSeq: user.seq })
  expect(previewResponse.status).toBe(200)
  const preview = await previewResponse.json() as { fingerprint: string; contextRevision: number; workspaceId: string }
  return { session, user, preview, body: { turnSeq: user.seq, fingerprint: preview.fingerprint, contextRevision: preview.contextRevision, confirmed: true, mode: 'conversation' } }
}

describe('conversation history API', () => {
  it('creates a preserved-prefix edit branch without sending a model request, then regenerates only once', async () => {
    const requests: unknown[] = []
    const adapter: ModelAdapter = { id: 'history-model', defaultModel: 'history-model', async *stream(req): AsyncIterable<StreamChunk> { requests.push(req.messages); yield* text('EDIT_ANSWER') } }
    const f = await boot({ adapter }), { session, user, body } = await seed(f)
    const original = await fs.readFile(session.file)
    const response = await f.post('/api/sessions/' + session.id + '/history/edit', { ...body, text: 'REPLACED TASK' })
    expect(response.status).toBe(200)
    const result = await response.json() as { sessionId: string }
    expect(result).toMatchObject({ edited: true, generated: false, sourceId: session.id, restoredFiles: 0 })
    expect(requests).toHaveLength(2)
    expect(await fs.readFile(session.file)).toEqual(original)
    const branch = await f.handle.harness.ctx.sessions.open(result.sessionId)
    expect(branch.deriveMessages().filter(message => message.role === 'user').map(message => message.content)).toEqual(['kept task', 'REPLACED TASK'])
    expect(JSON.stringify(branch.events)).not.toContain('discarded task')
    expect((await (await fetch(f.base + '/api/state')).json()) as unknown).toMatchObject({ sessionId: branch.id, historyGenerationReady: true, expertMode: false })
    expect((await f.post('/api/conversation/generate', { sessionId: branch.id })).status).toBe(202)
    await f.handle.harness.main().wait()
    expect(requests).toHaveLength(3)
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(2)
    expect((await f.post('/api/conversation/generate', { sessionId: branch.id })).status).toBe(409)
    expect((await f.post('/api/sessions/' + session.id + '/history/edit', { ...body, text: 'duplicate' })).status).toBe(409)
    expect(requests).toHaveLength(3)
    const exported = await (await fetch(f.base + '/api/sessions/' + branch.id + '/export')).text()
    expect(exported).toContain('REPLACED TASK'); expect(exported).not.toContain('discarded task')
    expect(user.seq).toBeGreaterThan(1)
  })

  it.each(['edit', 'rewind'] as const)('allows a conversation-only %s while a real background preview keeps running, but rejects code restoration', async action => {
    const adapter = new MockAdapter([text('KEPT_ANSWER'),
      toolCall('write', JSON.stringify({ file_path: 'background-code.txt', content: 'BACKGROUND_CODE_KEEP' })), text('CODE_ANSWER'), text('EDITED_ANSWER')])
    const requests = vi.spyOn(adapter, 'stream')
    const f = await boot({ adapter }), { session, user, body } = await seed(f)
    const original = await fs.readFile(session.file), file = path.join(f.cwd, 'background-code.txt')
    const background = await startHistoryBackgroundPreview(f.handle.harness.ctx.jobs!, f.cwd)
    cleanups.push(() => background.stop())
    expect(await (await fetch(background.url)).text()).toBe('HISTORY_BACKGROUND_PREVIEW_ALIVE')
    const route = '/api/sessions/' + session.id + '/history/'
    const response = await f.post(route + 'preview', { turnSeq: user.seq })
    expect(response.status).toBe(200)
    const preview = await response.json() as { codeRestoreBlockedReason: string; checkpoint: { files: unknown[] } }
    expect(preview.codeRestoreBlockedReason).toContain('后台命令')
    expect(preview.checkpoint.files).toHaveLength(1)
    // The confirmation was captured before the background job began: the
    // commit must recheck live jobs instead of trusting that earlier preview.
    for (const mode of action === 'edit' ? ['both'] : ['code', 'both']) {
      const rejected = await f.post(route + action, { ...body, mode, text: 'BACKGROUND_EDIT' })
      expect(rejected.status).toBe(409)
      expect(await rejected.json()).toMatchObject({ error: expect.stringContaining('后台命令') })
    }
    expect(await fs.readFile(file, 'utf8')).toBe('BACKGROUND_CODE_KEEP')
    expect(await fs.readFile(session.file)).toEqual(original)
    expect((await f.handle.harness.ctx.sessions.list())).toHaveLength(1)
    expect(f.handle.harness.main().sessionId).toBe(session.id)
    expect(requests).toHaveBeenCalledTimes(3)
    const committed = await f.post(route + action, { ...body, text: 'BACKGROUND_EDIT' })
    expect(committed.status).toBe(200)
    const result = await committed.json() as { sessionId: string }
    expect(result).toMatchObject({ edited: action === 'edit', generated: false, sourceId: session.id, restoredFiles: 0 })
    expect(result.sessionId).not.toBe(session.id)
    const branch = await f.handle.harness.ctx.sessions.open(result.sessionId)
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(action === 'edit' ? 2 : 1)
    if (action === 'edit') {
      expect((await f.post('/api/conversation/generate', { sessionId: result.sessionId })).status).toBe(202)
      await f.handle.harness.main().wait()
      expect((await f.post('/api/conversation/generate', { sessionId: result.sessionId })).status).toBe(409)
      expect(requests).toHaveBeenCalledTimes(4)
      expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(2)
    } else expect(requests).toHaveBeenCalledTimes(3)
    expect(background.job.status).toBe('running')
    expect(await (await fetch(background.url)).text()).toBe('HISTORY_BACKGROUND_PREVIEW_ALIVE')
    expect(await fs.readFile(file, 'utf8')).toBe('BACKGROUND_CODE_KEEP')
    expect(await fs.readFile(session.file)).toEqual(original)
  })

  it('allows code restoration after the background preview stops and a fresh preview is confirmed', async () => {
    const f = await boot({ adapter: new MockAdapter([toolCall('write', JSON.stringify({ file_path: 'background-code.txt', content: 'GENERATED_CODE' })), text('ANSWER')]) })
    await f.handle.harness.run('create code')
    const session = await f.handle.harness.ctx.sessions.open(f.handle.harness.main().sessionId)
    const user = session.events.find(record => record.type === 'user/message')!, original = await fs.readFile(session.file)
    const background = await startHistoryBackgroundPreview(f.handle.harness.ctx.jobs!, f.cwd)
    cleanups.push(() => background.stop())
    const route = '/api/sessions/' + session.id + '/history/'
    const blocked = await f.post(route + 'preview', { turnSeq: user.seq })
    expect(blocked.status).toBe(200)
    expect(await blocked.json()).toMatchObject({ codeRestoreBlockedReason: expect.stringContaining('后台命令') })
    await background.stop()
    const preview = await (await f.post(route + 'preview', { turnSeq: user.seq })).json() as { fingerprint: string; contextRevision: number; codeRestoreBlockedReason: string }
    expect(preview.codeRestoreBlockedReason).toBe('')
    expect((await f.post(route + 'rewind', { ...preview, turnSeq: user.seq, mode: 'code', confirmed: true })).status).toBe(200)
    await expect(fs.access(path.join(f.cwd, 'background-code.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(session.file)).toEqual(original)
  })

  it('restores only native code without truncating the dialogue or replacing the main agent', async () => {
    const f = await boot({ adapter: new MockAdapter([toolCall('write', JSON.stringify({ file_path: 'new.txt', content: 'generated' })), text('CODE ANSWER')]) })
    await f.handle.harness.run('create code')
    const main = f.handle.harness.main(), session = await f.handle.harness.ctx.sessions.open(main.sessionId)
    const user = session.events.find(record => record.type === 'user/message')!, log = await fs.readFile(session.file)
    const p = await (await f.post('/api/sessions/' + session.id + '/history/preview', { turnSeq: user.seq })).json() as { contextRevision: number; fingerprint: string }
    expect((await f.post('/api/sessions/' + session.id + '/history/rewind', { turnSeq: user.seq, ...p, mode: 'code', confirmed: true })).status).toBe(200)
    expect(f.handle.harness.main()).toBe(main)
    expect(await fs.readFile(session.file)).toEqual(log)
    await expect(fs.access(path.join(f.cwd, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(session.deriveMessages().some(message => message.content === 'CODE ANSWER')).toBe(true)
  })

  it('requires a current explicit confirmation and validates sequence, scope, session and workspace', async () => {
    const f = await boot(), s = await seed(f), route = '/api/sessions/' + s.session.id + '/history/rewind'
    const log = await fs.readFile(s.session.file)
    for (const bad of [{ ...s.body, confirmed: false }, { ...s.body, fingerprint: 'invalid' }, { ...s.body, turnSeq: 1 },
      { ...s.body, turnSeq: 1.2 }, { ...s.body, mode: 'all' }, { ...s.body, mode: 'code' }]) {
      expect((await f.post(route, bad)).status).toBe(400)
    }
    expect((await f.post(route, s.body, { 'x-sakura-workspace': 'wrong-workspace' })).status).toBe(409)
    expect((await f.post('/api/sessions/unknown/history/rewind', s.body)).status).toBe(409)
    await s.session.append({ type: 'user/message', payload: { content: 'NEWER' } })
    expect((await f.post(route, s.body)).status).toBe(409)
    expect((await fs.readFile(s.session.file)).subarray(0, log.length)).toEqual(log)
    expect((await f.handle.harness.ctx.sessions.list())).toHaveLength(1)
  })

  it('rejects old preview after a file change, exposes conflicts, and allows a fresh conversation-only branch', async () => {
    const f = await boot({ adapter: new MockAdapter([toolCall('write', JSON.stringify({ file_path: 'file.txt', content: 'generated' })), text('done')]) })
    await f.handle.harness.run('task')
    const session = await f.handle.harness.ctx.sessions.open(f.handle.harness.main().sessionId), user = session.events.find(record => record.type === 'user/message')!
    const route = '/api/sessions/' + session.id + '/history/'
    const old = await (await f.post(route + 'preview', { turnSeq: user.seq })).json() as { contextRevision: number; fingerprint: string }
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'MANUAL_KEEP')
    expect((await f.post(route + 'rewind', { ...old, turnSeq: user.seq, confirmed: true, mode: 'both' })).status).toBe(409)
    const fresh = await (await f.post(route + 'preview', { turnSeq: user.seq })).json() as { contextRevision: number; fingerprint: string; checkpoint: { files: Array<{ conflict: string }> } }
    expect(fresh.checkpoint.files[0]!.conflict).toContain('手动修改')
    expect((await f.post(route + 'rewind', { ...fresh, turnSeq: user.seq, confirmed: true, mode: 'both' })).status).toBe(409)
    expect((await f.post(route + 'rewind', { ...fresh, turnSeq: user.seq, confirmed: true, mode: 'conversation' })).status).toBe(200)
    expect(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8')).toBe('MANUAL_KEEP')
  })

  it('holds one gate across disk work and rejects competing messages, history actions, settings and deletes', async () => {
    const f = await boot(), s = await seed(f), entered = barrier(), finish = barrier()
    const append = fs.appendFile.bind(fs)
    const pause = vi.spyOn(fs, 'appendFile').mockImplementation(async (file, ...args) => {
      if (String(file).endsWith('session.jsonl') && !String(file).startsWith(s.session.dir)) { entered.release(); await finish.promise }
      return append(file, ...args)
    })
    const mutation = f.post('/api/sessions/' + s.session.id + '/history/rewind', s.body)
    try {
      await entered.promise
      for (const route of ['/api/message', '/api/sessions', '/api/settings', '/api/context/clear', '/api/sessions/' + s.session.id + '/history/preview']) {
        expect((await f.post(route, { ...s.body, text: 'MUST_NOT_SEND' })).status).toBe(409)
      }
      expect((await fetch(f.base + '/api/sessions/' + s.session.id, { method: 'DELETE' })).status).toBe(409)
      await expect(s.session.append({ type: 'user/message', payload: { content: 'LATE' } })).rejects.toMatchObject({ code: 'EBUSY' })
    } finally { finish.release(); pause.mockRestore() }
    expect((await mutation).status).toBe(200)
    expect(JSON.stringify(s.session.events)).not.toContain('MUST_NOT_SEND')
  })

  it('refuses running agents, queued turns, compaction, archived sessions and viewer credentials', async () => {
    const operator = 'history-operator-' + 'a'.repeat(40), viewer = 'history-viewer-' + 'b'.repeat(40)
    const f = await boot({ token: operator, viewerToken: viewer })
    const auth = { authorization: 'Bearer ' + operator }
    await f.handle.harness.run('original')
    const session = await f.handle.harness.ctx.sessions.open(f.handle.harness.main().sessionId), user = session.events.find(record => record.type === 'user/message')!, route = '/api/sessions/' + session.id + '/history/preview'
    expect((await f.post(route, { turnSeq: user.seq }, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    const compact = f.handle.harness.ctx.get<CompactionService>('compaction'), spy = vi.spyOn(compact, 'isCompacting').mockReturnValue(true)
    expect((await f.post(route, { turnSeq: user.seq }, auth)).status).toBe(409); spy.mockRestore()
    await f.handle.harness.ctx.sessions.setArchived(session.id, true)
    expect((await f.post(route, { turnSeq: user.seq }, auth)).status).toBe(409)
    await f.handle.harness.ctx.sessions.setArchived(session.id, false)
    const started = barrier(), done = barrier()
    const loop = f.handle.harness.ctx.agentLoop, run = loop.run.bind(loop)
    vi.spyOn(loop, 'run').mockImplementation(async (...args) => { started.release(); await done.promise; return run(...args) })
    const turn = f.handle.harness.main().turn('running')
    try { await started.promise; expect((await f.post(route, { turnSeq: user.seq }, auth)).status).toBe(409) }
    finally { done.release(); await turn }
  })

  it('does not publish a branch when a prefix log write fails and allows retry with the unchanged preview', async () => {
    const f = await boot(), s = await seed(f)
    const append = fs.appendFile.bind(fs)
    const fail = vi.spyOn(fs, 'appendFile').mockImplementation(async (file, ...args) => {
      if (String(file).endsWith('session.jsonl') && !String(file).startsWith(s.session.dir) && String(args[0]).includes('user/message')) throw new Error('branch disk full')
      return append(file, ...args)
    })
    const response = await f.post('/api/sessions/' + s.session.id + '/history/rewind', s.body)
    expect(response.status).toBe(500); fail.mockRestore()
    expect(f.handle.harness.main().sessionId).toBe(s.session.id)
    expect((await f.handle.harness.ctx.sessions.list())).toHaveLength(1)
    expect((await f.post('/api/sessions/' + s.session.id + '/history/rewind', s.body)).status).toBe(200)
  })

  it('copies an edited image/text attachment and does not send it to unrelated retained collaborators', async () => {
    const f = await boot(), main = f.handle.harness.main()
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/1ioAAAAASUVORK5CYII='
    expect((await f.post('/api/message', { text: 'with files', files: [{ name: 'one.png', dataUrl: 'data:image/png;base64,' + png },
      { name: 'note.txt', dataUrl: 'data:text/plain;base64,' + Buffer.from('FILE_CONTENT').toString('base64') }] })).status).toBe(202)
    await main.wait()
    const session = await f.handle.harness.ctx.sessions.open(main.sessionId), user = session.events.find(record => record.type === 'user/message')!
    const route = '/api/sessions/' + session.id + '/history/', preview = await (await f.post(route + 'preview', { turnSeq: user.seq })).json() as { contextRevision: number; fingerprint: string }
    const response = await f.post(route + 'edit', { ...preview, turnSeq: user.seq, text: 'edited files', confirmed: true, mode: 'conversation' })
    const result = await response.json() as { sessionId: string }; expect(response.status).toBe(200)
    const branch = await f.handle.harness.ctx.sessions.open(result.sessionId), edited = branch.events.find(record => record.type === 'user/message')!
    if (edited.type !== 'user/message') throw new Error('missing user')
    expect(edited.payload.attachments).toHaveLength(2); expect(edited.payload.images).toHaveLength(1)
    expect(edited.payload.content).toContain('FILE_CONTENT')
    expect((await f.post('/api/conversation/generate', { sessionId: branch.id })).status).toBe(202)
    await f.handle.harness.main().wait()
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(1)
    const records = await (await fetch(f.base + '/api/sessions/' + session.id + '/records')).json() as { records: SessionEventRecord[] }
    expect(records.records).toEqual(session.events)
  })
})