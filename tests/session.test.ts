import { promises as fs } from 'node:fs'
import nodeFs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { Session, SessionService, sessionPlugin } from '../src/core/session.js'
import type { SessionEventRecord, StreamSummary, ToolCallId } from '../src/core/types.js'

let tmpRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

const stream = (toolCalls: ToolCallId[] = []): StreamSummary => ({ text: '', toolCalls, durationMs: 1 })

const readLines = async (file: string): Promise<string[]> => {
  const raw = await fs.readFile(file, 'utf8')
  return raw.split('\n').filter((line) => line.trim())
}

// ---------------------------------------------------------------------------
// Session.append — the append-only JSONL log
// ---------------------------------------------------------------------------

describe('Session activity metadata', () => {
  it('projects explicit expert ownership across cold listings without guessing from names or changing logs', async () => {
    const service = new SessionService(tmpRoot)
    const expert = await service.create({ agent: '架构师', role: 'sub', expert: 'architect' })
    const ordinary = await service.create({ agent: '架构师', title: '架构师', role: 'sub' })
    await expert.append({ type: 'user/message', payload: { content: 'shared task' } })
    const original = await fs.readFile(expert.file, 'utf8')
    const rows = await new SessionService(tmpRoot).list()
    expect(rows.find(row => row.id === expert.id)?.expert).toBe('architect')
    expect(rows.find(row => row.id === ordinary.id)?.expert).toBeUndefined()
    expect(await fs.readFile(expert.file, 'utf8')).toBe(original)
    expect(rows).toHaveLength(2)
  })

  it('streams cold listings, reuses compact summaries and rereads only changed logs', async () => {
    const svc = new SessionService(tmpRoot)
    const first = await svc.create(), second = await svc.create()
    await first.append({ type: 'user/message', payload: { content: 'first history' } })
    await second.append({ type: 'user/message', payload: { content: 'second history' } })
    await first.append({ type: 'tool/result', payload: { id: 'large', name: 'read', output: 'PRIVATE_OUTPUT'.repeat(100_000), durationMs: 1 } })
    const stream = vi.spyOn(nodeFs, 'createReadStream')
    syncBuiltinESMExports()
    const fullRead = vi.spyOn(fs, 'readFile')
    const before = await svc.list()
    expect(stream).toHaveBeenCalledTimes(2)
    expect(fullRead).not.toHaveBeenCalled()
    expect(JSON.stringify(before)).not.toContain('PRIVATE_OUTPUT')
    await Promise.all(Array.from({ length: 6 }, () => svc.list()))
    expect(stream).toHaveBeenCalledTimes(2)
    before[0]!.title = 'caller mutation'
    before[0]!.activity!.lastTask = 'caller mutation'
    expect(JSON.stringify(await svc.list())).not.toContain('caller mutation')
    await svc.rename(first.id, 'updated title')
    expect((await svc.list()).find(row => row.id === first.id)?.title).toBe('updated title')
    expect(stream).toHaveBeenCalledTimes(3)
    await svc.setArchived(first.id, true)
    expect((await svc.list()).map(row => row.id)).toEqual([second.id])
    expect((await svc.list({ archived: true }))[0]?.id).toBe(first.id)
    expect(stream).toHaveBeenCalledTimes(4)
    await svc.delete(first.id)
    expect((await svc.list({ archived: 'all' })).map(row => row.id)).toEqual([second.id])
  })

  it('coalesces concurrent cold scans without retaining complete session records', async () => {
    const session = await new SessionService(tmpRoot).create()
    await session.append({ type: 'user/message', payload: { content: 'only one stream' } })
    const svc = new SessionService(tmpRoot), stream = vi.spyOn(nodeFs, 'createReadStream')
    syncBuiltinESMExports()
    const results = await Promise.all(Array.from({ length: 10 }, () => svc.list()))
    expect(stream).toHaveBeenCalledOnce()
    expect(results.every(rows => rows[0]?.activity?.lastTask === 'only one stream')).toBe(true)
    expect((svc as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0)
  })

  it('invalidates changed, truncated and link-replaced histories even when an earlier projection is cached', async () => {
    const svc = new SessionService(tmpRoot), session = await svc.create()
    await session.append({ type: 'user/message', payload: { content: 'original history' } })
    await svc.list()
    const outside = path.join(tmpRoot, 'external.jsonl')
    const replacement = JSON.stringify({ seq: 1, time: '2026-04-01T00:00:00.000Z', type: 'user/message', payload: { content: 'external replacement' } }) + '\n'
    await fs.writeFile(session.file, replacement)
    expect((await svc.list())[0]).toMatchObject({ events: 1, title: 'external replacement' })
    await fs.truncate(session.file, 0)
    expect((await svc.list())[0]).toMatchObject({ events: 0, title: null, activity: { status: 'empty' } })
    await fs.writeFile(outside, replacement)
    await fs.unlink(session.file)
    await fs.symlink(outside, session.file, 'file')
    expect(await svc.list()).toEqual([])
    expect(await fs.readFile(outside, 'utf8')).toBe(replacement)
  })

  it('does not reuse another root\'s summary for an identical session id', async () => {
    const a = path.join(tmpRoot, 'a'), b = path.join(tmpRoot, 'b')
    await new Session('same-id', path.join(a, 'same-id')).append({ type: 'user/message', payload: { content: 'root a' } })
    await new Session('same-id', path.join(b, 'same-id')).append({ type: 'user/message', payload: { content: 'root b' } })
    const svc = new SessionService(a)
    expect((await svc.list())[0]?.title).toBe('root a')
    svc.root = b
    expect((await svc.list())[0]?.title).toBe('root b')
    svc.root = a
    expect((await svc.list())[0]?.title).toBe('root a')
  })

  it('projects bounded task/tool status without system prompts, arguments, reasoning or tool output', async () => {
    const service = new SessionService(tmpRoot)
    const session = await service.create()
    await session.append({ type: 'system/message', payload: { content: 'PRIVATE_SYSTEM' } })
    await session.append({ type: 'user/message', payload: { content: 'latest task '.repeat(40) } })
    await session.append({ type: 'tool/call', payload: { id: 'a', name: 'read', arguments: 'PRIVATE_ARGUMENTS' } })
    await session.append({ type: 'tool/result', payload: { id: 'a', name: 'read', output: 'PRIVATE_OUTPUT', durationMs: 1 } })
    await session.append({ type: 'tool/call', payload: { id: 'b', name: 'write', arguments: '{}' } })
    await session.append({ type: 'tool/result', payload: { id: 'b', name: 'write', output: 'PRIVATE_ERROR', isError: true, durationMs: 1 } })
    const final = await session.append({ type: 'assistant/attempt', payload: { error: 'cancelled' } })
    const row = (await service.list())[0]!
    expect(row.updatedAt).toBe(final.time)
    expect(row.activity).toMatchObject({ status: 'cancelled', lastTool: 'write', toolCalls: 2, completedTools: 1, failedTools: 1 })
    expect(row.activity?.lastTask).toHaveLength(180)
    expect(JSON.stringify(row)).not.toContain('PRIVATE_')
  })

  it('orders by actual recent activity and ignores an incomplete final log write', async () => {
    const service = new SessionService(tmpRoot)
    const first = await service.create()
    const second = await service.create()
    const raw = [
      { seq: 1, time: '2026-01-01T00:00:00.000Z', type: 'user/message', payload: { content: 'updated first' } },
      { seq: 2, time: '2026-03-01T00:00:00.000Z', type: 'assistant/message', payload: { role: 'assistant', content: 'done', stream: stream() } },
    ]
    await fs.writeFile(first.file, raw.map(row => JSON.stringify(row)).join('\n') + '\n{"torn":')
    await fs.writeFile(second.file, JSON.stringify({ seq: 1, time: '2026-02-01T00:00:00.000Z', type: 'user/message', payload: { content: 'older second' } }) + '\n')
    const rows = await service.list()
    expect(rows.map(row => row.id)).toEqual([first.id, second.id])
    expect(rows[0]).toMatchObject({ events: 2, updatedAt: raw[1]!.time, activity: { status: 'done' } })
    expect(rows[1]?.activity?.status).toBe('unfinished')
  })
})

describe('Session.append', () => {
  it('appends JSON lines with increasing seq and returns the record', async () => {
    // The session dir does not exist yet — append must mkdir -p it.
    const dir = path.join(tmpRoot, 'nested', 'session-dir')
    const s = new Session('s-1', dir)

    const r1 = await s.append({ type: 'user/message', payload: { content: 'hi' } })
    const r2 = await s.append({ type: 'system/message', payload: { content: 'sys' } })

    expect(r1.seq).toBe(1)
    expect(r2.seq).toBe(2)
    expect(r1.type).toBe('user/message')
    expect(typeof r1.time).toBe('string')
    expect(Number.isNaN(new Date(r1.time).getTime())).toBe(false)

    const lines = await readLines(s.file)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ seq: 1, type: 'user/message', payload: { content: 'hi' } })
    expect(JSON.parse(lines[1]!)).toMatchObject({ seq: 2, type: 'system/message', payload: { content: 'sys' } })
  })

  it('keeps in-memory events in step with the file', async () => {
    const s = new Session('s-2', path.join(tmpRoot, 's2'))
    await s.append({ type: 'session/note', payload: { n: 1 } })
    await s.append({ type: 'session/note', payload: { n: 2 } })
    expect(s.events).toHaveLength(2)
    expect(s.events[1]!.seq).toBe(2)
    expect(s.file).toBe(path.join(s.dir, 'session.jsonl'))
  })

  it('publishes only committed records and recovers after a failed concurrent append', async () => {
    const s = new Session('failed-write', path.join(tmpRoot, 'failed-write'))
    const seen: SessionEventRecord[] = []
    s.subscribe(record => seen.push(record))
    const original = fs.appendFile.bind(fs)
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const spy = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async () => {
      entered(); await held; throw new Error('synthetic log disk failure')
    }).mockImplementation(original)
    try {
      const rejected = expect(s.append({ type: 'user/message', payload: { content: 'MUST_NOT_ENTER_CONTEXT' } })).rejects.toThrow('synthetic log disk failure')
      const next = s.append({ type: 'user/message', payload: { content: 'COMMITTED_AFTER_FAILURE' } })
      await started
      expect(s.events).toEqual([])
      expect(seen).toEqual([])
      release(); await rejected
      const committed = await next
      expect(s.events).toEqual([committed])
      expect(seen).toEqual([committed])
      expect(s.deriveMessages()).toEqual([{ role: 'user', content: 'COMMITTED_AFTER_FAILURE' }])
      expect((await readLines(s.file)).map(line => JSON.parse(line))).toEqual([committed])
    } finally { release(); spy.mockRestore() }
  })
})

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

