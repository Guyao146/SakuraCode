import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { killProcessTree, shellSpawnDetached } from '../core/shell.js'
import { GitObjects } from '../git/objects.js'
import { safeEnvironment, type Operation } from '../git/process.js'
import type { ObjectEntry, Repository } from '../git/repository.js'
import { digest, digestParts, gitPath, guardDirectory, inside, missing, optionalRegular, readRegular, samePath, statOrNull } from '../git/safety.js'
import { GIT_REVIEW_LIMITS } from '../git/types.js'
import { WorktreeError, type WorktreeInfo } from './types.js'

export const LIMITS = { ...GIT_REVIEW_LIMITS, timeoutMs: 120_000 }
export const MAX_WORKTREES = 32
export const MAX_STORE_BYTES = 16 * 1024 * 1024
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const HASH = /^[0-9a-f]{64}$/
export const inode = (s: Stats): string => digestParts([s.dev, s.ino, s.birthtimeMs, s.isDirectory()])
export const privatePath = (name: string): boolean => name.split('/').some(part => part.toLowerCase() === '.sakura')
export const order = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))
export function relativeFile(value: string): string {
  if (typeof value !== 'string' || value.includes('\\')) throw new WorktreeError('UNSAFE_PATH', 'Expected a literal, slash-separated repository path.')
  return gitPath(value)
}
export function assertId(id: string): void { if (typeof id !== 'string' || !UUID.test(id)) throw new WorktreeError('INVALID_ARGUMENT', 'Invalid worktree or preview ID.') }
export function assertFingerprint(value: string): void { if (typeof value !== 'string' || !HASH.test(value)) throw new WorktreeError('INVALID_ARGUMENT', 'A current fingerprint is required.') }
export const requireSame = (a: unknown, b: unknown, message = 'The preview is stale; review the current state again.'): void => {
  if (a !== b) throw new WorktreeError('STATE_CHANGED', message, 409)
}
export async function ensureDirectory(directory: string): Promise<void> {
  const existing = await statOrNull(directory)
  if (existing) { await guardDirectory(directory); return }
  const parent = path.dirname(directory)
  if (parent === directory) throw new WorktreeError('UNSAFE_PATH', 'Cannot create the managed filesystem root.')
  await ensureDirectory(parent)
  const identity = inode(await guardDirectory(parent))
  try { await fs.mkdir(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  requireSame(inode(await guardDirectory(parent)), identity)
  await guardDirectory(directory)
}
export async function writeNew(file: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  const parent = inode(await guardDirectory(path.dirname(file)))
  const handle = await fs.open(file, 'wx', mode)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  requireSame(inode(await guardDirectory(path.dirname(file))), parent)
}
export async function atomicFile(file: string, bytes: Buffer | string, expected: string | null): Promise<void> {
  const parent = inode(await guardDirectory(path.dirname(file)))
  const temp = path.join(path.dirname(file), '.publish-' + randomUUID())
  await writeNew(temp, bytes)
  const staged = await readRegular(temp, MAX_STORE_BYTES, true)
  try {
    const previous = await optionalRegular(file, MAX_STORE_BYTES, true)
    requireSame(previous === null ? null : digest(previous), expected, 'Managed metadata changed concurrently.')
    requireSame(inode(await guardDirectory(path.dirname(file))), parent)
    const latest = await readRegular(temp, MAX_STORE_BYTES, true)
    requireSame(inode(latest.stat), inode(staged.stat), 'Staging file was replaced.')
    requireSame(digest(latest.bytes), digest(bytes), 'Staging content changed.')
    await fs.rename(temp, file)
  } finally {
    if (inode(await guardDirectory(path.dirname(file))) === parent) {
      const remaining = await statOrNull(temp)
      if (remaining?.isFile() && !remaining.isSymbolicLink() && remaining.nlink === 1 && inode(remaining) === inode(staged.stat)) await fs.unlink(temp)
    }
  }
}

/** The same exclusive lease used by independent execution prevents cross-process integration/cleanup races. */
export async function withExecutionLease<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  const parent = inode(await guardDirectory(dataDir)), file = path.join(dataDir, 'execution.lock')
  let handle: fs.FileHandle
  try { handle = await fs.open(file, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorktreeError('WORKTREE_BUSY', 'Close the independent execution context before integration or cleanup.', 409); throw error }
  const identity = inode(await handle.stat())
  try { await handle.writeFile(randomUUID()); await handle.sync(); return await action() }
  finally {
    await handle.close()
    if (inode(await guardDirectory(dataDir)) === parent) {
      const current = await statOrNull(file)
      if (current?.isFile() && !current.isSymbolicLink() && current.nlink === 1 && inode(current) === identity) await fs.unlink(file)
    }
  }
}

export interface BaseEntry extends ObjectEntry { hash: string | null; bytes: number; text: boolean; excluded: boolean }
export interface AppliedEntry { path: string; hash: string | null; mode: string | null }
export interface RecordData {
  info: WorktreeInfo
  identities: { container: string; tree: string; data: string; git: string; admin: string }
  markerHash: string
  configHash: string
  base: BaseEntry[]
  integrated: AppliedEntry[]
  removedAt?: string
  pendingTransaction?: string
}
export interface StoreData { version: 1; repositoryId: string; identity: string; revision: number; records: RecordData[] }
export interface StoreState { data: StoreData; hash: string | null }
export interface Context { repo: Repository; identity: string; storeDir: string; storeIdentity: string; storeFile: string; head: string | null }
export function locations(context: Context, id: string) {
  assertId(id)
  const container = path.join(context.storeDir, id)
  return { container, tree: path.join(container, 'tree'), data: path.join(container, 'data'), git: path.join(container, 'git'), admin: path.join(container, 'git', 'worktrees', 'tree') }
}
export async function storeRead(context: Context): Promise<StoreState> {
  const bytes = await optionalRegular(context.storeFile, MAX_STORE_BYTES, true)
  if (!bytes) return { data: { version: 1, repositoryId: context.repo.id, identity: context.identity, revision: 0, records: [] }, hash: null }
  try {
    const data = JSON.parse(bytes.toString('utf8')) as StoreData
    if (data.version !== 1 || data.repositoryId !== context.repo.id || data.identity !== context.identity || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.records) || data.records.length > 256) throw new Error('schema')
    const ids = new Set<string>(), tasks = new Set<string>()
    for (const record of data.records) {
      assertId(record.info.id)
      const loc = locations(context, record.info.id)
      if (ids.has(record.info.id) || typeof record.info.taskId !== 'string' || !record.info.taskId.trim() || record.info.taskId.length > 160 || /[\x00-\x1f]/.test(record.info.taskId) ||
          record.info.repositoryId !== context.repo.id || !samePath(record.info.path, loc.tree) || !samePath(record.info.dataDir, loc.data) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(record.info.commit) ||
          typeof record.info.createdAt !== 'string' || !Number.isFinite(Date.parse(record.info.createdAt)) || !Array.isArray(record.base) || record.base.length > LIMITS.maxFiles || !Array.isArray(record.integrated) || record.integrated.length > LIMITS.maxFiles + LIMITS.maxUntrackedFiles ||
          !HASH.test(record.markerHash) || !HASH.test(record.configHash) || Object.values(record.identities).length !== 5 || !Object.values(record.identities).every(value => HASH.test(value))) throw new Error('record')
      ids.add(record.info.id)
      if (record.pendingTransaction) assertId(record.pendingTransaction)
      if (!record.removedAt) { if (tasks.has(record.info.taskId)) throw new Error('duplicate task'); tasks.add(record.info.taskId) }
      const names = new Set<string>()
      for (const entry of record.base) {
        relativeFile(entry.path)
        if (names.has(entry.path) || !['100644', '100755', '120000', '160000'].includes(entry.mode) || entry.stage !== 0 || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(entry.oid) || (entry.hash !== null && !HASH.test(entry.hash)) || typeof entry.excluded !== 'boolean' || typeof entry.text !== 'boolean' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('base')
        names.add(entry.path)
      }
      names.clear()
      for (const entry of record.integrated) {
        relativeFile(entry.path)
        if (names.has(entry.path) || privatePath(entry.path) || (entry.hash !== null && !HASH.test(entry.hash)) || ![null, '100644', '100755'].includes(entry.mode)) throw new Error('integration')
        names.add(entry.path)
      }
    }
    return { data, hash: digest(bytes) }
  } catch { throw new WorktreeError('STORE_CORRUPT', 'Worktree metadata is invalid or belongs to another repository identity. No directories were changed.', 409) }
}
export async function storeSave(context: Context, state: StoreState): Promise<StoreState> {
  const data = { ...state.data, revision: state.data.revision + 1 }
  const bytes = Buffer.from(JSON.stringify(data))
  if (bytes.length > MAX_STORE_BYTES) throw new WorktreeError('LIMIT_EXCEEDED', 'Worktree metadata exceeds its size limit.', 413)
  await atomicFile(context.storeFile, bytes, state.hash)
  return { data, hash: digest(bytes) }
}
export async function withLock<T>(context: Context, run: () => Promise<T>): Promise<T> {
  const lock = path.join(context.storeDir, 'state.lock')
  await guardDirectory(context.storeDir)
  let handle: fs.FileHandle
  try { handle = await fs.open(lock, 'wx', 0o600) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new WorktreeError('STORE_BUSY', 'Another worktree operation owns the metadata lock. An interrupted lock is never removed automatically.', 409); throw error }
  const identity = inode(await handle.stat())
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() })); await handle.sync(); return await run() }
  finally {
    await handle.close()
    const current = await statOrNull(lock)
    if (current?.isFile() && !current.isSymbolicLink() && inode(current) === identity) await fs.unlink(lock)
  }
}

