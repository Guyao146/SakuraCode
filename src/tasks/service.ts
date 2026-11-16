/** Confirmed validation runs reuse the ordinary tool approval pipeline. */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ToolsService } from '../core/tools.js'
import { TaskStore, checksHash } from './store.js'
import { TaskError, TASK_LIMITS, type TaskRevision, type TaskRun, type TaskSnapshot, type TaskCodeState } from './types.js'

const live = new Set(['awaiting_approval', 'running'])
const clip = (value: string, max: number) => value.slice(0, max).replace(/[\uD800-\uDBFF]$/, '')
export class TasksService {
  readonly store: TaskStore
  private active?: { controller: AbortController; run: TaskRun; owner: string; done?: Promise<void> }
  private closed = false
  private failure?: string
  private codeReader?: (signal: AbortSignal) => Promise<TaskCodeState | undefined>
  constructor(readonly cwd: string, private tools: ToolsService, private changed: () => void = () => {}, dataCwd = cwd) { this.store = new TaskStore(dataCwd) }
  setCodeReader(reader: (signal: AbortSignal) => Promise<TaskCodeState | undefined>): void { this.codeReader = reader }
  isBusy(): boolean { return !!this.active }
  async snapshot(): Promise<TaskSnapshot & { activeRunId?: string; error?: string }> {
    const snapshot = await this.store.snapshot()
    return { ...snapshot, ...(this.active ? { activeRunId: this.active.run.id } : {}), ...(this.failure ? { error: this.failure } : {}) }
  }
  async initialize(): Promise<void> {
    try { await this.store.recover() }
    catch (error) { this.failure = error instanceof TaskError ? error.message : 'Task recovery failed; data was preserved.' }
  }
  async code(signal: AbortSignal = new AbortController().signal): Promise<TaskCodeState | undefined> { return this.codeReader?.(signal) }
  async report(runId: string, signal: AbortSignal = new AbortController().signal) {
    const run = await this.store.run(runId), snapshot = await this.store.snapshot()
    const task = snapshot.tasks.find(task => task.id === run.taskId)
    const currentChecks = task?.checkIds.map(id => snapshot.checks.find(check => check.id === id))
    let codeStale: boolean | null = null
    try { const current = await this.code(signal)
      if (run.code && current) codeStale = JSON.stringify(current) !== JSON.stringify(run.code)
    } catch { /* A missing or oversized repository is not a passing freshness check. */ }
    return { run, definitionStale: !task || task.definitionHash !== run.definitionHash || !currentChecks ||
      currentChecks.some(check => !check) || checksHash(currentChecks as typeof snapshot.checks) !== run.checksHash, codeStale }
  }
  async start(input: { taskId: string; expected: TaskRevision; agentId: string; sessionId?: string; skipIds?: string[] }, current: () => void = () => {}): Promise<TaskRun> {
    if (this.closed || this.active) throw new TaskError(409, 'validation is busy or shutting down')
    const controller = new AbortController(), owner = randomUUID()
    const run: TaskRun = { id: randomUUID(), taskId: input.taskId, ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      startedAt: new Date().toISOString(), status: 'awaiting_approval', definitionHash: '', checksHash: '', results: [] }
    let settled!: () => void
    const ticket = { controller, run, owner, done: new Promise<void>(resolve => { settled = resolve }) }
    this.active = ticket
    const valid = () => { if (this.closed) throw new TaskError(409, 'validation is shutting down'); controller.signal.throwIfAborted(); current() }
    let persisted = false
    try {
      current()
      const snapshot = await this.store.snapshot()
      if (snapshot.revision !== input.expected.revision || snapshot.fingerprint !== input.expected.fingerprint) throw new TaskError(409, 'tasks changed; reload before validation')
      const task = snapshot.tasks.find(task => task.id === input.taskId)
      if (!task || task.archived) throw new TaskError(404, 'active task not found')
      const checks = task.checkIds.map(id => snapshot.checks.find(check => check.id === id))
      if (!checks.length || checks.some(check => !check)) throw new TaskError(400, 'select saved validation commands first')
      const skip = input.skipIds ?? []
      if (!Array.isArray(skip) || new Set(skip).size !== skip.length || skip.some(id => !checks.some(check => check?.id === id && !check.required))) throw new TaskError(400, 'only selected optional checks can be skipped')
      run.definitionHash = task.definitionHash; run.checksHash = checksHash(checks as typeof snapshot.checks)
      for (const check of checks) {
        const directory = path.resolve(this.cwd, check!.workdir)
        const real = await fs.realpath(directory), root = await fs.realpath(this.cwd)
        const relative = path.relative(root, real)
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !(await fs.stat(real)).isDirectory()) throw new TaskError(400, 'validation directory must remain inside the workspace')
        run.results.push({ ...check!, callId: randomUUID(), status: skip.includes(check!.id) ? 'skipped' : 'not_run', exitCode: null, output: '', truncated: false,
          ...(skip.includes(check!.id) ? { note: 'Optional check explicitly skipped before execution.' } : {}) })
      }
      try { run.code = await this.code(controller.signal) }
      catch { run.codeNote = 'Repository fingerprint unavailable; source freshness is not verified.' }
      if (!run.code) run.codeNote ??= 'No tracked repository fingerprint; this report does not attest to unchanged source files.'
      valid()
      await this.store.begin(run, input.expected, owner, valid); persisted = true
      this.failure = undefined
      void this.execute(ticket, input.agentId, valid).finally(settled)
      this.changed()
      return structuredClone(run)
    } catch (error) {
      if (!persisted) this.store.releaseOwner(owner)
      if (this.active === ticket) this.active = undefined
      settled()
      if (error instanceof TaskError) throw error
      throw new TaskError(409, 'validation did not start; check the workspace and command directories')
    }
  }
  private async execute(ticket: { controller: AbortController; run: TaskRun; owner: string }, agentId: string, current: () => void): Promise<void> {
    const { controller, run, owner } = ticket
    try {
      for (const result of run.results) {
        if (result.status === 'skipped') continue
        current(); controller.signal.throwIfAborted()
        result.status = 'awaiting_approval'; run.status = 'awaiting_approval'
        await this.store.saveRun(run, owner); this.changed()
        const workdir = path.resolve(this.cwd, result.workdir)
        const execution = await this.tools.execute(result.callId, result.shell, JSON.stringify({ command: result.command, description: result.name,
          timeoutMs: result.timeoutMs, workdir, run_in_background: false }), {
          sessionId: run.sessionId ?? `validation-${run.id}`, agentId, signal: controller.signal, localOnly: true,
          onCommandStart: async () => {
            current(); controller.signal.throwIfAborted()
            const root = await fs.realpath(this.cwd), real = await fs.realpath(workdir), relative = path.relative(root, real)
            if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new TaskError(409, 'validation directory changed after approval')
            result.status = 'running'; run.status = 'running'
            await this.store.saveRun(run, owner); this.changed()
          },
        })
        result.output = clip(execution.output, TASK_LIMITS.logChars)
        result.truncated = result.output.length < execution.output.length || execution.execution?.truncated === true
        result.execution = execution.execution
        result.exitCode = execution.execution?.exitCode ?? null
        result.status = controller.signal.aborted || execution.execution?.reason === 'cancelled' || execution.execution?.reason === 'timeout' ? 'interrupted' :
          execution.blockedReason ? 'denied' : execution.execution?.reason === 'exit' && execution.execution.exitCode === 0 && !execution.isError ? 'passed' : 'failed'
        if (!execution.execution) result.note = execution.blockedReason ? 'Command denied by the approval pipeline; no process was started.' : 'No successful process evidence was returned.'
        await this.store.saveRun(run, owner); this.changed()
        if (result.status !== 'passed') { run.status = result.status; break }
      }
      if (live.has(run.status)) run.status = run.results.some(result => result.status === 'passed') && run.results.every(result => result.status === 'passed' || result.status === 'skipped') ? 'passed' : 'failed'
    } catch (error) {
      run.status = controller.signal.aborted ? 'interrupted' : 'failed'
      run.error = error instanceof TaskError ? clip(error.message, 2000) : controller.signal.aborted ? 'Validation interrupted; remaining commands were not run.' : 'Validation stopped before all evidence could be recorded.'
      for (const result of run.results) if (live.has(result.status)) { result.status = 'interrupted'; result.note = 'No complete process result was recorded.' }
    } finally {
      run.endedAt = new Date().toISOString()
      try { await this.store.saveRun(run, owner, true) }
      catch { this.failure = 'Validation stopped, but its final report could not be saved. The last persisted state is not a passing result.' }
      this.store.releaseOwner(owner)
      if (this.active === ticket) this.active = undefined
      this.changed()
    }
  }
  cancel(runId?: string): void {
    if (runId && this.active?.run.id !== runId) throw new TaskError(409, 'validation changed; refresh before stopping')
    this.active?.controller.abort()
  }
  async wait(): Promise<void> { await this.active?.done }
  async close(): Promise<void> {
    this.closed = true; this.cancel()
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([this.active?.done, new Promise<void>(resolve => { timer = setTimeout(resolve, 8000) })]) }
    finally { clearTimeout(timer) }
  }
  async accept(taskId: string, note: string, expected: TaskRevision, current?: () => void): Promise<TaskSnapshot> {
    const snapshot = await this.store.snapshot(), latest = snapshot.runs.find(run => run.taskId === taskId)
    if (latest?.code) { const report = await this.report(latest.id)
      if (report.codeStale !== false) throw new TaskError(409, 'source changed or could not be verified; run checks again before acceptance')
    }
    return this.store.accept(taskId, note, expected, current)
  }
}

export function exportTaskReport(run: TaskRun): string {
  const fence = '`'.repeat(Math.max(3, ...run.results.flatMap(result => [...result.output.matchAll(/`+/g)].map(match => match[0].length + 1))))
  const lines = [`# Validation report ${run.id}`, '', `Task: ${run.taskId}`, `Result: ${run.status}`, `Started: ${run.startedAt}`, `Ended: ${run.endedAt ?? 'not finished'}`,
    `Definition: ${run.definitionHash}`, `Commands: ${run.checksHash}`, run.code ? `Tracked source: ${JSON.stringify(run.code)}` : run.codeNote ?? 'Source freshness not verified.',
    '', 'Command validation is not human acceptance. Untracked files and external service state are not included in the source fingerprint.', '']
  for (const result of run.results) lines.push(`## ${result.name.replace(/[\r\n]/g, ' ')}`, `Status: ${result.status}; exit: ${result.exitCode ?? 'unknown'}; shell: ${result.shell}`,
    `Directory: ${result.workdir}`, `Required: ${result.required}; log truncated: ${result.truncated}`, '', fence, result.command, fence, '', fence, result.output, fence, '')
  if (run.error) lines.push(run.error)
  return lines.join('\n')
}
