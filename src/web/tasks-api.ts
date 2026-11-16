/** Local-operator task API. No task definitions or logs enter the general SSE state. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { HttpError, json } from './http.js'
import { TaskError, type TaskRevision } from '../tasks/types.js'
import { exportTaskReport, type TasksService } from '../tasks/service.js'

interface TaskApiContext {
  service: TasksService
  workspaceId: string
  current(): void
  idle(): void
  main(): { id: string; sessionId: string }
  body(limit?: number): Promise<Record<string, unknown>>
  notify(): void
  rememberRun(sessionId: string, taskId: string, runId: string): Promise<void>
}
export async function handleTaskApi(req: IncomingMessage, res: ServerResponse, url: URL, api: TaskApiContext): Promise<void> {
  const method = req.method ?? 'GET', route = url.pathname
  const expected = (body: Record<string, unknown>): TaskRevision => ({ revision: body.revision as number, fingerprint: body.fingerprint as string })
  const reply = (result: unknown, status = 200) => { api.current(); json(res, status, { ...(result as object), workspaceId: api.workspaceId }) }
  try {
    api.current()
    if (method === 'GET' && route === '/api/tasks') { reply(await api.service.snapshot()); return }
    const report = /^\/api\/tasks\/runs\/([A-Za-z0-9_-]+)(\/export)?$/.exec(route)
    if (method === 'GET' && report) {
      const result = await api.service.report(report[1]!)
      api.current()
      if (report[2]) {
        const text = exportTaskReport(result.run)
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store',
          'content-disposition': `attachment; filename="validation-${result.run.id}.md"` })
        res.end(text)
      } else reply(result)
      return
    }
    if (method !== 'POST') throw new HttpError(404, 'unknown task operation')
    const body = await api.body(256 * 1024); api.current()
    if (body.confirmed !== true) throw new HttpError(400, 'task changes require explicit confirmation')
    if (route === '/api/tasks/cancel') { api.service.cancel(typeof body.runId === 'string' ? body.runId : undefined); reply({ stopping: true }); return }
    api.idle()
    if (route === '/api/tasks') {
      const saved = await api.service.store.upsert(body.task, expected(body), api.current); api.notify(); reply(saved); return
    }
    if (route === '/api/tasks/checks') {
      const saved = await api.service.store.saveChecks(body.checks, expected(body), api.current); api.notify(); reply(saved); return
    }
    if (route === '/api/tasks/accept') {
      if (typeof body.taskId !== 'string' || typeof body.note !== 'string') throw new HttpError(400, 'task and acceptance note required')
      const saved = await api.service.accept(body.taskId, body.note, expected(body), api.current); api.notify(); reply(saved); return
    }
    if (route === '/api/tasks/verify') {
      if (typeof body.taskId !== 'string') throw new HttpError(400, 'task ID required')
      const main = api.main()
      const run = await api.service.start({ taskId: body.taskId, expected: expected(body), agentId: main.id,
        ...(main.sessionId && !main.sessionId.startsWith('pending') ? { sessionId: main.sessionId } : {}), skipIds: body.skipIds as string[] | undefined }, api.current)
      if (run.sessionId) await api.rememberRun(run.sessionId, run.taskId, run.id).catch(() => {})
      reply({ runId: run.id }, 202); return
    }
    throw new HttpError(404, 'unknown task operation')
  } catch (error) {
    if (error instanceof TaskError) throw new HttpError(error.status, error.message)
    throw error
  }
}
