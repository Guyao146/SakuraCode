export const PARSER_VERSION = 'sakura-documents/1;pdfjs/4.10.38;docx/1'
export const DOCUMENT_LIMITS = Object.freeze({
  maxInputBytes: 16 * 1024 * 1024, maxPages: 256, maxUnits: 2048,
  maxCharacters: 2 * 1024 * 1024, maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 20_000, maxPreviews: 4, maxPreviewBytes: 48 * 1024 * 1024, previewTtlMs: 5 * 60_000,
  maxZipEntries: 512, maxZipEntryBytes: 8 * 1024 * 1024, maxZipTotalBytes: 32 * 1024 * 1024, maxZipRatio: 200,
  maxManifestBytes: 2 * 1024 * 1024, maxOriginals: 256, maxArtifacts: 2048, maxStoredOriginalBytes: 256 * 1024 * 1024,
  maxFiles: 128, maxFileBytes: 256 * 1024, maxTotalBytes: 4 * 1024 * 1024,
})
export type DocumentKind = 'pdf' | 'docx'
export type SourceLocator = { kind: 'pdf'; page: number } | { kind: 'docx'; block: number; blockType: 'paragraph' | 'table' }
export interface DocumentUnit { id: string; label: string; text: string; sourceLocator: SourceLocator }
export interface ParsedDocument { kind: DocumentKind; units: DocumentUnit[]; warnings: string[] }
export interface DocumentPreview extends ParsedDocument { id: string; sha256: string; name: string; expiresAt: number; parserVersion: string }
export interface DocumentArtifact {
  sha256: string; bytes: number; path: string; originalSha256: string; name: string; parserVersion: string
  units: { id: string; label: string; sourceLocator: SourceLocator }[]
}
export interface DocumentSelection { previewId: string; files: { path: string; content: string }[]; artifacts: DocumentArtifact[] }
export interface DocumentManifest {
  version: 1; revision: number
  originals: { sha256: string; bytes: number; kind: DocumentKind }[]
  artifacts: DocumentArtifact[]
}
export interface DocumentRevision { revision: number; fingerprint: string }
export interface DocumentContext { signal?: AbortSignal; assertCurrent?: () => void }
export class DocumentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); this.name = 'DocumentError' }
}
export function checkContext(context?: DocumentContext): void {
  if (context?.signal?.aborted) throw new DocumentError('CANCELLED', 'Document operation cancelled', 499)
  context?.assertCurrent?.()
}
