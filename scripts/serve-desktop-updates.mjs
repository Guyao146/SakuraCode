/** Read-only update host. Run behind an HTTPS reverse proxy; has no upload/admin/execution route. */
import assert from 'node:assert/strict'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import * as http from 'node:http'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1]
  assert.ok(['--directory', '--port', '--host'].includes(name) && value && !options.has(name),
    'Usage: node scripts/serve-desktop-updates.mjs --directory <absolute-published-directory> [--port 8787] [--host 127.0.0.1]')
  options.set(name, value)
}
const directory = options.get('--directory'), host = options.get('--host') ?? '127.0.0.1', port = Number(options.get('--port') ?? 8787)
assert.ok(directory && path.isAbsolute(directory) && (await lstat(directory)).isDirectory(), 'An existing absolute directory is required')
assert.ok(['127.0.0.1', '::1', '0.0.0.0'].includes(host), 'Host must be an explicit loopback/container listen address')
assert.ok(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid listen port')
const root = await realpath(directory)
const server = http.createServer(async (request, response) => {
  const fail = status => { if (!response.headersSent) response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' }); response.end(http.STATUS_CODES[status]) }
  if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('allow', 'GET, HEAD'); fail(405); return }
  const raw = request.url ?? ''
  if (raw.includes('?') || raw.includes('#') || /%2f|%5c|\\/i.test(raw)) { fail(404); return }
  let pathname
  try { pathname = decodeURIComponent(raw) } catch { fail(404); return }
  let relative
  if (pathname === '/latest.json') relative = 'latest.json'
  else {
    const match = /^\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\/(index\.html|SakuraCode Desktop\.exe|SakuraCode Desktop\.sha256|SakuraCode Desktop-使用说明\.txt)?$/.exec(pathname)
    if (!match) { fail(404); return }
    relative = `${match[1]}.${match[2]}.${match[3]}/${match[4] || 'index.html'}`
  }
  try {
    const file = path.join(root, relative)
    const parent = relative.includes('/') ? path.dirname(file) : root
    if ((await lstat(parent)).isSymbolicLink() || !(await lstat(file)).isFile() || (await realpath(file)) !== file) { fail(404); return }
    const info = await stat(file), ext = path.extname(file)
    response.writeHead(200, { 'content-type': ext === '.json' ? 'application/json; charset=utf-8' : ext === '.html' ? 'text/html; charset=utf-8' : ext === '.exe' ? 'application/octet-stream' : 'text/plain; charset=utf-8',
      'content-length': info.size, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'cache-control': relative === 'latest.json' ? 'no-store' : 'public, max-age=31536000, immutable',
      ...(ext === '.exe' ? { 'content-disposition': 'attachment; filename="SakuraCode Desktop.exe"' } : {}) })
    if (request.method === 'HEAD') { response.end(); return }
    await pipeline(createReadStream(file), response)
  } catch (error) {
    if (!response.headersSent) fail(error.code === 'ENOENT' ? 404 : 500)
    else response.destroy()
  }
})
server.headersTimeout = 15_000; server.requestTimeout = 30_000
server.on('error', error => { console.error(error.message); process.exitCode = 1 })
server.listen(port, host, () => {
  const address = server.address()
  console.log(JSON.stringify({ ready: true, url: `http://${host === '::1' ? '[::1]' : host}:${address.port}/`, directory: root, readOnly: true }))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close() })