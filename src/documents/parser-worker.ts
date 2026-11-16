import { parentPort, workerData } from 'node:worker_threads'
import { DocumentError, DOCUMENT_LIMITS as L, type ParsedDocument, type DocumentUnit } from './types.js'
import { parseDocx } from './docx.js'
// @ts-expect-error build-only module: resources embedded by build-document-parser.mjs
import assets from 'sakura-document-parser-assets'

// Compatibility with the full supported Node 20 range; PDF.js uses this Node 22 API.
const promise = Promise as unknown as { withResolvers?: () => unknown }
if (!promise.withResolvers) Object.defineProperty(Promise, 'withResolvers', { value: function () {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void
  const p = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise: p, resolve, reject }
} })
const deny = () => { throw new DocumentError('EXTERNAL_RESOURCE', 'External resource access is disabled') }
Object.defineProperty(globalThis, 'fetch', { value: deny, configurable: false, writable: false })
// This is a resource-limited worker, not an OS security sandbox. Inputs are never URLs.
class NoCanvas { create = deny; reset = deny; destroy() {} }
function resource(name: string) {
  const value: unknown = Object.prototype.hasOwnProperty.call(assets, name) ? assets[name] : undefined
  if (typeof value !== 'string') throw new DocumentError('MISSING_RESOURCE', 'Unsupported PDF built-in resource')
  return Uint8Array.from(Buffer.from(value, 'base64'))
}
class CMaps { async fetch({ name }: { name: string }) { return { cMapData: resource(`cmaps/${name}.bcmap`), isCompressed: true } } }
class Fonts { async fetch({ filename }: { filename: string }) { return resource(`standard_fonts/${filename}`) } }
async function parsePdf(bytes: Uint8Array): Promise<ParsedDocument> {
  // Both imports become local bundle modules. No automatic worker path import is reached.
  // @ts-expect-error PDF.js build exports share the package's API typings
  const pdf = await import('pdfjs-dist/build/pdf.mjs')
  // @ts-expect-error worker handler has no public declaration file
  const handler = await import('pdfjs-dist/build/pdf.worker.mjs')
  Object.assign(globalThis, { pdfjsWorker: { WorkerMessageHandler: handler.WorkerMessageHandler } })
  let pdfWarnings = 0
  const originalLog = console.log, originalWarn = console.warn
  const warning = (...args: unknown[]) => { if (args.some(value => typeof value === 'string' && value.startsWith('Warning:'))) pdfWarnings++ }
  console.log = warning; console.warn = warning
  const task = pdf.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false, enableXfa: false, disableAutoFetch: true, disableStream: true,
    disableRange: true, stopAtErrors: true, maxImageSize: 0, verbosity: 1,
    CanvasFactory: NoCanvas, CMapReaderFactory: CMaps, StandardFontDataFactory: Fonts })
  try {
    const document = await task.promise
    const metadata = await document.getMetadata()
    if (metadata.info?.EncryptFilterName) throw new DocumentError('ENCRYPTED', 'Encrypted PDF documents are unsupported')
    if (metadata.info?.IsXFA) throw new DocumentError('UNSUPPORTED_PDF', 'XFA PDF documents are unsupported')
    if (document.numPages > L.maxPages) throw new DocumentError('PAGE_LIMIT', 'PDF exceeds the page limit', 413)
    const units: DocumentUnit[] = [], warnings: string[] = []
    let characters = 0, empty = 0
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number), reader = page.streamTextContent({ includeMarkedContent: false }).getReader()
      let text = ''
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          for (const item of chunk.value.items) {
            if (typeof item.str !== 'string') continue
            const part = item.str + (item.hasEOL ? '\n' : ' ')
            characters += part.length
            if (characters > L.maxCharacters) throw new DocumentError('TEXT_LIMIT', 'PDF text exceeds the preview character limit', 413)
            text += part
          }
        }
      } finally { await reader.cancel().catch(() => {}); page.cleanup() }
      text = text.trim()
      if (!text) empty++
      units.push({ id: `page-${number}`, label: `Page ${number}`, text, sourceLocator: { kind: 'pdf', page: number } })
    }
    if (empty === units.length) throw new DocumentError('NO_TEXT', 'PDF has no extractable text; scanned PDFs require OCR, which is not supported')
    if (empty) warnings.push(`${empty} page(s) contain no extractable text; those pages may be blank or scanned. No OCR was performed.`)
    if (pdfWarnings) warnings.push('PDF.js reported recoverable document/font warnings; verify extracted text against the original before importing.')
    warnings.push('PDF locations are physical page numbers. Text order and layout may differ from the rendered document.')
    return { kind: 'pdf', units, warnings }
  } catch (error) {
    if ((error as Error)?.name === 'PasswordException') throw new DocumentError('ENCRYPTED', 'Encrypted PDF documents are unsupported')
    throw error
  } finally { try { await task.destroy() } finally { console.log = originalLog; console.warn = originalWarn } }
}
async function main() {
  if (!parentPort) throw new Error('Document parser must run in a worker')
  try {
    const bytes: Uint8Array = workerData.bytes, kind = workerData.kind
    if (!(bytes instanceof Uint8Array) || bytes.length > L.maxInputBytes) throw new DocumentError('INPUT_LIMIT', 'Document input exceeds the byte limit', 413)
    const result = kind === 'pdf' ? await parsePdf(bytes) : kind === 'docx' ? parseDocx(bytes) : deny()
    if (Buffer.byteLength(JSON.stringify(result)) > L.maxOutputBytes) throw new DocumentError('OUTPUT_LIMIT', 'Document preview exceeds the output limit', 413)
    parentPort.postMessage({ ok: true, result })
  } catch (error) {
    const known = error instanceof DocumentError
    parentPort.postMessage({ ok: false, code: known ? error.code : 'INVALID_DOCUMENT', status: known ? error.status : 400,
      message: known ? error.message : 'Document is invalid or contains unsupported text structures' })
  } finally { parentPort.close() }
}
void main()
