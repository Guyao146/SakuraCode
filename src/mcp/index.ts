/**
 * ctx.mcp — MCP (Model Context Protocol) client manager.
 *
 * Launches MCP servers over the stdio transport (newline-delimited JSON-RPC
 * 2.0, the 2025-03-26 protocol subset), performs the initialize handshake,
 * lists their tools and bridges each one into ctx.tools as
 * `mcp__<server>__<tool>`. Zero dependencies: the JSON-RPC framing is
 * hand-rolled on top of child process pipes.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import * as path from 'node:path'
import type { Context, Plugin } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { connectHttpServer, type HttpMcpConnection } from './http.js'

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  /** stdio transport: the executable. Optional when `url` is set. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Streamable HTTP transport: connect to this URL instead of spawning. */
  url?: string
  headers?: Record<string, string>
  /** Per-tool-call timeout in ms (default 120000). */
  timeoutMs?: number
}

export type McpServerState = 'connecting' | 'connected' | 'error' | 'stopped'

export interface McpServerStatus {
  name: string
  state: McpServerState
  toolCount: number
  error?: string
}

export interface McpService {
  status(): McpServerStatus[]
  /** Reconnect the named server, or every configured server when omitted. Fails with state=error and rethrows. */
  reconnect(name?: string): Promise<void>
  listTools(): Array<{ server: string; name: string; description: string }>
  stopAll(): Promise<void>
}

