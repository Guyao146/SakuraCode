/** Reuse the existing MCP manager in a private registry; no duplicate RPC implementation. */
import { Context } from '../kernel/index.js'
import { ToolsService } from '../core/tools.js'
import { McpManager, type McpServerConfig } from '../mcp/index.js'
import type { ConnectorAdapter } from './types.js'
import { ConnectorError } from './types.js'
import { connectorUrl, resolveConnectorHeaders, validateCapabilities, validateExternalRead, validateExternalSearch } from './validation.js'

const PROCESS_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
export const mcpConnectorAdapter: ConnectorAdapter = {
  id: 'mcp', version: 1, description: 'MCP stdio / Streamable HTTP, with explicitly enabled capabilities',
  async connect(config, context) {
    const scope = new Context()
    const tools = new ToolsService(scope)
    scope.provide('tools'); scope.set('tools', tools)
    const env: Record<string, string> = {}
    for (const name of PROCESS_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]!
    for (const [name, variable] of Object.entries(config.envRefs ?? {})) {
      const value = process.env[variable]
      if (value === undefined || value.length > 8192 || value.includes('\0')) throw new ConnectorError(400, `process environment reference ${variable} is missing or invalid`)
      env[name] = value
    }
    const server: McpServerConfig = config.url
      ? { url: connectorUrl(config.url), headers: resolveConnectorHeaders(config), timeoutMs: config.timeoutMs }
      : { command: config.command, args: config.args, env, inheritEnv: false, timeoutMs: config.timeoutMs }
    const manager = new McpManager(scope, { [config.id]: server }, context.cwd)
    const listeners = new Set<() => void>()
    let closed = false
    scope.on('mcp/status', (payload: { server: { state: string } }) => {
      if (payload.server.state !== 'error' && payload.server.state !== 'stopped') return
      closed = true
      for (const listener of [...listeners]) listener()
    })
    const stop = () => { void manager.stopAll(); scope.dispose() }
    if (context.signal.aborted) { stop(); throw new ConnectorError(409, 'MCP connection cancelled') }
    context.signal.addEventListener('abort', stop, { once: true })
    try {
      await manager.start()
      context.signal.throwIfAborted()
      if (manager.status()[0]?.state !== 'connected' || manager.status()[0]?.error) throw new ConnectorError(502, 'MCP connection failed or contains skipped/conflicting tools; check the configured software, endpoint and credentials')
      const prefix = `mcp__${config.id}__`
      const definitions = new Map(tools.list().map(tool => [tool.name.slice(prefix.length), tool]))
      const search = config.knowledgeTools?.search, read = config.knowledgeTools?.read
      if (config.knowledgeTools && (!definitions.has(search!) || !definitions.has(read!))) throw new ConnectorError(502, 'configured MCP knowledge bindings were not discovered')
      const capabilities = validateCapabilities({ version: 1,
        actions: [...definitions].map(([name, definition]) => ({ name, description: definition.description, parameters: definition.parameters })),
        ...(search && read ? { knowledge: { search: true, read: true } } : {}) })
      async function call(name: string, args: Record<string, unknown>, signal: AbortSignal) {
        context.signal.throwIfAborted(); signal.throwIfAborted()
        const definition = definitions.get(name)
        if (!definition) throw new ConnectorError(404, 'MCP action was not discovered')
        const result = await definition.execute(args, { sessionId: 'connector', agentId: 'connector', signal })
        return typeof result === 'string' ? { output: result } : result
      }
      async function json(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
        const result = await call(name, args, signal)
        if (result.isError) throw new ConnectorError(502, 'MCP knowledge tool returned an error')
        try { return JSON.parse(result.output) } catch { throw new ConnectorError(502, 'MCP knowledge tools must return the v1 JSON result contract') }
      }
      return {
        capabilities, call,
        ...(search && read ? {
          search: async (query: string, options: { limit: number; maxChars: number }, signal: AbortSignal) =>
            validateExternalSearch(await json(search, { query, ...options }, signal), options.limit, options.maxChars),
          read: async (id: string, options: { cursor?: string; version?: string; maxChars: number }, signal: AbortSignal) =>
            validateExternalRead(await json(read, { id, ...options }, signal), id, options.maxChars),
        } : {}),
        close: () => { context.signal.removeEventListener('abort', stop); listeners.clear(); stop() },
        onClose: (listener: () => void) => { listeners.add(listener); if (closed) listener(); return () => listeners.delete(listener) },
      }
    } catch (error) { context.signal.removeEventListener('abort', stop); stop(); throw error }
  },
}
