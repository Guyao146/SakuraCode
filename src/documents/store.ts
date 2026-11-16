/** Originals/provenance are outside the knowledge scan tree. A manifest is the only publication point. */
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { checkContext, DOCUMENT_LIMITS as L, DocumentError, type DocumentArtifact, type DocumentContext,
  type DocumentKind, type DocumentManifest, type DocumentRevision } from './types.js'
import { documentHash, documentOriginalPath, validateDocumentManifest, validateDocumentSnapshot } from './validate.js'

export interface DocumentSnapshot extends DocumentRevision { manifest: DocumentManifest }
export interface DocumentCommitInput { bytes: Uint8Array; kind: DocumentKind; artifacts: DocumentArtifact[] }
export interface DocumentInventory extends DocumentSnapshot { originals: Map<string, Uint8Array>; files: { path: string; bytes: Uint8Array }[] }
type Disk = DocumentSnapshot & { raw?: Buffer }
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
const identity = (s: Stats) => `${s.dev}:${s.ino}`
const stamp = (s: Stats) => `${identity(s)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`
const empty = (): Disk => ({ revision: 0, fingerprint: documentHash('missing'), manifest: { version: 1, revision: 0, originals: [], artifacts: [] } })
const conflict = (message: string): never => { throw new DocumentError('CONFLICT', message, 409) }
const unsafe = (): never => { throw new DocumentError('UNSAFE_PATH', 'Document storage must use regular files and real directories without links', 409) }
function same(current: DocumentRevision, expected: DocumentRevision) {
  if (!expected || !Number.isSafeInteger(expected.revision) || !/^[a-f0-9]{64}$/.test(expected.fingerprint) || current.revision !== expected.revision || current.fingerprint !== expected.fingerprint) conflict('Document provenance changed; refresh the confirmation')
}
async function checked<T>(context: DocumentContext | undefined, work: () => Promise<T>): Promise<T> { checkContext(context); const result = await work(); checkContext(context); return result }

