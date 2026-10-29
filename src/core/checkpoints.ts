/** Per-turn file preimages. No Git reset, workspace scan or external-file restore.
 * Journal the intended change before touching a file: an interrupted write is
 * either recognized by its hash or reported as a conflict, never guessed away. */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Plugin } from '../kernel/index.js'
import { isSessionId, type SessionService } from './session.js'
import type { CheckpointTarget, ToolContext } from './types.js'

const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024
type FileState = { sha256: string; size: number; mode: number } | null
interface Change { kind: 'change'; id: string; turnSeq: number; workspace: string; file: string; before: FileState; after: FileState }
interface Untracked { kind: 'untracked'; turnSeq: number; file: string; reason: string }
type Journal = Change | Untracked | { kind: 'cancel'; id: string } | { kind: 'restore'; ids: string[]; transaction: string }
interface PlannedFile {
  file: string
  before: FileState
  after: FileState
  current: FileState
  ids: string[]
  conflict: string | null
}
export interface CheckpointPlan {
  sessionId: string
  turnSeq: number
  fingerprint: string
  files: PlannedFile[]
  untracked: Array<{ file: string; reason: string }>
}
export class CheckpointError extends Error {
  constructor(readonly code: 'ECONFLICT' | 'EINVAL' | 'EIO', message: string) {
    super(message); this.name = 'CheckpointError'
  }
}

const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
const equal = (a: FileState, b: FileState) => a === null || b === null ? a === b : a.sha256 === b.sha256 && a.mode === b.mode && a.size === b.size
const samePath = (a: string, b: string) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
const inside = (root: string, file: string) => { const rel = path.relative(root, file); return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) }

