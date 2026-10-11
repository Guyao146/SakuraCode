/**
 * Fake MCP stdio server for tests.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the MCP 2025-03-26 subset):
 *   initialize / notifications/initialized / tools/list / tools/call / ping.
 *
 * Env:
 *   FAKE_SUICIDE_AFTER=1 — process.exit(1) after answering the second
 *   tools/call request (used to simulate a server crash mid-session).
 */
import readline from 'node:readline'

const suicide = process.env.FAKE_SUICIDE_AFTER === '1'
let toolCallCount = 0

/** Write one JSON-RPC response; onFlush runs once the bytes are flushed. */
function send(id, result, error, onFlush) {
  const message = { jsonrpc: '2.0', id }
  if (error) message.error = error
  else message.result = result === undefined ? {} : result
  process.stdout.write(`${JSON.stringify(message)}\n`, onFlush)
}

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

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }
  const { id, method, params } = message

  if (method === 'initialize') {
    send(id, {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    send(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    toolCallCount += 1
    if (name === 'echo') {
      if (suicide && toolCallCount >= 2) {
        // Answer, then die once the answer has been flushed to the pipe.
        const die = () => process.exit(1)
        setTimeout(die, 250)
        send(id, { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] }, undefined, die)
      } else {
        send(id, { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }] })
      }
      return
    }
    if (name === 'fail') {
      send(id, { content: [{ type: 'text', text: 'boom' }], isError: true })
      return
    }
    send(id, undefined, { code: -32601, message: `unknown tool: ${String(name)}` })
    return
  }
  if (method === 'ping') {
    send(id, {})
    return
  }
  if (id !== undefined) send(id, undefined, { code: -32601, message: 'Method not found' })
})

// If the client goes away, so do we.
rl.on('close', () => process.exit(0))

for (const signalName of ['SIGTERM', 'SIGINT']) {
  process.on(signalName, () => process.exit(0))
}
