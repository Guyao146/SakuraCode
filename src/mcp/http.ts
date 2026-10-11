/**
 * src/mcp/http.ts — MCP client transport over streamable HTTP (the JSON-mode
 * subset of the MCP 2025-03-26 protocol).
 *
 * Mirrors the connection lifecycle of the stdio transport in src/mcp/index.ts
 * (initialize handshake → notifications/initialized → tools/list → bridged
 * tools/call with `mcp__<server>__<tool>` definitions, kind 'execute') but as
 * a self-contained factory: `connectHttpServer` performs the handshake, hands
 * fully-built ToolDefinitions to the caller's registerTool callback and
 * reports state transitions through the caller's setStatus callback. All
 * `mcp/status` emission stays with the caller — the McpManager owns
 * emitStatus for both transports (see the integration note at the bottom).
 *
 * Zero dependencies: JSON-RPC over fetch. Response bodies may be JSON or SSE
 * (`data:` frames); both are parsed. The optional server → client GET SSE
 * stream of the 2025-03-26 spec is intentionally not implemented — every
 * request carries its own response (JSON polling mode), which is sufficient
 * for tool bridging; server → client requests (e.g. ping) therefore cannot
 * be answered in this mode.
 */

import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface HttpMcpServerConfig {
  /** Base URL of the MCP endpoint (e.g. http://127.0.0.1:3000/mcp). */
  url: string
  /** Extra request headers (e.g. Authorization); win over the defaults. */
  headers?: Record<string, string>
  /** Per-tool-call timeout in ms (default 120000). */
  timeoutMs?: number
}

/** Same lifecycle states as the stdio transport's McpServerState. */
export type HttpMcpState = 'connecting' | 'connected' | 'error' | 'stopped'

export interface HttpMcpStatus {
  state: HttpMcpState
  toolCount: number
  error?: string
}

export type HttpMcpStatusListener = (status: HttpMcpStatus) => void

export interface HttpMcpConnection {
  /** Server-issued mcp-session-id, when the server grants one. */
  readonly sessionId: string | undefined
  /** Call a tool by its server-side name; resolves to the bridged ToolResult. */
  call(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>
  /**
   * Stop the connection: abort in-flight calls (rejected with "was closed"),
   * reject later calls ("is not connected"), invoke unregisterAll and report
   * { state: 'stopped', toolCount: 0 } through setStatus. Idempotent.
   */
  close(): Promise<void>
}

/**
 * Convert an MCP CallToolResult content array into the SakuraCode ToolResult
 * shape (same rules as the stdio transport's callTool): text parts join into
 * `output`, image parts become data: URLs, empty output renders as
 * "(empty result)". Tolerant: non-object items and unknown types are skipped;
 * a part carrying `isError: true` marks the whole result (the standard
 * result-level isError flag is merged by the caller).
 */
export function contentToResult(content: unknown[]): { output: string; images?: string[]; isError?: boolean } {
  const lines: string[] = []
  const images: string[] = []
  let isError = false
  for (const item of content) {
    if (!item || typeof item !== 'object') continue
    const part = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown; isError?: unknown }
    if (part.type === 'text' && typeof part.text === 'string') {
      lines.push(part.text)
    } else if (part.type === 'image' && typeof part.data === 'string') {
      const mime = typeof part.mimeType === 'string' && part.mimeType ? part.mimeType : 'image/png'
      images.push(`data:${mime};base64,${part.data}`)
    }
    if (part.isError === true) isError = true
  }
  return {
    output: lines.length > 0 ? lines.join('\n') : '(empty result)',
    ...(isError ? { isError: true } : {}),
    ...(images.length > 0 ? { images } : {}),
  }
}

// ---------------------------------------------------------------------------
// Internals — small helpers duplicated from src/mcp/index.ts, which is
// read-only and does not export them. If the HTTP branch is integrated into
// McpManager, consider exporting these from index.ts instead.
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '2025-03-26'
/** The HTTP transport identifies as sakuracode 0.2.0 (stdio ships 0.1.0). */
const CLIENT_INFO = { name: 'sakuracode', version: '0.2.0' }
const HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000

function normalizeParameters(inputSchema: unknown): JsonSchemaObject {
  if (inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)) {
    const candidate = inputSchema as { type?: unknown }
    if (candidate.type === 'object') return inputSchema as JsonSchemaObject
  }
  return { type: 'object', properties: {} }
}

function describeRpcError(error: unknown): string {
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const e = error as { message?: unknown; code?: unknown }
    const message = typeof e.message === 'string' && e.message ? e.message : JSON.stringify(error)
    return e.code !== undefined ? `JSON-RPC error ${String(e.code)}: ${message}` : message
  }
  return String(error)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface HttpConnState {
  name: string
  cfg: HttpMcpServerConfig
  sessionId?: string
  nextId: number
  closed: boolean
  readonly inFlight: Set<AbortController>
}

