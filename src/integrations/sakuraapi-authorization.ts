/** Official client-account code + S256 PKCE. Never reads website login tokens or profiles. */
import { spawn } from 'node:child_process'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { BLOCKED_WEB_PORTS, HttpError, json, readJson } from '../web/http.js'

export const SAKURA_API_ORIGIN = 'https://sakuraapi.top'
export const SAKURA_MODEL_BASE_URL = 'https://api.sakuraapi.top/v1'
export const SAKURA_AUTHORIZATION_URL = SAKURA_API_ORIGIN + '/client-authorize.html'

export interface SakuraApiAuthorizationDraft {
  clientId: 'sakuracode'
  redirectUri: string
  state: string
  verifier: string
  expiresAt: number
  authorizeUrl: string
}

export function createSakuraAuthorizationDraft(redirectUri: string): SakuraApiAuthorizationDraft {
  const redirect = new URL(redirectUri)
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username || redirect.password || redirect.search || redirect.hash) {
    throw new Error('invalid SakuraAPI loopback callback')
  }
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url')
  const url = new URL(SAKURA_AUTHORIZATION_URL)
  url.search = new URLSearchParams({ client_id: 'sakuracode', client_name: 'SakuraCode Desktop', redirect_uri: redirectUri,
    response_type: 'code', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', mode: 'account', delivery: 'postmessage', from: redirect.origin }).toString()
  return { clientId: 'sakuracode', redirectUri, state, verifier, expiresAt: Date.now() + 10 * 60_000, authorizeUrl: url.href }
}

export interface SiteAuthorizationWindow {
  /** Only a result explicitly returned by the official consent popup, not its login session. */
  readAuthorization(): Promise<unknown>
  /** Native-only PKCE verifier; never serialize this to the workspace UI. */
  draft?: SakuraApiAuthorizationDraft
  close(): Promise<void>
}

export type SakuraOfficialPage = 'purchase' | 'keys' | 'profile'

export function sakuraOfficialPageUrl(page: SakuraOfficialPage): string {
  if (!['purchase', 'keys', 'profile'].includes(page)) throw new Error('unsupported SakuraAPI official page')
  return SAKURA_API_ORIGIN + '/' + page
}

/** Use the user's normal browser so an existing official-site login can be reused.
 * We do not own that browser and must never kill it or inspect its other tabs. */
export function openSystemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', () => reject(new Error('无法打开系统浏览器，请检查默认浏览器设置。')))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('无法打开系统浏览器，请检查默认浏览器设置。')))
  })
}

export async function openSakuraApiPage(page: SakuraOfficialPage,
  open: (url: string) => Promise<void> = openSystemBrowser): Promise<void> {
  await open(sakuraOfficialPageUrl(page))
}

/** A one-operation loopback receiver. Validate exact origin, popup, state and
 * clientId; only the authorization code is handed to the native account client. */
