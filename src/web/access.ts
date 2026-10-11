/** Remote access is a transport concern; the Harness/plugin API stays unchanged. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { HttpError } from './http.js'

export interface WebAccessOptions {
  host: string
  token?: string
  viewerToken?: string
  publicOrigin?: string
  sessionTtlMs?: number
}

export interface WebPrincipal {
  role: 'operator' | 'viewer'
  sessionId?: string
  expiresAt?: number
}

export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '')
  return name === 'localhost' || name === '::1' || (isIP(name) === 4 && name.startsWith('127.'))
}

const digest = (value: string): Buffer => createHash('sha256').update(value).digest()

export class WebAccess {
  readonly host: string
  readonly required: boolean
  readonly remote: boolean
  readonly publicOrigin?: string
  private readonly operatorHash?: Buffer
  private readonly viewerHash?: Buffer
  private readonly ttl: number
  private readonly sessions = new Map<string, WebPrincipal>()
  private readonly attempts = new Map<string, { count: number; until: number }>()

  constructor(opts: WebAccessOptions) {
    if (typeof opts.host !== 'string' || !opts.host || (!isIP(opts.host.replace(/^\[|\]$/g, '')) && !/^[a-z0-9.-]+$/i.test(opts.host))) {
      throw new Error('web.host / --host must be an IP address or hostname (not a URL)')
    }
    this.host = opts.host.toLowerCase().replace(/^\[|\]$/g, '')
    if (opts.publicOrigin !== undefined) {
      let url: URL
      try { url = new URL(opts.publicOrigin) } catch { throw new Error('web.publicOrigin / --public-origin must be an HTTPS origin') }
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
        throw new Error('web.publicOrigin / --public-origin must be an HTTPS origin without a path, credentials, query or fragment')
      }
      this.publicOrigin = url.origin
    }
    for (const [name, value] of [['operator', opts.token], ['viewer', opts.viewerToken]] as const) {
      if (value !== undefined && (typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value))) {
        throw new Error(`web ${name} token must contain 32-256 non-whitespace ASCII characters; use a cryptographically random token`)
      }
    }
    this.remote = !isLoopbackHost(this.host) || !!this.publicOrigin
    if ((this.remote || opts.viewerToken) && !opts.token) {
      throw new Error('remote Web access requires SAKURA_WEB_TOKEN (at least 32 random characters); refusing an unauthenticated listener')
    }
    if (opts.viewerToken && opts.viewerToken === opts.token) throw new Error('operator and viewer tokens must be different')
    this.required = !!opts.token
    if (opts.token) this.operatorHash = digest(opts.token)
    if (opts.viewerToken) this.viewerHash = digest(opts.viewerToken)
    this.ttl = opts.sessionTtlMs ?? 12 * 60 * 60_000
    if (!Number.isFinite(this.ttl) || this.ttl <= 0) throw new Error('web session lifetime must be positive')
  }

  /** Do not trust Forwarded/X-Forwarded-*; a proxy must preserve the configured Host. */
  guard(req: IncomingMessage, port: number): void {
    let target: URL
    try {
      target = new URL(`${this.publicOrigin ? 'https' : 'http'}://${req.headers.host ?? ''}`)
      if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('invalid Host')
    } catch { throw new HttpError(403, 'invalid Host header') }
    const expected = this.publicOrigin ? new URL(this.publicOrigin) : target
    if (this.publicOrigin) {
      if (target.host !== expected.host) throw new HttpError(403, 'Host does not match configured public origin')
    } else {
      if (Number(target.port || 80) !== port) throw new HttpError(403, 'Host port does not match listener')
      // A loopback listener without authentication must resist DNS rebinding.
      if (!this.required && !isLoopbackHost(target.hostname)) throw new HttpError(403, 'non-loopback Host rejected')
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'cross-origin request rejected')
    const origin = req.headers.origin
    if (!origin) return // CLI/API clients still require credentials when auth is enabled.
    let source: URL
    try { source = new URL(origin) } catch { throw new HttpError(403, 'cross-origin request rejected') }
    const alias = !this.publicOrigin && source.protocol === 'http:' && isLoopbackHost(source.hostname)
      && isLoopbackHost(target.hostname) && source.port === target.port
    if (source.origin !== expected.origin && !alias) throw new HttpError(403, 'cross-origin request rejected')
    if (source.username || source.password || source.pathname !== '/' || source.search || source.hash) {
      throw new HttpError(403, 'cross-origin request rejected')
    }
  }

  private role(token: unknown): WebPrincipal['role'] | undefined {
    if (typeof token !== 'string' || token.length > 256) return undefined
    const hash = digest(token)
    const operator = this.operatorHash && timingSafeEqual(hash, this.operatorHash)
    const viewer = this.viewerHash && timingSafeEqual(hash, this.viewerHash)
    return operator ? 'operator' : viewer ? 'viewer' : undefined
  }

  private cookieId(req: IncomingMessage, port: number): string | undefined {
    return req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith(`sakura_session_${port}=`))?.split('=')[1]
  }

  principal(req: IncomingMessage, port: number): WebPrincipal | undefined {
    if (!this.required) return { role: 'operator' }
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/i.exec(req.headers.authorization)
      const role = this.role(match?.[1])
      return role ? { role } : undefined
    }
    const id = this.cookieId(req, port)
    const entry = id ? this.sessions.get(id) : undefined
    return entry && this.isActive(entry) ? entry : undefined
  }

  isActive(principal: WebPrincipal): boolean {
    if (!principal.sessionId) return true
    if ((principal.expiresAt ?? 0) <= Date.now()) {
      this.sessions.delete(principal.sessionId)
      return false
    }
    return this.sessions.get(principal.sessionId) === principal
  }

  status(req: IncomingMessage, port: number) {
    const principal = this.principal(req, port)
    return { required: this.required, authenticated: !!principal, role: principal?.role ?? null,
      remote: this.remote, publicOrigin: this.publicOrigin, expiresAt: principal?.expiresAt }
  }

  /** Reserve an attempt before reading the body, including concurrent attempts. */
  beginLogin(address: string): void {
    const now = Date.now()
    for (const [key, entry] of this.attempts) if (entry.until <= now) this.attempts.delete(key)
    const entry = this.attempts.get(address) ?? { count: 0, until: now + 60_000 }
    if (entry.count >= 10 || (!this.attempts.has(address) && this.attempts.size >= 1024)) {
      throw new HttpError(429, 'too many login attempts; retry in one minute')
    }
    entry.count++
    this.attempts.set(address, entry)
  }

  login(token: unknown): WebPrincipal {
    const role = this.role(token)
    if (!role) throw new HttpError(401, 'invalid access token')
    for (const entry of this.sessions.values()) this.isActive(entry)
    // Bound memory even with repeated successful logins; eviction also revokes SSE.
    if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value!)
    const sessionId = randomBytes(32).toString('hex')
    const principal: WebPrincipal = { role, sessionId, expiresAt: Date.now() + this.ttl }
    this.sessions.set(sessionId, principal)
    return principal
  }

  cookie(id: string, port: number): string {
    return `sakura_session_${port}=${id}; Path=/; HttpOnly; SameSite=Strict${this.publicOrigin ? '; Secure' : ''}${id ? '' : '; Max-Age=0'}`
  }

  logout(req: IncomingMessage, port: number): void {
    const id = this.cookieId(req, port)
    if (id) this.sessions.delete(id)
  }

  dispose(): void { this.sessions.clear(); this.attempts.clear() }
}