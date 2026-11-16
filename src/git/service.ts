import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  GIT_REVIEW_LIMITS, GitReviewError,
  type GitExportPatchRequest, type GitMarkReviewedRequest, type GitPatchExport, type GitPatchRange,
  type GitReadUntrackedRequest, type GitReviewFile, type GitReviewLimits, type GitReviewOptions,
  type GitReviewSnapshot, type GitSnapshotOptions, type GitTrackedFingerprint,
} from './types.js'
import { digestParts, diskPath, gitPath, inScope, localPath, nulRecords, readRegular, utf8 } from './safety.js'
import { operation, resolveGit, type Operation } from './process.js'
import { discoverRepository, IsolatedRepository, resolveRef, type ObjectEntry, type Repository } from './repository.js'
import { GitObjects, mapFingerprint, rangeView, untrackedFiles, type ContentMap, type RangeView } from './objects.js'
import { EMPTY_STORE_FINGERPRINT, GitReviewStore, type StoreSnapshot } from './store.js'

interface Capture {
  snapshot: GitReviewSnapshot
  repo?: Repository
  isolated?: IsolatedRepository
  objects?: GitObjects
  views?: Record<GitPatchRange, RangeView>
  worktreeEntries?: ObjectEntry[]
  worktree?: ContentMap
  indexEntries?: ObjectEntry[]
  store?: GitReviewStore
  storeState?: StoreSnapshot
  rawHead?: string | null
  rawBase?: string | null
  baseRequest: string
  dispose(): Promise<void>
}
const rangeNames: GitPatchRange[] = ['staged', 'unstaged', 'baseline']
let activeOperations = 0
const allFiles = (snapshot: GitReviewSnapshot): GitReviewFile[] => Object.values(snapshot.ranges).flat()
const entryFingerprint = (entries: ObjectEntry[]): unknown[] => [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)) || a.stage - b.stage).map(entry => [entry.path, entry.stage, entry.mode, entry.oid])

/** Config-isolated, bounded, raw-byte review. It never runs Git against the real worktree/index/config. */
export class GitReviewService {
  readonly cwd: string
  readonly limits: GitReviewLimits
  private readonly explicitGit?: string
  private active = 0

