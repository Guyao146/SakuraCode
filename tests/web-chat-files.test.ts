/** Actual HTTP file transport, expert fan-out, replay, stale targets and authorization. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerOptions, type WebServerHandle } from '../src/web/server.js'
import { CHAT_FILE_LIMITS, type ChatAttachment } from '../src/core/attachments.js'
import type { LLMRequest } from '../src/core/types.js'
import { MockAdapter, text } from './helpers.js'

const directories: string[] = [], servers: WebServerHandle[] = []
const post = (base: string, route: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + route, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
})
const upload = (name: string, content: string | Buffer) => ({ name, dataUrl: 'data:application/octet-stream;base64,' + Buffer.from(content).toString('base64') })
afterEach(async () => {
  while (servers.length) await servers.pop()!.close()
  while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
})
async function boot(extra: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-files-')); directories.push(cwd)
  const requests: LLMRequest[] = []
  const server = await runWebServer({ cwd, adapter: new MockAdapter([request => { requests.push(request); return text('FILES_ACCEPTED') }]),
    approvalMode: 'yolo', open: false, quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, ...extra })
  servers.push(server)
  return { server, cwd, requests, base: server.url.replace(/\/$/, '') }
}

describe('web chat files', () => {
  it('rejects a team that was stopped and restarted while files were being saved', async () => {
    const { base, server, requests } = await boot()
    expect((await post(base, '/api/experts/start', {})).status).toBe(200)
    const prepare = server.harness.ctx.agents.prepareFiles.bind(server.harness.ctx.agents)
    const paths: string[] = []
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    let first = true
    const spy = vi.spyOn(server.harness.ctx.agents, 'prepareFiles').mockImplementation(async (id, files) => {
      const prepared = await prepare(id, files); paths.push(...prepared.attachments.map(file => file.path))
      if (first) { first = false; entered(); await held }
      return prepared
    })
    try {
      const pending = post(base, '/api/message', { text: 'stale team task', files: [upload('team.txt', 'DO_NOT_FAN_OUT')] })
      await started
      expect((await post(base, '/api/experts/stop', {})).status).toBe(200)
      expect((await post(base, '/api/experts/start', {})).status).toBe(200)
      release()
      const response = await pending
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('专家组已改变') })
      expect(requests).toHaveLength(0)
      for (const file of paths) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { release(); spy.mockRestore() }
  })

  it('rejects expert actions explicitly targeting an older session', async () => {
    const { base, server, requests } = await boot()
    const first = await (await post(base, '/api/sessions', {})).json() as { sessionId: string }
    const second = await (await post(base, '/api/sessions', {})).json() as { sessionId: string }
    for (const route of ['/api/experts/start', '/api/experts/stop', '/api/experts/summarize']) {
      expect((await post(base, route, { sessionId: first.sessionId })).status).toBe(409)
    }
    expect(server.harness.main().sessionId).toBe(second.sessionId)
    expect(server.harness.ctx.agents.list()).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })

  it.each([null, 'invalid', [42], ['https://example.test/image.png'], ['data:image/png;base64,***'],
    ['data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')],
    ['data:image/png;base64,' + Buffer.from('not an image').toString('base64')],
    Array.from({ length: 13 }, () => 'data:image/png;base64,iVBORw0KGgo=')].map(images => ({ images })))('rejects malformed legacy images instead of silently sending an incomplete task ($images)', async ({ images }) => {
    const { base, requests } = await boot()
    const response = await post(base, '/api/message', { text: 'validate every image', images })
    expect([400, 413]).toContain(response.status)
    expect(requests).toHaveLength(0)
  })

  it('applies the file-count limit to mixed legacy images and uploaded files', async () => {
    const { base, requests } = await boot()
    expect((await post(base, '/api/message', { text: 'too many attachments',
      files: Array.from({ length: 12 }, () => upload('empty.txt', '')),
      images: ['data:image/png;base64,iVBORw0KGgo='] })).status).toBe(413)
    expect(requests).toHaveLength(0)
  })

  it('stores legacy images independently for every expert, keeping exact replay bytes', async () => {
    const { base, server, requests } = await boot()
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
    expect((await post(base, '/api/experts/start', {})).status).toBe(200)
    expect((await post(base, '/api/message', { text: '', images: [image] })).status).toBe(202)
    const agents = server.harness.ctx.agents.list()
    await Promise.all(agents.map(agent => agent.wait()))
    expect(requests).toHaveLength(4)
    const paths: string[] = []
    for (const agent of agents) {
      const session = await server.harness.ctx.sessions.open(agent.sessionId)
      const user = session.events.find(event => event.type === 'user/message')
      if (user?.type !== 'user/message') throw new Error('Missing image user record')
      expect(user.payload.images).toEqual([image])
      const attachment = user.payload.attachments![0]!
      expect(attachment).toMatchObject({ name: 'image-1.png', kind: 'image' })
      expect(await fs.readFile(attachment.path)).toEqual(Buffer.from(image.split(',')[1]!, 'base64'))
      paths.push(attachment.path)
    }
    expect(new Set(paths).size).toBe(4)
  })

  it('rejects legacy image storage failures before acceptance, without any model request', async () => {
    const { base, server, requests } = await boot()
    const spy = vi.spyOn(server.harness.ctx.agents, 'prepareFiles').mockRejectedValueOnce(new Error('synthetic image disk failure'))
    try {
      const response = await post(base, '/api/message', { text: 'legacy image draft', images: ['data:image/png;base64,iVBORw0KGgo='] })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('消息没有发送') })
      expect(requests).toHaveLength(0)
    } finally { spy.mockRestore() }
  })

  it('rejects a stale client expert-mode expectation instead of unexpectedly fanning out a task', async () => {
    const { base, requests } = await boot()
    expect((await post(base, '/api/experts/start', {})).status).toBe(200)
    expect((await post(base, '/api/message', { text: 'main only draft', expertMode: false })).status).toBe(409)
    expect(requests).toHaveLength(0)
  })

  it('acknowledges disk failure before accepting a message and rolls back all prepared expert copies', async () => {
    const { base, server, requests } = await boot()
    expect((await post(base, '/api/experts/start', {})).status).toBe(200)
    const prepare = server.harness.ctx.agents.prepareFiles.bind(server.harness.ctx.agents), paths: string[] = []
    let calls = 0
    const spy = vi.spyOn(server.harness.ctx.agents, 'prepareFiles').mockImplementation(async (id, files) => {
      if (++calls === 3) throw new Error('synthetic disk full')
      const prepared = await prepare(id, files); paths.push(...prepared.attachments.map(file => file.path)); return prepared
    })
    try {
      const response = await post(base, '/api/message', { text: 'do not lose draft', files: [upload('task.txt', 'DISK_FAILURE_DRAFT')] })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('消息没有发送') })
      expect(requests).toHaveLength(0)
      expect(paths).toHaveLength(2)
      for (const file of paths) await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
      for (const agent of server.harness.ctx.agents.list().filter(agent => !agent.sessionId.startsWith('('))) {
        expect((await server.harness.ctx.sessions.open(agent.sessionId)).events.some(event => event.type === 'user/message')).toBe(false)
      }
    } finally { spy.mockRestore() }
    expect((await post(base, '/api/message', { text: 'retry explicitly', files: [upload('task.txt', 'DISK_FAILURE_DRAFT')] })).status).toBe(202)
    await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    expect(requests).toHaveLength(4)
  })

  it('saves queued file bytes before acceptance and delivers once when the held turn ends', async () => {
    const requests: LLMRequest[] = []
    let release!: () => void, entered!: () => void
    const hold = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    const { base, server } = await boot({ adapter: { id: 'held-file-adapter', defaultModel: 'held-model', async *stream(request) {
      requests.push(request)
      if (requests.length === 1) { entered(); await hold }
      yield* text('QUEUED_FILE_RESULT')
    } } })
    try {
      expect((await post(base, '/api/message', { text: 'hold first' })).status).toBe(202); await started
      const main = server.harness.main(), response = await post(base, '/api/message', { text: 'queued', files: [upload('queued.txt', 'QUEUE_FILE_BYTES')], sessionId: main.sessionId })
      expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ queued: true })
      expect(requests).toHaveLength(1)
      const session = await server.harness.ctx.sessions.open(main.sessionId), batches = await fs.readdir(path.join(session.dir, 'attachments'))
      expect(batches).toHaveLength(1)
      expect(await fs.readFile(path.join(session.dir, 'attachments', batches[0]!, 'file-1.txt'), 'utf8')).toBe('QUEUE_FILE_BYTES')
      release(); await main.wait()
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[1]!.messages)).toContain('QUEUE_FILE_BYTES')
    } finally { release() }
  })

  it('coalesces simultaneous first-message uploads into one session without losing either file', async () => {
    const { base, server, requests } = await boot()
    const responses = await Promise.all(['one', 'two'].map(value => post(base, '/api/message', { text: value, files: [upload(value + '.txt', 'CONCURRENT_' + value)] })))
    expect(responses.map(response => response.status)).toEqual([202, 202])
    const main = server.harness.main(); await main.wait()
    expect(requests).toHaveLength(2)
    const session = await server.harness.ctx.sessions.open(main.sessionId)
    const users = session.events.filter(event => event.type === 'user/message')
    expect(users).toHaveLength(2)
    expect(users.every(event => event.type === 'user/message' && event.payload.attachments?.length === 1)).toBe(true)
    expect(JSON.stringify(session.deriveMessages())).toContain('CONCURRENT_one')
    expect(JSON.stringify(session.deriveMessages())).toContain('CONCURRENT_two')
  })

  it('accepts mixed files without a text draft and restores file metadata/text after full server restart', async () => {
    const { base, server, cwd, requests } = await boot()
    expect(await (await fetch(base + '/api/state')).json()).toMatchObject({ attachmentLimits: CHAT_FILE_LIMITS })
    const files = [upload('中文 notes.txt', 'FILE_TRANSPORT_BODY'), upload('archive.zip', Buffer.from([80, 75, 3, 4, 0, 255]))]
    expect((await post(base, '/api/message', { text: '', files, sessionId: null })).status).toBe(202)
    const main = server.harness.main(); expect((await main.wait()).error).toBeUndefined()
    expect(JSON.stringify(requests[0]!.messages)).toContain('FILE_TRANSPORT_BODY')
    const records = await (await fetch(base + `/api/sessions/${main.sessionId}/records`)).json() as { records: Array<{ type: string; payload: { content?: string; attachments?: ChatAttachment[] } }> }
    const user = records.records.find(record => record.type === 'user/message')!
    expect(user.payload.attachments!.map(file => file.kind)).toEqual(['text', 'binary'])
    expect(user.payload.content).toContain('请查看附件文件。')
    await server.close()
    const restarted = await runWebServer({ cwd, resumeSessionId: main.sessionId, adapter: new MockAdapter([text('REPLAYED')]), quiet: true, open: false, token: null, viewerToken: null, updatesAutoCheck: false })
    servers.push(restarted)
    const resumed = await restarted.harness.ctx.sessions.open(main.sessionId)
    expect(JSON.stringify(resumed.deriveMessages())).toContain('FILE_TRANSPORT_BODY')
    expect(resumed.events.find(event => event.type === 'user/message')).toMatchObject({ payload: { attachments: user.payload.attachments } })
    for (const [index, file] of user.payload.attachments!.entries()) expect(await fs.readFile(file.path)).toEqual(Buffer.from(files[index]!.dataUrl.split(',')[1]!, 'base64'))
  })

  it('each expert receives its own complete copy, and deletion of the main session does not destroy expert bytes', async () => {
    const { base, server, cwd, requests } = await boot()
    const start = await post(base, '/api/experts/start', {})
    expect(start.status).toBe(200); expect(requests).toHaveLength(0)
    const files = [upload('task.md', 'EXPERT_ATTACHMENT_CONTEXT')]
    expect((await post(base, '/api/message', { text: 'shared task', files })).status).toBe(202)
    const agents = server.harness.ctx.agents.list()
    expect(agents).toHaveLength(4)
    await Promise.all(agents.map(agent => agent.wait()))
    expect(requests).toHaveLength(4)
    const attachments: ChatAttachment[] = []
    for (const agent of agents) {
      const session = await server.harness.ctx.sessions.open(agent.sessionId)
      const user = session.events.find(event => event.type === 'user/message')
      if (user?.type !== 'user/message') throw new Error('Missing expert user record')
      expect(user.payload.content).toContain('EXPERT_ATTACHMENT_CONTEXT')
      const file = user.payload.attachments![0]!; attachments.push(file)
      expect(file.path.startsWith(session.dir + path.sep)).toBe(true)
      expect(await fs.readFile(file.path, 'utf8')).toBe('EXPERT_ATTACHMENT_CONTEXT')
    }
    expect(new Set(attachments.map(file => file.path)).size).toBe(4)
    const original = path.join(cwd, 'original.md'); await fs.writeFile(original, 'ORIGINAL_NOT_TOUCHED')
    expect((await post(base, '/api/experts/stop', {})).status).toBe(200)
    const sid = server.harness.main().sessionId
    expect((await fetch(base + '/api/sessions/' + sid, { method: 'DELETE' })).status).toBe(200)
    for (const attachment of attachments.filter(file => !file.path.includes(path.sep + sid + path.sep))) expect(await fs.readFile(attachment.path, 'utf8')).toBe('EXPERT_ATTACHMENT_CONTEXT')
    expect(await fs.readFile(original, 'utf8')).toBe('ORIGINAL_NOT_TOUCHED')
  })

  it('rejects invalid, oversized, stale-session and cross-origin uploads without a model request', async () => {
    const { base, server, requests } = await boot()
    const session = await post(base, '/api/sessions', {}); const { sessionId } = await session.json() as { sessionId: string }
    const good = upload('one.txt', 'never sent')
    for (const [body, status] of [
      [{ text: 'x', files: [upload('../escape.txt', 'bad')] }, 400],
      [{ text: 'x', files: [upload('large', Buffer.alloc(CHAT_FILE_LIMITS.perFileBytes + 1))] }, 413],
      [{ text: 'x', files: Array.from({ length: 13 }, () => good) }, 413],
      [{ text: 'x', files: [good], sessionId: 'old-session' }, 409],
      [{ text: 'x', files: [good], sessionId: null }, 409],
    ] as const) expect((await post(base, '/api/message', body)).status).toBe(status)
    expect((await post(base, '/api/message', { text: 'x', files: [good], sessionId }, { origin: 'https://untrusted.example.test' })).status).toBe(403)
    expect(requests).toHaveLength(0)
    const opened = await server.harness.ctx.sessions.open(sessionId)
    expect(opened.events.some(event => event.type === 'user/message')).toBe(false)
    await expect(fs.stat(path.join(opened.dir, 'attachments'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unauthenticated/viewer uploads while allowing the authenticated operator', async () => {
    const token = 'operator-files-' + 'a'.repeat(40), viewer = 'viewer-files-' + 'b'.repeat(40)
    const { base, server, requests } = await boot({ token, viewerToken: viewer })
    const body = { text: 'x', files: [upload('explicit.txt', 'AUTHORIZED_FILE')] }
    expect((await post(base, '/api/message', body)).status).toBe(401)
    expect((await post(base, '/api/message', body, { authorization: 'Bearer ' + viewer })).status).toBe(403)
    expect(requests).toHaveLength(0)
    expect((await post(base, '/api/message', body, { authorization: 'Bearer ' + token })).status).toBe(202)
    await server.harness.main().wait()
    expect(JSON.stringify(requests[0]!.messages)).toContain('AUTHORIZED_FILE')
  })
})