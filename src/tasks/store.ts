/** Workspace task ledger. All writers compare content revisions and publish by rename. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { TaskError, TASK_LIMITS, type TaskCard, type TaskCheck, type TaskRevision, type TaskRun,
  type TaskSnapshot, type TaskState, type TaskStatus } from './types.js'

const activeOwners = new Set<string>()
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const clone = <T>(value: T): T => structuredClone(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`
const key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)
const statuses: TaskStatus[] = ['pending', 'in_progress', 'completed']
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaskError(400, 'expected an object')
  return value as Record<string, unknown>
}
const text = (value: unknown, max: number, required = false): string => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || required && !value.trim()) {
    throw new TaskError(400, 'invalid or oversized task text')
  }
  return value
}
const empty = (): TaskState => ({ version: 1, revision: 0, tasks: [], checks: [], runs: [] })
const date = () => new Date().toISOString()
const requireRevision = (value: TaskRevision) => {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    throw new TaskError(400, 'a current task revision and fingerprint are required')
  }
}

export function checksHash(checks: readonly TaskCheck[]): string { return hash(JSON.stringify(checks)) }
export function definitionHash(task: Pick<TaskCard, 'title' | 'description' | 'criteria' | 'checkIds' | 'steps'>): string {
  return hash(JSON.stringify({ title: task.title, description: task.description, criteria: task.criteria,
    checkIds: task.checkIds, steps: task.steps.map(step => ({ id: step.id, content: step.content })) }))
}
export function validateCheck(value: unknown): TaskCheck {
  const row = object(value)
  if (!id(row.id) || !['bash', 'pwsh'].includes(String(row.shell)) || typeof row.required !== 'boolean') throw new TaskError(400, 'invalid validation command')
  const workdir = text(row.workdir ?? '.', 512, true).replace(/\\/g, '/')
  if (workdir !== '.' && (path.posix.isAbsolute(workdir) || path.win32.isAbsolute(workdir) || /[\u0000-\u001f<>:"|?*]/.test(workdir) ||
    workdir.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new TaskError(400, 'validation directory must be relative to this workspace')
  }
  if (!Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 100 || Number(row.timeoutMs) > 600_000) throw new TaskError(400, 'validation timeout must be 100–600000ms')
  return { id: row.id, name: text(row.name, 120, true), shell: row.shell as TaskCheck['shell'], command: text(row.command, 8000, true),
    workdir, timeoutMs: Number(row.timeoutMs), required: row.required }
}
function validateCard(value: unknown, previous?: TaskCard): TaskCard {
  const row = object(value)
  const allowed = ['id', 'title', 'description', 'priority', 'status', 'steps', 'criteria', 'checkIds', 'archived', 'sessionId', 'userSeq']
  if (Object.keys(row).some(name => !allowed.includes(name))) throw new TaskError(400, 'task evidence and acceptance are not editable fields')
  if (row.id !== undefined && !id(row.id) || !statuses.includes(row.status as TaskStatus) || !['high', 'medium', 'low'].includes(String(row.priority)) || typeof row.archived !== 'boolean') {
    throw new TaskError(400, 'invalid task fields')
  }
  if (!Array.isArray(row.steps) || row.steps.length > TASK_LIMITS.steps || !Array.isArray(row.criteria) || row.criteria.length > TASK_LIMITS.criteria ||
      !Array.isArray(row.checkIds) || row.checkIds.length > TASK_LIMITS.taskChecks || row.checkIds.some(value => !id(value))) throw new TaskError(400, 'invalid task steps, criteria or checks')
  const steps = row.steps.map(value => { const step = object(value)
    if (!id(step.id) || !statuses.includes(step.status as TaskStatus)) throw new TaskError(400, 'invalid task step')
    return { id: step.id, content: text(step.content, 1000, true), status: step.status as TaskStatus }
  })
  if (new Set(steps.map(step => step.id)).size !== steps.length || new Set(row.checkIds).size !== row.checkIds.length) throw new TaskError(400, 'duplicate task steps or checks')
  if (row.sessionId !== undefined && !id(row.sessionId) || row.userSeq !== undefined && (!Number.isSafeInteger(row.userSeq) || Number(row.userSeq) < 1)) throw new TaskError(400, 'invalid session reference')
  const task: TaskCard = { id: typeof row.id === 'string' ? row.id : randomUUID(), title: text(row.title, 200, true), description: text(row.description, 12_000),
    priority: row.priority as TaskCard['priority'], status: row.status as TaskStatus, steps, criteria: row.criteria.map(value => text(value, 2000, true)),
    checkIds: row.checkIds as string[], archived: row.archived, createdAt: previous?.createdAt ?? date(), updatedAt: date(), definitionHash: '',
    ...(row.sessionId ? { sessionId: row.sessionId as string } : {}), ...(row.userSeq ? { userSeq: Number(row.userSeq) } : {}) }
  task.definitionHash = definitionHash(task)
  if (previous?.acceptance && task.definitionHash === previous.definitionHash) task.acceptance = clone(previous.acceptance)
  return task
}
function validateDisk(value: unknown): TaskState {
  const raw = object(value)
  if (raw.version !== 1 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !Array.isArray(raw.tasks) || raw.tasks.length > TASK_LIMITS.tasks ||
      !Array.isArray(raw.checks) || raw.checks.length > TASK_LIMITS.checks || !Array.isArray(raw.runs) || raw.runs.length > TASK_LIMITS.runs) throw new TaskError(409, 'task ledger has an unsupported shape')
  const checks = raw.checks.map(validateCheck)
  const tasks = raw.tasks.map(value => {
    const row = object(value)
    if (!id(row.id)) throw new TaskError(409, 'invalid saved task ID')
    const { createdAt, updatedAt, definitionHash: savedHash, acceptance, ...editable } = row
    const task = validateCard(editable)
    if (savedHash !== task.definitionHash) throw new TaskError(409, 'task definition fingerprint does not match')
    task.createdAt = text(createdAt, 40, true); task.updatedAt = text(updatedAt, 40, true)
    if (acceptance !== undefined) { const a = object(acceptance)
      if (a.definitionHash !== savedHash || a.runId !== undefined && !id(a.runId)) throw new TaskError(409, 'invalid saved acceptance')
      task.acceptance = { at: text(a.at, 40, true), definitionHash: savedHash as string, note: text(a.note, 2000), ...(a.runId ? { runId: String(a.runId) } : {}) }
    }
    return task
  })
  const runs = raw.runs.map(value => {
    const run = object(value)
    if (!id(run.id) || !id(run.taskId) || !['awaiting_approval', 'running', 'passed', 'failed', 'interrupted', 'denied'].includes(String(run.status)) ||
      !Array.isArray(run.results) || !run.results.length || run.results.length > TASK_LIMITS.taskChecks || !/^[a-f0-9]{64}$/.test(String(run.checksHash)) ||
      !/^[a-f0-9]{64}$/.test(String(run.definitionHash))) throw new TaskError(409, 'invalid saved validation report')
    text(run.startedAt, 40, true)
    if (run.endedAt !== undefined) text(run.endedAt, 40, true)
    if (run.error !== undefined) text(run.error, 2000)
    if (run.sessionId !== undefined && !id(run.sessionId)) throw new TaskError(409, 'invalid report session')
    for (const value of run.results) {
      const result = object(value); validateCheck(result)
      if (!id(result.callId) || !['not_run', 'awaiting_approval', 'running', 'passed', 'failed', 'interrupted', 'denied', 'skipped'].includes(String(result.status)) ||
          result.exitCode !== null && !Number.isInteger(result.exitCode) || typeof result.truncated !== 'boolean') throw new TaskError(409, 'invalid check result')
      if (typeof result.output !== 'string' || result.output.length > TASK_LIMITS.logChars) throw new TaskError(409, 'invalid or oversized command log')
      if (result.note !== undefined) text(result.note, 2000)
      if (result.execution !== undefined) { const execution = object(result.execution)
        if (!['exit', 'timeout', 'cancelled', 'spawn_error'].includes(String(execution.reason)) || execution.exitCode !== null && !Number.isInteger(execution.exitCode) ||
          typeof execution.truncated !== 'boolean' || !Number.isSafeInteger(execution.outputBytes) || Number(execution.outputBytes) < 0) throw new TaskError(409, 'invalid command evidence')
        text(execution.startedAt, 40, true); text(execution.endedAt, 40, true)
      }
      if (result.status === 'passed' && (result.exitCode !== 0 || object(result.execution).reason !== 'exit')) throw new TaskError(409, 'passing result has no successful process evidence')
    }
    return clone(value) as TaskRun
  })
  if ([tasks.map(row => row.id), checks.map(row => row.id), runs.map(row => row.id)].some(ids => new Set(ids).size !== ids.length)) throw new TaskError(409, 'duplicate task ledger IDs')
  const state: TaskState = { version: 1, revision: Number(raw.revision), tasks, checks, runs }
  if (raw.active !== undefined) { const active = object(raw.active)
    if (!id(active.owner) || !id(active.runId) || !Number.isSafeInteger(active.pid) || Number(active.pid) <= 0 || !runs.some(run => run.id === active.runId)) throw new TaskError(409, 'invalid active validation owner')
    state.active = { owner: active.owner, pid: Number(active.pid), runId: active.runId }
  }
  return state
}

export function validateTaskBackup(value: unknown): TaskState { return validateDisk(value) }

/** Restored evidence is historical, never an active process or fresh acceptance. */
export function restoredTaskState(value: unknown, restoredAt: string): TaskState {
  const state = validateDisk(value)
  delete state.active
  for (const task of state.tasks) delete task.acceptance
  for (const run of state.runs) {
    const old = run.status
    run.status = 'interrupted'; run.endedAt ??= restoredAt
    run.error = `Restored historical report (${old}); rerun validation in this workspace before accepting.`
    for (const result of run.results) if (['running', 'awaiting_approval'].includes(result.status)) {
      result.status = 'interrupted'; result.exitCode = null; result.note = 'Restored history; no command was replayed.'
    }
  }
  return state
}

