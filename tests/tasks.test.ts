import { spawn } from 'node:child_process'
import { promises as fs, readdirSync, renameSync, writeFileSync, linkSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { approvalPlugin, type ApprovalService } from '../src/core/approval.js'
import { shellToolsPlugin } from '../src/tools/shell.js'
import { todoToolsPlugin, type TodoStore } from '../src/tools/todo.js'
import { taskToolsPlugin } from '../src/tools/tasks.js'
import { TasksService, exportTaskReport } from '../src/tasks/service.js'
import { TaskStore, checksHash } from '../src/tasks/store.js'
import type { TaskCard, TaskRun, TaskSnapshot } from '../src/tasks/types.js'
import { killProcessTree, shellSpawnDetached } from '../src/core/shell.js'

const roots: string[] = [], contexts: Context[] = [], services: TasksService[] = []
const card = (extra: Record<string, unknown> = {}) => ({ title: '验证项目', description: '持久任务', priority: 'high', status: 'pending',
  steps: [{ id: 'one', content: '实现变更', status: 'pending' }], criteria: ['测试必须通过'], checkIds: [], archived: false, ...extra })
const editable = ({ createdAt, updatedAt, definitionHash, acceptance, ...task }: TaskCard) => task
const command = (command = 'exit 0', extra: Record<string, unknown> = {}) => ({ id: 'verify', name: '本机检查', shell: 'bash', command, workdir: '.', timeoutMs: 15_000, required: true, ...extra })
async function fixture(mode: 'default' | 'yolo' = 'yolo') {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-tasks-')); roots.push(cwd)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(approvalPlugin, { mode }); await ctx.plugin(toolsPlugin); await ctx.plugin(shellToolsPlugin, { cwd }); await ctx.plugin(todoToolsPlugin)
  const tools = ctx.get<ToolsService>('tools'), tasks = new TasksService(cwd, tools); services.push(tasks)
  ctx.provide('tasks'); ctx.set('tasks', tasks); await ctx.plugin(taskToolsPlugin)
  await tasks.initialize()
  return { cwd, tasks, store: tasks.store, ctx, tools }
}
afterEach(async () => { vi.restoreAllMocks(); while (services.length) await services.pop()!.close(); while (contexts.length) contexts.pop()!.dispose()
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 4 }) })

async function configured(f: Awaited<ReturnType<typeof fixture>>, cmd = 'printf "verified"; exit 0') {
  const checks = await f.store.saveChecks([command(cmd)], await f.store.snapshot())
  const saved = await f.store.upsert(card({ checkIds: ['verify'] }), checks)
  return saved
}

const ledger = (cwd: string) => path.join(cwd, '.sakura', 'tasks', 'state.json')
function barrier() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  return { enter, release, entered, held }
}
function pendingRun(snapshot: TaskSnapshot, id: string): TaskRun {
  return { id, taskId: snapshot.tasks[0]!.id, status: 'running', startedAt: new Date().toISOString(),
    definitionHash: snapshot.tasks[0]!.definitionHash, checksHash: checksHash(snapshot.checks),
    results: snapshot.checks.map(check => ({ ...check, callId: `${id}-call`, status: 'running', exitCode: null, output: '', truncated: false })) }
}

