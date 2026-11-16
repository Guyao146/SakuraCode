import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GitObjects } from '../git/objects.js'
import { operation, resolveGit, type Operation } from '../git/process.js'
import { discoverRepository, IsolatedRepository, resolveRef } from '../git/repository.js'
import { digest, digestParts, guardDirectory, inside, isText, localPath, optionalRegular, readRegular, samePath, statOrNull } from '../git/safety.js'
import { GitReviewError } from '../git/types.js'
import {
  LIMITS, MAX_WORKTREES, assertFingerprint, assertId, atomicFile, contentKey, copyCommitTrees, ensureDirectory, inode, inspectFile, locations,
  makeIndex, order, privatePath, registerWorktree, relativeFile, removeOwned, requireSame, stateKey, storeRead, storeSave,
  validateRecord, verifyParents, withLock, withExecutionLease, writeNew, writeObject,
  type BaseEntry, type Context, type FileState, type RecordData, type StoreState,
} from './internal.js'
import { WorktreeError, type WorktreeCreatePreview, type WorktreeFile, type WorktreeInfo, type WorktreeIntegratePreview, type WorktreeOperation, type WorktreeOptions, type WorktreeRead } from './types.js'

const WARNINGS = ['Committed local raw bytes only; no checkout filters, hooks, dependencies, submodules or repository code are executed.', 'This worktree has private Git metadata; it is registered there, not in the original repository.']
const INTEGRATION_WARNING = 'Selected files are published atomically one at a time, not as a multi-file atomic transaction. Preimages and a recovery journal are retained in dataDir.'
interface BaseCapture { context: Context; state: StoreState; isolated: IsolatedRepository; objects: GitObjects; commit: string; requestedRef: string; rawRef: string; base: BaseEntry[]; contents: Map<string, Buffer>; bytes: number; fingerprint: string; warnings: string[] }
interface Capture { context: Context; state: StoreState; record: RecordData; result: WorktreeRead; sources: Map<string, FileState>; indexHash: string | null }
interface Selection { file: WorktreeFile; source: FileState; target: FileState }
type Preview = { type: 'create'; expires: number; cost: number; value: WorktreeCreatePreview; request: { taskId: string; baseRef: string } } |
  { type: 'integrate'; expires: number; cost: number; value: WorktreeIntegratePreview; readFingerprint: string; selection: Selection[] }
interface Journal { version: 1; id: string; worktreeId: string; repositoryId: string; phase: string; files: { path: string; beforeHash: string | null; afterHash: string | null; beforeMode: string | null; afterMode: string | null; beforeImage: string | null; afterImage: string | null; published: boolean }[]; recovery: string[] }

/** Isolated committed worktrees and explicit raw-text integration. The original index is never a Git command target. */
export class WorktreeService {
  readonly cwd: string
  readonly managedRoot: string
  private readonly gitPath?: string
  private readonly previews = new Map<string, Preview>()
  private active = 0

  constructor(cwd: string, options: WorktreeOptions = {}) {
    localPath(cwd)
    this.cwd = path.resolve(cwd)
    this.managedRoot = path.resolve(options.managedRoot ?? path.join(os.homedir(), '.sakura', 'worktrees'))
    localPath(this.managedRoot)
    if (options.managedRoot !== undefined) localPath(options.managedRoot)
    if (options.gitPath !== undefined) localPath(options.gitPath)
    this.gitPath = options.gitPath
  }

  private async perform<T>(input: WorktreeOperation | undefined, run: (op: Operation) => Promise<T>): Promise<T> {
    if (this.active >= 2) throw new WorktreeError('BUSY', 'Too many concurrent worktree operations.', 429)
    const timed = operation(LIMITS.timeoutMs, input?.signal)
    const op: Operation = { signal: timed.signal, dispose: () => timed.dispose(), check: () => { timed.check(); input?.assertCurrent?.(); timed.check() } }
    this.active++
    try { op.check(); return await run(op) }
    catch (error) { if (error instanceof GitReviewError) throw new WorktreeError(error.code, error.message, error.status); throw error }
    finally { op.dispose(); this.active-- }
  }

  private async context(op: Operation): Promise<Context> {
    op.check()
    await guardDirectory(this.cwd)
    const repo = await discoverRepository(this.cwd, LIMITS, op)
    if (!repo) throw new WorktreeError('NOT_REPOSITORY', 'This workspace is not a local Git repository.', 422)
    if (repo.scope || !samePath(repo.root, repo.workspace) || !samePath(repo.gitDir, path.join(repo.root, '.git')) || !samePath(repo.commonDir, repo.gitDir) || !(await fs.lstat(repo.gitDir)).isDirectory()) {
      throw new WorktreeError('UNSUPPORTED_REPOSITORY', 'Only a complete ordinary non-bare repository workspace is supported; linked worktrees and parent-repository/subdirectory workspaces are not expanded automatically.', 422)
    }
    if (inside(repo.root, this.managedRoot) || inside(this.managedRoot, repo.root)) throw new WorktreeError('UNSAFE_PATH', 'The managed root and original repository must not contain one another.')
    const identity = digestParts([repo.id, inode(await guardDirectory(repo.root)), inode(await guardDirectory(repo.gitDir)), repo.format, repo.fileMode])
    const storeDir = path.join(this.managedRoot, repo.id)
    await ensureDirectory(storeDir)
    const head = await resolveRef(repo, 'HEAD', LIMITS, op)
    return { repo, identity, storeDir, storeIdentity: inode(await guardDirectory(storeDir)), storeFile: path.join(storeDir, 'state.json'), head }
  }

