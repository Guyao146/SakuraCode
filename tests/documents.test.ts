import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { zipSync, strToU8 } from 'fflate'
import { afterEach, describe, expect, it } from 'vitest'
import { DocumentService, DocumentStore, DOCUMENT_LIMITS as L, documentHash, validateDocumentSnapshot } from '../src/documents/index.js'
import { runParser } from '../src/documents/parser.js'

const roots: string[] = []
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/package/2006/relationships'
async function fixture() { const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-documents-')); roots.push(cwd); return { cwd, service: new DocumentService(cwd) } }
afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }) })
function docx(body = '<w:p><w:r><w:t>中文资料 First paragraph</w:t></w:r></w:p>', extra: Record<string, Uint8Array> = {}, level: 0 | 6 = 0) {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels': strToU8(`<Relationships xmlns="${R}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`), ...extra,
  }, { level })
}
function pdf(pages = ['Hello actual PDF', 'Second real page'], encrypted = false, chinese = false, scanned = false) {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '']
  if (chinese) {
    objects.push('<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticChinese /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>')
    objects.push('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticChinese /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor << /Type /FontDescriptor /FontName /SyntheticChinese /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >> >>')
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <4E2D> <0002> <6587> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end'
    objects.push(`<< /Length ${Buffer.byteLength(cmap)} >>\nstream\n${cmap}\nendstream`)
  } else objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const imageId = objects.length + 1
  if (scanned) objects.push('<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nff0000>\nendstream')
  const kids: string[] = []
  for (const text of pages) {
    const id = objects.length + 1
    kids.push(`${id} 0 R`)
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> ${scanned ? `/XObject << /Im0 ${imageId} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`)
    const content = scanned ? 'q 100 0 0 100 20 20 cm /Im0 Do Q' : !text ? '' : chinese ? 'BT /F1 12 Tf 20 100 Td <00010002> Tj ET' : `BT /F1 12 Tf 20 100 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`
  let encryption = ''
  if (encrypted) { objects.push('<< /Filter /Standard /V 1 /R 2 /Length 40 /O <0000000000000000000000000000000000000000000000000000000000000000> /U <0000000000000000000000000000000000000000000000000000000000000000> /P -4 >>'); encryption = `/Encrypt ${objects.length} 0 R /ID [<01020304><01020304>]` }
  let output = '%PDF-1.7\n', offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(output)
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${encryption} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(output)
}

