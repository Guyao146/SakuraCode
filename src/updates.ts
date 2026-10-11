/**
 * Update checks against the project's GitHub releases. The server keeps a
 * cached result, re-checks on demand via POST /api/updates/check, and runs a
 * periodic background check that can broadcast a notice when a newer release
 * appears. Network failures never throw — they land in `error` so the UI can
 * show "检查失败" without breaking anything else.
 */

export interface UpdateInfo {
  /** The version this process reports (package.json / VERSION constant). */
  current: string
  /** Newest release tag seen, without the leading `v`. */
  latest?: string
  /** True when latest is newer than current. */
  hasUpdate: boolean
  /** Browser URL of the release page. */
  releaseUrl?: string
  /** ISO timestamp of the last completed check. */
  checkedAt?: string
  /** Set when the last check could not reach the update source. */
  error?: string
}

export const DEFAULT_UPDATES_URL = 'https://api.github.com/repos/Guyao146/SakuraCode/releases/latest'

/** Parse the leading numeric triple of a version tag (`v1.2.3-rc1` → [1,2,3]). */
function versionParts(version: string): number[] {
  const main = version.trim().replace(/^v/i, '').split('-')[0] ?? ''
  return main.split('.').map((part) => Number.parseInt(part, 10)).slice(0, 3)
}

/**
 * Semver-style comparison of two version strings. Returns a negative number
 * when `a` is older, 0 when equal, positive when `a` is newer. Pre-release
 * suffixes are ignored: `1.2.3-rc1` compares as `1.2.3`.
 */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a)
  const pb = versionParts(b)
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0
    if (x !== y) return x - y
  }
  return 0
}

export class UpdateChecker {
  private cache: UpdateInfo | undefined
  /** Whether an "update available" notification has already gone out. */
  private notified = false

  constructor(
    private readonly current: string,
    private readonly url: string = DEFAULT_UPDATES_URL,
  ) {}

  cached(): UpdateInfo | undefined {
    return this.cache
  }

  /** True once a check has found a newer release (sticky until a newer current). */
  notifiedOfUpdate(): boolean {
    return this.notified
  }

  /** Query the release endpoint once and update the cache. Never throws. */
  async check(signal?: AbortSignal): Promise<UpdateInfo> {
    const info: UpdateInfo = { current: this.current, hasUpdate: false }
    try {
      const response = await fetch(this.url, {
        headers: { 'user-agent': `SakuraCode/${this.current}`, accept: 'application/vnd.github+json' },
        signal: signal ?? AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`update source returned ${response.status}`)
      const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown }
      if (typeof body.tag_name !== 'string' || !body.tag_name.trim()) {
        throw new Error('update source returned no release tag')
      }
      const latest = body.tag_name.trim().replace(/^v/i, '')
      info.latest = latest
      info.releaseUrl = typeof body.html_url === 'string' ? body.html_url : undefined
      info.hasUpdate = compareVersions(this.current, latest) < 0
      info.checkedAt = new Date().toISOString()
      if (info.hasUpdate) this.notified = true
    } catch (error) {
      info.checkedAt = new Date().toISOString()
      info.error = error instanceof Error ? error.message : String(error)
    }
    this.cache = info
    return info
  }

  /**
   * Re-check and tell the caller whether this is a *new* detection (first time
   * a newer release appears, or it reappears after the current version caught
   * up and fell behind again). Callers use this to fire a notification exactly
   * once per release.
   */
  async checkAndDetectChange(): Promise<{ info: UpdateInfo; isNew: boolean }> {
    const previous = this.cache
    const hadUpdate = !!previous?.hasUpdate
    const info = await this.check()
    return { info, isNew: info.hasUpdate && !hadUpdate }
  }
}
