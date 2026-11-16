import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import type { ModelAdapter, LLMRequest, StreamChunk } from '../src/core/types.js'
import type { WorktreeInfo, WorktreeCreatePreview } from '../src/worktrees/index.js'
import type { TaskSnapshot } from '../src/tasks/types.js'
const roots: string[] = [], handles: WebServerHandle[] = []
afterEach(async () => { while (handles.length) await handles.pop()!.close(); while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 5 }) })
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-worktree-api-')); roots.push(cwd)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(cwd, 'base.txt'), 'baseline'); git('add', 'base.txt'); git('commit', '-m', 'baseline')
  const requests: LLMRequest[] = []
  const adapter: ModelAdapter = { id: 'offline', defaultModel: 'fixture', models: ['fixture'], async *stream(req): AsyncIterable<StreamChunk> {
    requests.push(req)
    if (!req.messages.some(message => message.role === 'tool')) yield { type: 'tool_call', index: 0, id: 'write-local', name: 'write', argsDelta: JSON.stringify({ file_path: 'child.txt', content: 'independent only' }) }
    else yield { type: 'text', delta: 'COMPLETED_INDEPENDENT' }
    yield { type: 'done', reason: req.messages.some(message => message.role === 'tool') ? 'stop' : 'tool_calls' }
  } }
  const web = await runWebServer({ cwd, adapter, approvalMode: 'yolo', open: false, quiet: true, updatesAutoCheck: false,
    config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { disabled: true } } } }); handles.push(web)
  const state = await (await fetch(web.url + 'api/state')).json() as { workspaceId: string }
  const request = async <T>(route: string, body?: unknown, expected = 200) => {
    const response = await fetch(web.url + route, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'X-Sakura-Workspace': state.workspaceId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(expected); return result as T
  }
  const saved = await web.harness.ctx.tasks!.store.upsert({ title: 'isolated test', description: '', priority: 'medium', status: 'pending', steps: [], criteria: [], checkIds: [], archived: false }, await web.harness.ctx.tasks!.snapshot())
  const preview = await request<WorktreeCreatePreview>('api/worktrees/preview-create', { taskId: saved.tasks[0]!.id, confirmed: true })
  const info = await request<WorktreeInfo>('api/worktrees/create', { previewId: preview.id, expectedFingerprint: preview.fingerprint, confirmed: true })
  roots.push(path.dirname(info.path))
  return { cwd, web, request, info, requests, saved }
}
describe('local independent task execution', () => {
  it('requires confirmation, writes only the separate tree, and resumes records without replaying a model request', async () => {
    const f = await fixture()
    expect(f.requests).toHaveLength(0)
    await f.request('api/worktrees/start', { id: f.info.id, model: 'fixture', adapter: 'offline', text: 'task' }, 400)
    await f.request('api/worktrees/open', { id: f.info.id, model: 'fixture', adapter: 'offline', confirmed: true })
    expect(f.requests).toHaveLength(0)
    const post = { id: f.info.id, model: 'fixture', adapter: 'offline', text: 'write independent file', confirmed: true }
    await f.request('api/worktrees/start', post)
    await vi.waitFor(async () => { const status = await f.request<{ running: boolean; execution: { status: string } }>('api/worktrees/status?id=' + f.info.id); expect(status.running).toBe(false); expect(status.execution.status).toBe('done') }, { timeout: 15000 })
    expect(await fs.readFile(path.join(f.info.path, 'child.txt'), 'utf8')).toBe('independent only')
    await expect(fs.stat(path.join(f.cwd, 'child.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.requests).toHaveLength(2)
    const history = await f.request<{ records: unknown[] }>('api/worktrees/records?id=' + f.info.id)
    expect(JSON.stringify(history.records)).toContain('COMPLETED_INDEPENDENT')
    expect((await f.web.harness.ctx.sessions.list()).length).toBe(0)
    await f.request('api/worktrees/release', { id: f.info.id, confirmed: true })
    await f.request('api/worktrees/open', { id: f.info.id, model: 'fixture', adapter: 'offline', confirmed: true })
    expect(f.requests).toHaveLength(2)
    const tasks = await f.request<{ validation: TaskSnapshot }>('api/worktrees/status?id=' + f.info.id)
    expect(tasks.validation.tasks[0]!.id).not.toBe(f.saved.tasks[0]!.id)
  }, 60000)
})