  private async verifyContext(context: Context, op?: Operation, checkHead = true): Promise<void> {
    op?.check()
    const repo = context.repo
    requireSame(digestParts([repo.id, inode(await guardDirectory(repo.root)), inode(await guardDirectory(repo.gitDir)), repo.format, repo.fileMode]), context.identity, 'The original repository identity changed.')
    requireSame(inode(await guardDirectory(context.storeDir)), context.storeIdentity, 'The managed metadata directory changed.')
    if (checkHead) {
      const fallback = operation(LIMITS.timeoutMs)
      try { requireSame(await resolveRef(repo, 'HEAD', LIMITS, op ?? fallback), context.head, 'Original HEAD changed; create a new preview.') } finally { fallback.dispose() }
    }
    op?.check()
  }

  private index(context: Context): Promise<Buffer | null> { return optionalRegular(path.join(context.repo.gitDir, 'index'), LIMITS.maxMetadataBytes, true) }
  private async indexHash(context: Context): Promise<string | null> { const bytes = await this.index(context); return bytes === null ? null : digest(bytes) }
  private record(state: StoreState, id: string): RecordData {
    assertId(id)
    const record = state.data.records.find(value => value.info.id === id && !value.removedAt)
    if (!record) throw new WorktreeError('NOT_FOUND', 'The managed worktree was not found.', 404)
    return record
  }
  private put(preview: Preview): void {
    const now = Date.now()
    for (const [id, entry] of this.previews) if (entry.expires <= now) this.previews.delete(id)
    while (this.previews.size >= 16 || [...this.previews.values()].reduce((total, entry) => total + entry.cost, 0) + preview.cost > LIMITS.maxTotalBytes) {
      const oldest = this.previews.keys().next().value
      if (!oldest) throw new WorktreeError('LIMIT_EXCEEDED', 'The selected preview exceeds its memory limit.', 413)
      this.previews.delete(oldest)
    }
    this.previews.set(preview.value.id, preview)
  }
  private take(id: string, fingerprint: string): Preview {
    assertId(id); assertFingerprint(fingerprint)
    const preview = this.previews.get(id)
    this.previews.delete(id)
    if (!preview || preview.expires <= Date.now()) throw new WorktreeError('PREVIEW_EXPIRED', 'The preview expired or was already used. Preview again.', 409)
    requireSame(preview.value.fingerprint, fingerprint)
    return preview
  }

  async list(input?: WorktreeOperation): Promise<{ repositoryId: string; fingerprint: string; worktrees: WorktreeInfo[]; warnings: string[] }> {
    return this.perform(input, async op => {
      const context = await this.context(op), state = await storeRead(context)
      const records = state.data.records.filter(record => !record.removedAt)
      const warnings = [...WARNINGS]
      for (const record of records) { op.check(); await validateRecord(context, record); if (record.pendingTransaction) warnings.push(`Recovery required: ${path.join(record.info.dataDir, 'transactions', record.pendingTransaction)}`) }
      await this.verifyContext(context, op)
      requireSame((await storeRead(context)).hash, state.hash)
      return { repositoryId: context.repo.id, fingerprint: digestParts([context.identity, context.storeIdentity, state.hash]), worktrees: records.map(record => ({ ...record.info })), warnings }
    })
  }