describe('Session.subscribe', () => {
  it('fires listeners before a committed append resolves', async () => {
    const s = new Session('s-3', path.join(tmpRoot, 's3'))
    const seen: SessionEventRecord[] = []
    s.subscribe((event) => seen.push(event))

    const record = await s.append({ type: 'user/message', payload: { content: 'hello' } })
    expect(seen).toEqual([record])
  })

  it('a throwing listener never breaks the log, and unsubscribe stops delivery', async () => {
    const s = new Session('s-4', path.join(tmpRoot, 's4'))
    const seen: SessionEventRecord[] = []
    s.subscribe(() => {
      throw new Error('ui crash')
    })
    const off = s.subscribe((event) => seen.push(event))

    await s.append({ type: 'session/note', payload: { n: 1 } })
    expect(seen).toHaveLength(1)

    off()
    await s.append({ type: 'session/note', payload: { n: 2 } })
    expect(seen).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// SessionService — create / open / list
// ---------------------------------------------------------------------------

describe('SessionService', () => {
  it('create() makes a session dir and logs an agent/meta event with the extra metadata', async () => {
    const svc = new SessionService(tmpRoot)
    const s = await svc.create({ label: 'lab' })

    expect(s.id).toBeTruthy()
    expect(path.dirname(s.dir)).toBe(tmpRoot)

    const lines = await readLines(s.file)
    expect(lines).toHaveLength(1)
    const first = JSON.parse(lines[0]!) as SessionEventRecord
    expect(first.type).toBe('agent/meta')
    expect(first.seq).toBe(1)
    expect(first.payload).toMatchObject({ created: true, label: 'lab' })
  })

  it('open() returns the cached instance for a live session, and restores from disk in a fresh service', async () => {
    const svc = new SessionService(tmpRoot)
    const created = await svc.create()
    await created.append({ type: 'user/message', payload: { content: 'one' } })

    // Same service: the in-memory instance is reused.
    expect(await svc.open(created.id)).toBe(created)

    // A fresh service over the same root: state is restored from session.jsonl.
    const svc2 = new SessionService(tmpRoot)
    const reopened = await svc2.open(created.id)
    expect(reopened).not.toBe(created)
    expect(reopened.events).toHaveLength(2)
    expect(reopened.events[0]!.type).toBe('agent/meta')
    expect(reopened.events[reopened.events.length - 1]!.seq).toBe(2)

    // The restored sequence continues where the file left off.
    const next = await reopened.append({ type: 'user/message', payload: { content: 'two' } })
    expect(next.seq).toBe(3)
    expect(await readLines(reopened.file)).toHaveLength(3)
  })

  it('open() rejects when the session file does not exist', async () => {
    const svc = new SessionService(tmpRoot)
    await expect(svc.open('ghost-session')).rejects.toThrow()
  })

  it('list() returns metadata for each session dir, skipping stray files', async () => {
    const svc = new SessionService(tmpRoot)
    const a = await svc.create()
    const b = await svc.create()
    await b.append({ type: 'session/note', payload: { note: 'x' } })
    await fs.writeFile(path.join(tmpRoot, 'stray.txt'), 'not a session', 'utf8')

    const metas = await svc.list()
    expect(metas).toHaveLength(2)

    const ma = metas.find((m) => m.id === a.id)!
    expect(ma.dir).toBe(a.dir)
    expect(ma.events).toBe(1)
    expect(ma.startedAt).toBe(a.events[0]!.time)

    const mb = metas.find((m) => m.id === b.id)!
    expect(mb.events).toBe(2)
  })

  it('list() on a missing root directory returns [] instead of throwing', async () => {
    const svc = new SessionService(path.join(tmpRoot, 'does-not-exist'))
    expect(await svc.list()).toEqual([])
  })

  it('deletes the complete directory and cache, and seals old handles against resurrection', async () => {
    const svc = new SessionService(tmpRoot)
    const session = await svc.create()
    const kept = await svc.create()
    await fs.mkdir(path.join(session.dir, 'attachments'))
    await fs.writeFile(path.join(session.dir, 'attachments', 'image.txt'), 'saved attachment')
    const writes = Array.from({ length: 20 }, (_, n) => session.append({ type: 'session/note', payload: { n } }))
    await Promise.all([...writes, svc.delete(session.id)])
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(svc.open(session.id)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(session.append({ type: 'user/message', payload: { content: 'too late' } })).rejects.toMatchObject({ code: 'ENOENT' })
    expect(session.events).toEqual([])
    expect((await svc.list()).map(s => s.id)).toEqual([kept.id])
    await expect(svc.delete(session.id)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('loads only one handle during concurrent opens, even when deletion arrives mid-read', async () => {
    const created = await new SessionService(tmpRoot).create()
    const svc = new SessionService(tmpRoot)
    const first = svc.open(created.id)
    const second = svc.open(created.id)
    const deletion = svc.delete(created.id)
    await expect(svc.open(created.id)).rejects.toMatchObject({ code: 'EBUSY' })
    await expect(svc.delete(created.id)).rejects.toMatchObject({ code: 'EBUSY' })
    const handles = await Promise.all([first, second])
    expect(handles[0]).toBe(handles[1])
    await deletion
    await expect(handles[0]!.append({ type: 'session/note', payload: {} })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(svc.open(created.id)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects path traversal, Windows aliases, invalid IDs and non-session directories without removing files', async () => {
    const svc = new SessionService(tmpRoot)
    for (const id of ['', '.', '..', '../outside', 'a/../../b', 'a\\b', 'C:\\temp', 'a:stream', 'a..b', 'a.', 'NUL', 'CON.txt', 'LPT1', 'x'.repeat(129), 'a\0b', '%2e%2e']) {
      await expect(svc.delete(id), id).rejects.toMatchObject({ code: 'EINVAL' })
      await expect(svc.open(id), id).rejects.toMatchObject({ code: 'EINVAL' })
    }
    await fs.mkdir(path.join(tmpRoot, 'not-session'))
    await fs.writeFile(path.join(tmpRoot, 'not-session', 'keep.txt'), 'keep')
    await expect(svc.delete('not-session')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(tmpRoot, 'not-session', 'keep.txt'), 'utf8')).toBe('keep')
    await expect(svc.delete('missing')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not follow session directory symlinks or Windows junctions', async () => {
    const outside = path.join(tmpRoot, 'outside')
    const svc = new SessionService(path.join(tmpRoot, 'sessions'))
    const external = new Session('outside', outside)
    await external.append({ type: 'user/message', payload: { content: 'must survive' } })
    await fs.mkdir(path.join(tmpRoot, 'sessions'))
    await fs.symlink(outside, path.join(tmpRoot, 'sessions', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(svc.delete('linked')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(svc.open('linked')).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await svc.list()).toEqual([])
    expect(await fs.readFile(external.file, 'utf8')).toContain('must survive')
  })

  it('revalidates cached handles and refuses a directory replaced with an external junction', async () => {
    const svc = new SessionService(path.join(tmpRoot, 'sessions'))
    const session = await svc.create()
    const outside = new Session('external', path.join(tmpRoot, 'external'))
    await outside.append({ type: 'user/message', payload: { content: 'EXTERNAL_DIRECTORY_MUST_SURVIVE' } })
    await fs.rm(session.dir, { recursive: true })
    await fs.symlink(outside.dir, session.dir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(svc.delete(session.id)).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await fs.readFile(outside.file, 'utf8')).toContain('EXTERNAL_DIRECTORY_MUST_SURVIVE')
    expect((await fs.lstat(session.dir)).isSymbolicLink()).toBe(true)
    await fs.rm(session.dir, { recursive: true })
    await expect(svc.delete(session.id)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(session.append({ type: 'session/note', payload: { late: true } })).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a session log that is not a regular file, even when the handle is cached', async () => {
    const svc = new SessionService(tmpRoot)
    const session = await svc.create()
    await fs.unlink(session.file)
    await fs.mkdir(session.file)
    await fs.writeFile(path.join(session.file, 'keep.txt'), 'do not delete a non-log directory')
    await expect(svc.delete(session.id)).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await fs.readFile(path.join(session.file, 'keep.txt'), 'utf8')).toBe('do not delete a non-log directory')
    expect(await svc.list()).toEqual([])
  })

  it('keeps identical IDs isolated when the storage root changes, including a pending open', async () => {
    const first = path.join(tmpRoot, 'first')
    const other = path.join(tmpRoot, 'other')
    const a = new Session('same-id', path.join(first, 'same-id'))
    const b = new Session('same-id', path.join(other, 'same-id'))
    await a.append({ type: 'user/message', payload: { content: 'first' } })
    await b.append({ type: 'user/message', payload: { content: 'other' } })
    const svc = new SessionService(first)
    const opened = svc.open(a.id)
    svc.root = other
    await opened
    expect((await svc.open(b.id)).dir).toBe(b.dir)
    await svc.delete(b.id)
    expect(await fs.readFile(a.file, 'utf8')).toContain('first')
    svc.root = first
    expect((await svc.open(a.id)).dir).toBe(a.dir)
    expect((await svc.list()).map(s => s.id)).toEqual([a.id])
  })

  it('rechecks ownership immediately before removal and leaves rejected sessions usable', async () => {
    const svc = new SessionService(tmpRoot)
    const session = await svc.create()
    let checks = 0
    await expect(svc.delete(session.id, () => {
      if (++checks === 2) throw new Error('became busy')
    })).rejects.toThrow('became busy')
    expect(checks).toBe(2)
    expect(await svc.open(session.id)).toBe(session)
    await session.append({ type: 'session/note', payload: { recovered: true } })
    const rm = vi.spyOn(fs, 'rm').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try {
      await expect(svc.delete(session.id)).rejects.toThrow('denied')
    } finally { rm.mockRestore() }
    await session.append({ type: 'session/note', payload: { retry: true } })
    await svc.delete(session.id)
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drains the triggering write when a synchronous log listener requests deletion', async () => {
    const svc = new SessionService(tmpRoot)
    const session = await svc.create()
    let deletion: Promise<void> | undefined
    session.subscribe(() => { deletion = svc.delete(session.id) })
    await session.append({ type: 'user/message', payload: { content: 'last event' } })
    await deletion
    await expect(fs.stat(session.dir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

// ---------------------------------------------------------------------------
// deriveMessages — projecting the log into model messages
// ---------------------------------------------------------------------------

describe('Session.deriveMessages', () => {
  it('returns [] for an empty session', () => {
    const s = new Session('d-0', path.join(tmpRoot, 'd0'))
    expect(s.deriveMessages()).toEqual([])
  })

  it('folds system messages: latest wins into a single system message', async () => {
    const s = new Session('d-1', path.join(tmpRoot, 'd1'))
    await s.append({ type: 'system/message', payload: { content: 'v1' } })
    await s.append({ type: 'system/message', payload: { content: 'v2' } })
    expect(s.deriveMessages()).toEqual([{ role: 'system', content: 'v2' }])
  })

  it('a system message arriving after user messages is unshifted to position 0, then updated in place', async () => {
    const s = new Session('d-2', path.join(tmpRoot, 'd2'))
    await s.append({ type: 'user/message', payload: { content: 'hi' } })
    await s.append({ type: 'system/message', payload: { content: 'sys' } })
    expect(s.deriveMessages()).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])

    await s.append({ type: 'system/message', payload: { content: 'sys2' } })
    expect(s.deriveMessages()).toEqual([
      { role: 'system', content: 'sys2' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('user messages append a [from: ...] suffix only when payload.from is set', async () => {
    const s = new Session('d-3', path.join(tmpRoot, 'd3'))
    await s.append({ type: 'user/message', payload: { content: 'plain' } })
    await s.append({ type: 'user/message', payload: { content: 'hello', from: 'web' } })
    expect(s.deriveMessages()).toEqual([
      { role: 'user', content: 'plain' },
      { role: 'user', content: 'hello\n[from: web]' },
    ])
  })

  it('assistant messages embed their tool_calls, followed by one tool message per tool/result, in order', async () => {
    const s = new Session('d-4', path.join(tmpRoot, 'd4'))
    const call: ToolCallId = { id: 'c1', type: 'function', function: { name: 'fs.read', arguments: '{"path":"a"}' } }
    const call2: ToolCallId = { id: 'c2', type: 'function', function: { name: 'fs.read', arguments: '{"path":"b"}' } }

    await s.append({ type: 'user/message', payload: { content: 'read a and b' } })
    await s.append({
      type: 'assistant/message',
      payload: { role: 'assistant', content: null, tool_calls: [call, call2], stream: stream([call, call2]) },
    })
    await s.append({ type: 'tool/result', payload: { id: 'c1', name: 'fs.read', output: 'body-a', durationMs: 3 } })
    await s.append({ type: 'tool/result', payload: { id: 'c2', name: 'fs.read', output: 'body-b', durationMs: 4 } })

    const messages = s.deriveMessages()
    expect(messages).toHaveLength(4)
    expect(messages[1]).toMatchObject({ role: 'assistant', content: null, tool_calls: [call, call2] })
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'body-a' })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'body-b' })
  })

  it('an assistant message without tool_calls produces no tool field', async () => {
    const s = new Session('d-5', path.join(tmpRoot, 'd5'))
    await s.append({
      type: 'assistant/message',
      payload: { role: 'assistant', content: 'plain answer', stream: stream() },
    })
    const messages = s.deriveMessages()
    expect(messages).toHaveLength(1)
    expect(messages[0]).toEqual({ role: 'assistant', content: 'plain answer' })
    expect(messages[0]).not.toHaveProperty('tool_calls')
  })

  it('drops a tool result whose assistant tool_calls was cut off by a compaction marker', async () => {
    const s = new Session('d-5b', path.join(tmpRoot, 'd5b'))
    const call: ToolCallId = { id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"x"}' } }
    // Step starts: the assistant asks for a tool call…
    await s.append({ type: 'user/message', payload: { content: 'run it' } })
    await s.append({
      type: 'assistant/message',
      payload: { role: 'assistant', content: null, tool_calls: [call], stream: stream([call]) },
    })
    // …and while the tool runs, a compaction marker lands (mid-step compact).
    await s.append({ type: 'session/note', payload: { note: 'compaction', summary: 'everything up to the call' } })
    // The tool finishes after the marker: its result lost its pairing.
    await s.append({ type: 'tool/result', payload: { id: 'c1', name: 'bash', output: 'late output', durationMs: 9 } })

    const messages = s.deriveMessages()
    // Everything before the marker is carried by the summary, so the
    // projection is just the [context compacted] user message. The orphan
    // role:'tool' message must NOT appear — OpenAI-compatible APIs reject it
    // with 400 tool_call_id not found and would brick the session on resume.
    expect(messages).toHaveLength(1)
    expect(typeof messages[0]!.content === 'string' && (messages[0]!.content as string)).toContain('[context compacted')
    expect(typeof messages[0]!.content === 'string' && (messages[0]!.content as string)).toContain('everything up to the call')
    expect(messages.some((m) => m.role === 'tool')).toBe(false)
  })

  it('assistant/attempt, tool/call, agent/meta and session/note never enter the messages', async () => {
    const s = new Session('d-6', path.join(tmpRoot, 'd6'))
    const call: ToolCallId = { id: 'c9', type: 'function', function: { name: 't', arguments: '{}' } }
    await s.append({ type: 'agent/meta', payload: { created: true } })
    await s.append({ type: 'user/message', payload: { content: 'q' } })
    await s.append({ type: 'assistant/attempt', payload: { error: 'transient' } })
    await s.append({ type: 'tool/call', payload: { id: 'c9', name: 't', arguments: '{}' } })
    await s.append({
      type: 'assistant/message',
      payload: { role: 'assistant', content: 'a', tool_calls: [call], stream: stream([call]) },
    })
    await s.append({ type: 'session/note', payload: { note: 'observability only' } })
    await s.append({ type: 'tool/result', payload: { id: 'c9', name: 't', output: 'out', durationMs: 2 } })

    const messages = s.deriveMessages()
    expect(messages).toHaveLength(3)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
  })

  it('a durable clear preserves the latest system prompt and history but drops summaries and old tool pairs', async () => {
    const session = new Session('context-reset', path.join(tmpRoot, 'context-reset'))
    await session.append({ type: 'system/message', payload: { content: 'system rules' } })
    await session.append({ type: 'user/message', payload: { content: 'old user message' } })
    await session.append({ type: 'session/note', payload: { note: 'compaction', summary: 'old summary' } })
    const call: ToolCallId = { id: 'old-call', type: 'function', function: { name: 'read', arguments: '{}' } }
    await session.append({ type: 'assistant/message', payload: { role: 'assistant', content: null, tool_calls: [call], stream: stream([call]) } })
    const prefix = await fs.readFile(session.file, 'utf8')
    await session.clearContext()
    await session.append({ type: 'tool/result', payload: { id: 'old-call', name: 'read', output: 'late old output', durationMs: 1 } })
    await session.append({ type: 'user/message', payload: { content: 'fresh question' } })
    expect(session.deriveMessages()).toEqual([{ role: 'system', content: 'system rules' }, { role: 'user', content: 'fresh question' }])
    expect((await fs.readFile(session.file, 'utf8')).startsWith(prefix)).toBe(true)
    const restored = await new SessionService(tmpRoot).open(session.id)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('a failed clear write leaves model projection and sequence intact', async () => {
    const session = new Session('clear-fail', path.join(tmpRoot, 'clear-fail'))
    await session.append({ type: 'user/message', payload: { content: 'must not forget' } })
    const before = session.deriveMessages()
    const denied = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }))
    try { await expect(session.clearContext()).rejects.toThrow('denied') } finally { denied.mockRestore() }
    expect(session.deriveMessages()).toEqual(before)
    expect(session.events).toHaveLength(1)
    expect((await session.append({ type: 'user/message', payload: { content: 'next' } })).seq).toBe(2)
  })

  it('excludes concurrent append and deletion while a clear marker is being persisted', async () => {
    const session = new Session('clear-busy', path.join(tmpRoot, 'clear-busy'))
    await session.append({ type: 'user/message', payload: { content: 'old history' } })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const append = fs.appendFile.bind(fs)
    const writing = vi.spyOn(fs, 'appendFile').mockImplementationOnce(async (...args: Parameters<typeof fs.appendFile>) => { await gate; return append(...args) })
    const clear = session.clearContext()
    try {
      await expect(session.append({ type: 'user/message', payload: { content: 'cannot interleave' } })).rejects.toMatchObject({ code: 'EBUSY' })
      await expect(session.delete()).rejects.toMatchObject({ code: 'EBUSY' })
      await expect(session.clearContext()).rejects.toMatchObject({ code: 'EBUSY' })
    } finally { release(); await clear; writing.mockRestore() }
    expect(session.deriveMessages()).toEqual([])
    expect(session.events.at(-1)?.seq).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// sessionPlugin — the ctx.provide/ctx.set wiring for ctx.sessions
// ---------------------------------------------------------------------------

describe('sessionPlugin', () => {
  it('wires a sessions service via the provide/set pattern and honors config.dir', async () => {
    const ctx = new Context()
    const scope = await ctx.plugin(sessionPlugin, { dir: tmpRoot })

    expect(scope.has('sessions')).toBe(true)
    const sessions = scope.get<SessionService>('sessions')
    expect(sessions).toBeInstanceOf(SessionService)

    const s = await sessions.create()
    expect(path.dirname(s.dir)).toBe(tmpRoot)
    expect(await readLines(s.file)).toHaveLength(1)
  })

  it('defaults to .sakura/sessions when no dir is configured', async () => {
    const ctx = new Context()
    const scope = await ctx.plugin(sessionPlugin, {})
    const svc = scope.get<SessionService>('sessions')
    expect((svc as unknown as { rootDir: string }).rootDir).toBe('.sakura/sessions')
  })
})
