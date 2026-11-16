import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KnowledgeStore, KNOWLEDGE_LIMITS, type KnowledgeRevision, type KnowledgeVersionState } from '../src/knowledge/index.js'

const roots: string[] = []
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const metadata = (cwd: string) => path.join(cwd, '.sakura', 'knowledge-versions')
const revision = (state: KnowledgeRevision): KnowledgeRevision => ({ revision: state.revision, fingerprint: state.fingerprint })
const filePath = (cwd: string, source: string) => path.join(cwd, ...source.split('/'))

async function fixture(files = [{ path: 'guide.md', content: 'OriginalCobalt reference' }]) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-knowledge-versions-'))
  roots.push(cwd)
  const store = new KnowledgeStore(cwd)
  const imported = await store.importFiles({ files })
  return { cwd, store, imported, batchId: imported.documents[0]!.id.split('/')[0]! }
}

async function adopted(files?: { path: string; content: string }[]) {
  const value = await fixture(files)
  const state = await value.store.adoptLegacy(value.batchId, await value.store.getVersionState())
  return { ...value, state, collectionId: state.collectionId, versionId: state.versionId }
}

async function publish(store: KnowledgeStore, state: KnowledgeVersionState, collectionId: string, files: { path: string; content: string }[]) {
  const preview = await store.previewUpdate({ collectionId, files }, state)
  return { preview, state: await store.commitUpdate(preview.previewId, preview.expected) }
}

async function entries(directory: string): Promise<string[]> {
  try { return (await fs.readdir(directory, { recursive: true })).map(String).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true })
})

