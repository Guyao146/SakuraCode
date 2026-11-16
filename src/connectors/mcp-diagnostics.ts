/** Strict MCP diagnostic contracts shared by the existing stdio/HTTP transports. */
import { ConnectorDiagnosticError } from './types.js'
import { validateCapabilities } from './validation.js'
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export interface McpDiagnosticObserver {
  onStage(stage: 'connection' | 'handshake'): void
  onTools(tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>): void
}
export function diagnosticHandshake(value: unknown): void {
  if (!object(value) || value.protocolVersion !== '2025-03-26' || !object(value.capabilities) || !object(value.serverInfo) || typeof value.serverInfo.name !== 'string' || typeof value.serverInfo.version !== 'string') throw new ConnectorDiagnosticError('handshake', 'MALFORMED_RESPONSE')
}
export function diagnosticTools(value: unknown): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
  try {
    if (!object(value) || !Array.isArray(value.tools) || value.nextCursor !== undefined) throw new Error()
    const capabilities = validateCapabilities({ version: 1, actions: value.tools.map(raw => {
      if (!object(raw)) throw new Error()
      return { name: raw.name, description: raw.description === undefined ? raw.name : raw.description, parameters: raw.inputSchema }
    }) })
    return capabilities.actions.map(action => ({ name: action.name, description: action.description, inputSchema: action.parameters }))
  } catch { throw new ConnectorDiagnosticError('capabilities', 'INVALID_MANIFEST') }
}
