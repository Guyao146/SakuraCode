import type { IncomingMessage, ServerResponse } from 'node:http'

/** A request-scoped failure carrying the status the client should see. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** Bounded JSON object reader. Errors are client errors, never accidental 500s. */
export async function readJson(
  req: IncomingMessage,
  timeoutMs = 15_000,
  cap = 16 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const raw = await new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error): void => {
      clearTimeout(timer)
      req.off('data', data)
      req.off('end', end)
      req.off('error', fail)
      req.off('aborted', aborted)
      if (error) {
        chunks.length = 0
        req.resume()
        reject(error)
      } else resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const data = (chunk: Buffer): void => {
      size += chunk.length
      if (size > cap) finish(new HttpError(413, 'request body too large'))
      else chunks.push(chunk)
    }
    const end = (): void => finish()
    const fail = (error: Error): void => finish(error)
    const aborted = (): void => finish(new HttpError(400, 'request aborted'))
    const timer = setTimeout(() => finish(new HttpError(408, 'request body timed out')), timeoutMs)
    req.on('data', data)
    req.once('end', end)
    req.once('error', fail)
    req.once('aborted', aborted)
  })
  let value: unknown
  try { value = JSON.parse(raw || '{}') } catch { throw new HttpError(400, 'invalid JSON body') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}