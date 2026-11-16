/** Separate harnesses for explicit worktree tasks; nothing is sent through the parent transcript. */
import * as path from 'node:path'
import { createHarness, type Harness } from '../harness.js'
import type { AgentHandle } from '../core/agent.js'
import type { ApprovalRequest } from '../core/approval.js'
import type { TaskCard } from '../tasks/types.js'
import { PermissionEngine } from '../permissions/index.js'
import { GitReviewService } from '../git/index.js'
import { isSessionId } from '../core/session.js'
import type { WorktreeService, WorktreeInfo } from '../worktrees/index.js'
import { HttpError } from './http.js'
import { readBinding, writeBinding, executionLock, type IsolatedBinding } from './isolated-state.js'

interface Runtime {
  info: WorktreeInfo
  harness: Harness
  agent: AgentHandle
  binding: IsolatedBinding
  fingerprint: string
  release(): Promise<void>
  done?: Promise<unknown>
  writing: Promise<unknown>
}
const disabled = ['core-hooks', 'core-skills', 'core-agent-defs', 'core-model-profiles', 'core-memory-processing', 'core-compaction',
  'mcp-manager', 'core-connectors', 'tool-connectors', 'tool-plugin-manager', 'tool-browser', 'tool-computer', 'tool-subagent', 'tool-subagent-control', 'core-interaction', 'tool-ask-user', 'tool-plan']
