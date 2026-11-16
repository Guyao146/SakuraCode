import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { GitReviewError, type GitReviewLimits } from './types.js'
import { digest, guardDirectory, missing, readRegular, sameIdentity, statOrNull } from './safety.js'
import type { Operation } from './process.js'

export interface ReviewRecord { key: string; fingerprint: string }
interface StoreData { version: 1; records: ReviewRecord[] }
export interface StoreSnapshot { data: StoreData; fingerprint: string }
export const EMPTY_STORE_FINGERPRINT = digest('')
const hex = /^[0-9a-f]{64}$/

/** A dedicated subdirectory; never migrates, overwrites or deletes other Sakura state. */
export class GitReviewStore {
  readonly directory: string
  readonly file: string
  private readonly sakura: string

  constructor(readonly workspace: string, readonly limits: GitReviewLimits) {
    this.sakura = path.join(workspace, '.sakura')
    this.directory = path.join(this.sakura, 'git-review')
    this.file = path.join(this.directory, 'state.json')
  }

  private async guard(create = false): Promise<Stats | null> {
    try {
      await guardDirectory(this.workspace)
      for (const directory of [this.sakura, this.directory]) {
        if (!(await statOrNull(directory))) {
          if (!create) return null
          try { await fs.mkdir(directory, { mode: 0o700 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
        }
        await guardDirectory(directory)
      }
      return fs.lstat(this.directory)
    } catch (error) {
      if (error instanceof GitReviewError && error.code === 'UNSAFE_PATH') throw new GitReviewError('UNSAFE_STORE', 'Review storage contains linked or unsafe directories.', 409)
      throw error
    }
  }

  async read(): Promise<StoreSnapshot> {
    if (!(await this.guard())) return { data: { version: 1, records: [] }, fingerprint: EMPTY_STORE_FINGERPRINT }
    let bytes: Buffer
    try { bytes = (await readRegular(this.file, this.limits.maxStoreBytes, true)).bytes }
    catch (error) {
      if (missing(error)) return { data: { version: 1, records: [] }, fingerprint: EMPTY_STORE_FINGERPRINT }
      if (error instanceof GitReviewError && error.code === 'UNSAFE_PATH') throw new GitReviewError('UNSAFE_STORE', 'Review storage must be a single-link ordinary file.', 409)
      throw error
    }
    try {
      const data: unknown = JSON.parse(bytes.toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('object expected')
      const value = data as Record<string, unknown>
      if (value.version !== 1 || !Array.isArray(value.records) || Object.keys(value).sort().join(',') !== 'records,version' || value.records.length > 20_000) throw new Error('schema mismatch')
      const seen = new Set<string>()
      for (const record of value.records) {
        if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'fingerprint,key' ||
            typeof record.key !== 'string' || !hex.test(record.key) || typeof record.fingerprint !== 'string' || !hex.test(record.fingerprint) || seen.has(record.key)) throw new Error('invalid record')
        seen.add(record.key)
      }
      return { data: value as unknown as StoreData, fingerprint: digest(bytes) }
    } catch { throw new GitReviewError('STORE_CORRUPT', 'Review state is invalid. The original file was preserved; repair it explicitly before writing.', 409) }
  }

  async update(expected: string, op: Operation, mutate: (data: StoreData) => Promise<StoreData>): Promise<StoreSnapshot> {
    op.check()
    const directoryIdentity = (await this.guard(true))!
    const lockPath = path.join(this.directory, 'write.lock')
    let lock: Awaited<ReturnType<typeof fs.open>>
    try { lock = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new GitReviewError('STORE_BUSY', 'Another review writer holds the write lock. Existing locks are never deleted automatically.', 409)
      throw error
    }
    const lockIdentity = await lock.stat()
    let tempFile: string | null = null
    let tempIdentity: Stats | null = null
    try {
      await lock.writeFile(`${process.pid}\n${randomUUID()}\n`)
      await lock.sync()
      await this.checkIdentity(directoryIdentity)
      const initial = await this.read()
      if (initial.fingerprint !== expected) throw new GitReviewError('STALE_STORE', 'Review state changed; reload before saving.', 409)
      const next = await mutate(initial.data)
      op.check()
      if (next.records.length > 20_000) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many stored review marks.', 413)
      next.records.sort((a, b) => a.key.localeCompare(b.key))
      const bytes = Buffer.from(JSON.stringify(next) + '\n')
      if (bytes.length > this.limits.maxStoreBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'Review state exceeds the storage limit.', 413)
      tempFile = path.join(this.directory, `.state-${randomUUID()}.tmp`)
      const temp = await fs.open(tempFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600)
      try { tempIdentity = await temp.stat(); await temp.writeFile(bytes); await temp.sync() }
      finally { await temp.close() }
      op.check()
      await this.checkIdentity(directoryIdentity)
      if ((await this.read()).fingerprint !== expected) throw new GitReviewError('STALE_STORE', 'Review state changed while saving. The original file was preserved.', 409)
      const tempNow = await fs.lstat(tempFile)
      if (!tempIdentity || !sameIdentity(tempIdentity, tempNow) || !tempNow.isFile() || tempNow.isSymbolicLink() || tempNow.nlink !== 1) throw new GitReviewError('UNSAFE_STORE', 'The temporary review state changed.', 409)
      await this.checkIdentity(directoryIdentity)
      await fs.rename(tempFile, this.file)
      tempFile = null
      // fsync directory where supported; Windows does not allow opening directories this way.
      if (process.platform !== 'win32') {
        const handle = await fs.open(this.directory, constants.O_RDONLY)
        try { await handle.sync() } finally { await handle.close() }
      }
      return { data: next, fingerprint: digest(bytes) }
    } finally {
      await lock.close()
      // Do not follow a swapped directory, delete someone else's lock, or unlink a hardlink.
      const currentDirectory = await this.guard().catch(() => null)
      if (currentDirectory && sameIdentity(directoryIdentity, currentDirectory)) {
        if (tempFile && tempIdentity) {
          const info = await statOrNull(tempFile)
          if (info && sameIdentity(info, tempIdentity) && info.nlink === 1 && !info.isSymbolicLink()) await fs.unlink(tempFile)
        }
        const info = await statOrNull(lockPath)
        if (info && sameIdentity(info, lockIdentity) && info.nlink === 1 && !info.isSymbolicLink()) await fs.unlink(lockPath)
      }
    }
  }

  private async checkIdentity(expected: Stats): Promise<void> {
    const actual = await this.guard()
    if (!actual || !sameIdentity(expected, actual)) throw new GitReviewError('UNSAFE_STORE', 'The review storage directory changed.', 409)
  }
}