export class DocumentStore {
  readonly cwd: string
  readonly root: string
  readonly manifestFile: string
  private seenManifest = false
  constructor(cwd: string) { this.cwd = path.resolve(cwd); this.root = path.join(this.cwd, '.sakura', 'documents'); this.manifestFile = path.join(this.root, 'manifest.json') }
  private async safeDirectory(directory: string, context?: DocumentContext): Promise<Stats> {
    const before = await checked(context, () => fs.lstat(directory))
    if (!before.isDirectory() || before.isSymbolicLink() || key(await checked(context, () => fs.realpath(directory))) !== key(directory)) unsafe()
    const after = await checked(context, () => fs.lstat(directory))
    if (!after.isDirectory() || after.isSymbolicLink() || identity(before) !== identity(after)) conflict('Document directory changed during access')
    return after
  }
  private async directory(directory: string, create: boolean, context?: DocumentContext): Promise<boolean> {
    await this.safeDirectory(this.cwd, context)
    const relative = path.relative(this.cwd, directory)
    if (relative.startsWith('..') || path.isAbsolute(relative)) unsafe()
    let current = this.cwd
    for (const part of relative.split(path.sep).filter(Boolean)) {
      const parent = current; current = path.join(current, part)
      try { await this.safeDirectory(current, context) }
      catch (error) {
        if (!missing(error)) throw error
        if (!create) return false
        await this.safeDirectory(parent, context)
        try { await checked(context, () => fs.mkdir(current, { mode: 0o700 })) }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
        await this.safeDirectory(current, context)
      }
    }
    return true
  }
  private async readSafe(file: string, maxBytes: number, context?: DocumentContext): Promise<Buffer> {
    await this.directory(path.dirname(file), false, context)
    const before = await checked(context, () => fs.lstat(file))
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) unsafe()
    checkContext(context)
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      checkContext(context)
      if (stamp(await checked(context, () => handle.stat())) !== stamp(before)) conflict('Document file changed during access')
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        const read = await checked(context, () => handle.read(bytes, offset, bytes.length - offset, offset))
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await checked(context, () => handle.stat()), entry = await checked(context, () => fs.lstat(file))
      await this.directory(path.dirname(file), false, context)
      if (offset !== before.size || !entry.isFile() || entry.isSymbolicLink() || stamp(after) !== stamp(before) || stamp(entry) !== stamp(before)) conflict('Document file changed during access')
      return bytes.subarray(0, offset)
    } finally { await handle.close() }
  }
  private async disk(context?: DocumentContext): Promise<Disk> {
    if (!await this.directory(this.root, false, context)) { if (this.seenManifest) conflict('Document manifest is missing'); return empty() }
    let raw: Buffer
    try { raw = await this.readSafe(this.manifestFile, L.maxManifestBytes, context) }
    catch (error) { if (!missing(error)) throw error; if (this.seenManifest) conflict('Document manifest is missing'); return empty() }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
    catch { throw new DocumentError('INVALID_MANIFEST', 'Document manifest is corrupt', 409) }
    const manifest = validateDocumentManifest(value)
    this.seenManifest = true
    return { revision: manifest.revision, fingerprint: documentHash(raw), manifest, raw }
  }
  async snapshot(context?: DocumentContext): Promise<DocumentSnapshot> {
    const { revision, fingerprint, manifest } = await this.disk(context)
    return { revision, fingerprint, manifest }
  }
  private async writeOwned(file: string, bytes: Uint8Array, context?: DocumentContext): Promise<Stats> {
    await this.directory(path.dirname(file), false, context)
    checkContext(context)
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    let owned: Stats | undefined
    try {
      owned = await handle.stat()
      if (!owned.isFile() || owned.nlink !== 1) unsafe()
      await checked(context, () => handle.writeFile(bytes)); await checked(context, () => handle.sync())
      owned = await checked(context, () => handle.stat())
      await this.directory(path.dirname(file), false, context)
      const current = await checked(context, () => fs.lstat(file))
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || stamp(current) !== stamp(owned)) conflict('Document staging file changed')
      return owned
    } catch (error) { await handle.close().catch(() => {}); await this.clean(file, owned); throw error }
    finally { await handle.close().catch(() => {}) }
  }
  private async clean(file: string, owned?: Stats) {
    if (!owned) return
    try {
      if (!await this.directory(path.dirname(file), false)) return
      const current = await fs.lstat(file)
      if (current.isFile() && !current.isSymbolicLink() && identity(current) === identity(owned)) await fs.unlink(file)
    } catch { /* A replaced path is not ours to remove. */ }
  }
  async commit(input: DocumentCommitInput, expected: DocumentRevision, context?: DocumentContext): Promise<DocumentSnapshot> {
    checkContext(context)
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length || input.bytes.length > L.maxInputBytes || !['pdf', 'docx'].includes(input.kind)) throw new DocumentError('INVALID_ORIGINAL', 'Invalid document original')
    const bytes = Uint8Array.from(input.bytes), sha256 = documentHash(bytes), kind = input.kind
    const artifacts = validateDocumentManifest({ version: 1, revision: 0, originals: [{ sha256, bytes: bytes.length, kind }], artifacts: input.artifacts }).artifacts
    const baseline = { revision: expected.revision, fingerprint: expected.fingerprint }
    same(await this.disk(context), baseline)
    await this.directory(this.root, true, context)
    const lockFile = path.join(this.root, 'store.lock')
    let lock: Stats
    try { lock = await this.writeOwned(lockFile, Buffer.from(randomUUID()), context) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict('Document store is locked; try again after the owner finishes'); throw error }
    let temp: string | undefined, tempStat: Stats | undefined
    try {
      const before = await this.disk(context); same(before, baseline)
      const manifest: DocumentManifest = structuredClone(before.manifest)
      const original = manifest.originals.find(item => item.sha256 === sha256)
      if (original && (original.bytes !== bytes.length || original.kind !== kind)) conflict('Original document identity conflicts with stored provenance')
      if (!original) manifest.originals.push({ sha256, bytes: bytes.length, kind })
      for (const artifact of artifacts) {
        const present = manifest.artifacts.find(item => item.sha256 === artifact.sha256)
        if (present && JSON.stringify(present) !== JSON.stringify(artifact)) conflict('Knowledge artifact already has different provenance')
        if (!present) manifest.artifacts.push(artifact)
      }
      if (manifest.originals.length > L.maxOriginals || manifest.artifacts.length > L.maxArtifacts || manifest.originals.reduce((sum, item) => sum + item.bytes, 0) > L.maxStoredOriginalBytes) throw new DocumentError('STORE_LIMIT', 'Document provenance storage budget exceeded', 413)
      manifest.revision++
      validateDocumentManifest(manifest)
      const originalFile = path.join(this.cwd, ...documentOriginalPath(sha256).split('/'))
      await this.directory(path.dirname(originalFile), true, context)
      try {
        const existing = await this.readSafe(originalFile, L.maxInputBytes, context)
        if (existing.length !== bytes.length || documentHash(existing) !== sha256) conflict('Existing document original has changed')
      } catch (error) {
        if (!missing(error)) throw error
        temp = path.join(this.root, `.original-${randomUUID()}.tmp`)
        tempStat = await this.writeOwned(temp, bytes, context)
        await this.directory(path.dirname(originalFile), false, context)
        await this.directory(this.root, false, context)
        checkContext(context)
        // link is atomic and never overwrites an existing hash path. Remove the staging link immediately.
        await fs.link(temp, originalFile)
        await this.clean(temp, tempStat); temp = undefined; tempStat = undefined
        const saved = await this.readSafe(originalFile, L.maxInputBytes, context)
        if (saved.length !== bytes.length || documentHash(saved) !== sha256) conflict('Document original changed before publication')
      }
      const raw = Buffer.from(JSON.stringify(manifest))
      temp = path.join(this.root, `.manifest-${randomUUID()}.tmp`)
      tempStat = await this.writeOwned(temp, raw, context)
      same(await this.disk(context), baseline)
      await this.directory(this.root, false, context)
      const currentLock = await checked(context, () => fs.lstat(lockFile))
      if (!currentLock.isFile() || currentLock.isSymbolicLink() || currentLock.nlink !== 1 || stamp(currentLock) !== stamp(lock)) conflict('Document lock changed before publication')
      if (documentHash(await this.readSafe(originalFile, L.maxInputBytes, context)) !== sha256) conflict('Document original changed before publication')
      checkContext(context)
      await fs.rename(temp, this.manifestFile)
      temp = undefined; tempStat = undefined; this.seenManifest = true
      // Cancellation after the atomic publication cannot turn a completed commit into a false failure.
      return { revision: manifest.revision, fingerprint: documentHash(raw), manifest }
    } finally { if (temp) await this.clean(temp, tempStat); await this.clean(lockFile, lock) }
  }
  async readOriginal(sha256: string, context?: DocumentContext): Promise<Uint8Array> {
    const relative = documentOriginalPath(sha256), before = await this.disk(context)
    const original = before.manifest.originals.find(item => item.sha256 === sha256)
    if (!original) throw new DocumentError('NOT_FOUND', 'Document original is not registered', 404)
    const bytes = await this.readSafe(path.join(this.cwd, ...relative.split('/')), L.maxInputBytes, context)
    if (bytes.length !== original.bytes || documentHash(bytes) !== sha256) conflict('Document original is missing or changed')
    same(await this.disk(context), before)
    return bytes
  }
  async inventory(context?: DocumentContext): Promise<DocumentInventory> {
    const before = await this.disk(context), originals = new Map<string, Uint8Array>(), files: DocumentInventory['files'] = []
    if (before.raw) files.push({ path: '.sakura/documents/manifest.json', bytes: before.raw })
    for (const original of before.manifest.originals) {
      const relative = documentOriginalPath(original.sha256)
      const bytes = await this.readSafe(path.join(this.cwd, ...relative.split('/')), L.maxInputBytes, context)
      originals.set(original.sha256, bytes); files.push({ path: relative, bytes })
    }
    validateDocumentSnapshot(before.manifest, originals)
    same(await this.disk(context), before)
    return { revision: before.revision, fingerprint: before.fingerprint, manifest: before.manifest, originals, files }
  }
}