export async function openSakuraApiAuthorization(options: {
  openBrowser?: (url: string) => Promise<void>
} = {}): Promise<SiteAuthorizationWindow> {
  const path = '/' + randomBytes(32).toString('hex')
  const nonce = randomBytes(24).toString('base64')
  let origin = ''
  let draft: SakuraApiAuthorizationDraft
  let result: unknown = null
  let closed = false
  const server = createServer((req, res) => {
    void (async () => {
      if (closed || req.headers.host !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') {
        throw new HttpError(403, 'authorization receiver unavailable')
      }
      res.setHeader('cache-control', 'no-store')
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader('x-content-type-options', 'nosniff')
      if (req.url === path && req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8')
        res.setHeader('content-security-policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`)
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SakuraCode · SakuraAPI 授权</title>
<style nonce="${nonce}">html{color-scheme:dark;background:#1a1c22;color:#e5e7ee;font:16px/1.8 system-ui,"Microsoft YaHei"}body{max-width:560px;margin:10vh auto;padding:24px}h1{font-size:24px}p{color:#bdc0cd}button{font:inherit;padding:10px 18px;border:0;border-radius:10px;background:#f0adc0;color:#302029;cursor:pointer}button:disabled{opacity:.5}small{display:block;margin-top:24px;color:#9a9eae}</style>
<h1>SakuraCode · 授权登录 SakuraAPI</h1><p>请在官网确认账号并点击「同意并连接账号」。本次只连接账号，不创建 Key，也不会读取密码或浏览器登录令牌。</p>
<p>SakuraCode 使用一次性授权码和 S256 PKCE 获取独立客户端凭据。连接后请在软件的「模型设置」中选择已有 Key，或确认模型分组创建新 Key；账号凭据不用于模型调用。</p>
<button id="authorize" type="button">继续到 SakuraAPI 官网授权</button><p id="status" role="status" aria-live="polite">请点击上方按钮。浏览器已有的官网登录状态可以直接复用。</p><small>关闭 SakuraCode 或取消后，此次接收地址立即失效。请勿把授权 Key 发给任何人。</small>
<script nonce="${nonce}">
(() => {
  let popup = null, pending = null, sending = false, done = false;
  const button = document.getElementById('authorize'), status = document.getElementById('status');
  button.addEventListener('click', () => {
    if (done || sending) return;
    if (pending) { void sendAuthorization(); return; }
    if (sending || done) return;
    if (popup && !popup.closed) { popup.focus(); return; }
    popup = window.open(${JSON.stringify(draft.authorizeUrl)}, '_blank', 'popup,width=680,height=780');
    status.textContent = popup ? '请在官网完成登录并同意授权。完成后会自动连接 SakuraCode。' : '弹窗被拦截，请允许此本机页面打开弹窗后重试。';
  });
  async function sendAuthorization() {
    if (!pending || sending || done) return;
    const message = pending;
    sending = true; button.disabled = true;
    try {
      const response = await fetch(location.pathname + '/complete', {method:'POST', headers:{'content-type':'application/json'}, credentials:'omit', body:JSON.stringify(message)});
      if (!response.ok) throw new Error('receiver unavailable');
      const acknowledgement = await response.json();
      if (!acknowledgement || acknowledgement.received !== true) throw new Error('receiver did not acknowledge');
      done = true; pending = null;
      status.textContent = message.event === 'authorized' ? '授权码已安全回传。SakuraCode 正在连接账号，将自动关闭本次授权窗口。' : message.event === 'denied' ? '你已拒绝授权，没有连接账号。可以关闭此窗口。' : '官网未能完成授权。请返回 SakuraCode 查看提示后重试。';
      if (message.event === 'authorized') window.setTimeout(() => {
        // Only the exact consent popup we opened and this receiver page belong
        // to the operation. Never close other website tabs or the browser.
        try { if (popup && !popup.closed) popup.close(); } catch {}
        try { window.close(); } catch {}
        status.textContent = '授权码已安全回传。请返回 SakuraCode 的「模型设置」选择 Key。若浏览器不允许自动关闭，可手动关闭此页；连接失败请在软件中重试。';
      }, 180);
    } catch { button.textContent = '重试回传'; status.textContent = '未能回传授权码。点击「重试回传」发送同一份结果，不会重复授权或创建 Key。若本次授权已取消或过期，请返回 SakuraCode 重新开始。'; }
    finally { sending = false; button.disabled = done; }
  }
  window.addEventListener('message', async event => {
    if (event.origin !== ${JSON.stringify(SAKURA_API_ORIGIN)} || !popup || event.source !== popup || pending || sending || done) return;
    const message = event.data;
    if (!message || message.source !== 'sakura-client-authorization' || message.state !== ${JSON.stringify(draft.state)} || !['authorized', 'denied', 'error'].includes(message.event)) return;
    const data = message.data || {};
    if (message.event === 'authorized' && (typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.code) || data.clientId !== 'sakuracode')) return;
    pending = {event:message.event, state:message.state, ...(message.event === 'authorized' ? {data:{code:data.code, clientId:data.clientId}} : {})};
    await sendAuthorization();
  });
})();
</script></html>`)
        return
      }
      if (req.url !== path + '/complete' || req.method !== 'POST') throw new HttpError(404, 'not found')
      if (req.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        throw new HttpError(403, 'cross-origin authorization result rejected')
      }
      const body = await readJson(req, 5000, 4096)
      if (closed) throw new HttpError(409, 'authorization receiver cancelled')
      if (!['authorized', 'denied', 'error'].includes(String(body.event)) || typeof body.state !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.state) || body.state.length !== draft.state.length ||
        !timingSafeEqual(Buffer.from(body.state), Buffer.from(draft.state)) || draft.expiresAt <= Date.now()) throw new HttpError(400, 'invalid authorization result')
      let candidate: unknown
      if (body.event === 'authorized') {
        const data = body.data as Record<string, unknown> | undefined
        if (!data || typeof data.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(data.code) || data.clientId !== 'sakuracode') {
          throw new HttpError(400, 'invalid authorization code')
        }
        candidate = { event: 'authorized', state: draft.state, data: { code: data.code, clientId: 'sakuracode' } }
      } else candidate = { event: body.event, state: draft.state }
      // Retrying a lost acknowledgement must not require another authorization.
      // The first result wins; only an identical sanitized retry is idempotent.
      if (result && JSON.stringify(result) !== JSON.stringify(candidate)) throw new HttpError(409, 'authorization result already received')
      result = candidate
      json(res, 200, { received: true })
    })().catch(error => json(res, error instanceof HttpError ? error.status : 500, { error: 'authorization receiver rejected the request' }))
  })
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    result = null
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('error', failed); reject(error) }
      server.once('error', failed)
      const listen = (attempt: number): void => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          if (address && typeof address !== 'string' && BLOCKED_WEB_PORTS.has(address.port)) {
            server.close(() => {
              if (attempt >= 31) failed(new Error('cannot allocate a browser-compatible authorization port'))
              else listen(attempt + 1)
            })
            return
          }
          server.off('error', failed)
          resolve()
        })
      }
      listen(0)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('authorization receiver did not start')
    origin = 'http://127.0.0.1:' + address.port
    draft = createSakuraAuthorizationDraft(origin + path)
    await (options.openBrowser ?? openSystemBrowser)(origin + path)
    return { draft, readAuthorization: async () => { if (closed) throw new Error('authorization receiver closed'); return result }, close }
  } catch (error) {
    await close()
    throw error
  }
}