export interface McpPluginConfig {
  cwd?: string
  servers?: Record<string, McpServerConfig>
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = '2025-03-26'
const CLIENT_INFO = { name: 'sakuracode', version: '0.1.0' }
const HANDSHAKE_TIMEOUT_MS = 15_000
const DEFAULT_CALL_TIMEOUT_MS = 120_000
const STDERR_TAIL_CHARS = 4_000

/** On Windows the npm-family launchers ship as .cmd shims. */
const WIN32_CMD_SHIMS = new Set(['npx', 'npm', 'uvx', 'pnpm', 'yarn'])

/**
 * Windows: bare names of the npm-family launchers must resolve to their .cmd
 * shims (node_modules/.bin only carries .cmd wrappers there). Everything else
 * is returned unchanged. Callers spawning the result must enable shell mode
 * when it ends in .cmd/.bat (Node ≥18.20 rejects shell-less .cmd spawns).
 */
export function resolveCommand(command: string): string {
  if (process.platform !== 'win32') return command
  const trimmed = command.trim()
  if (!trimmed) return command
  if (/\.(exe|cmd|bat|com)$/i.test(trimmed)) return trimmed
  const base = path.basename(trimmed)
  if (WIN32_CMD_SHIMS.has(base.toLowerCase())) return `${trimmed}.cmd`
  return trimmed
}

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

interface PendingRequest {
  // `any` — the map holds requests of mixed result types (handshake + calls).
  resolve: (value: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface RegisteredTool {
  name: string
  description: string
}

interface ServerEntry {
  name: string
  config: McpServerConfig
  state: McpServerState
  error?: string
  toolCount: number
  child?: ChildProcess
  pending: Map<number | string, PendingRequest>
  /** Unparsed stdout tail (up to the next newline). */
  lineBuf: string
  stderrTail: string
  nextId: number
  /** Set for intentional stops so the exit handler keeps the managed state. */
  stopping: boolean
  disposers: Array<() => void>
  /** HTTP-transport connection (config.url instead of a spawned process). */
  http?: HttpMcpConnection
  tools: RegisteredTool[]
}

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

export class McpManager implements McpService {
  private readonly ctx: Context
  private readonly configs: Map<string, McpServerConfig>
  private readonly servers = new Map<string, ServerEntry>()

  constructor(ctx: Context, servers: Record<string, McpServerConfig>, private readonly cwd = process.cwd()) {
    this.ctx = ctx
    this.configs = new Map(Object.entries(servers))
  }

  /** Connect every configured server; failures are recorded, not thrown. */
  async start(): Promise<void> {
    await Promise.all([...this.configs.keys()].map((name) => this.connect(name).catch(() => {})))
  }

  status(): McpServerStatus[] {
    return [...this.servers.values()].map((entry) => this.toStatus(entry))
  }

  async reconnect(name?: string): Promise<void> {
    if (name !== undefined) {
      if (!this.configs.has(name)) throw new Error(`unknown mcp server "${name}"`)
      await this.connect(name)
      return
    }
    const results = await Promise.allSettled([...this.configs.keys()].map((n) => this.connect(n)))
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed) throw failed.reason
  }

  listTools(): Array<{ server: string; name: string; description: string }> {
    const out: Array<{ server: string; name: string; description: string }> = []
    for (const entry of this.servers.values()) {
      for (const tool of entry.tools) {
        out.push({ server: entry.name, name: tool.name, description: tool.description })
      }
    }
    return out
  }

  async stopAll(): Promise<void> {
    for (const entry of [...this.servers.values()]) {
      this.shutdownEntry(entry)
      entry.state = 'stopped'
      this.emitStatus(entry)
    }
  }

  // -- connection lifecycle -------------------------------------------------

  private async connect(name: string): Promise<void> {
    const config = this.configs.get(name)
    if (!config) throw new Error(`unknown mcp server "${name}"`)

    const existing = this.servers.get(name)
    if (existing) this.shutdownEntry(existing)

    const entry: ServerEntry = {
      name,
      config,
      state: 'connecting',
      toolCount: 0,
      pending: new Map(),
      lineBuf: '',
      stderrTail: '',
      nextId: 0,
      stopping: false,
      disposers: [],
      tools: [],
    }
    this.servers.set(name, entry)
    this.emitStatus(entry)

    // Streamable HTTP transport: no spawned process — the connection object
    // owns the session; the manager keeps sole ownership of status emits.
    if (config.url) {
      try {
        const connection = await connectHttpServer(
          name,
          { url: config.url, headers: config.headers, timeoutMs: config.timeoutMs },
          (definition) => {
            try {
              const dispose = this.toolsService().register(definition)
              entry.disposers.push(dispose)
              entry.tools.push({ name: definition.name, description: definition.description })
              entry.toolCount = entry.disposers.length
            } catch (toolError) {
              entry.error = `tool "${definition.name}" skipped: ${describeError(toolError)}`
            }
          },
          () => {
            this.unregisterTools(entry)
            entry.toolCount = 0
          },
          (status) => {
            entry.state = status.state
            if (status.error !== undefined) entry.error = status.error
            entry.toolCount = status.toolCount
          },
        )
        entry.http = connection
        entry.state = 'connected'
        this.emitStatus(entry)
        return
      } catch (error) {
        this.shutdownEntry(entry)
        entry.state = 'error'
        entry.error = describeError(error)
        if (this.servers.get(entry.name) === entry) this.emitStatus(entry)
        throw error
      }
    }

    if (!config.command) throw new Error(`mcp server "${name}" needs either "command" (stdio) or "url" (http)`)

    try {
      const resolved = resolveCommand(config.command)
      const options: SpawnOptions = {
        cwd: this.cwd,
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }
      // Node ≥18.20 refuses to spawn .cmd/.bat without a shell on Windows.
      if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolved)) options.shell = true

      const child = spawn(resolved, config.args ?? [], options)
      entry.child = child
      child.stdin?.on('error', () => {}) // EPIPE when the server dies mid-write
      child.stdout?.on('data', (chunk: Buffer) => this.onStdout(entry, chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.onStderr(entry, chunk))
      child.on('exit', (code, signal) => this.onExit(entry, code, signal))
      child.on('error', (error) => this.onChildError(entry, error))

      await this.request(entry, 'initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO }, HANDSHAKE_TIMEOUT_MS)
      this.notify(entry, 'notifications/initialized')
      const listing = await this.request<{ tools?: unknown }>(entry, 'tools/list', {}, HANDSHAKE_TIMEOUT_MS)
      const tools = Array.isArray(listing?.tools) ? listing.tools : []
      this.registerTools(entry, tools)

      entry.state = 'connected'
      this.emitStatus(entry)
    } catch (error) {
      const tail = entry.stderrTail.trim()
      const message = describeError(error)
      const full = tail ? `${message} — stderr: ${tail}` : message
      this.shutdownEntry(entry)
      entry.state = 'error'
      entry.error = full
      if (this.servers.get(entry.name) === entry) this.emitStatus(entry)
      throw error
    }
  }

  /** Intentional stop: kill the child, reject pending, unregister tools. */
  private shutdownEntry(entry: ServerEntry): void {
    entry.stopping = true
    if (entry.http) {
      const http = entry.http
      entry.http = undefined
      void http.close().catch(() => {})
    }
    const child = entry.child
    entry.child = undefined
    if (child) {
      try {
        child.kill()
      } catch {
        /* already dead */
      }
    }
    this.failPending(entry, `connection to mcp server "${entry.name}" was closed`)
    entry.lineBuf = ''
    this.unregisterTools(entry)
    entry.toolCount = 0
  }

  // -- tool bridge -----------------------------------------------------------

  private toolsService(): ToolsService {
    const tools = this.ctx.peek<ToolsService>('tools')
    if (!tools) throw new Error('ctx.tools is not available — mount core-tools before mcp-manager')
    return tools
  }

  private registerTools(entry: ServerEntry, tools: unknown[]): void {
    const registry = this.toolsService()
    const callTimeoutMs = entry.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
    const skipped: string[] = []
    for (const raw of tools) {
      if (!raw || typeof raw !== 'object') continue
      const tool = raw as { name?: unknown; description?: unknown; inputSchema?: unknown }
      if (typeof tool.name !== 'string' || !tool.name) continue
      const toolName: string = tool.name
      const fullName = `mcp__${entry.name}__${toolName}`.replace(/[^A-Za-z0-9_-]/g, '_')
      const description =
        typeof tool.description === 'string' && tool.description ? tool.description : toolName
      const definition: ToolDefinition = {
        name: fullName,
        description: `[mcp:${entry.name}] ${description}`,
        parameters: normalizeParameters(tool.inputSchema),
        kind: 'execute',
        execute: (args: Record<string, unknown>, tc: ToolContext): Promise<ToolResult> =>
          this.callTool(entry, toolName, args, callTimeoutMs, tc.signal),
      }
      try {
        const dispose = registry.register(definition)
        entry.disposers.push(dispose)
        entry.tools.push({ name: fullName, description: definition.description })
      } catch (error) {
        skipped.push(`tool "${fullName}" skipped: ${describeError(error)}`)
      }
    }
    if (skipped.length > 0) entry.error = skipped.join('; ')
    entry.toolCount = entry.disposers.length
  }

  private unregisterTools(entry: ServerEntry): void {
    for (const dispose of entry.disposers) {
      try {
        dispose()
      } catch {
        /* best effort */
      }
    }
    entry.disposers = []
    entry.tools = []
    entry.toolCount = 0
  }

  private async callTool(
    entry: ServerEntry,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const result = await this.request<{ content?: unknown; isError?: unknown }>(
      entry,
      'tools/call',
      { name: toolName, arguments: args },
      timeoutMs,
      signal,
    )
    const lines: string[] = []
    const images: string[] = []
    let isError = false
    if (result && typeof result === 'object') {
      if (result.isError === true) isError = true
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (!item || typeof item !== 'object') continue
          const part = item as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
          if (part.type === 'text' && typeof part.text === 'string') {
            lines.push(part.text)
          } else if (part.type === 'image' && typeof part.data === 'string') {
            const mime = typeof part.mimeType === 'string' && part.mimeType ? part.mimeType : 'image/png'
            images.push(`data:${mime};base64,${part.data}`)
          }
        }
      }
    }
    return {
      output: lines.length > 0 ? lines.join('\n') : '(empty result)',
      ...(isError ? { isError: true } : {}),
      ...(images.length > 0 ? { images } : {}),
    }
  }