/** A real separate Node process loads only the known local TaskStore module through the offline tsx loader. */
async function externalStoreProcess(cwd: string, action: 'claim' | 'attempt') {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const source = pathToFileURL(path.join(repositoryRoot, 'src/tasks/store.ts')).href
  const loader = pathToFileURL(path.join(repositoryRoot, 'node_modules/tsx/dist/loader.mjs')).href
  const script = `
    const { TaskStore, checksHash } = await import(${JSON.stringify(source)});
    const store = new TaskStore(process.argv[1]);
    const mode = process.argv[2];
    await store.recover();
    const saved = await store.snapshot();
    const run = { id: 'other-process-run', taskId: saved.tasks[0].id, status: 'running', startedAt: new Date().toISOString(),
      definitionHash: saved.tasks[0].definitionHash, checksHash: checksHash(saved.checks), results: saved.checks.map(check => ({ ...check,
        callId: 'other-process-call', status: 'running', exitCode: null, output: '', truncated: false })) };
    try {
      await store.begin(run, saved, 'other-process-owner');
      process.stdout.write(JSON.stringify({ begun: true, snapshot: await store.snapshot() }) + '\\n');
      if (mode === 'claim') {
        process.stdin.resume();
        await new Promise(resolve => process.stdin.once('data', resolve));
        run.status = 'interrupted'; run.endedAt = new Date().toISOString();
        for (const result of run.results) result.status = 'interrupted';
        await store.saveRun(run, 'other-process-owner', true);
      }
    } catch (error) {
      process.stdout.write(JSON.stringify({ begun: false, status: error.status, message: error.message, snapshot: await store.snapshot() }) + '\\n');
    }
  `
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '-e', script, cwd, action], {
    cwd: repositoryRoot, env: { ...process.env }, shell: false, windowsHide: true,
    detached: shellSpawnDetached(), stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stderr.on('data', chunk => { errors += chunk })
  const done = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)) })
  const first = new Promise<{ begun: boolean; status?: number; snapshot: TaskSnapshot }>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; killProcessTree(child); reject(new Error('Store child timed out: ' + errors)) } }, 15_000)
    child.stdout.on('data', chunk => {
      output += chunk
      const end = output.indexOf('\n')
      if (!settled && end >= 0) {
        settled = true; clearTimeout(timer)
        try { resolve(JSON.parse(output.slice(0, end))) } catch (error) { reject(error) }
      }
    })
    child.once('error', error => { if (!settled) { settled = true; clearTimeout(timer); reject(error) } })
    child.once('close', code => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Store child exited ${code}: ${errors}`)) } })
  })
  return { first, async finish() { child.stdin.end('finish\n'); expect(await done, errors).toBe(0) },
    async stop() { killProcessTree(child); await done.catch(() => {}) } }
}

describe('persistent workspace tasks and command evidence', () => {
  it('keeps a read-only empty workspace empty and restores saved cards independently of todo replacement', async () => {
    const f = await fixture()
    expect((await f.store.snapshot()).tasks).toEqual([])
    await expect(fs.stat(path.join(f.cwd, '.sakura'))).rejects.toMatchObject({ code: 'ENOENT' })
    const saved = await f.store.upsert(card({ sessionId: 'missing-session' }), await f.store.snapshot())
    const task = saved.tasks[0]!
    expect(task.id).toBeTruthy()
    await f.tools.execute('todos', 'todo_write', JSON.stringify({ todos: [{ content: 'temporary', status: 'completed' }] }), { agentId: 'main', sessionId: 'session', signal: new AbortController().signal })
    expect(f.ctx.get<TodoStore>('todos').todos).toHaveLength(1)
    expect((await new TaskStore(f.cwd).snapshot()).tasks[0]).toEqual(task)
    await f.tools.execute('todos-empty', 'todo_write', '{"todos":[]}', { agentId: 'main', sessionId: 'session', signal: new AbortController().signal })
    expect((await f.store.snapshot()).tasks).toHaveLength(1)
  })

  it('rejects stale writers and model-supplied evidence while preserving the saved card', async () => {
    const f = await fixture(), first = await f.store.snapshot()
    const saved = await f.store.upsert(card(), first)
    await expect(new TaskStore(f.cwd).upsert(card(), first)).rejects.toMatchObject({ status: 409 })
    await expect(f.store.upsert({ ...editable(saved.tasks[0]!), acceptance: { at: 'forged' } }, saved)).rejects.toMatchObject({ status: 400 })
    const output = await f.tools.execute('write', 'task_write', JSON.stringify({ task: { ...editable(saved.tasks[0]!), results: [] }, ...saved }), {
      agentId: 'main', sessionId: 'session', signal: new AbortController().signal })
    expect(output.isError).toBe(true)
    expect((await f.store.snapshot()).tasks).toEqual(saved.tasks)
  })

  it('separates completed work, real process success, and human acceptance', async () => {
    const f = await fixture(), saved = await configured(f)
    const completed = await f.store.upsert({ ...editable(saved.tasks[0]!), status: 'completed' }, saved)
    await expect(f.tasks.accept(completed.tasks[0]!.id, '', completed)).rejects.toMatchObject({ status: 409 })
    const run = await f.tasks.start({ taskId: completed.tasks[0]!.id, expected: completed, agentId: 'main', sessionId: 'linked-session' })
    await f.tasks.wait()
    const report = await f.tasks.report(run.id)
    expect(report.run).toMatchObject({ status: 'passed', sessionId: 'linked-session', results: [{ status: 'passed', exitCode: 0, execution: { reason: 'exit', exitCode: 0 } }] })
    expect(report.run.results[0]!.output).toContain('verified')
    expect((await f.store.snapshot()).tasks[0]!.acceptance).toBeUndefined()
    const accepted = await f.tasks.accept(completed.tasks[0]!.id, '人工检查通过', await f.store.snapshot())
    expect(accepted.tasks[0]!.acceptance?.runId).toBe(run.id)
    const updated = await f.store.saveChecks([command('exit 1')], accepted)
    expect(updated.tasks[0]!.acceptance).toBeUndefined()
    expect((await f.tasks.report(run.id)).definitionStale).toBe(true)
    expect(exportTaskReport(report.run)).toContain('exit: 0')
  })

  it('records a nonzero exit as failure without automatically running remaining checks', async () => {
    const f = await fixture()
    const checks = await f.store.saveChecks([command('exit 7'), command('touch should-not-run', { id: 'second' })], await f.store.snapshot())
    const saved = await f.store.upsert(card({ checkIds: ['verify', 'second'] }), checks)
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' }); await f.tasks.wait()
    const report = await f.store.run(run.id)
    expect(report.status).toBe('failed')
    expect(report.results.map(row => [row.status, row.exitCode])).toEqual([['failed', 7], ['not_run', null]])
    await expect(fs.stat(path.join(f.cwd, 'should-not-run'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('denies an unapproved command without starting a process', async () => {
    const f = await fixture('default'), saved = await configured(f, 'touch never-created')
    const approval = f.ctx.get<ApprovalService>('approval'), confirm = vi.fn(() => false); approval.setConfirmHandler(confirm)
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' }); await f.tasks.wait()
    expect(confirm).toHaveBeenCalledOnce()
    expect((await f.store.run(run.id)).results[0]).toMatchObject({ status: 'denied', exitCode: null })
    await expect(fs.stat(path.join(f.cwd, 'never-created'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains explicit optional skips without treating a skipped required check as passing', async () => {
    const f = await fixture(), checks = await f.store.saveChecks([command(), command('exit 9', { id: 'optional', required: false })], await f.store.snapshot())
    const saved = await f.store.upsert(card({ checkIds: ['verify', 'optional'] }), checks)
    await expect(f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main', skipIds: ['verify'] })).rejects.toMatchObject({ status: 400 })
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main', skipIds: ['optional'] }); await f.tasks.wait()
    expect((await f.store.run(run.id)).results.map(row => row.status)).toEqual(['passed', 'skipped'])
  })

  it('records timeout and cancellation, and blocks concurrent mutation during a run', async () => {
    const f = await fixture(), checks = await f.store.saveChecks([command('sleep 10', { timeoutMs: 100 })], await f.store.snapshot())
    const saved = await f.store.upsert(card({ checkIds: ['verify'] }), checks)
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' })
    await expect(f.store.upsert(card(), await f.store.snapshot())).rejects.toMatchObject({ status: 409 })
    await f.tasks.wait()
    expect((await f.store.run(run.id)).results[0]).toMatchObject({ status: 'interrupted', execution: { reason: 'timeout' } })
    const next = await f.store.snapshot()
    const cancelled = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: next, agentId: 'main' }); f.tasks.cancel(cancelled.id); await f.tasks.wait()
    expect((await f.store.run(cancelled.id)).status).toBe('interrupted')
  })

  it('does not start a command when the start record cannot be persisted', async () => {
    const f = await fixture(), saved = await configured(f, 'touch never-started')
    vi.spyOn(f.store, 'begin').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' })).rejects.toThrow()
    expect(f.tasks.isBusy()).toBe(false)
    await expect(fs.stat(path.join(f.cwd, 'never-started'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not show completed validation when final evidence cannot be saved', async () => {
    const f = await fixture(), saved = await configured(f)
    const original = f.store.saveRun.bind(f.store)
    vi.spyOn(f.store, 'saveRun').mockImplementation((run, owner, finished) => finished ? Promise.reject(new Error('locked')) : original(run, owner, finished))
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' }); await f.tasks.wait()
    expect((await f.tasks.snapshot()).error).toContain('could not be saved')
    expect((await f.store.run(run.id)).endedAt).toBeUndefined()
    expect((await f.store.run(run.id)).status).not.toBe('passed')
  })

  it('recovers unfinished records as interrupted without replaying their commands', async () => {
    const f = await fixture(), saved = await configured(f)
    const checks = saved.checks, owner = 'orphan-owner'
    const run: TaskRun = { id: 'orphan-run', taskId: saved.tasks[0]!.id, startedAt: new Date().toISOString(), status: 'running',
      definitionHash: saved.tasks[0]!.definitionHash, checksHash: (await import('../src/tasks/store.js')).checksHash(checks),
      results: checks.map(check => ({ ...check, command: 'touch MUST_NOT_REPLAY', callId: 'old-call', status: 'running', exitCode: null, output: '', truncated: false })) }
    await f.store.begin(run, saved, owner); f.store.releaseOwner(owner)
    const restarted = new TaskStore(f.cwd); await restarted.recover()
    expect((await restarted.run(run.id)).status).toBe('interrupted')
    expect((await restarted.run(run.id)).results[0]!.status).toBe('interrupted')
    await expect(fs.stat(path.join(f.cwd, 'MUST_NOT_REPLAY'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses corrupt metadata and linked directories without touching their targets', async () => {
    const f = await fixture(), saved = await f.store.upsert(card(), await f.store.snapshot()), ledger = path.join(f.cwd, '.sakura/tasks/state.json')
    await fs.writeFile(ledger, '{broken')
    await expect(f.store.snapshot()).rejects.toMatchObject({ status: 409 })
    await expect(f.store.upsert(card(), saved)).rejects.toThrow()
    expect(await fs.readFile(ledger, 'utf8')).toBe('{broken')
    const linked = await fixture(), outside = await fixture()
    await fs.symlink(outside.cwd, path.join(linked.cwd, '.sakura'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(linked.store.snapshot()).rejects.toMatchObject({ status: 409 })
    expect(await fs.readdir(outside.cwd)).toEqual([])
  })

  it('preserves ANSI and NUL command output without making snapshots or subsequent saves unreadable', async () => {
    const f = await fixture(), saved = await configured(f, `printf '\\033[31mred\\033[0m\\000binary\\n'; exit 0`)
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' })
    await f.tasks.wait()
    const report = await f.store.run(run.id)
    expect(report.status).toBe('passed')
    expect(report.results[0]!.output).toContain('\u001b[31mred\u001b[0m\u0000binary\n')
    expect(report.results[0]!.execution).toMatchObject({ reason: 'exit', exitCode: 0 })
    const reloaded = await new TaskStore(f.cwd).snapshot()
    expect(reloaded.runs[0]!.status).toBe('passed')
    expect((await f.store.upsert({ ...editable(reloaded.tasks[0]!), description: 'still writable' }, reloaded)).tasks[0]!.description).toBe('still writable')
    expect((await f.store.run(run.id)).results[0]!.output).toBe(report.results[0]!.output)
    expect(exportTaskReport(report)).toContain('\u0000binary')
  })

  it('waits for a blocked start lifecycle during close and never persists or executes a cancelled start', async () => {
    const f = await fixture(), saved = await configured(f, 'touch should-never-start')
    const bytes = await fs.readFile(ledger(f.cwd)), gate = barrier()
    let signal: AbortSignal | undefined, closed = false, waited = false
    f.tasks.setCodeReader(async incoming => { signal = incoming; gate.enter(); await gate.held; return undefined })
    const execute = vi.spyOn(f.tools, 'execute'), begin = vi.spyOn(f.store, 'begin')
    const starting = f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' })
    const rejected = expect(starting).rejects.toMatchObject({ status: 409 })
    await gate.entered
    const waiting = f.tasks.wait().then(() => { waited = true })
    const closing = f.tasks.close().then(() => { closed = true })
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(signal?.aborted).toBe(true)
      expect(closed).toBe(false); expect(waited).toBe(false)
      expect(execute).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled()
    } finally { gate.release(); await rejected; await closing; await waiting }
    expect(f.tasks.isBusy()).toBe(false)
    expect(await fs.readFile(ledger(f.cwd))).toEqual(bytes)
    await expect(fs.stat(path.join(f.cwd, 'should-never-start'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects malformed next-state evidence before replacing a valid ledger', async () => {
    const f = await fixture(), saved = await configured(f)
    const run = pendingRun(saved, 'invalid-next-state'), owner = 'invalid-next-owner'
    await f.store.begin(run, saved, owner)
    const before = await fs.readFile(ledger(f.cwd))
    run.results[0]!.status = 'passed'; run.results[0]!.exitCode = 0
    await expect(f.store.saveRun(run, owner)).rejects.toMatchObject({ status: 400 })
    expect(await fs.readFile(ledger(f.cwd))).toEqual(before)
    expect((await f.store.run(run.id)).results[0]!.status).toBe('running')
    f.store.releaseOwner(owner)
  })

  it.each(['temp', 'directory', 'cas'] as const)('preserves the original ledger when %s changes after staging but before publication', async attack => {
    const f = await fixture(), saved = await f.store.upsert(card(), await f.store.snapshot())
    const file = ledger(f.cwd), directory = path.dirname(file), before = await fs.readFile(file)
    let attacked = false, tempPath = '', externalBytes: Buffer | undefined
    const originalLstat = fs.lstat.bind(fs)
    if (attack === 'directory') {
      // Windows forbids renaming a directory with the writer's open lock; model its post-swap inode at the filesystem seam.
      vi.spyOn(fs, 'lstat').mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const info = await originalLstat(...args)
        if (attacked && String(args[0]) === directory) {
          const swapped = Object.create(Object.getPrototypeOf(info)) as typeof info
          Object.assign(swapped, info)
          Object.defineProperty(swapped, 'ino', { value: typeof info.ino === 'bigint' ? info.ino + 1n : (info.ino === 1 ? 2 : 1) })
          return swapped
        }
        return info
      }) as typeof fs.lstat)
    }
    const current = () => {
      const staged = readdirSync(directory).find(name => /^\.tasks-.+\.tmp$/.test(name))
      if (!staged || attacked) return
      attacked = true; tempPath = path.join(directory, staged)
      if (attack === 'temp') {
        renameSync(tempPath, tempPath + '.owned')
        const outside = path.join(f.cwd, 'unrelated-original.txt')
        writeFileSync(outside, 'outside sentinel')
        linkSync(outside, tempPath)
      } else if (attack === 'directory') {
        // The lstat seam now represents a different real directory at the same path.
      } else {
        externalBytes = Buffer.concat([before, Buffer.from(' \n')])
        writeFileSync(file, externalBytes)
      }
    }
    await expect(f.store.upsert({ ...editable(saved.tasks[0]!), title: 'must not publish' }, saved, current)).rejects.toMatchObject({ status: 409 })
    expect(attacked).toBe(true)
    expect(await fs.readFile(file)).toEqual(externalBytes ?? before)
    if (attack === 'temp') expect(await fs.readFile(path.join(f.cwd, 'unrelated-original.txt'), 'utf8')).toBe('outside sentinel')
    if (attack === 'directory') expect(await fs.readFile(file)).toEqual(before)
    expect((await f.store.snapshot()).tasks[0]!.title).toBe(saved.tasks[0]!.title)
  })

  it('permits only one running group across two services for the same workspace', async () => {
    const f = await fixture('default'), saved = await configured(f, 'touch single-run-only')
    const approval = f.ctx.get<ApprovalService>('approval'), gate = barrier()
    const confirm = vi.fn(async request => { expect(request.localOnly).toBe(true); gate.enter(); await gate.held; return false })
    approval.setConfirmHandler(confirm)
    const other = new TasksService(f.cwd, f.tools); services.push(other); await other.initialize()
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' })
    await gate.entered
    try {
      const ongoing = await other.store.snapshot()
      await expect(other.start({ taskId: saved.tasks[0]!.id, expected: ongoing, agentId: 'other' })).rejects.toMatchObject({ status: 409 })
      expect((await other.store.snapshot()).runs).toHaveLength(1)
      expect(other.isBusy()).toBe(false); expect(f.tasks.isBusy()).toBe(true)
      expect(confirm).toHaveBeenCalledOnce()
    } finally { gate.release(); await f.tasks.wait() }
    expect((await other.store.run(run.id)).status).toBe('denied')
    await expect(fs.stat(path.join(f.cwd, 'single-run-only'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a live other-process owner and rejects a second process without recovering or replaying it', async () => {
    const f = await fixture(), saved = await configured(f, 'touch process-must-not-run')
    const child = await externalStoreProcess(f.cwd, 'claim')
    try {
      const claimed = await child.first
      expect(claimed.begun).toBe(true)
      const other = new TaskStore(f.cwd); await other.recover()
      expect((await other.run('other-process-run')).status).toBe('running')
      const execute = vi.spyOn(f.tools, 'execute')
      await expect(f.tasks.start({ taskId: saved.tasks[0]!.id, expected: await other.snapshot(), agentId: 'main' })).rejects.toMatchObject({ status: 409 })
      expect(execute).not.toHaveBeenCalled()
      const contender = await externalStoreProcess(f.cwd, 'attempt')
      try {
        expect(await contender.first).toMatchObject({ begun: false, status: 409 })
        await contender.finish()
      } finally { await contender.stop() }
      expect((await other.snapshot()).runs).toHaveLength(1)
      await child.finish()
      expect((await other.run('other-process-run')).status).toBe('interrupted')
      await expect(fs.stat(path.join(f.cwd, 'process-must-not-run'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await child.stop() }
  }, 60_000)

  it('rejects outside/alias directories and marks code changes stale', async () => {
    const f = await fixture()
    await expect(f.store.saveChecks([command('exit 0', { workdir: '../outside' })], await f.store.snapshot())).rejects.toMatchObject({ status: 400 })
    const saved = await configured(f)
    let fingerprint = 'before'
    f.tasks.setCodeReader(async () => ({ repository: 'repo', head: 'oid', scope: '.', fingerprint }))
    const run = await f.tasks.start({ taskId: saved.tasks[0]!.id, expected: saved, agentId: 'main' }); await f.tasks.wait()
    expect((await f.tasks.report(run.id)).codeStale).toBe(false)
    fingerprint = 'after'
    expect((await f.tasks.report(run.id)).codeStale).toBe(true)
  })
})