function portable(file: unknown): file is string {
  return typeof file === 'string' && file.length <= 4096 && !file.includes('\\') &&
    file.split('/').every(part => !!part && part.length <= 255 && part !== '.' && part !== '..' &&
      !/[\x00-\x1f\x7f<>:"|?*]/.test(part) && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
}
function validState(value: unknown): value is FileState {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const row = value as Exclude<FileState, null>
  return /^[a-f0-9]{64}$/.test(row.sha256) && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= MAX_FILE_BYTES &&
    Number.isInteger(row.mode) && row.mode >= 0 && row.mode <= 0o777
}

/** Reject symlinks/junctions at every existing component, including the root. */
async function ordinary(file: string, directory = false): Promise<void> {
  const root = path.parse(path.resolve(file)).root
  let current = root
  for (const part of path.relative(root, file).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = await fs.lstat(current) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    if (info.isSymbolicLink() || (current !== file || directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
      throw new CheckpointError('EINVAL', '路径含符号链接、联接、硬链接或非普通文件，不能安全回滚。')
    }
  }
}

async function capture(file: string): Promise<{ state: FileState; bytes: Buffer | null }> {
  await ordinary(file)
  let info
  try { info = await fs.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: null, bytes: null }; throw error }
  if (info.size > MAX_FILE_BYTES) throw new CheckpointError('EINVAL', '文件超过 8 MiB，不能安全保存回滚快照。')
  const bytes = await fs.readFile(file)
  const after = await fs.lstat(file)
  if (bytes.length > MAX_FILE_BYTES || info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || after.isSymbolicLink() || after.nlink !== 1) {
    throw new CheckpointError('ECONFLICT', '文件正在被其他程序修改，请稍后重试。')
  }
  return { state: { sha256: hash(bytes), size: bytes.length, mode: after.mode & 0o777 }, bytes }
}

export class CheckpointService {
  private chain: Promise<void> = Promise.resolve()
  constructor(private sessions: SessionService, readonly cwd: string) {}

  /** Serialize native filesystem tools with the whole branch/restore transaction. */
  locked<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private journalFile(dir: string): string { return path.join(dir, 'checkpoints.jsonl') }
  private blobFile(dir: string, sha256: string): string { return path.join(dir, 'checkpoints', sha256 + '.bin') }
  private target(file: string): string {
    const resolved = path.resolve(this.cwd, file)
    const relative = path.relative(this.cwd, resolved).split(path.sep).join('/')
    if (!inside(this.cwd, resolved) || !portable(relative) || relative.split('/').some(part => /^\.(git|sakura)$/i.test(part)) ||
        resolved === this.sessions.root || inside(this.sessions.root, resolved)) {
      throw new CheckpointError('EINVAL', '不回滚工作区外文件、内部会话数据或 Git 元数据。')
    }
    return relative
  }

  private async append(dir: string, record: Journal): Promise<void> {
    await ordinary(dir, true)
    await ordinary(this.journalFile(dir))
    await fs.appendFile(this.journalFile(dir), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
  }
  private async blob(dir: string, state: FileState, bytes: Buffer | null): Promise<void> {
    if (!state || !bytes) return
    const directory = path.join(dir, 'checkpoints')
    await ordinary(directory, true)
    await fs.mkdir(directory, { recursive: true })
    const file = this.blobFile(dir, state.sha256)
    await ordinary(file)
    try { await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await this.readBlob(dir, state)
    }
  }
  private async readBlob(dir: string, state: Exclude<FileState, null>): Promise<Buffer> {
    const file = this.blobFile(dir, state.sha256)
    await ordinary(file)
    const info = await fs.lstat(file)
    if (info.size !== state.size) throw new CheckpointError('EIO', '代码快照缺失或损坏，未覆盖项目文件。')
    const bytes = await fs.readFile(file)
    if (hash(bytes) !== state.sha256) throw new CheckpointError('EIO', '代码快照校验失败，未覆盖项目文件。')
    return bytes
  }

  private async journal(dir: string): Promise<{ rows: Journal[]; raw: string }> {
    const file = this.journalFile(dir)
    await ordinary(file)
    let info
    try { info = await fs.lstat(file) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rows: [], raw: '' }; throw error }
    if (info.size > MAX_JOURNAL_BYTES) throw new CheckpointError('EIO', '代码快照日志过大，请先备份；未执行回滚。')
    const raw = await fs.readFile(file, 'utf8'), rows: Journal[] = []
    for (const line of raw.split('\n').filter(line => line.trim())) {
      let row: Journal
      try { row = JSON.parse(line) as Journal } catch { throw new CheckpointError('EIO', '代码快照日志损坏，请保留原会话与项目文件。') }
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new CheckpointError('EIO', '代码快照记录无效，未执行回滚。')
      const valid = row.kind === 'change' ? typeof row.id === 'string' && Number.isSafeInteger(row.turnSeq) && row.turnSeq > 0 &&
        typeof row.workspace === 'string' && path.isAbsolute(row.workspace) && portable(row.file) && validState(row.before) && validState(row.after)
        : row.kind === 'untracked' ? Number.isSafeInteger(row.turnSeq) && row.turnSeq > 0 && typeof row.file === 'string' && typeof row.reason === 'string'
          : row.kind === 'cancel' ? typeof row.id === 'string'
            : row.kind === 'restore' && Array.isArray(row.ids) && row.ids.every(id => typeof id === 'string') && typeof row.transaction === 'string'
      if (!valid) throw new CheckpointError('EIO', '代码快照记录无效，未执行回滚。')
      rows.push(row)
    }
    return { rows, raw }
  }

  /** Only real user-turn contexts create snapshots; direct tool consumers keep
   * their existing behavior. A snapshot disk failure prevents a tracked write. */
  write(file: string, bytes: Buffer, tc: ToolContext, expected?: Buffer): Promise<void> {
    file = path.resolve(this.cwd, file)
    return this.locked(async () => {
      tc.signal.throwIfAborted()
      const owner: CheckpointTarget | undefined = tc.checkpoint
      const session = owner && isSessionId(owner.sessionId) ? await this.sessions.open(owner.sessionId) : undefined
      let relative = '', before: Awaited<ReturnType<typeof capture>> | undefined, reason = ''
      if (session) {
        if (!session.events.some(record => record.seq === owner!.turnSeq && record.type === 'user/message')) throw new CheckpointError('EINVAL', '找不到代码修改所属的用户回合。')
        try {
          relative = this.target(file)
          if (bytes.length > MAX_FILE_BYTES) throw new CheckpointError('EINVAL', '文件超过 8 MiB，不提供自动代码回滚。')
          before = await capture(file)
        } catch (error) {
          if (!(error instanceof CheckpointError) || error.code !== 'EINVAL') throw error
          reason = error.message
        }
      }
      if (expected && !(await fs.readFile(file)).equals(expected)) throw new CheckpointError('ECONFLICT', '文件已改变，请重新读取后编辑。')
      let change: Change | undefined
      if (session && before) {
        const after: FileState = { sha256: hash(bytes), size: bytes.length, mode: before.state?.mode ?? (0o666 & ~process.umask()) }
        change = { kind: 'change', id: randomUUID(), turnSeq: owner!.turnSeq, workspace: path.resolve(this.cwd), file: relative, before: before.state, after }
        await this.blob(session.dir, before.state, before.bytes)
        await this.blob(session.dir, after, bytes)
        await this.append(session.dir, change)
      } else if (session) await this.append(session.dir, { kind: 'untracked', turnSeq: owner!.turnSeq, file: relative || path.basename(file), reason })
      try {
        tc.signal.throwIfAborted()
        if (before && !equal((await capture(file)).state, before.state)) throw new CheckpointError('ECONFLICT', '文件已改变，代码未写入；请重新读取。')
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, bytes)
      } catch (error) {
        if (session && change && equal((await capture(file)).state, change.before)) await this.append(session.dir, { kind: 'cancel', id: change.id })
        throw error
      }
    })
  }

  async plan(sessionId: string, turnSeq: number): Promise<CheckpointPlan> {
    const session = await this.sessions.open(sessionId), { rows, raw } = await this.journal(session.dir)
    const excluded = new Set(rows.flatMap(row => row.kind === 'cancel' ? [row.id] : row.kind === 'restore' ? row.ids : []))
    const groups = new Map<string, PlannedFile>()
    for (const row of rows) {
      if (row.kind !== 'change' || row.turnSeq < turnSeq || excluded.has(row.id)) continue
      const key = process.platform === 'win32' ? row.file.toLowerCase() : row.file
      const prior = groups.get(key)
      const workspaceConflict = !samePath(row.workspace, this.cwd) ? '快照来自其他工作区，不能应用到当前项目。' : null
      if (prior) {
        if (!equal(prior.after, row.before)) prior.conflict = '文件在工具修改之间有额外改动，不能安全回滚。'
        prior.after = row.after; prior.ids.push(row.id)
        if (workspaceConflict) prior.conflict = workspaceConflict
      } else groups.set(key, { file: row.file, before: row.before, after: row.after, current: null, ids: [row.id], conflict: workspaceConflict })
    }
    const files = [...groups.values()]
    for (const row of files) {
      if (row.conflict === '快照来自其他工作区，不能应用到当前项目。') continue
      try {
        const file = path.resolve(this.cwd, row.file)
        this.target(file)
        row.current = (await capture(file)).state
        if (!equal(row.current, row.after) && !equal(row.current, row.before)) row.conflict = '文件已被手动修改、删除或由其他任务改写，未强制覆盖。'
        if (row.before) await this.readBlob(session.dir, row.before)
        if (row.after) await this.readBlob(session.dir, row.after)
      } catch (error) { row.conflict = error instanceof CheckpointError ? error.message : '文件或快照不可读，不能安全回滚。' }
    }
    const untracked = rows.filter((row): row is Untracked => row.kind === 'untracked' && row.turnSeq >= turnSeq).map(({ file, reason }) => ({ file, reason }))
    return { sessionId, turnSeq, files, untracked, fingerprint: hash(JSON.stringify({ cwd: path.resolve(this.cwd), sessionId, turnSeq, raw, files, untracked })) }
  }

  /** Called under locked(). Preflight every blob before the first write; on an
   * I/O failure compensate only files still matching our own restored image. */
  async restore(plan: CheckpointPlan, assertIdle: () => void): Promise<number> {
    const fresh = await this.plan(plan.sessionId, plan.turnSeq)
    if (fresh.fingerprint !== plan.fingerprint || fresh.files.some(row => row.conflict)) throw new CheckpointError('ECONFLICT', '代码或快照已改变，请刷新回滚预览；项目文件未覆盖。')
    const session = await this.sessions.open(plan.sessionId)
    const prepared = await Promise.all(fresh.files.map(async row => ({ row, before: row.before ? await this.readBlob(session.dir, row.before) : null,
      after: row.after ? await this.readBlob(session.dir, row.after) : null })))
    assertIdle()
    const completed: typeof prepared = [], transaction = randomUUID()
    try {
      for (const entry of prepared) {
        assertIdle()
        if (equal(entry.row.current, entry.row.before)) continue
        await this.replace(entry.row.file, entry.row.after, entry.row.before, entry.before)
        completed.push(entry)
      }
      assertIdle()
      await this.append(session.dir, { kind: 'restore', transaction, ids: fresh.files.flatMap(row => row.ids) })
      return completed.length
    } catch (error) {
      const failures: string[] = []
      for (const entry of completed.reverse()) {
        try { await this.replace(entry.row.file, entry.row.before, entry.row.after, entry.after) }
        catch { failures.push(entry.row.file) }
      }
      if (failures.length) throw new CheckpointError('EIO', '回滚未完成，且这些文件需人工恢复（快照仍保留）：' + failures.join('、'))
      throw error
    }
  }

  private async replace(relative: string, expected: FileState, next: FileState, bytes: Buffer | null): Promise<void> {
    const file = path.resolve(this.cwd, relative)
    this.target(file)
    if (!equal((await capture(file)).state, expected)) throw new CheckpointError('ECONFLICT', '文件在回滚期间发生变化，已停止覆盖。')
    if (next === null) { await fs.unlink(file); return }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await ordinary(path.dirname(file), true)
    const temporary = path.join(path.dirname(file), '.sakura-restore-' + randomUUID())
    try {
      await fs.writeFile(temporary, bytes!, { flag: 'wx', mode: next.mode })
      await fs.chmod(temporary, next.mode)
      if (!equal((await capture(file)).state, expected)) throw new CheckpointError('ECONFLICT', '文件在回滚期间发生变化，已停止覆盖。')
      await fs.rename(temporary, file)
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }

  /** Make earlier checkpoints independent of the original session's lifetime. */
  async inherit(sourceId: string, destinationId: string, seqMap: Map<number, number>): Promise<void> {
    const source = await this.sessions.open(sourceId), destination = await this.sessions.open(destinationId)
    const { rows } = await this.journal(source.dir)
    const excluded = new Set(rows.flatMap(row => row.kind === 'cancel' ? [row.id] : row.kind === 'restore' ? row.ids : []))
    for (const row of rows) {
      if (row.kind !== 'change' && row.kind !== 'untracked' || !seqMap.has(row.turnSeq) || row.kind === 'change' && excluded.has(row.id)) continue
      if (row.kind === 'change') {
        for (const state of [row.before, row.after]) if (state) await this.blob(destination.dir, state, await this.readBlob(source.dir, state))
      }
      await this.append(destination.dir, { ...row, turnSeq: seqMap.get(row.turnSeq)! })
    }
  }
}

export const checkpointsPlugin: Plugin = {
  name: 'core-checkpoints',
  description: 'Persistent per-turn write/edit preimages and conflict-safe code restore',
  inject: ['sessions'],
  apply(ctx, config: { cwd?: string } = {}, sessions: unknown) {
    ctx.provide('checkpoints')
    ctx.set('checkpoints', new CheckpointService(sessions as SessionService, path.resolve(config.cwd ?? process.cwd())))
  },
}