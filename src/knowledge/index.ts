/** Bounded, workspace-local UTF-8 reference documents; never executable instructions. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'
import { retrieveText, type RetrievalItem, type RetrievalHit } from '../util/retrieval.js'
import type {
  KnowledgeRevision, KnowledgeVersionDocument, KnowledgeCollection,
  KnowledgeVersionState, KnowledgeUpdateInput, KnowledgeUpdatePreview, KnowledgeVersionMutation,
  KnowledgeManifest, StoredKnowledgeCollection, StoredKnowledgeVersion, StoredKnowledgeFile,
} from './versions.js'
export type {
  KnowledgeRevision, KnowledgeVersionDocument, KnowledgeCollectionVersion, KnowledgeCollection,
  KnowledgeLegacyBatch, KnowledgeVersionState, KnowledgeUpdateInput, KnowledgeUpdatePreview, KnowledgeVersionMutation,
} from './versions.js'

export const KNOWLEDGE_LIMITS = Object.freeze({
  maxFiles: 128,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxCollections: 32,
  maxVersions: 64,
  maxManifestBytes: 512 * 1024,
  maxPreviews: 8,
  maxPreviewBytes: 8 * 1024 * 1024,
  previewTtlMs: 5 * 60 * 1000,
  readLines: 200,
  readChars: 12_000,
})

export interface KnowledgeDocument {
  id: string
  name: string
  source: string
  version: string
  lines: number
  bytes: number
}

export interface KnowledgeRead {
  id: string
  source: string
  version: string
  startLine: number
  endLine: number
  totalLines: number
  content: string
  truncated: boolean
  /** Paired continuation cursor when truncated; absent at EOF. */
  nextOffset?: number
  /** 0-based UTF-16 offset within nextOffset's physical line, not a byte offset. */
  nextCharOffset?: number
}

export interface KnowledgeHit extends RetrievalHit {
  documentId: string
  version: string
  /** Long-line chunk's 0-based UTF-16 start within startLine; ordinary line hits omit it. */
  charOffset?: number
}

export class KnowledgeError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'KnowledgeError'
  }
}

/** offset is 1-based; charOffset is a 0-based UTF-16 offset within that first line. */
type ReadOptions = { offset?: number; charOffset?: number; limit?: number; maxChars?: number; version?: string }
type SearchOptions = { limit?: number; maxChars?: number }
type Entry = { document: KnowledgeDocument; text: string; fingerprint: string }
type Snapshot = {
  entries: Map<string, Entry>
  allEntries: Map<string, Entry>
  invalidDocuments: Set<string>
  revision: string
  errors: string[]
  files: number
  bytes: number
  overLimit: boolean
  metadataError?: string
  disk: ManifestDisk
  versionState: KnowledgeVersionState
  inventories?: { legacy: Inventory; managed: Inventory }
}
type ManifestDisk = KnowledgeRevision & { manifest: KnowledgeManifest; exists: boolean }
type Inventory = {
  entries: Map<string, Entry>
  paths: Set<string>
  directories: Set<string>
  issues: Set<string>
}
type ScanBudget = { files: number; bytes: number; readBytes: number; visited: number; overLimit: boolean; stopped: boolean }
type PreparedFile = { path: string; bytes: Buffer; text: string }
type Preview = { result: KnowledgeUpdatePreview; files: PreparedFile[]; baseline: string }
type CurrentCheck = () => void
type CurrentAsyncCheck = () => Promise<void>

class CurrentAssertionError extends Error {
  constructor(readonly original: unknown) { super('workspace changed during knowledge operation') }
}

