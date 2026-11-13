/** Bounded, workspace-local UTF-8 reference documents; never executable instructions. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { TextDecoder } from 'node:util'
import { retrieveText, type RetrievalItem, type RetrievalHit } from '../util/retrieval.js'

export const KNOWLEDGE_LIMITS = Object.freeze({
  maxFiles: 128,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
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
  revision: string
  errors: string[]
  files: number
  bytes: number
  overLimit: boolean
}
type PreparedFile = { path: string; bytes: Buffer; text: string }

class CurrentAssertionError extends Error {
  constructor(readonly original: unknown) { super('workspace changed during knowledge import') }
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

function documentOf(id: string, text: string, bytes: Buffer): KnowledgeDocument {
  return { id, name: path.posix.basename(id), source: `.sakura/knowledge/${id}`,
    version: hash(bytes), lines: linesOf(text).length, bytes: bytes.length }
}

function prepareImport(value: unknown): PreparedFile[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KnowledgeError(400, 'expected { files: [{ path, content }] }')
  const files = (value as Record<string, unknown>).files
  if (!Array.isArray(files) || !files.length) throw new KnowledgeError(400, 'files must be a non-empty array')
  if (files.length > KNOWLEDGE_LIMITS.maxFiles) throw new KnowledgeError(413, 'knowledge file count limit exceeded')
  const names = new Set<string>()
  const spellings = new Map<string, string>()
  let total = 0
  return files.map(file => {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new KnowledgeError(400, 'invalid knowledge file')
    const record = file as Record<string, unknown>
    // The published batch directory uses one of the eight allowed directory levels.
    const relative = relativePath(record.path, MAX_DEPTH)
    if (Buffer.byteLength(relative, 'utf8') > 981) throw new KnowledgeError(400, 'knowledge relative path is too long for a collection')
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
  private snapshot: Snapshot = { entries: new Map(), revision: hash(''), errors: [], files: 0, bytes: 0, overLimit: false }

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd)
    this.parent = path.join(this.cwd, '.sakura')
    this.root = path.join(this.parent, 'knowledge')
  }

  private async ensureRoot(create: boolean, assertCurrent?: () => void): Promise<boolean> {
    await safeDirectory(this.cwd, assertCurrent)
    for (const directory of [this.parent, this.root]) {
      assertCurrent?.()
      let exists = true
      try { await fs.lstat(directory) }
      catch (error) { if (missing(error)) exists = false; else throw error }
      if (!exists) {
        if (!create) return false
        await safeDirectory(path.dirname(directory), assertCurrent)
        assertCurrent?.()
        try { await fs.mkdir(directory, { mode: 0o700 }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      }
      await safeDirectory(directory, assertCurrent)
    }
    return true
  }

  private async readEntry(id: string, before: Stats, readBudget: { bytes: number }): Promise<Entry> {
    const file = path.join(this.root, ...id.split('/'))
    let directory = this.root
    await safeDirectory(directory)
    for (const part of id.split('/').slice(0, -1)) {
      directory = path.join(directory, part)
      await safeDirectory(directory)
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new KnowledgeError(400, 'knowledge files must be regular files without links')
    const allowed = Math.min(KNOWLEDGE_LIMITS.maxFileBytes, KNOWLEDGE_LIMITS.maxTotalBytes - readBudget.bytes)
    if (before.size > allowed) throw new KnowledgeError(413, 'knowledge read byte limit exceeded')
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.nlink !== 1 || fingerprint(opened) !== fingerprint(before)) {
        throw new KnowledgeError(409, 'knowledge file changed during access')
      }
      const buffer = Buffer.alloc(allowed + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
        length += bytesRead
        readBudget.bytes += bytesRead
        if (length > allowed) throw new KnowledgeError(413, 'knowledge read byte limit exceeded')
        if (!bytesRead) break
      }
      const after = await handle.stat()
      const current = await fs.lstat(file)
      await safeDirectory(directory)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 ||
          fingerprint(after) !== fingerprint(opened) || fingerprint(current) !== fingerprint(opened) || length !== opened.size) {
        throw new KnowledgeError(409, 'knowledge file changed during access')
      }
      const bytes = buffer.subarray(0, length)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw new KnowledgeError(400, 'knowledge file is not valid UTF-8') }
      validText(text)
      return { document: documentOf(id, text, bytes), text, fingerprint: fingerprint(current) }
    } finally { await handle.close() }
  }

  private async scan(): Promise<Snapshot> {
    const state: Snapshot = { entries: new Map(), revision: hash(''), errors: [], files: 0, bytes: 0, overLimit: false }
    const error = (label: string, reason: string) => {
      if (state.errors.length < 32) state.errors.push(`${label ? `${clip(label, 120)}: ` : ''}${reason}`)
    }
    try { if (!await this.ensureRoot(false)) return state }
    catch (cause) {
      error('', cause instanceof KnowledgeError ? cause.message : 'knowledge directory is unavailable')
      return state
    }
    let visited = 0
    let stopped = false
    const readBudget = { bytes: 0 }
    const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (stopped) return
      let names: string[] = []
      try {
        await safeDirectory(directory)
        const handle = await fs.opendir(directory)
        for await (const child of handle) {
          if (++visited > MAX_WALK_ENTRIES) {
            error('', 'knowledge directory entry limit exceeded')
            state.overLimit = true
            stopped = true
            break
          }
          names.push(child.name)
        }
        await safeDirectory(directory)
      } catch (cause) {
        error(prefix, cause instanceof KnowledgeError ? cause.message : 'unreadable knowledge directory')
        return
      }
      names = names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
      for (const name of names) {
        if (stopped) break
        let id: string
        try { id = relativePath(prefix ? `${prefix}/${name}` : name) }
        catch { error('', 'invalid knowledge relative path'); state.overLimit = true; continue }
        const file = path.join(directory, name)
        try {
          const info = await fs.lstat(file)
          if (info.isSymbolicLink()) throw new KnowledgeError(400, 'links are not allowed in knowledge')
          if (info.isDirectory()) {
            if (depth >= MAX_DEPTH) {
              error(id, 'knowledge directory depth limit exceeded')
              state.overLimit = true
            } else await walk(file, id, depth + 1)
            continue
          }
          if (!info.isFile() || info.nlink !== 1) throw new KnowledgeError(400, 'knowledge files must be regular files without links')
          state.files++
          state.bytes += info.size
          if (state.files > KNOWLEDGE_LIMITS.maxFiles || state.bytes > KNOWLEDGE_LIMITS.maxTotalBytes) {
            state.overLimit = true
            stopped = true
            throw new KnowledgeError(413, 'knowledge collection limit exceeded')
          }
          if (!/\.(md|txt)$/i.test(id)) throw new KnowledgeError(400, 'unsupported knowledge file type')
          if (info.size > KNOWLEDGE_LIMITS.maxFileBytes) throw new KnowledgeError(413, 'knowledge file size limit exceeded')
          state.entries.set(id, await this.readEntry(id, info, readBudget))
        } catch (cause) {
          error(id, cause instanceof KnowledgeError ? cause.message : 'unreadable knowledge entry')
        }
      }
    }
    await walk(this.root, '', 0)
    const revision = createHash('sha256')
    for (const [id, entry] of state.entries) revision.update(`${id}\0${entry.document.version}\0${entry.fingerprint}\n`)
    state.revision = revision.digest('hex')
    return state
  }

  private async refresh(): Promise<Snapshot> {
    const snapshot = await this.scan()
    this.snapshot = snapshot
    return snapshot
  }

  async reload(): Promise<{ documents: KnowledgeDocument[]; revision: string; errors: string[] }> {
    const snapshot = await this.refresh()
    return { documents: [...snapshot.entries.values()].map(entry => ({ ...entry.document })),
      revision: snapshot.revision, errors: [...snapshot.errors] }
  }

  list(): KnowledgeDocument[] {
    return [...this.snapshot.entries.values()].map(entry => ({ ...entry.document }))
  }

  async read(id: string, options: ReadOptions = {}): Promise<KnowledgeRead> {
    const documentId = relativePath(id)
    const offset = integer(options.offset, 1, 1, Number.MAX_SAFE_INTEGER, 'offset')
    const charOffset = integer(options.charOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'charOffset')
    const limit = integer(options.limit, KNOWLEDGE_LIMITS.readLines, 1, KNOWLEDGE_LIMITS.readLines, 'limit')
    const maxChars = integer(options.maxChars, KNOWLEDGE_LIMITS.readChars, 1, KNOWLEDGE_LIMITS.readChars, 'maxChars')
    if (options.version !== undefined && typeof options.version !== 'string') throw new KnowledgeError(400, 'version must be a string')
    const snapshot = await this.refresh()
    const entry = snapshot.entries.get(documentId)
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
    const checkCurrent = () => {
      try { assertCurrent?.() }
      catch (error) { throw new CurrentAssertionError(error) }
    }
    try { return await locked(this.root, async () => {
      checkCurrent() // No filesystem access occurs before the workspace-epoch check.
      const before = await this.scan()
      const bytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
      if (before.overLimit || before.files + files.length > KNOWLEDGE_LIMITS.maxFiles || before.bytes + bytes > KNOWLEDGE_LIMITS.maxTotalBytes) {
        throw new KnowledgeError(413, 'knowledge collection limit exceeded')
      }
      const batch = `batch_${randomUUID()}`
      const staging = path.join(this.parent, `.knowledge-staging_${randomUUID()}`)
      const destination = path.join(this.root, batch)
      let staged = false, published = false
      try {
        await this.ensureRoot(true, checkCurrent)
        await safeDirectory(this.parent, checkCurrent)
        checkCurrent()
        await fs.mkdir(staging, { mode: 0o700 })
        staged = true
        await safeDirectory(staging, checkCurrent)
        for (const file of files) {
          let directory = staging
          for (const part of file.path.split('/').slice(0, -1)) {
            await safeDirectory(directory, checkCurrent)
            const child = path.join(directory, part)
            checkCurrent()
            try { await fs.mkdir(child, { mode: 0o700 }) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
            await safeDirectory(child, checkCurrent)
            directory = child
          }
          await safeDirectory(directory, checkCurrent)
          checkCurrent()
          const handle = await fs.open(path.join(directory, path.posix.basename(file.path)),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
          try {
            checkCurrent()
            await handle.writeFile(file.bytes)
            const stat = await handle.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== file.bytes.length) throw new KnowledgeError(409, 'knowledge staging file changed')
          } finally { await handle.close() }
        }
        await safeDirectory(staging, checkCurrent)
        await safeDirectory(this.root, checkCurrent)
        checkCurrent()
        try { await fs.lstat(destination); throw new KnowledgeError(409, 'knowledge collection already exists') }
        catch (error) { if (!missing(error)) throw error }
        // Random, independent collection names plus the absence check never reuse a user's collection.
        checkCurrent()
        await fs.rename(staging, destination)
        published = true
        const documents = files.map(file => documentOf(`${batch}/${file.path}`, file.text, file.bytes))
        await this.refresh()
        return { documents, imported: documents.length }
      } catch (error) {
        if (error instanceof KnowledgeError || error instanceof CurrentAssertionError) throw error
        throw new KnowledgeError(500, 'could not import knowledge documents')
      } finally {
        if (staged && !published) {
          // Cleanup only our private real directory, never a replaced link or linked ancestor.
          try {
            await safeDirectory(this.parent)
            await safeDirectory(staging)
            await fs.rm(staging, { recursive: true, force: true })
          } catch { /* An unsafe/replaced staging directory must not be followed. */ }
        }
      }
    }) } catch (error) {
      if (error instanceof CurrentAssertionError) throw error.original
      throw error
    }
  }
}