function buildHeaders(state: HttpConnState): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': PROTOCOL_VERSION,
    ...(state.sessionId ? { 'mcp-session-id': state.sessionId } : {}),
    ...state.cfg.headers,
  }
}

/**
 * Decode an SSE response body until the JSON-RPC message answering
 * `requestId` arrives (POST responses may stream their reply as
 * `data:` frames while keeping the connection open).
 *
 * `signal` is the same composite (call timeout + caller abort + close) that
 * was given to fetch: `reader.read()` has no deadline of its own, so the
 * reader must be cancelled explicitly when that signal fires — a server that
 * answers 200 + text/event-stream and then never sends the terminating frame
 * would otherwise keep the tool call pending. The rejection raised here (or
 * by the aborted fetch itself) is mapped onto the timeout/abort vocabulary by
 * postJson, the single owner of those messages.
 */
async function readSseResponse(
  response: Response,
  requestId: number,
  methodLabel: string,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error(`mcp http: empty SSE response to "${methodLabel}"`)
  const decoder = new TextDecoder()
  let buffer = ''
  // Cancelling settles a pending read() (done: true) and releases the socket;
  // the fetch abort alone is not a contract this reader may depend on.
  const cancelOnAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  if (signal.aborted) cancelOnAbort()
  else signal.addEventListener('abort', cancelOnAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        let message: unknown
        try {
          message = JSON.parse(payload)
        } catch {
          continue // tolerate keep-alive noise and partial frames
        }
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          if ((message as { id?: unknown }).id === requestId) return message
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort)
    void reader.cancel().catch(() => {})
  }
  throw new Error(`mcp http: SSE stream ended without a response to "${methodLabel}"`)
}

/**
 * POST one JSON-RPC message. Resolves the parsed response object, or
 * undefined for empty bodies (e.g. 202 notification acks). Non-2xx replies
 * and transport-level failures throw; timeouts and aborts are mapped onto
 * the stdio transport's error vocabulary.
 */
async function postJson(
  state: HttpConnState,
  message: unknown,
  methodLabel: string,
  requestId: number | undefined,
  timeoutMs: number,
  extraSignal?: AbortSignal,
): Promise<unknown> {
  if (state.closed) throw new Error(`mcp server "${state.name}" is not connected`)
  const controller = new AbortController()
  state.inFlight.add(controller)
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signals: AbortSignal[] = [controller.signal, timeoutSignal]
  if (extraSignal) signals.push(extraSignal)
  // One composite for the whole exchange: fetch and the SSE body reader share
  // it so a timeout/caller abort cuts the stream, not just the request.
  const abortSignal = AbortSignal.any(signals)
  try {
    const response = await fetch(state.cfg.url, {
      method: 'POST',
      headers: buildHeaders(state),
      body: JSON.stringify(message),
      signal: abortSignal,
    })
    const session = response.headers.get('mcp-session-id')
    if (session) state.sessionId = session
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`mcp http ${methodLabel} failed with status ${response.status}: ${body.slice(0, 200)}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      if (requestId === undefined) {
        try {
          await response.body?.cancel()
        } catch {
          /* draining a notification stream is best effort */
        }
        return undefined
      }
      return await readSseResponse(response, requestId, methodLabel, abortSignal)
    }
    const text = await response.text()
    if (!text.trim()) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`mcp http: invalid JSON response to "${methodLabel}"`)
    }
    return parsed
  } catch (error) {
    if (state.closed) throw new Error(`connection to mcp server "${state.name}" was closed`)
    if (timeoutSignal.aborted) throw new Error(`mcp request "${methodLabel}" timed out after ${timeoutMs}ms`)
    if (extraSignal?.aborted) throw new Error('mcp tool call aborted')
    throw error
  } finally {
    state.inFlight.delete(controller)
  }
}

interface JsonRpcResponse {
  id?: unknown
  result?: unknown
  error?: unknown
}

async function rpc<T>(
  state: HttpConnState,
  method: string,
  params: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  const id = ++state.nextId
  const body = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
  const parsed = await postJson(state, body, method, id, timeoutMs, signal)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mcp http: invalid response to "${method}"`)
  }
  const message = parsed as JsonRpcResponse
  if (!('result' in message) && !('error' in message)) {
    throw new Error(`mcp http: invalid JSON-RPC response to "${method}"`)
  }
  if (message.error !== undefined && message.error !== null) {
    throw new Error(describeRpcError(message.error))
  }
  return message.result as T
}

/** Fire-and-forget notification (a 202/empty reply is normal); failures are tolerated. */
async function notify(state: HttpConnState, method: string, timeoutMs: number): Promise<void> {
  try {
    await postJson(state, { jsonrpc: '2.0', method }, method, undefined, timeoutMs)
  } catch {
    /* the stdio notify is a best-effort pipe write; mirror that here */
  }
}

async function callTool(
  state: HttpConnState,
  toolName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const timeoutMs = state.cfg.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
  const result = await rpc<{ content?: unknown; isError?: unknown }>(
    state,
    'tools/call',
    { name: toolName, arguments: args },
    timeoutMs,
    signal,
  )
  const content =
    result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : []
  const converted = contentToResult(content)
  if (result && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
    converted.isError = true
  }
  return converted
}