describe('knowledge collections and immutable versions', () => {
  it('does not create metadata on read or auto-adopt imports and preserves old IDs and sources', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-knowledge-versions-empty-'))
    roots.push(cwd)
    const empty = new KnowledgeStore(cwd)
    expect(await empty.getVersionState()).toMatchObject({ revision: 0, fingerprint: digest('missing'), collections: [], legacyBatches: [], errors: [] })
    expect(await fs.readdir(cwd)).toEqual([])
    const { cwd: root, store, imported, batchId } = await fixture()
    const second = await store.importFiles({ files: [{ path: 'guide.md', content: 'UnmanagedAmber reference' }] })
    const before = await store.getVersionState()
    expect(before.collections).toEqual([])
    expect(before.legacyBatches.map(batch => batch.batchId)).toContain(batchId)
    expect(before.unmanagedDocuments).toHaveLength(2)
    expect(await store.listCollections()).toEqual([])
    const oldFile = filePath(root, imported.documents[0]!.source), originalStat = await fs.lstat(oldFile)
    const registered = await store.adoptLegacy(batchId, before)
    expect(registered.revision).toBe(1)
    expect(registered.collections).toHaveLength(1)
    const first = registered.collections[0]!.versions[0]!
    expect(first).toMatchObject({ id: registered.versionId, number: 1, kind: 'legacy', available: true,
      documents: [{ ...imported.documents[0], path: 'guide.md' }] })
    expect(first.id).not.toBe(imported.documents[0]!.version)
    expect((await fs.lstat(oldFile)).ino).toBe(originalStat.ino)
    expect((await store.read(imported.documents[0]!.id, { version: imported.documents[0]!.version })).content).toBe('OriginalCobalt reference')
    expect(registered.unmanagedDocuments.map(document => document.id)).toEqual([second.documents[0]!.id])
    expect((await store.reload()).documents).toHaveLength(2)
    await expect(store.adoptLegacy(batchId, registered)).rejects.toMatchObject({ status: 409 })
    expect(await entries(path.join(metadata(root), 'versions'))).toEqual([])
  })

  it('retains externally supplied legacy paths even when their names resemble version storage', async () => {
    const { cwd, store } = await fixture()
    const directory = path.join(cwd, '.sakura', 'knowledge', 'version_manual-not-managed')
    await fs.mkdir(directory)
    await fs.writeFile(path.join(directory, 'manual.md'), 'LegacyNamedVersionSentinel')
    const before = await store.getVersionState()
    expect(before.unmanagedDocuments.some(document => document.id === 'version_manual-not-managed/manual.md')).toBe(true)
    expect((await store.search('LegacyNamedVersionSentinel')).results).toHaveLength(1)
    const state = await store.adoptLegacy('version_manual-not-managed', before)
    expect(state.collections[0]!.versions[0]!.documents[0]!.id).toBe('version_manual-not-managed/manual.md')
    expect((await new KnowledgeStore(cwd).search('LegacyNamedVersionSentinel')).results).toHaveLength(1)
  })

  it('previews the complete real diff without IO and commits only the active version while old references remain readable', async () => {
    const { cwd, store, state, collectionId, imported } = await adopted([
      { path: 'Manual/guide.md', content: 'OriginalCobalt reference' }, { path: 'same.txt', content: 'unchanged' },
      { path: 'remove.md', content: 'RetiredMagenta reference' },
    ])
    const beforeFiles = await entries(path.join(cwd, '.sakura'))
    const preview = await store.previewUpdate({ collectionId, files: [
      { path: 'Manual/guide.md', content: 'UpdatedEmerald reference' }, { path: 'same.txt', content: 'unchanged' },
      { path: 'new.txt', content: 'AddedSilver reference' },
    ] }, state)
    expect(preview.diff).toEqual({ added: ['new.txt'], removed: ['remove.md'], modified: ['Manual/guide.md'], unchanged: ['same.txt'] })
    expect(preview.baseVersionId).toBe(state.versionId)
    expect(preview.baseContentHash).toBe(state.collections[0]!.versions[0]!.contentHash)
    expect(preview.expected).toEqual(revision(state))
    expect(preview.expiresAt).toBeGreaterThan(Date.now())
    expect(await entries(path.join(cwd, '.sakura'))).toEqual(beforeFiles)
    expect((await store.search('UpdatedEmerald')).results).toEqual([])
    const committed = await store.commitUpdate(preview.previewId, preview.expected)
    expect(committed.revision).toBe(state.revision + 1)
    expect(committed.versionId).toBe(preview.versionId)
    expect(committed.fingerprint).not.toBe(state.fingerprint)
    expect(committed.collections[0]!.versions).toHaveLength(2)
    expect(committed.usage).toMatchObject({ files: 6, versions: 2, collections: 1 })
    const current = committed.collections[0]!.versions[1]!
    expect(current).toMatchObject({ id: preview.versionId, number: 2, kind: 'managed', available: true, contentHash: preview.contentHash })
    const document = current.documents.find(document => document.path === 'Manual/guide.md')!
    expect(document.id).toBe(`${preview.versionId}/Manual/guide.md`)
    expect(document.source).toBe(`.sakura/knowledge-versions/versions/${document.id}`)
    expect(document.version).toBe(digest('UpdatedEmerald reference'))
    expect(await fs.readFile(filePath(cwd, document.source), 'utf8')).toBe('UpdatedEmerald reference')
    expect(store.list().map(document => document.id).sort()).toEqual(current.documents.map(document => document.id).sort())
    expect((await store.search('OriginalCobalt')).results).toEqual([])
    expect((await store.search('RetiredMagenta')).results).toEqual([])
    const hit = (await store.search('UpdatedEmerald')).results[0]!
    expect(hit).toMatchObject({ documentId: document.id, version: document.version, source: `${document.source}#L1-L1` })
    expect((await store.read(imported.documents[0]!.id, { version: imported.documents[0]!.version })).content).toBe('OriginalCobalt reference')
    await expect(store.read(imported.documents[0]!.id, { version: document.version })).rejects.toMatchObject({ status: 409 })
    const restarted = new KnowledgeStore(cwd)
    expect((await restarted.getVersionState()).collections).toEqual(committed.collections)
    expect((await restarted.search('UpdatedEmerald')).results[0]!.documentId).toBe(document.id)
    expect((await restarted.read(imported.documents[2]!.id, { version: imported.documents[2]!.version })).content).toBe('RetiredMagenta reference')
  })

  it('activates exact historical versions without deleting history, permits an empty replacement and advances metadata revision', async () => {
    const { cwd, store, state, collectionId, imported } = await adopted()
    const replacement = await publish(store, state, collectionId, [{ path: 'guide.md', content: 'NextViolet reference' }])
    const historyId = replacement.state.versionId
    const old = await store.activateVersion(collectionId, state.versionId, replacement.state)
    expect(old.revision).toBe(replacement.state.revision + 1)
    expect(old.collections[0]!.activeVersionId).toBe(state.versionId)
    expect(store.list().map(document => document.id)).toEqual([imported.documents[0]!.id])
    expect((await store.search('NextViolet')).results).toEqual([])
    const retained = replacement.state.collections[0]!.versions[1]!.documents[0]!
    expect((await store.read(retained.id, { version: retained.version })).content).toBe('NextViolet reference')
    const empty = await publish(store, old, collectionId, [])
    expect(empty.preview.diff).toEqual({ added: [], removed: ['guide.md'], modified: [], unchanged: [] })
    expect(store.list()).toEqual([])
    expect(empty.state.usage.versions).toBe(3)
    const back = await store.activateVersion(collectionId, historyId, empty.state)
    expect(back.collections[0]!.versions).toHaveLength(3)
    expect((await new KnowledgeStore(cwd).search('NextViolet')).results).toHaveLength(1)
  })
})