  private validateCreate(request: { taskId: string; baseRef?: string }): { taskId: string; baseRef: string } {
    if (!request || typeof request.taskId !== 'string' || !request.taskId.trim() || request.taskId.length > 160 || /[\x00-\x1f\x7f]/.test(request.taskId)) throw new WorktreeError('INVALID_ARGUMENT', 'A non-empty task ID of at most 160 characters is required.')
    const baseRef = request.baseRef ?? 'HEAD'
    if (typeof baseRef !== 'string' || !baseRef || baseRef.length > 512 || baseRef.startsWith('refs/') && !/^refs\/(?:heads|tags)\//.test(baseRef)) throw new WorktreeError('INVALID_REF', 'The baseline must be HEAD, a committed local branch/tag, or a full local commit ID.')
    return { taskId: request.taskId, baseRef }
  }

  private async baseline(request: { taskId: string; baseRef: string }, op: Operation): Promise<BaseCapture> {
    const context = await this.context(op), state = await storeRead(context)
    if (state.data.records.some(record => !record.removedAt && record.info.taskId === request.taskId)) throw new WorktreeError('TASK_BOUND', 'This task already has a managed worktree.', 409)
    if (state.data.records.filter(record => !record.removedAt).length >= MAX_WORKTREES || state.data.records.length >= 256) throw new WorktreeError('LIMIT_EXCEEDED', 'The repository has reached its managed worktree limit.', 413)
    const executable = await resolveGit(this.gitPath)
    if (!executable) throw new WorktreeError('GIT_UNAVAILABLE', 'A trusted local Git executable was not found.', 503)
    const rawRef = await resolveRef(context.repo, request.baseRef, LIMITS, op)
    if (!rawRef) throw new WorktreeError('INVALID_REF', 'An existing committed local baseline is required; HEAD is unborn.', 422)
    const isolated = await IsolatedRepository.create(context.repo, executable, LIMITS, op)
    try {
      const objects = new GitObjects(isolated), commit = await objects.commit(rawRef)
      const entries = await isolated.tree(commit)
      const base: BaseEntry[] = [], contents = new Map<string, Buffer>(), seen = new Set<string>()
      let bytes = 0
      for (const entry of entries) {
        op.check(); relativeFile(entry.path)
        if (!['100644', '100755', '120000', '160000'].includes(entry.mode)) throw new WorktreeError('UNSUPPORTED_REPOSITORY', 'The baseline contains unsupported file modes.', 422)
        const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path
        if (seen.has(key) || [...seen].some(name => name.startsWith(key + '/') || key.startsWith(name + '/'))) throw new WorktreeError('UNSAFE_PATH', 'Baseline paths collide on this filesystem.')
        seen.add(key)
        const excluded = privatePath(entry.path) || !['100644', '100755'].includes(entry.mode)
        if (excluded) { base.push({ ...entry, hash: null, bytes: 0, text: false, excluded }); continue }
        const object = await objects.object(entry.oid)
        if (object.type !== 'blob') throw new WorktreeError('UNSAFE_REPOSITORY', 'A baseline file is not a blob.')
        bytes += object.bytes.length
        if (bytes > LIMITS.maxTotalBytes) throw new WorktreeError('LIMIT_EXCEEDED', 'The committed baseline exceeds its byte limit.', 413)
        contents.set(entry.path, object.bytes)
        base.push({ ...entry, hash: digest(object.bytes), bytes: object.bytes.length, text: isText(object.bytes), excluded: false })
      }
      await this.verifyContext(context, op)
      requireSame(await resolveRef(context.repo, request.baseRef, LIMITS, op), rawRef)
      await isolated.assertIndexUnchanged()
      requireSame((await storeRead(context)).hash, state.hash)
      const fingerprint = digestParts([context.identity, context.storeIdentity, context.head, state.hash, request, rawRef, commit, base])
      const warnings = [...WARNINGS]
      if (base.some(entry => entry.excluded)) warnings.push('Private .sakura paths, symbolic links and submodules are excluded and marked skip-worktree; they are not followed or copied.')
      return { context, state, isolated, objects, requestedRef: request.baseRef, rawRef, commit, base, contents, bytes, fingerprint, warnings }
    } catch (error) { await isolated.dispose(); throw error }
  }

  async previewCreate(request: { taskId: string; baseRef?: string }, input?: WorktreeOperation): Promise<WorktreeCreatePreview> {
    const validated = this.validateCreate(request)
    return this.perform(input, async op => {
      const base = await this.baseline(validated, op)
      try {
        const value: WorktreeCreatePreview = { id: randomUUID(), fingerprint: base.fingerprint, repositoryId: base.context.repo.id, commit: base.commit, taskId: validated.taskId, files: base.contents.size, bytes: base.bytes, warnings: base.warnings }
        this.put({ type: 'create', value: structuredClone(value), request: validated, expires: Date.now() + 300_000, cost: Buffer.byteLength(JSON.stringify(base.base)) })
        return value
      } finally { await base.isolated.dispose() }
    })
  }

  async create(request: { previewId: string; expectedFingerprint: string }, input?: WorktreeOperation): Promise<WorktreeInfo> {
    const preview = this.take(request.previewId, request.expectedFingerprint)
    if (preview.type !== 'create') throw new WorktreeError('INVALID_ARGUMENT', 'This is not a create preview.')
    return this.perform(input, async op => {
      const base = await this.baseline(preview.request, op)
      try {
        requireSame(base.fingerprint, preview.value.fingerprint)
        return await withLock(base.context, async () => {
          op.check(); requireSame((await storeRead(base.context)).hash, base.state.hash)
          const id = randomUUID(), loc = locations(base.context, id)
          await fs.mkdir(loc.container, { mode: 0o700 })
          const containerIdentity = inode(await guardDirectory(loc.container))
          let persisted = false
          try {
            await fs.mkdir(loc.data, { mode: 0o700 })
            for (const directory of ['objects/info', 'objects/pack', 'refs/heads', 'empty-hooks']) await ensureDirectory(path.join(loc.git, directory))
            const hooks = path.join(loc.git, 'empty-hooks').replaceAll('\\', '/')
            const config = `[core]\nrepositoryformatversion = ${base.context.repo.format === 'sha256' ? 1 : 0}\nbare = true\nfilemode = ${base.context.repo.fileMode}\nautocrlf = false\nlongpaths = true\nfsmonitor = false\nhooksPath = "${hooks.replaceAll('"', '\\"')}"\n[gc]\nauto = 0\n[maintenance]\nauto = false\n` + (base.context.repo.format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : '')
            await writeNew(path.join(loc.git, 'config'), config)
            await writeNew(path.join(loc.git, 'HEAD'), base.commit + '\n')
            await writeNew(path.join(loc.git, 'shallow'), base.commit + '\n')
            await copyCommitTrees(base.objects, loc.git, base.commit, op)
            for (const entry of base.base) {
              op.check()
              const bytes = base.contents.get(entry.path)
              if (bytes) await writeObject(loc.git, 'blob', bytes, entry.oid)
            }
            await registerWorktree(base.isolated.git.executable, loc.git, loc.tree, base.commit, op)
            await writeNew(path.join(loc.admin, 'index'), makeIndex(base.base, base.context.repo.format))
            for (const entry of base.base) {
              op.check()
              const bytes = base.contents.get(entry.path)
              if (!bytes) continue
              const file = path.join(loc.tree, ...entry.path.split('/'))
              await ensureDirectory(path.dirname(file))
              await writeNew(file, bytes, entry.mode === '100755' ? 0o755 : 0o644)
            }
            const info: WorktreeInfo = { id, taskId: preview.request.taskId, repositoryId: base.context.repo.id, commit: base.commit, path: loc.tree, dataDir: loc.data, createdAt: new Date().toISOString() }
            const record: RecordData = {
              info, base: base.base, integrated: [], identities: { container: containerIdentity, tree: inode(await guardDirectory(loc.tree)), data: inode(await guardDirectory(loc.data)), git: inode(await guardDirectory(loc.git)), admin: inode(await guardDirectory(loc.admin)) },
              markerHash: digest((await readRegular(path.join(loc.tree, '.git'), LIMITS.maxMetadataBytes, true)).bytes), configHash: digest(config),
            }
            await validateRecord(base.context, record)
            await this.verifyContext(base.context, op)
            requireSame(await resolveRef(base.context.repo, base.requestedRef, LIMITS, op), base.rawRef)
            await base.isolated.assertIndexUnchanged()
            base.state.data.records.push(record)
            op.check()
            await storeSave(base.context, base.state)
            persisted = true
            return { ...info }
          } catch (error) {
            if (!persisted) {
              try { await removeOwned(loc.container, containerIdentity) }
              catch { throw new WorktreeError('CREATE_RECOVERY_REQUIRED', `Creation failed and the private directory could not be removed safely. Inspect ${loc.container}.`, 409, loc.container) }
            }
            throw error
          }
        })
      } finally { await base.isolated.dispose() }
    })
  }

  private async capture(context: Context, state: StoreState, record: RecordData, op: Operation): Promise<Capture> {
    await validateRecord(context, record)
    const indexHash = await this.indexHash(context), sources = new Map<string, FileState>()
    const base = new Map(record.base.map(entry => [entry.path, entry])), integrated = new Map(record.integrated.map(entry => [entry.path, entry]))
    let bytes = 0, scanned = 0
    const read = async (name: string, metadataOnly = false) => {
      const entry = base.get(name)
      const value = await inspectFile(record.info.path, name, context.repo.fileMode, entry?.mode === '100755' ? '100755' : '100644', metadataOnly)
      bytes += value.bytes?.length ?? 0
      if (bytes > LIMITS.maxTotalBytes || sources.size >= LIMITS.maxFiles + LIMITS.maxUntrackedFiles) throw new WorktreeError('LIMIT_EXCEEDED', 'The managed worktree exceeds its bounded read limit.', 413)
      sources.set(name, value)
    }
    const visit = async (directory: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 64) throw new WorktreeError('LIMIT_EXCEEDED', 'Worktree nesting exceeds its limit.', 413)
      const identity = inode(await guardDirectory(directory))
      const handle = await fs.opendir(directory)
      for await (const entry of handle) {
        op.check()
        if (++scanned > (LIMITS.maxFiles + LIMITS.maxUntrackedFiles) * 4) throw new WorktreeError('LIMIT_EXCEEDED', 'Worktree entry count exceeds its limit.', 413)
        if (!prefix && entry.name === '.git') continue
        const name = prefix ? prefix + '/' + entry.name : entry.name
        relativeFile(name)
        const target = path.join(directory, entry.name), info = await fs.lstat(target)
        const excluded = privatePath(name) || base.get(name)?.excluded || info.isSymbolicLink() || !info.isDirectory() && !info.isFile()
        if (excluded) await read(name, true)
        else if (info.isDirectory()) {
          if (await statOrNull(path.join(target, '.git'))) await read(name, true)
          else await visit(target, name, depth + 1)
        } else await read(name)
      }
      requireSame(inode(await guardDirectory(directory)), identity)
    }
    await visit(record.info.path, '', 0)
    for (const entry of record.base) if (!sources.has(entry.path) && !entry.excluded) { op.check(); await read(entry.path) }
    const files: WorktreeFile[] = []
    for (const [name, source] of [...sources].sort(([a], [b]) => order(a, b))) {
      const before = base.get(name), prior = integrated.get(name)
      if (source.kind === 'missing' && (!before || before.excluded)) continue
      if (before && !before.excluded && source.kind === 'file' && source.hash === before.hash && source.mode === before.mode) continue
      const integrable = !privatePath(name) && !before?.excluded && (source.kind === 'missing' || source.kind === 'file' && isText(source.bytes!)) && (!before || before.text)
      const isIntegrated = Boolean(prior && integrable && prior.hash === source.hash && prior.mode === source.mode)
      files.push({ path: name, status: !before ? 'added' : source.kind === 'missing' ? 'deleted' : 'modified', baseHash: before?.hash ?? null, sourceHash: source.hash,
        ...(integrable && source.bytes ? { text: source.bytes.toString('utf8') } : {}), integrable, integrated: isIntegrated })
    }
    await validateRecord(context, record)
    await this.verifyContext(context, op)
    requireSame(await this.indexHash(context), indexHash, 'The original index changed during capture.')
    requireSame((await storeRead(context)).hash, state.hash)
    const fingerprint = digestParts([context.identity, context.storeIdentity, context.head, state.hash, record.info.id, indexHash, [...sources].sort(([a], [b]) => order(a, b)).map(([name, source]) => [name, stateKey(source)])])
    const warnings = [...WARNINGS]
    if (files.some(file => !file.integrable)) warnings.push('Binary, linked, private and special files are not integrable; they are never followed.')
    if (record.pendingTransaction) warnings.push(`Recovery required before further writes: ${path.join(record.info.dataDir, 'transactions', record.pendingTransaction)}`)
    return { context, state, record, sources, indexHash, result: { worktree: { ...record.info }, fingerprint, files, warnings } }
  }