export class IsolatedTasks {
  private runtimes = new Map<string, Runtime>()
  private opening = new Map<string, Promise<Runtime>>()
  private readonly transitions = new Set<string>()
  private readonly controls = new Map<string, AbortController>()
  private readonly operations = new Set<Promise<unknown>>()
  private closed = false
  private async transition<T>(id: string, action: (check: () => void) => Promise<T>, current: () => void): Promise<T> {
    this.check(); current()
    if (this.transitions.has(id)) throw new HttpError(409, '独立任务正在处理上一操作，请等待完成。')
    const controller = new AbortController()
    const check = () => { this.check(); controller.signal.throwIfAborted(); current() }
    this.transitions.add(id); this.controls.set(id, controller)
    const work = Promise.resolve().then(() => action(check)); this.operations.add(work)
    try { return await work }
    finally { this.transitions.delete(id); this.controls.delete(id); this.operations.delete(work) }
  }
  constructor(private worktrees: WorktreeService, private parent: () => Harness,
    private confirm: (id: string, request: ApprovalRequest) => Promise<boolean>, private changed: () => void,
    private healthy: () => void) {}
  allowForSession(id: string, toolName: string): void { this.runtimes.get(id)?.harness.ctx.approval.engine.allowForSession(toolName) }
  isBusy(): boolean { return this.transitions.size > 0 || this.opening.size > 0 || [...this.runtimes.values()].some(row => !!row.done || row.harness.ctx.tasks?.isBusy()) }
  isRunning(id: string): boolean { return this.transitions.has(id) || this.running(id) }
  private running(id: string): boolean { const row = this.runtimes.get(id); return this.opening.has(id) || !!row?.done || !!row?.harness.ctx.tasks?.isBusy() }
  private check(): void { if (this.closed) throw new HttpError(409, '独立任务管理器已关闭。'); this.healthy() }
  private async info(id: string): Promise<WorktreeInfo> {
    this.check(); const listed = await this.worktrees.list({ assertCurrent: () => this.check() })
    const info = listed.worktrees.find(row => row.id === id)
    if (!info) throw new HttpError(404, '独立任务目录不存在。')
    return info
  }
  private persist(runtime: Runtime, current: () => void = () => {}): Promise<void> {
    const value = structuredClone(runtime.binding)
    const work = runtime.writing.catch(() => {}).then(async () => {
      runtime.fingerprint = await writeBinding(runtime.info.dataDir, value, runtime.fingerprint, current)
    })
    runtime.writing = work; return work
  }
  private async open(id: string, choice: { model: string; adapter: string }, current: () => void): Promise<Runtime> {
    this.check(); current()
    const existing = this.runtimes.get(id)
    if (existing) {
      if (existing.binding.model !== choice.model || existing.binding.adapter !== choice.adapter) {
        if (this.running(id)) throw new HttpError(409, '任务运行中不能切换模型。')
        const adapter = this.parent().ctx.llm.isolatedAdapter(choice.model, choice.adapter)
        existing.harness.ctx.llm.replaceAdapters(adapter)
        existing.harness.ctx.agents.setModel(existing.agent.id, choice.model, choice.adapter)
        existing.binding.model = choice.model; existing.binding.adapter = choice.adapter; existing.binding.updatedAt = new Date().toISOString()
        await this.persist(existing, current)
      }
      return existing
    }
    const pending = this.opening.get(id)
    if (pending) throw new HttpError(409, '独立任务正在打开，请等待完成后重试。')
    if (this.runtimes.size + this.opening.size >= 2) throw new HttpError(409, '最多同时打开两个独立任务，请先暂停并关闭一个。')
    const work = this.createRuntime(id, choice, current)
    this.opening.set(id, work)
    try { return await work } finally { this.opening.delete(id) }
  }
  private async createRuntime(id: string, choice: { model: string; adapter: string }, current: () => void): Promise<Runtime> {
    const info = await this.info(id), source = this.parent(), adapter = source.ctx.llm.isolatedAdapter(choice.model, choice.adapter)
    if (!source.ctx.llm.modelStatus(choice.model, choice.adapter).configured) throw new HttpError(409, '所选模型尚未配置。')
    const release = await executionLock(info.dataDir)
    let harness: Harness | undefined
    try {
      current(); this.check()
      const saved = await readBinding(info.dataDir)
      if (saved.value && saved.value.taskId !== info.taskId) throw new HttpError(409, '任务目录与执行记录不匹配。')
      const plugins = Object.fromEntries(disabled.map(name => [name, { disabled: true }]))
      harness = await createHarness({ cwd: info.path, dataCwd: info.dataDir,
        sessionDir: path.join(info.dataDir, 'sessions'), jobsDir: path.join(info.dataDir, 'jobs'), renderer: false,
        config: { bundles: [], plugins, profiles: {}, mcpServers: {}, connectors: [] }, adapter,
        approvalMode: source.ctx.approval.mode, maxSteps: 40, allowNestedSubagents: false,
        systemPrompt: `Work on the selected task in this independent development directory: ${info.path}. The parent workspace is not your working directory. Do not edit parent workspace files or Git metadata. Task integration requires a separate user confirmation. Directory isolation is not an operating-system sandbox.`,
      })
      harness.ctx.llm.replaceAdapters(adapter)
      harness.ctx.llm.setThinking(source.ctx.llm.thinking)
      harness.ctx.approval.setEngine(new PermissionEngine(source.ctx.approval.engine.rules()))
      harness.ctx.approval.setConfirmHandler(request => this.confirm(id, { ...request, localOnly: true }))
      current(); this.check()
      const session = saved.value ? await harness.ctx.sessions.open(saved.value.sessionId) : await harness.ctx.sessions.create({ title: '独立开发任务', isolatedTask: info.taskId })
      const agent = harness.main({ resumeSessionId: session.id })
      harness.ctx.agents.setModel(agent.id, choice.model, choice.adapter)
      const tasks = harness.ctx.tasks!
      if (!tasks) throw new HttpError(500, '独立验收服务未挂载。')
      const review = new GitReviewService(info.path)
      tasks.setCodeReader(async signal => { const state = await review.getTrackedFingerprint({ signal });
        return state.repositoryId && state.fingerprint ? { repository: state.repositoryId, head: state.headOid, fingerprint: state.fingerprint, scope: state.scope ?? '' } : undefined })
      let validationTaskId = saved.value?.validationTaskId
      if (!validationTaskId) {
        const parentTasks = await source.ctx.tasks?.snapshot(), original = parentTasks?.tasks.find(task => task.id === info.taskId)
        if (!original) throw new HttpError(404, '原持久任务已不存在；目录内容仍保留。')
        const configured = await tasks.store.saveChecks(parentTasks!.checks.filter(check => original.checkIds.includes(check.id)), await tasks.store.snapshot(), current)
        const { id: _id, createdAt: _created, updatedAt: _updated, definitionHash: _hash, acceptance: _acceptance, ...task } = original
        const copied = await tasks.store.upsert({ ...task, archived: false, sessionId: session.id, status: 'pending' }, configured, current)
        validationTaskId = copied.tasks[0]!.id
      }
      const binding: IsolatedBinding = { version: 1, taskId: info.taskId, sessionId: session.id, validationTaskId,
        model: choice.model, adapter: choice.adapter, status: saved.value?.status === 'running' ? 'interrupted' : saved.value?.status ?? 'idle', updatedAt: new Date().toISOString() }
      const runtime: Runtime = { info, harness, agent, binding, fingerprint: saved.fingerprint, release, writing: Promise.resolve() }
      await this.persist(runtime, current)
      current(); this.check(); this.runtimes.set(id, runtime)
      harness.ctx.on('tasks/changed', () => this.changed())
      return runtime
    } catch (error) { harness?.dispose(); await release(); throw error }
  }
  async status(id: string, current: () => void) {
    const info = await this.info(id), runtime = this.runtimes.get(id), saved = runtime ? { value: runtime.binding } : await readBinding(info.dataDir)
    current()
    return { worktree: info, execution: saved.value ? { ...saved.value, status: !runtime && saved.value.status === 'running' ? 'interrupted' : saved.value.status } : null,
      open: !!runtime, running: this.isRunning(id), validation: runtime ? await runtime.harness.ctx.tasks?.snapshot() : null,
      notice: '目录与历史保留；重新打开不会自动执行命令或模型请求。' }
  }
  async records(id: string, current: () => void) {
    const info = await this.info(id), runtime = this.runtimes.get(id), saved = runtime ? { value: runtime.binding } : await readBinding(info.dataDir)
    if (!saved.value) return { records: [], sessionId: null }
    const { SessionService } = await import('../core/session.js')
    const session = await (runtime?.harness.ctx.sessions ?? new SessionService(path.join(info.dataDir, 'sessions'))).open(saved.value.sessionId)
    current()
    return { records: session.events.slice(-400), truncated: session.events.length > 400, sessionId: session.id }
  }
  async send(id: string, input: string, choice: { model: string; adapter: string }, current: () => void) {
    return this.transition(id, check => this.sendNow(id, input, choice, check), current)
  }
  private async sendNow(id: string, input: string, choice: { model: string; adapter: string }, current: () => void) {
    if (typeof input !== 'string' || !input.trim() || input.length > 32_000) throw new HttpError(400, '请输入完整、有限长度的独立任务说明。')
    const runtime = await this.open(id, choice, current)
    if (this.running(id)) throw new HttpError(409, '独立任务正在执行，不自动排入第二次请求。')
    runtime.binding.status = 'running'; runtime.binding.error = undefined; runtime.binding.updatedAt = new Date().toISOString()
    await this.persist(runtime, current)
    this.check(); current()
    const turn = runtime.agent.turn(input)
    const finished = turn.then(result => {
      runtime.binding.status = result.cancelled ? 'interrupted' : result.error ? 'error' : 'done'
      if (result.error) runtime.binding.error = this.parent().ctx.llm.redactError(result.error).slice(0, 2000)
    }, () => { runtime.binding.status = 'error'; runtime.binding.error = '独立任务未完成，请查看其会话记录。' }).then(async () => {
      runtime.binding.updatedAt = new Date().toISOString()
      try { await this.persist(runtime) } catch { runtime.binding.status = 'error'; runtime.binding.error = '执行结束，但状态保存失败；历史记录保留。' }
    }).finally(() => { if (runtime.done === finished) runtime.done = undefined; this.changed() })
    runtime.done = finished
    void finished.catch(() => {})
    this.changed(); return { accepted: true, sessionId: runtime.agent.sessionId }
  }
  async verify(id: string, choice: { model: string; adapter: string }, current: () => void) {
    return this.transition(id, check => this.verifyNow(id, choice, check), current)
  }
  private async verifyNow(id: string, choice: { model: string; adapter: string }, current: () => void) {
    const runtime = await this.open(id, choice, current)
    if (this.running(id)) throw new HttpError(409, '独立任务正在运行。')
    const tasks = runtime.harness.ctx.tasks!, saved = await tasks.snapshot()
    const result = await tasks.start({ taskId: runtime.binding.validationTaskId, expected: saved, agentId: runtime.agent.id,
      sessionId: isSessionId(runtime.agent.sessionId) ? runtime.agent.sessionId : undefined }, () => { this.check(); current() })
    return { runId: result.id }
  }
  async validationReport(id: string, runId: string, current: () => void) {
    const runtime = this.runtimes.get(id)
    if (!runtime) throw new HttpError(409, '先重新打开独立任务，或查看数据目录中的历史报告。')
    const result = await runtime.harness.ctx.tasks!.report(runId); current(); return result
  }
  async stop(id: string): Promise<void> {
    this.controls.get(id)?.abort()
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.agent.interrupt(); runtime.harness.ctx.tasks?.cancel(); runtime.harness.ctx.jobs?.stopAll()
    await runtime.harness.ctx.agents.stopAll(); await runtime.harness.ctx.tasks?.wait(); await runtime.done; await runtime.writing.catch(() => {})
    this.changed()
  }
  async release(id: string): Promise<void> {
    if (this.isRunning(id)) throw new HttpError(409, '请先停止独立任务后关闭。')
    const runtime = this.runtimes.get(id); if (!runtime) return
    await runtime.writing; runtime.harness.dispose(); await runtime.release(); this.runtimes.delete(id); this.changed()
  }
  async reopen(id: string, choice: { model: string; adapter: string }, current: () => void) {
    return this.transition(id, async check => { await this.open(id, choice, check); return this.status(id, check) }, current)
  }
  async close(): Promise<void> {
    this.closed = true
    for (const control of this.controls.values()) control.abort()
    for (const runtime of this.runtimes.values()) { runtime.agent.interrupt(); runtime.harness.ctx.tasks?.cancel(); runtime.harness.ctx.jobs?.stopAll() }
    await Promise.allSettled([...this.operations, ...this.opening.values()])
    await Promise.allSettled([...this.runtimes.keys()].map(id => this.stop(id)))
    for (const runtime of this.runtimes.values()) { runtime.harness.dispose(); await runtime.release().catch(() => {}) }
    this.runtimes.clear()
  }
}
