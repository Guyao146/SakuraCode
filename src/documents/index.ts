import { randomUUID } from 'node:crypto'
import { runParser } from './parser.js'
import { DocumentStore, type DocumentSnapshot } from './store.js'
import { documentHash } from './validate.js'
import { checkContext, DOCUMENT_LIMITS as L, PARSER_VERSION, DocumentError, type DocumentPreview,
  type DocumentSelection, type DocumentRevision, type DocumentContext, type DocumentKind } from './types.js'
export * from './types.js'
export * from './store.js'
export * from './validate.js'
interface Cached { preview: DocumentPreview; bytes: Uint8Array; size: number }
let activeParsers = 0
/** Knowledge prepare/commit belongs to the caller: merge complete collection files, then use its version pipeline. */
export class DocumentService {
  readonly store: DocumentStore
  private previews = new Map<string, Cached>()
  private busy = false
  constructor(cwd: string) { this.store = new DocumentStore(cwd) }
  private prune() { for (const [id, item] of this.previews) if (item.preview.expiresAt <= Date.now()) this.previews.delete(id) }
  private cached(id: string): Cached {
    this.prune()
    const item = this.previews.get(id)
    if (!item) throw new DocumentError('PREVIEW_EXPIRED', 'Document preview expired or does not exist; parse again', 410)
    return item
  }
  async parse(input: { name: string; bytes: Uint8Array }, signal?: AbortSignal): Promise<DocumentPreview> {
    checkContext({ signal }); this.prune()
    if (this.busy || activeParsers >= 2) throw new DocumentError('BUSY', 'Document parser is busy; try again after it finishes', 429)
    const name = input?.name
    if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name)) throw new DocumentError('INVALID_NAME', 'A plain document filename is required')
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > L.maxInputBytes) throw new DocumentError('INPUT_LIMIT', 'Document input is empty or exceeds the byte limit', 413)
    const kind: DocumentKind | undefined = /\.pdf$/i.test(name) ? 'pdf' : /\.docx$/i.test(name) ? 'docx' : undefined
    if (!kind) throw new DocumentError('UNSUPPORTED_TYPE', 'Only text PDF and DOCX documents are supported')
    const magic = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, Math.min(input.bytes.length, 8))
    if (kind === 'pdf' ? !magic.subarray(0, 5).equals(Buffer.from('%PDF-')) : !magic.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]))) throw new DocumentError('INVALID_DOCUMENT', 'Document bytes do not match the filename type')
    const retained = Array.from(this.previews.values()).reduce((sum, item) => sum + item.size, 0)
    if (this.previews.size >= L.maxPreviews || retained + input.bytes.length + L.maxOutputBytes > L.maxPreviewBytes) throw new DocumentError('PREVIEW_LIMIT', 'Discard an existing document preview before parsing another', 413)
    const bytes = Uint8Array.from(input.bytes), sha256 = documentHash(bytes)
    this.busy = true; activeParsers++
    try {
      const parsed = await runParser(bytes, kind, signal)
      checkContext({ signal })
      const preview: DocumentPreview = { ...parsed, id: `document_${randomUUID()}`, name, sha256, expiresAt: Date.now() + L.previewTtlMs, parserVersion: PARSER_VERSION }
      this.previews.set(preview.id, { preview, bytes, size: bytes.length + Buffer.byteLength(JSON.stringify(preview)) })
      return structuredClone(preview)
    } finally { this.busy = false; activeParsers-- }
  }
  getPreview(previewId: string): DocumentPreview { return structuredClone(this.cached(previewId).preview) }
  discard(previewId: string): void { this.previews.delete(previewId) }
  dispose(): void { this.previews.clear() }
  select(previewId: string, selectedUnitIds: readonly string[], context?: DocumentContext): DocumentSelection {
    checkContext(context)
    const { preview } = this.cached(previewId)
    if (!Array.isArray(selectedUnitIds) || !selectedUnitIds.length || selectedUnitIds.length > L.maxFiles || new Set(selectedUnitIds).size !== selectedUnitIds.length) throw new DocumentError('INVALID_SELECTION', 'Select between 1 and 128 distinct document units; select fewer units when over budget', 413)
    const ids = new Set(selectedUnitIds)
    if (selectedUnitIds.some(id => !preview.units.some(unit => unit.id === id))) throw new DocumentError('INVALID_SELECTION', 'Selected document unit does not exist')
    const files: DocumentSelection['files'] = [], artifacts: DocumentSelection['artifacts'] = []
    let total = 0
    for (const unit of preview.units) {
      if (!ids.has(unit.id)) continue
      if (!unit.text.trim()) throw new DocumentError('NO_TEXT', `Selected ${unit.label} contains no extractable text`)
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(unit.text)) throw new DocumentError('INVALID_TEXT', `Selected ${unit.label} contains control characters unsupported by the knowledge store`)
      const locator = unit.sourceLocator.kind === 'pdf' ? `PDF physical page ${unit.sourceLocator.page}` : `DOCX body ${unit.sourceLocator.blockType} at block ${unit.sourceLocator.block}`
      const content = `Source: ${preview.name}\nOriginal SHA-256: ${preview.sha256}\nLocation: ${locator}\nParser: ${preview.parserVersion}\n\n${unit.text}\n`
      const bytes = Buffer.byteLength(content), path = `document-${preview.sha256}-${unit.id}.txt`
      if (bytes > L.maxFileBytes || (total += bytes) > L.maxTotalBytes) throw new DocumentError('KNOWLEDGE_LIMIT', 'Selected text exceeds the knowledge file/total budget; select fewer units. No text was truncated.', 413)
      files.push({ path, content }); artifacts.push({ path, bytes, sha256: documentHash(content), originalSha256: preview.sha256,
        name: preview.name, parserVersion: preview.parserVersion, units: [{ id: unit.id, label: unit.label, sourceLocator: structuredClone(unit.sourceLocator) }] })
    }
    return { previewId, files, artifacts }
  }
  /** Call only after explicit confirmation, before knowledge registration. If later registration fails, this is a non-searchable orphan. */
  async persistSelection(previewId: string, selectedUnitIds: readonly string[], expected: DocumentRevision, context?: DocumentContext): Promise<DocumentSnapshot> {
    const selection = this.select(previewId, selectedUnitIds, context), cached = this.cached(previewId)
    return this.store.commit({ bytes: cached.bytes, kind: cached.preview.kind, artifacts: selection.artifacts }, expected, context)
  }
}