  async read(id: string, input?: WorktreeOperation): Promise<WorktreeRead> {
    assertId(id)
    return this.perform(input, async op => {
      const context = await this.context(op), state = await storeRead(context)
      return (await this.capture(context, state, this.record(state, id), op)).result
    })
  }

  async previewIntegrate(request: { id: string; expectedFingerprint: string; paths: string[] }, input?: WorktreeOperation): Promise<WorktreeIntegratePreview> {
    assertId(request.id); assertFingerprint(request.expectedFingerprint)
    if (!Array.isArray(request.paths) || !request.paths.length || request.paths.length > 128 || new Set(request.paths).size !== request.paths.length) throw new WorktreeError('INVALID_ARGUMENT', 'Select between 1 and 128 unique, literal file paths explicitly.')
    const paths = request.paths.map(relativeFile).sort(order)
    return this.perform(input, async op => {
      const context = await this.context(op), state = await storeRead(context), record = this.record(state, request.id)
      if (record.pendingTransaction) throw new WorktreeError('RECOVERY_REQUIRED', 'Resolve the unfinished transaction before another integration.', 409, path.join(record.info.dataDir, 'transactions', record.pendingTransaction))
      const capture = await this.capture(context, state, record, op)
      requireSame(capture.result.fingerprint, request.expectedFingerprint)
      const selection: Selection[] = [], conflicts: WorktreeIntegratePreview['conflicts'] = []
      let cost = 0
      for (const name of paths) {
        op.check()
        const file = capture.result.files.find(value => value.path === name)
        if (!file) throw new WorktreeError('INVALID_ARGUMENT', 'Every selected path must be present in the current change list.')
        const source = capture.sources.get(name)!, base = record.base.find(entry => entry.path === name), previous = record.integrated.find(entry => entry.path === name)
        const target = await inspectFile(context.repo.root, name, context.repo.fileMode, base?.mode === '100755' ? '100755' : '100644', privatePath(name))
        const ordinaryTarget = target.kind === 'missing' || target.kind === 'file' && isText(target.bytes!)
        const matchesBase = target.hash === (base?.hash ?? null) && target.mode === (base && !base.excluded ? base.mode : null)
        const matchesPrevious = previous && target.hash === previous.hash && target.mode === previous.mode
        if (!file.integrable) conflicts.push({ path: name, reason: 'Only ordinary UTF-8 text additions, modifications and deletions are supported.' })
        else if (!ordinaryTarget) conflicts.push({ path: name, reason: 'The destination is binary, linked, nested or otherwise not an ordinary text file.' })
        else if (!matchesBase && !matchesPrevious) conflicts.push({ path: name, reason: 'The destination no longer matches the committed base or the last integrated content; existing edits are preserved.' })
        cost += (source.bytes?.length ?? 0) + (target.bytes?.length ?? 0)
        if (cost > 16 * 1024 * 1024) throw new WorktreeError('LIMIT_EXCEEDED', 'Selected before/after images exceed the 16 MiB integration limit.', 413)
        selection.push({ file: { ...file }, source, target })
      }
      for (const selected of selection) {
        op.check()
        requireSame(stateKey(await inspectFile(record.info.path, selected.file.path, context.repo.fileMode, selected.source.mode ?? '100644', !selected.file.integrable)), stateKey(selected.source))
        requireSame(stateKey(await inspectFile(context.repo.root, selected.file.path, context.repo.fileMode, selected.target.mode ?? '100644', privatePath(selected.file.path))), stateKey(selected.target))
      }
      await this.verifyContext(context, op)
      requireSame((await storeRead(context)).hash, state.hash)
      const fingerprint = digestParts([capture.result.fingerprint, paths, selection.map(entry => [entry.file.path, stateKey(entry.source), stateKey(entry.target)]), conflicts])
      const value: WorktreeIntegratePreview = { id: randomUUID(), fingerprint, worktreeId: record.info.id, files: selection.map(entry => entry.file), conflicts, canIntegrate: conflicts.length === 0, warnings: [...capture.result.warnings, INTEGRATION_WARNING] }
      this.put({ type: 'integrate', value: structuredClone(value), selection, readFingerprint: capture.result.fingerprint, expires: Date.now() + 300_000, cost })
      return value
    })
  }