/** Only this fixed command can create a linked worktree. No user repository/config is a Git target. */
export async function registerWorktree(executable: string, common: string, tree: string, commit: string, op: Operation): Promise<void> {
  op.check()
  if (path.basename(common) !== 'git' || path.basename(tree) !== 'tree' || !samePath(path.dirname(common), path.dirname(tree)) || !UUID.test(path.basename(path.dirname(common))) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new WorktreeError('UNSAFE_PATH', 'Invalid private worktree registration.')
  await guardDirectory(common)
  const home = path.dirname(common)
  const config = ['core.hooksPath=' + path.join(common, 'empty-hooks').replaceAll('\\', '/'), 'core.fsmonitor=false', 'core.longpaths=true', 'core.untrackedCache=false', 'core.preloadIndex=false', 'core.autocrlf=false', 'core.attributesFile=', 'core.excludesFile=', 'core.pager=', 'maintenance.auto=false', 'gc.auto=0', 'protocol.allow=never', 'submodule.recurse=false', 'fetch.recurseSubmodules=false', 'credential.helper=']
  const argv = ['--no-pager', '--literal-pathspecs', '--no-replace-objects', '--git-dir=' + common, ...config.flatMap(value => ['-c', value]), 'worktree', 'add', '--detach', '--no-checkout', '--', tree, commit]
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: home, env: safeEnvironment(executable, home), shell: false, windowsHide: true, detached: shellSpawnDetached(), stdio: ['ignore', 'pipe', 'pipe'] })
    let bytes = 0, failure: Error | undefined
    const errors: Buffer[] = []
    const stop = (error: Error) => { if (!failure) { failure = error; killProcessTree(child) } }
    const abort = () => { try { op.check() } catch (error) { stop(error as Error) } }
    op.signal.addEventListener('abort', abort, { once: true })
    if (op.signal.aborted) abort()
    const collect = (data: Buffer) => { bytes += data.length; if (bytes > LIMITS.maxOutputBytes) stop(new WorktreeError('LIMIT_EXCEEDED', 'Git registration output exceeds its limit.', 413)) }
    child.stdout.on('data', collect)
    child.stderr.on('data', (data: Buffer) => { collect(data); if (bytes <= 4096) errors.push(data) })
    child.once('error', error => { failure ??= error })
    child.once('close', code => {
      op.signal.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new WorktreeError('GIT_FAILED', 'Private Git worktree registration failed: ' + Buffer.concat(errors).toString('utf8').slice(0, 600).replace(/[\x00-\x1f]/g, ' '), 422))
      else resolve()
    })
  })
  op.check()
}

