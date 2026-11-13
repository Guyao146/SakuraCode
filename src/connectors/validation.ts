/** Validation shared by connection metadata, manifests and bounded reference replies. */
import { isIP } from 'node:net'
import type { ToolResult } from '../core/types.js'
import { CONNECTOR_LIMITS, ConnectorError, type ConnectorCapabilities, type ConnectorConfig,
  type ExternalKnowledgeRead, type ExternalKnowledgeSearch } from './types.js'

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export const connectorName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(value)
const envName = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)
const controlledHeader = /^(?:host|cookie|set-cookie|content-length|content-type|accept|connection|transfer-encoding|origin|referer|upgrade|te|trailer|sec-.*|proxy-.*|mcp-.*)$/i
function text(value: unknown, name: string, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new ConnectorError(400, `invalid ${name}`)
  return value
}
export function connectorUrl(value: unknown): string {
  const raw = text(value, 'connector URL')
  let url: URL
  try { url = new URL(raw) } catch { throw new ConnectorError(400, 'invalid connector URL') }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new ConnectorError(400, 'connector URL must be HTTPS, or loopback HTTP, without credentials/query/fragment')
  }
  return url.href.replace(/\/$/, '')
}
function refs(value: unknown, headers: boolean): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!plain(value) || Object.keys(value).length > 32) throw new ConnectorError(400, 'invalid credential environment references')
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(value)) {
    if (!(headers ? /^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key) && !controlledHeader.test(key) : envName(key)) || !envName(val) || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new ConnectorError(400, 'only safe environment variable references are accepted')
    if (Object.keys(out).some(name => name.toLowerCase() === key.toLowerCase())) throw new ConnectorError(400, 'duplicate environment/header name')
    out[key] = val
  }
  return out
}
export function validateConnector(value: unknown): ConnectorConfig {
  const fields = ['id', 'name', 'category', 'adapter', 'url', 'command', 'args', 'headersEnv', 'envRefs', 'timeoutMs', 'autoConnect', 'enabledActions', 'approvedCapabilities', 'knowledgeEnabled', 'knowledgeTools']
  if (!plain(value) || Object.keys(value).some(key => !fields.includes(key))) throw new ConnectorError(400, 'invalid connector metadata; store environment references, not secrets')
  if (!connectorName(value.id) || !connectorName(value.adapter) || !['software', 'knowledge'].includes(String(value.category))) throw new ConnectorError(400, 'invalid connector id, adapter or category')
  const result: ConnectorConfig = { id: value.id, name: text(value.name, 'connector name', 100), category: value.category as ConnectorConfig['category'], adapter: value.adapter }
  if (value.url !== undefined) result.url = connectorUrl(value.url)
  if (value.command !== undefined) result.command = text(value.command, 'command', 4096)
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.length > 64 || value.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || /[\u0000\r\n]/.test(arg))) throw new ConnectorError(400, 'invalid command arguments')
    result.args = [...value.args] as string[]
  }
  if (result.adapter === 'http' && (!result.url || result.command || result.args?.length || value.envRefs !== undefined)) throw new ConnectorError(400, 'HTTP connectors require a URL, not a command')
  if (result.adapter === 'mcp' && (!!result.url === !!result.command)) throw new ConnectorError(400, 'MCP requires exactly one URL or local command')
  if (result.url && (result.command || result.args?.length || value.envRefs !== undefined)) throw new ConnectorError(400, 'network connectors cannot contain process settings')
  if (result.command && value.headersEnv !== undefined) throw new ConnectorError(400, 'local process connectors cannot contain HTTP headers')
  result.headersEnv = refs(value.headersEnv, true)
  result.envRefs = refs(value.envRefs, false)
  if (value.timeoutMs !== undefined) result.timeoutMs = boundedInteger(value.timeoutMs, 30_000, 100, CONNECTOR_LIMITS.timeoutMs, 'timeoutMs')
  for (const key of ['autoConnect', 'knowledgeEnabled'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new ConnectorError(400, `invalid ${key}`)
    result[key] = value[key] === true
  }
  if (value.enabledActions !== undefined && (!Array.isArray(value.enabledActions) || value.enabledActions.length > CONNECTOR_LIMITS.actions || value.enabledActions.some(name => !connectorName(name)) || new Set(value.enabledActions).size !== value.enabledActions.length)) throw new ConnectorError(400, 'invalid enabled actions')
  result.enabledActions = [...(value.enabledActions as string[] | undefined ?? [])]
  if (value.approvedCapabilities !== undefined) {
    if (typeof value.approvedCapabilities !== 'string' || !/^[a-f0-9]{64}$/.test(value.approvedCapabilities)) throw new ConnectorError(400, 'invalid approved capability fingerprint')
    result.approvedCapabilities = value.approvedCapabilities
  }
  if (value.knowledgeTools !== undefined) {
    if (result.adapter !== 'mcp') throw new ConnectorError(400, 'knowledge tool bindings apply only to MCP connectors')
    if (!plain(value.knowledgeTools) || Object.keys(value.knowledgeTools).some(key => !['search', 'read'].includes(key)) || !connectorName(value.knowledgeTools.search) || !connectorName(value.knowledgeTools.read)) throw new ConnectorError(400, 'knowledge tool bindings require explicit search/read names')
    result.knowledgeTools = { search: value.knowledgeTools.search, read: value.knowledgeTools.read }
  }
  return result
}
export function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new ConnectorError(400, `${name} must be ${min}–${max}`)
  return value
}
export function resolveConnectorHeaders(config: ConnectorConfig): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, variable] of Object.entries(config.headersEnv ?? {})) {
    const value = process.env[variable]
    if (!value || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new ConnectorError(400, `credential environment ${variable} is missing or invalid`)
    out[name] = value
  }
  return out
}
export function connectorSecrets(config: ConnectorConfig): string[] {
  return [...Object.values(config.headersEnv ?? {}), ...Object.values(config.envRefs ?? {})].map(name => process.env[name]).filter((value): value is string => !!value)
}
export function redactConnector(value: string, config: ConnectorConfig): string {
  return redactConnectorValues(value, connectorSecrets(config))
}
export function redactConnectorValues(value: string, secrets: readonly string[]): string {
  let result = value
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) result = result.split(secret).join('[redacted]')
  return result
}
export function containsConnectorSecret(value: unknown, secrets: readonly string[]): boolean {
  if (typeof value === 'string') return secrets.some(secret => value.includes(secret))
  if (Array.isArray(value)) return value.some(item => containsConnectorSecret(item, secrets))
  if (plain(value)) return Object.values(value).some(item => containsConnectorSecret(item, secrets))
  return false
}
export function redactConnectorData<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === 'string') return redactConnectorValues(value, secrets) as T
  if (Array.isArray(value)) return value.map(item => redactConnectorData(item, secrets)) as T
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactConnectorData(item, secrets)])) as T
  return value
}
export function validateCapabilities(value: unknown): ConnectorCapabilities {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.actions) || value.actions.length > CONNECTOR_LIMITS.actions) throw new ConnectorError(502, 'invalid connector capability manifest')
  const names = new Set<string>()
  const actions = value.actions.map(item => {
    if (!plain(item) || !connectorName(item.name) || names.has(item.name) || !plain(item.parameters) || item.parameters.type !== 'object' || Buffer.byteLength(JSON.stringify(item.parameters)) > CONNECTOR_LIMITS.schemaBytes) throw new ConnectorError(502, 'invalid, duplicate or oversized connector action')
    names.add(item.name)
    const parameters = JSON.parse(JSON.stringify(item.parameters))
    if ((parameters.required !== undefined && (!Array.isArray(parameters.required) || parameters.required.some((key: unknown) => typeof key !== 'string'))) || (parameters.properties !== undefined && !plain(parameters.properties))) throw new ConnectorError(502, 'invalid connector schema')
    return { name: item.name, description: text(item.description, 'action description', 4000), parameters }
  })
  const knowledge = value.knowledge
  if (knowledge !== undefined && (!plain(knowledge) || typeof knowledge.search !== 'boolean' || typeof knowledge.read !== 'boolean')) throw new ConnectorError(502, 'invalid knowledge capabilities')
  return { version: 1, actions, ...(plain(knowledge) ? { knowledge: { search: knowledge.search === true, read: knowledge.read === true } } : {}) }
}
function referenceFields(value: Record<string, unknown>): { source?: string; version?: string; startLine?: number; endLine?: number } {
  const result: { source?: string; version?: string; startLine?: number; endLine?: number } = {}
  for (const key of ['source', 'version'] as const) if (value[key] !== undefined) result[key] = text(value[key], key, 2048)
  for (const key of ['startLine', 'endLine'] as const) if (value[key] !== undefined) result[key] = boundedInteger(value[key], 1, 1, Number.MAX_SAFE_INTEGER, key)
  if (result.endLine !== undefined && (result.startLine === undefined || result.endLine < result.startLine)) throw new ConnectorError(502, 'invalid external source lines')
  return result
}
function clip(value: string, chars: number): string {
  let end = Math.min(value.length, chars)
  if (end < value.length && end && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--
  return value.slice(0, end)
}
export function validateExternalSearch(value: unknown, limit: number, maxChars: number): ExternalKnowledgeSearch {
  if (!plain(value) || !Array.isArray(value.results) || value.results.length > CONNECTOR_LIMITS.searchResults || typeof value.truncated !== 'boolean') throw new ConnectorError(502, 'invalid external knowledge search response')
  let remaining = maxChars, truncated = value.truncated
  const seen = new Set<string>()
  const results = []
  for (const item of value.results) {
    if (!plain(item) || typeof item.snippet !== 'string') throw new ConnectorError(502, 'invalid external knowledge result')
    const id = text(item.id, 'document id', 1024)
    if (seen.has(id)) throw new ConnectorError(502, 'duplicate external document id')
    seen.add(id)
    const fields = referenceFields(item)
    const title = item.title === undefined ? undefined : text(item.title, 'document title', 500)
    if (results.length >= limit || remaining === 0) { truncated = true; continue }
    const snippet = clip(item.snippet, remaining)
    if (snippet.length !== item.snippet.length) truncated = true
    remaining -= snippet.length
    results.push({ id, snippet, ...fields, ...(title ? { title } : {}) })
  }
  return { results, truncated }
}
export function validateExternalRead(value: unknown, id: string, maxChars: number): ExternalKnowledgeRead {
  if (!plain(value) || value.id !== id || typeof value.content !== 'string' || typeof value.truncated !== 'boolean') throw new ConnectorError(502, 'invalid external knowledge read response')
  const fields = referenceFields(value)
  const cursor = value.cursor === undefined ? undefined : text(value.cursor, 'continuation cursor', 2048)
  if (value.content.length > maxChars) throw new ConnectorError(502, 'external knowledge page exceeds its requested budget; provider must return a valid continuation cursor')
  if (value.truncated && !cursor) throw new ConnectorError(502, 'truncated external page is missing a continuation cursor')
  return { id, content: value.content, ...fields, truncated: value.truncated, ...(cursor ? { cursor } : {}) }
}
export function validateConnectorResult(value: unknown): ToolResult {
  if (!plain(value) || typeof value.output !== 'string' || Buffer.byteLength(value.output) > CONNECTOR_LIMITS.responseBytes || (value.isError !== undefined && typeof value.isError !== 'boolean')) throw new ConnectorError(502, 'invalid connector action response')
  return { output: value.output, ...(value.isError === true ? { isError: true } : {}) }
}
export function validateArguments(args: Record<string, unknown>, schema: Record<string, unknown>): void {
  const properties = plain(schema.properties) ? schema.properties : {}
  if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || args[key] === undefined)) throw new ConnectorError(400, 'connector action is missing a required argument')
  if (schema.additionalProperties === false && Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new ConnectorError(400, 'unknown connector action argument')
  for (const [key, value] of Object.entries(args)) {
    const rule = properties[key]
    if (!plain(rule)) continue
    const valid = rule.type === undefined || (rule.type === 'string' && typeof value === 'string') || (rule.type === 'boolean' && typeof value === 'boolean') || (rule.type === 'number' && typeof value === 'number' && Number.isFinite(value)) || (rule.type === 'integer' && typeof value === 'number' && Number.isSafeInteger(value)) || (rule.type === 'object' && plain(value)) || (rule.type === 'array' && Array.isArray(value)) || (rule.type === 'null' && value === null)
    if (!valid || (Array.isArray(rule.enum) && !rule.enum.includes(value)) || (typeof value === 'string' && typeof rule.maxLength === 'number' && value.length > rule.maxLength)) throw new ConnectorError(400, `invalid action argument ${key}`)
  }
}