function closeConnection(
  state: HttpConnState,
  unregisterAll: () => void,
  setStatus: HttpMcpStatusListener,
): Promise<void> {
  if (state.closed) return Promise.resolve()
  state.closed = true
  for (const controller of [...state.inFlight]) controller.abort()
  state.inFlight.clear()
  try {
    unregisterAll()
  } catch {
    /* best effort, mirrors the stdio shutdown */
  }
  setStatus({ state: 'stopped', toolCount: 0 })
  return Promise.resolve()
}

// ---------------------------------------------------------------------------
// Connection factory
// ---------------------------------------------------------------------------

/**
 * Connect to a streamable-HTTP MCP server (JSON mode): initialize handshake
 * → notifications/initialized → tools/list → hand one ToolDefinition per
 * listed tool to `registerTool` (failures to register are collected into the
 * connected status' error field, mirroring the stdio manager). Resolves with
 * a minimal handle whose `call` backs every bridged tool's execute.
 *
 * Status reporting is callback-based so the caller (McpManager) stays the
 * single owner of `mcp/status` emission: `setStatus` is invoked with
 * connecting → connected, or connecting → error on handshake failure.
 */
export async function connectHttpServer(
  name: string,
  cfg: HttpMcpServerConfig,
  registerTool: (def: ToolDefinition) => void,
  unregisterAll: () => void,
  setStatus: HttpMcpStatusListener,
): Promise<HttpMcpConnection> {
  const state: HttpConnState = { name, cfg, nextId: 0, closed: false, inFlight: new Set() }
  setStatus({ state: 'connecting', toolCount: 0 })
  try {
    await rpc(state, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, HANDSHAKE_TIMEOUT_MS)
    await notify(state, 'notifications/initialized', HANDSHAKE_TIMEOUT_MS)
    const listing = await rpc<{ tools?: unknown }>(state, 'tools/list', {}, HANDSHAKE_TIMEOUT_MS)
    const tools = Array.isArray(listing?.tools) ? listing.tools : []

    let toolCount = 0
    const skipped: string[] = []
    for (const raw of tools) {
      if (!raw || typeof raw !== 'object') continue
      const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
      if (typeof tool.name !== 'string' || !tool.name) continue
      const toolName: string = tool.name
      const fullName = `mcp__${name}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_')
      const description =
        typeof tool.description === 'string' && tool.description ? tool.description : toolName
      const definition: ToolDefinition = {
        name: fullName,
        description: `[mcp:${name}] ${description}`,
        parameters: normalizeParameters(tool.inputSchema),
        kind: 'execute',
        execute: (args: Record<string, unknown>, tc: ToolContext): Promise<ToolResult> =>
          callTool(state, toolName, args, tc.signal),
      }
      try {
        registerTool(definition)
        toolCount += 1
      } catch (error) {
        skipped.push(`tool "${fullName}" skipped: ${describeError(error)}`)
      }
    }

    setStatus({ state: 'connected', toolCount, ...(skipped.length > 0 ? { error: skipped.join('; ') } : {}) })
    return {
      get sessionId() {
        return state.sessionId
      },
      call: (toolName, args, signal) => callTool(state, toolName, args, signal),
      close: () => closeConnection(state, unregisterAll, setStatus),
    }
  } catch (error) {
    setStatus({ state: 'error', toolCount: 0, error: describeError(error) })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Integration note (for the McpManager in src/mcp/index.ts — read-only here):
//
// 1. Extend McpServerConfig with `url?: string` and `headers?: Record<string,
//    string>` (command becomes optional).
// 2. Add `http?: HttpMcpConnection` to ServerEntry; in shutdownEntry(), before
//    failing pending: `entry.http?.close(); entry.http = undefined` (close()
//    completes synchronously — rejects in-flight calls, unregisters tools and
//    reports stopped via the setStatus callback below; no emission needed).
// 3. In connect()'s try block, branch before spawn:
//
//      if (config.url) {
//        const registry = this.toolsService()
//        entry.http = await connectHttpServer(
//          name,
//          { url: config.url, headers: config.headers, timeoutMs: config.timeoutMs },
//          (def) => {
//            const dispose = registry.register(def)
//            entry.disposers.push(dispose)
//            entry.tools.push({ name: def.name, description: def.description })
//            entry.toolCount = entry.disposers.length
//          },
//          () => this.unregisterTools(entry),
//          (s) => {
//            entry.state = s.state
//            entry.toolCount = s.toolCount
//            entry.error = s.error
//          },
//        )
//        this.emitStatus(entry) // connected — same tail as the stdio path
//        return
//      }
//
//    The existing catch/stopAll/reconnect paths then work unchanged for HTTP
//    (connectHttpServer throws on handshake failure → catch sets error and
//    emits, exactly like the stdio path).
// ---------------------------------------------------------------------------
