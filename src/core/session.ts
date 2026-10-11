/**
 * Session log — the append-only source of the context the model sees.
 * "Model-visible means logged": every request is reconstructable from the log
 * via deriveMessages(). Stored as session.jsonl (v0 format), one JSON event
 * per line, never rewritten. Explicit deletion removes the whole session.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type {
  AssistantMessage,
  ChatMessage,
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

async function assertSessionFiles(dir: string): Promise<void> {
  const [directory, log] = await Promise.all([fs.lstat(dir), fs.lstat(path.join(dir, 'session.jsonl'))])
  if (!directory.isDirectory() || directory.isSymbolicLink() || !log.isFile() || log.isSymbolicLink()) {
    throw new SessionError('EINVAL', 'session must be a directory with a regular log, not a symbolic link')
  }
}

export class Session {
  private seq = 0
  readonly events: SessionEventRecord[] = []
  private listeners = new Set<(event: SessionEventRecord) => void>()
  /** Serializes mkdir+appendFile so concurrent appends hit disk in seq order. */
  private writeChain: Promise<void> = Promise.resolve()
  private deleted = false

  constructor(
    readonly id: string,
    readonly dir: string,
  ) {}

  get file(): string {
    return path.join(this.dir, 'session.jsonl')
  }

  append(event: SessionEventPayload): Promise<SessionEventRecord> {
    if (this.deleted) return Promise.reject(new SessionError('ENOENT', `session "${this.id}" was deleted`))
    const record: SessionEventRecord = { seq: ++this.seq, time: new Date().toISOString(), ...event }
    // Persistence is serialized (seq order on disk even with concurrent
    // appends) and still awaited by the caller — awaiting append() means the
    // record is on disk.
    const write = this.writeChain
      .then(() => this.persist(record))
      .then(() => record)
    this.writeChain = write.then(
      () => {},
      () => {},
    )
    // Publish only after enqueueing persistence: a listener may request deletion.
    this.events.push(record)
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        /* UI listeners must never break the log */
      }
    }
    return write
  }

  private async persist(record: SessionEventRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    await fs.appendFile(this.file, JSON.stringify(record) + '\n', 'utf8')
  }

  /** Seal old handles before draining writes so a late append cannot recreate the log.
   * The caller's synchronous guard is rechecked after all preparatory disk I/O. */
  async delete(assertIdle: () => void = () => {}): Promise<void> {
    if (this.deleted) throw new SessionError('ENOENT', `session "${this.id}" was deleted`)
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
  deriveMessages(): ChatMessage[] {
    // Context compaction: the last session/note marked `note: 'compaction'`
    // truncates the projection — records before it contribute only their
    // system/message (the prompt), and the summary enters as a user message.
    let markerSeq = -1
    let markerSummary = ''
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      if (e.type === 'session/note' && (e.payload as { note?: string }).note === 'compaction') {
        markerSeq = e.seq
        markerSummary = String((e.payload as { summary?: unknown }).summary ?? '')
        break
      }
    }
    // Only the most recent tool/result carrying images is replayed to the
    // model — older screenshots degrade to a text note so context stays bounded.
    let lastImageSeq = -1
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!
      if (e.type === 'tool/result' && e.payload.images?.length) {
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
    for (const event of this.events) {
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
        messages.push({
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
      }
      // 'assistant/attempt', 'agent/meta', 'tool/call', 'session/note' are
      // observability-only; the assistant message itself carries the calls.
    }
    return messages
  }

  /** Compact human-readable transcript for /review-style introspection. */
  transcript(): string[] {
    return this.events.map((e) => `[${e.seq}] ${e.type}`)
  }
}

export interface SessionMeta {
  id: string
  dir: string
  startedAt: string
  events: number
  /** First user message (≤60 chars), when the session has one. */
  title?: string | null
}

export class SessionService {
  private sessions = new Map<string, Session>()
  private opening = new Map<string, Promise<Session>>()
  private deleting = new Set<string>()

  constructor(private rootDir: string) {}

  set root(dir: string) {
    this.rootDir = dir
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
    await session.append({ type: 'agent/meta', payload: { created: true, ...meta } })
    if (meta?.title) await session.append({ type: 'session/note', payload: { note: 'title', title: normalizeTitle(String(meta.title)) } })
    return session
  }

  /** Rename a session: appends a title note that list() picks up as the newest title. */
  async rename(id: string, title: string): Promise<void> {
    const session = await this.open(id)
    await session.append({ type: 'session/note', payload: { note: 'title', title: normalizeTitle(title) } })
  }

  async open(id: string): Promise<Session> {
    const { dir, key } = this.location(id)
    if (this.deleting.has(key)) throw new SessionError('EBUSY', 'session deletion is in progress; retry')
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
    if (this.deleting.has(key)) throw new SessionError('EBUSY', 'session deletion is in progress; retry')
    this.deleting.add(key)
    try {
      await this.opening.get(key)
      const session = this.sessions.get(key) ?? await this.load(id, dir)
      await session.delete(assertIdle)
      this.sessions.delete(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.sessions.delete(key)
      throw error
    } finally {
      this.deleting.delete(key)
    }
  }

  async list(): Promise<SessionMeta[]> {
    const root = path.resolve(this.rootDir)
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      const metas: SessionMeta[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || !isSessionId(entry.name)) continue
        const dir = path.join(root, entry.name)
        const file = path.join(dir, 'session.jsonl')
        try {
          await assertSessionFiles(dir)
          const raw = await fs.readFile(file, 'utf8')
          const lines = raw.split('\n').filter((l) => l.trim())
          const first = lines[0] ? (JSON.parse(lines[0]) as SessionEventRecord) : undefined
          metas.push({
            id: entry.name,
            dir,
            startedAt: first?.time ?? 'unknown',
            events: lines.length,
            title: sessionTitle(lines),
          })
        } catch {
          /* skip unreadable session dirs */
        }
      }
      return metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    } catch {
      return []
    }
  }
}

/**
 * Session title: the newest explicit rename/create title wins, otherwise the
 * first user message (≤60 chars). null when neither exists.
 */
function sessionTitle(lines: string[]): string | null {
  let explicit: string | null = null
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as SessionEventRecord
      if (record.type === 'session/note' && record.payload?.note === 'title') {
        const title = String(record.payload.title ?? '').replace(/\s+/g, ' ').trim()
        if (title) explicit = title.length > 60 ? `${title.slice(0, 60)}…` : title
      }
    } catch {
      continue
    }
  }
  if (explicit) return explicit
  for (const line of lines.slice(0, 50)) {
    try {
      const record = JSON.parse(line) as SessionEventRecord
      if (record.type === 'user/message') {
        const content = String(record.payload.content).replace(/\s+/g, ' ').trim()
        return content.length > 60 ? `${content.slice(0, 60)}…` : content || null
      }
    } catch {
      continue
    }
  }
  return null
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
