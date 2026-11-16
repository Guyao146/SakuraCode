/** File selection is previewed before the original and generated knowledge are published. */
import { randomUUID } from 'node:crypto'
import { DocumentService, DocumentError, type DocumentRevision, type DocumentContext } from '../documents/index.js'
import { KnowledgeStore, type KnowledgeRevision } from '../knowledge/index.js'

interface Ticket {
  documentId: string
  unitIds: string[]
  originalRevision: DocumentRevision
  files: Array<{ path: string; content: string }>
  knowledgePreviewId?: string
  knowledgeRevision: KnowledgeRevision
  expiresAt: number
}
export class DocumentImportService {
  readonly documents: DocumentService
  private tickets = new Map<string, Ticket>()
  private busy = false
  private closed = false
  constructor(cwd: string, private knowledge: KnowledgeStore) { this.documents = new DocumentService(cwd) }
  isBusy(): boolean { return this.busy }
  close(): void { this.closed = true; this.tickets.clear(); this.documents.dispose() }
  private check(context: DocumentContext) { if (this.closed) throw new DocumentError('CLOSED', 'Document import is closed', 409); context.signal?.throwIfAborted(); context.assertCurrent?.() }
  async prepare(input: { documentId: string; unitIds: string[]; collectionId?: string; revision?: KnowledgeRevision }, context: DocumentContext) {
    this.check(context)
    if (!input || typeof input.documentId !== 'string' || !Array.isArray(input.unitIds) || input.unitIds.some(id => typeof id !== 'string') ||
      input.collectionId !== undefined && (typeof input.collectionId !== 'string' || !/^collection_[a-f0-9-]{36}$/.test(input.collectionId))) throw new DocumentError('INVALID_SELECTION', 'Invalid import target or selected document units')
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.tickets.delete(id)
    if (this.tickets.size >= 4) throw new DocumentError('PREVIEW_LIMIT', 'Close another import preview first', 413)
    const selection = this.documents.select(input.documentId, input.unitIds, context), state = await this.knowledge.getVersionState(context.assertCurrent)
    if (state.errors.length) throw new DocumentError('INVALID_DOCUMENT', 'Knowledge metadata is not ready for import', 409)
    const originalRevision = await this.documents.store.snapshot(context)
    let files = selection.files, knowledgePreviewId: string | undefined
    let diff = { added: files.map(file => file.path), modified: [] as string[], removed: [] as string[], unchanged: [] as string[] }
    if (input.collectionId) {
      if (!input.revision || input.revision.revision !== state.revision || input.revision.fingerprint !== state.fingerprint) throw new DocumentError('INVALID_SELECTION', 'Knowledge collection changed; reload before preparing an import', 409)
      const collection = state.collections.find(c => c.id === input.collectionId), active = collection?.versions.find(v => v.id === collection.activeVersionId)
      if (!active?.available) throw new DocumentError('INVALID_SELECTION', 'Current knowledge version is unavailable', 409)
      const retained: Array<{ path: string; content: string }> = []
      for (const doc of active.documents) {
        this.check(context)
        if (files.some(file => file.path === doc.path)) continue
        const bytes = await this.knowledge.readRaw(doc.id, doc.version, () => this.check(context))
        retained.push({ path: doc.path, content: bytes.toString('utf8') })
      }
      files = [...retained, ...files]
      const preview = await this.knowledge.previewUpdate({ collectionId: input.collectionId, files }, input.revision, context.assertCurrent)
      knowledgePreviewId = preview.previewId; diff = preview.diff
    }
    this.check(context)
    const id = randomUUID(), expiresAt = Math.min(Date.now() + 5 * 60_000, this.documents.getPreview(input.documentId).expiresAt)
    this.tickets.set(id, { documentId: input.documentId, unitIds: [...input.unitIds], originalRevision, files, knowledgePreviewId,
      knowledgeRevision: { revision: state.revision, fingerprint: state.fingerprint }, expiresAt })
    return { id, expiresAt, diff, selectedFiles: selection.files.length, totalFiles: files.length,
      note: 'Existing collection documents are retained. Confirming stores the original locally and publishes the selected text.' }
  }
  async commit(id: string, context: DocumentContext) {
    this.check(context)
    if (this.busy) throw new DocumentError('BUSY', 'Another document import is active', 409)
    const ticket = this.tickets.get(id); this.tickets.delete(id)
    if (!ticket || ticket.expiresAt <= Date.now()) throw new DocumentError('PREVIEW_EXPIRED', 'Import preview expired; prepare it again', 409)
    this.busy = true
    try {
      const latest = await this.knowledge.getVersionState(context.assertCurrent)
      if (latest.revision !== ticket.knowledgeRevision.revision || latest.fingerprint !== ticket.knowledgeRevision.fingerprint) throw new DocumentError('INVALID_SELECTION', 'Knowledge changed after the import preview', 409)
      await this.documents.persistSelection(ticket.documentId, ticket.unitIds, ticket.originalRevision, context)
      this.check(context)
      if (ticket.knowledgePreviewId) {
        const result = await this.knowledge.commitUpdate(ticket.knowledgePreviewId, ticket.knowledgeRevision, context.assertCurrent)
        this.documents.discard(ticket.documentId)
        return { imported: ticket.unitIds.length, collectionId: result.collectionId, versionId: result.versionId }
      }
      const imported = await this.knowledge.importFiles({ files: ticket.files }, context.assertCurrent)
      const batch = imported.documents[0]!.id.split('/')[0]!
      try {
        this.check(context)
        const state = await this.knowledge.getVersionState(context.assertCurrent)
        const managed = await this.knowledge.adoptLegacy(batch, state, context.assertCurrent)
        this.documents.discard(ticket.documentId)
        return { imported: imported.imported, collectionId: managed.collectionId, versionId: managed.versionId }
      } catch {
        this.documents.discard(ticket.documentId)
        throw new DocumentError('PARTIAL_IMPORT', `Text was imported as batch ${batch}, but collection registration did not complete. The original and imported text are preserved. Refresh the knowledge list and register this batch; do not import it again.`, 409)
      }
    } finally { this.busy = false }
  }
  async cancel(id: string): Promise<void> {
    const ticket = this.tickets.get(id); this.tickets.delete(id)
    if (ticket?.knowledgePreviewId) await this.knowledge.cancelPreview(ticket.knowledgePreviewId)
  }
}