export class TaskStore {
  readonly root: string
  private readonly dir: string
  private readonly file: string
  private chain: Promise<unknown> = Promise.resolve()
  constructor(cwd: string) { this.root = path.resolve(cwd); this.dir = path.join(this.root, '.sakura', 'tasks'); this.file = path.join(this.dir, 'state.json') }

  private async directory(create = false): Promise<boolean> {
    for (const directory of [this.root, path.join(this.root, '.sakura'), this.dir]) {
      let stat: Stats
      try { stat = await fs.lstat(directory) }
      catch (error) {
        if (!missing(error)) throw error
        if (!create || directory === this.root) return false
        await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
        stat = await fs.lstat(directory)
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || key(await fs.realpath(directory)) !== key(directory)) throw new TaskError(409, 'task directories must be real workspace directories')
    }
    return true
  }
  private async disk(): Promise<{ state: TaskState; fingerprint: string }> {
    if (!await this.directory()) return { state: empty(), fingerprint: hash('missing') }
    let before: Stats
    try { before = await fs.lstat(this.file) } catch (error) { if (missing(error)) return { state: empty(), fingerprint: hash('missing') }; throw error }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > TASK_LIMITS.bytes) throw new TaskError(409, 'task ledger must be a bounded ordinary file')
    const handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: string
    try {
      if (identity(await handle.stat()) !== identity(before)) throw new TaskError(409, 'task ledger changed while opening')
      const bytes = Buffer.alloc(Math.min(TASK_LIMITS.bytes, before.size) + 1)
      let size = 0
      while (size < bytes.length) { const read = await handle.read(bytes, size, bytes.length - size, null); if (!read.bytesRead) break; size += read.bytesRead }
      if (size !== before.size || identity(await handle.stat()) !== identity(before)) throw new TaskError(409, 'task ledger changed while reading')
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
    } finally { await handle.close() }
    await this.directory()
    if (identity(await fs.lstat(this.file)) !== identity(before)) throw new TaskError(409, 'task ledger was replaced')
    try { return { state: validateDisk(JSON.parse(raw)), fingerprint: hash(raw) } }
    catch { throw new TaskError(409, 'task ledger is invalid; original data has been preserved') }
  }
  private projected(state: TaskState, fingerprint: string): TaskSnapshot {
    return { revision: state.revision, fingerprint, tasks: clone(state.tasks), checks: clone(state.checks), runs: state.runs.map(({ results, ...run }) => ({ ...clone(run),
      checks: results.map(({ id, name, required, status, exitCode }) => ({ id, name, required, status, exitCode })) })) }
  }
  private async transact(expected: TaskRevision | undefined, change: (state: TaskState) => void, current: () => void = () => {}): Promise<TaskSnapshot> {
    const operation = this.chain.catch(() => {}).then(async () => {
      current(); await this.directory(true); current()
      const directories = await Promise.all([this.root, path.dirname(this.dir), this.dir].map(async file => ({ file, stat: await fs.lstat(file) })))
      const checkDirectories = async () => {
        await this.directory()
        for (const original of directories) {
          const latest = await fs.lstat(original.file)
          if (!latest.isDirectory() || latest.isSymbolicLink() || latest.dev !== original.stat.dev || latest.ino !== original.stat.ino) throw new TaskError(409, 'task directory changed during save')
        }
      }
      const lockPath = path.join(this.dir, 'write.lock')
      let lock
      try { lock = await fs.open(lockPath, 'wx', 0o600) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new TaskError(409, 'task ledger is locked; retry after the other writer finishes'); throw error }
      let temp: string | undefined
      try {
        await lock.writeFile(randomUUID()); const before = await this.disk()
        if (expected && (expected.revision !== before.state.revision || expected.fingerprint !== before.fingerprint)) throw new TaskError(409, 'tasks changed; reload before saving')
        change(before.state)
        if (before.state.revision >= Number.MAX_SAFE_INTEGER) throw new TaskError(409, 'task revision exhausted')
        before.state.revision++
        validateDisk(before.state)
        const raw = JSON.stringify(before.state) + '\n'
        if (Buffer.byteLength(raw) > TASK_LIMITS.bytes) throw new TaskError(413, 'task history is full; export reports before adding more')
        temp = path.join(this.dir, `.tasks-${randomUUID()}.tmp`)
        const handle = await fs.open(temp, 'wx', 0o600)
        let staged: Stats
        try { await handle.writeFile(raw); await handle.sync(); staged = await handle.stat() } finally { await handle.close() }
        const latest = await this.disk()
        if (latest.fingerprint !== before.fingerprint) throw new TaskError(409, 'task ledger changed during save')
        current(); await checkDirectories(); current()
        const stagedNow = await fs.lstat(temp), ownedLock = await lock.stat(), currentLock = await fs.lstat(lockPath)
        if (!stagedNow.isFile() || stagedNow.isSymbolicLink() || stagedNow.nlink !== 1 || identity(stagedNow) !== identity(staged) ||
          !currentLock.isFile() || currentLock.isSymbolicLink() || currentLock.nlink !== 1 || identity(currentLock) !== identity(ownedLock)) throw new TaskError(409, 'task staging file or lock changed during save')
        if ((await this.disk()).fingerprint !== before.fingerprint) throw new TaskError(409, 'task ledger changed before publication')
        await fs.rename(temp, this.file); temp = undefined
        return this.projected(before.state, hash(raw))
      } finally {
        if (temp) { try { await this.directory(); await fs.unlink(temp) } catch { /* Only our staging path is eligible for cleanup. */ } }
        const owned = await lock.stat(); await lock.close()
        const latest = await fs.lstat(lockPath).catch(() => undefined)
        if (latest?.isFile() && !latest.isSymbolicLink() && identity(latest) === identity(owned)) await fs.unlink(lockPath).catch(() => {})
      }
    })
    this.chain = operation
    try { return await operation }
    catch (error) { if (error instanceof TaskError) throw error; throw new TaskError(500, 'task data could not be saved; previous data was preserved') }
  }
  async snapshot(): Promise<TaskSnapshot> { const { state, fingerprint } = await this.disk(); return this.projected(state, fingerprint) }
  async recover(): Promise<void> {
    const { state, fingerprint } = await this.disk()
    if (!state.active) return
    if (activeOwners.has(state.active.owner)) return
    if (state.active.pid !== process.pid) {
      try { process.kill(state.active.pid, 0); return } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return }
    }
    await this.transact({ revision: state.revision, fingerprint }, saved => {
      const run = saved.runs.find(row => row.id === saved.active?.runId)
      if (run) { run.status = 'interrupted'; run.endedAt = date(); run.error = 'The previous validation stopped without a complete result. Process state is unknown; no command was replayed.'
        for (const result of run.results) if (['running', 'awaiting_approval'].includes(result.status)) { result.status = 'interrupted'; result.exitCode = null; result.note = 'Result unavailable after restart.' }
      }
      delete saved.active
    })
  }
  async upsert(value: unknown, expected: TaskRevision, current?: () => void): Promise<TaskSnapshot> {
    requireRevision(expected)
    return this.transact(expected, state => {
      if (state.active) throw new TaskError(409, 'validation is active; stop it before changing tasks')
      const raw = object(value); const previous = state.tasks.find(row => row.id === raw.id)
      if (raw.id !== undefined && !previous) throw new TaskError(404, 'task no longer exists')
      const task = validateCard(raw, previous)
      if (task.checkIds.some(id => !state.checks.some(check => check.id === id))) throw new TaskError(400, 'task references an unknown validation command')
      if (!previous && state.tasks.length >= TASK_LIMITS.tasks) throw new TaskError(413, 'too many saved tasks')
      if (previous) state.tasks[state.tasks.indexOf(previous)] = task
      else state.tasks.unshift(task)
    }, current)
  }
  async saveChecks(value: unknown, expected: TaskRevision, current?: () => void): Promise<TaskSnapshot> {
    requireRevision(expected)
    if (!Array.isArray(value) || value.length > TASK_LIMITS.checks) throw new TaskError(400, 'invalid command list')
    const checks = value.map(validateCheck)
    if (new Set(checks.map(check => check.id)).size !== checks.length) throw new TaskError(400, 'duplicate command IDs')
    return this.transact(expected, state => {
      if (state.active) throw new TaskError(409, 'validation is active')
      if (state.tasks.some(task => task.checkIds.some(id => !checks.some(check => check.id === id)))) throw new TaskError(409, 'remove command references from tasks before removing a command')
      if (checksHash(checks) !== checksHash(state.checks)) for (const task of state.tasks) delete task.acceptance
      state.checks = checks
    }, current)
  }
  async accept(taskId: string, note: string, expected: TaskRevision, current?: () => void): Promise<TaskSnapshot> {
    requireRevision(expected)
    text(note, 2000)
    return this.transact(expected, state => {
      if (state.active) throw new TaskError(409, 'wait for validation before accepting the task')
      const task = state.tasks.find(row => row.id === taskId)
      if (!task) throw new TaskError(404, 'task not found')
      if (task.status !== 'completed' || task.archived) throw new TaskError(409, 'complete the task before human acceptance')
      const run = state.runs.find(row => row.taskId === task.id)
      const checks = task.checkIds.map(id => state.checks.find(check => check.id === id)!)
      if (checks.some(check => check.required) && (!run || run.status !== 'passed' || run.definitionHash !== task.definitionHash || run.checksHash !== checksHash(checks))) throw new TaskError(409, 'required checks have not passed for the current task configuration')
      task.acceptance = { at: date(), definitionHash: task.definitionHash, note, ...(run ? { runId: run.id } : {}) }
    }, current)
  }
  async run(id: string): Promise<TaskRun> { const { state } = await this.disk(); const run = state.runs.find(row => row.id === id)
    if (!run) throw new TaskError(404, 'validation report not found'); return clone(run) }
  async begin(run: TaskRun, expected: TaskRevision, owner: string, current?: () => void): Promise<void> {
    requireRevision(expected)
    activeOwners.add(owner)
    try { await this.transact(expected, state => {
      if (state.active) throw new TaskError(409, 'another validation is already active')
      if (state.runs.length >= TASK_LIMITS.runs) throw new TaskError(413, 'validation history is full; existing reports are preserved')
      const task = state.tasks.find(row => row.id === run.taskId)
      if (!task || task.archived || task.definitionHash !== run.definitionHash) throw new TaskError(409, 'task changed before validation')
      state.runs.unshift(clone(run)); state.active = { owner, pid: process.pid, runId: run.id }; delete task.acceptance
    }, current) } catch (error) { activeOwners.delete(owner); throw error }
  }
  async saveRun(run: TaskRun, owner: string, finished = false): Promise<void> {
    await this.transact(undefined, state => {
      if (state.active?.owner !== owner || state.active.runId !== run.id) throw new TaskError(409, 'validation ownership changed')
      const index = state.runs.findIndex(row => row.id === run.id)
      if (index < 0) throw new TaskError(409, 'validation report disappeared')
      state.runs[index] = clone(run)
      if (finished) delete state.active
    })
    if (finished) activeOwners.delete(owner)
  }
  releaseOwner(owner: string): void { activeOwners.delete(owner) }
}