export async function writeObject(common: string, type: string, bytes: Buffer, oid: string): Promise<void> {
  const directory = path.join(common, 'objects', oid.slice(0, 2))
  await ensureDirectory(directory)
  const target = path.join(directory, oid.slice(2))
  if (await statOrNull(target)) return
  await writeNew(target, deflateSync(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])), 0o444)
}
export async function copyCommitTrees(objects: GitObjects, common: string, commit: string, op: Operation): Promise<void> {
  const value = await objects.object(commit)
  const root = /^tree ([0-9a-f]+)\n/.exec(value.bytes.toString('utf8'))?.[1]
  if (value.type !== 'commit' || !root) throw new WorktreeError('UNSUPPORTED_REPOSITORY', 'Malformed baseline commit.')
  await writeObject(common, 'commit', value.bytes, commit)
  const seen = new Set<string>()
  const visit = async (oid: string, depth: number): Promise<void> => {
    op.check()
    if (seen.has(oid)) return
    if (depth > 64 || seen.size > LIMITS.maxFiles * 2 + 64) throw new WorktreeError('LIMIT_EXCEEDED', 'Baseline tree metadata exceeds its limit.', 413)
    seen.add(oid)
    const object = await objects.object(oid)
    if (object.type !== 'tree') throw new WorktreeError('UNSAFE_REPOSITORY', 'A baseline directory is not a Git tree.')
    await writeObject(common, 'tree', object.bytes, oid)
    const size = objects.isolated.repo.format === 'sha1' ? 20 : 32
    for (let offset = 0; offset < object.bytes.length;) {
      const space = object.bytes.indexOf(32, offset), nul = object.bytes.indexOf(0, space + 1)
      if (space < offset || nul < space || nul + 1 + size > object.bytes.length) throw new WorktreeError('UNSAFE_REPOSITORY', 'Malformed baseline tree.')
      if (object.bytes.subarray(offset, space).toString('ascii') === '40000') await visit(object.bytes.subarray(nul + 1, nul + 1 + size).toString('hex'), depth + 1)
      offset = nul + 1 + size
    }
  }
  await visit(root, 0)
}
/** A v3 index made from raw committed objects, never checkout/add/filter/smudge. */
export function makeIndex(entries: BaseEntry[], format: Repository['format']): Buffer {
  const header = Buffer.alloc(12); header.write('DIRC'); header.writeUInt32BE(3, 4); header.writeUInt32BE(entries.length, 8)
  const rows = [...entries].sort((a, b) => order(a.path, b.path)).map(entry => {
    const name = Buffer.from(entry.path), oid = Buffer.from(entry.oid, 'hex')
    const fixed = 40 + oid.length + 2 + (entry.excluded ? 2 : 0)
    const row = Buffer.alloc(Math.ceil((fixed + name.length + 1) / 8) * 8)
    row.writeUInt32BE(parseInt(entry.mode, 8), 24)
    row.writeUInt32BE(entry.bytes, 36)
    oid.copy(row, 40)
    row.writeUInt16BE(Math.min(name.length, 0xfff) | (entry.excluded ? 0x4000 : 0), 40 + oid.length)
    if (entry.excluded) row.writeUInt16BE(0x4000, 42 + oid.length)
    name.copy(row, fixed)
    return row
  })
  const content = Buffer.concat([header, ...rows])
  return Buffer.concat([content, createHash(format).update(content).digest()])
}

