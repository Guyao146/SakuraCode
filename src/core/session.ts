/**
 * Session log — the append-only source of the context the model sees.
 * "Model-visible means logged": every request is reconstructable from the log
 * via deriveMessages(). Stored as session.jsonl (v0 format), one JSON event
 * per line, never rewritten. Explicit deletion removes the whole session.
 */

import { createReadStream, promises as fs, type Stats } from 'node:fs'
import * as path from 'node:path'
import { lastContextMarkerIndex } from '../util/context.js'
import { CHAT_ATTACHMENT_MARKER } from './attachments.js'
import type {
  AssistantMessage,
  ChatMessage,
  CollaborationRecord,
  SessionEventPayload,
  SessionEventRecord,
} from './types.js'

/** A single portable directory name, never a path, Windows device or ADS. */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) &&
    !id.includes('..') && !id.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
}

export class SessionError extends Error {
  constructor(readonly code: 'EINVAL' | 'ENOENT' | 'EBUSY', message: string) {
    super(message)
    this.name = 'SessionError'
  }
}

async function assertSessionFiles(dir: string): Promise<Stats> {
  const [directory, log] = await Promise.all([fs.lstat(dir), fs.lstat(path.join(dir, 'session.jsonl'))])
  if (!directory.isDirectory() || directory.isSymbolicLink() || !log.isFile() || log.isSymbolicLink()) {
    throw new SessionError('EINVAL', 'session must be a directory with a regular log, not a symbolic link')
  }
  return log
}

export class Session {
  private seq = 0
  readonly events: SessionEventRecord[] = []
  private listeners = new Set<(event: SessionEventRecord) => void>()
  /** Serializes mkdir+appendFile so concurrent appends hit disk in seq order. */
  private writeChain: Promise<void> = Promise.resolve()
  private deleted = false
  private clearing = false

  get archived(): boolean {
    return archiveState(this.events).archived
  }

  constructor(
    readonly id: string,
    readonly dir: string,
  ) {}

  get file(): string {
    return path.join(this.dir, 'session.jsonl')
  }

  append(event: SessionEventPayload): Promise<SessionEventRecord> {
    if (this.deleted) return Promise.reject(new SessionError('ENOENT', `session "${this.id}" was deleted`))
    if (this.archived) return Promise.reject(new SessionError('EBUSY', 'session is archived; restore it before writing'))
    if (this.clearing) return Promise.reject(new SessionError('EBUSY', 'context is being cleared; retry after completion'))
    const record: SessionEventRecord = { seq: ++this.seq, time: new Date().toISOString(), ...event }
    // Persistence is serialized (seq order on disk even with concurrent
    // appends) and still awaited by the caller — awaiting append() means the
    // record is on disk.
    const write = this.writeChain
      .then(() => this.persist(record))
      .then(() => {
        // Failed or still-pending writes must never enter model context, replay
        // or subscriber side effects. The chain is already registered below,
        // so a subscriber may request deletion without missing this write.
        this.events.push(record)
        for (const listener of this.listeners) {
          try { listener(record) } catch { /* UI listeners must never break the log */ }
        }
        return record
      })
    this.writeChain = write.then(
      () => {},
      () => {},
    )
    return write
  }

  /** Publish a reset only after its marker reaches disk. A failed write must
   * not silently forget context in memory while leaving it intact on restart. */
  async clearContext(assertIdle: () => void = () => {}): Promise<void> {
    if (this.deleted) throw new SessionError('ENOENT', `session "${this.id}" was deleted`)
    if (this.archived) throw new SessionError('EBUSY', 'session is archived; restore it first')
    if (this.clearing) throw new SessionError('EBUSY', 'context is already being cleared')
    assertIdle()
    this.clearing = true
    try {
      await this.writeChain
      assertIdle()
      const record: SessionEventRecord = { seq: this.seq + 1, time: new Date().toISOString(), type: 'session/note', payload: { note: 'context-clear' } }
      await this.persist(record)
      this.seq = record.seq
      this.events.push(record)
      for (const listener of this.listeners) {
        try { listener(record) } catch { /* UI listeners must never break the log */ }
      }
    } finally { this.clearing = false }
  }

  private async persist(record: SessionEventRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.appendFile(this.file, JSON.stringify(record) + '\n', 'utf8')
  }