describe('knowledge preview capabilities and concurrent confirmation', () => {
  it('cancels with no disk changes, consumes confirmations once and rejects previews after restart', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const before = await entries(path.join(cwd, '.sakura'))
    const input = { collectionId, files: [{ path: 'guide.md', content: 'changed reference' }] }
    const cancelled = await store.previewUpdate(input, state)
    expect(await store.cancelPreview(cancelled.previewId)).toEqual({ cancelled: true })
    expect(await store.cancelPreview(cancelled.previewId)).toEqual({ cancelled: false })
    await expect(store.commitUpdate(cancelled.previewId, cancelled.expected)).rejects.toMatchObject({ status: 409 })
    const lost = await store.previewUpdate(input, state)
    await expect(new KnowledgeStore(cwd).commitUpdate(lost.previewId, lost.expected)).rejects.toMatchObject({ status: 409 })
    expect(await entries(path.join(cwd, '.sakura'))).toEqual(before)
    const result = await store.commitUpdate(lost.previewId, lost.expected)
    await expect(store.commitUpdate(lost.previewId, result)).rejects.toMatchObject({ status: 409 })
    expect(result.collections[0]!.versions).toHaveLength(2)
  })

  it('expires previews, bounds memory and detaches caller-owned payloads/results', async () => {
    const { store, state, collectionId } = await adopted()
    const start = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(start)
    const input = { collectionId, files: [{ path: 'guide.md', content: 'BoundedPearl reference' }] }
    const preview = await store.previewUpdate(input, state)
    input.files[0]!.content = 'forged'
    preview.documents[0]!.version = 'forged'
    preview.expected.revision = 999
    now.mockReturnValue(start + KNOWLEDGE_LIMITS.previewTtlMs)
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/expired/) })
    now.mockRestore()
    const stored = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'BoundedPearl reference' }] }, state)
    stored.documents[0]!.version = 'forged'
    const other = []
    for (let index = 1; index < KNOWLEDGE_LIMITS.maxPreviews; index++) other.push(await store.previewUpdate(input, state))
    await expect(store.previewUpdate(input, state)).rejects.toMatchObject({ status: 413 })
    const committed = await store.commitUpdate(stored.previewId, state)
    expect(committed.collections[0]!.versions[1]!.documents[0]!.version).toBe(digest('BoundedPearl reference'))
    expect(other).toHaveLength(KNOWLEDGE_LIMITS.maxPreviews - 1)
  })

  it('rejects old revision/fingerprint or active-version changes and makes even failed confirmation single-use', async () => {
    const { store, state, collectionId } = await adopted()
    const input = { collectionId, files: [{ path: 'guide.md', content: 'ConflictTopaz reference' }] }
    const preview = await store.previewUpdate(input, state)
    await expect(store.commitUpdate(preview.previewId, { ...state, fingerprint: digest('forged') })).rejects.toMatchObject({ status: 409 })
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 409 })
    const next = await store.previewUpdate(input, state)
    const changed = await store.activateVersion(collectionId, state.versionId, state)
    await expect(store.commitUpdate(next.previewId, state)).rejects.toMatchObject({ status: 409 })
    await expect(store.previewUpdate(input, state)).rejects.toMatchObject({ status: 409 })
    await expect(store.activateVersion(collectionId, state.versionId, state)).rejects.toMatchObject({ status: 409 })
    expect(changed.collections[0]!.versions).toHaveLength(1)
  })

  it('serializes separate store instances and honors an existing on-disk exclusive lock without stealing it', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const other = new KnowledgeStore(cwd), input = { collectionId, files: [{ path: 'guide.md', content: 'ConcurrentQuartz reference' }] }
    const [one, two] = await Promise.all([store.previewUpdate(input, state), other.previewUpdate(input, state)])
    const settled = await Promise.allSettled([store.commitUpdate(one.previewId, state), other.commitUpdate(two.previewId, state)])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(settled.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } })
    const latest = await store.getVersionState()
    expect(latest.collections[0]!.versions).toHaveLength(2)
    const lock = path.join(metadata(cwd), 'store.lock')
    await fs.writeFile(lock, 'another-process-owner', { flag: 'wx' })
    await expect(store.activateVersion(collectionId, state.versionId, latest)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('locked') })
    expect(await fs.readFile(lock, 'utf8')).toBe('another-process-owner')
    await fs.unlink(lock)
  })

  it('does not allow an older asynchronous refresh to overwrite a newly published snapshot', async () => {
    const { store, state, collectionId } = await adopted()
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'PublishedTurquoise reference' }] }, state)
    const started = deferred<void>(), release = deferred<void>()
    const internal = store as unknown as { scan(...args: unknown[]): Promise<unknown> }
    const original = internal.scan.bind(store)
    let intercept = true
    const spy = vi.spyOn(internal, 'scan').mockImplementation(async (...args) => {
      const snapshot = await original(...args)
      if (intercept) { intercept = false; started.resolve(); await release.promise }
      return snapshot
    })
    const pending = store.reload()
    await started.promise
    const committed = await store.commitUpdate(preview.previewId, state)
    release.resolve()
    await pending
    spy.mockRestore()
    expect(store.list().map(document => document.id)).toEqual(committed.collections[0]!.versions[1]!.documents.map(document => document.id))
  })
})