const MAX_DEPTH = 8
const MAX_WALK_ENTRIES = 2048
const CHUNK_CHARS = 2000
// Query-sized overlap covers matches at chunk seams; every step advances by at least 1742 units.
const CHUNK_OVERLAP = 256
const importLocks = new Map<string, Promise<void>>()
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const fingerprint = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.nlink}`
// Physical source lines are preserved; read/search retain the legacy CRLF/CR → LF output.
// All character positions count UTF-16 code units within a line, not raw UTF-8 byte offsets.
const linesOf = (text: string) => text.length ? text.split(/\r\n|\n|\r/) : []
const controlText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/
const sha256 = /^[a-f0-9]{64}$/
const uuidPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const versionPattern = new RegExp(`^version_${uuidPattern}$`)
const collectionPattern = new RegExp(`^collection_${uuidPattern}$`)
const previewPattern = new RegExp(`^preview_${uuidPattern}$`)
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const pathKey = (value: string) => value.toLowerCase().normalize('NFC')
const within = (id: string, directory: string) => id.startsWith(`${directory}/`)
const identity = (stat: Stats) => `${stat.dev}:${stat.ino}`
const emptyDisk = (): ManifestDisk => ({ revision: 0, fingerprint: hash('missing'), exists: false,
  manifest: { version: 1, revision: 0, collections: [] } })
const emptyVersionState = (disk = emptyDisk()): KnowledgeVersionState => ({
  revision: disk.revision, fingerprint: disk.fingerprint, collections: [], legacyBatches: [],
  unmanagedDocuments: [], orphans: [], usage: { files: 0, bytes: 0, versions: 0, collections: 0, overLimit: false }, errors: [],
})
const emptySnapshot = (disk = emptyDisk()): Snapshot => ({ entries: new Map(), allEntries: new Map(),
  invalidDocuments: new Set(), revision: hash(''), errors: [], files: 0, bytes: 0, overLimit: false,
  disk, versionState: emptyVersionState(disk) })

async function checked<T>(check: CurrentCheck | undefined, action: () => Promise<T>): Promise<T> {
  check?.()
  const result = await action()
  check?.()
  return result
}

function currentCheck(assertCurrent?: CurrentCheck): CurrentCheck {
  return () => {
    try { assertCurrent?.() }
    catch (error) { throw new CurrentAssertionError(error) }
  }
}

async function operation<T>(action: (check: CurrentCheck) => Promise<T>, assertCurrent?: CurrentCheck,
  failure = 'knowledge version operation failed; existing versions were preserved'): Promise<T> {
  try { return await action(currentCheck(assertCurrent)) }
  catch (error) {
    if (error instanceof CurrentAssertionError) throw error.original
    if (error instanceof KnowledgeError) throw error
    // Do not retain fs Error causes: HTTP serializers may expose their private absolute paths.
    throw new KnowledgeError(500, failure)
  }
}

function expectedRevision(value: KnowledgeRevision): KnowledgeRevision {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      typeof value.fingerprint !== 'string' || !sha256.test(value.fingerprint)) {
    throw new KnowledgeError(400, 'a current knowledge revision and fingerprint are required')
  }
  return { revision: value.revision, fingerprint: value.fingerprint }
}

function sameRevision(actual: KnowledgeRevision, expected: KnowledgeRevision): void {
  if (actual.revision !== expected.revision || actual.fingerprint !== expected.fingerprint) {
    throw new KnowledgeError(409, 'knowledge metadata changed; reload and preview again')
  }
}

function contentHash(files: readonly StoredKnowledgeFile[]): string {
  return hash(JSON.stringify([...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    .map(file => [file.path, file.hash, file.bytes, file.lines])))
}

function storedFiles(files: readonly PreparedFile[]): StoredKnowledgeFile[] {
  return files.map(file => ({ path: file.path, hash: hash(file.bytes), bytes: file.bytes.length,
    lines: linesOf(file.text).length })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function versionDocuments(version: StoredKnowledgeVersion): KnowledgeVersionDocument[] {
  const sourceRoot = version.kind === 'legacy' ? '.sakura/knowledge' : '.sakura/knowledge-versions/versions'
  return version.files.map(file => {
    const id = `${version.directory}/${file.path}`
    return { id, name: path.posix.basename(file.path), path: file.path, source: `${sourceRoot}/${id}`,
      version: file.hash, bytes: file.bytes, lines: file.lines }
  })
}

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!)
}

function clip(text: string, chars: number): string {
  let end = Math.min(chars, text.length)
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  return text.slice(0, end)
}

/** Portable relative paths, including rejecting Windows drive/ADS/device aliases on Unix. */
function relativePath(value: unknown, maxSegments = MAX_DEPTH + 1): string {
  if (typeof value !== 'string' || !value || Buffer.from(value, 'utf8').toString('utf8') !== value ||
      /[\u0000-\u001f\u007f-\u009f<>:"|?*]/.test(value) ||
      path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new KnowledgeError(400, 'invalid knowledge relative path')
  }
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (parts.length > maxSegments || Buffer.byteLength(normalized, 'utf8') > 1024 || parts.some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || Buffer.byteLength(part, 'utf8') > 255 ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new KnowledgeError(400, 'invalid knowledge relative path')
  }
  return normalized
}

function validText(text: string): void {
  if (controlText.test(text) || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    throw new KnowledgeError(400, 'knowledge files must be valid UTF-8 text without control characters')
  }
}

function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new KnowledgeError(400, `${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function documentOf(id: string, text: string, bytes: Buffer, sourceRoot = '.sakura/knowledge'): KnowledgeDocument {
  return { id, name: path.posix.basename(id), source: `${sourceRoot}/${id}`,
    version: hash(bytes), lines: linesOf(text).length, bytes: bytes.length }
}

function prepareImport(value: unknown, allowEmpty = false, maxPathBytes = 981): PreparedFile[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeError(400, 'expected { files: [{ path, content }] }')
  const files = (value as Record<string, unknown>).files
  if (!Array.isArray(files) || (!allowEmpty && !files.length)) throw new KnowledgeError(400, allowEmpty ? 'files must be an array' : 'files must be a non-empty array')
  if (files.length > KNOWLEDGE_LIMITS.maxFiles) throw new KnowledgeError(413, 'knowledge file count limit exceeded')
  const names = new Set<string>()
  const spellings = new Map<string, string>()
  let total = 0
  return files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new KnowledgeError(400, 'invalid knowledge file')
    const record = file as Record<string, unknown>
    // The published batch directory uses one of the eight allowed directory levels.
    const relative = relativePath(record.path, MAX_DEPTH)
    if (Buffer.byteLength(relative, 'utf8') > maxPathBytes) throw new KnowledgeError(400, 'knowledge relative path is too long for a collection')
    if (!/\.(md|txt)$/i.test(relative)) throw new KnowledgeError(400, 'only .md and .txt knowledge files are supported')
    const nameKey = relative.toLowerCase().normalize('NFC')
    if ([...names].some(name => name === nameKey || name.startsWith(`${nameKey}/`) || nameKey.startsWith(`${name}/`))) {
      throw new KnowledgeError(409, 'duplicate or conflicting knowledge file paths')
    }
    names.add(nameKey)
    const parts = relative.split('/')
    for (let index = 1; index <= parts.length; index++) {
      const spelling = parts.slice(0, index).join('/')
      const spellingKey = spelling.toLowerCase().normalize('NFC')
      const previous = spellings.get(spellingKey)
      if (previous !== undefined && previous !== spelling) throw new KnowledgeError(409, 'ambiguous knowledge file paths')
      spellings.set(spellingKey, spelling)
    }
    if (typeof record.content !== 'string') throw new KnowledgeError(400, 'knowledge file content must be a string')
    if (record.content.length > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(413, 'knowledge file size limit exceeded')
    validText(record.content)
    const bytes = Buffer.from(record.content, 'utf8')
    if (bytes.length > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(413, 'knowledge file size limit exceeded')
    total += bytes.length
    if (total > KNOWLEDGE_LIMITS.maxTotalBytes) throw new KnowledgeError(413, 'knowledge total size limit exceeded')
    // Unknown metadata is deliberately ignored, not copied or interpreted.
    return { path: relative, bytes, text: record.content }
  })
}

function parseManifest(raw: string): KnowledgeManifest {
  const invalid = () => { throw new KnowledgeError(409, 'knowledge version manifest is invalid; existing data was preserved') }
  const record = (value: unknown, fields: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) return invalid()
    return value as Record<string, unknown>
  }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return invalid() }
  const root = record(value, ['version', 'revision', 'collections'])
  if (root.version !== 1 || !Number.isSafeInteger(root.revision) || (root.revision as number) < 0 ||
      !Array.isArray(root.collections) || root.collections.length > KNOWLEDGE_LIMITS.maxCollections) return invalid()
  const collectionIds = new Set<string>(), versionIds = new Set<string>(), legacyDirectories = new Set<string>()
  let totalFiles = 0, totalBytes = 0, totalVersions = 0
  try {
    const collections = root.collections.map(value => {
      const row = record(value, ['id', 'name', 'activeVersionId', 'versions'])
      if (typeof row.id !== 'string' || !collectionPattern.test(row.id) || collectionIds.has(row.id) ||
          typeof row.name !== 'string' || row.name.length > 255 || !Array.isArray(row.versions) || !row.versions.length) return invalid()
      collectionIds.add(row.id)
      const versions = row.versions.map((value, index) => {
        const version = record(value, ['id', 'number', 'createdAt', 'kind', 'directory', 'contentHash', 'files'])
        if (++totalVersions > KNOWLEDGE_LIMITS.maxVersions || typeof version.id !== 'string' ||
            !versionPattern.test(version.id) || versionIds.has(version.id) || version.number !== index + 1 ||
            !Number.isSafeInteger(version.createdAt) || (version.createdAt as number) < 0 ||
            version.kind !== (index ? 'managed' : 'legacy') || typeof version.directory !== 'string' ||
            typeof version.contentHash !== 'string' || !sha256.test(version.contentHash) || !Array.isArray(version.files)) return invalid()
        versionIds.add(version.id)
        if (version.kind === 'managed') {
          if (version.directory !== version.id) return invalid()
        } else {
          if (relativePath(version.directory, 1) !== version.directory ||
              legacyDirectories.has(pathKey(version.directory)) || row.name !== version.directory || !version.files.length) return invalid()
          legacyDirectories.add(pathKey(version.directory))
        }
        const prepared = prepareImport({ files: version.files.map(file => ({
          path: record(file, ['path', 'hash', 'bytes', 'lines']).path, content: '',
        })) }, true, 1024 - Buffer.byteLength(version.directory, 'utf8') - 1)
        const files = version.files.map((value, fileIndex) => {
          const file = value as Record<string, unknown>
          if (file.path !== prepared[fileIndex]!.path || typeof file.hash !== 'string' || !sha256.test(file.hash) ||
              !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > KNOWLEDGE_LIMITS.maxFileBytes ||
              !Number.isSafeInteger(file.lines) || (file.lines as number) < 0 || (file.lines as number) > (file.bytes as number) + 1 ||
              ((file.bytes === 0) !== (file.lines === 0))) return invalid()
          totalFiles++
          totalBytes += file.bytes as number
          if (totalFiles > KNOWLEDGE_LIMITS.maxFiles || totalBytes > KNOWLEDGE_LIMITS.maxTotalBytes) return invalid()
          return { path: file.path as string, hash: file.hash, bytes: file.bytes as number, lines: file.lines as number }
        })
        if (contentHash(files) !== version.contentHash) return invalid()
        return { id: version.id, number: version.number as number, createdAt: version.createdAt as number,
          kind: version.kind as 'legacy' | 'managed', directory: version.directory, contentHash: version.contentHash, files }
      })
      if (typeof row.activeVersionId !== 'string' || !versions.some(version => version.id === row.activeVersionId)) return invalid()
      return { id: row.id, name: row.name, activeVersionId: row.activeVersionId, versions }
    })
    return { version: 1, revision: root.revision as number, collections }
  } catch { return invalid() }
}

export function validateKnowledgeBackup(raw: string, documents: ReadonlyMap<string, Uint8Array>): KnowledgeManifest {
  if (Buffer.byteLength(raw) > KNOWLEDGE_LIMITS.maxManifestBytes) throw new KnowledgeError(413, 'knowledge backup manifest is too large')
  const manifest = parseManifest(raw), referenced = new Set<string>(), managedLegacy = new Set<string>()
  let bytes = 0
  if (documents.size > KNOWLEDGE_LIMITS.maxFiles) throw new KnowledgeError(413, 'knowledge backup has too many documents')
  for (const [relative, value] of documents) {
    if (!(relative.startsWith('knowledge/') || relative.startsWith('knowledge-versions/versions/'))) throw new KnowledgeError(400, 'invalid knowledge backup path')
    const prefix = relative.startsWith('knowledge/') ? 'knowledge/' : 'knowledge-versions/versions/'
    relativePath(relative.slice(prefix.length))
    if (!/\.(md|txt)$/i.test(relative)) throw new KnowledgeError(400, 'unsupported knowledge backup file')
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value)
    validText(text); bytes += value.byteLength
    if (value.byteLength > KNOWLEDGE_LIMITS.maxFileBytes || bytes > KNOWLEDGE_LIMITS.maxTotalBytes) throw new KnowledgeError(413, 'knowledge backup exceeds its content budget')
  }
  for (const collection of manifest.collections) for (const version of collection.versions) {
    const root = version.kind === 'legacy' ? 'knowledge/' : 'knowledge-versions/versions/'
    if (version.kind === 'legacy') managedLegacy.add(root + version.directory + '/')
    for (const file of version.files) {
      const relative = root + version.directory + '/' + file.path, value = documents.get(relative)
      if (!value || value.byteLength !== file.bytes || hash(Buffer.from(value)) !== file.hash || linesOf(Buffer.from(value).toString('utf8')).length !== file.lines) throw new KnowledgeError(409, 'knowledge backup reference is missing or changed')
      referenced.add(relative)
    }
  }
  for (const relative of documents.keys()) {
    if ((relative.startsWith('knowledge-versions/') || [...managedLegacy].some(root => relative.startsWith(root))) && !referenced.has(relative)) throw new KnowledgeError(409, 'knowledge backup contains unreferenced version content')
  }
  return manifest
}