  // -- JSON-RPC plumbing -----------------------------------------------------

  private request<T = unknown>(
    entry: ServerEntry,
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!entry.child) return Promise.reject(new Error(`mcp server "${entry.name}" is not running`))
    const id = ++entry.nextId
    return new Promise<T>((resolve, reject) => {
      let onAbort: (() => void) | undefined
      const pending: PendingRequest = {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        timer: setTimeout(() => {
          entry.pending.delete(id)
          pending.reject(new Error(`mcp request "${method}" timed out after ${timeoutMs}ms`))
        }, timeoutMs),
      }
      const cleanup = () => {
        clearTimeout(pending.timer)
        if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      }
      if (signal) {
        if (signal.aborted) {
          pending.reject(new Error('mcp tool call aborted'))
          return
        }
        onAbort = () => {
          entry.pending.delete(id)
          pending.reject(new Error('mcp tool call aborted'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      entry.pending.set(id, pending)
      this.send(entry, { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  private send(entry: ServerEntry, message: unknown): void {
    const stdin = entry.child?.stdin
    if (!stdin?.writable) return
    try {
      stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      /* the child died mid-write; the exit handler takes over */
    }
  }

  private notify(entry: ServerEntry, method: string, params?: unknown): void {
    this.send(entry, { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) })
  }

  private onStdout(entry: ServerEntry, chunk: Buffer): void {
    entry.lineBuf += chunk.toString('utf8')
    let index = entry.lineBuf.indexOf('\n')
    while (index >= 0) {
      const line = entry.lineBuf.slice(0, index)
      entry.lineBuf = entry.lineBuf.slice(index + 1)
      this.handleLine(entry, line)
      index = entry.lineBuf.indexOf('\n')
    }
  }

  private handleLine(entry: ServerEntry, line: string): void {
    const trimmed = line.replace(/\r/g, '').trim()
    if (!trimmed) return
    let message: unknown
    try {
      message = JSON.parse(trimmed)
    } catch {
      return // tolerate non-JSON noise on stdout
    }
    this.handleMessage(entry, message)
  }

  private handleMessage(entry: ServerEntry, message: unknown): void {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return
    const msg = message as { id?: unknown; method?: unknown; result?: unknown; error?: unknown }

    if (typeof msg.method === 'string') {
      // Notifications (no id, or a notifications/* method) carry no response.
      if (msg.id === undefined || msg.method.startsWith('notifications/')) return
      // Server → client request: answer ping, refuse everything else.
      if (msg.method === 'ping') {
        this.send(entry, { jsonrpc: '2.0', id: msg.id, result: {} })
      } else {
        this.send(entry, {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        })
      }
      return
    }

    if (typeof msg.id !== 'number' && typeof msg.id !== 'string') return
    const pending = entry.pending.get(msg.id)
    if (!pending) return
    entry.pending.delete(msg.id)
    if (msg.error !== undefined && msg.error !== null) pending.reject(new Error(describeRpcError(msg.error)))
    else pending.resolve(msg.result)
  }

  private onStderr(entry: ServerEntry, chunk: Buffer): void {
    entry.stderrTail += chunk.toString('utf8')
    if (entry.stderrTail.length > STDERR_TAIL_CHARS) {
      entry.stderrTail = entry.stderrTail.slice(-STDERR_TAIL_CHARS)
    }
  }

  private failPending(entry: ServerEntry, message: string): void {
    for (const pending of entry.pending.values()) pending.reject(new Error(message))
    entry.pending.clear()
  }

  private onExit(entry: ServerEntry, code: number | null, signal: string | null): void {
    entry.child = undefined
    this.failPending(entry, `mcp server "${entry.name}" exited`)
    if (entry.stopping) return
    if (this.servers.get(entry.name) !== entry) return
    const tail = entry.stderrTail.trim()
    const cause = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`
    this.setErrored(entry, `server exited (${cause})${tail ? `: ${tail}` : ''}`)
  }

  private onChildError(entry: ServerEntry, error: Error): void {
    this.failPending(entry, error.message)
    if (entry.stopping) return
    if (this.servers.get(entry.name) !== entry) return
    this.setErrored(entry, `failed to start server: ${error.message}`)
  }

  private setErrored(entry: ServerEntry, message: string): void {
    entry.state = 'error'
    entry.error = message
    this.unregisterTools(entry)
    this.emitStatus(entry)
  }

  // -- status ----------------------------------------------------------------

  private toStatus(entry: ServerEntry): McpServerStatus {
    return {
      name: entry.name,
      state: entry.state,
      toolCount: entry.toolCount,
      ...(entry.error ? { error: entry.error } : {}),
    }
  }

  private emitStatus(entry: ServerEntry): void {
    this.ctx.emit('mcp/status', { server: this.toStatus(entry) })
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const mcpPlugin: Plugin = {
  name: 'mcp-manager',
  description: 'MCP client manager — launches stdio MCP servers and bridges their tools into ctx.tools (ctx.mcp)',
  inject: ['tools'],
  async apply(ctx: Context, config?: McpPluginConfig): Promise<void> {
    const manager = new McpManager(ctx, config?.servers ?? {}, config?.cwd)
    ctx.provide('mcp')
    ctx.set('mcp', manager)
    ctx.effect(() => () => {
      void manager.stopAll()
    })
    await manager.start()
  },
}
