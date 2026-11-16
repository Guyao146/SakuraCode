/** Portable session logs with explicit attachment references; never rewrite arbitrary chat text. */
import * as path from 'node:path'
import { isSessionId } from '../core/session.js'
import { CHAT_ATTACHMENT_MARKER } from '../core/attachments.js'
import type { SessionEventRecord } from '../core/types.js'
import { BackupError, BACKUP_LIMITS } from './types.js'
import { portable } from './safety.js'

const TYPES = new Set(['agent/meta', 'system/message', 'user/message', 'assistant/message', 'assistant/attempt', 'tool/call', 'tool/result', 'session/note', 'collaboration/message'])
export const BACKUP_ATTACHMENT = 'sakura-backup:/'
export function records(bytes: Buffer): SessionEventRecord[] {
  let raw: string
  try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new BackupError(400, 'session log is not valid UTF-8') }
  const result: SessionEventRecord[] = []; let seq = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let record: SessionEventRecord
    try { record = JSON.parse(line) as SessionEventRecord } catch { throw new BackupError(409, 'session log contains an incomplete record; no partial backup was created') }
    if (!record || !Number.isSafeInteger(record.seq) || record.seq <= seq || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time)) || !TYPES.has(record.type) ||
      !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) throw new BackupError(400, 'invalid session record')
    if (record.type === 'user/message' && typeof record.payload.content !== 'string') throw new BackupError(400, 'invalid user message')
    seq = record.seq; result.push(record)
    if (result.length > 100_000) throw new BackupError(413, 'too many session records')
  }
  return result
}
export function sessionDependencies(log: readonly SessionEventRecord[]): string[] {
  const result = new Set<string>()
  const add = (value: unknown) => { if (value !== undefined && value !== null && value !== '') { if (!isSessionId(value)) throw new BackupError(400, 'invalid referenced session'); result.add(value) } }
  for (const record of log) {
    if (record.type === 'agent/meta') { add(record.payload.branchOf); add(record.payload.parentSession) }
    if (record.type === 'collaboration/message') add(record.payload.sourceSessionId)
  }
  return [...result]
}
export function attachmentPath(sessionId: string, file: string, sessionRoot?: string): string {
  if (!isSessionId(sessionId) || typeof file !== 'string') throw new BackupError(400, 'invalid attachment reference')
  let relative: string
  if (file.startsWith(BACKUP_ATTACHMENT)) relative = file.slice(BACKUP_ATTACHMENT.length)
  else {
    if (!sessionRoot || !path.isAbsolute(file)) throw new BackupError(400, 'attachment must refer to an owned session file')
    const within = path.relative(path.join(sessionRoot, sessionId), file).split(path.sep).join('/')
    relative = `sessions/${sessionId}/${within}`
  }
  if (!portable(relative) || !relative.startsWith(`sessions/${sessionId}/attachments/`) || relative.split('/').length !== 5) throw new BackupError(400, 'attachment points outside its session')
  return relative
}
export function mapSession(log: readonly SessionEventRecord[], sessionId: string, map: (file: string, hash: string, size: number) => string): SessionEventRecord[] {
  return log.map(record => {
    const next = structuredClone(record)
    if (next.type !== 'user/message' || next.payload.attachments === undefined) return next
    if (!Array.isArray(next.payload.attachments) || next.payload.attachments.length > 12) throw new BackupError(400, 'invalid session attachment list')
    const replacements: Array<{ before: string; after: string }> = []
    next.payload.attachments = next.payload.attachments.map(item => {
      if (!item || typeof item.path !== 'string' || typeof item.name !== 'string' || item.name.length > 512 || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 0 || item.size > BACKUP_LIMITS.fileBytes || !['image', 'text', 'binary'].includes(item.kind)) throw new BackupError(400, 'invalid attachment metadata')
      const updated = { ...item, path: map(item.path, item.sha256, item.size) }
      replacements.push({ before: JSON.stringify(item), after: JSON.stringify(updated) })
      return updated
    })
    // Replace only a complete generated metadata line, in attachment order.
    // Text inside <file> blocks and arbitrary user mentions of paths stay byte-identical.
    const start = next.payload.content.indexOf(CHAT_ATTACHMENT_MARKER)
    if (start >= 0) {
      const prefix = next.payload.content.slice(0, start)
      let appendix = next.payload.content.slice(start), from = 0
      for (const replacement of replacements) {
        const needle = '\n' + replacement.before + '\n', at = appendix.indexOf(needle, from)
        if (at < 0) continue
        appendix = appendix.slice(0, at) + '\n' + replacement.after + '\n' + appendix.slice(at + needle.length)
        from = at + replacement.after.length + 2
      }
      next.payload.content = prefix + appendix
    }
    return next
  })
}
export function encodeRecords(log: readonly SessionEventRecord[]): Buffer { return Buffer.from(log.map(record => JSON.stringify(record)).join('\n') + '\n') }
