/**
 * mock-openai-server — a dependency-free OpenAI-compatible SSE mock.
 *
 * Used by tests/e2e.test.ts to exercise the REAL OpenAICompatAdapter
 * (src/core/llm.ts) over HTTP, and runnable standalone for local debugging:
 *
 *   npx tsx scripts/mock-openai-server.ts   → http://127.0.0.1:3100
 *
 * Wire contract (mirrors the adapter's parser):
 *   POST {baseURL}/chat/completions   body: { model, messages, stream, ... }
 *   response: text/event-stream; `data: {json}\n\n` frames, then `data: [DONE]\n\n`
 *   frame shape: { choices: [{ delta: { content? | tool_calls? }, finish_reason }] }
 *   `finish_reason`: 'stop' | 'tool_calls' | null (null = streaming continues)
 */

import * as http from 'node:http'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

/** One SSE frame, shaped exactly as the adapter's SSEChoiceDelta expects. */
export interface SSEEvent {
  choices: Array<{
    delta: {
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: 'stop' | 'tool_calls' | null
  }>
  /** Optional usage frame (adapter maps it to the `usage` StreamChunk). */
  usage?: { prompt_tokens: number; completion_tokens: number }
}

/** Loose shape of a chat-completions request body (we only read messages). */
export interface ChatRequestBody {
  model?: string
  messages?: Array<{ role: string; content?: unknown; tool_calls?: unknown; [key: string]: unknown }>
  stream?: boolean
  [key: string]: unknown
}

/** One scripted response: given the request body, produce the SSE frames. */
export type ScriptFn = (body: ChatRequestBody) => SSEEvent[]

export interface StartMockServerOptions {
  /** Consume one entry per request, in order; falls back to the default script when exhausted. */
  script?: ScriptFn[]
  /** Fixed port (default: an ephemeral port chosen by the OS). */
  port?: number
}

export interface MockServer {
  url: string
  port: number
  close(): Promise<void>
  /** Every parsed request body, in arrival order. */
  requests: ChatRequestBody[]
  reset(): void
}

/** framesForText — one content delta, then an empty stop frame carrying usage. */
export function framesForText(text: string): SSEEvent[] {
  return [
    { choices: [{ delta: { content: text }, finish_reason: null }] },
    {
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ]
}

/** The tool_call the default script issues on the first step. */
const TOOL_CALL_FRAMES: SSEEvent[] = [
  {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_e2e_1',
              type: 'function',
              function: {
                name: 'bash',
                arguments: JSON.stringify({ command: 'echo sakura-e2e-ok', description: 'e2e echo' }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
]

/** The final answer the default script streams once a tool result is present. */
const FINAL_TEXT_FRAMES: SSEEvent[] = [
  { choices: [{ delta: { content: 'E2E_FINAL_' }, finish_reason: null }] },
  {
    choices: [{ delta: { content: 'ANSWER' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  },
]

/**
 * Default scripting: while no tool result has come back, call `bash` with
 * `echo sakura-e2e-ok`; once any message has role 'tool', stream the final
 * answer 'E2E_FINAL_' + 'ANSWER'.
 */
function defaultScript(body: ChatRequestBody): SSEEvent[] {
  const sawToolResult = (body.messages ?? []).some((m) => m?.role === 'tool')
  return sawToolResult ? FINAL_TEXT_FRAMES : TOOL_CALL_FRAMES
}

export async function startMockServer(opts: StartMockServerOptions = {}): Promise<MockServer> {
  const script = [...(opts.script ?? [])]
  const requests: ChatRequestBody[] = []
  let scriptIndex = 0

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${req.url ?? ''}` } }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: ChatRequestBody = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as ChatRequestBody
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }))
        return
      }
      requests.push(body)

      const scripted = scriptIndex < script.length ? script[scriptIndex++] : undefined
      const events = scripted ? scripted(body) : defaultScript(body)

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const event of events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`)
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server failed to bind a TCP port')
  const port = address.port

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    reset() {
      requests.length = 0
      scriptIndex = 0
    },
    close() {
      // fetch (undici) keeps idle keep-alive sockets open — drop them so close() settles.
      server.closeAllConnections()
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Direct invocation: `npx tsx scripts/mock-openai-server.ts` serves on :3100.
// ---------------------------------------------------------------------------

const invokedDirectly = (() => {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    const self = import.meta.url.toLowerCase()
    const invoked = pathToFileURL(path.resolve(arg)).href.toLowerCase()
    return self === invoked
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  const port = Number(process.env.MOCK_OPENAI_PORT ?? 3100)
  const server = await startMockServer({ port })
  console.log(`[mock-openai] listening on ${server.url} — POST ${server.url}/chat/completions`)
  const shutdown = () => {
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
