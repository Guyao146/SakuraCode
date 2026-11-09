/** Public, deliberately lossy sharing DTOs. Never forward desktop state or session payloads verbatim. */
import type { SessionEventRecord } from '../core/types.js'
import { isSessionId } from '../core/session.js'
import { SHARE_LIMITS, type SharedHistory, type SharedWorkspace } from '../sharing/protocol.js'

const LOCAL_PATH = '[local path]'
const REDACTED = '[redacted]'
const STATUSES = new Set(['idle', 'running', 'done', 'error', 'cancelled', 'stopped', 'waiting', 'empty', 'pending', 'completed', 'archived'])
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])
const ROLES = new Set(['main', 'sub', 'expert'])
const NOTES: Record<string, string> = {
  'context-clear': '上下文已清空。', compaction: '上下文已整理。', archive: '会话归档状态已更新。',
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function identifier(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !value.includes('..') ? value : ''
}
function timestamp(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? value : ''
}
function code(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback
}
function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? sanitizeSharedText(value.slice(0, limit)).slice(0, limit) : ''
}
function toolName(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,60}$/.test(value) ? value : 'tool'
}

/**
 * Defense in depth, NOT a promise that chat is free of sensitive information.
 * Callers should first apply the mounted model's credential redactor. Arbitrary
 * pasted secrets/business data can remain; sharing always requires explicit consent.
 */
