/**
 * Fake MCP streamable-HTTP server for tests.
 *
 * Speaks the JSON-mode subset of MCP 2025-03-26 over POST /:
 *   initialize / notifications/initialized / tools/list / tools/call / ping.
 *
 * The initialize response grants `mcp-session-id`; every later request
 * without that exact id is rejected with 400 (the transport under test must
 * carry the granted id on all subsequent requests).
 *
 * `tools/call` with name "stall" is the adversarial case: 200 +
 * `content-type: text/event-stream`, one comment keep-alive frame (so the
 * client really enters its SSE reader) and then no terminating frame ever,
 * with the socket left open. The transport must time it out and release it.
 *
 * Usage:
 *   - imported by tests/mcp-http.test.ts via startFakeHttpMcp(options)
 *   - run standalone: node tests/fixtures/fake-mcp-http-server.mjs
 *     (prints the listening URL; FAKE_HTTP_CALL_DELAY_MS delays tools/call)
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'fail',
    description: 'Always errors',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function startFakeHttpMcp({ callDelayMs = 0, initializeStatus = 0, stallIntervalMs = 0 } = {}) {
  const sessionId = randomUUID()
  const requests = []
  const timers = new Set()
  /** Stall responses still holding a socket open (see the "stall" tool). */
  const openStalls = new Set()

  /** Write one JSON-RPC response. */
  function send(res, id, result, error) {
    const message = { jsonrpc: '2.0', id }
    if (error) message.error = error
    else message.result = result === undefined ? {} : result
    const body = JSON.stringify(message)
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url || !req.url.startsWith('/')) {
      res.writeHead(404).end()
      return
    }
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400).end()
        return
      }
      const { id, method, params } = message ?? {}
      const hadSession = req.headers['mcp-session-id'] === sessionId
      requests.push({ method: String(method ?? ''), hadSession, headers: { ...req.headers } })

      // initialize is exempt from the session gate — its response grants the id.
      if (method === 'initialize') {
        if (initializeStatus > 0) {
          const body = JSON.stringify({ error: 'internal (injected for tests)' })
          res.writeHead(initializeStatus, { 'content-type': 'application/json' })
          res.end(body)
          return
        }
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fake-http-mcp', version: '1.0.0' },
          },
        })
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': sessionId,
          'content-length': Buffer.byteLength(body),
        })
        res.end(body)
        return
      }

      if (!hadSession) {
        const body = JSON.stringify({ error: 'missing or unknown mcp-session-id' })
        res.writeHead(400, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
        res.end(body)
        return
      }

      if (method === 'notifications/initialized') {
        res.writeHead(202).end()
        return
      }
      if (method === 'tools/list') {
        send(res, id, { tools: TOOLS })
        return
      }
      if (method === 'tools/call') {
        const name = params?.name
        const args = params?.arguments ?? {}
        // Adversarial endpoint: 200 + text/event-stream, a keep-alive comment
        // frame (so the client is provably inside its SSE reader) and then a
        // silent, never-terminating stream. Nothing else is ever written.
        if (name === 'stall') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
          res.write(': keep-alive\n\n')
          openStalls.add(res)
          res.on('close', () => openStalls.delete(res))
          res.on('error', () => {}) // the client aborting mid-stream is expected
          // Optional trickle: keep pushing non-terminating frames forever, so
          // a call cannot be rescued by the stream going quiet.
          if (stallIntervalMs > 0) {
            const tick = setInterval(() => {
              if (res.destroyed) {
                clearInterval(tick)
                timers.delete(tick)
                return
              }
              try {
                res.write(': keep-alive\n\n')
              } catch {
                /* the client aborted between the check and the write */
              }
            }, stallIntervalMs)
            timers.add(tick)
          }
          return
        }
        const reply = () => {
          if (res.destroyed) return // the client gave up (timeout test)
          if (name === 'echo') send(res, id, { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] })
          else if (name === 'fail') send(res, id, { content: [{ type: 'text', text: 'boom' }], isError: true })
          else send(res, id, undefined, { code: -32601, message: `unknown tool: ${String(name)}` })
        }
        if (callDelayMs > 0) {
          const timer = setTimeout(() => {
            timers.delete(timer)
            reply()
          }, callDelayMs)
          timers.add(timer)
        } else {
          reply()
        }
        return
      }
      if (method === 'ping') {
        send(res, id, {})
        return
      }
      if (id !== undefined) send(res, id, undefined, { code: -32601, message: 'Method not found' })
      else res.writeHead(202).end()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(undefined)
    })
  })
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}/`,
    sessionId,
    requests,
    /** Number of "stall" responses whose socket is still open. */
    openStallCount: () => openStalls.size,
    close() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      openStalls.clear()
      server.closeAllConnections?.()
      return new Promise((resolve) => server.close(() => resolve(undefined)))
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeHttpMcp({ callDelayMs: Number(process.env.FAKE_HTTP_CALL_DELAY_MS ?? 0) })
  console.log(`[fake-http-mcp] listening on ${fake.url} (session ${fake.sessionId})`)
}
