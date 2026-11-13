/** Public v1 contracts for explicitly configured external software and knowledge. */
import type { JsonSchemaObject, ToolResult } from '../core/types.js'

export const CONNECTOR_LIMITS = Object.freeze({ connections: 32, actions: 128, schemaBytes: 64 * 1024,
  requestBytes: 256 * 1024, responseBytes: 1024 * 1024, concurrent: 4, timeoutMs: 120_000,
  searchResults: 20, searchChars: 16_000, readChars: 12_000 })

export interface ConnectorConfig {
  id: string
  name: string
  category: 'software' | 'knowledge'
  adapter: string
  url?: string
  command?: string
  args?: string[]
  /** Values are environment variable names, never credentials. */
  headersEnv?: Record<string, string>
  envRefs?: Record<string, string>
  timeoutMs?: number
  autoConnect?: boolean
  enabledActions?: string[]
  /** Manifest fingerprint confirmed when these capabilities were enabled. */
  approvedCapabilities?: string
  knowledgeEnabled?: boolean
  /** MCP tool bindings must return the v1 knowledge JSON contract. */
  knowledgeTools?: { search: string; read: string }
}

export interface ConnectorAction { name: string; description: string; parameters: JsonSchemaObject }
export interface ConnectorCapabilities {
  version: 1
  actions: ConnectorAction[]
  knowledge?: { search: boolean; read: boolean }
}
export interface ExternalKnowledgeHit {
  id: string; snippet: string; title?: string; source?: string; version?: string; startLine?: number; endLine?: number
}
export interface ExternalKnowledgeSearch { results: ExternalKnowledgeHit[]; truncated: boolean }
export interface ExternalKnowledgeRead {
  id: string; content: string; source?: string; version?: string; startLine?: number; endLine?: number
  cursor?: string; truncated: boolean
}
export interface ConnectorSession {
  capabilities: ConnectorCapabilities
  call(action: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
  search?(query: string, options: { limit: number; maxChars: number }, signal: AbortSignal): Promise<ExternalKnowledgeSearch>
  read?(id: string, options: { cursor?: string; version?: string; maxChars: number }, signal: AbortSignal): Promise<ExternalKnowledgeRead>
  close(): Promise<void> | void
  /** Optional transport lifecycle notification; a stopped software process revokes its tools. */
  onClose?(listener: () => void): () => void
}
export interface ConnectorAdapter {
  id: string
  version: 1
  description: string
  connect(config: Readonly<ConnectorConfig>, context: { cwd: string; signal: AbortSignal }): Promise<ConnectorSession>
}
export interface ConnectorStatus {
  id: string; state: 'disconnected' | 'connecting' | 'connected' | 'error'
  capabilities?: ConnectorCapabilities
  capabilitiesFingerprint?: string
  error?: string
}
export interface ConnectorSnapshot {
  revision: number; fingerprint: string; connections: ConnectorConfig[]; statuses: ConnectorStatus[]; error?: string
}
export interface ConnectorRevision { revision: number; fingerprint: string }
export class ConnectorError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ConnectorError' }
}
