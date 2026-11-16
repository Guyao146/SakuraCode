/** Bounded regular-file reads and portable archive paths; no recursive workspace copying. */
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { BACKUP_LIMITS, BackupError, type BackupEntry } from './types.js'

export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
export const pathKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
export const stamp = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
export const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
export function portable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\\x00-\x1f\x7f<>:"|?*]/.test(value) && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => !!part && part.length <= 255 && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))
}
export function permitted(file: string): boolean {
  if (!portable(file)) return false
  if (/^sessions\/[^/]+\/session\.jsonl$/.test(file) || /^sessions\/[^/]+\/attachments\/[^/]+\/[^/]+$/.test(file)) return true
  if (['memory/workspace-memory.md', 'memory/workspace-memory.json', 'tasks/state.json', 'knowledge-versions/manifest.json', 'documents/manifest.json'].includes(file)) return true
  if (/^knowledge\/.+\.(md|txt)$/i.test(file) || /^knowledge-versions\/versions\/[^/]+\/.+\.(md|txt)$/i.test(file)) return true
  return /^documents\/originals\/[a-f0-9]{64}\.bin$/.test(file)
}
export async function directory(file: string): Promise<Stats> {
  const resolved = path.resolve(file), root = path.parse(resolved).root
  let current = root, stat = await fs.lstat(root)
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new BackupError(409, 'backup paths must use ordinary directories, not links')
  }
  if (pathKey(await fs.realpath(resolved)) !== pathKey(resolved)) throw new BackupError(409, 'backup path has a linked ancestor')
  return stat
}
export async function regular(file: string, check: () => void = () => {}): Promise<Buffer> {
  check(); await directory(path.dirname(file)); check()
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > BACKUP_LIMITS.fileBytes) throw new BackupError(409, 'backup source must be a bounded regular file without links')
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (stamp(await handle.stat()) !== stamp(before)) throw new BackupError(409, 'backup source changed while opening')
    const bytes = Buffer.alloc(before.size + 1); let size = 0
    while (size < bytes.length) { check(); const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead }
    if (size !== before.size || stamp(await handle.stat()) !== stamp(before) || stamp(await fs.lstat(file)) !== stamp(before)) throw new BackupError(409, 'backup source changed while reading')
    await directory(path.dirname(file)); check()
    return bytes.subarray(0, size)
  } finally { await handle.close() }
}
export function entry(file: string, bytes: Buffer): BackupEntry {
  if (!permitted(file) || bytes.length > BACKUP_LIMITS.fileBytes) throw new BackupError(400, 'unsupported backup entry')
  return { path: file, bytes: bytes.length, sha256: digest(bytes), data: bytes.toString('base64') }
}
export function decodeEntry(value: unknown): { entry: BackupEntry; bytes: Buffer } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BackupError(400, 'invalid backup entry')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['path', 'bytes', 'sha256', 'data'].includes(key)) || typeof row.path !== 'string' || !permitted(row.path) ||
    !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > BACKUP_LIMITS.fileBytes || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256) ||
    typeof row.data !== 'string' || row.data.length > Math.ceil(BACKUP_LIMITS.fileBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data)) throw new BackupError(400, 'unsafe or malformed backup entry')
  const bytes = Buffer.from(row.data, 'base64')
  if (bytes.length !== row.bytes || digest(bytes) !== row.sha256) throw new BackupError(400, 'backup checksum mismatch')
  return { entry: row as unknown as BackupEntry, bytes }
}
