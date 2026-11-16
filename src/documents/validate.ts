import { createHash } from 'node:crypto'
import { DOCUMENT_LIMITS as L, DocumentError, type DocumentManifest } from './types.js'
export const documentHash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const HASH = /^[a-f0-9]{64}$/
const isHash = (value: unknown): value is string => typeof value === 'string' && HASH.test(value)
const invalid = (): never => { throw new DocumentError('INVALID_MANIFEST', 'Invalid document provenance manifest', 409) }
export function documentOriginalPath(sha256: string): string {
  if (!isHash(sha256)) invalid()
  return `.sakura/documents/originals/${sha256}.bin`
}
export function validateDocumentManifest(value: unknown): DocumentManifest {
  if (!value || typeof value !== 'object') invalid()
  let encoded: string
  try { encoded = JSON.stringify(value) } catch { return invalid() }
  if (Buffer.byteLength(encoded) > L.maxManifestBytes) invalid()
  const m = JSON.parse(encoded) as DocumentManifest
  if (m.version !== 1 || !Number.isSafeInteger(m.revision) || m.revision < 0 || !Array.isArray(m.originals) || !Array.isArray(m.artifacts) || m.originals.length > L.maxOriginals || m.artifacts.length > L.maxArtifacts) invalid()
  const originals = new Map<string, string>(), artifacts = new Set<string>()
  let total = 0
  for (const o of m.originals) {
    if (!o || !isHash(o.sha256) || !Number.isSafeInteger(o.bytes) || o.bytes <= 0 || o.bytes > L.maxInputBytes || !['pdf', 'docx'].includes(o.kind) || originals.has(o.sha256)) invalid()
    originals.set(o.sha256, o.kind); total += o.bytes
  }
  if (total > L.maxStoredOriginalBytes) invalid()
  const used = new Set<string>()
  for (const a of m.artifacts) {
    if (!a || !isHash(a.sha256) || artifacts.has(a.sha256) || !isHash(a.originalSha256) || !originals.has(a.originalSha256) || !Number.isSafeInteger(a.bytes) || a.bytes <= 0 || a.bytes > L.maxFileBytes || typeof a.path !== 'string' || !/^document-[a-f0-9]{64}-(?:page|block)-[1-9][0-9]*\.txt$/.test(a.path) || typeof a.name !== 'string' || a.name.length > 200 || /[\x00-\x1f\x7f]/.test(a.name) || typeof a.parserVersion !== 'string' || a.parserVersion.length > 160 || !Array.isArray(a.units) || a.units.length !== 1) invalid()
    for (const u of a.units) {
      if (!u || typeof u.label !== 'string' || u.label.length > 100 || typeof u.id !== 'string' || !/^(?:page|block)-[1-9][0-9]*$/.test(u.id)) invalid()
      const s = u.sourceLocator
      if (!s || s.kind !== originals.get(a.originalSha256)) invalid()
      if (s.kind === 'pdf' ? !Number.isInteger(s.page) || s.page < 1 || s.page > L.maxPages || u.id !== `page-${s.page}` : !Number.isInteger(s.block) || s.block < 1 || s.block > L.maxUnits || !['paragraph', 'table'].includes(s.blockType) || u.id !== `block-${s.block}`) invalid()
      if (a.path !== `document-${a.originalSha256}-${u.id}.txt`) invalid()
    }
    artifacts.add(a.sha256); used.add(a.originalSha256)
  }
  if (used.size !== originals.size) invalid()
  return JSON.parse(JSON.stringify(m)) as DocumentManifest
}
export function validateDocumentSnapshot(manifest: unknown, originals: ReadonlyMap<string, Uint8Array>): DocumentManifest {
  const m = validateDocumentManifest(manifest)
  if (originals.size !== m.originals.length) invalid()
  for (const o of m.originals) {
    const bytes = originals.get(o.sha256)
    if (!(bytes instanceof Uint8Array) || bytes.length !== o.bytes || documentHash(bytes) !== o.sha256) invalid()
  }
  return m
}