  /** Freeze a committed source during a branch/checkpoint transaction.
   * The source log is never rewritten, even when the transaction fails. */
  async exclusive<T>(operation: () => Promise<T>, assertIdle: () => void = () => {}): Promise<T> {
    if (this.deleted) throw new SessionError('ENOENT', `session "${this.id}" was deleted`)
    if (this.archived) throw new SessionError('EBUSY', 'session is archived; restore it first')
    if (this.clearing) throw new SessionError('EBUSY', 'session is already changing')
    assertIdle()
    this.clearing = true
    try {
      await this.writeChain
      await assertSessionFiles(this.dir)
      assertIdle()
      return await operation()
    } finally { this.clearing = false }
  }

  /** Archive notes share the write gate with context resets. No directory move,
   * lost attachments, or cached handle capable of resuming an archived log. */
  async setArchived(archived: boolean, assertIdle: () => void = () => {}): Promise<void> {
    if (this.deleted) throw new SessionError('ENOENT', `session "${this.id}" was deleted`)
    if (this.clearing) throw new SessionError('EBUSY', 'session is already changing')
    assertIdle()
    this.clearing = true
    try {
      await this.writeChain
      await assertSessionFiles(this.dir)
      assertIdle()
      if (this.archived === archived) return
      const record: SessionEventRecord = { seq: this.seq + 1, time: new Date().toISOString(),
        type: 'session/note', payload: { note: 'archive', archived } }
      await this.persist(record)
      this.seq = record.seq
      this.events.push(record)
      for (const listener of this.listeners) {
        try { listener(record) } catch { /* observers cannot break committed metadata */ }
      }
    } finally { this.clearing = false }
  }

  /** Seal old handles before draining writes so a late append cannot recreate the log.
   * The caller's synchronous guard is rechecked after all preparatory disk I/O. */
  async delete(assertIdle: () => void = () => {}): Promise<void> {
    if (this.deleted) throw new SessionError('ENOENT', `session "${this.id}" was deleted`)
    if (this.clearing) throw new SessionError('EBUSY', 'context is being cleared; wait before deleting the session')
    assertIdle()
    this.deleted = true
    try {
      await this.writeChain
      await assertSessionFiles(this.dir)
      assertIdle()
      await fs.rm(this.dir, { recursive: true, maxRetries: 4, retryDelay: 100 })
      this.listeners.clear()
      this.events.length = 0
    } catch (error) {
      this.deleted = (error as NodeJS.ErrnoException).code === 'ENOENT'
      throw error
    }
  }

