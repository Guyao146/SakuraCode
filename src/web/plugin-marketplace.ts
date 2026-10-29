/** Public npm metadata only. Searching never installs/imports a package or executes its code. */
import { HttpError } from './http.js'

export const PLUGIN_MARKETPLACE_ORIGIN = 'https://registry.npmjs.org'
export const PLUGIN_MARKETPLACE_KEYWORD = 'sakuracode-plugin'
const PAGE_SIZE = 20
const MAX_BODY_BYTES = 1024 * 1024
const CACHE_MS = 5 * 60_000

export interface PluginMarketItem {
  name: string
  version: string
  description: string
  npmUrl: string
}

export interface PluginMarketResult {
  source: 'npm'
  query: string
  page: number
  pageSize: number
  total: number
  items: PluginMarketItem[]
  checkedAt: string
}

export interface PluginMarketplaceOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
}

function searchInput(query: unknown, page: unknown): { query: string; page: number } {
  if (typeof query !== 'string' || query.length > 120 || /[\x00-\x1f\x7f]/.test(query)) {
    throw new HttpError(400, '搜索关键词最多 120 个字符，不能包含控制字符。')
  }
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 50) {
    throw new HttpError(400, '市场页码须为 1–50 的整数。')
  }
  return { query: query.trim().replace(/\s+/g, ' '), page }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function marketItems(objects: unknown[]): PluginMarketItem[] {
  const seen = new Set<string>(), items: PluginMarketItem[] = []
  for (const value of objects) {
    const pkg = record(record(value)?.package)
    const name = pkg?.name
    if (typeof name !== 'string' || name.length > 214 ||
      !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) || seen.has(name)) continue
    // Registry full-text search can return unrelated packages. Only expose
    // packages explicitly advertised by their publisher as SakuraCode plugins.
    if (!Array.isArray(pkg?.keywords) || !pkg.keywords.includes(PLUGIN_MARKETPLACE_KEYWORD)) continue
    if (typeof pkg.version !== 'string' || !/^[0-9A-Za-z.+-]{1,80}$/.test(pkg.version)) continue
    seen.add(name)
    items.push({ name, version: pkg.version,
      description: typeof pkg.description === 'string' ? pkg.description.slice(0, 1000) : '',
      // Do not trust arbitrary URLs (including npm links) in registry metadata.
      npmUrl: 'https://www.npmjs.com/package/' + name })
    if (items.length === PAGE_SIZE) break
  }
  return items
}

export class PluginMarketplace {
  private readonly fetcher: typeof globalThis.fetch | undefined
  private readonly timeoutMs: number
  private readonly cache = new Map<string, { savedAt: number; result: PluginMarketResult }>()
  private readonly flights = new Map<string, Promise<PluginMarketResult>>()
  private readonly shutdown = new AbortController()

  constructor(options: PluginMarketplaceOptions = {}) {
    this.fetcher = options.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error('marketplace timeout must be 1–60000 ms')
    }
  }

  search(query: unknown = '', page: unknown = 1): Promise<PluginMarketResult> {
    const input = searchInput(query, page)
    if (this.shutdown.signal.aborted) return Promise.reject(new HttpError(503, '插件市场连接已关闭。'))
    const key = JSON.stringify(input), cached = this.cache.get(key)
    if (cached && Date.now() - cached.savedAt < CACHE_MS) return Promise.resolve(structuredClone(cached.result))
    const current = this.flights.get(key)
    if (current) return current.then(result => structuredClone(result))
    if (this.flights.size >= 3) return Promise.reject(new HttpError(429, '市场搜索请求过多，请稍后重试。'))
    const flight = this.queryWithDeadline(input).then(result => {
      this.shutdown.signal.throwIfAborted()
      this.cache.delete(key)
      this.cache.set(key, { savedAt: Date.now(), result })
      while (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!)
      return result
    }).finally(() => { this.flights.delete(key) })
    this.flights.set(key, flight)
    return flight.then(result => structuredClone(result))
  }

  close(): void {
    this.shutdown.abort()
    this.cache.clear()
  }

  private async queryWithDeadline(input: { query: string; page: number }): Promise<PluginMarketResult> {
    const timerController = new AbortController()
    const timer = setTimeout(() => timerController.abort(), this.timeoutMs)
    const signal = AbortSignal.any([this.shutdown.signal, timerController.signal])
    let onAbort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new HttpError(this.shutdown.signal.aborted ? 503 : 504,
        this.shutdown.signal.aborted ? '插件市场连接已关闭。' : '插件市场搜索超时，请检查网络后重试。'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // Also bounds test/custom transports that do not honour AbortSignal.
      const result = await Promise.race([this.query(input, signal), cancelled])
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (this.shutdown.signal.aborted) throw new HttpError(503, '插件市场连接已关闭。')
      if (timerController.signal.aborted) throw new HttpError(504, '插件市场搜索超时，请检查网络后重试。')
      // Do not reflect external errors, response bodies or credentials to the page/log.
      throw new HttpError(502, '无法连接 npm 插件市场，请检查网络后重试。本地插件仍可使用。')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }

  private async query(input: { query: string; page: number }, signal: AbortSignal): Promise<PluginMarketResult> {
    const url = new URL('/-/v1/search', PLUGIN_MARKETPLACE_ORIGIN)
    // Quoting prevents user-supplied npm qualifiers from changing the plugin scope.
    const term = input.query.replace(/["\\]/g, ' ')
    url.searchParams.set('text', `keywords:${PLUGIN_MARKETPLACE_KEYWORD}${term ? ' "' + term + '"' : ''}`)
    url.searchParams.set('size', String(PAGE_SIZE))
    url.searchParams.set('from', String((input.page - 1) * PAGE_SIZE))
    // Match the account transport: resolve the default at request time so
    // mounted plugins can instrument network calls; an injected transport is pinned.
    const response = await (this.fetcher ?? globalThis.fetch)(url.href, { method: 'GET', signal, credentials: 'omit', redirect: 'error',
      headers: { accept: 'application/json' } })
    if (signal.aborted || !response.ok || !response.body ||
      Number(response.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      await response.body?.cancel().catch(() => {})
      signal.throwIfAborted()
      throw new HttpError(502, response.status === 429 ? 'npm 市场暂时限流，请稍后重试。' : 'npm 市场返回了无效响应，请稍后重试。')
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []
    const cancel = () => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancel, { once: true })
    let size = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const chunk = await reader.read()
        signal.throwIfAborted()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_BODY_BYTES) throw new HttpError(502, 'npm 市场响应过大，请缩小搜索范围。')
        chunks.push(chunk.value)
      }
      const data = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      if (!Array.isArray(data?.objects) || data.objects.length > 100 ||
        !Number.isSafeInteger(data.total) || Number(data.total) < 0) throw new HttpError(502, 'npm 市场响应格式无效。')
      return { source: 'npm', ...input, pageSize: PAGE_SIZE, total: Number(data.total),
        items: marketItems(data.objects), checkedAt: new Date().toISOString() }
    } finally {
      signal.removeEventListener('abort', cancel)
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}