describe('actual bytes parsed in a bounded document worker', () => {
  it('extracts actual PDF text and physical page numbers including blank pages, with no preview disk writes', async () => {
    const { cwd, service } = await fixture(), bytes = pdf(['First page', '', 'Third page'])
    const preview = await service.parse({ name: 'reference.pdf', bytes })
    expect(preview.sha256).toBe(documentHash(bytes))
    expect(preview.units.map(unit => unit.text)).toEqual(['First page', '', 'Third page'])
    expect(preview.units.map(unit => unit.sourceLocator)).toEqual([{ kind: 'pdf', page: 1 }, { kind: 'pdf', page: 2 }, { kind: 'pdf', page: 3 }])
    expect(preview.warnings.join(' ')).toContain('1 page(s)')
    expect(await fs.readdir(cwd)).toEqual([])
    const selected = service.select(preview.id, ['page-3', 'page-1'])
    expect(selected.files).toHaveLength(2)
    expect(selected.files[1]!.content).toContain('PDF physical page 3')
    expect(selected.files[1]!.content).toContain(preview.sha256)
    preview.units[0]!.text = 'tamper'
    expect(service.getPreview(preview.id).units[0]!.text).toBe('First page')
    expect(() => service.select(preview.id, ['page-2'])).toThrow(/no extractable text/)
  }, 30_000)
  it('extracts Chinese from a real PDF ToUnicode CMap', async () => {
    const { service } = await fixture()
    const preview = await service.parse({ name: '中文.pdf', bytes: pdf(['Chinese'], false, true) })
    expect(preview.units[0]!.text).toBe('中文')
  })
  it('preserves DOCX Chinese paragraphs and tables in body order without fabricated page numbers', async () => {
    const { service } = await fixture()
    const preview = await service.parse({ name: '中文.docx', bytes: docx('<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>表格乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>末段</w:t></w:r></w:p>') })
    expect(preview.units.map(unit => unit.sourceLocator)).toEqual([{ kind: 'docx', block: 1, blockType: 'paragraph' }, { kind: 'docx', block: 2, blockType: 'table' }, { kind: 'docx', block: 3, blockType: 'paragraph' }])
    expect(preview.units.map(unit => unit.text)).toEqual(['第一段', '表格甲\n\t表格乙\n\t', '末段'])
  })
  it('rejects corrupt, encrypted and textless PDFs', async () => {
    const { service } = await fixture()
    await expect(service.parse({ name: 'bad.pdf', bytes: Buffer.from('%PDF-invalid') })).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' })
    await expect(service.parse({ name: 'locked.pdf', bytes: pdf(['secret'], true) })).rejects.toMatchObject({ code: 'ENCRYPTED' })
    await expect(service.parse({ name: 'scan.pdf', bytes: pdf([''], false, false, true) })).rejects.toMatchObject({ code: 'NO_TEXT' })
  })
  it('ignores external DOCX relationships without fetching their resources', async () => {
    let requests = 0
    const server = createServer((_req, res) => { requests++; res.end('external') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as { port: number }).port, { service } = await fixture()
      const preview = await service.parse({ name: 'linked.docx', bytes: docx(undefined, { 'word/_rels/document.xml.rels': strToU8(`<Relationships xmlns="${R}"><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="http://127.0.0.1:${port}/image.png"/></Relationships>`) }) })
      expect(preview.warnings.join(' ')).toContain('External relationships were ignored')
      expect(requests).toBe(0)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it('rejects corrupt ZIPs, unsafe paths, duplicate sizes, macros, entities and expansion bombs', async () => {
    const { service } = await fixture()
    const bad: [Uint8Array, string][] = [
      [docx(undefined, { '../escape.xml': strToU8('x') }), 'INVALID_ZIP'],
      [docx(undefined, { 'word/vbaProject.bin': new Uint8Array([1]) }), 'INVALID_DOCX'],
      [docx(undefined, { 'word/document.xml': strToU8(`<!DOCTYPE x [<!ENTITY x SYSTEM "file:///secret">]><w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>`) }), 'INVALID_DOCX'],
      [docx(undefined, { 'word/bomb.xml': strToU8('A'.repeat(1024 * 1024)) }, 6), 'ZIP_LIMIT'],
    ]
    const damaged = docx(); damaged[60] = damaged[60]! ^ 1; bad.push([damaged, 'INVALID_ZIP'])
    const forged = Buffer.from(docx(undefined, { 'word/bomb.xml': strToU8('0123456789'.repeat(2000)) }, 6))
    for (let at = 0; at < forged.length - 46; at++) {
      if (forged.readUInt32LE(at) !== 0x02014b50) continue
      const size = forged.readUInt32LE(at + 24), compressed = forged.readUInt32LE(at + 20)
      if (size <= compressed * 20) continue
      const start = forged.readUInt32LE(at + 42)
      forged.writeUInt32LE(1, at + 24); forged.writeUInt32LE(1, start + 22)
    }
    bad.push([forged, 'INVALID_ZIP'])
    const huge = Buffer.from(docx())
    const central = huge.indexOf(Buffer.from([0x50, 0x4b, 1, 2]))
    huge.writeUInt32LE(L.maxZipEntryBytes + 1, central + 24)
    bad.push([huge, 'ZIP_LIMIT'])
    const locked = Buffer.from(docx()); const lockCentral = locked.indexOf(Buffer.from([0x50, 0x4b, 1, 2]))
    locked.writeUInt16LE(1, 6); locked.writeUInt16LE(1, lockCentral + 8); bad.push([locked, 'ENCRYPTED'])
    for (const [bytes, code] of bad) await expect(service.parse({ name: 'bad.docx', bytes })).rejects.toMatchObject({ code })
    const count = Object.fromEntries(Array.from({ length: L.maxZipEntries }, (_, i) => [`word/extra${i}.xml`, strToU8('x')]))
    await expect(service.parse({ name: 'many.docx', bytes: docx(undefined, count) })).rejects.toMatchObject({ code: 'ZIP_LIMIT' })
  })
  it('fails page/text/file budgets without silently truncating and supports timeout/cancellation', async () => {
    const { service } = await fixture()
    await expect(service.parse({ name: 'pages.pdf', bytes: pdf(Array.from({ length: L.maxPages + 1 }, () => 'x')) })).rejects.toMatchObject({ code: 'PAGE_LIMIT' })
    await expect(service.parse({ name: 'large.docx', bytes: docx(`<w:p><w:r><w:t>${'x'.repeat(L.maxCharacters + 1)}</w:t></w:r></w:p>`) })).rejects.toMatchObject({ code: 'TEXT_LIMIT' })
    const preview = await service.parse({ name: 'file.docx', bytes: docx(`<w:p><w:r><w:t>${'x'.repeat(L.maxFileBytes)}</w:t></w:r></w:p>`) })
    expect(() => service.select(preview.id, ['block-1'])).toThrow(/select fewer units/)
    const pre = new AbortController(); pre.abort()
    await expect(service.parse({ name: 'cancel.pdf', bytes: pdf() }, pre.signal)).rejects.toMatchObject({ code: 'CANCELLED' })
    const controller = new AbortController(), parsing = service.parse({ name: 'cancel.pdf', bytes: pdf() }, controller.signal)
    controller.abort(); await expect(parsing).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(runParser(pdf(), 'pdf', undefined, 1)).rejects.toMatchObject({ code: 'TIMEOUT' })
    service.discard(preview.id)
    expect(() => service.getPreview(preview.id)).toThrow(/expired/)
  })
})

describe('confirmed originals and versioned provenance', () => {
  it('publishes originals with CAS, survives restart and provides a validated backup closure', async () => {
    const { cwd, service } = await fixture(), bytes = docx(), preview = await service.parse({ name: 'reference.docx', bytes })
    const baseline = await service.store.snapshot(), first = await service.persistSelection(preview.id, ['block-1'], baseline)
    expect(first.revision).toBe(1)
    const restarted = new DocumentStore(cwd)
    expect(Buffer.from(await restarted.readOriginal(preview.sha256))).toEqual(Buffer.from(bytes))
    const inventory = await restarted.inventory()
    expect(inventory.files.map(file => file.path)).toEqual(['.sakura/documents/manifest.json', `.sakura/documents/originals/${preview.sha256}.bin`])
    expect(validateDocumentSnapshot(inventory.manifest, inventory.originals)).toEqual(first.manifest)
    expect(() => validateDocumentSnapshot(inventory.manifest, new Map())).toThrow()
    await expect(service.persistSelection(preview.id, ['block-1'], baseline)).rejects.toMatchObject({ code: 'CONFLICT' })
    const second = await service.persistSelection(preview.id, ['block-1'], first)
    expect(second.revision).toBe(2); expect(second.manifest.artifacts).toHaveLength(1)
    const next = await service.parse({ name: 'next.docx', bytes: docx('<w:p><w:r><w:t>下一轮</w:t></w:r></w:p>') })
    const third = await service.persistSelection(next.id, ['block-1'], second)
    expect(third.manifest.originals).toHaveLength(2)
    expect(third.manifest.artifacts).toHaveLength(2)
    const corrupted = await restarted.inventory(); corrupted.originals.get(preview.sha256)![0] ^= 1
    expect(() => validateDocumentSnapshot(corrupted.manifest, corrupted.originals)).toThrow()
    expect(await fs.readdir(path.join(cwd, '.sakura'))).toEqual(['documents'])
  })
  it('does not publish after cancellation/current-workspace failure, excludes orphan files and detects tampering', async () => {
    const { cwd, service } = await fixture(), preview = await service.parse({ name: 'reference.docx', bytes: docx() })
    const baseline = await service.store.snapshot()
    await expect(service.persistSelection(preview.id, ['block-1'], baseline, { assertCurrent() { throw new Error('workspace switched') } })).rejects.toThrow('workspace switched')
    expect(await fs.readdir(cwd)).toEqual([])
    const committed = await service.persistSelection(preview.id, ['block-1'], baseline)
    await fs.writeFile(path.join(cwd, '.sakura/documents/originals', `${'a'.repeat(64)}.bin`), 'orphan')
    expect((await service.store.inventory()).files).toHaveLength(2)
    await fs.writeFile(path.join(cwd, '.sakura/documents/originals', `${preview.sha256}.bin`), 'tampered')
    await expect(service.store.readOriginal(preview.sha256)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(service.persistSelection(preview.id, ['block-1'], committed)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await service.store.snapshot()).revision).toBe(committed.revision)
  })
  it('rejects incompatible artifact provenance and permits only one simultaneous CAS publication', async () => {
    const { cwd, service } = await fixture(), bytes = docx(), preview = await service.parse({ name: 'one.docx', bytes })
    const baseline = await service.store.snapshot()
    const outcomes = await Promise.allSettled([
      service.persistSelection(preview.id, ['block-1'], baseline),
      new DocumentStore(cwd).commit({ bytes, kind: 'docx', artifacts: service.select(preview.id, ['block-1']).artifacts }, baseline),
    ])
    expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1)
    const state = await service.store.snapshot(), selection = service.select(preview.id, ['block-1'])
    selection.artifacts[0]!.name = 'different.docx'
    await expect(service.store.commit({ bytes, kind: 'docx', artifacts: selection.artifacts }, state)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await service.store.snapshot()).revision).toBe(1)
  })
  it('rejects linked storage and locked metadata without following or stealing it', async () => {
    const { cwd, service } = await fixture(), other = await fixture()
    await fs.mkdir(path.join(cwd, '.sakura'))
    await fs.symlink(other.cwd, path.join(cwd, '.sakura/documents'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.store.snapshot()).rejects.toMatchObject({ code: 'UNSAFE_PATH' })
    expect(await fs.readdir(other.cwd)).toEqual([])
    await fs.unlink(path.join(cwd, '.sakura/documents'))
    const preview = await service.parse({ name: 'reference.docx', bytes: docx() }), baseline = await service.store.snapshot()
    await fs.mkdir(path.join(cwd, '.sakura/documents'))
    await fs.writeFile(path.join(cwd, '.sakura/documents/store.lock'), 'other owner')
    await expect(service.persistSelection(preview.id, ['block-1'], baseline)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await fs.readFile(path.join(cwd, '.sakura/documents/store.lock'), 'utf8')).toBe('other owner')
  })
})