describe('knowledge immutable integrity and publication failures', () => {
  it('rechecks same-size/mtime baseline edits and refuses externally changed historical versions', async () => {
    const { cwd, store, state, collectionId, imported } = await adopted()
    const input = { collectionId, files: [{ path: 'guide.md', content: 'UpdatedCobalt reference' }] }
    const preview = await store.previewUpdate(input, state)
    const oldPath = filePath(cwd, imported.documents[0]!.source), stat = await fs.stat(oldPath)
    await fs.writeFile(oldPath, 'ExternalCobalt reference')
    await fs.utimes(oldPath, stat.atime, stat.mtime)
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 409 })
    expect((await store.search('ExternalCobalt')).results).toEqual([])
    await expect(store.read(imported.documents[0]!.id, { version: imported.documents[0]!.version })).rejects.toMatchObject({ status: 409 })
    const unavailable = await store.getVersionState()
    expect(unavailable.collections[0]!.versions[0]!.available).toBe(false)
    await fs.writeFile(oldPath, 'OriginalCobalt reference')
    const next = await publish(store, state, collectionId, input.files)
    await fs.writeFile(oldPath, 'ExternalCobalt reference')
    await expect(store.activateVersion(collectionId, state.versionId, next.state)).rejects.toMatchObject({ status: 409 })
    expect((await store.search('UpdatedCobalt')).results).toHaveLength(1)
    await fs.writeFile(oldPath, 'OriginalCobalt reference')
    expect((await store.activateVersion(collectionId, state.versionId, next.state)).collections[0]!.activeVersionId).toBe(state.versionId)
  })

  it('does not reclassify a case-renamed adopted legacy directory as unmanaged', async () => {
    const { cwd, store, state, collectionId, batchId } = await adopted()
    const next = await publish(store, state, collectionId, [{ path: 'guide.md', content: 'CurrentDiamond reference' }])
    const old = path.join(cwd, '.sakura', 'knowledge', batchId), intermediate = `${old}-moving`
    await fs.rename(old, intermediate)
    await fs.rename(intermediate, path.join(path.dirname(old), batchId.toUpperCase()))
    const status = await new KnowledgeStore(cwd).getVersionState()
    expect(status.unmanagedDocuments).toEqual([])
    expect(status.legacyBatches).toEqual([])
    expect(status.collections[0]!.versions[0]!.available).toBe(false)
    expect((await store.search('OriginalCobalt')).results).toEqual([])
    expect((await store.search('CurrentDiamond')).results).toHaveLength(1)
    await expect(store.activateVersion(collectionId, state.versionId, next.state)).rejects.toMatchObject({ status: 409 })
  })

  it('detects manifest whitespace/fingerprint edits with an unchanged metadata revision', async () => {
    const { store, state, collectionId } = await adopted()
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'OutdatedUI reference' }] }, state)
    const raw = await fs.readFile(store.manifestFile, 'utf8')
    await fs.writeFile(store.manifestFile, `${raw}\n`)
    const changed = await store.getVersionState()
    expect(changed.revision).toBe(state.revision)
    expect(changed.fingerprint).not.toBe(state.fingerprint)
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 409 })
    expect((await store.search('OutdatedUI')).results).toEqual([])
  })

  it('detects baseline changes during metadata preparation and leaves the pointer untouched', async () => {
    const { cwd, store, state, collectionId, imported } = await adopted()
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'ShouldStayUnpublished reference' }] }, state)
    const raw = await fs.readFile(store.manifestFile, 'utf8'), nativeOpen = fs.open.bind(fs)
    let changed = false
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args)
      if (!changed && String(args[0]).includes('.manifest-')) {
        changed = true
        await fs.writeFile(filePath(cwd, imported.documents[0]!.source), 'TamperedCobalt reference')
      }
      return handle
    }) as typeof fs.open)
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 409 })
    spy.mockRestore()
    expect(changed).toBe(true)
    expect(await fs.readFile(store.manifestFile, 'utf8')).toBe(raw)
    expect((await store.search('ShouldStayUnpublished')).results).toEqual([])
  })

  it('fails closed on a managed document ID colliding with a separate legacy location instead of jumping scopes', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const next = await publish(store, state, collectionId, [{ path: 'guide.md', content: 'ManagedCollisionSentinel' }])
    const document = next.state.collections[0]!.versions[1]!.documents[0]!
    const collision = path.join(cwd, '.sakura', 'knowledge', ...document.id.split('/'))
    await fs.mkdir(path.dirname(collision), { recursive: true })
    await fs.writeFile(collision, 'UnmanagedCollisionSentinel')
    expect((await store.search('ManagedCollisionSentinel')).results).toEqual([])
    expect((await store.search('UnmanagedCollisionSentinel')).results).toEqual([])
    await expect(store.read(document.id, { version: document.version })).rejects.toMatchObject({ status: 409 })
    await expect(store.activateVersion(collectionId, next.state.versionId, next.state)).rejects.toMatchObject({ status: 409 })
  })

  it('does not index unreferenced managed versions, staging data or extra files inside a registered version', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const orphan = path.join(metadata(cwd), 'versions', 'version_00000000-0000-4000-8000-000000000000')
    const staging = path.join(metadata(cwd), 'staging', '.pending_unreferenced')
    await fs.mkdir(orphan, { recursive: true }); await fs.mkdir(staging, { recursive: true })
    await fs.writeFile(path.join(orphan, 'orphan.md'), 'OrphanSecretSentinel')
    await fs.writeFile(path.join(staging, 'staging.md'), 'StagingSecretSentinel')
    let status = await store.getVersionState()
    expect(status.orphans).toHaveLength(2)
    expect(status.usage.files).toBe(3)
    expect((await store.search('OrphanSecretSentinel')).results).toEqual([])
    expect((await store.search('StagingSecretSentinel')).results).toEqual([])
    await expect(store.read('version_00000000-0000-4000-8000-000000000000/orphan.md')).rejects.toMatchObject({ status: 404 })
    const next = await publish(store, state, collectionId, [{ path: 'guide.md', content: 'ActiveLapis reference' }])
    const document = next.state.collections[0]!.versions[1]!.documents[0]!
    await fs.writeFile(path.join(path.dirname(filePath(cwd, document.source)), 'extra.md'), 'UnlistedSecretSentinel')
    status = await new KnowledgeStore(cwd).getVersionState()
    expect(status.collections[0]!.versions[1]!.available).toBe(false)
    expect((await store.search('ActiveLapis')).results).toEqual([])
    expect((await store.search('UnlistedSecretSentinel')).results).toEqual([])
    expect((await store.read(next.state.collections[0]!.versions[0]!.documents[0]!.id)).content).toBe('OriginalCobalt reference')
  })

  it.each(['invalid-json', 'unsupported', 'invalid-path', 'missing', 'oversize', 'hardlink'])(
    'fails closed for %s metadata without searching old versions as unmanaged or exposing private paths', async kind => {
      const { cwd, store, state, collectionId } = await adopted()
      const next = await publish(store, state, collectionId, [{ path: 'guide.md', content: 'CurrentRuby reference' }])
      const raw = await fs.readFile(store.manifestFile, 'utf8')
      if (kind === 'invalid-json') await fs.writeFile(store.manifestFile, '{')
      if (kind === 'unsupported') await fs.writeFile(store.manifestFile, raw.replace('"version":1', '"version":99'))
      if (kind === 'invalid-path') {
        const forged = JSON.parse(raw)
        forged.collections[0].versions[0].directory = '../private'
        await fs.writeFile(store.manifestFile, JSON.stringify(forged))
      }
      if (kind === 'missing') await fs.unlink(store.manifestFile)
      if (kind === 'oversize') await fs.writeFile(store.manifestFile, ' '.repeat(KNOWLEDGE_LIMITS.maxManifestBytes + 1))
      if (kind === 'hardlink') await fs.link(store.manifestFile, path.join(cwd, 'private-metadata-link'))
      const restarted = new KnowledgeStore(cwd), loaded = await restarted.reload()
      expect(loaded.documents).toEqual([])
      expect(loaded.errors.join(' ')).toContain('manifest')
      expect(loaded.errors.join(' ')).not.toContain(cwd)
      expect((await restarted.search('OriginalCobalt')).results).toEqual([])
      expect((await restarted.search('CurrentRuby')).results).toEqual([])
      await expect(restarted.activateVersion(collectionId, next.state.versionId, next.state)).rejects.toMatchObject({ status: 409 })
      await expect(restarted.importFiles({ files: [{ path: 'new.md', content: 'should not write' }] })).rejects.toMatchObject({ status: 409 })
      await expect(restarted.read(next.state.collections[0]!.versions[0]!.documents[0]!.id)).rejects.toMatchObject({ status: 409 })
    },
  )

  it('cleans a failed first adoption and preserves an unmanaged batch if the first pointer rename fails', async () => {
    const { cwd, store, batchId } = await fixture()
    const before = await store.getVersionState(), nativeRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === store.manifestFile) throw new Error(`private failed rename ${cwd}`)
      return nativeRename(from, to)
    })
    await expect(store.adoptLegacy(batchId, before)).rejects.toMatchObject({ status: 500 })
    spy.mockRestore()
    const restarted = new KnowledgeStore(cwd), status = await restarted.getVersionState()
    expect(status).toMatchObject({ revision: 0, collections: [], errors: [] })
    expect(status.legacyBatches.map(batch => batch.batchId)).toContain(batchId)
    expect((await restarted.search('OriginalCobalt')).results).toHaveLength(1)
    expect(await entries(metadata(cwd))).toEqual([])
  })

  it('cleans temporary metadata on sync failure and does not publish a new version', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const raw = await fs.readFile(store.manifestFile, 'utf8')
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'Unsynced reference' }] }, state)
    const nativeOpen = fs.open.bind(fs)
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args)
      if (String(args[0]).includes('.manifest-')) handle.sync = async () => { throw new Error(`private sync failure ${cwd}`) }
      return handle
    }) as typeof fs.open)
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 500 })
    spy.mockRestore()
    expect(await fs.readFile(store.manifestFile, 'utf8')).toBe(raw)
    expect((await entries(metadata(cwd))).some(name => /store\.lock|\.manifest-/.test(name))).toBe(false)
    expect(await entries(path.join(metadata(cwd), 'versions'))).toEqual([])
  })

  it.each(['content', 'manifest'])('keeps the old pointer and active data after a failed %s rename without leaking a filesystem cause', async target => {
    const { cwd, store, state, collectionId } = await adopted()
    const raw = await fs.readFile(store.manifestFile, 'utf8')
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'NeverPublished reference' }] }, state)
    const nativeRename = fs.rename.bind(fs)
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (target === 'manifest' ? String(to) === store.manifestFile : String(to).endsWith(preview.versionId)) {
        throw new Error(`private filesystem failure ${cwd}`)
      }
      return nativeRename(from, to)
    })
    const error = await store.commitUpdate(preview.previewId, state).catch(error => error)
    expect(error).toMatchObject({ status: 500 })
    expect(error.message).not.toContain(cwd)
    expect(error.cause).toBeUndefined()
    spy.mockRestore()
    expect(await fs.readFile(store.manifestFile, 'utf8')).toBe(raw)
    expect((await new KnowledgeStore(cwd).getVersionState()).collections[0]!.activeVersionId).toBe(state.versionId)
    expect((await store.search('NeverPublished')).results).toEqual([])
    expect((await store.search('OriginalCobalt')).results).toHaveLength(1)
    expect(await entries(path.join(metadata(cwd), 'versions'))).toEqual([])
    expect(await entries(path.join(metadata(cwd), 'staging'))).toEqual([])
    expect((await entries(metadata(cwd))).some(name => /store\.lock|\.manifest-/.test(name))).toBe(false)
  })

  it('keeps replaced failed-publication directories as quarantined orphans instead of deleting another owner\'s data', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'QuarantinedOpal reference' }] }, state)
    const raw = await fs.readFile(store.manifestFile, 'utf8'), nativeRename = fs.rename.bind(fs)
    const destination = path.dirname(filePath(cwd, preview.documents[0]!.source))
    let replaced = false
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === store.manifestFile) {
        const backup = path.join(metadata(cwd), 'staging', '.replaced-content')
        await nativeRename(destination, backup)
        await fs.mkdir(destination)
        await fs.writeFile(path.join(destination, 'preserve.txt'), 'ForeignDirectorySentinel')
        replaced = true
        throw new Error('rename failed after a replaced destination')
      }
      return nativeRename(from, to)
    })
    await expect(store.commitUpdate(preview.previewId, state)).rejects.toMatchObject({ status: 500 })
    spy.mockRestore()
    expect(replaced).toBe(true)
    expect(await fs.readFile(store.manifestFile, 'utf8')).toBe(raw)
    expect(await fs.readFile(path.join(destination, 'preserve.txt'), 'utf8')).toBe('ForeignDirectorySentinel')
    const restarted = new KnowledgeStore(cwd), latest = await restarted.getVersionState()
    expect(latest.orphans).toHaveLength(2)
    expect((await restarted.search('ForeignDirectorySentinel')).results).toEqual([])
    expect((await restarted.search('QuarantinedOpal')).results).toEqual([])
    expect((await restarted.search('OriginalCobalt')).results).toHaveLength(1)
  })

  it('publishes contents before the manifest pointer but never exposes them until they are referenced', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const preview = await store.previewUpdate({ collectionId, files: [{ path: 'guide.md', content: 'AtomicJade reference' }] }, state)
    const nativeRename = fs.rename.bind(fs)
    let checked = false
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === store.manifestFile) {
        checked = true
        expect(await fs.readFile(filePath(cwd, preview.documents[0]!.source), 'utf8')).toBe('AtomicJade reference')
        expect((await new KnowledgeStore(cwd).search('AtomicJade')).results).toEqual([])
        expect((await new KnowledgeStore(cwd).search('OriginalCobalt')).results).toHaveLength(1)
      }
      return nativeRename(from, to)
    })
    await store.commitUpdate(preview.previewId, state)
    spy.mockRestore()
    expect(checked).toBe(true)
    expect((await store.search('AtomicJade')).results).toHaveLength(1)
  })

  it('checks workspace assertions before IO and throughout reads, writes and final pointer publication', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const input = { collectionId, files: [{ path: 'guide.md', content: 'GuardedGarnet reference' }] }, stale = new Error('workspace epoch changed')
    const lstat = vi.spyOn(fs, 'lstat')
    await expect(store.previewUpdate(input, state, () => { throw stale })).rejects.toBe(stale)
    expect(lstat).not.toHaveBeenCalled()
    lstat.mockRestore()
    const preview = await store.previewUpdate(input, state)
    const raw = await fs.readFile(store.manifestFile, 'utf8'), nativeOpen = fs.open.bind(fs)
    let manifestWritten = false
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args)
      if (String(args[0]).includes('.manifest-')) manifestWritten = true
      return handle
    }) as typeof fs.open)
    await expect(store.commitUpdate(preview.previewId, state, () => { if (manifestWritten) throw stale })).rejects.toBe(stale)
    spy.mockRestore()
    expect(await fs.readFile(store.manifestFile, 'utf8')).toBe(raw)
    expect((await entries(metadata(cwd))).some(name => /store\.lock|\.manifest-/.test(name))).toBe(false)
    expect(await entries(path.join(metadata(cwd), 'versions'))).toEqual([])
  })
})

