/** Raw-byte Git snapshots and downloads are explicit local-operator actions. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GitReviewError, type GitReviewService, type GitPatchRange } from '../git/index.js'
import { HttpError, json } from './http.js'

export async function handleGitReviewApi(req: IncomingMessage, res: ServerResponse, url: URL, options: {
  review: GitReviewService; workspaceId: string; current(): void; idle(): void; signal: AbortSignal;
  body(limit?: number): Promise<Record<string, unknown>>
}): Promise<void> {
  const { review, workspaceId, current, idle, signal } = options
  const reply = (result: unknown) => { current(); json(res, 200, { ...(result as object), workspaceId }) }
  try {
    current()
    if (req.method === 'GET' && url.pathname === '/api/git-review') {
      reply(await review.getSnapshot({ baseRef: url.searchParams.get('baseRef') || undefined, signal })); return
    }
    if (req.method !== 'POST') throw new HttpError(404, 'unknown Git review operation')
    const body = await options.body(32 * 1024); current()
    if (body.confirmed !== true) throw new HttpError(400, 'confirm the selected review operation')
    const args = { expectedSnapshotId: body.expectedSnapshotId as string, baseRef: body.baseRef as string | undefined,
      selectedUntracked: body.selectedUntracked as string[] | undefined, signal }
    if (url.pathname === '/api/git-review/read') {
      reply(await review.readUntracked({ ...args, path: body.path as string })); return
    }
    idle()
    if (url.pathname === '/api/git-review/reviewed') {
      reply(await review.markReviewed({ ...args, expectedStoreFingerprint: body.expectedStoreFingerprint as string,
        fileId: body.fileId as string, reviewed: body.reviewed as boolean })); return
    }
    if (url.pathname === '/api/git-review/export') {
      const patch = await review.exportPatch({ ...args, fileIds: body.fileIds as string[], range: body.range as GitPatchRange })
      current()
      res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${patch.filename.replace(/[^A-Za-z0-9_.-]/g, '_')}"` })
      res.end(patch.patch); return
    }
    throw new HttpError(404, 'unknown Git review operation')
  } catch (error) { if (error instanceof GitReviewError) throw new HttpError(error.status, error.message); throw error }
}
