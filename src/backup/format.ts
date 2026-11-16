/** Memory-bounded gzip envelope; paths are allowlisted and every payload is hashed. */
import { gzip, gunzip } from 'node:zlib'
import { promisify } from 'node:util'
import { BACKUP_LIMITS, BackupError, type BackupManifest } from './types.js'
import { decodeEntry } from './safety.js'
import { records, sessionDependencies, attachmentPath, BACKUP_ATTACHMENT } from './sessions.js'
import { isSessionId } from '../core/session.js'
import { validateTaskBackup } from '../tasks/store.js'
import { validateMemoryBackup } from '../plugins/workspace-memory.js'
import { validateKnowledgeBackup } from '../knowledge/index.js'
import { validateDocumentSnapshot } from '../documents/validate.js'

const zip = promisify(gzip), unzip = promisify(gunzip)
export function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError(400, 'invalid backup manifest')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(name => !['format', 'version', 'createdAt', 'components', 'sessionIds', 'warnings', 'entries'].includes(name)) || row.format !== 'sakuracode-workspace-backup' || row.version !== 1 ||
    typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || !Array.isArray(row.components) || row.components.some(c => !['sessions', 'tasks', 'memory', 'knowledge'].includes(c)) ||
    !Array.isArray(row.sessionIds) || row.sessionIds.length > BACKUP_LIMITS.sessions || row.sessionIds.some(id => !isSessionId(id)) ||
    !Array.isArray(row.warnings) || row.warnings.length > 32 || row.warnings.some(w => typeof w !== 'string' || w.length > 2000) ||
    !Array.isArray(row.entries) || row.entries.length > BACKUP_LIMITS.files) throw new BackupError(400, 'invalid or unsupported backup format')
  const entries = row.entries.map(decodeEntry), paths = new Map<string, Buffer>(), aliases = new Set<string>()
  let total = 0
  for (const item of entries) {
    total += item.bytes.length
    if (total > BACKUP_LIMITS.decodedBytes) throw new BackupError(413, 'backup contents exceed the restore budget')
    const alias = item.entry.path.toLowerCase().normalize('NFC')
    if (aliases.has(alias) || [...aliases].some(other => other.startsWith(alias + '/') || alias.startsWith(other + '/'))) throw new BackupError(400, 'duplicate or overlapping backup path')
    aliases.add(alias); paths.set(item.entry.path, item.bytes)
  }
  const sessionIds = row.sessionIds as string[], components = new Set(row.components)
  if (!components.size || components.size !== row.components.length || sessionIds.length && !components.has('sessions')) throw new BackupError(400, 'invalid backup component selection')
  if (paths.has('memory/workspace-memory.md') && paths.has('memory/workspace-memory.json')) throw new BackupError(400, 'duplicate memory representations')
  for (const file of paths.keys()) {
    const component = file.startsWith('sessions/') ? 'sessions' : file.startsWith('memory/') ? 'memory' : file.startsWith('tasks/') ? 'tasks' : 'knowledge'
    if (!components.has(component)) throw new BackupError(400, 'backup entry is outside the selected components')
  }
  const referencedAttachments = new Set<string>()
  if (new Set(sessionIds.map(id => id.toLowerCase())).size !== sessionIds.length) throw new BackupError(400, 'duplicate backup session')
  for (const id of sessionIds) {
    const bytes = paths.get(`sessions/${id}/session.jsonl`)
    if (!bytes) throw new BackupError(400, 'session log missing from backup')
    const log = records(bytes)
    for (const dependency of sessionDependencies(log)) if (!sessionIds.includes(dependency)) throw new BackupError(400, 'referenced session is missing from backup')
    for (const record of log) if (record.type === 'user/message' && record.payload.attachments) {
      for (const file of record.payload.attachments) {
        if (typeof file.path !== 'string' || !file.path.startsWith(BACKUP_ATTACHMENT)) throw new BackupError(400, 'attachment path is not portable')
        const target = attachmentPath(id, file.path), stored = entries.find(entry => entry.entry.path === target)
        if (!stored || stored.entry.sha256 !== file.sha256 || stored.bytes.length !== file.size) throw new BackupError(400, 'attachment dependency is missing or changed')
        referencedAttachments.add(target)
      }
    }
  }
  for (const item of entries) {
    const file = item.entry.path
    if (file.startsWith('sessions/') && !sessionIds.includes(file.split('/')[1]!)) throw new BackupError(400, 'unexpected session file')
    if (file.includes('/attachments/') && !referencedAttachments.has(file)) throw new BackupError(400, 'unreferenced backup attachment')
    if (file === 'tasks/state.json') {
      const state = validateTaskBackup(JSON.parse(item.bytes.toString('utf8')))
      if (state.active) throw new BackupError(400, 'backup must not contain a running process owner')
      for (const task of state.tasks) if (task.sessionId && !sessionIds.includes(task.sessionId)) throw new BackupError(400, 'task session missing from backup')
      for (const run of state.runs) if (run.sessionId && !sessionIds.includes(run.sessionId)) throw new BackupError(400, 'validation session missing from backup')
    }
    if (file.startsWith('memory/')) validateMemoryBackup(item.bytes.toString('utf8'), file.endsWith('.json'))
  }
  try {
    const knowledge = new Map([...paths].filter(([file]) => file.startsWith('knowledge/') || file.startsWith('knowledge-versions/versions/')))
    validateKnowledgeBackup(paths.get('knowledge-versions/manifest.json')?.toString('utf8') ?? '{"version":1,"revision":0,"collections":[]}', knowledge)
    const originalManifest = paths.get('documents/manifest.json'), originals = new Map<string, Uint8Array>()
    for (const [file, bytes] of paths) if (file.startsWith('documents/originals/')) originals.set(file.split('/').at(-1)!.slice(0, -4), bytes)
    if (!originalManifest && originals.size) throw new Error('original manifest missing')
    if (originalManifest) validateDocumentSnapshot(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(originalManifest)), originals)
  } catch { throw new BackupError(400, 'backup knowledge or original-document dependencies are invalid') }
  return { format: 'sakuracode-workspace-backup', version: 1, createdAt: row.createdAt, components: row.components as BackupManifest['components'],
    sessionIds, warnings: row.warnings as string[], entries: entries.map(item => item.entry) }
}
export async function encodeBackup(value: BackupManifest): Promise<Buffer> {
  const manifest = validateManifest(value), raw = Buffer.from(JSON.stringify(manifest))
  if (raw.length > BACKUP_LIMITS.decodedBytes * 1.5) throw new BackupError(413, 'backup envelope is too large')
  const bytes = await zip(raw, { level: 6 })
  if (bytes.length > BACKUP_LIMITS.archiveBytes) throw new BackupError(413, 'compressed backup is too large')
  return bytes
}
export async function decodeBackup(bytes: Uint8Array): Promise<BackupManifest> {
  if (!bytes.length || bytes.length > BACKUP_LIMITS.archiveBytes) throw new BackupError(413, 'backup upload exceeds its size limit')
  let raw: Buffer
  try { raw = await unzip(bytes, { maxOutputLength: Math.floor(BACKUP_LIMITS.decodedBytes * 1.5) }) }
  catch { throw new BackupError(400, 'invalid or oversized compressed backup') }
  try { return validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))) }
  catch (error) { if (error instanceof BackupError) throw error; throw new BackupError(400, 'backup contains invalid component metadata') }
}