export async function validateRecord(context: Context, record: RecordData): Promise<void> {
  const loc = locations(context, record.info.id)
  for (const key of ['container', 'tree', 'data', 'git', 'admin'] as const) requireSame(inode(await guardDirectory(loc[key])), record.identities[key], 'A managed worktree directory was replaced; refusing to operate on it.')
  requireSame(digest((await readRegular(path.join(loc.tree, '.git'), LIMITS.maxMetadataBytes, true)).bytes), record.markerHash, 'The managed Git pointer changed.')
  requireSame(digest((await readRegular(path.join(loc.git, 'config'), LIMITS.maxMetadataBytes, true)).bytes), record.configHash, 'Private Git configuration changed.')
  const head = (await readRegular(path.join(loc.admin, 'HEAD'), 256, true)).bytes.toString('utf8').trim()
  requireSame(head, record.info.commit, 'The managed worktree HEAD changed; only the pinned detached baseline is supported.')
  const common = (await readRegular(path.join(loc.admin, 'commondir'), 4096, true)).bytes.toString('utf8').trim()
  const gitdir = (await readRegular(path.join(loc.admin, 'gitdir'), 4096, true)).bytes.toString('utf8').trim()
  if (!samePath(path.resolve(loc.admin, common), loc.git) || !samePath(path.resolve(loc.admin, gitdir), path.join(loc.tree, '.git'))) throw new WorktreeError('UNSAFE_REPOSITORY', 'Linked-worktree metadata no longer belongs to this managed directory.')
}