async function locked<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockKey = key(root)
  const previous = importLocks.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const ticket = new Promise<void>(resolve => { release = resolve })
  const next = previous.then(() => ticket)
  importLocks.set(lockKey, next)
  await previous
  try { return await action() }
  finally {
    release()
    if (importLocks.get(lockKey) === next) importLocks.delete(lockKey)
  }
}

/** Checking realpath as well as lstat also rejects junctions and linked ancestors. */
async function safeDirectory(directory: string, assertCurrent?: () => void): Promise<void> {
  assertCurrent?.()
  const before = await fs.lstat(directory)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new KnowledgeError(400, 'knowledge directories must be real directories without links')
  assertCurrent?.()
  if (key(await fs.realpath(directory)) !== key(directory)) throw new KnowledgeError(400, 'knowledge directories must not contain links')
  assertCurrent?.()
  const after = await fs.lstat(directory)
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) {
    throw new KnowledgeError(409, 'knowledge directory changed during access')
  }
}

export class KnowledgeStore {
  private readonly cwd: string
  private readonly parent: string
  private readonly root: string
  private readonly metadataRoot: string
  private readonly versionsRoot: string
  private readonly stagingRoot: string
  readonly manifestFile: string
  private snapshot: Snapshot = emptySnapshot()
  private refreshStarted = 0
  private refreshPublished = 0
  private publicationEpoch = 0
  private manifestSeen = false
  private readonly previews = new Map<string, Preview>()

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd)
    this.parent = path.join(this.cwd, '.sakura')
    this.root = path.join(this.parent, 'knowledge')
    this.metadataRoot = path.join(this.parent, 'knowledge-versions')
    this.versionsRoot = path.join(this.metadataRoot, 'versions')
    this.stagingRoot = path.join(this.metadataRoot, 'staging')
    this.manifestFile = path.join(this.metadataRoot, 'manifest.json')
  }

  private async ensureRoot(create: boolean, assertCurrent?: () => void): Promise<boolean> {
    return this.ensureDirectory(this.root, create, assertCurrent)
  }

  private async ensureDirectory(directory: string, create: boolean, check?: CurrentCheck): Promise<boolean> {
    await safeDirectory(this.cwd, check)
    const relative = path.relative(this.cwd, directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new KnowledgeError(400, 'invalid knowledge storage directory')
    let current = this.cwd
    for (const part of relative.split(path.sep).filter(Boolean)) {
      const parent = current
      current = path.join(current, part)
      let exists = true
      try { await checked(check, () => fs.lstat(current)) }
      catch (error) { if (missing(error)) exists = false; else throw error }
      if (!exists) {
        if (!create) return false
        await safeDirectory(parent, check)
        try { await checked(check, () => fs.mkdir(current, { mode: 0o700 })) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      await safeDirectory(current, check)
    }
    return true
  }

  private async readEntry(id: string, before: Stats, readBudget: { bytes: number }, root = this.root,
    sourceRoot = '.sakura/knowledge', check?: CurrentCheck): Promise<Entry> {
    const file = path.join(root, ...id.split('/'))
    let directory = root
    await safeDirectory(directory, check)
    for (const part of id.split('/').slice(0, -1)) {
      directory = path.join(directory, part)
      await safeDirectory(directory, check)
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new KnowledgeError(400, 'knowledge files must be regular files without links')
    const allowed = Math.min(KNOWLEDGE_LIMITS.maxFileBytes, KNOWLEDGE_LIMITS.maxTotalBytes - readBudget.bytes)
    if (before.size > allowed) throw new KnowledgeError(413, 'knowledge read byte limit exceeded')
    check?.()
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await checked(check, () => handle.stat())
      if (!opened.isFile() || opened.nlink !== 1 || fingerprint(opened) !== fingerprint(before)) {
        throw new KnowledgeError(409, 'knowledge file changed during access')
      }
      const buffer = Buffer.alloc(allowed + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await checked(check, () => handle.read(buffer, length, buffer.length - length, null))
        length += bytesRead
        readBudget.bytes += bytesRead
        if (length > allowed) throw new KnowledgeError(413, 'knowledge read byte limit exceeded')
        if (!bytesRead) break
      }
      const after = await checked(check, () => handle.stat())
      const current = await checked(check, () => fs.lstat(file))
      await safeDirectory(directory, check)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
          fingerprint(after) !== fingerprint(opened) || fingerprint(current) !== fingerprint(opened) || length !== opened.size) {
        throw new KnowledgeError(409, 'knowledge file changed during access')
      }
      const bytes = buffer.subarray(0, length)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw new KnowledgeError(400, 'knowledge file is not valid UTF-8') }
      validText(text)
      return { document: documentOf(id, text, bytes, sourceRoot), text, fingerprint: fingerprint(current) }
    } finally { await handle.close() }
  }

  private async readManifest(check?: CurrentCheck): Promise<ManifestDisk> {
    if (!await this.ensureDirectory(this.metadataRoot, false, check)) {
      if (this.manifestSeen) throw new KnowledgeError(409, 'knowledge version manifest is missing; restore it before continuing')
      return emptyDisk()
    }
    let before: Stats
    try { before = await checked(check, () => fs.lstat(this.manifestFile)) }
    catch (error) {
      if (!missing(error)) throw error
      // The versions directory is a durable management marker. Removing the pointer cannot
      // turn registered legacy directories back into unmanaged searchable documents.
      let marker = this.manifestSeen
      try { await checked(check, () => fs.lstat(this.versionsRoot)); marker = true }
      catch (cause) { if (!missing(cause)) throw cause }
      if (marker) throw new KnowledgeError(409, 'knowledge version manifest is missing; restore it before continuing')
      return emptyDisk()
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > KNOWLEDGE_LIMITS.maxManifestBytes) {
      throw new KnowledgeError(409, 'knowledge version manifest must be a bounded ordinary file without links')
    }
    check?.()
    const handle = await fs.open(this.manifestFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let bytes: Buffer
    try {
      const opened = await checked(check, () => handle.stat())
      if (fingerprint(opened) !== fingerprint(before)) throw new KnowledgeError(409, 'knowledge version manifest changed during access')
      const buffer = Buffer.alloc(KNOWLEDGE_LIMITS.maxManifestBytes + 1)
      let size = 0
      while (size < buffer.length) {
        const { bytesRead } = await checked(check, () => handle.read(buffer, size, buffer.length - size, null))
        size += bytesRead
        if (size > KNOWLEDGE_LIMITS.maxManifestBytes) throw new KnowledgeError(409, 'knowledge version manifest exceeds its byte budget')
        if (!bytesRead) break
      }
      const after = await checked(check, () => handle.stat())
      const current = await checked(check, () => fs.lstat(this.manifestFile))
      await safeDirectory(this.metadataRoot, check)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || fingerprint(after) !== fingerprint(before) ||
          fingerprint(current) !== fingerprint(before) || size !== before.size) {
        throw new KnowledgeError(409, 'knowledge version manifest changed during access')
      }
      bytes = buffer.subarray(0, size)
    } finally { await handle.close() }
    let raw: string
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
    catch { throw new KnowledgeError(409, 'knowledge version manifest is not valid UTF-8') }
    const manifest = parseManifest(raw)
    this.manifestSeen = true
    return { manifest, revision: manifest.revision, fingerprint: hash(bytes), exists: true }
  }

  private async inventory(root: string, sourceRoot: string, budget: ScanBudget, errors: string[],
    readable: (id: string) => boolean, check?: CurrentCheck, reserve: ReadonlyMap<string, StoredKnowledgeFile> = new Map()): Promise<Inventory> {
    const result: Inventory = { entries: new Map(), paths: new Set(), directories: new Set(), issues: new Set() }
    const error = (id: string, cause: unknown) => {
      if (cause instanceof CurrentAssertionError) throw cause
      result.issues.add(id)
      if (errors.length < 32) errors.push(`${id ? `${clip(id, 120)}: ` : ''}${
        cause instanceof KnowledgeError ? cause.message : 'unreadable knowledge entry'}`)
    }
    try { if (!await this.ensureDirectory(root, false, check)) return result }
    catch (cause) { error('', cause); return result }
    const readBudget = { bytes: budget.readBytes }
    const walk = async (directory: string, prefix: string, depth: number, read = true): Promise<void> => {
      if (budget.stopped) return
      result.directories.add(prefix)
      const names: string[] = []
      try {
        await safeDirectory(directory, check)
        check?.()
        const handle = await fs.opendir(directory)
        try {
          for await (const child of handle) {
            check?.()
            if (++budget.visited > MAX_WALK_ENTRIES) {
              budget.overLimit = budget.stopped = true
              throw new KnowledgeError(413, 'knowledge directory entry limit exceeded')
            }
            names.push(child.name)
          }
        } finally { await handle.close().catch(() => {}) }
        await safeDirectory(directory, check)
      } catch (cause) { error(prefix, cause); return }
      const spellings = new Map<string, string>(), aliases = new Set<string>()
      for (const name of names) {
        const normalized = pathKey(name), previous = spellings.get(normalized)
        if (previous !== undefined && previous !== name) { aliases.add(name); aliases.add(previous) }
        spellings.set(normalized, name)
      }
      names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      for (const name of names) {
        if (budget.stopped) break
        const id = prefix ? `${prefix}/${name}` : name
        try { if (relativePath(id) !== id) throw new KnowledgeError(400, 'invalid knowledge relative path') }
        catch (cause) { budget.overLimit = true; error(prefix, cause); continue }
        const file = path.join(directory, name)
        try {
          if (aliases.has(name)) error(id, new KnowledgeError(409, 'ambiguous knowledge file paths'))
          const canRead = read && !aliases.has(name)
          const info = await checked(check, () => fs.lstat(file))
          if (info.isSymbolicLink()) throw new KnowledgeError(400, 'links are not allowed in knowledge')
          if (info.isDirectory()) {
            if (depth >= MAX_DEPTH) { budget.overLimit = true; throw new KnowledgeError(413, 'knowledge directory depth limit exceeded') }
            await walk(file, id, depth + 1, canRead)
            continue
          }
          result.paths.add(id)
          if (info.isFile()) {
            const retained = reserve.get(id)
            budget.files += retained ? 0 : 1
            budget.bytes += retained ? Math.max(0, info.size - retained.bytes) : info.size
            if (budget.files > KNOWLEDGE_LIMITS.maxFiles || budget.bytes > KNOWLEDGE_LIMITS.maxTotalBytes) {
              budget.overLimit = budget.stopped = true
              throw new KnowledgeError(413, 'knowledge collection limit exceeded')
            }
          }
          if (!info.isFile() || info.nlink !== 1) throw new KnowledgeError(400, 'knowledge files must be regular files without links')
          if (!/\.(md|txt)$/i.test(id)) throw new KnowledgeError(400, 'unsupported knowledge file type')
          if (info.size > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(413, 'knowledge file size limit exceeded')
          if (canRead && readable(id)) result.entries.set(id, await this.readEntry(id, info, readBudget, root, sourceRoot, check))
        } catch (cause) { error(id, cause) }
      }
    }
    await walk(root, '', 0)
    budget.readBytes = readBudget.bytes
    return result
  }

  private versionAvailable(version: StoredKnowledgeVersion, inventory: Inventory): boolean {
    if (!inventory.directories.has(version.directory) || [...inventory.issues].some(id =>
      !id || id === version.directory || within(id, version.directory))) return false
    const documents = versionDocuments(version)
    if ([...inventory.paths].filter(id => within(id, version.directory)).length !== documents.length) return false
    return documents.every(document => {
      const actual = inventory.entries.get(document.id)?.document
      return actual?.version === document.version && actual.bytes === document.bytes && actual.lines === document.lines
    })
  }

  private async scan(check?: CurrentCheck, override?: ManifestDisk): Promise<Snapshot> {
    let actual: ManifestDisk
    try { actual = await this.readManifest(check) }
    catch (cause) {
      if (cause instanceof CurrentAssertionError) throw cause
      const failed = emptySnapshot(this.snapshot.disk)
      failed.metadataError = cause instanceof KnowledgeError ? cause.message : 'knowledge version manifest is unavailable'
      failed.errors.push(failed.metadataError)
      failed.versionState.errors = [...failed.errors]
      return failed
    }
    const disk = override ?? actual, state = emptySnapshot(disk)
    const versions = disk.manifest.collections.flatMap(collection => collection.versions)
    const reserve = (kind: 'legacy' | 'managed') => new Map(versions.filter(version => version.kind === kind)
      .flatMap(version => version.files.map(file => [`${version.directory}/${file.path}`, file] as const)))
    const legacyReserve = reserve('legacy'), managedReserve = reserve('managed')
    // Missing/deleted historical content still occupies its recorded quota; damage is not a way to reset limits.
    const budget: ScanBudget = { files: legacyReserve.size + managedReserve.size,
      bytes: [...legacyReserve.values(), ...managedReserve.values()].reduce((sum, file) => sum + file.bytes, 0),
      readBytes: 0, visited: 0, overLimit: false, stopped: false }
    const adopted = new Set(versions.filter(version => version.kind === 'legacy').map(version => pathKey(version.directory)))
    const managedDirectories = new Set(versions.filter(version => version.kind === 'managed').map(version => version.directory))
    const legacy = await this.inventory(this.root, '.sakura/knowledge', budget, state.errors, () => true, check, legacyReserve)
    const managed = await this.inventory(this.versionsRoot, '.sakura/knowledge-versions/versions', budget, state.errors,
      id => managedDirectories.has(id.split('/')[0]!), check, managedReserve)
    const staging = await this.inventory(this.stagingRoot, '.sakura/knowledge-versions/staging', budget, state.errors, () => false, check)
    const unmanaged = [...legacy.entries.values()].filter(entry => !adopted.has(pathKey(entry.document.id.split('/')[0]!)))
    for (const entry of unmanaged) { state.entries.set(entry.document.id, entry); state.allEntries.set(entry.document.id, entry) }
    const collections: KnowledgeCollection[] = disk.manifest.collections.map(collection => ({
      id: collection.id, name: collection.name, activeVersionId: collection.activeVersionId,
      versions: collection.versions.map(version => {
        const inventory = version.kind === 'legacy' ? legacy : managed
        const available = this.versionAvailable(version, inventory), documents = versionDocuments(version)
        if (documents.some(document => version.kind === 'managed' && legacy.entries.has(document.id))) {
          // Opaque IDs are authority only together with a manifest-owned location; never overwrite
          // an old unmanaged ID with a coincidentally named managed directory.
          for (const document of documents) { state.entries.delete(document.id); state.allEntries.delete(document.id); state.invalidDocuments.add(document.id) }
          if (state.errors.length < 32) state.errors.push('knowledge document IDs conflict across storage scopes')
          return { id: version.id, number: version.number, kind: version.kind, createdAt: version.createdAt,
            contentHash: version.contentHash, documents, totalBytes: documents.reduce((sum, file) => sum + file.bytes, 0),
            available: false, error: 'knowledge document IDs conflict across storage scopes' }
        }
        if (available) {
          for (const document of documents) {
            const entry = inventory.entries.get(document.id)!
            state.allEntries.set(document.id, entry)
            if (version.id === collection.activeVersionId) state.entries.set(document.id, entry)
          }
        } else {
          for (const document of documents) state.invalidDocuments.add(document.id)
          if (state.errors.length < 32) state.errors.push('knowledge version is missing, changed or unsafe')
        }
        return { id: version.id, number: version.number, kind: version.kind, createdAt: version.createdAt,
          contentHash: version.contentHash, documents, totalBytes: documents.reduce((sum, file) => sum + file.bytes, 0),
          available, ...(!available ? { error: 'knowledge version is missing, changed or unsafe' } : {}) }
      }),
    }))
    // ID ambiguity is global, not dependent on collection iteration order.
    for (const id of state.invalidDocuments) { state.entries.delete(id); state.allEntries.delete(id) }
    const legacyBatches = [...legacy.directories].filter(id => id && !id.includes('/') && !adopted.has(pathKey(id))).map(batchId => {
      const documents = unmanaged.filter(entry => within(entry.document.id, batchId)).map(entry => ({
        ...entry.document, path: entry.document.id.slice(batchId.length + 1),
      }))
      const files = documents.map(document => ({ path: document.path, hash: document.version, bytes: document.bytes, lines: document.lines }))
      const candidate: StoredKnowledgeVersion = { id: '', directory: batchId, kind: 'legacy', number: 1, createdAt: 0, contentHash: contentHash(files), files }
      const available = documents.length > 0 && this.versionAvailable(candidate, legacy)
      return { batchId, documents, contentHash: candidate.contentHash, totalBytes: documents.reduce((sum, file) => sum + file.bytes, 0),
        available, ...(!available ? { error: 'legacy batch is empty, changed or unsafe' } : {}) }
    })
    const orphanPaths = (inventory: Inventory, base: string, referenced: Set<string>): string[] => {
      const top = new Set([...inventory.directories, ...inventory.paths, ...inventory.issues].filter(Boolean).map(id => id.split('/')[0]!))
      return [...top].filter(id => !referenced.has(id)).map(id => `${base}/${id}`)
    }
    const orphans = [...orphanPaths(managed, '.sakura/knowledge-versions/versions', managedDirectories),
      ...orphanPaths(staging, '.sakura/knowledge-versions/staging', new Set())]
    state.files = budget.files
    state.bytes = budget.bytes
    state.overLimit = budget.overLimit
    state.inventories = { legacy, managed }
    state.versionState = { revision: disk.revision, fingerprint: disk.fingerprint, collections, legacyBatches,
      unmanagedDocuments: unmanaged.map(entry => ({ ...entry.document })), orphans: orphans.slice(0, 128),
      usage: { files: state.files, bytes: state.bytes, versions: versions.length, collections: collections.length, overLimit: state.overLimit },
      errors: [...state.errors] }
    // A scan is never allowed to combine an older pointer with newly published contents.
    try { sameRevision(await this.readManifest(check), actual) }
    catch (cause) {
      if (cause instanceof CurrentAssertionError) throw cause
      const failed = emptySnapshot(disk)
      failed.metadataError = cause instanceof KnowledgeError ? cause.message : 'knowledge version manifest changed during access'
      failed.errors.push(failed.metadataError)
      failed.versionState.errors = [...failed.errors]
      return failed
    }
    const revision = createHash('sha256')
    if (disk.exists) revision.update(`${disk.revision}\0${disk.fingerprint}\n`)
    for (const [id, entry] of [...state.entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      revision.update(`${id}\0${entry.document.version}\0${entry.fingerprint}\n`)
    }
    state.revision = revision.digest('hex')
    return state
  }

  private publishSnapshot(snapshot: Snapshot): void {
    this.publicationEpoch++
    this.refreshPublished = ++this.refreshStarted
    this.snapshot = snapshot
  }

  private async refresh(check?: CurrentCheck): Promise<Snapshot> {
    const sequence = ++this.refreshStarted, epoch = this.publicationEpoch
    const snapshot = await this.scan(check)
    if (epoch === this.publicationEpoch && sequence > this.refreshPublished) {
      this.refreshPublished = sequence
      this.snapshot = snapshot
    }
    return this.snapshot
  }

  private async exclusive<T>(check: CurrentCheck, action: (verifyLock: CurrentAsyncCheck) => Promise<T>): Promise<T> {
    return locked(this.root, async () => {
      check()
      await this.ensureDirectory(this.metadataRoot, true, check)
      const lockFile = path.join(this.metadataRoot, 'store.lock')
      check()
      let lock: Awaited<ReturnType<typeof fs.open>>
      try { lock = await fs.open(lockFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new KnowledgeError(409, 'knowledge metadata is locked; try again after the owner finishes')
        throw error
      }
      let owned: Stats | undefined
      try {
        owned = await lock.stat()
        check()
        await checked(check, () => lock.writeFile(randomUUID()))
        await checked(check, () => lock.sync())
        owned = await checked(check, () => lock.stat())
        const verifyLock = async () => {
          await safeDirectory(this.metadataRoot, check)
          const current = await checked(check, () => fs.lstat(lockFile))
          if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || fingerprint(current) !== fingerprint(owned!)) {
            throw new KnowledgeError(409, 'knowledge metadata lock changed during access')
          }
        }
        await verifyLock()
        return await action(verifyLock)
      } finally {
        await lock.close().catch(() => {})
        try {
          await safeDirectory(this.metadataRoot)
          const current = await fs.lstat(lockFile)
          if (owned && current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && identity(current) === identity(owned)) {
            await fs.unlink(lockFile)
          }
        } catch { /* Never steal/remove another process's lock or follow a replaced parent. */ }
      }
    })
  }

  private requireSnapshot(snapshot: Snapshot, expected: KnowledgeRevision): void {
    if (snapshot.metadataError) throw new KnowledgeError(409, snapshot.metadataError)
    sameRevision(snapshot.disk, expected)
    if (snapshot.overLimit) throw new KnowledgeError(413, 'knowledge collection limit exceeded, including retained history and orphans')
  }

  private capacity(snapshot: Snapshot, files = 0, bytes = 0, versions = 0, collections = 0): void {
    const usage = snapshot.versionState.usage
    if (snapshot.overLimit || usage.files + files > KNOWLEDGE_LIMITS.maxFiles || usage.bytes + bytes > KNOWLEDGE_LIMITS.maxTotalBytes ||
        usage.versions + versions > KNOWLEDGE_LIMITS.maxVersions || usage.collections + collections > KNOWLEDGE_LIMITS.maxCollections) {
      throw new KnowledgeError(413, 'knowledge capacity exceeded, including retained history and orphans')
    }
  }

  private collection(snapshot: Snapshot, id: string): StoredKnowledgeCollection {
    if (typeof id !== 'string' || !collectionPattern.test(id)) throw new KnowledgeError(400, 'invalid knowledge collection ID')
    const collection = snapshot.disk.manifest.collections.find(collection => collection.id === id)
    if (!collection) throw new KnowledgeError(404, 'knowledge collection not found')
    return collection
  }

  private requireVersion(snapshot: Snapshot, collection: StoredKnowledgeCollection, versionId: string): StoredKnowledgeVersion {
    if (typeof versionId !== 'string' || !versionPattern.test(versionId)) throw new KnowledgeError(400, 'invalid knowledge collection version ID')
    const version = collection.versions.find(version => version.id === versionId)
    if (!version) throw new KnowledgeError(404, 'knowledge collection version not found')
    const inventory = version.kind === 'legacy' ? snapshot.inventories?.legacy : snapshot.inventories?.managed
    if (!inventory || !this.versionAvailable(version, inventory) || versionDocuments(version).some(document => snapshot.invalidDocuments.has(document.id))) {
      throw new KnowledgeError(409, 'knowledge version is missing, changed or unsafe; restore its original content first')
    }
    return version
  }

  private baseline(snapshot: Snapshot, version: StoredKnowledgeVersion): string {
    return hash(JSON.stringify(versionDocuments(version).map(document => {
      const entry = snapshot.allEntries.get(document.id)
      return [document.id, document.version, entry?.fingerprint ?? 'missing']
    })))
  }

  private async verifyVersion(version: StoredKnowledgeVersion, snapshot: Snapshot, check: CurrentCheck): Promise<void> {
    const root = version.kind === 'legacy' ? this.root : this.versionsRoot
    const versionRoot = path.join(root, version.directory)
    const expected = new Map(versionDocuments(version).map(document => [document.id, document]))
    const seen = new Set<string>()
    let visited = 0
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      await safeDirectory(directory, check)
      check()
      const handle = await fs.opendir(directory)
      const names: string[] = []
      try {
        for await (const child of handle) {
          check()
          if (++visited > MAX_WALK_ENTRIES) throw new KnowledgeError(409, 'knowledge version changed during confirmation')
          names.push(child.name)
        }
      } finally { await handle.close().catch(() => {}) }
      await safeDirectory(directory, check)
      const spellings = new Set<string>()
      for (const name of names) {
        const id = `${prefix}/${name}`
        if (relativePath(id) !== id || spellings.has(pathKey(name))) throw new KnowledgeError(409, 'knowledge version has ambiguous paths')
        spellings.add(pathKey(name))
        const file = path.join(directory, name)
        const current = await checked(check, () => fs.lstat(file))
        if (current.isSymbolicLink()) throw new KnowledgeError(409, 'knowledge version contains links')
        if (current.isDirectory()) {
          if (depth >= MAX_DEPTH) throw new KnowledgeError(409, 'knowledge version directory depth changed')
          await walk(file, id, depth + 1)
        } else {
          const document = expected.get(id), before = snapshot.allEntries.get(id)
          if (!document || !before || !current.isFile() || current.nlink !== 1 || current.size !== document.bytes ||
              fingerprint(current) !== before.fingerprint) throw new KnowledgeError(409, 'knowledge version changed during confirmation')
          seen.add(id)
        }
      }
    }
    await this.ensureDirectory(root, false, check)
    await walk(versionRoot, version.directory, 1)
    if (seen.size !== expected.size) throw new KnowledgeError(409, 'knowledge version changed during confirmation')
  }

  private async cleanDirectory(directory: string, owned: Stats | undefined): Promise<void> {
    if (!owned) return
    try {
      await safeDirectory(path.dirname(directory))
      await safeDirectory(directory)
      const current = await fs.lstat(directory)
      if (identity(current) === identity(owned)) await fs.rm(directory, { recursive: true, force: true })
    } catch { /* Only our own real directory can be cleaned; unsafe remnants stay quarantined. */ }
  }

  private async stage(files: PreparedFile[], staging: string, check: CurrentCheck): Promise<Stats> {
    await safeDirectory(path.dirname(staging), check)
    check()
    await fs.mkdir(staging, { mode: 0o700 })
    const owned = await fs.lstat(staging)
    try {
      check()
      await safeDirectory(staging, check)
      for (const file of files) {
        let directory = staging
        for (const part of file.path.split('/').slice(0, -1)) {
          await safeDirectory(directory, check)
          const child = path.join(directory, part)
          try { await checked(check, () => fs.mkdir(child, { mode: 0o700 })) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          await safeDirectory(child, check)
          directory = child
        }
        await safeDirectory(directory, check)
        check()
        const destination = path.join(directory, path.posix.basename(file.path))
        const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
        try {
          await checked(check, () => handle.writeFile(file.bytes))
          await checked(check, () => handle.sync())
          const stat = await checked(check, () => handle.stat())
          const current = await checked(check, () => fs.lstat(destination))
          if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes.length || current.isSymbolicLink() || fingerprint(current) !== fingerprint(stat)) {
            throw new KnowledgeError(409, 'knowledge staging file changed')
          }
        } finally { await handle.close() }
      }
      await safeDirectory(staging, check)
      if (identity(await checked(check, () => fs.lstat(staging))) !== identity(owned)) throw new KnowledgeError(409, 'knowledge staging directory changed')
      return owned
    } catch (error) { await this.cleanDirectory(staging, owned); throw error }
  }

  private nextDisk(manifest: KnowledgeManifest, current: ManifestDisk): { disk: ManifestDisk; raw: string } {
    if (current.revision === Number.MAX_SAFE_INTEGER) throw new KnowledgeError(409, 'knowledge metadata revision is exhausted')
    const next = { ...manifest, revision: current.revision + 1 }
    const raw = JSON.stringify(next) + '\n'
    if (Buffer.byteLength(raw) > KNOWLEDGE_LIMITS.maxManifestBytes) throw new KnowledgeError(413, 'knowledge version manifest exceeds its byte budget')
    parseManifest(raw)
    return { raw, disk: { exists: true, manifest: next, revision: next.revision, fingerprint: hash(raw) } }
  }

  private async persist(next: { disk: ManifestDisk; raw: string }, current: ManifestDisk, check: CurrentCheck,
    verifyLock: CurrentAsyncCheck, validate: () => Promise<Snapshot>, verify: (snapshot: Snapshot) => Promise<void>): Promise<Snapshot> {
    await safeDirectory(this.metadataRoot, check)
    const temp = path.join(this.metadataRoot, `.manifest-${randomUUID()}.tmp`)
    let owned: Stats | undefined, marker: Stats | undefined, published = false
    check()
    const handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try {
      try {
        owned = await handle.stat()
        await checked(check, () => handle.writeFile(next.raw, 'utf8'))
        await checked(check, () => handle.sync())
        owned = await checked(check, () => handle.stat())
      } finally { await handle.close() }
      const snapshot = await validate()
      this.requireSnapshot(snapshot, next.disk)
      this.capacity(snapshot)
      sameRevision(await this.readManifest(check), current)
      await verifyLock()
      const temporary = await checked(check, () => fs.lstat(temp))
      if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.nlink !== 1 || fingerprint(temporary) !== fingerprint(owned!)) {
        throw new KnowledgeError(409, 'knowledge temporary manifest changed during access')
      }
      await verify(snapshot)
      sameRevision(await this.readManifest(check), current)
      if (!current.exists) {
        // Retained after the first successful pointer publication, this directory also makes a
        // missing manifest fail closed after restart. A failed first adoption removes only its own marker.
        check()
        await fs.mkdir(this.versionsRoot, { mode: 0o700 })
        marker = await fs.lstat(this.versionsRoot)
        check()
      }
      await safeDirectory(this.metadataRoot, check)
      await verifyLock()
      check()
      await fs.rename(temp, this.manifestFile)
      published = true
      this.manifestSeen = true
      this.publishSnapshot(snapshot)
      return snapshot
    } finally {
      if (!published) {
        try {
          await safeDirectory(this.metadataRoot)
          const stat = await fs.lstat(temp)
          if (owned && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && identity(stat) === identity(owned)) await fs.unlink(temp)
        } catch { /* Unsafe or replaced temporary metadata is not followed. */ }
        if (marker) {
          try {
            await safeDirectory(this.versionsRoot)
            if (identity(await fs.lstat(this.versionsRoot)) === identity(marker)) await fs.rmdir(this.versionsRoot)
          } catch { /* Nonempty or replaced markers fail closed rather than restoring unmanaged access. */ }
        }
      }
    }
  }

  async getVersionState(assertCurrent?: CurrentCheck): Promise<KnowledgeVersionState> {
    return operation(async check => { check(); return copy((await this.refresh(check)).versionState) }, assertCurrent)
  }

  async listCollections(assertCurrent?: CurrentCheck): Promise<KnowledgeCollection[]> {
    const state = await this.getVersionState(assertCurrent)
    if (this.snapshot.metadataError) throw new KnowledgeError(409, this.snapshot.metadataError)
    return state.collections
  }

  async adoptLegacy(batchId: string, expected: KnowledgeRevision, assertCurrent?: CurrentCheck): Promise<KnowledgeVersionMutation> {
    const id = relativePath(batchId, 1), revision = expectedRevision(expected)
    return operation(check => this.exclusive(check, async verifyLock => {
      const before = await this.scan(check)
      this.requireSnapshot(before, revision)
      if (before.disk.manifest.collections.some(collection => collection.versions.some(version => version.kind === 'legacy' && pathKey(version.directory) === pathKey(id)))) {
        throw new KnowledgeError(409, 'legacy batch is already managed')
      }
      const legacy = before.versionState.legacyBatches.find(batch => batch.batchId === id)
      if (!legacy) throw new KnowledgeError(404, 'legacy knowledge batch not found')
      if (!legacy.available) throw new KnowledgeError(409, 'legacy batch is empty, changed or unsafe')
      this.capacity(before, 0, 0, 1, 1)
      const files = legacy.documents.map(document => ({ path: document.path, hash: document.version, bytes: document.bytes, lines: document.lines }))
      prepareImport({ files: files.map(file => ({ path: file.path, content: '' })) }, false, 1024 - Buffer.byteLength(id, 'utf8') - 1)
      const version: StoredKnowledgeVersion = { id: `version_${randomUUID()}`, number: 1, createdAt: Date.now(), kind: 'legacy',
        directory: id, contentHash: legacy.contentHash, files }
      const collection: StoredKnowledgeCollection = { id: `collection_${randomUUID()}`, name: id, activeVersionId: version.id, versions: [version] }
      const next = this.nextDisk({ ...before.disk.manifest, collections: [...before.disk.manifest.collections, collection] }, before.disk)
      const baseline = this.baseline(before, version)
      const snapshot = await this.persist(next, before.disk, check, verifyLock, async () => {
        const candidate = await this.scan(check, next.disk)
        this.requireSnapshot(candidate, next.disk)
        this.requireVersion(candidate, collection, version.id)
        if (this.baseline(candidate, version) !== baseline) throw new KnowledgeError(409, 'legacy batch changed while registering; reload before continuing')
        return candidate
      }, candidate => this.verifyVersion(version, candidate, check))
      return { ...copy(snapshot.versionState), collectionId: collection.id, versionId: version.id }
    }), assertCurrent)
  }

  private expirePreviews(): void {
    for (const [id, preview] of this.previews) if (preview.result.expiresAt <= Date.now()) this.previews.delete(id)
  }

  async previewUpdate(value: KnowledgeUpdateInput, expected: KnowledgeRevision, assertCurrent?: CurrentCheck): Promise<KnowledgeUpdatePreview> {
    const files = prepareImport(value, true, 979), revision = expectedRevision(expected)
    const collectionId = value.collectionId
    if (typeof collectionId !== 'string' || !collectionPattern.test(collectionId)) throw new KnowledgeError(400, 'invalid knowledge collection ID')
    return operation(async check => {
      check()
      const before = await this.refresh(check)
      this.requireSnapshot(before, revision)
      const collection = this.collection(before, collectionId)
      const base = this.requireVersion(before, collection, collection.activeVersionId)
      const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
      this.capacity(before, files.length, bytes, 1)
      const stored = storedFiles(files), oldFiles = new Map(base.files.map(file => [file.path, file.hash]))
      const newFiles = new Map(stored.map(file => [file.path, file.hash]))
      const version: StoredKnowledgeVersion = { id: `version_${randomUUID()}`, number: collection.versions.length + 1,
        createdAt: Date.now(), kind: 'managed', directory: '', contentHash: contentHash(stored), files: stored }
      version.directory = version.id
      const result: KnowledgeUpdatePreview = { previewId: `preview_${randomUUID()}`, collectionId, versionId: version.id,
        baseVersionId: base.id, baseContentHash: base.contentHash, contentHash: version.contentHash, expected: revision,
        expiresAt: Date.now() + KNOWLEDGE_LIMITS.previewTtlMs,
        diff: { added: stored.filter(file => !oldFiles.has(file.path)).map(file => file.path),
          removed: base.files.filter(file => !newFiles.has(file.path)).map(file => file.path),
          modified: stored.filter(file => oldFiles.has(file.path) && oldFiles.get(file.path) !== file.hash).map(file => file.path),
          unchanged: stored.filter(file => oldFiles.get(file.path) === file.hash).map(file => file.path) },
        documents: versionDocuments(version), totalBytes: bytes }
      this.expirePreviews()
      const memory = [...this.previews.values()].reduce((sum, preview) => sum + preview.result.totalBytes, 0)
      if (this.previews.size >= KNOWLEDGE_LIMITS.maxPreviews || memory + bytes > KNOWLEDGE_LIMITS.maxPreviewBytes) {
        throw new KnowledgeError(413, 'knowledge preview memory limit reached; cancel an existing preview first')
      }
      check()
      this.previews.set(result.previewId, { result, files, baseline: this.baseline(before, base) })
      return copy(result)
    }, assertCurrent)
  }

  async cancelPreview(previewId: string): Promise<{ cancelled: boolean }> {
    if (typeof previewId !== 'string' || !previewPattern.test(previewId)) throw new KnowledgeError(400, 'invalid knowledge preview ID')
    this.expirePreviews()
    return { cancelled: this.previews.delete(previewId) }
  }

  private confirmPreview(preview: Preview, snapshot: Snapshot): StoredKnowledgeCollection {
    if (preview.result.expiresAt <= Date.now()) throw new KnowledgeError(409, 'knowledge preview expired; preview again before confirming')
    this.requireSnapshot(snapshot, preview.result.expected)
    const collection = this.collection(snapshot, preview.result.collectionId)
    const base = this.requireVersion(snapshot, collection, collection.activeVersionId)
    if (base.id !== preview.result.baseVersionId || base.contentHash !== preview.result.baseContentHash || this.baseline(snapshot, base) !== preview.baseline) {
      throw new KnowledgeError(409, 'knowledge preview baseline changed; reload and preview again')
    }
    return collection
  }

  async commitUpdate(previewId: string, expected: KnowledgeRevision, assertCurrent?: CurrentCheck): Promise<KnowledgeVersionMutation> {
    if (typeof previewId !== 'string' || !previewPattern.test(previewId)) throw new KnowledgeError(400, 'invalid knowledge preview ID')
    this.expirePreviews()
    const preview = this.previews.get(previewId)
    this.previews.delete(previewId) // Every confirmation attempt consumes the capability, including conflicts/failures.
    if (!preview) throw new KnowledgeError(409, 'knowledge preview expired, was already used or belongs to another session; preview again')
    const revision = expectedRevision(expected)
    sameRevision(preview.result.expected, revision)
    return operation(check => this.exclusive(check, async verifyLock => {
      const before = await this.scan(check), collection = this.confirmPreview(preview, before)
      this.capacity(before, preview.files.length, preview.result.totalBytes, 1)
      const stored = storedFiles(preview.files)
      const version: StoredKnowledgeVersion = { id: preview.result.versionId, number: collection.versions.length + 1,
        createdAt: Date.now(), kind: 'managed', directory: preview.result.versionId, contentHash: contentHash(stored), files: stored }
      const nextCollection = { ...collection, activeVersionId: version.id, versions: [...collection.versions, version] }
      const next = this.nextDisk({ ...before.disk.manifest, collections: before.disk.manifest.collections.map(row =>
        row.id === collection.id ? nextCollection : row) }, before.disk)
      await this.ensureDirectory(this.versionsRoot, true, check)
      await this.ensureDirectory(this.stagingRoot, true, check)
      const staging = path.join(this.stagingRoot, `.pending_${randomUUID()}`), destination = path.join(this.versionsRoot, version.id)
      let owned: Stats | undefined, contentPublished = false, committed = false
      try {
        owned = await this.stage(preview.files, staging, check)
        await safeDirectory(this.versionsRoot, check)
        try { await checked(check, () => fs.lstat(destination)); throw new KnowledgeError(409, 'knowledge version storage already exists') }
        catch (error) { if (!missing(error)) throw error }
        await verifyLock()
        check()
        await fs.rename(staging, destination)
        contentPublished = true
        const snapshot = await this.persist(next, before.disk, check, verifyLock, async () => {
          if (identity(await checked(check, () => fs.lstat(destination))) !== identity(owned!)) {
            throw new KnowledgeError(409, 'knowledge version directory was replaced during publication')
          }
          const candidate = await this.scan(check, next.disk)
          this.requireSnapshot(candidate, next.disk)
          const base = this.requireVersion(candidate, nextCollection, preview.result.baseVersionId)
          this.requireVersion(candidate, nextCollection, version.id)
          if (preview.result.expiresAt <= Date.now() || this.baseline(candidate, base) !== preview.baseline) {
            throw new KnowledgeError(409, 'knowledge preview expired or its baseline changed; preview again')
          }
          return candidate
        }, async candidate => {
          if (preview.result.expiresAt <= Date.now()) throw new KnowledgeError(409, 'knowledge preview expired; preview again')
          await this.verifyVersion(collection.versions.find(version => version.id === preview.result.baseVersionId)!, candidate, check)
          await this.verifyVersion(version, candidate, check)
          if (identity(await checked(check, () => fs.lstat(destination))) !== identity(owned!)) {
            throw new KnowledgeError(409, 'knowledge version directory was replaced during publication')
          }
        })
        committed = true
        return { ...copy(snapshot.versionState), collectionId: collection.id, versionId: version.id }
      } finally { if (!committed) await this.cleanDirectory(contentPublished ? destination : staging, owned) }
    }), assertCurrent)
  }

  async activateVersion(collectionId: string, versionId: string, expected: KnowledgeRevision,
    assertCurrent?: CurrentCheck): Promise<KnowledgeVersionMutation> {
    if (typeof collectionId !== 'string' || !collectionPattern.test(collectionId)) throw new KnowledgeError(400, 'invalid knowledge collection ID')
    if (typeof versionId !== 'string' || !versionPattern.test(versionId)) throw new KnowledgeError(400, 'invalid knowledge collection version ID')
    const revision = expectedRevision(expected)
    return operation(check => this.exclusive(check, async verifyLock => {
      const before = await this.scan(check)
      this.requireSnapshot(before, revision)
      const collection = this.collection(before, collectionId), version = this.requireVersion(before, collection, versionId)
      const baseline = this.baseline(before, version)
      const nextCollection = { ...collection, activeVersionId: version.id }
      const next = this.nextDisk({ ...before.disk.manifest, collections: before.disk.manifest.collections.map(row =>
        row.id === collection.id ? nextCollection : row) }, before.disk)
      const snapshot = await this.persist(next, before.disk, check, verifyLock, async () => {
        const candidate = await this.scan(check, next.disk)
        this.requireSnapshot(candidate, next.disk)
        this.requireVersion(candidate, nextCollection, version.id)
        if (this.baseline(candidate, version) !== baseline) throw new KnowledgeError(409, 'knowledge version changed during activation')
        return candidate
      }, candidate => this.verifyVersion(version, candidate, check))
      return { ...copy(snapshot.versionState), collectionId: collection.id, versionId: version.id }
    }), assertCurrent)
  }

  async reload(): Promise<{ documents: KnowledgeDocument[]; revision: string; errors: string[] }> {
    const snapshot = await this.refresh()
    return { documents: [...snapshot.entries.values()].map(entry => ({ ...entry.document })),
      revision: snapshot.revision, errors: [...snapshot.errors] }
  }

  list(): KnowledgeDocument[] {
    return [...this.snapshot.entries.values()].map(entry => ({ ...entry.document }))
  }

  /** Bounded, lossless UTF-8 read for operator version preparation; preserves BOM and every newline byte. */
  async readRaw(id: string, version: string, assertCurrent?: CurrentCheck): Promise<Buffer> {
    return operation(async check => {
      const documentId = relativePath(id)
      if (typeof version !== 'string' || !sha256.test(version)) throw new KnowledgeError(400, 'invalid knowledge version hash')
      const snapshot = await this.scan(check)
      if (snapshot.metadataError) throw new KnowledgeError(409, snapshot.metadataError)
      const entry = snapshot.allEntries.get(documentId)
      if (!entry || snapshot.invalidDocuments.has(documentId) || entry.document.version !== version) throw new KnowledgeError(409, 'knowledge document version is missing, changed or unsafe')
      const bytes = Buffer.from(entry.text, 'utf8')
      if (bytes.length !== entry.document.bytes || hash(bytes) !== version) throw new KnowledgeError(409, 'knowledge original byte identity changed')
      check()
      return bytes
    }, assertCurrent)
  }

  async read(id: string, options: ReadOptions = {}): Promise<KnowledgeRead> {
    const documentId = relativePath(id)
    const offset = integer(options.offset, 1, 1, Number.MAX_SAFE_INTEGER, 'offset')
    const charOffset = integer(options.charOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'charOffset')
    const limit = integer(options.limit, KNOWLEDGE_LIMITS.readLines, 1, KNOWLEDGE_LIMITS.readLines, 'limit')
    const maxChars = integer(options.maxChars, KNOWLEDGE_LIMITS.readChars, 1, KNOWLEDGE_LIMITS.readChars, 'maxChars')
    if (options.version !== undefined && typeof options.version !== 'string') throw new KnowledgeError(400, 'version must be a string')
    const snapshot = await this.refresh()
    if (snapshot.metadataError) throw new KnowledgeError(409, snapshot.metadataError)
    if (snapshot.invalidDocuments.has(documentId)) throw new KnowledgeError(409, 'knowledge document version is missing, changed or unsafe')
    const entry = snapshot.allEntries.get(documentId)
    if (!entry) throw new KnowledgeError(404, 'knowledge document not found')
    if (options.version !== undefined && options.version !== entry.document.version) throw new KnowledgeError(409, 'knowledge document version changed; search again')
    const lines = linesOf(entry.text)
    const firstLine = lines[offset - 1] ?? ''
    if (charOffset > firstLine.length || splitsSurrogate(firstLine, charOffset)) {
      throw new KnowledgeError(400, 'charOffset must be within the starting line and must not split a surrogate pair')
    }
    const page = lines.slice(offset - 1, offset - 1 + limit)
    if (page.length) page[0] = page[0]!.slice(charOffset)
    const original = page.join('\n')
    const content = clip(original, maxChars)
    const shown = page.length ? content.split('\n').length : 0
    const partial = content.length < original.length
    const truncated = partial || offset - 1 + page.length < lines.length
    // An unconsumed LF stays at the end of the current line; do not skip it or its remaining text.
    // Line-limit boundaries retain the legacy short-page behavior (no appended separator).
    const nextOffset = partial ? offset + shown - 1 : offset + page.length
    const nextCharOffset = partial ? (shown === 1 ? charOffset : 0) + content.length - content.lastIndexOf('\n') - 1 : 0
    return { id: documentId, source: entry.document.source, version: entry.document.version,
      startLine: offset, endLine: offset + shown - 1, totalLines: lines.length, content, truncated,
      ...(truncated ? { nextOffset, nextCharOffset } : {}) }
  }

  async search(query: string, options: SearchOptions = {}): Promise<{ results: KnowledgeHit[]; truncated: boolean; revision: string }> {
    // Query/ranking/output budgets belong to the shared retrieval utility.
    try { retrieveText(query, [], options) }
    catch (error) { throw new KnowledgeError(400, error instanceof Error ? error.message : 'invalid knowledge search query or budget') }
    const snapshot = await this.refresh()
    const items: RetrievalItem[] = []
    const chunks = new Map<string, { documentId: string; version: string; source: string; first: number; last: number; truncated: boolean; charOffset?: number }>()
    let shortened = false
    for (const entry of snapshot.entries.values()) {
      const lines = linesOf(entry.text)
      let buffer: string[] = [], chars = 0, start = 1, end = 0, chunk = 0
      const add = (text: string, first: number, last: number, truncated = false, charOffset?: number) => {
        if (!text.trim()) return
        const id = `knowledge:${hash(entry.document.id)}:${chunk++}`
        const source = `${entry.document.source}#L${first}-L${last}`
        items.push({ id, source, content: text, startLine: first })
        chunks.set(id, { documentId: entry.document.id, version: entry.document.version, source, first, last, truncated, charOffset })
      }
      const flush = () => {
        if (buffer.length) add(buffer.join('\n'), start, end)
        buffer = []; chars = 0
      }
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (line.length > CHUNK_CHARS) {
          flush()
          // The scan's existing 256-KiB/file and 4-MiB/collection limits also bound this loop/index.
          let charOffset = 0
          while (charOffset < line.length) {
            const text = clip(line.slice(charOffset), CHUNK_CHARS)
            add(text, index + 1, index + 1, true, charOffset)
            const through = charOffset + text.length
            if (through === line.length) break
            charOffset = through - CHUNK_OVERLAP
            if (splitsSurrogate(line, charOffset)) charOffset--
          }
          shortened = true
          continue
        }
        if (chars + (buffer.length ? 1 : 0) + line.length > CHUNK_CHARS) flush()
        if (!buffer.length) start = index + 1
        chars += (buffer.length ? 1 : 0) + line.length
        buffer.push(line); end = index + 1
        if (!line.trim() && chars >= CHUNK_CHARS / 2) flush()
      }
      flush()
    }
    const found = retrieveText(query, items, options)
    const results: KnowledgeHit[] = []
    for (const hit of found.results) {
      const chunk = chunks.get(hit.id)
      if (!chunk) { shortened = true; continue }
      // Shared retrieval may cut fragment edges through a pair; omit only those orphaned halves.
      const snippet = chunk.charOffset === undefined ? hit.snippet :
        hit.snippet.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
      results.push({ ...hit, snippet, source: chunk.source, documentId: chunk.documentId, version: chunk.version,
        startLine: Math.min(chunk.last, Math.max(chunk.first, hit.startLine ?? chunk.first)),
        endLine: Math.min(chunk.last, Math.max(chunk.first, hit.endLine ?? chunk.last)),
        truncated: hit.truncated || chunk.truncated,
        ...(chunk.charOffset === undefined ? {} : { charOffset: chunk.charOffset }) })
    }
    return { results, truncated: found.truncated || shortened || snapshot.errors.length > 0, revision: snapshot.revision }
  }

  async importFiles(value: unknown, assertCurrent?: () => void): Promise<{ documents: KnowledgeDocument[]; imported: number }> {
    const files = prepareImport(value)
    return operation(check => this.exclusive(check, async verifyLock => {
      const before = await this.scan(check)
      if (before.metadataError) throw new KnowledgeError(409, before.metadataError)
      this.capacity(before, files.length, files.reduce((sum, file) => sum + file.bytes.length, 0))
      const batch = `batch_${randomUUID()}`, staging = path.join(this.parent, `.knowledge-staging_${randomUUID()}`)
      const destination = path.join(this.root, batch)
      let owned: Stats | undefined, published = false
      try {
        await this.ensureRoot(true, check)
        owned = await this.stage(files, staging, check)
        await safeDirectory(this.root, check)
        try { await checked(check, () => fs.lstat(destination)); throw new KnowledgeError(409, 'knowledge collection already exists') }
        catch (error) { if (!missing(error)) throw error }
        sameRevision(await this.readManifest(check), before.disk)
        const latest = await this.scan(check)
        this.requireSnapshot(latest, before.disk)
        this.capacity(latest, files.length, files.reduce((sum, file) => sum + file.bytes.length, 0))
        await verifyLock()
        check()
        await fs.rename(staging, destination)
        published = true
        const documents = files.map(file => documentOf(`${batch}/${file.path}`, file.text, file.bytes))
        // Publish the successful write before any slower refresh, which cannot overwrite a newer pointer.
        this.publicationEpoch++
        this.snapshot = emptySnapshot(before.disk)
        const snapshot = await this.scan(check)
        this.publishSnapshot(snapshot)
        return { documents, imported: documents.length }
      } finally { if (!published) await this.cleanDirectory(staging, owned) }
    }), assertCurrent, 'could not import knowledge documents')
  }
}
