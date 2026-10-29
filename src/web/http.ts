import type { IncomingMessage, ServerResponse } from 'node:http'

/** Fetch/Chromium restricted ports. Random local web and authorization ports
 * must be browser-usable; explicit server ports remain caller-controlled.
 * https://fetch.spec.whatwg.org/#port-blocking */
export const BLOCKED_WEB_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566,
  4190, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
])

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