export interface FileState { kind: 'missing' | 'file' | 'special'; hash: string | null; mode: string | null; identity: string | null; bytes?: Buffer; parents: [string, string][] }
export const stateKey = (state: FileState): string => digestParts([state.kind, state.hash, state.mode, state.identity, state.parents])
export const contentKey = (state: FileState): string => digestParts([state.kind, state.hash, state.mode, state.identity])
export async function inspectFile(root: string, name: string, fileMode: boolean, defaultMode = '100644', metadataOnly = false): Promise<FileState> {
  relativeFile(name)
  const parents: [string, string][] = []
  let directory = root
  parents.push([directory, inode(await guardDirectory(directory))])
  for (const component of name.split('/').slice(0, -1)) {
    directory = path.join(directory, component)
    const info = await statOrNull(directory)
    if (!info) return { kind: 'missing', hash: null, mode: null, identity: null, parents }
    if (!info.isDirectory() || info.isSymbolicLink()) return { kind: 'special', hash: digestParts(['blocked-parent', inode(info)]), mode: null, identity: inode(info), parents }
    parents.push([directory, inode(await guardDirectory(directory))])
  }
  const target = path.join(root, ...name.split('/'))
  const stat = await statOrNull(target)
  if (!stat) return { kind: 'missing', hash: null, mode: null, identity: null, parents }
  if (metadataOnly || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { kind: 'special', hash: digestParts(['special', inode(stat), stat.size, stat.mtimeMs, stat.ctimeMs]), mode: null, identity: inode(stat), parents }
  const read = await readRegular(target, LIMITS.maxFileBytes, true)
  return { kind: 'file', hash: digest(read.bytes), mode: fileMode ? (read.stat.mode & 0o111 ? '100755' : '100644') : defaultMode, identity: inode(read.stat), bytes: read.bytes, parents }
}
export async function verifyParents(parents: [string, string][]): Promise<void> { for (const [directory, identity] of parents) requireSame(inode(await guardDirectory(directory)), identity, 'A destination parent directory was replaced.') }
/** Remove only an identity-pinned private tree. Linked children are unlinked, never traversed. */
export async function removeOwned(directory: string, expected: string): Promise<void> {
  requireSame(inode(await guardDirectory(directory)), expected, 'Refusing to remove a replaced managed directory.')
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    const info = await fs.lstat(target)
    requireSame(inode(await guardDirectory(directory)), expected)
    if (info.isDirectory() && !info.isSymbolicLink()) await removeOwned(target, inode(info))
    else await fs.unlink(target)
  }
  requireSame(inode(await guardDirectory(directory)), expected)
  await fs.rmdir(directory)
}
