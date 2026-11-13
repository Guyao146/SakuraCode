/** Synthetic loopback-only bridge demonstrating connector v1; no filesystem or real service access. */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const documents = [{ id: 'guide', title: '连接器示例资料', source: 'synthetic:guide', content: '# 示例知识库\n这是合成资料，可用于验证外接检索与阅读。\n不代表已连接真实第三方服务。\n' }]
const version = content => createHash('sha256').update(content).digest('hex')

export async function startExampleBridge({ port = 0 } = {}) {
  const requests = []
  const server = createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    if (req.headers.origin) { send(403, { error: 'browser cross-origin access is not supported' }); return }
    try {
      let bytes = 0
      const chunks = []
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > 256 * 1024) { send(413, { error: 'request too large' }); return }
        chunks.push(chunk)
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
      requests.push({ path: req.url, method: req.method })
      if (req.method === 'GET' && req.url === '/capabilities') {
        send(200, { version: 1, actions: [{ name: 'status', description: '查看合成软件的状态，不操作真实软件', parameters: { type: 'object', properties: {}, additionalProperties: false } }], knowledge: { search: true, read: true } }); return
      }
      if (req.method !== 'POST' || body.version !== 1 || typeof body.requestId !== 'string') { send(400, { error: 'expected a connector v1 request' }); return }
      if (req.url === '/actions/status') { send(200, { output: 'Synthetic software is ready; no real software was called.' }); return }
      if (req.url === '/knowledge/search') {
        if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 256 || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 20 || !Number.isInteger(body.maxChars) || body.maxChars < 256 || body.maxChars > 16000) { send(400, { error: 'invalid search budgets' }); return }
        let remaining = body.maxChars, truncated = false
        const results = documents.filter(doc => (doc.content + doc.title).includes(body.query)).slice(0, body.limit).map(doc => {
          const snippet = doc.content.slice(0, remaining); remaining -= snippet.length; truncated ||= snippet.length < doc.content.length
          return { id: doc.id, title: doc.title, source: doc.source, version: version(doc.content), snippet }
        })
        send(200, { results, truncated }); return
      }
      if (req.url === '/knowledge/read') {
        const doc = documents.find(row => row.id === body.id)
        if (!doc) { send(404, { error: 'document not found' }); return }
        if (body.documentVersion !== undefined && body.documentVersion !== version(doc.content)) { send(409, { error: 'document version changed' }); return }
        const offset = body.cursor === undefined ? 0 : Number(body.cursor)
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > doc.content.length || !Number.isSafeInteger(body.maxChars) || body.maxChars < 1 || body.maxChars > 12000) { send(400, { error: 'invalid read cursor/budget' }); return }
        let end = Math.min(doc.content.length, offset + body.maxChars)
        if (end < doc.content.length && /[\uD800-\uDBFF]/.test(doc.content[end - 1])) end--
        send(200, { id: doc.id, content: doc.content.slice(offset, end), source: doc.source, version: version(doc.content), truncated: end < doc.content.length, ...(end < doc.content.length ? { cursor: String(end) } : {}) }); return
      }
      send(404, { error: 'unknown bridge operation' })
    } catch { send(400, { error: 'invalid request JSON' }) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { url: 'http://127.0.0.1:' + server.address().port, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = process.argv[2] === undefined ? 8789 : Number(process.argv[2])
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Usage: node scripts/example-connector-bridge.mjs [port]')
  const bridge = await startExampleBridge({ port })
  console.log('Synthetic connector v1 bridge: ' + bridge.url)
  console.log('Only synthetic data is served; no software installation, real credentials or external requests.')
  const stop = async () => { await bridge.close(); process.exit(0) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
