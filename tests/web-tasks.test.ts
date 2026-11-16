import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskCard, TaskCheck, TaskRevision, TaskRun, TaskSnapshot } from '../src/tasks/types.js'
import type { TasksService } from '../src/tasks/service.js'
import { TaskStore } from '../src/tasks/store.js'
import { resolveGit } from '../src/git/process.js'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const OPERATOR = 'offline-tasks-operator-not-a-real-credential-00000001'
const VIEWER = 'offline-tasks-viewer-not-a-real-credential-0000000002'
const nativeFetch = globalThis.fetch
const cleanups: Array<() => Promise<unknown>> = []
let blockedFetches: string[] = []

type TasksReply = TaskSnapshot & { workspaceId: string; activeRunId?: string; error?: string }
type ReportReply = { run: TaskRun; definitionStale: boolean; codeStale: boolean | null; workspaceId: string }
type ApprovalFrame = { type: string; id: string; localOnly?: boolean; summary?: string; toolName?: string }
type StateReply = { workspaceId: string; cwd: string; tasksAvailable?: boolean; validationBusy?: boolean;
  pendingRequests?: ApprovalFrame[]; sessionId?: string | null; [key: string]: unknown }

beforeEach(() => {
  blockedFetches = []
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SAKURA_API_KEY']) vi.stubEnv(name, 'offline-fake-not-a-credential')
  vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1'); vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1')
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, url = new URL(raw)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      blockedFetches.push(raw); throw new Error(`No external network in tasks API tests: ${raw}`)
    }
    return nativeFetch(input, { ...init, redirect: 'error' })
  }) satisfies typeof fetch)
})
afterEach(async () => {
  try { while (cleanups.length) await cleanups.pop()!(); expect(blockedFetches).toEqual([]) }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})

