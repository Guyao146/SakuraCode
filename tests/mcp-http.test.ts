/**
 * src/mcp/http.ts — the streamable-HTTP MCP transport, exercised against a
 * fake HTTP MCP server (tests/fixtures/fake-mcp-http-server.mjs). The
 * connection layer is driven directly through connectHttpServer — no kernel,
 * no McpManager — with the register/status callbacks wired to spies.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectHttpServer, contentToResult } from '../src/mcp/http.js'
import type { HttpMcpConnection, HttpMcpServerConfig, HttpMcpStatus } from '../src/mcp/http.js'
import type { ToolContext, ToolDefinition } from '../src/core/types.js'
// @ts-expect-error — plain .mjs fixture without type declarations
import { startFakeHttpMcp as startFakeUntyped } from './fixtures/fake-mcp-http-server.mjs'

interface FakeHttpMcp {
  url: string
  sessionId: string
  requests: Array<{ method: string; hadSession: boolean; headers: Record<string, string | string[] | undefined> }>
  /** Number of "stall" tool-call responses whose socket is still open. */
  openStallCount(): number
  close(): Promise<void>
}

interface FakeOptions {
  callDelayMs?: number
  initializeStatus?: number
  /** Trickle non-terminating SSE frames every N ms from the "stall" tool. */
  stallIntervalMs?: number
}

const startFakeHttpMcp = startFakeUntyped as (options?: FakeOptions) => Promise<FakeHttpMcp>

const fakes: FakeHttpMcp[] = []
const connections: HttpMcpConnection[] = []

afterEach(async () => {
  while (connections.length) {
    await connections.pop()!.close().catch(() => {})
  }
  while (fakes.length) {
    await fakes.pop()!.close()
  }
})

async function startFake(options?: FakeOptions): Promise<FakeHttpMcp> {
  const fake = await startFakeHttpMcp(options)
  fakes.push(fake)
  return fake
}

interface Connected {
  conn: HttpMcpConnection
  registered: ToolDefinition[]
  statuses: HttpMcpStatus[]
  unregisterAll: ReturnType<typeof vi.fn>
}

async function connect(fake: FakeHttpMcp, overrides: Partial<HttpMcpServerConfig> = {}): Promise<Connected> {
  const registered: ToolDefinition[] = []
  const statuses: HttpMcpStatus[] = []
  const unregisterAll = vi.fn(() => {
    registered.length = 0
  })
  const conn = await connectHttpServer(
    'demo',
    { url: fake.url, headers: { authorization: 'Bearer test' }, ...overrides },
    (def) => {
      registered.push(def)
    },
    unregisterAll,
    (status) => {
      statuses.push({ ...status })
    },
  )
  connections.push(conn)
  return { conn, registered, statuses, unregisterAll }
}

const makeTc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll `check` every 20ms until it holds or `budgetMs` runs out (bounded, no long waits). */
async function waitFor(check: () => boolean, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (check()) return true
    if (Date.now() >= deadline) return false
    await sleep(20)
  }
}

