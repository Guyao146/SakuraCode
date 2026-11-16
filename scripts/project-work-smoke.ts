/** Exercise the compiled engine with a synthetic local repository; never a model or network service. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { TaskSnapshot } from '../src/tasks/types.js'
import type { KnowledgeVersionState, KnowledgeUpdatePreview } from '../src/knowledge/index.js'
import type { GitReviewSnapshot } from '../src/git/index.js'
import { syntheticDocx, syntheticPdf } from '../tests/document-fixtures.js'
import type { DocumentPreview } from '../src/documents/types.js'
import type { BackupPreview } from '../src/backup/types.js'
import type { WorktreeCreatePreview, WorktreeInfo, WorktreeRead, WorktreeIntegratePreview } from '../src/worktrees/index.js'
import { createServer } from 'node:http'

export async function verifyProjectWork(url: string, cwd: string): Promise<void> {
  const initialResponse = await fetch(url + 'api/state')
  assert.equal(initialResponse.status, 200)
  const initial = await initialResponse.json() as { workspaceId: string; approvalMode: string }
  const headers = { 'content-type': 'application/json', 'X-Sakura-Workspace': initial.workspaceId }
  async function request<T>(route: string, body?: unknown, status = 200): Promise<T> {
    const response = await fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) })
    const data = await response.json()
    assert.equal(response.status, status, `${route}: ${JSON.stringify(data)}`)
    return data as T
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  // Only this synthetic workspace receives a repository. Never walk or write the project's own index.
  git('init'); git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false')
  const source = path.join(cwd, 'project-work-smoke.txt')
  await fs.writeFile(source, 'compiled baseline\n')
  git('add', '--', 'project-work-smoke.txt'); git('commit', '-m', 'synthetic desktop baseline')
  await fs.writeFile(source, 'compiled changed\n')
  const index = await fs.readFile(path.join(cwd, '.git', 'index'))
  const diff = await request<GitReviewSnapshot>('api/git-review')
  const changed = diff.ranges.unstaged.find(row => row.path === 'project-work-smoke.txt')
  assert.ok(changed)
  assert.ok(changed.patch?.includes('+compiled changed'))
  assert.equal(changed.exportable, true)
  const reviewed = await request<GitReviewSnapshot>('api/git-review/reviewed', { fileId: changed.id, reviewed: true, expectedSnapshotId: diff.snapshotId,
    expectedStoreFingerprint: diff.storeFingerprint, confirmed: true })
  assert.equal(reviewed.ranges.unstaged.find(row => row.id === changed.id)?.reviewed, true)
  const exported = await fetch(url + 'api/git-review/export', { method: 'POST', headers, body: JSON.stringify({ expectedSnapshotId: reviewed.snapshotId,
    range: 'unstaged', fileIds: [changed.id], confirmed: true }), signal: AbortSignal.timeout(45_000) })
  assert.equal(exported.status, 200)
  assert.ok((await exported.text()).includes('+compiled changed'))
  assert.deepEqual(await fs.readFile(path.join(cwd, '.git', 'index')), index)
  assert.equal(await fs.readFile(source, 'utf8'), 'compiled changed\n')

  let tasks = await request<TaskSnapshot>('api/tasks')
  tasks = await request<TaskSnapshot>('api/tasks/checks', { revision: tasks.revision, fingerprint: tasks.fingerprint, confirmed: true,
    checks: [{ id: 'desktop-check', name: 'Compiled command evidence', shell: 'bash', command: 'printf COMPILED_TASK_CHECK; exit 0', workdir: '.', required: true, timeoutMs: 3000 }] })
  tasks = await request<TaskSnapshot>('api/tasks', { revision: tasks.revision, fingerprint: tasks.fingerprint, confirmed: true,
    task: { title: 'Compiled task card', description: 'No automatic command replay', priority: 'medium', status: 'completed',
      steps: [], criteria: ['Real command exits zero'], checkIds: ['desktop-check'], archived: false } })
  await request('api/settings', { approvalMode: 'yolo' })
  try {
    const run = await request<{ runId: string }>('api/tasks/verify', { taskId: tasks.tasks[0]!.id, revision: tasks.revision, fingerprint: tasks.fingerprint, confirmed: true }, 202)
    const deadline = Date.now() + 30_000
    for (;;) {
      tasks = await request<TaskSnapshot & { activeRunId?: string }>('api/tasks')
      if (!('activeRunId' in tasks)) break
      assert.ok(Date.now() < deadline, 'compiled validation must settle')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const report = await request<{ run: { status: string; results: Array<{ exitCode: number; output: string }> } }>('api/tasks/runs/' + run.runId)
    assert.equal(report.run.status, 'passed'); assert.equal(report.run.results[0]!.exitCode, 0)
    assert.ok(report.run.results[0]!.output.includes('COMPILED_TASK_CHECK'))
    assert.equal('acceptance' in tasks.tasks[0]!, false)
    tasks = await request<TaskSnapshot>('api/tasks/accept', { taskId: tasks.tasks[0]!.id, note: 'Synthetic explicit acceptance', revision: tasks.revision, fingerprint: tasks.fingerprint, confirmed: true })
    assert.equal(tasks.tasks[0]!.acceptance?.runId, run.runId)
  } finally { await request('api/settings', { approvalMode: initial.approvalMode }) }
  assert.equal(JSON.parse(await fs.readFile(path.join(cwd, '.sakura', 'tasks', 'state.json'), 'utf8')).tasks[0].title, 'Compiled task card')

  const imported = await request<{ documents: Array<{ id: string; version: string }> }>('api/knowledge/import', { files: [{ path: 'native-version.txt', content: 'COMPILED_OLD_REFERENCE' }] })
  let versions = await request<KnowledgeVersionState>('api/knowledge/versions')
  const batchId = imported.documents[0]!.id.split('/')[0]!
  versions = await request<KnowledgeVersionState>('api/knowledge/versions/adopt', { batchId, revision: versions.revision, fingerprint: versions.fingerprint, confirmed: true })
  const collection = versions.collections[0]!
  const preview = await request<KnowledgeUpdatePreview>('api/knowledge/versions/preview', { collectionId: collection.id,
    files: [{ path: 'native-version.txt', content: 'COMPILED_NEW_REFERENCE' }], revision: versions.revision, fingerprint: versions.fingerprint, confirmed: true })
  assert.deepEqual(preview.diff.modified, ['native-version.txt'])
  versions = await request<KnowledgeVersionState>('api/knowledge/versions/commit', { previewId: preview.previewId, ...preview.expected, confirmed: true })
  const search = await request<{ results: unknown[] }>('api/knowledge/search?q=COMPILED_NEW_REFERENCE')
  assert.equal(search.results.length, 1)
  const old = await request<{ content: string }>('api/knowledge/read?id=' + encodeURIComponent(imported.documents[0]!.id) + '&version=' + imported.documents[0]!.version)
  assert.equal(old.content, 'COMPILED_OLD_REFERENCE')
  versions = await request<KnowledgeVersionState>('api/knowledge/versions/activate', { collectionId: collection.id, versionId: collection.activeVersionId,
    revision: versions.revision, fingerprint: versions.fingerprint, confirmed: true })
  assert.equal(versions.collections[0]!.activeVersionId, collection.activeVersionId)
  assert.equal((await request<{ results: unknown[] }>('api/knowledge/search?q=COMPILED_NEW_REFERENCE')).results.length, 0)

  // Calls are served by the SEA engine, so parsing cannot accidentally use the dev tree's worker file.
  const docBytes = syntheticDocx('COMPILED_DOCX_REFERENCE')
  const parsed = await request<DocumentPreview>('api/documents/parse', { name: 'reference.docx', base64: docBytes.toString('base64'), confirmed: true })
  assert.ok(parsed.units[0]!.text.includes('COMPILED_DOCX_REFERENCE'))
  const pdf = await request<DocumentPreview>('api/documents/parse', { name: 'reference.pdf', base64: syntheticPdf().toString('base64'), confirmed: true })
  assert.deepEqual(pdf.units.map(unit => unit.sourceLocator), [{ kind: 'pdf', page: 1 }, { kind: 'pdf', page: 2 }])
  await request('api/documents/cancel', { documentId: pdf.id, confirmed: true })
  const prepared = await request<{ id: string }>('api/documents/prepare', { documentId: parsed.id, unitIds: [parsed.units[0]!.id], confirmed: true })
  await request('api/documents/commit', { id: prepared.id, confirmed: true })
  const originalResponse = await fetch(url + 'api/documents/original?hash=' + parsed.sha256, { headers })
  assert.equal(originalResponse.status, 200); assert.deepEqual(Buffer.from(await originalResponse.arrayBuffer()), docBytes)
  const backup = await request<BackupPreview>('api/backups/preview', { selection: { knowledge: true, tasks: true, memory: true }, confirmed: true })
  const downloaded = await fetch(url + 'api/backups/download', { method: 'POST', headers, body: JSON.stringify({ id: backup.id, fingerprint: backup.fingerprint, confirmed: true }) })
  assert.equal(downloaded.status, 200)
  const archive = Buffer.from(await downloaded.arrayBuffer())
  const checked = await request<BackupPreview>('api/backups/inspect', { base64: archive.toString('base64'), confirmed: true })
  const restored = await request<{ directory: string }>('api/backups/restore', { id: checked.id, fingerprint: checked.fingerprint, parent: path.dirname(cwd), name: 'restored-work-data', confirmed: true })
  assert.deepEqual(await fs.readFile(path.join(restored.directory, '.sakura/documents/originals', parsed.sha256 + '.bin')), docBytes)
  assert.equal((JSON.parse(await fs.readFile(path.join(restored.directory, '.sakura/tasks/state.json'), 'utf8')) as TaskSnapshot).tasks[0]!.acceptance, undefined)

  const calls: string[] = []
  const endpoint = createServer((req, res) => { calls.push(req.url!); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, actions: [] })) })
  await new Promise<void>(resolve => endpoint.listen(0, '127.0.0.1', resolve))
  try {
    const connection = { id: 'smoke_diagnostic', name: 'Synthetic diagnostic', adapter: 'http', category: 'software', url: 'http://127.0.0.1:' + (endpoint.address() as { port: number }).port }
    const preflight = await request<{ ok: boolean }>('api/connector-wizard/preflight', { connection })
    assert.equal(preflight.ok, true); assert.deepEqual(calls, [])
    const diagnostic = await request<{ ok: boolean }>('api/connector-wizard/diagnose', { connection, confirmed: true })
    assert.equal(diagnostic.ok, true); assert.deepEqual(calls, ['/capabilities'])
  } finally { await new Promise<void>(resolve => { endpoint.closeAllConnections(); endpoint.close(() => resolve()) }) }

  const createPreview = await request<WorktreeCreatePreview>('api/worktrees/preview-create', { taskId: tasks.tasks[0]!.id, confirmed: true })
  const tree = await request<WorktreeInfo>('api/worktrees/create', { previewId: createPreview.id, expectedFingerprint: createPreview.fingerprint, confirmed: true })
  assert.equal(await fs.readFile(path.join(tree.path, 'project-work-smoke.txt'), 'utf8'), 'compiled baseline\n')
  const newFile = 'compiled-isolated-addition.txt'
  await fs.writeFile(path.join(tree.path, newFile), 'COMPILED_ISOLATED_TEXT')
  const snapshot = await request<WorktreeRead>('api/worktrees/read?id=' + tree.id)
  const integration = await request<WorktreeIntegratePreview>('api/worktrees/preview-integrate', { id: tree.id, expectedFingerprint: snapshot.fingerprint, paths: [newFile], confirmed: true })
  assert.equal(integration.canIntegrate, true)
  await request('api/worktrees/integrate', { id: tree.id, previewId: integration.id, expectedFingerprint: integration.fingerprint, confirmed: true })
  assert.equal(await fs.readFile(path.join(cwd, newFile), 'utf8'), 'COMPILED_ISOLATED_TEXT')
  assert.deepEqual(await fs.readFile(path.join(cwd, '.git/index')), index)
  const final = await request<WorktreeRead>('api/worktrees/read?id=' + tree.id)
  await request('api/worktrees/cleanup', { id: tree.id, expectedFingerprint: final.fingerprint, confirmed: true })
  assert.equal((await fs.stat(tree.dataDir)).isDirectory(), true)
}