export function sanitizeSharedText(value: string): string {
  if (typeof value !== 'string') return ''
  return value.slice(0, SHARE_LIMITS.historyChars)
    // Do not expose link destinations, image references, or local artifact URLs.
    .replace(/!?\[([^\]\r\n]*)\]\([^\r\n)]*\)/g, '$1')
    .replace(/!?\[([^\]\r\n]*)\]\[[^\]\r\n]*\]/g, '$1')
    .replace(/^\s*\[[^\]\r\n]+\]:\s*\S+.*$/gm, '[link omitted]')
    .replace(/<\/?(?:a|img|iframe|object|embed|source)\b[^>]*>/gi, '')
    .replace(/\bfile:\/\/[^\r\n<>"'`)\]]+/gi, LOCAL_PATH)
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|\\\\|\/|~[\\/])[^\r\n]*?\1/g, LOCAL_PATH)
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`|?*),;\]}]+/g, LOCAL_PATH)
    .replace(/\\\\[^\s<>"'`|?*),;\]}]+[\\/][^\s<>"'`|?*),;\]}]+/g, LOCAL_PATH)
    .replace(/~[\\/][^\s<>"'`),;\]}]+/g, LOCAL_PATH)
    // A boundary excludes the slashes in ordinary https:// links and slash commands.
    .replace(/(?<![A-Za-z0-9_:\/])\/(?:[^\s<>"'`(),;\]{}\/]+\/)+[^\s<>"'`(),;\]{}]*/g, LOCAL_PATH)
    .replace(/(?<![A-Za-z0-9_:\/])\/(?:home|Users|root|tmp|private|var|etc|mnt|Volumes)(?=\b|\/)[^\s<>"'`(),;\]{}]*/g, LOCAL_PATH)
    .replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*[^\r\n]+/gi, '$1: ' + REDACTED)
    .replace(/\b(x[-_]api[-_]key|api[-_]?key|access[-_]?token|refresh[-_]?token|registration[-_]?token|owner[-_]?token|client[-_]?secret|secret[-_]?key|password|token|invite)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}\]]+)/gi, '$1=' + REDACTED)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ' + REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function projectSharedWorkspace(state: Record<string, unknown>, redact: (value: string) => string = value => value): SharedWorkspace {
  const safeText = (value: unknown, limit: number) => text(typeof value === 'string' ? redact(value) : value, limit)
  const source = record(state)
  const cwd = typeof source.cwd === 'string' ? source.cwd.replace(/\\/g, '/').replace(/\/+$/, '') : ''
  const basename = cwd && !/^[A-Za-z]:$/.test(cwd) ? cwd.slice(cwd.lastIndexOf('/') + 1) : ''
  const sessions: SharedWorkspace['sessions'] = []
  const agents: SharedWorkspace['agents'] = []
  const todos: SharedWorkspace['todos'] = []
  for (const value of Array.isArray(source.sessions) ? source.sessions : []) {
    const session = record(value)
    if (!isSessionId(session.id)) continue
    sessions.push({ id: session.id, title: safeText(session.title, 200) || session.id,
      updatedAt: timestamp(session.updatedAt), status: code(session.status, STATUSES, 'empty') })
    if (sessions.length === 80) break
  }
  for (const value of Array.isArray(source.agents) ? source.agents : []) {
    const agent = record(value), id = identifier(agent.id)
    if (!id) continue
    agents.push({ id, name: safeText(agent.name, SHARE_LIMITS.nameChars) || id,
      status: code(agent.status, STATUSES, 'idle'), role: code(agent.role, ROLES, 'sub') })
    if (agents.length === 32) break
  }
  for (const value of Array.isArray(source.todos) ? source.todos : []) {
    const todo = record(value), content = safeText(todo.content, 1000)
    if (!content) continue
    todos.push({ content, status: code(todo.status, TODO_STATUSES, 'pending') })
    if (todos.length === 80) break
  }
  return {
    workspaceId: identifier(source.workspaceId), name: safeText(basename || source.name, SHARE_LIMITS.nameChars) || '当前工作区',
    revision: typeof source.revision === 'number' && Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0,
    sessionId: isSessionId(source.sessionId) ? source.sessionId : null,
    busy: source.busy === true, expertMode: source.expertMode === true, sessions, agents, todos,
  }
}

/** Latest visible messages only. Tool arguments/output, prompts, reasoning, attachments and metadata are never exported. */
export function projectSharedHistory(sessionId: string, events: readonly SessionEventRecord[], redact: (value: string) => string = value => value): SharedHistory {
  const safeText = (value: unknown, limit: number) => text(typeof value === 'string' ? redact(value) : value, limit)
  const result: SharedHistory = { sessionId: isSessionId(sessionId) ? sessionId : '', entries: [], truncated: false }
  if (!result.sessionId || !Array.isArray(events)) return result
  let chars = 0, bytes = 0
  const add = (event: Record<string, unknown>, kind: SharedHistory['entries'][number]['kind'], raw: unknown, label?: string): boolean => {
    if (typeof raw !== 'string' || !raw) return true
    if (result.entries.length >= SHARE_LIMITS.historyEntries || chars >= SHARE_LIMITS.historyChars || bytes >= SHARE_LIMITS.historyChars) {
      result.truncated = true
      return false
    }
    const limit = Math.min(SHARE_LIMITS.taskChars, SHARE_LIMITS.historyChars - chars)
    let content = safeText(raw, limit)
    const remaining = SHARE_LIMITS.historyChars - bytes
    if (Buffer.byteLength(content) > remaining) {
      // At most 8K characters per entry; trim at code point boundaries, not UTF-8 byte boundaries.
      let used = 0, prefix = ''
      for (const character of content) {
        const size = Buffer.byteLength(character)
        if (used + size > remaining) break
        prefix += character
        used += size
      }
      content = prefix
      result.truncated = true
    }
    if (raw.length > limit) result.truncated = true
    if (!content) return true
    chars += content.length
    bytes += Buffer.byteLength(content)
    const entry: SharedHistory['entries'][number] = {
      seq: typeof event.seq === 'number' && Number.isSafeInteger(event.seq) && event.seq >= 0 ? event.seq : 0,
      time: timestamp(event.time), kind, text: content,
    }
    if (label) entry.label = safeText(label, SHARE_LIMITS.nameChars)
    result.entries.push(entry)
    return true
  }
  let full = false
  for (let i = events.length - 1; i >= 0 && !full; i--) {
    const event = record(events[i]), payload = record(event.payload)
    switch (event.type) {
      case 'user/message':
        if (payload.from || payload.source && payload.source !== 'user' && payload.source !== 'expert-summary') break
        full = !add(event, payload.source === 'expert-summary' ? 'expert' : 'user', payload.originalText ?? payload.content)
        break
      case 'assistant/message':
        full = !add(event, 'assistant', payload.content)
        break
      case 'tool/call':
        full = !add(event, 'tool', '工具开始。', toolName(payload.name))
        break
      case 'tool/result':
        full = !add(event, 'tool', payload.isError === true ? '工具执行失败。' : '工具已完成。', toolName(payload.name))
        break
      case 'session/note':
        if (typeof payload.note === 'string' && Object.hasOwn(NOTES, payload.note)) full = !add(event, 'note', NOTES[payload.note])
        break
      case 'collaboration/message': {
        const messages = Array.isArray(payload.messages) ? payload.messages : []
        const label = safeText(payload.agentName, SHARE_LIMITS.nameChars) || 'expert'
        for (let j = messages.length - 1; j >= 0 && !full; j--) {
          const message = record(messages[j])
          if (message.role === 'assistant') full = !add(event, 'expert', message.content, label)
          else if (message.role === 'tool') full = !add(event, 'tool', '专家工具已完成。', 'tool')
        }
        break
      }
    }
  }
  result.entries.reverse()
  return result
}
