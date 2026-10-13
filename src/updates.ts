/** Stable-release checks. Failures retain the last known result; notices are claimed once per version. */

export interface UpdateInfo {
  current: string
  latest?: string
  hasUpdate: boolean
  /** Canonical HTTPS link to this project's release tag, never an arbitrary feed URL. */
  releaseUrl?: string
  /** Last completed check attempt, including a failed attempt. */
  checkedAt?: string
  error?: string
}

export interface UpdateCheckerOptions {
  fetch?: typeof globalThis.fetch
  /** Covers both response headers and body. Defaults to 10 seconds. */
  timeoutMs?: number
}

export const DEFAULT_UPDATES_URL = 'https://api.github.com/repos/Guyao146/SakuraCode/releases/latest'
const RELEASE_TAG_URL = 'https://github.com/Guyao146/SakuraCode/releases/tag/'
const MAX_BODY_BYTES = 1024 * 1024

interface Version {
  core: string[]
  prerelease: string[]
  /** Build metadata does not change SemVer precedence or notification identity. */
  key: string
}

function parseVersion(version: string): Version {
  const value = version.trim().replace(/^v/i, '')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) throw new Error('invalid semantic version')
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error('invalid semantic version')
  }
  const core = [match[1]!, match[2]!, match[3]!]
  return { core, prerelease, key: core.join('.') + (prerelease.length ? '-' + prerelease.join('.') : '') }
}

/** Compare decimal strings without Number rounding or overflow. Inputs have no leading zeroes. */
function compareNumeric(a: string, b: string): number {
  return Math.sign(a.length - b.length) || (a === b ? 0 : a < b ? -1 : 1)
}