  constructor(cwd: string, options: GitReviewOptions = {}) {
    localPath(cwd)
    this.cwd = path.resolve(cwd)
    this.explicitGit = options.gitPath
    if (this.explicitGit !== undefined) localPath(this.explicitGit)
    this.limits = { ...GIT_REVIEW_LIMITS, ...options.limits }
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024) throw new GitReviewError('INVALID_ARGUMENT', `Invalid Git review limit: ${name}.`)
    }
    if (this.limits.maxConcurrent > 8 || this.limits.timeoutMs > 120_000 || this.limits.maxFileBytes > 64 * 1024 * 1024 ||
        this.limits.maxTotalBytes > 256 * 1024 * 1024 || this.limits.maxOutputBytes > 64 * 1024 * 1024 || this.limits.maxPatchBytes > 32 * 1024 * 1024 ||
        this.limits.maxMetadataBytes > 64 * 1024 * 1024 || this.limits.maxStoreBytes > 4 * 1024 * 1024 || this.limits.maxFiles > 20_000 ||
        this.limits.maxUntrackedFiles > 20_000 || this.limits.maxSelectedUntracked > 256) throw new GitReviewError('INVALID_ARGUMENT', 'Git review limits exceed the hard safety ceiling.')
    Object.freeze(this.limits)
  }

  private async perform<T>(signal: AbortSignal | undefined, run: (op: Operation) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw new GitReviewError('CANCELLED', 'Git review cancelled.', 499)
    if (this.active >= this.limits.maxConcurrent || activeOperations >= GIT_REVIEW_LIMITS.maxConcurrent) throw new GitReviewError('BUSY', 'Too many concurrent Git review operations.', 429)
    this.active++
    activeOperations++
    const op = operation(this.limits.timeoutMs, signal)
    try { op.check(); const result = await run(op); op.check(); return result }
    catch (error) { op.check(); throw error }
    finally { op.dispose(); this.active--; activeOperations-- }
  }

  private validateOptions(options: GitSnapshotOptions): { baseRef: string; selected: string[] } {
    const baseRef = options.baseRef ?? 'HEAD'
    if (typeof baseRef !== 'string' || !baseRef || baseRef.length > 512) throw new GitReviewError('INVALID_REF', 'Invalid baseline reference.')
    if (options.selectedUntracked !== undefined && !Array.isArray(options.selectedUntracked)) throw new GitReviewError('INVALID_ARGUMENT', 'selectedUntracked must be a list of literal paths.')
    const selected = options.selectedUntracked ?? []
    if (selected.length > this.limits.maxSelectedUntracked) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many explicitly selected untracked files.', 413)
    for (const name of selected) {
      if (typeof name !== 'string') throw new GitReviewError('INVALID_ARGUMENT', 'Untracked selections must be literal paths.')
      gitPath(name)
    }
    if (new Set(selected).size !== selected.length) throw new GitReviewError('INVALID_ARGUMENT', 'Duplicate untracked selections.')
    return { baseRef, selected: [...selected].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))) }
  }

  private unavailable(status: 'not_repository' | 'git_unavailable', baseRef: string): Capture {
    const trackedFingerprint: GitTrackedFingerprint = {
      status, repositoryId: null, headOid: null, scope: null, fingerprint: null, includesUntracked: false,
      submodules: 'gitlink-only', normalization: 'raw-bytes-no-filters',
    }
    return {
      baseRequest: baseRef,
      snapshot: {
        status, message: status === 'git_unavailable' ? 'A trusted local Git executable was not found.' : 'The workspace is not inside a Git repository.',
        repositoryRoot: null, repositoryId: null, workspaceRoot: this.cwd, scope: null, headOid: null,
        base: { requestedRef: baseRef, oid: null }, snapshotId: digestParts([status, this.cwd, baseRef]),
        trackedFingerprint, storeFingerprint: EMPTY_STORE_FINGERPRINT, selectedUntracked: [],
        ranges: { staged: [], unstaged: [], baseline: [], untracked: [] }, complete: true, normalization: 'raw-bytes-no-filters',
      },
      async dispose() {},
    }
  }

  private async capture(options: GitSnapshotOptions, op: Operation): Promise<Capture> {
    const { baseRef, selected } = this.validateOptions(options)
    const executable = await resolveGit(this.explicitGit)
    if (!executable) return this.unavailable('git_unavailable', baseRef)
    const repo = await discoverRepository(this.cwd, this.limits, op)
    if (!repo) return this.unavailable('not_repository', baseRef)
    for (const name of selected) if (!inScope(name, repo.scope)) throw new GitReviewError('UNSAFE_PATH', 'An untracked selection is outside the workspace scope.')
    const isolated = await IsolatedRepository.create(repo, executable, this.limits, op)
    try {
      const objects = new GitObjects(isolated)
      const rawHead = await resolveRef(repo, 'HEAD', this.limits, op)
      const headOid = rawHead ? await objects.commit(rawHead) : null
      const rawBase = baseRef === 'HEAD' ? rawHead : await resolveRef(repo, baseRef, this.limits, op)
      if (!rawBase && baseRef !== 'HEAD') throw new GitReviewError('INVALID_REF', 'The local baseline does not exist.')
      const baseOid = rawBase ? (rawBase === rawHead ? headOid : await objects.commit(rawBase)) : null
      const indexEntries = await isolated.index()
      const headEntries = headOid ? await isolated.tree(headOid) : []
      const baseEntries = baseOid === headOid ? headEntries : baseOid ? await isolated.tree(baseOid) : []
      // An index deletion may leave the old pathname as untracked on disk. Never read it implicitly.
      const worktreeEntries = indexEntries
      const conflicts = new Map<string, ObjectEntry[]>()
      for (const entry of indexEntries) if (entry.stage) { const stages = conflicts.get(entry.path) ?? []; stages.push(entry); conflicts.set(entry.path, stages) }
      const head = await objects.load(headEntries)
      const base = baseOid === headOid ? head : await objects.load(baseEntries)
      const index = await objects.load(indexEntries)
      // Validate all conflict stage objects but never run a patch across them.
      await objects.load(indexEntries.filter(entry => entry.stage).map(entry => ({ ...entry, stage: 0 })))
      const worktree = await objects.worktree(worktreeEntries)
      const trackedFingerprint = this.tracked(repo, headOid, indexEntries, worktree, headEntries)
      const views = {
        staged: await rangeView(objects, 'staged', head, index, conflicts),
        unstaged: await rangeView(objects, 'unstaged', index, this.subset(worktree, indexEntries), conflicts),
        baseline: await rangeView(objects, 'baseline', base, worktree, conflicts),
      }
      const untracked = await untrackedFiles(objects, await isolated.untracked(indexEntries), new Set(selected))
      const store = new GitReviewStore(repo.workspace, this.limits)
      const storeState = await store.read()
      const snapshot: GitReviewSnapshot = {
        status: headOid ? 'ready' : 'unborn',
        ...(!headOid ? { message: 'HEAD is unborn. Staged additions are compared with the empty tree.' } : {}),
        repositoryRoot: repo.root, repositoryId: repo.id, workspaceRoot: repo.workspace, scope: repo.scope,
        headOid, base: { requestedRef: baseRef, oid: baseOid }, snapshotId: '', trackedFingerprint,
        storeFingerprint: storeState.fingerprint, selectedUntracked: selected,
        ranges: { staged: views.staged.files, unstaged: views.unstaged.files, baseline: views.baseline.files, untracked },
        complete: true, normalization: 'raw-bytes-no-filters',
      }
      const marks = new Map(storeState.data.records.map(record => [record.key, record.fingerprint]))
      for (const file of allFiles(snapshot)) file.reviewed = marks.get(this.markKey(snapshot, file)) === file.fingerprint
      const patchBytes = allFiles(snapshot).reduce((total, file) => total + Buffer.byteLength(file.patch ?? ''), 0)
      if (patchBytes > this.limits.maxPatchBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'The complete review exceeds the aggregate patch limit.', 413)
      snapshot.snapshotId = digestParts([repo.id, repo.scope, headOid, baseOid, baseRef, trackedFingerprint.fingerprint, selected,
        allFiles(snapshot).map(file => [file.id, file.fingerprint])])
      const capture: Capture = { snapshot, repo, isolated, objects, views, worktreeEntries, worktree, indexEntries, store, storeState, rawHead, rawBase, baseRequest: baseRef, dispose: () => isolated.dispose() }
      await this.verify(capture, op)
      return capture
    } catch (error) { await isolated.dispose(); throw error }
  }

  private subset(worktree: ContentMap, entries: ObjectEntry[]): ContentMap {
    const selected = new Set(entries.map(entry => entry.path))
    return new Map([...worktree].filter(([name]) => selected.has(name)))
  }

  private tracked(repo: Repository, headOid: string | null, index: ObjectEntry[], worktree: ContentMap, head: ObjectEntry[]): GitTrackedFingerprint {
    return {
      status: headOid ? 'ready' : 'unborn', repositoryId: repo.id, headOid, scope: repo.scope,
      fingerprint: digestParts([repo.id, repo.scope, headOid, entryFingerprint(index), mapFingerprint(this.subset(worktree, [...head, ...index]))]),
      includesUntracked: false, submodules: 'gitlink-only', normalization: 'raw-bytes-no-filters',
    }
  }

  private markKey(snapshot: GitReviewSnapshot, file: GitReviewFile): string {
    return digestParts([snapshot.repositoryId, snapshot.scope, snapshot.headOid, snapshot.base.oid, file.range, file.oldPath, file.newPath])
  }

  private async verify(capture: Capture, op: Operation): Promise<void> {
    if (!capture.isolated || !capture.repo || !capture.objects || !capture.worktree || !capture.worktreeEntries) return
    op.check()
    await capture.isolated.assertIndexUnchanged()
    const currentRepo = await discoverRepository(this.cwd, this.limits, op)
    if (!currentRepo || currentRepo.id !== capture.repo.id || currentRepo.scope !== capture.repo.scope || currentRepo.format !== capture.repo.format || currentRepo.fileMode !== capture.repo.fileMode) throw new GitReviewError('STATE_CHANGED', 'The repository identity changed during capture.', 409)
    const head = await resolveRef(currentRepo, 'HEAD', this.limits, op)
    const base = capture.baseRequest === 'HEAD' ? head : await resolveRef(currentRepo, capture.baseRequest, this.limits, op)
    if (head !== capture.rawHead || base !== capture.rawBase) throw new GitReviewError('STATE_CHANGED', 'The baseline or HEAD changed during capture.', 409)
    const verifier = new GitObjects(capture.isolated)
    const current = await verifier.worktree(capture.worktreeEntries, false)
    if (digestParts(mapFingerprint(current)) !== digestParts(mapFingerprint(capture.worktree))) throw new GitReviewError('STATE_CHANGED', 'Tracked content changed during capture.', 409)
    for (const file of capture.snapshot.ranges.untracked) if (file.selected) {
      op.check()
      const bytes = (await readRegular(diskPath(currentRepo.root, file.path), this.limits.maxFileBytes, true)).bytes
      verifier.account(bytes.length)
      const stat = await fs.lstat(diskPath(currentRepo.root, file.path))
      const mode = stat.mode & 0o111 ? '100755' : '100644'
      if (digestParts([file.path, mode, verifier.objectId('blob', bytes)]) !== file.fingerprint) throw new GitReviewError('STATE_CHANGED', 'Selected untracked content changed during capture.', 409)
    }
  }

  async getSnapshot(options: GitSnapshotOptions = {}): Promise<GitReviewSnapshot> {
    return this.perform(options.signal, async op => {
      const capture = await this.capture(options, op)
      try { return capture.snapshot } finally { await capture.dispose() }
    })
  }

  /** No patch generation, untracked enumeration, or review-store access on the report hot path. */
  async getTrackedFingerprint(options: { signal?: AbortSignal } = {}): Promise<GitTrackedFingerprint> {
    return this.perform(options.signal, async op => {
      const executable = await resolveGit(this.explicitGit)
      if (!executable) return this.unavailable('git_unavailable', 'HEAD').snapshot.trackedFingerprint
      const repo = await discoverRepository(this.cwd, this.limits, op)
      if (!repo) return this.unavailable('not_repository', 'HEAD').snapshot.trackedFingerprint
      const isolated = await IsolatedRepository.create(repo, executable, this.limits, op)
      try {
        const objects = new GitObjects(isolated)
        const rawHead = await resolveRef(repo, 'HEAD', this.limits, op)
        const headOid = rawHead ? await objects.commit(rawHead) : null
        const index = await isolated.index()
        const head: ObjectEntry[] = []
        const entries = index
        const worktree = await objects.worktree(entries, false)
        const fingerprint = this.tracked(repo, headOid, index, worktree, head)
        await isolated.assertIndexUnchanged()
        if (await resolveRef(repo, 'HEAD', this.limits, op) !== rawHead) throw new GitReviewError('STATE_CHANGED', 'HEAD changed during fingerprint capture.', 409)
        const current = await new GitObjects(isolated).worktree(entries, false)
        if (digestParts(mapFingerprint(current)) !== digestParts(mapFingerprint(worktree))) throw new GitReviewError('STATE_CHANGED', 'Tracked content changed during fingerprint capture.', 409)
        return fingerprint
      } finally { await isolated.dispose() }
    })
  }

  private expected(snapshot: GitReviewSnapshot, expected: string): void {
    if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) throw new GitReviewError('INVALID_ARGUMENT', 'expectedSnapshotId is required.')
    if (snapshot.snapshotId !== expected) throw new GitReviewError('STALE_SNAPSHOT', 'Git content or baseline changed; reload the review before continuing.', 409)
    if (!snapshot.repositoryId) throw new GitReviewError('INVALID_ARGUMENT', 'A Git repository is required.')
  }

  async markReviewed(request: GitMarkReviewedRequest): Promise<GitReviewSnapshot> {
    if (typeof request.fileId !== 'string' || typeof request.reviewed !== 'boolean') throw new GitReviewError('INVALID_ARGUMENT', 'A file ID and reviewed boolean are required.')
    return this.perform(request.signal, async op => {
      const capture = await this.capture(request, op)
      try {
        this.expected(capture.snapshot, request.expectedSnapshotId)
        const file = allFiles(capture.snapshot).find(entry => entry.id === request.fileId)
        if (!file) throw new GitReviewError('INVALID_ARGUMENT', 'The selected file is not part of the expected snapshot.')
        if (file.range === 'untracked' && !file.selected) throw new GitReviewError('UNSUPPORTED_FILE', 'Select and read untracked content before marking it reviewed.')
        const expectedStore = request.expectedStoreFingerprint ?? capture.snapshot.storeFingerprint
        const key = this.markKey(capture.snapshot, file)
        const saved = await capture.store!.update(expectedStore, op, async data => {
          await this.verify(capture, op)
          const records = data.records.filter(record => record.key !== key)
          if (request.reviewed) records.push({ key, fingerprint: file.fingerprint })
          return { version: 1, records }
        })
        capture.snapshot.storeFingerprint = saved.fingerprint
        file.reviewed = request.reviewed
        return capture.snapshot
      } finally { await capture.dispose() }
    })
  }

  /** Returns a new snapshot because selecting content strengthens the snapshot's fingerprint. */
  async readUntracked(request: GitReadUntrackedRequest): Promise<GitReviewSnapshot> {
    if (typeof request.path !== 'string') throw new GitReviewError('INVALID_ARGUMENT', 'An untracked path is required.')
    gitPath(request.path)
    return this.perform(request.signal, async op => {
      const previous = await this.capture(request, op)
      try {
        this.expected(previous.snapshot, request.expectedSnapshotId)
        if (!previous.snapshot.ranges.untracked.some(file => file.path === request.path)) throw new GitReviewError('INVALID_ARGUMENT', 'The path is not an untracked file in the expected snapshot.')
        const selectedUntracked = [...new Set([...previous.snapshot.selectedUntracked, request.path])]
        const next = await this.capture({ baseRef: request.baseRef, selectedUntracked }, op)
        try {
          if (next.snapshot.trackedFingerprint.fingerprint !== previous.snapshot.trackedFingerprint.fingerprint || next.snapshot.base.oid !== previous.snapshot.base.oid) throw new GitReviewError('STALE_SNAPSHOT', 'Tracked content changed while selecting an untracked file.', 409)
          return next.snapshot
        } finally { await next.dispose() }
      } finally { await previous.dispose() }
    })
  }

  async exportPatch(request: GitExportPatchRequest): Promise<GitPatchExport> {
    if (!rangeNames.includes(request.range) || !Array.isArray(request.fileIds) || !request.fileIds.length ||
        request.fileIds.length > this.limits.maxFiles || request.fileIds.some(id => typeof id !== 'string') || new Set(request.fileIds).size !== request.fileIds.length) {
      throw new GitReviewError('INVALID_ARGUMENT', 'Choose unique tracked file IDs from exactly one patch range.')
    }
    return this.perform(request.signal, async op => {
      const capture = await this.capture(request, op)
      try {
        this.expected(capture.snapshot, request.expectedSnapshotId)
        const view = capture.views![request.range]
        const files = request.fileIds.map(id => view.files.find(file => file.id === id))
        if (files.some(file => !file)) throw new GitReviewError('INVALID_ARGUMENT', 'Patch selections must belong to the selected snapshot range.')
        if (files.some(file => !file!.exportable || file!.conflict || file!.binary || file!.symlink || file!.submodule || file!.range === 'untracked')) throw new GitReviewError('UNSUPPORTED_FILE', 'Patch export supports tracked ordinary text only; special files are never converted.')
        const paths = [...new Set(files.flatMap(file => [file!.oldPath, file!.newPath]).filter((name): name is string => name !== null))]
        // Even literal pathspecs name directories: a file-to-directory replacement must not pull in unselected children.
        const raw = nulRecords(await capture.objects!.diff(view.oldTree, view.newTree, false, paths))
        const selectedPaths = new Set(paths)
        for (let i = 0; i < raw.length; i++) {
          const header = raw[i]!.toString('ascii')
          if (!/^:\d{6} \d{6} [0-9a-f]+ [0-9a-f]+ [AMDRTU]\d*$/.test(header) || !raw[i + 1]) throw new GitReviewError('GIT_FAILED', 'Malformed selected patch metadata.', 422)
          const names = [utf8(raw[++i]!)]
          if (/ R\d*$/.test(header)) names.push(utf8(raw[++i] ?? Buffer.alloc(0)))
          if (names.some(name => !selectedPaths.has(name))) throw new GitReviewError('UNSUPPORTED_FILE', 'The selected path also contains unselected tracked changes; select the complete change or export it separately.')
        }
        const bytes = await capture.objects!.diff(view.oldTree, view.newTree, true, paths)
        await this.verify(capture, op)
        const patch = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        return { patch, byteLength: bytes.length, filename: `git-review-${request.range}.patch`, snapshotId: capture.snapshot.snapshotId, range: request.range }
      } finally { await capture.dispose() }
    })
  }
}
