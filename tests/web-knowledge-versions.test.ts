/** Real loopback REST requests only; temporary workspaces, synthetic credentials and an unused offline model. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelAdapter } from '../src/core/index.js'
import { runWebServer } from '../src/web/server.js'
import { KnowledgeStore, type KnowledgeDocument, type KnowledgeHit, type KnowledgeRead,
  type KnowledgeRevision, type KnowledgeUpdatePreview, type KnowledgeVersionMutation, type KnowledgeVersionState } from '../src/knowledge/index.js'

const operator = 'OFFLINE_KNOWLEDGE_OPERATOR_NOT_REAL_0123456789'
const viewer = 'OFFLINE_KNOWLEDGE_VIEWER_NOT_REAL_012345678901'
const route = '/api/knowledge/versions'
const nativeFetch = globalThis.fetch
const cleanups: Array<() => Promise<void>> = []
const roots: string[] = []
let forbiddenRequests: string[] = []
let modelRequests = 0

type State = KnowledgeVersionState & { workspaceId: string }
type Mutation = KnowledgeVersionMutation & { workspaceId: string }
type Preview = KnowledgeUpdatePreview & { workspaceId: string }
type Imported = { imported: number; documents: KnowledgeDocument[]; workspaceId: string }
type Reply<T> = { status: number; body: T; headers: Headers }
type RequestOptions = { workspace?: string | null; token?: string | null; cookie?: string }
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const expected = (state: KnowledgeRevision) => ({ revision: state.revision, fingerprint: state.fingerprint, confirmed: true })
const query = (url: string, values: Record<string, string>) => `${url}?${new URLSearchParams(values)}`
const originalText = 'OriginalCobaltReference from imported legacy text'
const updatedText = 'UpdatedEmeraldReference from immutable current text'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function temporaryWorkspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-knowledge-versions-'))
  roots.push(cwd)
  return cwd
}

beforeEach(() => {
  forbiddenRequests = []
  modelRequests = 0
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  vi.stubGlobal('fetch', ((input, init) => {
    const raw = input instanceof Request ? input.url : String(input), url = new URL(raw)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      forbiddenRequests.push(raw)
      throw new Error('External network forbidden in knowledge versions REST tests')
    }
    return nativeFetch(input, { ...init, redirect: 'error' })
  }) as typeof fetch)
})

afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!()
    vi.restoreAllMocks()
    while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true })
    expect(forbiddenRequests).toEqual([])
    expect(modelRequests, 'knowledge version API operations never call a provider').toBe(0)
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

async function fixture(options: { remote?: boolean } = {}) {
  const cwd = await temporaryWorkspace()
  const adapter: ModelAdapter = {
    id: 'knowledge-offline-fixture', defaultModel: 'offline',
    async *stream() { modelRequests++; yield { type: 'done' as const, reason: 'stop' as const } },
  }
  const web = await runWebServer({ cwd, adapter, host: options.remote ? '0.0.0.0' : '127.0.0.1', port: 0,
    token: operator, viewerToken: viewer, quiet: true, open: false, updatesAutoCheck: false, approvalMode: 'yolo',
    onPersistSettings: () => {},
    config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { config: { auto: 0, autoTokens: 0 } },
      'core-skills': { disabled: true }, 'core-agent-defs': { disabled: true } } },
  })
  cleanups.push(() => web.close())
  const base = `http://127.0.0.1:${web.port}`
  let workspaceId = ''
  async function rest<T = { error: string }>(url: string, body?: unknown, opts: RequestOptions = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' }
    if (opts.cookie) headers.cookie = opts.cookie
    else if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? operator}`
    const workspace = opts.workspace === undefined ? workspaceId : opts.workspace
    if (workspace) headers['x-sakura-workspace'] = workspace
    const response = await fetch(base + url, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) })
    return { status: response.status, body: await response.json() as T, headers: response.headers }
  }
  async function refreshWorkspace() {
    const reply = await rest<{ workspaceId: string; cwd: string }>('/api/state', undefined, { workspace: null })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    workspaceId = reply.body.workspaceId
    return reply.body
  }
  await refreshWorkspace()
  const store = web.harness.ctx.get<KnowledgeStore>('knowledge')
  async function versions() {
    const reply = await rest<State>(route)
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return reply.body
  }
  async function preview(state: State | Mutation, collectionId: string, content = updatedText) {
    const reply = await rest<Preview>(`${route}/preview`, { ...expected(state), collectionId, files: [{ path: 'guide.md', content }] })
    expect(reply.status, JSON.stringify(reply.body)).toBe(200)
    return reply.body
  }
  return { cwd, web, rest, store, versions, preview, refreshWorkspace, workspace: () => workspaceId }
}

async function adopted() {
  const f = await fixture()
  const imported = await f.rest<Imported>('/api/knowledge/import', { files: [{ path: 'guide.md', content: originalText }] })
  expect(imported.status, JSON.stringify(imported.body)).toBe(200)
  const state = await f.versions(), batchId = imported.body.documents[0]!.id.split('/')[0]!
  const adopted = await f.rest<Mutation>(`${route}/adopt`, { ...expected(state), batchId })
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200)
  return { ...f, imported: imported.body, batchId, state: adopted.body, collectionId: adopted.body.collectionId }
}

describe('operator-only knowledge version REST lifecycle', () => {
  it('imports legacy data, adopts explicitly, previews/commits, searches active versions, reads exact history and activates v1', async () => {
    const f = await fixture()
    const imported = await f.rest<Imported>('/api/knowledge/import', { files: [
      { path: 'Manual/guide.md', content: originalText }, { path: 'retire.txt', content: 'RetiredMagentaReference' },
    ] })
    expect(imported.status, JSON.stringify(imported.body)).toBe(200)
    const unmanaged = await f.rest<Imported>('/api/knowledge/import', { files: [{ path: 'guide.md', content: 'UnmanagedAmberReference' }] })
    expect(unmanaged.status).toBe(200)
    const state = await f.versions(), batchId = imported.body.documents[0]!.id.split('/')[0]!
    expect(state).toMatchObject({ revision: 0, collections: [], errors: [], workspaceId: f.workspace() })
    expect(state.legacyBatches).toHaveLength(2)
    expect(state.unmanagedDocuments).toHaveLength(3)
    const adopted = await f.rest<Mutation>(`${route}/adopt`, { ...expected(state), batchId })
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200)
    expect(adopted.body).toMatchObject({ revision: 1, workspaceId: f.workspace() })
    expect(adopted.body.collections[0]!.versions[0]!.documents[0]!.id).toBe(imported.body.documents[0]!.id)
    const { collectionId, versionId: legacyVersionId } = adopted.body
    const rawBefore = await fs.readFile(f.store.manifestFile, 'utf8')
    const previewed = await f.rest<Preview>(`${route}/preview`, { ...expected(adopted.body), collectionId, files: [
      { path: 'Manual/guide.md', content: updatedText }, { path: 'new.txt', content: 'AddedSilverReference' },
    ] })
    expect(previewed.status, JSON.stringify(previewed.body)).toBe(200)
    expect(previewed.body).toMatchObject({ workspaceId: f.workspace(), baseVersionId: legacyVersionId,
      diff: { added: ['new.txt'], removed: ['retire.txt'], modified: ['Manual/guide.md'], unchanged: [] } })
    expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(rawBefore)
    const preview = previewed.body
    const committed = await f.rest<Mutation>(`${route}/commit`, { ...expected(adopted.body), previewId: preview.previewId })
    expect(committed.status, JSON.stringify(committed.body)).toBe(200)
    expect(committed.body).toMatchObject({ versionId: preview.versionId, revision: 2, workspaceId: f.workspace() })
    expect(committed.body.collections[0]!.versions).toHaveLength(2)
    const current = committed.body.collections[0]!.versions[1]!.documents.find(document => document.path === 'Manual/guide.md')!
    expect(current.version).toBe(digest(updatedText))
    expect(current.version).not.toBe(committed.body.versionId)
    const listed = await f.rest<{ documents: KnowledgeDocument[]; workspaceId: string }>('/api/knowledge')
    expect(listed.status).toBe(200)
    expect(listed.body.documents).toHaveLength(3)
    expect(listed.body.documents.some(document => document.id === imported.body.documents[0]!.id)).toBe(false)
    const search = await f.rest<{ results: KnowledgeHit[]; workspaceId: string }>('/api/knowledge/search?q=UpdatedEmeraldReference')
    expect(search.status).toBe(200)
    expect(search.body.results[0]).toMatchObject({ documentId: current.id, version: current.version, source: `${current.source}#L1-L1` })
    for (const term of ['OriginalCobaltReference', 'RetiredMagentaReference']) {
      expect((await f.rest<{ results: KnowledgeHit[] }>(`/api/knowledge/search?q=${term}`)).body.results).toEqual([])
    }
    expect((await f.rest<{ results: KnowledgeHit[] }>('/api/knowledge/search?q=UnmanagedAmberReference')).body.results).toHaveLength(1)
    const old = imported.body.documents[0]!
    const historic = await f.rest<KnowledgeRead>(query('/api/knowledge/read', { id: old.id, version: old.version }))
    expect(historic.status, JSON.stringify(historic.body)).toBe(200)
    expect(historic.body).toMatchObject({ id: old.id, version: old.version, content: originalText, source: old.source })
    expect((await f.rest(query('/api/knowledge/read', { id: old.id, version: current.version }))).status).toBe(409)
    const active = await f.rest<Mutation>(`${route}/activate`, { ...expected(committed.body), collectionId, versionId: legacyVersionId })
    expect(active.status, JSON.stringify(active.body)).toBe(200)
    expect(active.body).toMatchObject({ revision: 3, versionId: legacyVersionId, workspaceId: f.workspace() })
    expect(active.body.collections[0]!.versions).toHaveLength(2)
    expect((await f.rest<{ results: KnowledgeHit[] }>('/api/knowledge/search?q=UpdatedEmeraldReference')).body.results).toEqual([])
    expect((await f.rest<{ results: KnowledgeHit[] }>('/api/knowledge/search?q=OriginalCobaltReference')).body.results).toHaveLength(1)
    expect((await f.rest<KnowledgeRead>(query('/api/knowledge/read', { id: current.id, version: current.version }))).body.content).toBe(updatedText)
    expect(JSON.stringify(await f.versions())).not.toContain(f.cwd)
  }, 30_000)

  it('cancels previews without writes, requires confirmation and consumes a successful preview once', async () => {
    const f = await adopted(), raw = await fs.readFile(f.store.manifestFile, 'utf8')
    const preview = await f.preview(f.state, f.collectionId)
    const body = { ...expected(f.state), previewId: preview.previewId }
    expect((await f.rest(`${route}/cancel`, { ...body, confirmed: false })).status).toBe(400)
    expect((await f.rest(`${route}/cancel`, body)).body).toMatchObject({ cancelled: true, workspaceId: f.workspace() })
    expect((await f.rest(`${route}/cancel`, body)).body).toMatchObject({ cancelled: false })
    expect((await f.rest(`${route}/commit`, body)).status).toBe(409)
    expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(raw)
    const valid = await f.preview(f.state, f.collectionId)
    const confirmation = { ...expected(f.state), previewId: valid.previewId }
    expect((await f.rest(`${route}/commit`, { ...confirmation, confirmed: undefined })).status).toBe(400)
    expect((await f.rest(`${route}/commit`, confirmation)).status).toBe(200)
    expect((await f.rest(`${route}/commit`, confirmation)).status).toBe(409)
    expect((await f.versions()).collections[0]!.versions).toHaveLength(2)
  })

  it('rejects wrong fingerprints and stale metadata with no write, then requires a fresh preview', async () => {
    const f = await adopted(), raw = await fs.readFile(f.store.manifestFile, 'utf8')
    const wrong = { ...expected(f.state), fingerprint: 'f'.repeat(64) }
    expect((await f.rest(`${route}/preview`, { ...wrong, collectionId: f.collectionId, files: [] })).status).toBe(409)
    expect((await f.rest(`${route}/activate`, { ...wrong, collectionId: f.collectionId, versionId: f.state.versionId })).status).toBe(409)
    const preview = await f.preview(f.state, f.collectionId)
    expect((await f.rest(`${route}/commit`, { ...wrong, previewId: preview.previewId })).status).toBe(409)
    expect((await f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId })).status).toBe(409)
    expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(raw)
    const another = await f.preview(f.state, f.collectionId)
    const activated = await f.rest<Mutation>(`${route}/activate`, { ...expected(f.state), collectionId: f.collectionId, versionId: f.state.versionId })
    expect(activated.status).toBe(200)
    expect((await f.rest(`${route}/commit`, { ...expected(f.state), previewId: another.previewId })).status).toBe(409)
    const refreshed = await f.versions(), fresh = await f.preview(refreshed, f.collectionId)
    expect((await f.rest(`${route}/commit`, { ...expected(refreshed), previewId: fresh.previewId })).status).toBe(200)
  })

  it('returns client errors for malformed runtime IDs/revisions/file sets without touching valid previews', async () => {
    const f = await adopted(), raw = await fs.readFile(f.store.manifestFile, 'utf8')
    const preview = await f.preview(f.state, f.collectionId)
    for (const invalid of [undefined, null, 42, true, [], {}, '', '../private', 'preview_wrong']) {
      for (const action of ['commit', 'cancel']) {
        const reply = await f.rest(`${route}/${action}`, { ...expected(f.state), previewId: invalid })
        expect(reply.status, `${action} ${JSON.stringify(invalid)} ${JSON.stringify(reply.body)}`).toBe(400)
        expect(JSON.stringify(reply.body)).not.toContain(f.cwd)
      }
    }
    for (const invalid of [undefined, null, 42, false, [], {}, '', '../private', '/absolute']) {
      expect((await f.rest(`${route}/adopt`, { ...expected(f.state), batchId: invalid })).status).toBe(400)
    }
    for (const invalid of [undefined, null, 42, false, [], {}, '', '../private']) {
      expect((await f.rest(`${route}/preview`, { ...expected(f.state), collectionId: invalid, files: [] })).status).toBe(400)
      expect((await f.rest(`${route}/activate`, { ...expected(f.state), collectionId: f.collectionId, versionId: invalid })).status).toBe(400)
    }
    for (const invalid of [undefined, null, 'files', {}, [null], [{ path: 'valid.md', content: 12 }]]) {
      expect((await f.rest(`${route}/preview`, { ...expected(f.state), collectionId: f.collectionId, files: invalid })).status).toBe(400)
    }
    for (const invalid of [{ revision: '1' }, { revision: -1 }, { revision: 1.2 }, { fingerprint: null }, { fingerprint: 'wrong' }]) {
      expect((await f.rest(`${route}/preview`, { ...expected(f.state), ...invalid, collectionId: f.collectionId, files: [] })).status).toBe(400)
    }
    expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(raw)
    expect((await f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId })).status).toBe(200)
  }, 30_000)
})

describe('knowledge version API authorization and workspace fences', () => {
  it('requires the exact workspace header for GET and every mutation before entering the store', async () => {
    const f = await adopted(), preview = await f.preview(f.state, f.collectionId)
    const body = { ...expected(f.state), batchId: f.batchId, previewId: preview.previewId, collectionId: f.collectionId,
      versionId: f.state.versionId, files: [] }
    const spies = [vi.spyOn(f.store, 'getVersionState'), vi.spyOn(f.store, 'adoptLegacy'), vi.spyOn(f.store, 'previewUpdate'),
      vi.spyOn(f.store, 'commitUpdate'), vi.spyOn(f.store, 'activateVersion'), vi.spyOn(f.store, 'cancelPreview')]
    for (const workspace of [null, 'wrong-workspace']) {
      expect((await f.rest(route, undefined, { workspace })).status).toBe(409)
      for (const action of ['adopt', 'preview', 'commit', 'activate', 'cancel']) {
        expect((await f.rest(`${route}/${action}`, body, { workspace })).status).toBe(409)
      }
    }
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore() }
    expect((await f.rest(`${route}/commit`, body)).status).toBe(200)
  })

  it('denies unauthenticated clients, local viewers and remote operators/viewers without revealing metadata', async () => {
    const local = await adopted()
    const remote = await fixture({ remote: true })
    const body = { ...expected(local.state), collectionId: local.collectionId, batchId: local.batchId,
      versionId: local.state.versionId, previewId: 'preview_00000000-0000-4000-8000-000000000000', files: [] }
    for (const token of [null, viewer]) {
      expect((await local.rest(route, undefined, { token })).status).toBe(token === null ? 401 : 404)
      for (const action of ['adopt', 'preview', 'commit', 'activate', 'cancel']) {
        const response = await local.rest(`${route}/${action}`, body, { token })
        expect(response.status).toBe(token === null ? 401 : 403)
        expect(JSON.stringify(response.body)).not.toContain(local.collectionId)
        expect(JSON.stringify(response.body)).not.toContain(local.cwd)
      }
    }
    for (const token of [operator, viewer]) {
      expect((await remote.rest(route, undefined, { token })).status).toBe(404)
      for (const action of ['adopt', 'preview', 'commit', 'activate', 'cancel']) {
        expect((await remote.rest(`${route}/${action}`, body, { token })).status).toBe(token === operator ? 404 : 403)
      }
    }
    expect((await local.versions()).collections[0]!.versions).toHaveLength(1)
    await expect(fs.lstat(path.join(remote.cwd, '.sakura', 'knowledge-versions'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['state', 'preview'] as const)('drops a delayed %s response after a workspace remount instead of exposing old metadata', async action => {
    const f = await adopted(), oldWorkspace = f.workspace(), oldMount = f.web.harness.ctx
    const entered = gate(), release = gate(), other = await temporaryWorkspace()
    const state = await f.store.getVersionState()
    const preview = await f.store.previewUpdate({ collectionId: f.collectionId, files: [{ path: 'guide.md', content: updatedText }] }, f.state)
    const spy = action === 'state' ? vi.spyOn(f.store, 'getVersionState').mockImplementationOnce(async () => {
      entered.release(); await release.promise; return state
    }) : vi.spyOn(f.store, 'previewUpdate').mockImplementationOnce(async () => {
      entered.release(); await release.promise; return preview
    })
    const pending = action === 'state' ? f.rest(route) : f.rest(`${route}/preview`, {
      ...expected(f.state), collectionId: f.collectionId, files: [{ path: 'guide.md', content: updatedText }],
    })
    try {
      await entered.promise
      const switched = await f.rest('/api/desktop/settings', { workspace: other })
      expect(switched.status, JSON.stringify(switched.body)).toBe(200)
      expect(f.web.harness.ctx).not.toBe(oldMount)
      release.release()
      const late = await pending
      expect(late.status, JSON.stringify(late.body)).toBe(503)
      expect(JSON.stringify(late.body)).not.toContain(f.collectionId)
      expect(JSON.stringify(late.body)).not.toContain(preview.previewId)
      spy.mockRestore()
      const current = await f.refreshWorkspace()
      expect(current.cwd).toBe(other)
      expect(current.workspaceId).not.toBe(oldWorkspace)
      expect((await f.versions()).collections).toEqual([])
      expect((await f.rest(route, undefined, { workspace: oldWorkspace })).status).toBe(409)
      expect((await f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId })).status).toBe(409)
      expect((await new KnowledgeStore(f.cwd).getVersionState()).collections[0]!.versions).toHaveLength(1)
    } finally { release.release(); await pending.catch(() => {}); spy.mockRestore() }
  }, 30_000)

  it('aborts a commit during disk IO after switching workspaces and preserves both manifests', async () => {
    const f = await adopted(), preview = await f.preview(f.state, f.collectionId)
    const raw = await fs.readFile(f.store.manifestFile, 'utf8'), entered = gate(), release = gate(), other = await temporaryWorkspace()
    const nativeOpen = fs.open.bind(fs)
    let held = false
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args)
      if (!held && String(args[0]).startsWith(path.dirname(f.store.manifestFile)) && String(args[0]).includes('.manifest-')) {
        held = true; entered.release(); await release.promise
      }
      return handle
    }) as typeof fs.open)
    const pending = f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId })
    try {
      await entered.promise
      expect((await f.rest('/api/desktop/settings', { workspace: other })).status).toBe(200)
      release.release()
      const late = await pending
      expect(late.status, JSON.stringify(late.body)).toBe(503)
      spy.mockRestore()
      expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(raw)
      await f.refreshWorkspace()
      expect((await f.versions()).collections).toEqual([])
      expect((await fs.readdir(path.dirname(f.store.manifestFile))).some(name => /store\.lock|\.manifest-/.test(name))).toBe(false)
      expect((await new KnowledgeStore(f.cwd).search('UpdatedEmeraldReference')).results).toEqual([])
    } finally { release.release(); await pending.catch(() => {}); spy.mockRestore() }
  }, 30_000)

  it.each(['state', 'preview'] as const)('drops a delayed %s response after the browser logs out', async action => {
    const f = await adopted()
    const loggedIn = await f.rest<{ ok: boolean }>('/api/auth/login', { token: operator }, { token: null })
    expect(loggedIn.status).toBe(200)
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0]!
    const state = await f.store.getVersionState()
    const preview = await f.store.previewUpdate({ collectionId: f.collectionId, files: [] }, f.state)
    const entered = gate(), release = gate()
    const spy = action === 'state' ? vi.spyOn(f.store, 'getVersionState').mockImplementationOnce(async () => {
      entered.release(); await release.promise; return state
    }) : vi.spyOn(f.store, 'previewUpdate').mockImplementationOnce(async () => {
      entered.release(); await release.promise; return preview
    })
    const pending = action === 'state' ? f.rest(route, undefined, { cookie }) :
      f.rest(`${route}/preview`, { ...expected(f.state), collectionId: f.collectionId, files: [] }, { cookie })
    try {
      await entered.promise
      expect((await f.rest('/api/auth/logout', {}, { cookie })).status).toBe(200)
      release.release()
      const late = await pending
      expect(late.status, JSON.stringify(late.body)).toBe(409)
      expect(JSON.stringify(late.body)).not.toContain(f.collectionId)
      expect(JSON.stringify(late.body)).not.toContain(preview.previewId)
      spy.mockRestore()
      expect((await f.rest(route, undefined, { cookie })).status).toBe(401)
      expect((await f.versions()).collections[0]!.versions).toHaveLength(1)
    } finally { release.release(); await pending.catch(() => {}); spy.mockRestore() }
  })

  it('rechecks browser authorization during commit IO and never publishes after logout', async () => {
    const f = await adopted(), preview = await f.preview(f.state, f.collectionId)
    const loggedIn = await f.rest('/api/auth/login', { token: operator }, { token: null })
    const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0]!
    const raw = await fs.readFile(f.store.manifestFile, 'utf8'), nativeOpen = fs.open.bind(fs), entered = gate(), release = gate()
    let held = false
    const spy = vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      const handle = await nativeOpen(...args)
      if (!held && String(args[0]).startsWith(path.dirname(f.store.manifestFile)) && String(args[0]).includes('.manifest-')) {
        held = true; entered.release(); await release.promise
      }
      return handle
    }) as typeof fs.open)
    const pending = f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId }, { cookie })
    try {
      await entered.promise
      expect((await f.rest('/api/auth/logout', {}, { cookie })).status).toBe(200)
      release.release()
      const rejected = await pending
      expect(rejected.status, JSON.stringify(rejected.body)).toBe(409)
      spy.mockRestore()
      expect(await fs.readFile(f.store.manifestFile, 'utf8')).toBe(raw)
      expect((await f.rest(route, undefined, { cookie })).status).toBe(401)
      expect((await f.rest(`${route}/commit`, { ...expected(f.state), previewId: preview.previewId })).status).toBe(409)
      expect((await f.versions()).collections[0]!.versions).toHaveLength(1)
      expect((await fs.readdir(path.join(path.dirname(f.store.manifestFile), 'versions')))).toEqual([])
    } finally { release.release(); await pending.catch(() => {}); spy.mockRestore() }
  })
})
