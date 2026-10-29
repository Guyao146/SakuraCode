/** Real preimages, independent branches, and deterministic disk/race failures. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckpointService } from '../src/core/checkpoints.js'
import { ConversationHistoryService } from '../src/core/conversation-history.js'
import { SessionService } from '../src/core/session.js'
import type { ToolContext } from '../src/core/types.js'
import { tmpHarness, text, toolCall } from './helpers.js'

afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const f = await tmpHarness({ config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
  const session = await f.ctx.sessions.create()
  const user = await session.append({ type: 'user/message', payload: { content: 'original task' } })
  const tc: ToolContext = { sessionId: session.id, agentId: 'fixture', signal: new AbortController().signal,
    checkpoint: { sessionId: session.id, turnSeq: user.seq } }
  const history = new ConversationHistoryService(f.ctx.sessions, f.ctx.checkpoints)
  return { ...f, session, user, tc, history, checkpoints: f.ctx.checkpoints! }
}
const request = (preview: Awaited<ReturnType<ConversationHistoryService['preview']>>, mode: 'conversation' | 'code' | 'both' = 'both') => ({
  sessionId: preview.sessionId, turnSeq: preview.turnSeq, contextRevision: preview.contextRevision, fingerprint: preview.fingerprint, mode,
})

describe('conversation branches and checkpoints', () => {
  it('tracks native writes across real turns, preserves bytes/modes, and persists across restart', async () => {
    const f = await fixture(), file = path.join(f.tmpDir, '中文 source.txt')
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a, 0x62])
    await fs.writeFile(file, original)
    await f.checkpoints.write(file, Buffer.from('after-one'), f.tc)
    const second = await f.session.append({ type: 'user/message', payload: { content: 'second task' } })
    await f.checkpoints.write(file, Buffer.from('after-two'), { ...f.tc, checkpoint: { sessionId: f.session.id, turnSeq: second.seq } })
    const sessions = new SessionService(f.ctx.sessions.root), fresh = new CheckpointService(sessions, f.tmpDir)
    const plan = await fresh.plan(f.session.id, f.user.seq)
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]).toMatchObject({ file: '中文 source.txt', conflict: null })
    expect(JSON.stringify(plan)).not.toContain('after-two')
    await fresh.locked(() => fresh.restore(plan, () => {}))
    expect(await fs.readFile(file)).toEqual(original)
    expect((await fresh.plan(f.session.id, f.user.seq)).files).toEqual([])
  })

  it('rewinds only the discarded suffix, deletes newly created files, and never rewrites the original log', async () => {
    const f = await fixture(), kept = path.join(f.tmpDir, 'kept.txt'), newer = path.join(f.tmpDir, 'nested', 'new.txt')
    await f.checkpoints.write(kept, Buffer.from('first round'), f.tc)
    await f.session.append({ type: 'assistant/message', payload: { role: 'assistant', content: 'old answer', stream: { text: 'old answer', toolCalls: [], durationMs: 1 } } })
    const target = await f.session.append({ type: 'user/message', payload: { content: 'discard this' } })
    await f.checkpoints.write(newer, Buffer.from('newer'), { ...f.tc, checkpoint: { sessionId: f.session.id, turnSeq: target.seq } })
    await f.session.append({ type: 'assistant/message', payload: { role: 'assistant', content: 'discard answer', stream: { text: '', toolCalls: [], durationMs: 1 } } })
    const log = await fs.readFile(f.session.file)
    const preview = await f.history.preview(f.session.id, target.seq)
    const result = await f.history.rewind(request(preview), () => {})
    expect(result.restoredFiles).toBe(1)
    expect(result.session.id).not.toBe(f.session.id)
    expect(result.session.deriveMessages()).toEqual([{ role: 'user', content: 'original task' }, { role: 'assistant', content: 'old answer' }])
    expect(await fs.readFile(f.session.file)).toEqual(log)
    expect(await fs.readFile(kept, 'utf8')).toBe('first round')
    await expect(fs.access(newer)).rejects.toMatchObject({ code: 'ENOENT' })
    await f.ctx.sessions.delete(f.session.id)
    const independent = await f.checkpoints.plan(result.session.id, result.session.events.find(record => record.type === 'user/message')!.seq)
    expect(independent.files[0]).toMatchObject({ file: 'kept.txt', conflict: null })
    await f.checkpoints.locked(() => f.checkpoints.restore(independent, () => {}))
    await expect(fs.access(kept)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('allows conversation-only edits without touching conflicts, and preserves original attachments independently', async () => {
    const f = await tmpHarness({ config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    const original = f.harness.main()
    await original.turn('model-expanded task', { originalText: '@chosen user text', files: [{ name: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('ATTACHMENT_SENTINEL') }] })
    const source = await f.ctx.sessions.open(original.sessionId), user = source.events.find(record => record.type === 'user/message')!
    const history = new ConversationHistoryService(f.ctx.sessions, f.ctx.checkpoints)
    const preview = await history.preview(source.id, user.seq)
    expect(preview.text).toBe('@chosen user text')
    const branch = (await history.rewind({ ...request(preview, 'conversation'), edit: { originalText: 'edited', task: 'expanded edited' } }, () => {})).session
    const edited = branch.events.find(record => record.type === 'user/message')!
    if (edited.type !== 'user/message' || user.type !== 'user/message') throw new Error('missing user')
    expect(edited.payload.originalText).toBe('edited')
    expect(edited.payload.content).toContain('ATTACHMENT_SENTINEL')
    expect(edited.payload.attachments![0]!.path).not.toBe(user.payload.attachments![0]!.path)
    await f.ctx.sessions.delete(source.id)
    expect(await fs.readFile(edited.payload.attachments![0]!.path, 'utf8')).toBe('ATTACHMENT_SENTINEL')
    f.harness.main({ resumeSessionId: branch.id })
    await branch.append({ type: 'session/note', payload: { note: 'generation-start', userSeq: edited.seq } })
    expect(await f.harness.main().turn(edited.payload.content, { resumeUserSeq: edited.seq })).toMatchObject({ output: 'ok' })
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(1)
    expect(await f.harness.main().turn('duplicate', { resumeUserSeq: edited.seq })).toMatchObject({ error: expect.stringContaining('未重复生成') })
  })

  it('never overwrites manual changes and requires a fresh preview even for conversation-only operations', async () => {
    const f = await fixture(), file = path.join(f.tmpDir, 'source.txt')
    await fs.writeFile(file, 'before')
    await f.checkpoints.write(file, Buffer.from('agent'), f.tc)
    const old = await f.history.preview(f.session.id, f.user.seq)
    await fs.writeFile(file, 'manual draft')
    await expect(f.history.rewind(request(old), () => {})).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(f.history.rewind(request(old, 'conversation'), () => {})).rejects.toMatchObject({ code: 'EBUSY' })
    const conflict = await f.history.preview(f.session.id, f.user.seq)
    expect(conflict.checkpoint!.files[0]!.conflict).toContain('手动修改')
    await expect(f.history.rewind(request(conflict), () => {})).rejects.toMatchObject({ code: 'EBUSY' })
    const branch = await f.history.rewind(request(conflict, 'conversation'), () => {})
    expect(branch.restoredFiles).toBe(0)
    expect(await fs.readFile(file, 'utf8')).toBe('manual draft')
    expect(branch.session.deriveMessages()).toEqual([])
  })

  it('rejects modified attachments without leaving a published branch', async () => {
    const f = await tmpHarness()
    await f.harness.main().turn('with attachment', { files: [{ name: 'original.txt', mimeType: 'text/plain', bytes: Buffer.from('original') }] })
    const session = await f.ctx.sessions.open(f.harness.main().sessionId), user = session.events.find(record => record.type === 'user/message')!
    if (user.type !== 'user/message') throw new Error('missing user')
    await fs.writeFile(user.payload.attachments![0]!.path, 'tampered')
    const history = new ConversationHistoryService(f.ctx.sessions, f.ctx.checkpoints), preview = await history.preview(session.id, user.seq)
    await expect(history.rewind({ ...request(preview, 'conversation'), edit: { task: 'edit', originalText: 'edit' } }, () => {})).rejects.toThrow()
    expect((await f.ctx.sessions.list()).map(row => row.id)).toEqual([session.id])
    expect(session.events.some(record => record.type === 'user/message' && record.payload.content.startsWith('with attachment'))).toBe(true)
  })

  it('preflights corrupt blobs and torn journals, leaving code and original conversation intact', async () => {
    const f = await fixture(), file = path.join(f.tmpDir, 'file.txt')
    await fs.writeFile(file, 'before')
    await f.checkpoints.write(file, Buffer.from('after'), f.tc)
    const plan = await f.checkpoints.plan(f.session.id, f.user.seq)
    await fs.writeFile(path.join(f.session.dir, 'checkpoints', plan.files[0]!.before!.sha256 + '.bin'), 'corrupt')
    const preview = await f.history.preview(f.session.id, f.user.seq)
    expect(preview.checkpoint!.files[0]!.conflict).toContain('快照')
    await expect(f.history.rewind(request(preview), () => {})).rejects.toMatchObject({ code: 'EBUSY' })
    await fs.appendFile(path.join(f.session.dir, 'checkpoints.jsonl'), '{torn')
    const torn = await f.history.preview(f.session.id, f.user.seq)
    expect(torn.checkpoint).toBeNull()
    expect((await f.history.rewind(request(torn, 'conversation'), () => {})).restoredFiles).toBe(0)
    expect(await fs.readFile(file, 'utf8')).toBe('after')
  })

  it('does not restore external files, internal metadata, links or oversized writes', async () => {
    const f = await fixture()
    const other = path.join(f.tmpDir, 'external'), linked = path.join(f.tmpDir, 'linked')
    await fs.mkdir(other); await fs.symlink(other, linked, 'junction')
    await f.checkpoints.write(path.join(linked, 'file.txt'), Buffer.from('outside link'), f.tc)
    await f.checkpoints.write(path.join(f.tmpDir, '.git', 'config'), Buffer.from('metadata'), f.tc)
    await f.checkpoints.write(path.join(f.tmpDir, 'large.bin'), Buffer.alloc(8 * 1024 * 1024 + 1), f.tc)
    const preview = await f.history.preview(f.session.id, f.user.seq)
    expect(preview.checkpoint!.files).toEqual([])
    expect(preview.checkpoint!.untracked).toHaveLength(3)
    await f.history.rewind(request(preview, 'conversation'), () => {})
    expect(await fs.readFile(path.join(other, 'file.txt'), 'utf8')).toBe('outside link')
    expect(await fs.readFile(path.join(f.tmpDir, '.git', 'config'), 'utf8')).toBe('metadata')
  })

  it('blocks native writes on snapshot failure, compensates failed multi-file restore, and discards unpublished branches', async () => {
    const f = await fixture(), a = path.join(f.tmpDir, 'a.txt'), b = path.join(f.tmpDir, 'b.txt')
    await fs.writeFile(a, 'a-before'); await fs.writeFile(b, 'b-before')
    const append = fs.appendFile.bind(fs)
    const failJournal = vi.spyOn(fs, 'appendFile').mockImplementation(async (file, ...args) => {
      if (String(file).endsWith('checkpoints.jsonl')) throw new Error('snapshot disk full')
      return append(file, ...args)
    })
    await expect(f.checkpoints.write(a, Buffer.from('a-after'), f.tc)).rejects.toThrow('snapshot disk full')
    expect(await fs.readFile(a, 'utf8')).toBe('a-before'); failJournal.mockRestore()
    await f.checkpoints.write(a, Buffer.from('a-after'), f.tc); await f.checkpoints.write(b, Buffer.from('b-after'), f.tc)
    const preview = await f.history.preview(f.session.id, f.user.seq), log = await fs.readFile(f.session.file)
    const rename = fs.rename.bind(fs)
    const failSecond = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === b) throw new Error('synthetic second file denied')
      return rename(from, to)
    })
    await expect(f.history.rewind(request(preview), () => {})).rejects.toThrow('synthetic second file denied')
    failSecond.mockRestore()
    expect(await fs.readFile(a, 'utf8')).toBe('a-after'); expect(await fs.readFile(b, 'utf8')).toBe('b-after')
    expect(await fs.readFile(f.session.file)).toEqual(log)
    expect((await f.ctx.sessions.list()).map(row => row.id)).toEqual([f.session.id])
    expect((await f.checkpoints.plan(f.session.id, f.user.seq)).files).toHaveLength(2)
  })

  it('detects edits between native tool changes and rejects paths replaced with a junction', async () => {
    const f = await fixture(), dir = path.join(f.tmpDir, 'src'), moved = path.join(f.tmpDir, 'moved')
    await fs.mkdir(dir); const file = path.join(dir, 'x.txt')
    await fs.writeFile(file, 'initial'); await f.checkpoints.write(file, Buffer.from('first'), f.tc)
    await fs.writeFile(file, 'manual intermediate'); await f.checkpoints.write(file, Buffer.from('second'), f.tc)
    expect((await f.checkpoints.plan(f.session.id, f.user.seq)).files[0]!.conflict).toContain('额外改动')
    await fs.rename(dir, moved); await fs.symlink(moved, dir, 'junction')
    expect((await f.checkpoints.plan(f.session.id, f.user.seq)).files[0]!.conflict).toContain('链接')
    expect(await fs.readFile(path.join(moved, 'x.txt'), 'utf8')).toBe('second')
  })

  it('supports real write/edit turns and child-delegated writes on the parent checkpoint', async () => {
    const f = await tmpHarness({ steps: [toolCall('write', JSON.stringify({ file_path: 'created.txt', content: 'alpha' })), text('done'),
      toolCall('edit', JSON.stringify({ file_path: 'created.txt', old_string: 'alpha', new_string: 'beta' })), text('done')],
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    await f.harness.run('create file'); await f.harness.run('edit file')
    expect(await fs.readFile(path.join(f.tmpDir, 'created.txt'), 'utf8')).toBe('beta')
    const source = await f.ctx.sessions.open(f.harness.main().sessionId), user = source.events.find(record => record.type === 'user/message')!
    expect((await f.ctx.checkpoints!.plan(source.id, user.seq)).files).toHaveLength(1)
    const child = f.ctx.agents.spawn({ seed: '', autoStart: false, persistentSession: true,
      meta: { role: 'sub', parentSession: source.id, checkpoint: { sessionId: source.id, turnSeq: user.seq } } })
    await child.turn('child final text')
    const tc: ToolContext = { agentId: child.id, sessionId: child.sessionId, signal: new AbortController().signal,
      checkpoint: { sessionId: source.id, turnSeq: user.seq } }
    await f.ctx.checkpoints!.write(path.join(f.tmpDir, 'child.txt'), Buffer.from('child edit'), tc)
    expect((await f.ctx.checkpoints!.plan(source.id, user.seq)).files.map(row => row.file)).toEqual(['created.txt', 'child.txt'])
  })

  it('refuses shared-session checkpoints from a different workspace even when the current file has identical bytes', async () => {
    const f = await fixture(), first = path.join(f.tmpDir, 'source.txt')
    await fs.writeFile(first, 'initial'); await f.checkpoints.write(first, Buffer.from('generated'), f.tc)
    const other = path.join(f.tmpDir, 'other-workspace'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'source.txt'), 'generated')
    const foreign = new CheckpointService(f.ctx.sessions, other)
    const plan = await foreign.plan(f.session.id, f.user.seq)
    expect(plan.files[0]!.conflict).toContain('其他工作区')
    await expect(foreign.locked(() => foreign.restore(plan, () => {}))).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(await fs.readFile(path.join(other, 'source.txt'), 'utf8')).toBe('generated')
  })

  it('honors plugin turn vetoes on edited regeneration and does not append a duplicate user message', async () => {
    const f = await fixture(), preview = await f.history.preview(f.session.id, f.user.seq)
    const branch = (await f.history.rewind({ ...request(preview, 'conversation'), edit: { originalText: 'edit', task: 'edit' } }, () => {})).session
    const user = branch.events.at(-1)!
    await branch.append({ type: 'session/note', payload: { note: 'generation-start', userSeq: user.seq } })
    f.harness.main({ resumeSessionId: branch.id })
    const guard = vi.fn(() => { throw new Error('PLUGIN_VETO') })
    f.ctx.on('turn/start', guard)
    expect(await f.harness.main().turn('edit', { resumeUserSeq: user.seq })).toMatchObject({ steps: 0, output: 'turn rejected: PLUGIN_VETO' })
    expect(guard).toHaveBeenCalledOnce()
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(1)
  })

  it('cleans up failed initial branch metadata without returning a usable cached handle', async () => {
    const f = await fixture(), preview = await f.history.preview(f.session.id, f.user.seq), append = fs.appendFile.bind(fs)
    const failure = vi.spyOn(fs, 'appendFile').mockImplementation(async (file, ...args) => {
      if (String(file).endsWith('session.jsonl') && !String(file).startsWith(f.session.dir)) throw new Error('FIRST_BRANCH_WRITE_FAILED')
      return append(file, ...args)
    })
    await expect(f.history.rewind(request(preview, 'conversation'), () => {})).rejects.toThrow('FIRST_BRANCH_WRITE_FAILED')
    failure.mockRestore()
    expect((await fs.readdir(f.ctx.sessions.root))).toEqual([f.session.id])
    expect((await f.ctx.sessions.list()).map(row => row.id)).toEqual([f.session.id])
    expect((await f.history.rewind(request(preview, 'conversation'), () => {})).session.id).not.toBe(f.session.id)
  })

  it('attributes child follow-up writes to each new parent turn, while direct child tasks stay independent', async () => {
    const f = await tmpHarness({ steps: [toolCall('write', JSON.stringify({ file_path: 'delegated-one.txt', content: 'one' })), text('done'),
      toolCall('write', JSON.stringify({ file_path: 'delegated-two.txt', content: 'two' })), text('done'),
      toolCall('write', JSON.stringify({ file_path: 'independent.txt', content: 'own task' })), text('done')] })
    const source = await f.ctx.sessions.create(), first = await source.append({ type: 'user/message', payload: { content: 'parent one' } })
    const child = f.ctx.agents.spawn({ seed: '', autoStart: false, persistentSession: true,
      meta: { role: 'sub', checkpoint: { sessionId: source.id, turnSeq: first.seq } } })
    const tc: ToolContext = { agentId: 'parent', sessionId: source.id, signal: new AbortController().signal,
      checkpoint: { sessionId: source.id, turnSeq: first.seq } }
    const send = (context: ToolContext, message: string) => f.ctx.tools.execute('send-' + message, 'send_message',
      JSON.stringify({ agent_id: child.id, message, wait: true }), context)
    expect((await send(tc, 'one')).isError).toBeFalsy()
    const second = await source.append({ type: 'user/message', payload: { content: 'parent two' } })
    expect((await send({ ...tc, checkpoint: { sessionId: source.id, turnSeq: second.seq } }, 'two')).isError).toBeFalsy()
    await child.turn('independent task')
    expect((await f.ctx.checkpoints!.plan(source.id, second.seq)).files.map(row => row.file)).toEqual(['delegated-two.txt'])
    expect((await f.ctx.checkpoints!.plan(source.id, first.seq)).files.map(row => row.file)).toEqual(['delegated-one.txt', 'delegated-two.txt'])
    expect((await f.ctx.checkpoints!.plan(child.sessionId, 1)).files.map(row => row.file)).toEqual(['independent.txt'])
  })
})