/** Standard SemVer precedence (optional leading v); invalid versions throw. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const order = compareNumeric(pa.core[i]!, pb.core[i]!)
    if (order) return order
  }
  if (!pa.prerelease.length || !pb.prerelease.length) {
    return pa.prerelease.length ? -1 : pb.prerelease.length ? 1 : 0
  }
  for (let i = 0; i < Math.max(pa.prerelease.length, pb.prerelease.length); i++) {
    const x = pa.prerelease[i]
    const y = pb.prerelease[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return compareNumeric(x, y)
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  return 0
}

interface CheckFlight {
  controller: AbortController
  owners: Map<AbortSignal, () => void>
  cancelled: boolean
  promise: Promise<UpdateInfo>
}

export class UpdateChecker {
  private cache: UpdateInfo | undefined
  private readonly notified = new Set<string>()
  private readonly fetcher: typeof globalThis.fetch
  private readonly timeoutMs: number
  private flight: CheckFlight | undefined
  private closed = false

  constructor(
    private readonly current: string,
    private readonly url: string = DEFAULT_UPDATES_URL,
    options: UpdateCheckerOptions = {},
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new Error('update timeout must be a positive timer duration')
    }
  }

  cached(): UpdateInfo | undefined {
    return this.cache && { ...this.cache }
  }

  /** True after a successful checkAndDetectChange has claimed at least one version. */
  notifiedOfUpdate(): boolean {
    return this.notified.size > 0
  }

  /**
   * Coalesces concurrent calls into one fetch. Every supplied signal represents
   * a SHARED lifecycle: aborting any participant cancels the request for all of
   * them. Use a common server/CLI signal, not one HTTP client's disconnect signal.
   * A caller abort leaves the cache unchanged; a timeout/source error preserves
   * the last successful version fields and caches error/checkedAt. Never throws.
   */
  check(signal?: AbortSignal): Promise<UpdateInfo> {
    if (this.closed) return Promise.resolve(this.failure('update checker is closed'))
    if (this.flight) {
      this.addOwner(this.flight, signal)
      return this.flight.promise
    }
    if (signal?.aborted) return Promise.resolve(this.failure('update check cancelled'))
    const flight: CheckFlight = {
      controller: new AbortController(), owners: new Map(), cancelled: false,
      promise: Promise.resolve({ current: this.current, hasUpdate: false }),
    }
    this.flight = flight
    this.addOwner(flight, signal)
    // Publish the flight before invoking even a synchronous injected fetch.
    flight.promise = Promise.resolve().then(() => this.run(flight))
    return flight.promise
  }

  /** Only this method claims notifications; check() may refresh data without consuming a notice. */
  async checkAndDetectChange(signal?: AbortSignal): Promise<{ info: UpdateInfo; isNew: boolean }> {
    const info = await this.check(signal)
    if (this.closed || signal?.aborted || info.error || !info.hasUpdate || !info.latest) return { info, isNew: false }
    const key = parseVersion(info.latest).key
    // Claim after the await: concurrent waiters on the same flight get one winner.
    const isNew = !this.notified.has(key)
    if (isNew) this.notified.add(key)
    return { info, isNew }
  }

  /** Idempotent. Aborts in-flight work, prevents new checks and never rewrites the cache. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.flight?.controller.abort(new Error('update checker is closed'))
  }

  private failure(message: string): UpdateInfo {
    return { ...this.cache, current: this.current, hasUpdate: this.cache?.hasUpdate ?? false,
      checkedAt: new Date().toISOString(), error: message }
  }

  private addOwner(flight: CheckFlight, signal?: AbortSignal): void {
    if (!signal || flight.owners.has(signal)) return
    const abort = (): void => {
      flight.cancelled = true
      flight.controller.abort(new Error('update check cancelled'))
    }
    if (signal.aborted) abort()
    else {
      flight.owners.set(signal, abort)
      signal.addEventListener('abort', abort, { once: true })
    }
  }

  private async run(flight: CheckFlight): Promise<UpdateInfo> {
    const { signal } = flight.controller
    const timer = setTimeout(() => flight.controller.abort(new Error('update check timed out')), this.timeoutMs)
    timer.unref()
    let onAbort!: () => void
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      // Race also bounds injected fetch implementations that ignore AbortSignal.
      const info = await Promise.race([this.query(signal), aborted])
      signal.throwIfAborted()
      if (!this.closed && !flight.cancelled && this.flight === flight) this.cache = { ...info }
      return info
    } catch (error) {
      const info = this.failure(error instanceof Error ? error.message : String(error))
      if (!this.closed && !flight.cancelled && this.flight === flight) this.cache = { ...info }
      return info
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      for (const [owner, abort] of flight.owners) owner.removeEventListener('abort', abort)
      flight.owners.clear()
      if (this.flight === flight) this.flight = undefined
    }
  }

  private async query(signal: AbortSignal): Promise<UpdateInfo> {
    signal.throwIfAborted()
    const response = await this.fetcher(this.url, {
      headers: { 'user-agent': `SakuraCode/${this.current}`, accept: 'application/vnd.github+json' },
      credentials: 'omit', redirect: 'error', signal,
    })
    const cancelBody = (): void => { void response.body?.cancel().catch(() => {}) }
    if (signal.aborted) {
      cancelBody()
      signal.throwIfAborted()
    }
    if (!response.ok) {
      cancelBody()
      throw new Error(`update source returned ${response.status}`)
    }
    const length = response.headers.get('content-length')
    if (length !== null && Number(length) > MAX_BODY_BYTES) {
      cancelBody()
      throw new Error('update source response exceeds 1 MiB')
    }
    if (!response.body) throw new Error('update source returned no response body')
    const reader = response.body.getReader()
    const cancelRead = (): void => { void reader.cancel().catch(() => {}) }
    signal.addEventListener('abort', cancelRead, { once: true })
    let contents = ''
    let size = 0
    const decoder = new TextDecoder()
    try {
      for (;;) {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        size += value.byteLength
        if (size > MAX_BODY_BYTES) throw new Error('update source response exceeds 1 MiB')
        contents += decoder.decode(value, { stream: true })
      }
      contents += decoder.decode()
    } catch (error) {
      cancelRead()
      throw error
    } finally {
      signal.removeEventListener('abort', cancelRead)
      reader.releaseLock()
    }
    const body: unknown = JSON.parse(contents)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('update source returned an invalid release')
    const release = body as Record<string, unknown>
    if (typeof release.tag_name !== 'string') throw new Error('update source returned no release tag')
    const tag = release.tag_name.trim()
    const version = parseVersion(tag)
    if (version.prerelease.length || (release.draft !== undefined && release.draft !== false) ||
      (release.prerelease !== undefined && release.prerelease !== false)) {
      throw new Error('update source returned a draft or prerelease; stable releases only')
    }
    // Ignore html_url: constructing from a validated tag is both the safe fallback
    // and the canonical link, including when the feed supplied an untrusted URL.
    return { current: this.current, latest: tag.replace(/^v/i, ''),
      hasUpdate: compareVersions(this.current, tag) < 0,
      releaseUrl: RELEASE_TAG_URL + encodeURIComponent(tag), checkedAt: new Date().toISOString() }
  }
}
