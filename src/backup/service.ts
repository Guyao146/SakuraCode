/** Snapshot explicit local data, preview restores, then publish only to a new directory. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { SessionService } from '../core/session.js'
import { isSessionId } from '../core/session.js'
import { KnowledgeStore } from '../knowledge/index.js'
import { restoredTaskState, validateTaskBackup } from '../tasks/store.js'
import { restoredMemory } from '../plugins/workspace-memory.js'
import { DocumentStore } from '../documents/store.js'
import { validateDocumentSnapshot } from '../documents/validate.js'
import { BACKUP_LIMITS, BackupError, type BackupManifest, type BackupPreview, type BackupSelection, type BackupEntry, type BackupComponent } from './types.js'
import { encodeBackup, decodeBackup, validateManifest } from './format.js'
import { digest, directory, entry, missing, pathKey, portable, regular } from './safety.js'
import { records, encodeRecords, mapSession, sessionDependencies, attachmentPath, BACKUP_ATTACHMENT } from './sessions.js'

interface Capture { manifest: BackupManifest; fingerprint: string; selected: BackupSelection }
interface Ticket { preview: BackupPreview; capture?: Capture; bytes?: Buffer }
const copy = <T>(value: T): T => structuredClone(value)
const checkId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
export class BackupService {
  private readonly tickets = new Map<string, Ticket>()
  private busy = false
  private closed = false
  constructor(readonly cwd: string, private sessions: SessionService) {}
  isBusy(): boolean { return this.busy }
  close(): void { this.closed = true; this.tickets.clear() }
  private check(current: () => void) { if (this.closed) throw new BackupError(409, 'backup service closed'); current() }
  private async exclusive<T>(action: () => Promise<T>, current: () => void): Promise<T> {
    this.check(current)
    if (this.busy) throw new BackupError(409, 'another backup operation is active')
    this.busy = true
    try { return await action() }
    finally { this.busy = false }
  }
  private expire(): void { for (const [id, ticket] of this.tickets) if (ticket.preview.expiresAt < Date.now()) this.tickets.delete(id) }
  private remember(manifest: BackupManifest, fingerprint: string, rest: Omit<Ticket, 'preview'>): BackupPreview {
    this.expire()
    if (this.tickets.size >= BACKUP_LIMITS.previews) throw new BackupError(409, 'close earlier backup previews before opening another')
    const preview: BackupPreview = { id: randomUUID(), fingerprint, expiresAt: Date.now() + BACKUP_LIMITS.previewMs, createdAt: manifest.createdAt,
      components: manifest.components, sessionIds: manifest.sessionIds, files: manifest.entries.length, bytes: manifest.entries.reduce((n, e) => n + e.bytes, 0), warnings: manifest.warnings }
    this.tickets.set(preview.id, { preview, ...rest }); return copy(preview)
  }
  private consume(id: string, fingerprint: string): Ticket {
    this.expire()
    const ticket = this.tickets.get(id)
    if (!checkId(id) || !ticket || ticket.preview.fingerprint !== fingerprint) throw new BackupError(409, 'backup preview expired or changed; create a new preview')
    this.tickets.delete(id); return ticket
  }
  cancel(id: string): { cancelled: boolean } { return { cancelled: this.tickets.delete(id) } }
  async catalog(current: () => void = () => {}) {
    this.check(current)
    const sessions = await this.sessions.list({ archived: 'all' }); this.check(current)
    return { sessions: sessions.map(({ id, title, archived }) => ({ id, title, archived: !!archived })), limits: BACKUP_LIMITS }
  }
  private selection(value: BackupSelection): BackupSelection {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['sessionIds', 'memory', 'knowledge', 'tasks'].includes(key))) throw new BackupError(400, 'invalid backup selection')
    if (value.sessionIds !== undefined && (!Array.isArray(value.sessionIds) || value.sessionIds.length > BACKUP_LIMITS.sessions || value.sessionIds.some(id => !isSessionId(id)))) throw new BackupError(400, 'invalid selected sessions')
    for (const key of ['memory', 'knowledge', 'tasks'] as const) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new BackupError(400, 'invalid selected component')
    return { sessionIds: [...new Set(value.sessionIds ?? [])], memory: !!value.memory, knowledge: !!value.knowledge, tasks: !!value.tasks }
  }
  private async capture(value: BackupSelection, current: () => void): Promise<Capture> {
    const selected = this.selection(value), entries: BackupEntry[] = [], sources: Array<{ file: string; hash: string }> = [], components = new Set<BackupComponent>(), warnings: string[] = []
    const check = () => this.check(current)
    const absent: string[] = []
    let knowledgeInventory: string | undefined
    let total = 0
    const addBytes = (target: string, bytes: Buffer) => {
      if (entries.some(item => item.path === target)) return
      if (++total > BACKUP_LIMITS.files || entries.reduce((n, e) => n + e.bytes, 0) + bytes.length > BACKUP_LIMITS.decodedBytes) throw new BackupError(413, 'selected backup exceeds its file or byte budget')
      entries.push(entry(target, bytes))
    }
    const read = async (file: string) => { const bytes = await regular(file, check); sources.push({ file, hash: digest(bytes) }); return bytes }
    const optional = async (relative: string, target: string) => {
      try { const bytes = await read(path.join(this.cwd, '.sakura', relative)); addBytes(target, bytes); return bytes }
      catch (error) { if (missing(error)) { absent.push(path.join(this.cwd, '.sakura', relative)); return undefined }; throw error }
    }
    const requiredSessions = new Set(selected.sessionIds)
    if (selected.tasks) {
      components.add('tasks')
      const bytes = await optional('tasks/state.json', 'tasks/state.json')
      if (bytes) {
        const state = validateTaskBackup(JSON.parse(bytes.toString('utf8')))
        if (state.active) throw new BackupError(409, 'stop validation before backing up its task ledger')
        state.tasks.forEach(task => { if (task.sessionId) requiredSessions.add(task.sessionId) })
        state.runs.forEach(run => { if (run.sessionId) requiredSessions.add(run.sessionId) })
      }
    }
    if (selected.memory) {
      components.add('memory')
      const md = await optional('workspace-memory.md', 'memory/workspace-memory.md')
      if (!md) await optional('workspace-memory.json', 'memory/workspace-memory.json')
    }
    const processed = new Set<string>()
    while (processed.size < requiredSessions.size) {
      if (requiredSessions.size > BACKUP_LIMITS.sessions) throw new BackupError(413, 'session dependencies exceed the backup limit')
      const id = [...requiredSessions].find(id => !processed.has(id))!
      if (!isSessionId(id)) throw new BackupError(400, 'invalid linked session')
      const session = await this.sessions.open(id).catch(() => { throw new BackupError(409, 'a selected or referenced session is missing; repair its reference before backup') })
      await session.flush(); check()
      const raw = await read(session.file), log = records(raw)
      sessionDependencies(log).forEach(id => requiredSessions.add(id))
      const attached = new Map<string, Buffer>()
      for (const record of log) if (record.type === 'user/message' && record.payload.attachments) for (const file of record.payload.attachments) {
        const target = attachmentPath(id, file.path, this.sessions.root), relative = target.slice(`sessions/${id}/`.length)
        const bytes = await read(path.join(session.dir, relative))
        if (digest(bytes) !== file.sha256 || bytes.length !== file.size) throw new BackupError(409, 'session attachment changed or is incomplete')
        attached.set(target, bytes); addBytes(target, bytes)
      }
      const mapped = mapSession(log, id, file => BACKUP_ATTACHMENT + attachmentPath(id, file, this.sessions.root))
      addBytes(`sessions/${id}/session.jsonl`, encodeRecords(mapped)); processed.add(id)
      const refs = JSON.stringify(log)
      if (/@\[knowledge:|sakura-ref:.*knowledge/i.test(refs) && !selected.knowledge) { selected.knowledge = true; warnings.push('Knowledge was included because a selected session references it.') }
    }
    if (requiredSessions.size) components.add('sessions')
    if (requiredSessions.size > (selected.sessionIds?.length ?? 0)) warnings.push('Related sessions were included to preserve task and conversation references.')
    if (selected.knowledge) {
      components.add('knowledge')
      const knowledge = new KnowledgeStore(this.cwd), state = await knowledge.getVersionState(check)
      knowledgeInventory = digest(JSON.stringify(state))
      if (state.errors.length || state.usage.overLimit || state.collections.some(c => c.versions.some(v => !v.available))) throw new BackupError(409, 'knowledge is incomplete or invalid; no partial backup was created')
      const documents = [...state.unmanagedDocuments, ...state.collections.flatMap(c => c.versions.flatMap(v => v.documents))]
      for (const doc of documents) {
        const relative = doc.source.replace(/^\.sakura\//, '')
        if (!relative.startsWith('knowledge/') && !relative.startsWith('knowledge-versions/versions/')) throw new BackupError(409, 'invalid knowledge source')
        const bytes = await read(path.join(this.cwd, '.sakura', relative)); if (digest(bytes) !== doc.version) throw new BackupError(409, 'knowledge changed during backup')
        addBytes(relative, bytes)
      }
      await optional('knowledge-versions/manifest.json', 'knowledge-versions/manifest.json')
      const sourceManifest = await optional('documents/manifest.json', 'documents/manifest.json')
      if (sourceManifest) {
        const inventory = await new DocumentStore(this.cwd).inventory({ assertCurrent: check })
        for (const original of inventory.manifest.originals) {
          const target = `documents/originals/${original.sha256}.bin`, bytes = await read(path.join(this.cwd, '.sakura', target))
          if (digest(bytes) !== original.sha256 || bytes.length !== original.bytes) throw new BackupError(409, 'original document changed')
          addBytes(target, bytes)
        }
      }
    }
    if (!components.size) throw new BackupError(400, 'select data to back up')
    // A second full read detects writes during capture; do not publish a mixed snapshot.
    for (const source of sources) { check(); if (digest(await regular(source.file, check)) !== source.hash) throw new BackupError(409, 'workspace data changed during backup; retry when idle') }
    for (const file of absent) {
      check()
      try { await fs.lstat(file); throw new BackupError(409, 'previously missing backup data appeared during capture') }
      catch (error) { if (!missing(error)) throw error }
    }
    if (knowledgeInventory !== undefined && digest(JSON.stringify(await new KnowledgeStore(this.cwd).getVersionState(check))) !== knowledgeInventory) {
      throw new BackupError(409, 'knowledge inventory changed during capture; no mixed backup was created')
    }
    check()
    const manifest: BackupManifest = { format: 'sakuracode-workspace-backup', version: 1, createdAt: new Date().toISOString(), components: [...components],
      sessionIds: [...requiredSessions], warnings: [...warnings, 'Contains private chat, files and logs; credentials pasted into content are not automatically removed.',
        'Restoring disables automatic memory processing, preserves command reports as historical, and does not activate old code rollback checkpoints.'], entries }
    validateManifest(manifest)
    const fingerprint = digest(JSON.stringify(entries.map(e => [e.path, e.sha256]).sort((a, b) => a[0]! < b[0]! ? -1 : 1)))
    return { manifest, fingerprint, selected }
  }
  async previewBackup(selection: BackupSelection, current: () => void = () => {}): Promise<BackupPreview> {
    return this.exclusive(async () => { const capture = await this.capture(selection, current); return this.remember(capture.manifest, capture.fingerprint, { capture }) }, current)
  }
  async download(id: string, fingerprint: string, current: () => void = () => {}): Promise<Buffer> {
    return this.exclusive(async () => {
      const ticket = this.consume(id, fingerprint)
      if (!ticket.capture) throw new BackupError(400, 'not an export preview')
      const currentCapture = await this.capture(ticket.capture.selected, current)
      if (currentCapture.fingerprint !== ticket.capture.fingerprint) throw new BackupError(409, 'source changed after preview; create a new backup preview')
      const bytes = await encodeBackup(currentCapture.manifest); this.check(current); return bytes
    }, current)
  }
  async previewRestore(bytes: Uint8Array, current: () => void = () => {}): Promise<BackupPreview> {
    return this.exclusive(async () => {
      const manifest = await decodeBackup(bytes); this.check(current)
      await this.validateContents(manifest, current)
      return this.remember(manifest, digest(bytes), { bytes: Buffer.from(bytes) })
    }, current)
  }
  private async validateContents(manifest: BackupManifest, current: () => void): Promise<void> {
    // All schemas are checked without running tools, model requests or document parsers.
    const mapped = new Map(manifest.entries.map(e => [e.path, Buffer.from(e.data, 'base64')]))
    const sourceManifest = mapped.get('documents/manifest.json')
    if (sourceManifest) {
      const originals = new Map<string, Uint8Array>()
      for (const [file, bytes] of mapped) if (file.startsWith('documents/originals/')) originals.set(path.posix.basename(file, '.bin'), bytes)
      try { validateDocumentSnapshot(JSON.parse(sourceManifest.toString('utf8')), originals) }
      catch { throw new BackupError(400, 'original document metadata or content failed validation') }
    }
    const versions = mapped.get('knowledge-versions/manifest.json')
    if (versions) {
      const meta = JSON.parse(versions.toString('utf8')) as { version: number; collections: Array<{ activeVersionId: string; versions: Array<{ id: string; kind: string; directory: string; files: Array<{ path: string; hash: string; bytes: number }> }> }> }
      if (meta.version !== 1 || !Array.isArray(meta.collections) || meta.collections.length > 32) throw new BackupError(400, 'invalid knowledge version metadata')
      for (const collection of meta.collections) {
        if (!Array.isArray(collection.versions) || !collection.versions.some(v => v.id === collection.activeVersionId)) throw new BackupError(400, 'missing active knowledge version')
        for (const version of collection.versions) {
          if (!portable(version.directory) || version.directory.includes('/') || !['legacy', 'managed'].includes(version.kind) || !Array.isArray(version.files)) throw new BackupError(400, 'invalid knowledge version path')
          for (const file of version.files) {
            if (!portable(file.path)) throw new BackupError(400, 'invalid version document path')
            const target = (version.kind === 'legacy' ? 'knowledge/' : 'knowledge-versions/versions/') + version.directory + '/' + file.path, data = mapped.get(target)
            if (!data || data.length !== file.bytes || digest(data) !== file.hash) throw new BackupError(400, 'knowledge history dependency missing or corrupt')
          }
        }
      }
    }
    this.check(current)
  }
  async restore(id: string, fingerprint: string, parent: string, name: string, current: () => void = () => {}): Promise<{ directory: string; warnings: string[] }> {
    return this.exclusive(async () => {
      if (typeof parent !== 'string' || !path.isAbsolute(parent) || !portable(name) || name.includes('/')) throw new BackupError(400, 'restore requires an absolute parent and a new directory name')
      const ticket = this.consume(id, fingerprint)
      if (!ticket.bytes) throw new BackupError(400, 'not a restore preview')
      const manifest = await decodeBackup(ticket.bytes); await this.validateContents(manifest, current)
      const target = path.join(parent, name), owner = await directory(parent)
      if (await fs.lstat(target).then(() => true, error => { if (missing(error)) return false; throw error })) throw new BackupError(409, 'restore destination already exists; choose a new directory')
      const staged = path.join(parent, `.sakura-restore-${randomUUID()}`)
      await fs.mkdir(staged, { mode: 0o700 }); const identity = await fs.lstat(staged)
      let published = false
      try {
        const now = new Date().toISOString()
        for (const item of manifest.entries) {
          this.check(current)
          let relative = item.path
          let bytes: Buffer = Buffer.from(item.data, 'base64')
          if (relative.startsWith('memory/')) { bytes = Buffer.from(restoredMemory(bytes.toString('utf8'), relative.endsWith('.json'))); relative = 'workspace-memory.md' }
          if (relative === 'tasks/state.json') bytes = Buffer.from(JSON.stringify(restoredTaskState(JSON.parse(bytes.toString('utf8')), now)) + '\n')
          if (/^sessions\/[^/]+\/session\.jsonl$/.test(relative)) {
            const sessionId = relative.split('/')[1]!, log = mapSession(records(bytes), sessionId, file => path.join(target, '.sakura', attachmentPath(sessionId, file)))
            const seq = (log.at(-1)?.seq ?? 0) + 1
            log.push({ seq, time: now, type: 'session/note', payload: { note: 'backup-restored', sourceCreatedAt: manifest.createdAt, codeCheckpointsRestored: false } })
            bytes = encodeRecords(log)
          }
          const output = path.join(staged, '.sakura', relative)
          await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 }); await directory(path.dirname(output))
          const handle = await fs.open(output, 'wx', 0o600)
          try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
        }
        const status = await new KnowledgeStore(staged).getVersionState(() => this.check(current))
        if (status.errors.length || status.usage.overLimit) throw new BackupError(400, 'restored knowledge did not pass validation')
        await fs.writeFile(path.join(staged, 'RESTORE-REPORT.txt'), ['SakuraCode restored working data', `Source: ${manifest.createdAt}`, `Restored: ${now}`, ...manifest.warnings,
          'No code, Git repository, credentials, hooks, connectors or old code rollback checkpoints were restored.',
          'Memory is disabled until explicitly enabled. Task command evidence is historical and must be rerun.'].join('\n'), { flag: 'wx', mode: 0o600 })
        const finalParent = await directory(parent), finalStaged = await directory(staged)
        if (owner.dev !== finalParent.dev || owner.ino !== finalParent.ino || identity.dev !== finalStaged.dev || identity.ino !== finalStaged.ino) throw new BackupError(409, 'restore directory changed')
        if (await fs.lstat(target).then(() => true, error => { if (missing(error)) return false; throw error })) throw new BackupError(409, 'restore target appeared during validation')
        this.check(current); await fs.rename(staged, target); published = true
        return { directory: target, warnings: manifest.warnings }
      } finally {
        if (!published) {
          try { const lastParent = await directory(parent), last = await directory(staged)
            if (lastParent.ino === owner.ino && lastParent.dev === owner.dev && last.ino === identity.ino && last.dev === identity.dev) await fs.rm(staged, { recursive: true, force: true })
          } catch { /* Replaced temporary directories are never followed or removed. */ }
        }
      }
    }, current)
  }
}