describe('connectHttpServer — streamable HTTP MCP transport', () => {
  it('performs the initialize handshake, carries the granted session id and registers the listed tools', async () => {
    const fake = await startFake()
    const { conn, registered, statuses } = await connect(fake)

    expect(conn.sessionId).toBe(fake.sessionId)
    expect(statuses).toEqual([
      { state: 'connecting', toolCount: 0 },
      { state: 'connected', toolCount: 2 },
    ])
    expect(registered.map((def) => def.name)).toEqual(['mcp__demo__echo', 'mcp__demo__fail'])
    const echo = registered[0]!
    expect(echo.kind).toBe('execute')
    expect(echo.description).toBe('[mcp:demo] Echo back')
    expect(echo.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    })

    expect(fake.requests.map((r) => r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ])
    expect(fake.requests.slice(1).every((r) => r.hadSession)).toBe(true)

    const initialize = fake.requests[0]!
    expect(initialize.headers['mcp-protocol-version']).toBe('2025-03-26')
    expect(initialize.headers['accept']).toBe('application/json, text/event-stream')
    expect(initialize.headers['authorization']).toBe('Bearer test')
  })

  it('calls tools through the connection and the bridged ToolDefinition', async () => {
    const fake = await startFake()
    const { conn, registered } = await connect(fake)

    await expect(conn.call('echo', { text: 'hi' })).resolves.toEqual({ output: 'echo:hi' })
    await expect(conn.call('fail', {})).resolves.toEqual({ output: 'boom', isError: true })

    const viaDefinition = await registered[0]!.execute({ text: 'again' }, makeTc())
    expect(viaDefinition).toEqual({ output: 'echo:again' })
  })

  it('rejects session-less requests at the server while the connection always carries the granted id', async () => {
    const fake = await startFake()
    const { conn } = await connect(fake)

    const response = await fetch(fake.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
    })
    expect(response.status).toBe(400)

    await expect(conn.call('echo', { text: 'ok' })).resolves.toMatchObject({ output: 'echo:ok' })
  })

  it('applies timeoutMs to tools/call', async () => {
    const fake = await startFake({ callDelayMs: 3000 })
    const { conn } = await connect(fake, { timeoutMs: 500 })

    await expect(conn.call('echo', { text: 'slow' })).rejects.toThrow(/timed out after 500ms/)
  })

  // Regression: the response arrives (200 + text/event-stream) and then the
  // stream never terminates, so the request timeout has to reach the SSE
  // reader — otherwise tools/call blocks the agent turn forever.
  it(
    'times out a tools/call whose SSE stream stays open without a terminating frame',
    { timeout: 4000 },
    async () => {
      const fake = await startFake()
      const { conn } = await connect(fake, { timeoutMs: 300 })

      const started = Date.now()
      await expect(conn.call('stall', {})).rejects.toThrow(/timed out after 300ms/)
      // Roughly the configured timeout — not a hang, not a 30s default.
      expect(Date.now() - started).toBeLessThan(1500)

      // The aborted call must release the response body's socket, not orphan it.
      expect(await waitFor(() => fake.openStallCount() === 0, 1000)).toBe(true)
    },
  )

  it(
    'aborts a stalled SSE read when the caller signal fires',
    { timeout: 4000 },
    async () => {
      const fake = await startFake()
      const { conn } = await connect(fake, { timeoutMs: 30_000 })
      const controller = new AbortController()

      const pending = conn.call('stall', {}, controller.signal)
      // Wait until the server is streaming, then give the client a tick to
      // enter its reader so the abort lands mid-read rather than mid-request.
      expect(await waitFor(() => fake.openStallCount() === 1, 1000)).toBe(true)
      await sleep(30)
      controller.abort()

      await expect(pending).rejects.toThrow(/mcp tool call aborted/)
      expect(await waitFor(() => fake.openStallCount() === 0, 1000)).toBe(true)
    },
  )

  it(
    'a never-terminating SSE trickle cannot extend the call past timeoutMs',
    { timeout: 4000 },
    async () => {
      const fake = await startFake({ stallIntervalMs: 40 })
      const { conn } = await connect(fake, { timeoutMs: 300 })

      const started = Date.now()
      await expect(conn.call('stall', {})).rejects.toThrow(/timed out after 300ms/)
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await waitFor(() => fake.openStallCount() === 0, 1000)).toBe(true)
    },
  )

  it('close rejects in-flight and later calls, unregisters tools and reports stopped', async () => {
    const fake = await startFake({ callDelayMs: 3000 })
    const { conn, statuses, unregisterAll } = await connect(fake, { timeoutMs: 5000 })

    const pending = conn.call('echo', { text: 'in-flight' })
    await conn.close()
    await expect(pending).rejects.toThrow(/connection to mcp server "demo" was closed/)
    await expect(conn.call('echo', { text: 'later' })).rejects.toThrow(/mcp server "demo" is not connected/)
    expect(unregisterAll).toHaveBeenCalledTimes(1)
    expect(statuses[statuses.length - 1]).toEqual({ state: 'stopped', toolCount: 0 })
  })

  it('reports handshake failures through setStatus and surfaces HTTP error statuses', async () => {
    const fake = await startFake({ initializeStatus: 500 })
    const registered: ToolDefinition[] = []
    const statuses: HttpMcpStatus[] = []

    await expect(
      connectHttpServer(
        'broken',
        { url: fake.url },
        (def) => {
          registered.push(def)
        },
        () => {},
        (status) => {
          statuses.push({ ...status })
        },
      ),
    ).rejects.toThrow(/status 500/)

    expect(registered).toHaveLength(0)
    expect(statuses[0]).toEqual({ state: 'connecting', toolCount: 0 })
    expect(statuses[statuses.length - 1]).toMatchObject({ state: 'error', toolCount: 0 })
  })
})

describe('contentToResult', () => {
  it('joins text parts, converts image parts and skips unknown items', () => {
    expect(
      contentToResult([
        { type: 'text', text: 'line one' },
        { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
        { type: 'text', text: 'line two' },
        { type: 'resource', uri: 'file:///x' },
        null,
      ]),
    ).toEqual({ output: 'line one\nline two', images: ['data:image/jpeg;base64,QUJD'] })
  })

  it('renders empty output as (empty result) and honors content-level isError', () => {
    expect(contentToResult([])).toEqual({ output: '(empty result)' })
    expect(contentToResult([{ type: 'image', data: 'AA==' }])).toEqual({
      output: '(empty result)',
      images: ['data:image/png;base64,AA=='],
    })
    expect(contentToResult([{ type: 'text', text: 'boom', isError: true }]).isError).toBe(true)
  })
})
