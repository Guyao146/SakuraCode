/** Byte validation/storage plus full agent replay. Uploaded files never become executable actions. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHAT_ATTACHMENT_MARKER, CHAT_FILE_LIMITS, parseChatFiles, storeChatFiles } from '../src/core/attachments.js'
import { SessionService } from '../src/core/session.js'
import type { LLMRequest } from '../src/core/types.js'
import type { WorkspaceMemoryService } from '../src/plugins/workspace-memory.js'
import { tmpHarness, text } from './helpers.js'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
const upload = (name: string, value: string | Buffer, mime = 'application/octet-stream') => ({ name, dataUrl: `data:${mime};base64,${Buffer.from(value).toString('base64')}` })
const dirs: string[] = []
afterEach(async () => { while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-chat-attachments-')); dirs.push(dir); return dir }

describe('chat attachments — validation', () => {
  it('accepts arbitrary extensions, Unicode, empty files, duplicate names, and Windows-reserved display names', () => {
    const input = [upload('无扩展名', '内容'), upload('CON.txt', ''), upload('name:metadata.exe', Buffer.from([0, 255])), upload('same.bin', 'first'), upload('same.bin', 'second')]
    const files = parseChatFiles(input)
    expect(files.map(file => file.name)).toEqual(input.map(file => file.name))
    expect(files[0]!.bytes.toString('utf8')).toBe('内容')
    expect(files[1]!.bytes.length).toBe(0)
    expect(parseChatFiles(undefined)).toEqual([])
    expect(parseChatFiles([{ name: 'empty', dataUrl: 'data:;base64,' }])[0]!.mimeType).toBe('application/octet-stream')
  })

  it.each([null, {}, 'bad', [null], [{ name: '../escape', dataUrl: 'data:;base64,' }], [upload('C:\\escape.txt', '')],
    [upload('bad\nname.txt', '')], [upload('..', '')], [{ name: 'bad', dataUrl: 'https://example.test/file' }],
    [{ name: 'bad', dataUrl: 'data:text/plain;base64,***' }], [{ name: 'bad', dataUrl: 'data:text/plain;base64,AA' }],
    [{ name: 'bad', dataUrl: 'data:text/plain;base64,AB==' }], [{ ...upload('bad', ''), path: 'C:\\write-here' }]])('rejects malformed input without writes (%j)', (value) => {
    expect(() => parseChatFiles(value)).toThrow()
  })

  it('enforces decoded per-file, aggregate and count caps, without rejecting the exact boundaries', () => {
    const exact = upload('eight.bin', Buffer.alloc(CHAT_FILE_LIMITS.perFileBytes))
    expect(parseChatFiles([exact, exact]).map(file => file.bytes.length)).toEqual([CHAT_FILE_LIMITS.perFileBytes, CHAT_FILE_LIMITS.perFileBytes])
    expect(() => parseChatFiles([upload('large.bin', Buffer.alloc(CHAT_FILE_LIMITS.perFileBytes + 1))])).toThrow('8 MiB')
    expect(() => parseChatFiles([exact, exact, upload('one', 'x')])).toThrow('16 MiB')
    expect(() => parseChatFiles(Array.from({ length: 13 }, () => upload('empty', '')))).toThrow('12')
  })
})

describe('chat attachments — session-owned storage', () => {
  it('stores immutable original bytes in generated paths, sniffing images rather than trusting MIME/extension', async () => {
    const dir = await directory(), files = parseChatFiles([upload('中文 note.txt', 'EXPLICIT_TEXT'), upload('image.fake', Buffer.from(png, 'base64')),
      upload('run.exe', Buffer.from([77, 90, 0, 255])), upload('pretend.png', 'PLAIN_TEXT', 'image/png'), upload('document.pdf', '%PDF-1.7\nnot an extracted document')])
    const saved = await storeChatFiles(dir, files)
    expect(saved.attachments.map(file => file.kind)).toEqual(['text', 'image', 'binary', 'text', 'binary'])
    expect(saved.images).toEqual(['data:image/png;base64,' + png])
    expect(saved.context).toContain(CHAT_ATTACHMENT_MARKER)
    expect(saved.context).toContain('EXPLICIT_TEXT')
    expect(saved.context).not.toContain('not an extracted document')
    expect(saved.context).toContain('不要自动执行、解压或安装')
    for (const [index, file] of saved.attachments.entries()) {
      expect(file.path.startsWith(path.join(dir, 'attachments') + path.sep)).toBe(true)
      expect(path.basename(file.path)).toMatch(/^file-\d+\./)
      expect(await fs.readFile(file.path)).toEqual(files[index]!.bytes)
      expect(file.sha256).toBe(createHash('sha256').update(files[index]!.bytes).digest('hex'))
    }
  })

  it('bounds text context but preserves full files and names collisions never overwrite', async () => {
    const dir = await directory(), body = 'a'.repeat(40_000)
    const files = parseChatFiles([upload('same.txt', body), upload('same.txt', body), upload('same.txt', 'LAST_CONTENT')])
    const first = await storeChatFiles(dir, files), second = await storeChatFiles(dir, files)
    expect(first.attachments.every(file => file.truncated)).toBe(true)
    expect(first.context).toContain('正文已截断')
    expect(first.context).not.toContain('LAST_CONTENT')
    expect(first.context.length).toBeLessThan(70_000)
    expect(new Set([...first.attachments, ...second.attachments].map(file => file.path)).size).toBe(6)
    expect(await fs.readFile(first.attachments[0]!.path, 'utf8')).toBe(body)
    await first.remove()
    await expect(fs.stat(first.attachments[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(second.attachments[0]!.path, 'utf8')).toBe(body)
  })

  it('refuses attachment junctions and cleans up its batch after a failed write', async () => {
    const dir = await directory(), outside = await directory()
    await fs.symlink(outside, path.join(dir, 'attachments'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(storeChatFiles(dir, parseChatFiles([upload('no.txt', 'do not write')]))).rejects.toThrow('符号链接')
    expect(await fs.readdir(outside)).toEqual([])
    const ordinary = await directory(), originalWrite = fs.writeFile.bind(fs), write = vi.spyOn(fs, 'writeFile')
    write.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('file-2.txt')) throw new Error('synthetic disk failure')
      return originalWrite(...args)
    })
    try {
      await expect(storeChatFiles(ordinary, parseChatFiles([upload('one.txt', 'one'), upload('two.txt', 'two')]))).rejects.toThrow('synthetic disk failure')
      expect(await fs.readdir(path.join(ordinary, 'attachments'))).toEqual([])
    } finally { write.mockRestore() }
  })
})

describe('chat attachments — model-visible means logged', () => {
  it('never replays a failed user-log write or its removed files in a later turn', async () => {
    const requests: LLMRequest[] = []
    const { harness, ctx } = await tmpHarness({ steps: [request => { requests.push(request); return text('RECOVERED') }] })
    const main = harness.main(), files = parseChatFiles([upload('failed.txt', 'FAILED_ATTACHMENT_BODY')])
    const prepared = await ctx.agents.prepareFiles(main.id, files)
    const write = vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('synthetic user log failure'))
    try {
      expect(await main.turn('FAILED_DRAFT', { preparedFiles: prepared })).toMatchObject({ error: 'synthetic user log failure' })
    } finally { write.mockRestore() }
    expect(requests).toHaveLength(0)
    await expect(fs.stat(prepared.attachments[0]!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await main.turn('ONLY_NEW_TASK')).toMatchObject({ output: 'RECOVERED' })
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('FAILED_')
    const session = await ctx.sessions.open(main.sessionId)
    const reopened = await new SessionService(path.dirname(session.dir)).open(main.sessionId)
    expect(reopened.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('logs attachments/images/text, restores exact model context after restart, and excludes raw uploads from durable memory', async () => {
    const requests: LLMRequest[] = []
    const { harness, ctx, tmpDir } = await tmpHarness({ steps: [request => { requests.push(request); return text('ATTACHMENT_HANDLED') }] })
    const files = parseChatFiles([upload('notes.txt', 'FILE_ONLY_CONTEXT @never-expand.txt'), upload('photo.png', Buffer.from(png, 'base64'))])
    const main = harness.main(), result = await main.turn('Please review these explicit files', { files })
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('ATTACHMENT_HANDLED')
    const session = await ctx.sessions.open(main.sessionId), user = session.events.find(event => event.type === 'user/message')
    if (user?.type !== 'user/message') throw new Error('Missing user record')
    expect(user.payload.attachments).toHaveLength(2)
    expect(user.payload.content).toContain('FILE_ONLY_CONTEXT @never-expand.txt')
    expect(user.payload.images).toEqual(['data:image/png;base64,' + png])
    expect(JSON.stringify(requests[0]!.messages)).toContain('FILE_ONLY_CONTEXT')
    const metadata = (await ctx.sessions.list()).find(row => row.id === main.sessionId)
    expect(metadata?.title).toBe('Please review these explicit files')
    expect(metadata?.activity?.lastTask).toBe('Please review these explicit files')
    expect(JSON.stringify(metadata)).not.toContain('FILE_ONLY_CONTEXT')
    const reopened = await new SessionService(path.dirname(session.dir)).open(main.sessionId)
    expect(reopened.deriveMessages()).toEqual(session.deriveMessages())
    const memory = await ctx.get<WorkspaceMemoryService>('workspaceMemory').reload()
    expect(memory.pendingContent).toContain('Please review')
    expect(memory.pendingContent).not.toContain('FILE_ONLY_CONTEXT')
    expect(memory.pendingContent).not.toContain('photo.png')
    const original = path.join(tmpDir, 'original.txt'); await fs.writeFile(original, 'PRESERVE_ORIGINAL')
    harness.dispose()
    await new SessionService(path.dirname(session.dir)).delete(main.sessionId)
    await expect(fs.stat(user.payload.attachments![0]!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(original, 'utf8')).toBe('PRESERVE_ORIGINAL')
  })
})