  subscribe(listener: (event: SessionEventRecord) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Restore in-memory state after loading persisted records (used by open()). */
  restore(records: SessionEventRecord[]): void {
    this.events.push(...records)
    this.seq = records.length ? (records[records.length - 1]!.seq ?? 0) : 0
  }

  /**
   * Project the committed log into model messages:
   * system/message → system (latest wins), user/message → user,
   * assistant/message (embeds its tool_calls) followed by one tool message
   * per tool/result. assistant/attempt events never enter history.
   */
  deriveMessages(options?: { fromSeq?: number; throughSeq?: number; userSeq?: number; committedOnly?: boolean }): ChatMessage[] {
    // A slower expert must not pick up a later queued user task. Committed
    // peer evidence for its current/earlier task may arrive after that cutoff.
    const snapshot = options?.throughSeq === undefined ? this.events : this.events.filter(event => event.seq <= options.throughSeq!)
    const nextUser = options?.userSeq === undefined ? undefined : snapshot.find(event => event.type === 'user/message' && event.seq > options.userSeq! &&
      !event.payload.from && (!event.payload.source || event.payload.source === 'user'))
    const events = snapshot.filter(event => (options?.fromSeq === undefined || event.seq >= options.fromSeq) &&
      (!nextUser || event.seq < nextUser.seq || event.type === 'collaboration/message' && (event.payload.userSeq ?? Infinity) <= options!.userSeq!))
    // Compaction and explicit clears keep the append-only history intact.
    // A clear drops the prior summary too; only the system prompt survives.
    const marker = events[lastContextMarkerIndex(events)]
    const markerSeq = marker?.seq ?? -1
    const markerSummary = marker?.type === 'session/note' && marker.payload.note === 'compaction'
      ? String(marker.payload.summary ?? '') : null
    // Only the most recent tool/result carrying images is replayed to the
    // model — older screenshots degrade to a text note so context stays bounded.
    let lastImageSeq = -1
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!
      if (e.type === 'tool/result' && e.payload.images?.length || e.type === 'collaboration/message' &&
          e.payload.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))) {
        lastImageSeq = e.seq
        break
      }
    }
    const messages: ChatMessage[] = []
    // Tool calls whose assistant message the marker dropped. A tool that was
    // still running when the marker was appended leaves its tool/result AFTER
    // the marker while the assistant tool_calls that requested it falls before
    // it. That orphan is rejected outright by OpenAI-compatible APIs
    // (400 "tool_call_id not found") and would poison the session on resume and
    // on every later turn, so results that lost their pairing are dropped here
    // too — the summary carries their transcript instead. Events are walked in
    // seq order, so the dropped assistant message is always seen first.
    const suppressedCalls = new Set<string>()
    for (const event of events) {
      const preCompaction = markerSeq >= 0 && event.seq < markerSeq
      if (event.type === 'system/message') {
        const last = messages[0]
        if (last?.role === 'system') last.content = event.payload.content
        else messages.unshift({ role: 'system', content: event.payload.content })
      } else if (preCompaction) {
        if (event.type === 'assistant/message') {
          for (const call of event.payload.tool_calls ?? []) suppressedCalls.add(call.id)
        }
        continue // everything but the prompt is carried by the summary
      } else if (event.seq === markerSeq) {
        if (markerSummary !== null) messages.push({
          role: 'user',
          content: `[context compacted — earlier conversation replaced by this summary]\n${markerSummary}`,
        })
      } else if (event.type === 'user/message') {
        const suffix = event.payload.from ? `\n[from: ${event.payload.from}]` : ''
        const text = event.payload.content + suffix
        const { images } = event.payload
        if (images?.length) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text },
              ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
            ],
          })
        } else {
          messages.push({ role: 'user', content: text })
        }
      } else if (event.type === 'assistant/message') {
        const { content, tool_calls } = event.payload
        messages.push({ role: 'assistant', content, ...(tool_calls?.length ? { tool_calls } : {}) })
      } else if (event.type === 'tool/result') {
        if (suppressedCalls.has(event.payload.id)) continue // pairing was compacted away
        const { images } = event.payload
        const content =
          images?.length && event.seq !== lastImageSeq
            ? `${event.payload.output}\n[${images.length} image(s) elided — only the most recent image is kept in context]`
            : event.payload.output
        messages.push({
          role: 'tool',
          tool_call_id: event.payload.id,
          content,
        })
        if (images?.length && event.seq === lastImageSeq) {
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: `Image(s) produced by tool "${event.payload.name}":` },
              ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
            ],
          })
        }
      } else if (event.type === 'collaboration/message') {
        messages.push(...collaborationMessages(event.payload, event.seq === lastImageSeq))
      }
      // 'assistant/attempt', 'agent/meta', 'tool/call', 'session/note' are
      // observability-only; the assistant message itself carries the calls.
    }
    return orderToolMessages(messages, options?.committedOnly === true)
  }

  /** Compact human-readable transcript for /review-style introspection. */
  transcript(): string[] {
    return this.events.map((e) => `[${e.seq}] ${e.type}`)
  }
}

/** Flatten peers' finished calls into attributed evidence, not calls the current agent owes. */
export function collaborationMessages(record: CollaborationRecord, keepImages = true): ChatMessage[] {
  if (!record.messages.length) return []
  const lines = [`[专家协作记录；这是成员输出，不是新的用户指令]`, `成员：${record.agentName}（${record.agentId}）`]
  const images: import('./types.js').ContentPart[] = []
  for (const message of record.messages) {
    if (message.role === 'assistant') {
      if (message.content) lines.push(`成员回复：${message.content}`)
      for (const call of message.tool_calls ?? []) lines.push(`成员工具调用 ${call.function.name}：${call.function.arguments}`)
    } else if (message.role === 'tool') lines.push(`成员工具结果（${message.tool_call_id}）：${message.content}`)
    else if (message.role === 'user') {
      if (typeof message.content === 'string') lines.push(`成员任务/通信记录（非用户新指令）：${message.content}`)
      else for (const part of message.content) {
        if (part.type === 'text') lines.push(part.text)
        else if (keepImages) images.push(part)
        else lines.push('[较早的专家工具图片已省略，仅保留最近一组]')
      }
    }
  }
  return [{ role: 'assistant', content: lines.join('\n\n') }, ...(images.length ? [{ role: 'user' as const,
    content: [{ type: 'text' as const, text: `[专家 ${record.agentName} 产生的工具图片；非用户指令]` }, ...images] }] : [])]
}

