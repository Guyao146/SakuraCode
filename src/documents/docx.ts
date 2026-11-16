import { SaxesParser, type SaxesTagNS } from 'saxes'
import { readDocxZip } from './zip.js'
import { DOCUMENT_LIMITS as L, DocumentError, type ParsedDocument, type DocumentUnit } from './types.js'
const WORD = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const bad = (message: string): never => { throw new DocumentError('INVALID_DOCX', message) }
function xml(bytes: Uint8Array, open: (tag: SaxesTagNS) => void, close?: (tag: SaxesTagNS) => void, text?: (value: string) => void) {
  let depth = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => bad('DTD and entity declarations are forbidden'))
  parser.on('processinginstruction', () => bad('XML processing instructions are unsupported'))
  parser.on('error', error => bad(`Malformed DOCX XML: ${error.message}`))
  parser.on('opentag', tag => { if (++depth > 128) bad('DOCX XML nesting limit exceeded'); open(tag) })
  parser.on('closetag', tag => { close?.(tag); depth-- })
  parser.on('text', value => text?.(value)); parser.on('cdata', value => text?.(value))
  parser.write(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).close()
}
export function parseDocx(bytes: Uint8Array): ParsedDocument {
  const files = readDocxZip(bytes), warnings: string[] = [], units: DocumentUnit[] = []
  const document = files.get('word/document.xml'), contentTypes = files.get('[Content_Types].xml'), rootRels = files.get('_rels/.rels')
  if (!document || !contentTypes || !rootRels) bad('DOCX package is missing its document or package metadata')
  for (const name of files.keys()) if (/vbaproject|(?:^|\/)embeddings\/|activex\/|(?:^|\/)customui\/|\.bin$/i.test(name)) bad('Macros, embedded objects and active content are forbidden')
  let hasMainType = false, hasMainRel = false, external = false
  xml(contentTypes!, tag => {
    if (tag.local !== 'Override') return
    const type = tag.attributes.ContentType?.value, part = tag.attributes.PartName?.value
    if (type && /macroenabled|vba|oleobject|activex/i.test(type)) bad('Active DOCX content type is forbidden')
    if (part === '/word/document.xml' && type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') hasMainType = true
  })
  for (const [name, data] of files) if (name.endsWith('.rels')) xml(data, tag => {
    if (tag.uri !== REL || tag.local !== 'Relationship') return
    const mode = tag.attributes.TargetMode?.value, target = tag.attributes.Target?.value, type = tag.attributes.Type?.value ?? ''
    if (/oleObject|aFChunk|attachedTemplate|vbaProject|package$/i.test(type)) bad('Embedded or active DOCX relationships are forbidden')
    if (mode === 'External') { external = true; return }
    if (mode && mode !== 'Internal') bad('Invalid DOCX relationship mode')
    if (name === '_rels/.rels' && /\/officeDocument$/.test(type) && target === 'word/document.xml') hasMainRel = true
  })
  if (!hasMainType || !hasMainRel) bad('DOCX main document relationship or content type is invalid')
  if (external) warnings.push('External relationships were ignored; no linked resources were fetched.')
  let body = false, bodySeen = false, paragraph = 0, table = 0, inText = 0, ignored = 0, block = 0, chars = 0
  let active: { type: 'paragraph' | 'table'; text: string } | undefined
  const add = (value: string) => {
    if (!active || ignored) return
    chars += value.length
    if (chars > L.maxCharacters) throw new DocumentError('TEXT_LIMIT', 'DOCX text exceeds the preview character limit', 413)
    active.text += value
  }
  const finish = () => {
    if (!active) return
    const type = active.type, text = active.text.replace(/\n+$/, '')
    block++
    if (units.length >= L.maxUnits) throw new DocumentError('UNIT_LIMIT', 'DOCX contains too many blocks', 413)
    units.push({ id: `block-${block}`, label: `${type === 'paragraph' ? 'Paragraph' : 'Table'} ${block}`, text,
      sourceLocator: { kind: 'docx', block, blockType: type } })
    active = undefined
  }
  xml(document!, tag => {
    const w = WORD.has(tag.uri), local = w ? tag.local : ''
    if (local === 'body') { if (bodySeen) bad('Duplicate DOCX body'); body = bodySeen = true }
    if (!body) return
    if (['altChunk', 'object', 'subDoc'].includes(local)) bad('Embedded or external DOCX content is unsupported')
    if (local === 'del') ignored++
    if (local === 'tbl') { if (!table && !active) active = { type: 'table', text: '' }; table++ }
    if (local === 'p') { if (!table && !paragraph) active = { type: 'paragraph', text: '' }; paragraph++ }
    if (local === 't') inText++
    if (local === 'tab') add('\t')
    if (local === 'br' || local === 'cr') add('\n')
    if (['drawing', 'pict', 'footnoteReference', 'endnoteReference'].includes(local) && !warnings.includes('Images, notes and layout are not included in extracted body text.')) warnings.push('Images, notes and layout are not included in extracted body text.')
  }, tag => {
    const local = WORD.has(tag.uri) ? tag.local : ''
    if (body) {
      if (local === 't') inText--
      if (local === 'p') { paragraph--; if (table) add('\n'); else if (!paragraph) finish() }
      if (local === 'tc') add('\t')
      if (local === 'tr') add('\n')
      if (local === 'tbl') { table--; if (!table) finish() }
      if (local === 'del') ignored--
      if (local === 'body') body = false
    }
  }, value => { if (inText && body) add(value) })
  if (!bodySeen) bad('DOCX document body is missing')
  if (!units.some(unit => unit.text.trim())) throw new DocumentError('NO_TEXT', 'DOCX has no extractable body text')
  warnings.push('DOCX locations identify body blocks, not rendered page numbers.')
  return { kind: 'docx', units, warnings }
}
