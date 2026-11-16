import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'
import { syntheticDocx } from './document-fixtures.js'
import type { DocumentPreview } from '../src/documents/index.js'
import type { BackupPreview } from '../src/backup/types.js'
const roots: string[] = [], handles: WebServerHandle[] = []
afterEach(async () => { while (handles.length) await handles.pop()!.close(); while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 4 }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-data-api-')); roots.push(root)
  const cwd = path.join(root, 'workspace'); await fs.mkdir(cwd)
  const adapter = new MockAdapter([text('not called')]), modelCalls = vi.spyOn(adapter, 'stream')
  const web = await runWebServer({ cwd, adapter, approvalMode: 'yolo', quiet: true, open: false, updatesAutoCheck: false,
    config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { disabled: true } } } }); handles.push(web)
  const state = await (await fetch(web.url + 'api/state')).json() as { workspaceId: string }
  const request = (route: string, body?: unknown, workspace: string | undefined = state.workspaceId) => fetch(web.url + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...(workspace ? { 'X-Sakura-Workspace': workspace } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  async function json<T>(route: string, body?: unknown): Promise<T> { const response = await request(route, body), value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value as T }
  return { root, cwd, web, request, json, adapter, modelCalls }
}
describe('local document and backup APIs', () => {
  it('parses confirms and retrieves exact original then backs up and restores knowledge to a new directory', async () => {
    const f = await fixture(), bytes = syntheticDocx()
    const parsed = await f.json<DocumentPreview>('api/documents/parse', { name: 'reference.docx', base64: bytes.toString('base64'), confirmed: true })
    const prepared = await f.json<{ id: string }>('api/documents/prepare', { documentId: parsed.id, unitIds: [parsed.units[0]!.id], confirmed: true })
    await f.json('api/documents/commit', { id: prepared.id, confirmed: true })
    const original = await f.request('api/documents/original?hash=' + parsed.sha256)
    expect(Buffer.from(await original.arrayBuffer())).toEqual(bytes)
    const backup = await f.json<BackupPreview>('api/backups/preview', { selection: { knowledge: true }, confirmed: true })
    const download = await f.request('api/backups/download', { id: backup.id, fingerprint: backup.fingerprint, confirmed: true })
    expect(download.status).toBe(200)
    const archive = Buffer.from(await download.arrayBuffer())
    const inspected = await f.json<BackupPreview>('api/backups/inspect', { base64: archive.toString('base64'), confirmed: true })
    const restored = await f.json<{ directory: string }>('api/backups/restore', { id: inspected.id, fingerprint: inspected.fingerprint, parent: f.root, name: 'restored', confirmed: true })
    expect(await fs.readFile(path.join(restored.directory, '.sakura/documents/originals', parsed.sha256 + '.bin'))).toEqual(bytes)
    expect(await fs.readFile(path.join(restored.directory, 'RESTORE-REPORT.txt'), 'utf8')).toContain('No code')
    expect(f.modelCalls).not.toHaveBeenCalled()
  }, 60000)
  it('rejects missing workspace, missing confirmation and cancelled preview without storing input', async () => {
    const f = await fixture()
    for (const route of ['api/documents', 'api/backups', 'api/connector-wizard']) {
      expect((await fetch(f.web.url + route)).status).toBe(409)
      expect((await f.request(route, undefined, 'stale-workspace')).status).toBe(409)
    }
    expect((await f.request('api/documents/parse', { name: 'x.docx', base64: syntheticDocx().toString('base64') })).status).toBe(400)
    const parsed = await f.json<DocumentPreview>('api/documents/parse', { name: 'x.docx', base64: syntheticDocx().toString('base64'), confirmed: true })
    await f.json('api/documents/cancel', { documentId: parsed.id, confirmed: true })
    expect((await f.request('api/documents/prepare', { documentId: parsed.id, unitIds: [parsed.units[0]!.id], confirmed: true })).status).toBe(410)
    await expect(fs.stat(path.join(f.cwd, '.sakura/documents/manifest.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const templates = await f.json<{ templates: unknown[] }>('api/connector-wizard'); expect(templates.templates).toHaveLength(3)
    const invalid = await f.json<{ ok: boolean }>('api/connector-wizard/preflight', { connection: { id: 'x' } }); expect(invalid.ok).toBe(false)
  })
})