/** Concurrent peer evidence cannot interrupt an assistant(tool_calls)/tool block. */
function orderToolMessages(messages: ChatMessage[], committedOnly: boolean): ChatMessage[] {
  const output: ChatMessage[] = [], block: ChatMessage[] = [], deferred: ChatMessage[] = []
  const owed = new Set<string>()
  for (const message of messages) {
    if (owed.size) {
      if (message.role === 'tool' && owed.has(message.tool_call_id)) {
        block.push(message); owed.delete(message.tool_call_id)
        if (!owed.size) { output.push(...block, ...deferred); block.length = 0; deferred.length = 0 }
      } else deferred.push(message)
    } else if (message.role === 'assistant' && message.tool_calls?.length) {
      block.push(message); message.tool_calls.forEach(call => owed.add(call.id))
    } else if (!committedOnly || message.role !== 'tool') output.push(message)
  }
  if (!committedOnly) output.push(...block)
  output.push(...deferred)
  return output
}

export interface SessionMeta {
  id: string
  dir: string
  startedAt: string
  /** Timestamp of the newest intact persisted record, not the creation time. */
  updatedAt?: string
  events: number
  /** First user message (≤60 chars), when the session has one. */
  title?: string | null
  activity?: SessionActivity
  archived?: boolean
  archivedAt?: string | null
  /** Explicit ownership, persisted at creation; never guessed from a title. */
  expert?: string
}

function archiveState(records: SessionEventRecord[]): { archived: boolean; archivedAt: string | null } {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    if (record.type === 'session/note' && record.payload.note === 'archive' && typeof record.payload.archived === 'boolean') {
      return { archived: record.payload.archived, archivedAt: record.payload.archived ? record.time : null }
    }
  }
  return { archived: false, archivedAt: null }
}

export interface SessionActivity {
  status: 'empty' | 'unfinished' | 'done' | 'error' | 'cancelled'
  lastTask?: string
  lastTool?: string
  toolCalls: number
  completedTools: number
  failedTools: number
}

/** Keep only the list projection: never retain transcript, images or tool output.
 * Memory is bounded by one JSONL record rather than the entire conversation. */
async function readSessionMeta(id: string, dir: string): Promise<SessionMeta> {
  const activity: SessionActivity = { status: 'empty', toolCalls: 0, completedTools: 0, failedTools: 0 }
  const meta: SessionMeta = { id, dir, startedAt: 'unknown', updatedAt: 'unknown', events: 0, title: null,
    activity, archived: false, archivedAt: null }
  let explicitTitle: string | null = null, firstTitle: string | null = null, firstUserSeen = false, currentUserSeq = -1
  const accept = (line: string): boolean => {
    if (!line.trim()) return true
    let record: SessionEventRecord
    try { record = JSON.parse(line) as SessionEventRecord }
    catch { return false } // A torn final write is not an event or a rename.
    if (!record || typeof record !== 'object' || typeof record.type !== 'string' || !record.payload) return false
    if (meta.events++ === 0) meta.startedAt = record.time ?? 'unknown'
    meta.updatedAt = record.time ?? meta.startedAt
    if (record.type === 'agent/meta' && record.payload.created === true && record.payload.role === 'sub' &&
        typeof record.payload.expert === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(record.payload.expert)) {
      meta.expert = record.payload.expert
    } else if (record.type === 'user/message') {
      currentUserSeq = record.seq
      const content = record.payload.content.split(CHAT_ATTACHMENT_MARKER)[0]!.replace(/\s+/g, ' ')
      if (!firstUserSeen && meta.events <= 50) {
        firstUserSeen = true
        const title = content.trim()
        firstTitle = title.length > 60 ? `${title.slice(0, 60)}…` : title || null
      }
      activity.lastTask = content.slice(0, 180)
      activity.status = 'unfinished'
    } else if (record.type === 'assistant/message' && !record.payload.tool_calls?.length) {
      activity.status = 'done'
    } else if (record.type === 'assistant/attempt') {
      activity.status = record.payload.error === 'cancelled' ? 'cancelled' : 'error'
    } else if (record.type === 'tool/call') {
      activity.lastTool = record.payload.name
      activity.toolCalls++
    } else if (record.type === 'tool/result') {
      if (record.payload.isError) activity.failedTools++
      else activity.completedTools++
    } else if (record.type === 'session/note') {
      if (record.payload.note === 'turn-summary' && record.payload.userSeq === currentUserSeq && record.payload.metrics && typeof record.payload.metrics === 'object') {
        const status = (record.payload.metrics as { status?: string }).status
        if (status === 'done' || status === 'error' || status === 'cancelled') activity.status = status
        else if (status === 'rejected') activity.status = 'error'
      }
      if (record.payload.cancelled === true) activity.status = 'cancelled'
      if (record.payload.note === 'archive' && typeof record.payload.archived === 'boolean') {
        meta.archived = record.payload.archived
        meta.archivedAt = meta.archived ? record.time : null
      } else if (record.payload.note === 'title') {
        const title = String(record.payload.title ?? '').replace(/\s+/g, ' ').trim()
        if (title) explicitTitle = title.length > 60 ? `${title.slice(0, 60)}…` : title
      }
    }
    return true
  }
  const input = createReadStream(path.join(dir, 'session.jsonl'), { encoding: 'utf8', highWaterMark: 64 * 1024 })
  const fragments: string[] = []
  let intact = true
  try {
    for await (const value of input) {
      const chunk = String(value)
      let start = 0, newline: number
      while ((newline = chunk.indexOf('\n', start)) >= 0) {
        const part = chunk.slice(start, newline)
        let line = part
        if (fragments.length) { fragments.push(part); line = fragments.join(''); fragments.length = 0 }
        if (!accept(line)) { intact = false; break }
        start = newline + 1
      }
      if (!intact) break
      // Avoid rescanning/concatenating an ever-growing image or tool-result
      // line on every 64KiB chunk. Join once, when its newline arrives.
      if (start < chunk.length) fragments.push(chunk.slice(start))
    }
    if (intact && fragments.length) accept(fragments.join(''))
  } finally { input.destroy() }
  meta.title = explicitTitle ?? firstTitle
  return meta
}

