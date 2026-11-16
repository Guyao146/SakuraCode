import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { DOCUMENT_LIMITS as L, DocumentError, type DocumentKind, type ParsedDocument } from './types.js'
let source: Promise<string> | undefined
async function workerSource(): Promise<string> {
  return source ??= (async () => {
    try {
      // @ts-expect-error virtual module is provided only by the SEA builder
      const embedded = await import('sakura-document-parser-embed') as { default: string }
      if (typeof embedded.default === 'string') return embedded.default
    } catch { /* tsx/dist use local, application-owned resources */ }
    try { return await readFile(new URL('./parser-worker.cjs', import.meta.url), 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    // Source-mode preflight stays in a separate Node process so Vitest's own esbuild version cannot leak in.
    // Published dist never needs esbuild or a writable app directory.
    if (!fileURLToPath(import.meta.url).replaceAll('\\', '/').includes('/src/documents/')) throw new DocumentError('PARSER_UNAVAILABLE', 'Document parser resource is missing; rebuild the application', 503)
    const script = fileURLToPath(new URL('../../scripts/build-document-parser.mjs', import.meta.url))
    const built = await promisify(execFile)(process.execPath, [script, '--stdout'], { windowsHide: true,
      cwd: fileURLToPath(new URL('../../', import.meta.url)), maxBuffer: 24 * 1024 * 1024, timeout: L.timeoutMs })
    return built.stdout
  })().catch(error => { source = undefined; throw error })
}
export async function runParser(bytes: Uint8Array, kind: DocumentKind, signal?: AbortSignal, timeoutMs: number = L.timeoutMs): Promise<ParsedDocument> {
  if (signal?.aborted) throw new DocumentError('CANCELLED', 'Document parsing cancelled', 499)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > L.timeoutMs) throw new DocumentError('INVALID_TIMEOUT', 'Parser timeout is outside its allowed range')
  return new Promise((resolve, reject) => {
    let worker: Worker | undefined, settled = false, logBytes = 0
    const finish = (error?: unknown, result?: ParsedDocument) => {
      if (settled) return
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (worker) void worker.terminate().catch(() => {})
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => finish(new DocumentError('CANCELLED', 'Document parsing cancelled', 499))
    const timer = setTimeout(() => finish(new DocumentError('TIMEOUT', 'Document parsing timed out', 408)), timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) { abort(); return }
    void workerSource().then(code => {
      if (settled) return
      worker = new Worker(code, { eval: true, workerData: { kind, bytes }, execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } })
      // A malformed document cannot stream unbounded diagnostics to the application UI.
      const log = (chunk: Buffer) => { if ((logBytes += chunk.length) > 64 * 1024) finish(new DocumentError('OUTPUT_LIMIT', 'Parser diagnostic limit exceeded', 413)) }
      worker.stdout.on('data', log); worker.stderr.on('data', log)
      worker.once('error', error => finish(new DocumentError('PARSER_FAILED', `Document parser failed: ${error.message.slice(0, 160)}`, 400)))
      worker.once('exit', () => { if (!settled) finish(new DocumentError('PARSER_FAILED', 'Document parser exited without a result')) })
      worker.once('message', (message: { ok: boolean; result?: ParsedDocument; code?: string; message?: string; status?: number }) => {
        if (!message?.ok) { finish(new DocumentError(message?.code ?? 'PARSER_FAILED', message?.message ?? 'Document parsing failed', message?.status ?? 400)); return }
        const result = message.result
        if (!result || result.kind !== kind || !Array.isArray(result.units) || result.units.length > L.maxUnits || !Array.isArray(result.warnings) || Buffer.byteLength(JSON.stringify(result)) > L.maxOutputBytes) {
          finish(new DocumentError('OUTPUT_LIMIT', 'Invalid or oversized parser response', 413)); return
        }
        finish(undefined, result)
      })
    }).catch(error => finish(error))
  })
}
