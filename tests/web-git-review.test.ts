import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitReviewService, type GitPatchExport, type GitReviewSnapshot, type GitSnapshotOptions } from '../src/git/index.js'
import { resolveGit } from '../src/git/process.js'
import { runWebServer, type DesktopSettingsState, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const OPERATOR = 'offline-git-review-operator-not-a-real-credential-000001'
const VIEWER = 'offline-git-review-viewer-not-a-real-credential-00000002'
const nativeFetch = globalThis.fetch
const cleanups: Array<() => Promise<unknown>> = []
let blockedFetches: string[] = []

type WebSnapshot = GitReviewSnapshot & { workspaceId: string }
type WebState = { workspaceId: string; cwd: string }

beforeEach(() => {
  blockedFetches = []
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SAKURA_API_KEY']) vi.stubEnv(name, 'offline-fake-key-not-a-credential')
  vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1')
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      blockedFetches.push(raw)
      throw new Error(`External network is forbidden in offline Git API tests: ${raw}`)
    }
    return nativeFetch(input, { ...init, redirect: 'error' })
  }) satisfies typeof fetch)
})

afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!()
    expect(blockedFetches, 'the server must not attempt external network requests').toEqual([])
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})

async function git(cwd: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  const executable = await resolveGit()
  if (!executable) throw new Error('A trusted local Git executable is required; do not skip this integration test.')
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  Object.assign(env, { HOME: path.dirname(cwd), USERPROFILE: path.dirname(cwd), XDG_CONFIG_HOME: path.dirname(cwd),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(path.dirname(cwd), 'absent-global-git-config'),
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '', GIT_AUTHOR_NAME: 'Offline Git API Test',
    GIT_AUTHOR_EMAIL: 'offline@example.invalid', GIT_COMMITTER_NAME: 'Offline Git API Test',
    GIT_COMMITTER_EMAIL: 'offline@example.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' })
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
      cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk)); child.stderr.on('data', chunk => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve(Buffer.concat(stdout)) : reject(new Error(`Fixture Git ${args[0]} failed: ${Buffer.concat(stderr)}`)))
    child.stdin.on('error', reject)
    child.stdin.end(input)
  })
}

async function write(cwd: string, name: string, content: string | Buffer): Promise<void> {
  const file = path.join(cwd, name)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}

async function repository(files: Record<string, string | Buffer> = { 'staged.txt': 'stage base\n', 'work.txt': 'work base\n' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-git-review-'))
  cleanups.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 }))
  const cwd = path.join(root, 'repo')
  await fs.mkdir(cwd)
  await git(cwd, ['init', '-q', '--initial-branch=main'])
  await git(cwd, ['config', 'core.autocrlf', 'false'])
  for (const [name, content] of Object.entries(files)) await write(cwd, name, content)
  await git(cwd, ['add', '--', '.']); await git(cwd, ['commit', '-qm', 'offline initial'])
  return { cwd, root }
}

