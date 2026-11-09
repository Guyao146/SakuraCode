/** Restricted workspace-sharing protocol. No arbitrary URLs, HTTP proxying or desktop credentials. */
import { createHash, randomBytes } from 'node:crypto'
import { isLoopbackHost } from '../web/access.js'

export const SHARE_LIMITS = {
  rooms: 32, devices: 8, pending: 32, operations: 1024, frameBytes: 256 * 1024,
  taskChars: 8000, nameChars: 60, historyChars: 120_000, historyEntries: 160,
  inviteMs: 10 * 60_000, shareMs: 2 * 60 * 60_000, requestMs: 15_000, heartbeatMs: 15_000,
} as const
export type ShareRole = 'viewer' | 'controller'
export interface ShareDevice { id: string; name: string; role: ShareRole; online: boolean; connectedAt: number }
export interface ShareStatus {
  phase: 'idle' | 'connecting' | 'online' | 'offline' | 'error'
  relayOrigin?: string
  roomId?: string
  workspaceId?: string
  expiresAt?: number
  inviteExpiresAt?: number
  inviteUrl?: string
  devices: ShareDevice[]
  error?: string
}
export interface SharedWorkspace {
  workspaceId: string
  name: string
  revision: number
  sessionId: string | null
  busy: boolean
  expertMode: boolean
  sessions: Array<{ id: string; title: string; updatedAt: string; status: string }>
  agents: Array<{ id: string; name: string; status: string; role: string }>
  todos: Array<{ content: string; status: string }>
}
export interface SharedHistory {
  sessionId: string
  entries: Array<{ seq: number; time: string; kind: 'user' | 'assistant' | 'expert' | 'tool' | 'note'; text: string; label?: string }>
  truncated: boolean
}
export interface ShareRequest {
  requestId: string
  deviceId: string
  operationId: string
  kind: 'state' | 'history' | 'message' | 'stop'
  sessionId?: string
  text?: string
}
export interface ShareReply { status: number; data?: unknown; error?: string }
export interface ShareResponse extends ShareReply { requestId: string }
export interface ShareEvent {
  type: 'changed' | 'text' | 'turn' | 'tool'
  sessionId?: string
  agentId?: string
  text?: string
  name?: string
}
export type RelayOwnerEvent =
  | { type: 'hello' }
  | { type: 'device'; device: ShareDevice }
  | { type: 'request'; request: ShareRequest }
  | { type: 'closed'; reason: string }
export interface ShareCreateRequest { inviteHash: string; inviteExpiresAt: number; expiresAt: number }
export interface ShareCreated { roomId: string; ownerToken: string; expiresAt: number }
export interface SharePublish { snapshot?: SharedWorkspace; event?: ShareEvent; response?: ShareResponse }

export function shareSecret(): string { return randomBytes(32).toString('hex') }
export function shareDigest(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function isShareSecret(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) }
export function isShareId(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) }
export function shareId(): string { return randomBytes(16).toString('hex') }
export function shareOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('中转地址必须是 HTTPS origin。')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('中转地址无效。') }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error('中转地址须为不带路径、凭据或参数的 HTTPS origin；HTTP 仅限本机测试。')
  }
  return url.origin
}
export function registrationToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(value)) throw new Error('中转注册凭据须为 32～256 位随机非空白字符。')
  return value
}
export function validShareRole(value: unknown): value is ShareRole { return value === 'viewer' || value === 'controller' }
