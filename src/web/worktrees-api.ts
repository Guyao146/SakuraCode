/** Explicit local worktree operations and independent task execution. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorktreeError, type WorktreeService } from '../worktrees/index.js'
import type { IsolatedTasks } from './isolated-tasks.js'
import { HttpError, json } from './http.js'
export async function handleWorktreeApi(req: IncomingMessage, res: ServerResponse, url: URL, api: {
  service: WorktreeService; execution: IsolatedTasks; workspaceId: string; current(): void; idle(): void;
  signal: AbortSignal; body(): Promise<Record<string, unknown>>; taskExists(id: string): Promise<boolean>
}): Promise<void> {
  const op = { signal: api.signal, assertCurrent: api.current }
  const reply = (value: unknown) => { api.current(); json(res, 200, { ...(value as object), workspaceId: api.workspaceId }) }
  try {
    api.current()
    if (req.method === 'GET') {
      if (url.pathname === '/api/worktrees') { reply(await api.service.list(op)); return }
      const id = url.searchParams.get('id') || ''
      if (url.pathname.endsWith('/read')) { reply(await api.service.read(id, op)); return }
      if (url.pathname.endsWith('/status')) { reply(await api.execution.status(id, api.current)); return }
      if (url.pathname.endsWith('/records')) { reply(await api.execution.records(id, api.current)); return }
      if (url.pathname.endsWith('/report')) { reply(await api.execution.validationReport(id, url.searchParams.get('runId') || '', api.current)); return }
    }
    if (req.method !== 'POST') throw new HttpError(404, 'unknown independent task operation')
    const body = await api.body(); api.current()
    if (body.confirmed !== true) throw new HttpError(400, '请明确确认独立任务操作。')
    const id = typeof body.id === 'string' ? body.id : ''
    const action = url.pathname.slice('/api/worktrees/'.length)
    if (action === 'stop') { await api.execution.stop(id); reply({ stopped: true }); return }
    if (action === 'release') { await api.execution.release(id); reply({ closed: true }); return }
    if (['start', 'open', 'verify'].includes(action)) {
      if (typeof body.model !== 'string' || typeof body.adapter !== 'string') throw new HttpError(400, '请明确选择模型与提供方。')
      const choice = { model: body.model, adapter: body.adapter }
      if (action === 'start') reply(await api.execution.send(id, body.text as string, choice, api.current))
      else if (action === 'open') reply(await api.execution.reopen(id, choice, api.current))
      else reply(await api.execution.verify(id, choice, api.current))
      return
    }
    api.idle()
    if (action === 'preview-create') {
      if (typeof body.taskId !== 'string' || !await api.taskExists(body.taskId)) throw new HttpError(404, '请选择现有持久任务。')
      reply(await api.service.previewCreate({ taskId: body.taskId, baseRef: body.baseRef as string | undefined }, op)); return
    }
    if (action === 'create') { reply(await api.service.create({ previewId: body.previewId as string, expectedFingerprint: body.expectedFingerprint as string }, op)); return }
    if (api.execution.isRunning(id)) throw new HttpError(409, '请先停止独立任务与验收，再整合或清理。')
    if (action === 'preview-integrate') {
      reply(await api.service.previewIntegrate({ id, expectedFingerprint: body.expectedFingerprint as string, paths: body.paths as string[] }, op)); return
    }
    if (action === 'integrate') {
      if (api.execution.isBusy()) throw new HttpError(409, '独立任务仍在运行，请等待结束再整合。')
      if (!id) throw new HttpError(400, '独立目录 ID 必填。')
      await api.execution.release(id)
      reply(await api.service.integrate({ previewId: body.previewId as string, expectedFingerprint: body.expectedFingerprint as string }, op)); return
    }
    if (action === 'cleanup') {
      if (body.discard === true && body.confirmDiscard !== true) throw new HttpError(400, '放弃未整合成果需要单独确认。')
      await api.execution.release(id)
      reply(await api.service.cleanup({ id, expectedFingerprint: body.expectedFingerprint as string, discard: body.discard === true }, op)); return
    }
    throw new HttpError(404, 'unknown independent task operation')
  } catch (error) {
    if (error instanceof WorktreeError) throw new HttpError(error.status, error.message + (error.recoveryPath ? ` Recovery: ${error.recoveryPath}` : ''))
    throw error
  }
}