async function boot(extra: Partial<WebServerOptions> = {}, suppliedRepo?: Awaited<ReturnType<typeof repository>>) {
  const repo = suppliedRepo ?? await repository()
  const requests: unknown[] = []
  const persisted: DesktopSettingsState[] = []
  const handle = await runWebServer({
    cwd: repo.cwd, sessionDir: path.join(repo.root, 'sessions'), jobsDir: path.join(repo.root, 'jobs'),
    adapter: new MockAdapter([request => { requests.push(request); return text('offline adapter was not expected to run') }]),
    config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } },
      'core-skills': { disabled: true }, 'core-agent-defs': { disabled: true } } },
    host: '127.0.0.1', port: 0, token: OPERATOR, viewerToken: VIEWER,
    open: false, quiet: true, updatesAutoCheck: false, onPersistSettings: state => { persisted.push(state) },
    ...extra,
  })
  cleanups.push(async () => { await handle.close(); expect(requests, 'Git review must not call any model adapter').toEqual([]) })
  const base = `http://127.0.0.1:${handle.port}`
  const state = async () => {
    const response = await fetch(base + '/api/state', { headers: { authorization: `Bearer ${OPERATOR}` } })
    expect(response.status).toBe(200)
    return response.json() as Promise<WebState>
  }
  const initial = await state()
  async function request(route: string, options: { body?: unknown; workspace?: string | null; token?: string; headers?: Record<string, string> } = {}) {
    const workspace = options.workspace === undefined ? initial.workspaceId : options.workspace
    return fetch(base + route, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${options.token ?? OPERATOR}`,
        ...(workspace === null ? {} : { 'x-sakura-workspace': workspace }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
  }
  async function snapshot(query = ''): Promise<WebSnapshot> {
    const response = await request('/api/git-review' + query)
    expect(response.status, await response.clone().text()).toBe(200)
    return response.json() as Promise<WebSnapshot>
  }
  return { ...repo, base, handle, state, initial, request, snapshot, requests, persisted }
}

function changed(snapshot: GitReviewSnapshot, range: keyof GitReviewSnapshot['ranges'], name: string) {
  const found = snapshot.ranges[range].find(file => file.path === name)
  expect(found, `${range} must include ${name}`).toBeDefined()
  return found!
}
const current = (snapshot: WebSnapshot) => ({ expectedSnapshotId: snapshot.snapshotId, baseRef: snapshot.base.requestedRef,
  selectedUntracked: snapshot.selectedUntracked, expectedStoreFingerprint: snapshot.storeFingerprint, confirmed: true })
const indexBytes = (cwd: string) => fs.readFile(path.join(cwd, '.git', 'index'))

async function successfulSnapshot(response: Response): Promise<WebSnapshot> {
  expect(response.status, await response.clone().text()).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json() as Promise<WebSnapshot>
}

function gate() {
  let release!: () => void, enter!: () => void
  const ready = new Promise<void>(resolve => { enter = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  return { ready, wait, enter, release }
}

describe('offline local Git review API', () => {
  it('gets real scoped ranges with a fixed local baseline and denies missing/wrong workspace headers', async () => {
    const f = await boot()
    const baseOid = (await git(f.cwd, ['rev-parse', 'HEAD'])).toString().trim()
    await git(f.cwd, ['tag', 'review-base', baseOid])
    await write(f.cwd, 'staged.txt', 'staged changed\n'); await git(f.cwd, ['add', '--', 'staged.txt'])
    await write(f.cwd, 'work.txt', 'working changed\n')
    await write(f.cwd, 'private-new.txt', 'untracked private body sentinel\n')
    const before = await indexBytes(f.cwd)
    const spy = vi.spyOn(GitReviewService.prototype, 'getSnapshot')
    for (const workspace of [null, 'incorrect-epoch']) {
      const denied = await f.request('/api/git-review', { workspace })
      expect(denied.status).toBe(409)
      const raw = await denied.text()
      expect(raw).not.toContain('working changed'); expect(raw).not.toContain('ranges')
    }
    expect(spy).not.toHaveBeenCalled()
    const snapshot = await f.snapshot('?baseRef=refs%2Ftags%2Freview-base')
    expect(snapshot.workspaceId).toBe(f.initial.workspaceId)
    expect(snapshot.status).toBe('ready'); expect(snapshot.base.oid).toBe(baseOid)
    expect(changed(snapshot, 'staged', 'staged.txt').patch).toContain('+staged changed\n')
    expect(changed(snapshot, 'unstaged', 'work.txt').patch).toContain('+working changed\n')
    expect(changed(snapshot, 'untracked', 'private-new.txt').text).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('untracked private body sentinel')
    const badRef = await f.request('/api/git-review?baseRef=HEAD~1')
    expect(badRef.status).toBe(400)
    expect(await indexBytes(f.cwd)).toEqual(before)
  }, 60_000)

  it('denies Git GET to local viewers and both remote roles before reading repository content', async () => {
    const local = await boot(), remote = await boot({ host: '0.0.0.0' })
    await write(local.cwd, 'work.txt', 'local sensitive working content\n')
    await write(remote.cwd, 'work.txt', 'remote sensitive working content\n')
    const beforeLocal = await indexBytes(local.cwd), beforeRemote = await indexBytes(remote.cwd)
    const read = vi.spyOn(GitReviewService.prototype, 'getSnapshot')
    for (const [server, token] of [[local, VIEWER], [remote, OPERATOR], [remote, VIEWER]] as const) {
      const state = await fetch(server.base + '/api/state', { headers: { authorization: `Bearer ${token}` } })
      expect(state.status).toBe(200)
      const denied = await server.request('/api/git-review', { token, headers: { 'x-forwarded-for': '127.0.0.1' } })
      expect(denied.status).toBe(404)
      const raw = await denied.text()
      expect(raw).not.toContain('sensitive working content'); expect(raw).not.toContain('ranges')
    }
    expect(read).not.toHaveBeenCalled()
    expect(await indexBytes(local.cwd)).toEqual(beforeLocal); expect(await indexBytes(remote.cwd)).toEqual(beforeRemote)
  }, 60_000)

  it('requires literal confirmed=true on read/mark/export before invoking the Git service', async () => {
    const f = await boot()
    await write(f.cwd, 'work.txt', 'new work\n'); await write(f.cwd, 'new.txt', 'private new\n')
    const snapshot = await f.snapshot(), before = await indexBytes(f.cwd)
    const read = vi.spyOn(GitReviewService.prototype, 'readUntracked')
    const mark = vi.spyOn(GitReviewService.prototype, 'markReviewed')
    const exportPatch = vi.spyOn(GitReviewService.prototype, 'exportPatch')
    for (const [route, args] of [
      ['/api/git-review/read', { path: 'new.txt' }],
      ['/api/git-review/reviewed', { fileId: changed(snapshot, 'unstaged', 'work.txt').id, reviewed: true }],
      ['/api/git-review/export', { range: 'unstaged', fileIds: [changed(snapshot, 'unstaged', 'work.txt').id] }],
    ] as const) {
      for (const confirmed of [undefined, false, 'true']) {
        const response = await f.request(route, { body: { ...current(snapshot), ...args, confirmed } })
        expect(response.status, `${route} with confirmed=${String(confirmed)}`).toBe(400)
        expect((await response.json() as { error: string }).error).toContain('confirm')
      }
      const missingWorkspace = await f.request(route, { workspace: null, body: { ...current(snapshot), ...args } })
      expect(missingWorkspace.status).toBe(409)
    }
    expect(read).not.toHaveBeenCalled(); expect(mark).not.toHaveBeenCalled(); expect(exportPatch).not.toHaveBeenCalled()
    await expect(fs.stat(path.join(f.cwd, '.sakura', 'git-review', 'state.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await indexBytes(f.cwd)).toEqual(before)
  }, 60_000)

  it('reads only explicitly selected untracked content and forwards selection and store CAS through reviewed marks', async () => {
    const f = await boot()
    await write(f.cwd, 'work.txt', 'working changed\n'); await write(f.cwd, 'new.txt', 'private selected text\n')
    const initial = await f.snapshot(), before = await indexBytes(f.cwd)
    const selected = await successfulSnapshot(await f.request('/api/git-review/read', { body: { ...current(initial), path: 'new.txt' } }))
    expect(selected.selectedUntracked).toEqual(['new.txt'])
    expect(changed(selected, 'untracked', 'new.txt').text).toBe('private selected text\n')
    expect(selected.snapshotId).not.toBe(initial.snapshotId)
    const untracked = changed(selected, 'untracked', 'new.txt')
    const omitted = await f.request('/api/git-review/reviewed', { body: { ...current(selected), selectedUntracked: undefined, fileId: untracked.id, reviewed: true } })
    expect(omitted.status).toBe(409)
    const saved = await successfulSnapshot(await f.request('/api/git-review/reviewed', { body: { ...current(selected), fileId: untracked.id, reviewed: true } }))
    expect(saved.workspaceId).toBe(initial.workspaceId)
    expect(saved.snapshotId).toBe(selected.snapshotId)
    expect(saved.storeFingerprint).not.toBe(selected.storeFingerprint)
    expect(changed(saved, 'untracked', 'new.txt').reviewed).toBe(true)
    const statePath = path.join(f.cwd, '.sakura', 'git-review', 'state.json')
    const persisted = await fs.readFile(statePath)
    const tracked = changed(saved, 'unstaged', 'work.txt')
    const staleStore = await f.request('/api/git-review/reviewed', { body: { ...current(saved), expectedStoreFingerprint: selected.storeFingerprint, fileId: tracked.id, reviewed: true } })
    expect(staleStore.status).toBe(409)
    expect(await fs.readFile(statePath)).toEqual(persisted)
    const trackedSaved = await successfulSnapshot(await f.request('/api/git-review/reviewed', { body: { ...current(saved), fileId: tracked.id, reviewed: true } }))
    expect(changed(trackedSaved, 'unstaged', 'work.txt').reviewed).toBe(true)
    expect(changed(trackedSaved, 'untracked', 'new.txt').reviewed).toBe(true)
    const reloaded = await new GitReviewService(f.cwd).getSnapshot({ selectedUntracked: selected.selectedUntracked })
    expect(changed(reloaded, 'unstaged', 'work.txt').reviewed).toBe(true)
    expect(await indexBytes(f.cwd)).toEqual(before)
    expect(await fs.readFile(path.join(f.cwd, 'new.txt'), 'utf8')).toBe('private selected text\n')
  }, 90_000)

  it('downloads exact UTF-8 Git patch bytes for one range and rejects stale selections without changing the real index', async () => {
    const f = await boot()
    await write(f.cwd, 'staged.txt', 'stage changed\n'); await git(f.cwd, ['add', '--', 'staged.txt'])
    await write(f.cwd, 'work.txt', '中文 patch change\n')
    await write(f.cwd, 'new.txt', 'selected untracked value\n')
    const initial = await f.snapshot()
    const selected = await successfulSnapshot(await f.request('/api/git-review/read', { body: { ...current(initial), path: 'new.txt' } }))
    const before = await indexBytes(f.cwd)
    const target = changed(selected, 'unstaged', 'work.txt')
    const body = { ...current(selected), range: 'unstaged', fileIds: [target.id] }
    const omitted = await f.request('/api/git-review/export', { body: { ...body, selectedUntracked: undefined } })
    expect(omitted.status).toBe(409)
    const mixed = await f.request('/api/git-review/export', { body: { ...body, fileIds: [target.id, changed(selected, 'staged', 'staged.txt').id] } })
    expect(mixed.status).toBe(400)
    const response = await f.request('/api/git-review/export', { body })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/x-diff; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="git-review-unstaged.patch"')
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(bytes).toEqual(Buffer.from(target.patch!, 'utf8'))
    expect(bytes.length).toBe(Buffer.byteLength(target.patch!, 'utf8'))
    expect(bytes.length).toBeGreaterThan(target.patch!.length)
    expect(bytes.toString('utf8')).not.toContain('selected untracked value')
    await git(f.cwd, ['apply', '--cached', '--check', '-'], bytes)
    const staged = changed(selected, 'staged', 'staged.txt')
    const stagedResponse = await f.request('/api/git-review/export', { body: { ...current(selected), range: 'staged', fileIds: [staged.id] } })
    expect(stagedResponse.status).toBe(200)
    const stagedBytes = Buffer.from(await stagedResponse.arrayBuffer())
    expect(stagedBytes).toEqual(Buffer.from(staged.patch!))
    await git(f.cwd, ['apply', '--cached', '--reverse', '--check', '-'], stagedBytes)
    await write(f.cwd, 'new.txt', 'changed untracked value!\n')
    const stale = await f.request('/api/git-review/export', { body })
    expect(stale.status).toBe(409)
    expect(stale.headers.get('content-disposition')).toBeNull()
    expect((await stale.json() as { error: string }).error).toBeTruthy()
    expect(await indexBytes(f.cwd)).toEqual(before)
    expect(await fs.readFile(path.join(f.cwd, 'work.txt'), 'utf8')).toBe('中文 patch change\n')
  }, 90_000)

  it.each(['snapshot', 'export'] as const)('withholds a late %s response after workspace switch using a fake gate, not an external transport', async operation => {
    const first = await repository({ 'first.txt': 'first base\n' })
    const second = await repository({ 'second.txt': 'second base\n' })
    const f = await boot({}, first)
    await write(first.cwd, 'first.txt', 'first private change\n')
    await write(second.cwd, 'second.txt', 'second private change\n')
    const snapshot = await f.snapshot(), beforeFirst = await indexBytes(first.cwd), beforeSecond = await indexBytes(second.cwd)
    const held = gate()
    let signal: AbortSignal | undefined
    let seenCwd: string | undefined
    if (operation === 'snapshot') {
      vi.spyOn(GitReviewService.prototype, 'getSnapshot').mockImplementationOnce(async function(this: GitReviewService, options: GitSnapshotOptions = {}) {
        signal = options.signal; seenCwd = this.cwd; held.enter(); await held.wait
        // Intentionally ignore cancellation: the HTTP generation guard must still withhold stale data.
        return snapshot
      })
    } else {
      vi.spyOn(GitReviewService.prototype, 'exportPatch').mockImplementationOnce(async function(this: GitReviewService, options) {
        signal = options.signal; seenCwd = this.cwd; held.enter(); await held.wait
        const patch = 'late private patch must never reach a new workspace\n'
        return { patch, byteLength: Buffer.byteLength(patch), range: 'unstaged', filename: 'late.patch', snapshotId: snapshot.snapshotId } satisfies GitPatchExport
      })
    }
    const pending = f.request(operation === 'snapshot' ? '/api/git-review' : '/api/git-review/export', operation === 'snapshot' ? {} : {
      body: { ...current(snapshot), range: 'unstaged', fileIds: [changed(snapshot, 'unstaged', 'first.txt').id] },
    })
    try {
      await held.ready
      expect(seenCwd).toBe(first.cwd); expect(signal?.aborted).toBe(false)
      const switched = await f.request('/api/desktop/settings', { body: { workspace: second.cwd } })
      expect(switched.status, await switched.clone().text()).toBe(200)
      const now = await f.state()
      expect(now.cwd).toBe(second.cwd); expect(now.workspaceId).not.toBe(snapshot.workspaceId)
      expect(signal?.aborted).toBe(true)
      held.release()
      const late = await pending
      expect(late.status).toBe(503)
      expect(late.headers.get('content-disposition')).toBeNull()
      const raw = await late.text()
      expect(raw).not.toContain('first private change'); expect(raw).not.toContain('late private patch')
      expect((await f.request('/api/git-review')).status).toBe(409)
      const fresh = await successfulSnapshot(await f.request('/api/git-review', { workspace: now.workspaceId }))
      expect(fresh.workspaceId).toBe(now.workspaceId)
      expect(changed(fresh, 'unstaged', 'second.txt').patch).toContain('+second private change\n')
      expect(JSON.stringify(fresh)).not.toContain('first private change')
      expect(await indexBytes(first.cwd)).toEqual(beforeFirst); expect(await indexBytes(second.cwd)).toEqual(beforeSecond)
      expect(f.persisted).toHaveLength(1)
    } finally { held.release(); await pending.catch(() => {}) }
  }, 90_000)
})