  async integrate(request: { previewId: string; expectedFingerprint: string }, input?: WorktreeOperation): Promise<{ worktree: WorktreeInfo; applied: string[]; transactionId: string; indexUnchanged: true }> {
    const preview = this.take(request.previewId, request.expectedFingerprint)
    if (preview.type !== 'integrate') throw new WorktreeError('INVALID_ARGUMENT', 'This is not an integration preview.')
    if (!preview.value.canIntegrate) throw new WorktreeError('CONFLICT', 'The selected preview has conflicts; nothing was integrated.', 409)
    return this.perform(input, async op => {
      const context = await this.context(op)
      return withLock(context, async () => {
        let state = await storeRead(context), record = this.record(state, preview.value.worktreeId)
        if (record.pendingTransaction) throw new WorktreeError('RECOVERY_REQUIRED', 'Resolve the unfinished transaction first.', 409, path.join(record.info.dataDir, 'transactions', record.pendingTransaction))
        await validateRecord(context, record)
        return withExecutionLease(record.info.dataDir, async () => {
        const capture = await this.capture(context, state, record, op)
        requireSame(capture.result.fingerprint, preview.readFingerprint)
        for (const entry of preview.selection) {
          op.check()
          requireSame(stateKey(capture.sources.get(entry.file.path)!), stateKey(entry.source))
          requireSame(stateKey(await inspectFile(context.repo.root, entry.file.path, context.repo.fileMode, entry.target.mode ?? '100644')), stateKey(entry.target), 'A selected destination changed since preview.')
        }
        const transactionId = randomUUID(), recoveryPath = path.join(record.info.dataDir, 'transactions', transactionId)
        await ensureDirectory(recoveryPath)
        const journalPath = path.join(recoveryPath, 'journal.json')
        const journal: Journal = { version: 1, id: transactionId, worktreeId: record.info.id, repositoryId: context.repo.id, phase: 'preparing', files: [], recovery: [] }
        let journalHash: string | null = null
        const saveJournal = async () => { const bytes = Buffer.from(JSON.stringify(journal)); await atomicFile(journalPath, bytes, journalHash); journalHash = digest(bytes) }
        const published: { entry: Selection; after: FileState }[] = [], createdDirectories: [string, string][] = [], temporaries: { path: string; identity: string }[] = []
        let pending = false, committed = false
        try {
          // Every preimage is synced before the first destination change, including before parent creation.
          for (let i = 0; i < preview.selection.length; i++) {
            op.check()
            const entry = preview.selection[i]!, beforeImage = entry.target.bytes ? `before-${i}` : null, afterImage = entry.source.bytes ? `after-${i}` : null
            if (beforeImage) await writeNew(path.join(recoveryPath, beforeImage), entry.target.bytes!)
            if (afterImage) await writeNew(path.join(recoveryPath, afterImage), entry.source.bytes!)
            journal.files.push({ path: entry.file.path, beforeHash: entry.target.hash, afterHash: entry.source.hash, beforeMode: entry.target.mode, afterMode: entry.source.mode, beforeImage, afterImage, published: false })
          }
          journal.phase = 'prepared'; await saveJournal()
          await validateRecord(context, record); await this.verifyContext(context, op)
          requireSame(await this.indexHash(context), capture.indexHash)
          record.pendingTransaction = transactionId
          state = await storeSave(context, state); record = this.record(state, record.info.id); pending = true
          journal.phase = 'publishing'; await saveJournal()
          for (let i = 0; i < preview.selection.length; i++) {
            const entry = preview.selection[i]!, name = entry.file.path, target = path.join(context.repo.root, ...name.split('/'))
            op.check(); await this.verifyContext(context, op); await validateRecord(context, record)
            requireSame(await this.indexHash(context), capture.indexHash, 'The original index changed; integration stopped.')
            requireSame(stateKey(await inspectFile(record.info.path, name, context.repo.fileMode, entry.source.mode ?? '100644')), stateKey(entry.source), 'A selected source changed during integration.')
            const current = await inspectFile(context.repo.root, name, context.repo.fileMode, entry.target.mode ?? '100644')
            await verifyParents(entry.target.parents)
            requireSame(contentKey(current), contentKey(entry.target), 'A destination changed during integration.')
            for (const [directory, identity] of createdDirectories) requireSame(inode(await guardDirectory(directory)), identity)
            if (entry.source.kind === 'file') {
              let directory = context.repo.root
              for (const component of name.split('/').slice(0, -1)) {
                directory = path.join(directory, component)
                if (!await statOrNull(directory)) { op.check(); await fs.mkdir(directory, { mode: 0o755 }); createdDirectories.push([directory, inode(await guardDirectory(directory))]) }
                else await guardDirectory(directory)
              }
              const temp = path.join(path.dirname(target), '.sakura-worktree-' + transactionId + '-' + i + '.tmp')
              await writeNew(temp, entry.source.bytes!, entry.source.mode === '100755' ? 0o755 : 0o644)
              temporaries.push({ path: temp, identity: inode(await fs.lstat(temp)) })
              op.check(); await verifyParents(entry.target.parents)
              for (const [directory, identity] of createdDirectories) requireSame(inode(await guardDirectory(directory)), identity)
              requireSame(contentKey(await inspectFile(context.repo.root, name, context.repo.fileMode, entry.target.mode ?? '100644')), contentKey(entry.target))
              if (entry.target.kind === 'missing') { await fs.link(temp, target); await fs.unlink(temp) }
              else await fs.rename(temp, target)
            } else {
              op.check(); await verifyParents(entry.target.parents)
              requireSame(contentKey(await inspectFile(context.repo.root, name, context.repo.fileMode, entry.target.mode ?? '100644')), contentKey(entry.target))
              if (entry.target.kind !== 'missing') await fs.unlink(target)
            }
            // Record ownership immediately after publishing, before any cancellable callback or journal write.
            const after = await inspectFile(context.repo.root, name, context.repo.fileMode, entry.source.mode ?? '100644')
            published.push({ entry, after })
            requireSame(after.hash, entry.source.hash)
            requireSame(after.mode, entry.source.mode)
            journal.files[i]!.published = true; await saveJournal()
          }
          op.check(); await validateRecord(context, record); await this.verifyContext(context, op)
          requireSame(await this.indexHash(context), capture.indexHash, 'The original index changed during integration.')
          for (const item of published) {
            requireSame(stateKey(await inspectFile(context.repo.root, item.entry.file.path, context.repo.fileMode, item.after.mode ?? '100644')), stateKey(item.after), 'An already published destination was edited externally.')
            requireSame(stateKey(await inspectFile(record.info.path, item.entry.file.path, context.repo.fileMode, item.entry.source.mode ?? '100644')), stateKey(item.entry.source))
          }
          const integrated = new Map(record.integrated.map(entry => [entry.path, entry]))
          for (const entry of preview.selection) integrated.set(entry.file.path, { path: entry.file.path, hash: entry.source.hash, mode: entry.source.mode })
          record.integrated = [...integrated.values()].sort((a, b) => order(a.path, b.path))
          delete record.pendingTransaction
          state = await storeSave(context, state); committed = true
          journal.phase = 'committed'; await saveJournal()
          return { worktree: { ...record.info }, applied: preview.selection.map(entry => entry.file.path), transactionId, indexUnchanged: true }
        } catch (error) {
          if (committed) throw new WorktreeError('JOURNAL_RECOVERY_REQUIRED', 'Files and integration metadata were saved, but the final journal write failed. Inspect the recovery journal.', 500, recoveryPath)
          for (const item of [...published].reverse()) {
            const name = item.entry.file.path, target = path.join(context.repo.root, ...name.split('/'))
            try {
              await this.verifyContext(context, undefined, false)
              await verifyParents(item.after.parents)
              const current = await inspectFile(context.repo.root, name, context.repo.fileMode, item.after.mode ?? '100644')
              requireSame(stateKey(current), stateKey(item.after))
              if (item.entry.target.kind === 'missing') { if (current.kind !== 'missing') await fs.unlink(target) }
              else {
                const temp = path.join(path.dirname(target), '.sakura-rollback-' + randomUUID())
                await writeNew(temp, item.entry.target.bytes!, item.entry.target.mode === '100755' ? 0o755 : 0o644)
                temporaries.push({ path: temp, identity: inode(await fs.lstat(temp)) })
                await verifyParents(item.after.parents)
                requireSame(stateKey(await inspectFile(context.repo.root, name, context.repo.fileMode, item.after.mode ?? '100644')), stateKey(item.after))
                if (current.kind === 'missing') { await fs.link(temp, target); await fs.unlink(temp) } else await fs.rename(temp, target)
              }
            } catch { journal.recovery.push(name) }
          }
          for (const [directory, identity] of [...createdDirectories].reverse()) {
            try { requireSame(inode(await guardDirectory(directory)), identity); await fs.rmdir(directory) } catch { /* Never remove external contents or replaced directories. */ }
          }
          journal.phase = journal.recovery.length ? 'needs_recovery' : 'rolled_back'
          try { await saveJournal() } catch { journal.recovery.push('journal.json') }
          if (pending && !journal.recovery.length) {
            try {
              const current = await storeRead(context)
              requireSame(current.hash, state.hash)
              const currentRecord = this.record(current, record.info.id)
              requireSame(currentRecord.pendingTransaction, transactionId)
              delete currentRecord.pendingTransaction
              await storeSave(context, current)
            } catch { journal.recovery.push('state.json') }
          }
          const detail = error instanceof Error ? error.message : 'Unknown integration failure.'
          throw new WorktreeError(journal.recovery.length ? 'RECOVERY_REQUIRED' : 'INTEGRATION_FAILED', journal.recovery.length ? `Integration stopped; external edits were preserved. Manual recovery is required for ${journal.recovery.join(', ')}. ${detail}` : `Integration stopped and its own published files were rolled back. ${detail}`, 409, recoveryPath)
        } finally {
          for (const temp of temporaries) {
            try { const info = await statOrNull(temp.path); if (info?.isFile() && !info.isSymbolicLink() && inode(info) === temp.identity) { await guardDirectory(path.dirname(temp.path)); await fs.unlink(temp.path) } } catch { /* Do not unlink a replaced or unsafe temporary. */ }
          }
        }
        })
      })
    })
  }

