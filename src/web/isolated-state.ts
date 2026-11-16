/** Private execution metadata beside a managed tree, never inside source or a shared session. */
import { randomUUID } from 'node:crypto'
import { promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { guardDirectory, readRegular, digest, sameIdentity, statOrNull } from '../git/safety.js'
import { HttpError } from './http.js'

export interface IsolatedBinding {
  version: 1
  taskId: string
  sessionId: string
  validationTaskId: string
  model: string
  adapter: string
  status: 'idle' | 'running' | 'done' | 'error' | 'interrupted'
  updatedAt: string
  error?: string
}
const MAX_BYTES = 16 * 1024
export async function readBinding(dir: string): Promise<{ value?: IsolatedBinding; fingerprint: string }> {
  await guardDirectory(dir)
  const file = path.join(dir, 'execution.json')
  if (!await statOrNull(file)) return { fingerprint: digest('missing') }
  const { bytes } = await readRegular(file, MAX_BYTES, true)
  let value: IsolatedBinding
  try {
    value = JSON.parse(bytes.toString('utf8')) as IsolatedBinding
    if (!value || value.version !== 1 || !['idle', 'running', 'done', 'error', 'interrupted'].includes(value.status) ||
      ![value.taskId, value.sessionId, value.validationTaskId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..')) ||
      ![value.model, value.adapter].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f]/.test(v)) ||
      typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 2000)) throw Error()
  } catch { throw new HttpError(409, '独立任务执行记录损坏，原文件保留，请先备份检查。') }
  return { value, fingerprint: digest(bytes) }
}
export async function executionLock(dir: string): Promise<() => Promise<void>> {
  const directory = await guardDirectory(dir), file = path.join(dir, 'execution.lock')
  let handle
  try { handle = await fs.open(file, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new HttpError(409, '独立任务正由其他进程使用，或上次退出留下锁。请确认进程已关闭后检查，系统不自动删除锁。'); throw error }
  await handle.writeFile(randomUUID()); const owned = await handle.stat()
  return async () => {
    await handle.close()
    const currentDirectory = await guardDirectory(dir).catch(() => undefined), current = await statOrNull(file)
    if (currentDirectory && sameIdentity(directory, currentDirectory) && current?.isFile() && current.nlink === 1 && !current.isSymbolicLink() && sameIdentity(owned, current)) await fs.unlink(file)
  }
}
export async function writeBinding(dir: string, value: IsolatedBinding, expected: string, current: () => void): Promise<string> {
  current(); const directory = await guardDirectory(dir)
  const initial = await readBinding(dir)
  if (initial.fingerprint !== expected) throw new HttpError(409, '独立任务记录已改变，请重新打开。')
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > MAX_BYTES) throw new HttpError(413, '独立任务元数据过大。')
  const temp = path.join(dir, `.execution-${randomUUID()}.tmp`)
  let identity: Stats | undefined, published = false
  const handle = await fs.open(temp, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync(); identity = await handle.stat() } finally { await handle.close() }
  try {
    current()
    if (!sameIdentity(directory, await guardDirectory(dir)) || (await readBinding(dir)).fingerprint !== expected) throw new HttpError(409, '独立任务存储在保存时改变。')
    const staged = await fs.lstat(temp)
    if (!sameIdentity(staged, identity!) || !staged.isFile() || staged.nlink !== 1 || staged.isSymbolicLink()) throw new HttpError(409, '独立任务暂存文件被替换。')
    current(); await fs.rename(temp, path.join(dir, 'execution.json')); published = true
    return digest(bytes)
  } finally {
    if (!published) { const now = await statOrNull(temp); if (now && identity && sameIdentity(now, identity) && !now.isSymbolicLink() && now.nlink === 1) await fs.unlink(temp).catch(() => {}) }
  }
}