async function git(cwd: string, args: string[]): Promise<void> {
  const executable = await resolveGit()
  if (!executable) throw new Error('Local Git is required for the isolated task source fingerprint fixture.')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  Object.assign(env, { HOME: path.dirname(cwd), USERPROFILE: path.dirname(cwd), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(path.dirname(cwd), 'absent-git-config'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    GIT_AUTHOR_NAME: 'Offline Task Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Offline Task Test',
    GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], { cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let error = ''; child.stderr.on('data', chunk => { error += chunk }); child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Fixture Git failed: ${error}`)))
  })
}
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-tasks-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 75 }))
  const cwd = path.join(root, 'repo'); await fs.mkdir(cwd)
  await git(cwd, ['init', '-q', '--initial-branch=main'])
  await git(cwd, ['config', 'core.autocrlf', 'false'])
  await fs.writeFile(path.join(cwd, 'code.txt'), 'tracked offline source\n')
  await git(cwd, ['add', '--', 'code.txt']); await git(cwd, ['commit', '-qm', 'initial'])
  return { cwd, root }
}

async function boot(options: Partial<WebServerOptions> = {}, provided?: Awaited<ReturnType<typeof workspace>>) {
  const project = provided ?? await workspace(), requests: unknown[] = [], persisted: unknown[] = []
  const handle = await runWebServer({ cwd: project.cwd, sessionDir: path.join(project.root, 'sessions'), jobsDir: path.join(project.root, 'jobs'),
    adapter: new MockAdapter([request => { requests.push(request); return text('offline task tests should not call models') }]),
    host: '127.0.0.1', token: OPERATOR, viewerToken: VIEWER, port: 0, open: false, quiet: true, updatesAutoCheck: false,
    approvalMode: 'yolo', onPersistSettings: saved => { persisted.push(saved) },
    config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } }, 'core-skills': { disabled: true }, 'core-agent-defs': { disabled: true } } }, ...options })
  cleanups.push(async () => { await handle.close(); expect(requests, 'No model request is needed for task APIs').toEqual([]) })
  const base = `http://127.0.0.1:${handle.port}`
  const rawState = await fetch(base + '/api/state', { headers: { authorization: `Bearer ${OPERATOR}` } })
  expect(rawState.status).toBe(200)
  const initial = await rawState.json() as StateReply
  async function request(route: string, body?: unknown, settings: { token?: string; workspace?: string | null; method?: string } = {}) {
    const workspaceId = settings.workspace === undefined ? initial.workspaceId : settings.workspace
    return fetch(base + route, { method: settings.method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: `Bearer ${settings.token ?? OPERATOR}`, ...(workspaceId === null ? {} : { 'x-sakura-workspace': workspaceId }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  async function tasks() { return json<TasksReply>(await request('/api/tasks')) }
  async function state(token = OPERATOR) { return json<StateReply>(await request('/api/state', undefined, { token })) }
  const service = handle.harness.ctx.tasks as TasksService
  expect(service).toBeDefined()
  return { ...project, handle, base, initial, request, tasks, state, service, requests, persisted }
}
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(status)
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json() as Promise<T>
}
const expected = (value: TaskRevision) => ({ revision: value.revision, fingerprint: value.fingerprint, confirmed: true })
const editable = ({ createdAt, updatedAt, definitionHash, acceptance, ...task }: TaskCard) => task
const card = (extra: Record<string, unknown> = {}) => ({ title: 'API_PRIVATE_TASK_TITLE', description: 'API_PRIVATE_TASK_BODY', priority: 'high', status: 'pending',
  steps: [{ id: 'step-one', content: 'API_PRIVATE_STEP', status: 'pending' }], criteria: ['API_PRIVATE_CRITERION'], checkIds: [], archived: false, ...extra })
const check = (cmd = 'printf "API_PRIVATE_CHECK_LOG\\n"; exit 0', extra: Partial<TaskCheck> = {}): TaskCheck => ({ id: 'verify', name: 'API_PRIVATE_CHECK_NAME',
  shell: 'bash', command: cmd, workdir: '.', required: true, timeoutMs: 3000, ...extra })
async function configure(f: Awaited<ReturnType<typeof boot>>, checks: TaskCheck[] = [check()]) {
  const initial = await f.tasks()
  const saved = await json<TasksReply>(await f.request('/api/tasks/checks', { ...expected(initial), checks }))
  return json<TasksReply>(await f.request('/api/tasks', { ...expected(saved), task: card({ checkIds: checks.map(item => item.id) }) }))
}
async function run(f: Awaited<ReturnType<typeof boot>>, saved: TasksReply) {
  const started = await json<{ runId: string }>(await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id }), 202)
  await f.service.wait()
  return json<ReportReply>(await f.request(`/api/tasks/runs/${started.runId}`))
}

async function events(f: Awaited<ReturnType<typeof boot>>, token = OPERATOR) {
  const controller = new AbortController()
  const response = await fetch(f.base + '/api/events', { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
  expect(response.status).toBe(200)
  const reader = response.body!.getReader(), frames: Array<Record<string, unknown>> = []
  const reading = (async () => {
    let buffer = ''; const decoder = new TextDecoder()
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          const data = frame.split('\n').find(line => line.startsWith('data: '))
          if (data) frames.push(JSON.parse(data.slice(6)))
        }
      }
    } catch (error) { if (!controller.signal.aborted) throw error }
  })()
  const stop = async () => { controller.abort(); await reading }
  cleanups.push(stop)
  await vi.waitFor(() => expect(frames.some(frame => frame.type === 'state')).toBe(true), { timeout: 5000 })
  return { frames, stop }
}
async function pendingApproval(f: Awaited<ReturnType<typeof boot>>): Promise<ApprovalFrame> {
  let found: ApprovalFrame | undefined
  await vi.waitFor(async () => { found = (await f.state()).pendingRequests?.find(frame => frame.type === 'approval/request'); expect(found).toBeDefined() }, { timeout: 8000, interval: 20 })
  return found!
}

describe('offline local task API and durable validation evidence', () => {
  it('creates/edits/archives cards, validates real exits, accepts separately, invalidates configuration and survives restart', async () => {
    const f = await boot()
    const initial = await f.tasks()
    expect(initial.tasks).toEqual([]); expect(initial.workspaceId).toBe(f.initial.workspaceId)
    const configured = await configure(f)
    const completed = await json<TasksReply>(await f.request('/api/tasks', { ...expected(configured), task: { ...editable(configured.tasks[0]!), status: 'completed' } }))
    const early = await f.request('/api/tasks/accept', { ...expected(completed), taskId: completed.tasks[0]!.id, note: 'not checked yet' })
    expect(early.status).toBe(409)
    const result = await run(f, completed)
    expect(result.run).toMatchObject({ status: 'passed', results: [{ status: 'passed', exitCode: 0, execution: { reason: 'exit', exitCode: 0 } }] })
    expect(result.run.results[0]!.output).toContain('API_PRIVATE_CHECK_LOG')
    expect(result.definitionStale).toBe(false); expect(result.codeStale).toBe(false)
    const afterRun = await f.tasks()
    expect(afterRun.tasks[0]!.acceptance).toBeUndefined()
    const accepted = await json<TasksReply>(await f.request('/api/tasks/accept', { ...expected(afterRun), taskId: completed.tasks[0]!.id, note: 'manual approval' }))
    expect(accepted.tasks[0]!.acceptance?.runId).toBe(result.run.id)
    const exported = await f.request(`/api/tasks/runs/${result.run.id}/export`)
    expect(exported.status).toBe(200); expect(exported.headers.get('content-type')).toContain('text/markdown')
    expect(exported.headers.get('content-disposition')).toContain(`validation-${result.run.id}.md`)
    expect(await exported.text()).toContain('API_PRIVATE_CHECK_LOG')
    await f.handle.close()
    const restarted = await boot({}, { cwd: f.cwd, root: f.root })
    const persisted = await restarted.tasks()
    expect(persisted.tasks[0]!.acceptance).toEqual(accepted.tasks[0]!.acceptance)
    expect(persisted.runs).toHaveLength(1)
    expect((await json<ReportReply>(await restarted.request(`/api/tasks/runs/${result.run.id}`))).run.results[0]!.output).toContain('API_PRIVATE_CHECK_LOG')
    const changed = await json<TasksReply>(await restarted.request('/api/tasks/checks', { ...expected(persisted), checks: [check('exit 7')] }))
    expect(changed.tasks[0]!.acceptance).toBeUndefined()
    expect((await json<ReportReply>(await restarted.request(`/api/tasks/runs/${result.run.id}`))).definitionStale).toBe(true)
    const failed = await run(restarted, changed)
    expect(failed.run).toMatchObject({ status: 'failed', results: [{ status: 'failed', exitCode: 7, execution: { reason: 'exit', exitCode: 7 } }] })
    const afterFailure = await restarted.tasks()
    expect((await restarted.request('/api/tasks/accept', { ...expected(afterFailure), taskId: afterFailure.tasks[0]!.id, note: 'cannot accept failed required check' })).status).toBe(409)
    const archived = await json<TasksReply>(await restarted.request('/api/tasks', { ...expected(afterFailure), task: { ...editable(afterFailure.tasks[0]!), archived: true } }))
    expect(archived.tasks[0]!.archived).toBe(true)
    expect((await restarted.request('/api/tasks/verify', { ...expected(archived), taskId: archived.tasks[0]!.id })).status).toBe(404)
  }, 90_000)

  it('rejects unconfirmed, stale, missing-workspace and forged evidence requests without invoking any command', async () => {
    const f = await boot(), saved = await configure(f, [check('touch NEVER_STARTED')])
    const tools = vi.spyOn(f.handle.harness.ctx.tools, 'execute')
    const ledger = path.join(f.cwd, '.sakura/tasks/state.json'), bytes = await fs.readFile(ledger)
    for (const workspace of [null, 'wrong-epoch']) {
      expect((await f.request('/api/tasks', undefined, { workspace })).status).toBe(409)
      expect((await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id }, { workspace })).status).toBe(409)
    }
    for (const confirmed of [undefined, false, 'true']) {
      expect((await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id, confirmed })).status).toBe(400)
      expect((await f.request('/api/tasks/checks', { ...expected(saved), checks: [], confirmed })).status).toBe(400)
      expect((await f.request('/api/tasks', { ...expected(saved), task: card(), confirmed })).status).toBe(400)
    }
    expect((await f.request('/api/tasks/verify', { ...expected(saved), fingerprint: '0'.repeat(64), taskId: saved.tasks[0]!.id })).status).toBe(409)
    expect((await f.request('/api/tasks', { ...expected(saved), task: { ...editable(saved.tasks[0]!), acceptance: { runId: 'forged' } } })).status).toBe(400)
    expect((await f.request('/api/tasks/checks', { ...expected(saved), checks: [check('exit 0', { workdir: '../outside' })] })).status).toBe(400)
    expect(tools).not.toHaveBeenCalled(); expect(await fs.readFile(ledger)).toEqual(bytes)
    await expect(fs.stat(path.join(f.cwd, 'NEVER_STARTED'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('denies every task GET/write to viewers and remote listeners without exposing definitions or logs', async () => {
    const local = await boot(), saved = await configure(local), report = await run(local, saved)
    const remote = await boot({ host: '0.0.0.0' }, { cwd: local.cwd, root: local.root })
    for (const [server, token] of [[local, VIEWER], [remote, OPERATOR], [remote, VIEWER]] as const) {
      for (const route of ['/api/tasks', `/api/tasks/runs/${report.run.id}`, `/api/tasks/runs/${report.run.id}/export`]) {
        const denied = await server.request(route, undefined, { token })
        expect(denied.status).toBe(404)
        expect(await denied.text()).not.toContain('API_PRIVATE')
      }
      expect((await server.request('/api/tasks', { ...expected(await local.tasks()), task: card() }, { token })).status).toBe(token === VIEWER ? 403 : 404)
      const state = await server.state(token)
      expect(state.tasksAvailable).toBe(false); expect(state.validationBusy).toBe(false)
      expect(JSON.stringify(state)).not.toContain('API_PRIVATE')
      expect(state).not.toHaveProperty('tasks'); expect(state).not.toHaveProperty('runs'); expect(state).not.toHaveProperty('checks')
    }
  }, 60_000)

  it('uses local-only approval, denies zero-start commands, and hides task/approval events from viewers', async () => {
    const f = await boot({ approvalMode: 'default' }), saved = await configure(f, [check('touch PRIVATE_DENIED_COMMAND')])
    const operator = await events(f), viewer = await events(f, VIEWER)
    const tool = f.handle.harness.ctx.tools.get('bash')!
    const executed = vi.spyOn(tool, 'execute')
    const started = await json<{ runId: string }>(await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id }), 202)
    const approval = await pendingApproval(f)
    expect(approval.localOnly).toBe(true); expect(approval.summary).toContain('PRIVATE_DENIED_COMMAND')
    await vi.waitFor(() => expect(operator.frames.some(frame => frame.type === 'approval/request' && frame.id === approval.id && frame.localOnly === true)).toBe(true))
    const viewerState = await f.state(VIEWER)
    expect(viewerState.pendingRequests?.some(frame => frame.id === approval.id)).toBe(false)
    expect(JSON.stringify(viewerState)).not.toContain('PRIVATE_DENIED_COMMAND')
    expect((await f.request(`/api/approvals/${approval.id}`, { allow: true }, { token: VIEWER })).status).toBe(403)
    expect(executed).not.toHaveBeenCalled()
    await json(await f.request(`/api/approvals/${approval.id}`, { allow: false }))
    await f.service.wait()
    const report = await json<ReportReply>(await f.request(`/api/tasks/runs/${started.runId}`))
    expect(report.run.results[0]).toMatchObject({ status: 'denied', exitCode: null })
    expect(report.run.results[0]!.execution).toBeUndefined()
    expect(executed).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(f.cwd, 'PRIVATE_DENIED_COMMAND'))).rejects.toMatchObject({ code: 'ENOENT' })
    const beforeAllowed = await f.tasks()
    const allowConfig = await json<TasksReply>(await f.request('/api/tasks/checks', { ...expected(beforeAllowed), checks: [check('printf "PRIVATE_ALLOWED_OUTPUT\\n"; exit 0')] }))
    const allowedStart = await json<{ runId: string }>(await f.request('/api/tasks/verify', { ...expected(allowConfig), taskId: saved.tasks[0]!.id }), 202)
    const allowedApproval = await pendingApproval(f)
    expect(allowedApproval.localOnly).toBe(true)
    expect(executed).not.toHaveBeenCalled()
    await json(await f.request(`/api/approvals/${allowedApproval.id}`, { allow: true }))
    await f.service.wait()
    const allowed = await json<ReportReply>(await f.request(`/api/tasks/runs/${allowedStart.runId}`))
    expect(allowed.run).toMatchObject({ status: 'passed', results: [{ status: 'passed', exitCode: 0, execution: { reason: 'exit', exitCode: 0 } }] })
    expect(allowed.run.results[0]!.output).toContain('PRIVATE_ALLOWED_OUTPUT')
    expect(executed).toHaveBeenCalledOnce()
    await f.state(); await new Promise(resolve => setTimeout(resolve, 30))
    expect(viewer.frames.some(frame => frame.type === 'tasks/changed' || ['approval/request', 'approval/resolved'].includes(String(frame.type)) && [approval.id, allowedApproval.id].includes(String(frame.id)))).toBe(false)
    expect(JSON.stringify(viewer.frames)).not.toContain('PRIVATE_DENIED_COMMAND')
    expect(JSON.stringify(viewer.frames)).not.toContain('PRIVATE_ALLOWED_OUTPUT')
    expect(JSON.stringify(viewer.frames)).not.toContain('API_PRIVATE_TASK')
    expect(JSON.stringify(await f.state(VIEWER))).not.toContain('PRIVATE_ALLOWED_OUTPUT')
    await operator.stop(); await viewer.stop()
  }, 60_000)

  it('keeps validation exclusive against messages, settings, session deletion and workspace switching, then cancels cleanly', async () => {
    const f = await boot({ approvalMode: 'default' }), other = await workspace()
    const disposable = await f.handle.harness.ctx.sessions.create({ title: 'unrelated delete target' })
    const saved = await configure(f, [check('touch BUSY_MUST_NOT_RUN')])
    const beforeHarness = f.handle.harness, beforeCwd = f.cwd
    const started = await json<{ runId: string }>(await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id }), 202)
    const approval = await pendingApproval(f)
    expect((await f.state()).validationBusy).toBe(true)
    for (const [route, body, method] of [
      ['/api/message', { text: 'must not queue' }, 'POST'],
      ['/api/settings', { approvalMode: 'yolo' }, 'POST'],
      ['/api/desktop/settings', { workspace: other.cwd }, 'POST'],
      [`/api/sessions/${disposable.id}`, undefined, 'DELETE'],
      ['/api/sessions', {}, 'POST'],
      ['/api/tasks/verify', { ...expected(await f.tasks()), taskId: saved.tasks[0]!.id }, 'POST'],
    ] as const) expect((await f.request(route, body, { method })).status, route).toBe(409)
    expect(f.handle.harness).toBe(beforeHarness); expect((await f.state()).cwd).toBe(beforeCwd)
    expect(f.persisted).toEqual([]); expect(f.requests).toEqual([])
    expect((await f.handle.harness.ctx.sessions.list()).some(session => session.id === disposable.id)).toBe(true)
    await json(await f.request('/api/tasks/cancel', { runId: started.runId, confirmed: true }))
    await f.service.wait()
    expect((await json<ReportReply>(await f.request(`/api/tasks/runs/${started.runId}`))).run.status).toBe('interrupted')
    expect((await f.state()).validationBusy).toBe(false)
    expect((await f.request(`/api/approvals/${approval.id}`, { allow: true })).status).toBe(404)
    await expect(fs.stat(path.join(f.cwd, 'BUSY_MUST_NOT_RUN'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60_000)

  it('server close cancels a real running process and leaves a restartable interrupted report', async () => {
    const f = await boot(), saved = await configure(f, [check('printf started > process-started; sleep 30; printf finished > process-must-not-finish', { timeoutMs: 60_000 })])
    const started = await json<{ runId: string }>(await f.request('/api/tasks/verify', { ...expected(saved), taskId: saved.tasks[0]!.id }), 202)
    await vi.waitFor(async () => expect(await fs.readFile(path.join(f.cwd, 'process-started'), 'utf8')).toBe('started'), { timeout: 8000, interval: 20 })
    expect(f.service.isBusy()).toBe(true)
    await f.handle.close()
    expect(f.service.isBusy()).toBe(false)
    const savedReport = await new TaskStore(f.cwd).run(started.runId)
    expect(savedReport.status).toBe('interrupted')
    expect(savedReport.results[0]).toMatchObject({ status: 'interrupted', execution: { reason: 'cancelled' } })
    await expect(fs.stat(path.join(f.cwd, 'process-must-not-finish'))).rejects.toMatchObject({ code: 'ENOENT' })
    const restarted = await boot({}, { cwd: f.cwd, root: f.root })
    expect((await restarted.tasks()).runs[0]!.status).toBe('interrupted')
    expect((await json<ReportReply>(await restarted.request(`/api/tasks/runs/${started.runId}`))).run.status).toBe('interrupted')
  }, 60_000)
})