  async cleanup(request: { id: string; expectedFingerprint: string; discard?: boolean }, input?: WorktreeOperation): Promise<{ removed: true }> {
    assertId(request.id); assertFingerprint(request.expectedFingerprint)
    if (request.discard !== undefined && typeof request.discard !== 'boolean') throw new WorktreeError('INVALID_ARGUMENT', 'discard must be an explicit boolean.')
    return this.perform(input, async op => {
      const context = await this.context(op)
      return withLock(context, async () => {
        const state = await storeRead(context), record = this.record(state, request.id)
        if (record.pendingTransaction) throw new WorktreeError('RECOVERY_REQUIRED', 'An unfinished transaction prevents cleanup, even with discard.', 409, path.join(record.info.dataDir, 'transactions', record.pendingTransaction))
        await validateRecord(context, record)
        return withExecutionLease(record.info.dataDir, async () => {
          const capture = await this.capture(context, state, record, op)
          requireSame(capture.result.fingerprint, request.expectedFingerprint)
          if (!request.discard) {
            if (capture.result.files.some(file => !file.integrated)) throw new WorktreeError('UNINTEGRATED_CHANGES', 'The worktree has changes that have not been integrated. Integrate them or explicitly confirm discard.', 409)
            for (const file of capture.result.files) {
              const integrated = record.integrated.find(row => row.path === file.path)!
              const target = await inspectFile(context.repo.root, file.path, context.repo.fileMode, integrated.mode ?? '100644')
              if (target.kind === 'special' || target.hash !== integrated.hash || target.mode !== integrated.mode) {
                throw new WorktreeError('UNINTEGRATED_CHANGES', 'An integrated destination changed after integration. Keep the independent copy or explicitly confirm discard.', 409)
              }
            }
          }
          const loc = locations(context, record.info.id)
          await validateRecord(context, record); await this.verifyContext(context, op)
          requireSame(await this.indexHash(context), capture.indexHash)
          const latest = await this.capture(context, state, record, op)
          requireSame(latest.result.fingerprint, capture.result.fingerprint, 'Independent files changed before cleanup.')
          op.check()
          try {
            await removeOwned(loc.tree, record.identities.tree)
            await removeOwned(loc.admin, record.identities.admin)
            record.removedAt = new Date().toISOString()
            await storeSave(context, state)
            return { removed: true as const }
          } catch (error) { throw new WorktreeError('CLEANUP_RECOVERY_REQUIRED', `Cleanup did not finish. Private data and Git objects were retained. ${error instanceof Error ? error.message : ''}`, 409, loc.container) }
        })
      })
    })
  }
}