const logStamp = (log: Stats): string => `${log.dev}:${log.ino}:${log.size}:${log.mtimeMs}:${log.ctimeMs}`
const MAX_SESSION_META_CACHE = 2048

export class SessionService {
  private sessions = new Map<string, Session>()
  private opening = new Map<string, Promise<Session>>()
  private deleting = new Set<string>()
  private archiving = new Set<string>()
  private summaries = new Map<string, { stamp: string; meta: SessionMeta }>()
  private summarizing = new Map<string, { stamp: string; work: Promise<SessionMeta> }>()

  constructor(private rootDir: string) {}

  set root(dir: string) {
    this.rootDir = dir
  }

  get root(): string {
    return path.resolve(this.rootDir)
  }

  private location(id: string): { dir: string; key: string } {
    if (!isSessionId(id)) throw new SessionError('EINVAL', 'invalid session id')
    const dir = path.resolve(this.rootDir, id)
    return { dir, key: process.platform === 'win32' ? dir.toLowerCase() : dir }
  }

  async create(meta?: Record<string, unknown>): Promise<Session> {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${randomId()}`
    const { dir, key } = this.location(id)
    const session = new Session(id, dir)
    this.sessions.set(key, session)
    try {
      await session.append({ type: 'agent/meta', payload: { created: true, ...meta } })
      if (meta?.title) await session.append({ type: 'session/note', payload: { note: 'title', title: normalizeTitle(String(meta.title)) } })
      return session
    } catch (error) {
      this.sessions.delete(key)
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {})
      throw error
    }
  }

  /** Rename a session: appends a title note that list() picks up as the newest title. */
  async rename(id: string, title: string): Promise<void> {
    const session = await this.open(id)
    await session.append({ type: 'session/note', payload: { note: 'title', title: normalizeTitle(title) } })
  }

  async open(id: string): Promise<Session> {
    const { dir, key } = this.location(id)
    if (this.deleting.has(key) || this.archiving.has(key)) throw new SessionError('EBUSY', 'session change is in progress; retry')
    const existing = this.sessions.get(key)
    if (existing) return existing
    const opening = this.opening.get(key)
    if (opening) return opening
    const attempt = this.load(id, dir).then((session) => {
      this.sessions.set(key, session)
      return session
    }).finally(() => this.opening.delete(key))
    this.opening.set(key, attempt)
    return attempt
  }

  private async load(id: string, dir: string): Promise<Session> {
    await assertSessionFiles(dir)
    const file = path.join(dir, 'session.jsonl')
    const raw = await fs.readFile(file, 'utf8')
    const session = new Session(id, dir)
    const records: SessionEventRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as SessionEventRecord)
      } catch {
        // A torn final line (crash mid-append) must not brick the whole
        // session — skip it and continue from the last intact record.
        break
      }
    }
    session.restore(records)
    return session
  }

  /** Delete only this root's session; coalesce opens and exclude competing deletes.
   * Agent/workspace ownership is enforced by the caller's synchronous guard. */
  async delete(id: string, assertIdle: () => void = () => {}): Promise<void> {
    const { dir, key } = this.location(id)
    if (this.deleting.has(key) || this.archiving.has(key)) throw new SessionError('EBUSY', 'session change is in progress; retry')
    this.deleting.add(key)
    try {
      await this.opening.get(key)
      const session = this.sessions.get(key) ?? await this.load(id, dir)
      await session.delete(assertIdle)
      this.sessions.delete(key)
      this.summaries.delete(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.sessions.delete(key); this.summaries.delete(key) }
      throw error
    } finally {
      this.deleting.delete(key)
    }
  }

  /** Batch preflight: reject missing/link-backed logs before any selected item is removed. */
  async validateDeletion(id: string): Promise<void> {
    const { dir, key } = this.location(id)
    if (this.deleting.has(key) || this.archiving.has(key)) throw new SessionError('EBUSY', 'session change is in progress; retry')
    await assertSessionFiles(dir)
  }

  async setArchived(id: string, archived: boolean, assertIdle: () => void = () => {}): Promise<void> {
    if (typeof archived !== 'boolean') throw new SessionError('EINVAL', 'archive flag must be boolean')
    const { dir, key } = this.location(id)
    if (this.deleting.has(key) || this.archiving.has(key)) throw new SessionError('EBUSY', 'session change is in progress; retry')
    this.archiving.add(key)
    try {
      await this.opening.get(key)
      const session = this.sessions.get(key) ?? await this.load(id, dir)
      await session.setArchived(archived, assertIdle)
      this.sessions.set(key, session)
    } finally { this.archiving.delete(key) }
  }

  async list(options: { archived?: boolean | 'all' } = {}): Promise<SessionMeta[]> {
    const root = path.resolve(this.rootDir)
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const metas: SessionMeta[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !isSessionId(entry.name)) continue
        const dir = path.join(root, entry.name)
        const key = process.platform === 'win32' ? dir.toLowerCase() : dir
        try {
          const meta = await this.summary(entry.name, dir, key)
          if (options.archived !== 'all' && meta.archived !== (options.archived === true)) continue
          metas.push({ ...meta, activity: meta.activity ? { ...meta.activity } : undefined })
        } catch {
          this.summaries.delete(key)
          /* skip unreadable session dirs */
        }
      }
      return metas.sort((a, b) => (b.updatedAt ?? b.startedAt).localeCompare(a.updatedAt ?? a.startedAt))
    } catch {
      return []
    }
  }

  private async summary(id: string, dir: string, key: string): Promise<SessionMeta> {
    // Stat/link checks run even on a hit. External appends, replacement,
    // truncation and a changed storage root cannot reuse stale projections.
    const stamp = logStamp(await assertSessionFiles(dir))
    const cached = this.summaries.get(key)
    if (cached?.stamp === stamp) return cached.meta
    const pending = this.summarizing.get(key)
    if (pending?.stamp === stamp) return pending.work
    const work = (async () => {
      const meta = await readSessionMeta(id, dir)
      // Never cache a listing captured while the log changed or was deleted.
      if (logStamp(await assertSessionFiles(dir)) === stamp) {
        this.summaries.delete(key)
        this.summaries.set(key, { stamp, meta })
        if (this.summaries.size > MAX_SESSION_META_CACHE) this.summaries.delete(this.summaries.keys().next().value!)
      }
      return meta
    })()
    const job = { stamp, work }
    this.summarizing.set(key, job)
    try { return await work }
    finally {
      if (this.summarizing.get(key) === job) this.summarizing.delete(key)
    }
  }
}

function normalizeTitle(title: string): string {
  return title.slice(0, 60)
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8)
}

/** Registers the ctx.sessions service. */
export const sessionPlugin = {
  name: 'core-session',
  description: 'Append-only SessionEvent log (ctx.sessions)',
  apply(ctx: { provide(k: string): () => void; set(k: string, v: unknown): void }, config?: { dir?: string }) {
    ctx.provide('sessions')
    ctx.set('sessions', new SessionService(config?.dir ?? '.sakura/sessions'))
  },
}