describe('knowledge history capacity and safe paths', () => {
  it('counts retained files and bytes, even if historical content was deleted, and never auto-prunes', async () => {
    const { cwd, store, state, collectionId, imported } = await adopted(Array.from({ length: 64 }, (_, index) => ({ path: `${index}.md`, content: 'old' })))
    const next = await publish(store, state, collectionId, Array.from({ length: 64 }, (_, index) => ({ path: `${index}.md`, content: 'new' })))
    expect(next.state.usage.files).toBe(KNOWLEDGE_LIMITS.maxFiles)
    await expect(store.previewUpdate({ collectionId, files: [{ path: 'extra.md', content: 'more' }] }, next.state)).rejects.toMatchObject({ status: 413 })
    await fs.unlink(filePath(cwd, imported.documents[0]!.source))
    const damaged = await store.getVersionState()
    expect(damaged.usage.files).toBe(KNOWLEDGE_LIMITS.maxFiles)
    await expect(store.importFiles({ files: [{ path: 'extra.md', content: 'more' }] })).rejects.toMatchObject({ status: 413 })
    expect(damaged.collections[0]!.versions).toHaveLength(2)
  })

  it('counts historical byte quota against replacement content and bounds all versions, including empty ones', async () => {
    const bytes = await adopted(Array.from({ length: 8 }, (_, index) => ({ path: `${index}.txt`, content: 'x'.repeat(KNOWLEDGE_LIMITS.maxFileBytes) })))
    await expect(bytes.store.previewUpdate({ collectionId: bytes.collectionId, files: Array.from({ length: 9 }, (_, index) => ({
      path: `${index}.txt`, content: 'y'.repeat(KNOWLEDGE_LIMITS.maxFileBytes),
    })) }, bytes.state)).rejects.toMatchObject({ status: 413 })
    const { store, state, collectionId } = await adopted()
    let latest: KnowledgeVersionState = state
    for (let count = 1; count < KNOWLEDGE_LIMITS.maxVersions; count++) latest = (await publish(store, latest, collectionId, [])).state
    expect(latest.usage.versions).toBe(KNOWLEDGE_LIMITS.maxVersions)
    await expect(store.previewUpdate({ collectionId, files: [] }, latest)).rejects.toMatchObject({ status: 413 })
    expect((await store.getVersionState()).collections[0]!.versions).toHaveLength(KNOWLEDGE_LIMITS.maxVersions)
  }, 60_000)

  it.each(['../escape.md', 'C:alias.md', 'NUL.txt', 'nested/COM¹.md', 'name.txt ', 'name.md:stream', '\\\\server\\share\\file.md',
    'a/b/c/d/e/f/g/h/i.md', 'folder/../file.md', 'script.js'])(
    'rejects unsafe replacement path %j without changing disk', async unsafe => {
      const { cwd, store, state, collectionId } = await adopted()
      const before = await entries(metadata(cwd))
      await expect(store.previewUpdate({ collectionId, files: [{ path: unsafe, content: 'invalid' }] }, state)).rejects.toMatchObject({ status: 400 })
      expect(await entries(metadata(cwd))).toEqual(before)
    },
  )

  it('includes the longer immutable version prefix in the document ID byte budget', async () => {
    const { store, state, collectionId } = await adopted()
    const prefix = Array.from({ length: 7 }, () => 'a'.repeat(120)).join('/')
    const tooLong = `${prefix}/${'b'.repeat(130)}.md`
    expect(Buffer.byteLength(tooLong)).toBe(980)
    await expect(store.previewUpdate({ collectionId, files: [{ path: tooLong, content: 'bounded' }] }, state)).rejects.toMatchObject({ status: 400 })
    const valid = `${prefix}/${'b'.repeat(129)}.md`
    const preview = await store.previewUpdate({ collectionId, files: [{ path: valid, content: 'bounded' }] }, state)
    expect(Buffer.byteLength(preview.documents[0]!.id)).toBe(1024)
    await store.cancelPreview(preview.previewId)
  })

  it('rejects aliases, conflicting paths and invalid text in replacement payloads', async () => {
    const { store, state, collectionId } = await adopted()
    for (const paths of [['a.md', 'A.md'], ['folder/a.md', 'Folder/b.md'], ['tree.md', 'tree.md/child.txt'], ['é.md', 'é.md']]) {
      await expect(store.previewUpdate({ collectionId, files: paths.map(path => ({ path, content: 'x' })) }, state)).rejects.toMatchObject({ status: 409 })
    }
    await expect(store.previewUpdate({ collectionId, files: [{ path: 'valid.md', content: '\u0000bad' }] }, state)).rejects.toMatchObject({ status: 400 })
  })

  it('rejects hardlinked legacy and managed text without exposing external content', async () => {
    const { cwd, store, batchId, imported } = await fixture()
    const outside = path.join(cwd, 'private-reference.txt')
    await fs.link(filePath(cwd, imported.documents[0]!.source), outside)
    const before = await store.getVersionState()
    expect(before.legacyBatches[0]!.available).toBe(false)
    await expect(store.adoptLegacy(batchId, before)).rejects.toMatchObject({ status: 409 })
    await fs.unlink(outside)
    const state = await store.adoptLegacy(batchId, before)
    const next = await publish(store, state, state.collectionId, [{ path: 'guide.md', content: 'LinkGuardOnyx reference' }])
    await fs.link(filePath(cwd, next.state.collections[0]!.versions[1]!.documents[0]!.source), outside)
    expect((await store.search('LinkGuardOnyx')).results).toEqual([])
    await expect(store.activateVersion(state.collectionId, next.state.versionId, next.state)).rejects.toMatchObject({ status: 409 })
  })

  it('rejects metadata and ancestor directory junctions without writing or reading another workspace', async () => {
    const { cwd, store, state, collectionId } = await adopted()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-knowledge-versions-outside-'))
    roots.push(outside)
    await fs.writeFile(path.join(outside, 'private.md'), 'ExternalPrivateSentinel')
    const backup = `${metadata(cwd)}-backup`
    await fs.rename(metadata(cwd), backup)
    try { await fs.symlink(outside, metadata(cwd), process.platform === 'win32' ? 'junction' : 'dir') }
    catch (error) {
      await fs.rename(backup, metadata(cwd))
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    expect((await store.reload()).documents).toEqual([])
    await expect(store.activateVersion(collectionId, state.versionId, state)).rejects.toMatchObject({ status: 400 })
    expect(await fs.readdir(outside)).toEqual(['private.md'])
    await fs.rm(metadata(cwd), { recursive: true, force: true })
    await fs.rename(backup, metadata(cwd))
    const alias = path.join(outside, 'workspace-alias')
    await fs.symlink(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const linked = new KnowledgeStore(alias)
    expect((await linked.reload()).documents).toEqual([])
    await expect(linked.importFiles({ files: [{ path: 'escape.md', content: 'no write' }] })).rejects.toMatchObject({ status: 400 })
  })
})
