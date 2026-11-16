/** Local data APIs. Confirmation and workspace ownership are checked by the caller. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { BackupError, BACKUP_LIMITS, type BackupSelection } from '../backup/types.js'
import type { BackupService } from '../backup/service.js'
import { DocumentError, DOCUMENT_LIMITS } from '../documents/index.js'
import type { DocumentImportService } from './document-import.js'
import { KnowledgeError } from '../knowledge/index.js'
import type { ConnectorsService } from '../connectors/index.js'
import { ConnectorError } from '../connectors/types.js'
import { HttpError, json } from './http.js'

export function base64Bytes(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new HttpError(400, 'invalid or oversized base64 payload')
  const bytes = Buffer.from(value, 'base64')
  if (!bytes.length || bytes.length > max) throw new HttpError(413, 'upload exceeds its byte limit')
  return bytes
}
export async function handleDataApi(req: IncomingMessage, res: ServerResponse, url: URL, options: {
  backup: BackupService; documents?: DocumentImportService; connectors?: ConnectorsService;
  workspaceId: string; current(): void; idle(): void; signal: AbortSignal;
  body(limit?: number): Promise<Record<string, unknown>>
}): Promise<void> {
  const route = url.pathname, { current, idle, signal } = options
  const reply = (value: unknown) => { current(); json(res, 200, { ...(value as object), workspaceId: options.workspaceId }) }
  const context = { signal, assertCurrent: current }
  try {
    current()
    if (req.method === 'GET') {
      if (route === '/api/backups') { reply(await options.backup.catalog(current)); return }
      if (route === '/api/documents') {
        if (!options.documents) throw new HttpError(404, 'document import unavailable')
        reply(await options.documents.documents.store.snapshot(context)); return
      }
      if (route === '/api/documents/original') {
        if (!options.documents) throw new HttpError(404, 'document import unavailable')
        const bytes = await options.documents.documents.store.readOriginal(url.searchParams.get('hash') || '', context)
        current(); res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
          'content-disposition': 'attachment; filename="original-document.bin"' }); res.end(bytes); return
      }
      if (route === '/api/connector-wizard') { if (!options.connectors) throw new HttpError(404, 'connectors unavailable'); reply({ templates: options.connectors.templates() }); return }
      throw new HttpError(404, 'unknown local data operation')
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed')
    const body = await options.body(route.startsWith('/api/backups/') ? BACKUP_LIMITS.archiveBytes * 1.4 + 4096 : route === '/api/documents/parse' ? DOCUMENT_LIMITS.maxInputBytes * 1.4 + 4096 : 256 * 1024)
    current()
    if (body.confirmed !== true && route !== '/api/connector-wizard/preflight') throw new HttpError(400, 'explicit confirmation is required')
    if (route.startsWith('/api/backups/')) {
      idle()
      if (route === '/api/backups/preview') { reply(await options.backup.previewBackup(body.selection as BackupSelection, current)); return }
      if (route === '/api/backups/download') {
        const bytes = await options.backup.download(String(body.id), String(body.fingerprint), current); current()
        res.writeHead(200, { 'content-type': 'application/gzip', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="sakuracode-workspace.sakura-backup"' }); res.end(bytes); return
      }
      if (route === '/api/backups/inspect') { reply(await options.backup.previewRestore(base64Bytes(body.base64, BACKUP_LIMITS.archiveBytes), current)); return }
      if (route === '/api/backups/restore') { reply(await options.backup.restore(String(body.id), String(body.fingerprint), body.parent as string, body.name as string, current)); return }
      if (route === '/api/backups/cancel') { reply(options.backup.cancel(String(body.id))); return }
    }
    if (route.startsWith('/api/documents/')) {
      const service = options.documents; if (!service) throw new HttpError(404, 'document import unavailable')
      if (route === '/api/documents/parse') { reply(await service.documents.parse({ name: body.name as string, bytes: base64Bytes(body.base64, DOCUMENT_LIMITS.maxInputBytes) }, signal)); return }
      if (route === '/api/documents/prepare') {
        idle(); reply(await service.prepare({ documentId: body.documentId as string, unitIds: body.unitIds as string[], collectionId: body.collectionId as string | undefined,
          revision: body.revision as { revision: number; fingerprint: string } | undefined }, context)); return
      }
      if (route === '/api/documents/commit') { idle(); reply(await service.commit(body.id as string, context)); return }
      if (route === '/api/documents/cancel') { await service.cancel(String(body.id)); if (typeof body.documentId === 'string') service.documents.discard(body.documentId); reply({ cancelled: true }); return }
    }
    if (route.startsWith('/api/connector-wizard/')) {
      const service = options.connectors; if (!service) throw new HttpError(404, 'connectors unavailable')
      if (route === '/api/connector-wizard/preflight') { reply(service.preflight(body.connection)); return }
      if (route === '/api/connector-wizard/diagnose') { idle(); reply(await service.diagnose(body.connection, context)); return }
    }
    throw new HttpError(404, 'unknown local data operation')
  } catch (error) {
    if (error instanceof BackupError || error instanceof DocumentError || error instanceof KnowledgeError || error instanceof ConnectorError) throw new HttpError(error.status, error.message)
    throw error
  }
}
