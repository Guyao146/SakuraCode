import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentImportService } from '../src/web/document-import.js'
import { KnowledgeStore } from '../src/knowledge/index.js'
import { syntheticDocx } from './document-fixtures.js'
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 4 }) })
async function fixture() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-doc-import-')); roots.push(cwd); const knowledge = new KnowledgeStore(cwd); return { cwd, knowledge, service: new DocumentImportService(cwd, knowledge) } }
describe('confirmed document knowledge imports', () => {
  it('retains raw BOM/CRLF collection bytes and old references while importing parsed original provenance', async () => {
    const f = await fixture(), original = '\ufefforiginal\r\nsecond\r\n'
    const first = await f.knowledge.importFiles({ files: [{ path: 'old.md', content: original }] })
    const managed = await f.knowledge.adoptLegacy(first.documents[0]!.id.split('/')[0]!, await f.knowledge.getVersionState())
    const bytes = syntheticDocx(), parsed = await f.service.documents.parse({ name: 'reference.docx', bytes })
    const prepared = await f.service.prepare({ documentId: parsed.id, unitIds: [parsed.units[0]!.id], collectionId: managed.collectionId, revision: managed }, {})
    expect(prepared.diff.unchanged).toContain('old.md')
    const committed = await f.service.commit(prepared.id, {})
    const state = await f.knowledge.getVersionState(), version = state.collections[0]!.versions.find(v => v.id === committed.versionId)!
    const preserved = version.documents.find(d => d.path === 'old.md')!
    expect(await f.knowledge.readRaw(preserved.id, preserved.version)).toEqual(Buffer.from(original))
    expect(await f.knowledge.readRaw(first.documents[0]!.id, first.documents[0]!.version)).toEqual(Buffer.from(original))
    expect(Buffer.from(await f.service.documents.store.readOriginal(parsed.sha256))).toEqual(bytes)
    await expect(f.service.commit(prepared.id, {})).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' })
  })
  it('cancels without publishing and rejects failed provenance before knowledge import', async () => {
    const f = await fixture(), parsed = await f.service.documents.parse({ name: 'reference.docx', bytes: syntheticDocx() })
    const prepare = () => f.service.prepare({ documentId: parsed.id, unitIds: [parsed.units[0]!.id] }, {})
    const cancelled = await prepare(); await f.service.cancel(cancelled.id)
    await expect(f.service.commit(cancelled.id, {})).rejects.toMatchObject({ status: 409 })
    expect((await f.knowledge.reload()).documents).toEqual([])
    const next = await prepare()
    vi.spyOn(f.service.documents, 'persistSelection').mockRejectedValueOnce(new Error('synthetic storage failure'))
    await expect(f.service.commit(next.id, {})).rejects.toThrow('synthetic storage')
    expect((await f.knowledge.reload()).documents).toEqual([])
  })
  it('reports partial registration honestly and cannot replay a consumed confirmation', async () => {
    const f = await fixture(), parsed = await f.service.documents.parse({ name: 'reference.docx', bytes: syntheticDocx() })
    const prepared = await f.service.prepare({ documentId: parsed.id, unitIds: [parsed.units[0]!.id] }, {})
    vi.spyOn(f.knowledge, 'adoptLegacy').mockRejectedValueOnce(new Error('synthetic registration lock'))
    await expect(f.service.commit(prepared.id, {})).rejects.toMatchObject({ code: 'PARTIAL_IMPORT', status: 409 })
    expect((await f.knowledge.reload()).documents).toHaveLength(1)
    expect((await f.knowledge.getVersionState()).collections).toHaveLength(0)
    await expect(f.service.commit(prepared.id, {})).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' })
  })
})
