import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BackupService } from '../src/backup/service.js'
import { decodeBackup, encodeBackup } from '../src/backup/format.js'
import { SessionService } from '../src/core/session.js'
import { storeChatFiles } from '../src/core/attachments.js'
import { KnowledgeStore } from '../src/knowledge/index.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { TaskStore } from '../src/tasks/store.js'

const roots: string[] = []
afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 4 }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-backup-')); roots.push(root)
  const cwd = path.join(root, 'workspace'), sessionRoot = path.join(root, 'custom-sessions')
  await fs.mkdir(cwd); await fs.mkdir(sessionRoot)
  const sessions = new SessionService(sessionRoot), backup = new BackupService(cwd, sessions)
  return { root, cwd, sessions, backup }
}
const card = { title: 'Backup task', description: '', status: 'completed', priority: 'medium', steps: [], criteria: ['review'], checkIds: [], archived: false }

describe('allowlisted workspace backup and new-directory restore', () => {
  it('round-trips custom-root sessions and attachments while omitting credentials and executable configuration', async () => {
    const f = await fixture(), session = await f.sessions.create({ title: 'portable history' })
    const files = await storeChatFiles(session.dir, [{ name: 'note.txt', mimeType: 'text/plain', bytes: Buffer.from('attachment exact bytes') }])
    await session.append({ type: 'user/message', payload: { content: 'User original' + files.context, attachments: files.attachments } })
    await fs.writeFile(path.join(f.cwd, 'sakura.yml'), 'apiKey: SECRET_MUST_NOT_BACKUP')
    await fs.mkdir(path.join(f.cwd, '.sakura'))
    await fs.writeFile(path.join(f.cwd, '.sakura', 'connectors.json'), 'SECRET_CONNECTOR_MUST_NOT_BACKUP')
    const preview = await f.backup.previewBackup({ sessionIds: [session.id] })
    const bytes = await f.backup.download(preview.id, preview.fingerprint), archive = await decodeBackup(bytes)
    expect(JSON.stringify(archive)).not.toContain('SECRET_MUST_NOT_BACKUP')
    expect(archive.entries.every(e => e.path.startsWith('sessions/'))).toBe(true)
    const restore = await f.backup.previewRestore(bytes)
    const result = await f.backup.restore(restore.id, restore.fingerprint, f.root, 'restored')
    const restored = await new SessionService(path.join(result.directory, '.sakura', 'sessions')).open(session.id)
    const record = restored.events.find(r => r.type === 'user/message')!
    if (record.type !== 'user/message') throw Error('missing user event')
    expect(record.payload.content).toContain('User original')
    expect(record.payload.content).toContain('<file>\nattachment exact bytes\n</file>')
    expect(record.payload.content).not.toContain(JSON.stringify(files.attachments[0]!))
    expect(record.payload.content).toContain(JSON.stringify(record.payload.attachments![0]!))
    expect(record.payload.attachments![0]!.path).toContain(result.directory)
    expect(await fs.readFile(record.payload.attachments![0]!.path, 'utf8')).toBe('attachment exact bytes')
    await expect(fs.stat(path.join(result.directory, 'sakura.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(files.attachments[0]!.path, 'utf8')).toBe('attachment exact bytes')
  })

  it('restores immutable knowledge history and disables automatic memory processing', async () => {
    const f = await fixture(), knowledge = new KnowledgeStore(f.cwd)
    const imported = await knowledge.importFiles({ files: [{ path: 'guide.md', content: 'old text' }] })
    const managed = await knowledge.adoptLegacy(imported.documents[0]!.id.split('/')[0]!, await knowledge.getVersionState())
    const proposal = await knowledge.previewUpdate({ collectionId: managed.collectionId, files: [{ path: 'guide.md', content: 'new text' }] }, managed)
    await knowledge.commitUpdate(proposal.previewId, proposal.expected)
    const memory = new WorkspaceMemoryStore(f.cwd), original = await memory.reload()
    await memory.update({ content: 'durable notes' }, original.revision)
    const tasks = new TaskStore(f.cwd); await tasks.upsert(card, await tasks.snapshot())
    const preview = await f.backup.previewBackup({ knowledge: true, memory: true, tasks: true })
    const bytes = await f.backup.download(preview.id, preview.fingerprint), restore = await f.backup.previewRestore(bytes)
    const result = await f.backup.restore(restore.id, restore.fingerprint, f.root, 'restored')
    const restoredKnowledge = new KnowledgeStore(result.directory)
    expect((await restoredKnowledge.getVersionState()).collections[0]!.versions).toHaveLength(2)
    expect((await restoredKnowledge.read(imported.documents[0]!.id)).content).toBe('old text')
    expect((await restoredKnowledge.search('new')).results).toHaveLength(1)
    const restoredMemory = await new WorkspaceMemoryStore(result.directory).reload()
    expect(restoredMemory).toMatchObject({ content: 'durable notes', enabled: false, processing: { auto: false } })
    expect((await new TaskStore(result.directory).snapshot()).tasks[0]!.title).toBe('Backup task')
  })

  it('includes task session dependencies without scanning unrelated sessions', async () => {
    const f = await fixture(), session = await f.sessions.create(), unrelated = await f.sessions.create()
    const tasks = new TaskStore(f.cwd)
    await tasks.upsert({ ...card, sessionId: session.id }, await tasks.snapshot())
    const preview = await f.backup.previewBackup({ tasks: true })
    expect(preview.sessionIds).toEqual([session.id]); expect(preview.sessionIds).not.toContain(unrelated.id)
    expect(preview.warnings.some(w => w.includes('Related sessions'))).toBe(true)
  })

  it('rejects changed source after preview and never overwrites an existing restore target', async () => {
    const f = await fixture(), session = await f.sessions.create()
    const preview = await f.backup.previewBackup({ sessionIds: [session.id] })
    await session.append({ type: 'user/message', payload: { content: 'new update' } })
    await expect(f.backup.download(preview.id, preview.fingerprint)).rejects.toMatchObject({ status: 409 })
    const next = await f.backup.previewBackup({ sessionIds: [session.id] }), bytes = await f.backup.download(next.id, next.fingerprint)
    const restore = await f.backup.previewRestore(bytes)
    await fs.mkdir(path.join(f.root, 'existing')); await fs.writeFile(path.join(f.root, 'existing', 'keep.txt'), 'keep')
    await expect(f.backup.restore(restore.id, restore.fingerprint, f.root, 'existing')).rejects.toMatchObject({ status: 409 })
    expect(await fs.readFile(path.join(f.root, 'existing', 'keep.txt'), 'utf8')).toBe('keep')
  })

  it('rejects tampering, duplicate paths and unapproved executable paths', async () => {
    const f = await fixture(), session = await f.sessions.create(), preview = await f.backup.previewBackup({ sessionIds: [session.id] })
    const bytes = await f.backup.download(preview.id, preview.fingerprint), manifest = await decodeBackup(bytes)
    const tampered = structuredClone(manifest); tampered.entries[0]!.sha256 = '0'.repeat(64)
    await expect(encodeBackup(tampered)).rejects.toThrow('checksum')
    await expect(encodeBackup({ ...manifest, entries: [...manifest.entries, manifest.entries[0]!] })).rejects.toThrow('duplicate')
    for (const name of ['../escape', 'sessions/x/../../code', '.git/config', 'sakura.yml']) {
      const changed = structuredClone(manifest); changed.entries[0]!.path = name
      await expect(encodeBackup(changed)).rejects.toThrow()
    }
  })

  it('rejects linked sources and cancelled restore before publishing', async () => {
    const f = await fixture(), session = await f.sessions.create()
    const preview = await f.backup.previewBackup({ sessionIds: [session.id] }), bytes = await f.backup.download(preview.id, preview.fingerprint)
    const restoring = await f.backup.previewRestore(bytes)
    await expect(f.backup.restore(restoring.id, restoring.fingerprint, f.root, 'cancelled', () => { throw Error('cancelled') })).rejects.toThrow('cancelled')
    await expect(fs.stat(path.join(f.root, 'cancelled'))).rejects.toMatchObject({ code: 'ENOENT' })
    const target = path.join(f.root, 'outside'); await fs.mkdir(target)
    await fs.symlink(target, path.join(f.cwd, '.sakura'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(f.backup.previewBackup({ memory: true })).rejects.toThrow()
  })
})
