/**
 * Web GUI server — REST surface, SSE fan-out, approval bridge, session
 * switching. Uses the MockAdapter and an ephemeral port; no browser needed.
 */

import { promises as fs } from 'node:fs'
import type { Dirent } from 'node:fs'
import * as crypto from 'node:crypto'
import * as http from 'node:http'
import * as os from 'node:os'
import pkg from '../package.json'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type DesktopSettingsState, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { MockAdapter, text, toolCall, type MockStep } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length) {
    const dispose = cleanups.pop()
    await dispose?.()
  }
})

async function boot(
  steps: MockStep[] | ((tmpDir: string) => MockStep[]),
  approvalMode: 'yolo' | 'default' = 'yolo',
  extra: Partial<WebServerOptions> = {},
): Promise<{
  handle: WebServerHandle
  base: string
  tmpDir: string
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-test-'))
  const handle = await runWebServer({
    cwd: tmpDir,
    sessionDir: 'sessions',
    jobsDir: 'jobs',
    adapter: new MockAdapter(typeof steps === 'function' ? steps(tmpDir) : steps),
    approvalMode,
    quiet: true,
    open: false,
    ...extra,
  })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
  return { handle, base: handle.url.replace(/\/$/, ''), tmpDir }
}

/** Subscribe to the SSE stream; keep collecting frames in the background until stop(). */
function sseCollect(base: string, timeoutMs = 30_000): {
  frames: Array<Record<string, unknown>>
  stop(): Promise<void>
} {
  const frames: Array<Record<string, unknown>> = []
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const reading = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: controller.signal })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        frames.push(JSON.parse(line.slice(6)) as Record<string, unknown>)
      }
    }
  })()
  return {
    frames,
    async stop() {
      clearTimeout(timer)
      controller.abort()
      await reading.catch(() => {})
    },
  }
}

/** Wait until `pred` matches a collected frame (or fail after the deadline). */
async function waitFrame(
  frames: Array<Record<string, unknown>>,
  pred: (f: Record<string, unknown>) => boolean,
  deadlineMs = 15_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const hit = frames.find(pred)
    if (hit) return hit
    if (Date.now() > deadline) throw new Error(`timed out waiting for frame (collected ${frames.length})`)
    await new Promise((r) => setTimeout(r, 40))
  }
}

const waitFor = (frames: Array<Record<string, unknown>>, type: string, extra?: (f: Record<string, unknown>) => boolean): boolean =>
  frames.some((f) => f.type === type && (!extra || extra(f)))

describe('web server — REST surface', () => {
  it('serves state, rejects unknown routes', async () => {
    const { base } = await boot([text('ok')])
    const state = (await (await fetch(`${base}/api/state`)).json()) as Record<string, unknown>
    expect(state.version).toBe(pkg.version)
    expect(state.approvalMode).toBe('yolo')
    expect(Array.isArray(state.sessions)).toBe(true)
    expect(Array.isArray(state.agents)).toBe(true)

    const res404 = await fetch(`${base}/api/nope`)
    expect(res404.status).toBe(404)
  })

  it('serves the index HTML at /', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('<html')
  })

  it('hashes the CSP script source the way the HTML tokenizer sees it', async () => {
    // The tokenizer normalizes CRLF/CR to LF before the script text reaches the
    // DOM, so a hash over the raw bytes makes the browser block its own inline
    // script whenever index.html carries Windows line endings.
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/`)
    const served = (await res.text()).match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
    expect(served).toBeTruthy()
    const policy = res.headers.get('content-security-policy') ?? ''
    expect(policy).toContain("script-src 'sha256-")
    const normalized = served.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    expect(crypto.createHash('sha256').update(normalized, 'utf8').digest('base64'))
      .toBe(policy.match(/script-src 'sha256-([^']+)'/)?.[1])
    if (served !== normalized) {
      expect(policy).not.toContain(crypto.createHash('sha256').update(served, 'utf8').digest('base64'))
    }
  })

  it('rejects a message without text', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/api/message`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
  })

  it('queues a message while a turn is in flight (mailbox semantics)', async () => {
    const { base } = await boot([text('first reply'), text('second reply')])
    const sse = sseCollect(base)
    const first = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(first.status).toBe(202)
    expect(((await first.json()) as { queued?: boolean }).queued).toBeFalsy()
    // While busy, the second message queues behind the running turn.
    const second = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'hi again' }) })
    expect(second.status).toBe(202)
    expect(((await second.json()) as { queued?: boolean }).queued).toBe(true)
    // Both turns eventually complete, in order. The FIRST ui/turn/end only
    // proves turn #1 finished — stopping the stream there can cut the queued
    // turn's ui/text frames, so wait for the second one.
    await waitFrame(sse.frames, () => sse.frames.filter((f) => f.type === 'ui/turn/end' && f.main === true).length >= 2)
    await sse.stop()
    const joined = sse.frames.filter((f) => f.type === 'ui/text').map((f) => f.delta).join('')
    expect(joined).toContain('first reply')
    expect(joined).toContain('second reply')
  })

  it('changes approval mode via /api/settings', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ approvalMode: 'acceptEdits' }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { approvalMode: string }
    expect(body.approvalMode).toBe('acceptEdits')
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ approvalMode: 'chaos' }) })
    expect(bad.status).toBe(400)
  })

  it('sets, reflects and clears a dedicated compaction model via /api/settings', async () => {
    const { base } = await boot([text('ok')])
    const state = async () => (await (await fetch(`${base}/api/state`)).json()) as { compactModel?: string }

    const res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ compactModel: 'mock-model' }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { compactModel?: string }).compactModel).toBe('mock-model')
    expect((await state()).compactModel).toBe('mock-model')

    // Unknown models are rejected without touching the live setting.
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ compactModel: 'missing-model' }) })
    expect(bad.status).toBe(400)
    expect((await state()).compactModel).toBe('mock-model')

    // null restores follow-the-current-model.
    const cleared = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ compactModel: null }) })
    expect(cleared.status).toBe(200)
    expect((await state()).compactModel).toBeUndefined()
  })

  it('accepts an empty string compactModel as follow-selection', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ compactModel: '' }) })
    expect(res.status).toBe(400)
    const state = (await (await fetch(`${base}/api/state`)).json()) as { compactModel?: string }
    expect(state.compactModel).toBeUndefined()
  })

  it.each([
    { name: 'invalid thinking', body: { approvalMode: 'plan', thinking: 'unsupported', model: 'mock-model' } },
    { name: 'unknown model', body: { approvalMode: 'plan', thinking: 'high', model: 'missing-model' } },
    { name: 'invalid approval mode', body: { approvalMode: 'chaos', thinking: 'high', model: 'mock-model' } },
    { name: 'null model', body: { approvalMode: 'plan', thinking: 'high', model: null } },
    { name: 'object model', body: { approvalMode: 'plan', thinking: 'high', model: {} } },
    { name: 'array model', body: { approvalMode: 'plan', thinking: 'high', model: ['mock-model'] } },
  ])('validates a settings patch before changing anything: $name', async ({ body }) => {
    const { base, handle } = await boot([text('ok')], 'yolo', { token: null, viewerToken: null })
    const state = async () => await (await fetch(`${base}/api/state`)).json()
    const before = await state()
    const llm = handle.harness.ctx.llm
    const adapter = llm.pick()
    const selected = llm.selectedModel()
    const response = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify(body) })
    expect(response.status).toBe(400)
    expect(await state()).toEqual(before)
    expect(llm.pick()).toBe(adapter)
    expect(llm.selectedModel()).toBe(selected)
  })

  it.each(['main', 'sub'] as const)('blocks model and thinking edits during a %s task but allows approval-only edits', async (role) => {
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let signal: AbortSignal | undefined
    const requests: Array<{ model?: string; thinking?: string }> = []
    const { base, handle } = await boot([], 'yolo', {
      token: null,
      viewerToken: null,
      adapter: {
        id: 'held', defaultModel: 'held-one', models: ['held-one', 'held-two'], async *stream(req) {
          requests.push({ model: req.model, thinking: req.thinking })
          signal = req.signal
          entered()
          await barrier
          req.signal?.throwIfAborted()
          yield { type: 'text', delta: 'completed without interruption' }
          yield { type: 'done', reason: 'stop' }
        },
      },
    })
    const agent = role === 'main' ? handle.harness.main() : handle.harness.ctx.agents.spawn({
      name: 'held collaborator', seed: '', autoStart: false, meta: { role: 'sub' },
    })
    const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', body: JSON.stringify(body) })
    const state = async () => await (await fetch(`${base}/api/state`)).json() as {
      busy: boolean; approvalMode: string; thinking: string; model: string; modelStatus: { model: string }
    }
    try {
      const route = role === 'main' ? '/api/message' : `/api/agents/${agent.id}/message`
      expect((await post(route, { text: 'hold this task' })).status).toBe(202)
      await started
      const before = await state()
      expect(before.busy).toBe(role === 'main')
      expect(before.modelStatus.model).toBe('held-one')
      for (const patch of [
        { model: 'held-two' },
        { thinking: 'high' },
        { approvalMode: 'plan', model: 'held-two', thinking: 'high' },
      ]) {
        expect((await post('/api/settings', patch)).status).toBe(409)
        expect(await state()).toEqual(before)
        expect(agent.status).toBe('running')
        expect(signal?.aborted).toBe(false)
      }
      const approved = await post('/api/settings', { approvalMode: 'plan' })
      expect(approved.status).toBe(200)
      expect(await approved.json()).toMatchObject({ approvalMode: 'plan', thinking: 'off' })
      expect(await state()).toMatchObject({ model: before.model, modelStatus: before.modelStatus, approvalMode: 'plan', thinking: 'off' })
      expect(agent.status).toBe('running')
      expect(signal?.aborted).toBe(false)
      expect(requests).toEqual([{ model: 'held-one', thinking: undefined }])

      release()
      const completed = await agent.wait()
      expect(completed.error).toBeUndefined()
      expect(completed.cancelled).toBeUndefined()
      expect(completed.output).toBe('completed without interruption')
      const applied = await post('/api/settings', { model: 'held-two', thinking: 'high', approvalMode: 'acceptEdits' })
      expect(applied.status).toBe(200)
      expect(await state()).toMatchObject({ model: 'held-two', modelStatus: { model: 'held-two' }, thinking: 'high', approvalMode: 'acceptEdits' })
      const next = await handle.harness.run('use the new configuration')
      expect(next.error).toBeUndefined()
      expect(next.cancelled).toBeUndefined()
      expect(requests).toEqual([{ model: 'held-one', thinking: undefined }, { model: 'held-two', thinking: 'high' }])
    } finally {
      release()
      await agent.wait()
    }
  })

  it('keeps regular settings behind the desktop persistence gate, including approval-only edits', async () => {
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const { base, handle } = await boot([text('ok')], 'yolo', {
      token: null,
      viewerToken: null,
      onPersistSettings: async () => { entered(); await barrier },
    })
    const ctx = handle.harness.ctx
    const post = (route: string, body: unknown) => fetch(base + route, { method: 'POST', body: JSON.stringify(body) })
    const saving = post('/api/desktop/settings', { rememberKey: true })
    try {
      await started
      for (const patch of [{ approvalMode: 'plan' }, { model: 'mock-model', thinking: 'high', approvalMode: 'plan' }]) {
        expect((await post('/api/settings', patch)).status).toBe(409)
        expect(ctx.approval.mode).toBe('yolo')
        expect(ctx.llm.thinking).toBe('off')
        expect(ctx.llm.modelStatus().model).toBe('mock-model')
      }
      release()
      expect((await saving).status).toBe(200)
      expect((await post('/api/settings', { approvalMode: 'plan', thinking: 'high' })).status).toBe(200)
      expect(ctx.approval.mode).toBe('plan')
      expect(ctx.llm.thinking).toBe('high')
    } finally {
      release()
      await saving
    }
  })
})

describe('web server — turn streaming over SSE', () => {
  it('streams ui/text and ui/turn/end for a text turn', async () => {
    const { base } = await boot([text('hello from mock')])
    const sse = sseCollect(base)
    const post = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'say hi' }) })
    expect(post.status).toBe(202)
    await waitFrame(sse.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await sse.stop()
    const joined = sse.frames.filter((f) => f.type === 'ui/text').map((f) => f.delta).join('')
    expect(joined).toContain('hello from mock')
    expect(waitFor(sse.frames, 'turn/start')).toBe(true)
    expect(waitFor(sse.frames, 'state')).toBe(true)
  })

  it('streams tool calls with parsed args and results', async () => {
    const { base, tmpDir } = await boot((dir) => [
      toolCall('write', JSON.stringify({ file_path: path.join(dir, 'out.txt'), content: 'written by web test' })),
      text('done writing'),
    ])
    const sse = sseCollect(base)
    await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'write the file' }) })
    await waitFrame(sse.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await sse.stop()
    const call = sse.frames.find((f) => f.type === 'ui/tool/call')
    expect(call).toBeTruthy()
    expect(String((call as { args: Record<string, unknown> }).args.file_path)).toMatch(/out\.txt$/)
    const result = sse.frames.find((f) => f.type === 'ui/tool/result')
    expect(result).toBeTruthy()
    expect((result as { isError?: boolean }).isError).toBeFalsy()
    expect(await fs.readFile(path.join(tmpDir, 'out.txt'), 'utf8')).toContain('written by web test')
  })
})

describe('web server — approval bridge', () => {
  it('surfaces approval requests and honors an allow decision', async () => {
    const { base, tmpDir } = await boot(
      (dir) => [
        toolCall('write', JSON.stringify({ file_path: path.join(dir, 'approved.txt'), content: 'yes' })),
        text('approved and done'),
      ],
      'default',
    )
    const sse = sseCollect(base)
    await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'write a file' }) })

    const request = (await waitFrame(sse.frames, (f) => f.type === 'approval/request')) as {
      id: string
      toolName: string
      kind: string
    }
    expect(request.toolName).toBe('write')
    expect(request.kind).toBe('write')
    await fetch(`${base}/api/approvals/${request.id}`, { method: 'POST', body: JSON.stringify({ allow: true }) })
    // The turn continues after the decision — wait for its end before reading files.
    await waitFrame(sse.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await waitFrame(sse.frames, (f) => f.type === 'approval/resolved' && f.allow === true)
    await sse.stop()

    expect(await fs.readFile(path.join(tmpDir, 'approved.txt'), 'utf8')).toBe('yes')
  })

  it('denies when the decision is allow:false', async () => {
    const { base, tmpDir } = await boot(
      (dir) => [
        toolCall('write', JSON.stringify({ file_path: path.join(dir, 'denied.txt'), content: 'no' })),
        text('ok, moving on'),
      ],
      'default',
    )
    const sse = sseCollect(base)
    await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'try to write' }) })
    const request = (await waitFrame(sse.frames, (f) => f.type === 'approval/request')) as { id: string }
    await fetch(`${base}/api/approvals/${request.id}`, { method: 'POST', body: JSON.stringify({ allow: false }) })
    await waitFrame(sse.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await sse.stop()
    await expect(fs.access(path.join(tmpDir, 'denied.txt'))).rejects.toThrow()
  })

  it('404s on unknown approval ids', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/api/approvals/does-not-exist`, { method: 'POST', body: JSON.stringify({ allow: true }) })
    expect(res.status).toBe(404)
  })
})

describe('web server — sessions and agents', () => {
  it('accepts user-attached images and logs them on the user message', async () => {
    const { base } = await boot([text('i see your image')])
    const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
    const sse = sseCollect(base)
    const res = await fetch(`${base}/api/message`, {
      method: 'POST',
      body: JSON.stringify({ text: 'look', images: [img] }),
    })
    expect(res.status).toBe(202)
    await waitFrame(sse.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await sse.stop()
    const state = (await (await fetch(`${base}/api/state`)).json()) as { sessionId: string }
    const records = (await (await fetch(`${base}/api/sessions/${state.sessionId}/records`)).json()) as {
      records: Array<{ type: string; payload: { content?: string; images?: string[] } }>
    }
    const user = records.records.find((r) => r.type === 'user/message')
    expect(user?.payload.images).toEqual([img])
  })

  it('rejects oversized image payloads', async () => {
    const { base } = await boot([text('ok')])
    const big = 'data:image/png;base64,' + 'A'.repeat(9 * 1024 * 1024)
    const res = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'x', images: [big] }) })
    expect(res.status).toBe(413)
  })

  it('switches sessions and replays records', async () => {
    const { base } = await boot([text('first session answer'), text('second session answer')])
    // Turn in the initial (auto-created on first message) session.
    const sse1 = sseCollect(base)
    await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'turn one' }) })
    await waitFrame(sse1.frames, (f) => f.type === 'ui/turn/end' && f.main === true)
    await sse1.stop()

    // Start a new session.
    const created = (await (
      await fetch(`${base}/api/sessions`, { method: 'POST', body: '{}' })
    ).json()) as { sessionId: string }
    expect(created.sessionId).toBeTruthy()

    // The old session's records replay through the REST endpoint.
    const state = (await (await fetch(`${base}/api/state`)).json()) as { sessions: Array<{ id: string }> }
    expect(state.sessions.length).toBeGreaterThanOrEqual(2)
    const oldId = state.sessions.find((s) => s.id !== created.sessionId)!.id
    const records = (await (await fetch(`${base}/api/sessions/${oldId}/records`)).json()) as {
      records: Array<{ type: string }>
    }
    expect(records.records.some((r) => r.type === 'user/message')).toBe(true)
    expect(records.records.some((r) => r.type === 'assistant/message')).toBe(true)

    // Resuming the old session works.
    const resumed = (await (
      await fetch(`${base}/api/sessions`, { method: 'POST', body: JSON.stringify({ id: oldId }) })
    ).json()) as { sessionId: string }
    expect(resumed.sessionId).toBe(oldId)
  })

  it('404s on records for an unknown session', async () => {
    const { base } = await boot([text('ok')])
    const res = await fetch(`${base}/api/sessions/nope-123/records`)
    expect(res.status).toBe(404)
  })

  it('spawns an agent, delivers a message, and lists it in state', async () => {
    const { base } = await boot([text('sub says hi'), text('done')])
    const spawned = (await (
      await fetch(`${base}/api/agents`, {
        method: 'POST',
        body: JSON.stringify({ name: 'researcher' }),
      })
    ).json()) as { agent: { id: string; name: string; role: string } }
    expect(spawned.agent.name).toBe('researcher')
    expect(spawned.agent.role).toBe('sub')

    const delivered = await fetch(`${base}/api/agents/${spawned.agent.id}/message`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello sub' }),
    })
    expect(delivered.status).toBe(202)

    const state = (await (await fetch(`${base}/api/state`)).json()) as { agents: Array<{ id: string }> }
    expect(state.agents.some((a) => a.id === spawned.agent.id)).toBe(true)

    const missing = await fetch(`${base}/api/agents/agent-999/message`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(missing.status).toBe(404)
  })

  it('includes agent descriptions and errors in the workspace projection', async () => {
    const { base, handle } = await boot([text('ok')])
    const agent = handle.harness.ctx.agents.spawn({
      name: 'reviewer', seed: '', autoStart: false,
      meta: { role: 'sub', description: 'Review the module boundaries' },
    })
    agent.error = 'model unavailable'
    agent.status = 'error'
    const state = await (await fetch(`${base}/api/state`)).json() as {
      agents: Array<{ id: string; description?: string; error?: string }>
    }
    expect(state.agents.find((entry) => entry.id === agent.id)).toMatchObject({
      description: 'Review the module boundaries', error: 'model unavailable',
    })
  })

  it('rechecks running agents after session I/O and rejects overlapping switches', async () => {
    const { base, handle } = await boot([text('ok')])
    const ctx = handle.harness.ctx
    await handle.harness.run('keep this session')
    const main = handle.harness.main()
    const target = await ctx.sessions.create()
    const open = ctx.sessions.open.bind(ctx.sessions)
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const spy = vi.spyOn(ctx.sessions, 'open').mockImplementation(async (id) => {
      if (id === target.id) { entered(); await gate }
      return open(id)
    })
    const switchToTarget = () => fetch(`${base}/api/sessions`, {
      method: 'POST', body: JSON.stringify({ id: target.id }),
    })
    const first = switchToTarget()
    let child: ReturnType<typeof ctx.agents.spawn> | undefined
    try {
      await started
      expect((await switchToTarget()).status).toBe(409)
      child = ctx.agents.spawn({ name: 'other device', seed: '', autoStart: false, meta: { role: 'sub' } })
      child.status = 'running'
      release()
      expect((await first).status).toBe(409)
      expect(handle.harness.main()).toBe(main)
      expect(ctx.agents.get(child.id)).toBe(child)
      child.status = 'idle'
      ctx.approval.engine.allowForSession('write')
      const retry = await switchToTarget()
      expect(retry.status).toBe(200)
      expect(await retry.json()).toEqual({ sessionId: target.id })
      expect(ctx.approval.engine.sessionAllowed()).toEqual([])
      const snapshot = await (await fetch(`${base}/api/state`)).json() as { sessionId: string }
      expect(snapshot.sessionId).toBe(target.id)
    } finally {
      release()
      if (child) child.status = 'idle'
      await first.catch(() => {})
      spy.mockRestore()
    }
  })
})

describe('web server — local hardening', () => {
  it('rejects a cross-origin POST and keeps Origin-less clients working', async () => {
    const { base } = await boot([text('ok')])
    const evil = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { origin: 'http://evil.test' },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(evil.status).toBe(403)

    // The page the server itself serves passes — including the localhost
    // spelling of the same port — and non-browser clients (no Origin at all)
    // keep working.
    const sameOrigin = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { origin: base },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(sameOrigin.status).toBe(202)
    const localhost = await fetch(`${base}/api/message`, {
      method: 'POST',
      headers: { origin: base.replace('127.0.0.1', 'localhost') },
      body: JSON.stringify({ text: 'hi' }),
    })
    expect(localhost.status).toBe(202)
    expect((await fetch(`${base}/api/state`)).status).toBe(200)
  })

  it('frees a stalled request body with 408 instead of holding the socket', async () => {
    const { base } = await boot([text('ok')], 'yolo', { bodyTimeoutMs: 150 })
    expect(await stalledPost(base)).toBe(408)
  })
})

/** POST with an announced but never-finished body; resolves with the response status. */
function stalledPost(base: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/message', base)
    const req = http.request(
      {
        host: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '64' },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.write('{"text":"stalled')
    // Deliberately never end(): the server waits for the remaining bytes.
  })
}

describe('web server — model readiness and settings application', () => {
  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('exposes model status and compaction thresholds in state without secrets', async () => {
    const { handle, base } = await boot([text('ok')])
    const state = await (await fetch(base + '/api/state')).json() as {
      modelStatus?: { adapter: string; model: string; configured: boolean; thinking: { supported: boolean; param: string; levels: string[] } }
      contextBudget?: { autoThreshold: number; autoTokensThreshold: number }
    }
    // A mock adapter is a custom adapter: configured, thinking capability unknown-but-honest.
    expect(state.modelStatus?.configured).toBe(true)
    expect(state.modelStatus?.thinking).toBeDefined()
    expect(state.contextBudget?.autoThreshold).toBeGreaterThan(0)
    expect(state.contextBudget?.autoTokensThreshold).toBeGreaterThan(0)
    await handle.close()
  })

  it.each(['main', 'sub'] as const)('rejects settings and workspace changes without interrupting a running %s agent', async (role) => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ws-busy-other-'))
    cleanups.push(() => fs.rm(other, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }))
    let release!: () => void
    let entered!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    let signal: AbortSignal | undefined
    const persisted: DesktopSettingsState[] = []
    const { handle, base, tmpDir } = await boot([], 'yolo', {
      token: null,
      viewerToken: null,
      adapter: {
        id: 'held', defaultModel: 'held-model', async *stream(req) {
          signal = req.signal
          entered()
          await barrier
          req.signal?.throwIfAborted()
          yield { type: 'text', delta: 'completed without interruption' }
          yield { type: 'done', reason: 'stop' }
        },
      },
      onPersistSettings: (settings) => { persisted.push(settings) },
    })
    const original = handle.harness
    const agent = role === 'main' ? original.main() : original.ctx.agents.spawn({
      name: 'held collaborator', seed: '', autoStart: false, meta: { role: 'sub' },
    })
    const route = role === 'main' ? '/api/message' : `/api/agents/${agent.id}/message`
    const state = async () => await (await fetch(`${base}/api/state`)).json() as {
      cwd: string; workspaceId: string; model: string; busy: boolean; sessionId: string | null
      approvalMode: string; thinking: string; desktop: DesktopSettingsState
    }
    const sse = sseCollect(base)
    try {
      await waitFrame(sse.frames, (frame) => frame.type === 'state')
      expect((await post(base + route, { text: 'hold this task' })).status).toBe(202)
      await started
      const before = await state()
      expect(before.cwd).toBe(tmpDir)
      // A collaboration agent must block settings even while the main agent is idle.
      expect(before.busy).toBe(role === 'main')
      expect(agent.status).toBe('running')
      expect(signal?.aborted).toBe(false)
      for (const patch of [
        { model: 'never-applied' },
        { workspace: other },
        { workspace: other, model: 'never-applied', baseURL: 'https://never-applied.invalid/v1', apiKey: 'never-applied-key', rememberKey: true },
      ]) {
        expect((await post(`${base}/api/desktop/settings`, patch)).status).toBe(409)
        expect(handle.harness).toBe(original)
        expect(original.ctx.isDisposed()).toBe(false)
        expect(signal?.aborted).toBe(false)
        expect(agent.status).toBe('running')
        expect(await state()).toMatchObject({
          cwd: before.cwd, workspaceId: before.workspaceId, model: before.model,
          desktop: before.desktop, sessionId: before.sessionId, busy: before.busy,
        })
        expect(persisted).toEqual([])
      }
      expect(sse.frames.some((frame) => frame.type === 'workspace/changed')).toBe(false)

      release()
      const completed = await agent.wait()
      expect(completed).toMatchObject({ output: 'completed without interruption' })
      expect(completed.error).toBeUndefined()
      expect(completed.cancelled).toBeUndefined()
      const ended = await waitFrame(sse.frames, (frame) => frame.type === 'ui/turn/end' && frame.agentId === agent.id)
      expect(ended).toMatchObject({ ok: true })
      expect(signal?.aborted).toBe(false)

      // Retrying only the workspace change succeeds after the task finishes;
      // none of the rejected provider edits may leak into the new mount.
      const switched = await post(`${base}/api/desktop/settings`, { workspace: other })
      expect(switched.status).toBe(200)
      const after = await state()
      expect(after.cwd).toBe(other)
      expect(after.workspaceId).not.toBe(before.workspaceId)
      expect(handle.harness).not.toBe(original)
      expect(after.desktop).toEqual({ ...before.desktop, workspace: other, recentWorkspaces: [other, tmpDir] })
      // The persist frame mirrors the state view plus the per-workspace prefs map.
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toMatchObject(after.desktop)
      expect(Object.keys(persisted[0] ?? {}).sort())
        .toEqual([...Object.keys(after.desktop ?? {}), 'workspacePrefs'].sort())
      await waitFrame(sse.frames, (frame) => frame.type === 'workspace/changed' && frame.workspace === other)
      expect(sse.frames.filter((frame) => frame.type === 'workspace/changed')).toHaveLength(1)

      // A stale settings retry from the old workspace must not mutate the new one.
      for (const [route, patch] of [
        ['/api/desktop/settings', { rememberKey: true }],
        ['/api/settings', { model: 'held-model', thinking: 'high', approvalMode: 'plan' }],
      ] as const) {
        const stale = await fetch(base + route, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-sakura-workspace': before.workspaceId },
          body: JSON.stringify(patch),
        })
        expect(stale.status).toBe(409)
        expect(await state()).toMatchObject({
          desktop: after.desktop, approvalMode: after.approvalMode, thinking: after.thinking, model: after.model,
        })
        expect(persisted).toHaveLength(1)
      }
    } finally {
      release()
      await agent.wait()
      await sse.stop()
    }
  })
describe('web server — workspace switch keeps tools on the new workspace', () => {
  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('routes write/grep and session logs to the newly mounted workspace', async () => {
    const first = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ws-tools-'))
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-ws-tools-other-'))
    await fs.writeFile(path.join(first, 'package.json'), '{"type":"module"}')
    await fs.writeFile(path.join(other, 'package.json'), '{"type":"module"}')
    const handle = await runWebServer({
      cwd: first,
      adapter: new MockAdapter([
        toolCall('write', JSON.stringify({ file_path: 'marker-first.txt', content: 'FIRST' })),
        text('first done'),
        toolCall('write', JSON.stringify({ file_path: 'marker-after.txt', content: 'AFTER' })),
        text('after done'),
        toolCall('grep', JSON.stringify({ pattern: 'SENTINEL-9' })),
        text('grep done'),
      ]),
      approvalMode: 'yolo',
      quiet: true,
      open: false,
      onPersistSettings: () => {},
    })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(first, { recursive: true, force: true }).catch(() => {})
      await fs.rm(other, { recursive: true, force: true }).catch(() => {})
    })
    const base = handle.url.replace(/\/$/, '')
    const sse = sseCollect(base)
    // Count turn ends so each wait targets THIS message's turn, not a previous one.
    const exists = (file: string) => fs.access(file).then(() => true, () => false)
    const turnEnds = () => sse.frames.filter((f) => f.type === 'ui/turn/end' && f.main === true).length

    // Phase A — a relative write lands in the first workspace.
    let res = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'write the first marker' }) })
    expect(res.status).toBe(202)
    await waitFrame(sse.frames, () => turnEnds() >= 1)
    await expect(fs.readFile(path.join(first, 'marker-first.txt'), 'utf8')).resolves.toBe('FIRST')

    // Phase B — after the switch the same relative path resolves to `other`,
    // never to the old workspace or the server's process.cwd().
    const switched = await (await post(`${base}/api/desktop/settings`, { workspace: other })).json() as { workspace: string }
    expect(switched.workspace).toBe(other)
    await fs.writeFile(path.join(other, 'sentinel-9.txt'), 'SENTINEL-9 lives here\n')
    res = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'write the second marker' }) })
    expect(res.status).toBe(202)
    await waitFrame(sse.frames, () => turnEnds() >= 2)
    await expect(fs.readFile(path.join(other, 'marker-after.txt'), 'utf8')).resolves.toBe('AFTER')
    expect(await exists(path.join(first, 'marker-after.txt'))).toBe(false)
    expect(await exists(path.join(process.cwd(), 'marker-after.txt'))).toBe(false)

    // grep walks the mounted workspace, not the process directory.
    res = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'find the sentinel' }) })
    expect(res.status).toBe(202)
   const grep = await waitFrame(sse.frames, (f) => f.type === 'ui/tool/result' && typeof f.output === 'string' && f.output.includes('sentinel-9.txt'))
   expect(String(grep.output)).toContain('SENTINEL-9')
    await waitFrame(sse.frames, () => turnEnds() >= 3)
    await sse.stop()

    // Sessions stay per workspace (each project keeps its own logs on disk).
    const sessionsFirst = await fs.readdir(path.join(first, '.sakura', 'sessions'))
    const sessionsOther = await fs.readdir(path.join(other, '.sakura', 'sessions'))
    expect(sessionsFirst.length).toBeGreaterThanOrEqual(1)
    expect(sessionsOther.length).toBeGreaterThanOrEqual(1)
  }, 60_000)
})

  it('applies an endpoint/key patch even when the model name is already registered', async () => {
    const requests: Array<{ url: string; auth?: string }> = []
    const probe = http.createServer((req, res) => {
      requests.push({ url: req.url ?? '', auth: req.headers['authorization'] })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'patched' }, finish_reason: null }] })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    // No custom adapter: the built-in OpenAI-compatible adapter is the
    // registered "chat-pro" model, so the patch must reconfigure it
    // rather than taking the registered-model shortcut.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-patch-'))
    const handle = await runWebServer({
      cwd: tmpDir,
      sessionDir: 'sessions',
      jobsDir: 'jobs',
      approvalMode: 'yolo',
      quiet: true,
      open: false,
      onPersistSettings: () => {},
    })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })
    try {
      const applied = await (await post(handle.url + 'api/desktop/settings', {
        baseURL: `http://127.0.0.1:${port}`,
        model: 'chat-pro',
        apiKey: 'patched-key',
      })).json() as { hasApiKey: boolean; model: string }
      expect(applied.hasApiKey).toBe(true)
      expect(applied.model).toBe('chat-pro')
      await post(handle.url + 'api/message', { text: 'probe' })
      await vi.waitFor(() => expect(requests.some((r) => r.url === '/chat/completions')).toBe(true), { timeout: 5000 })
      expect(requests.find((r) => r.url === '/chat/completions')?.auth).toBe('Bearer patched-key')
    } finally {
      probe.close()
    }
  })
})

describe('web server — desktop workspace prefs', () => {
  async function bootDesktop(workspace: string) {
    const persisted: DesktopSettingsState[] = []
    await fs.writeFile(path.join(workspace, 'package.json'), '{"type":"module"}')
    const handle = await runWebServer({
      cwd: workspace,
      adapter: new MockAdapter([text('ok')]),
      approvalMode: 'yolo',
      quiet: true,
      open: false,
      onPersistSettings: (s) => persisted.push(s),
    })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
    })
    return { handle, base: handle.url.replace(/\/$/, ''), workspace, persisted }
  }

  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('routes sessions to a per-workspace session dir and persists the pref', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-ws-'))
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-sessions-'))
    try {
      const { base, persisted } = await bootDesktop(workspace)
      const res = await post(`${base}/api/desktop/settings`, { sessionDir: storage })
      expect(res.status).toBe(200)
      const state = (await res.json()) as DesktopSettingsState
      expect(state.sessionDir).toBe(storage)
      // The full pref map rides the persist frame so the launcher can store it.
      expect(persisted.at(-1)?.workspacePrefs?.[path.resolve(workspace)]?.sessionDir).toBe(storage)

      // A turn after the remount must write its session into the override.
      const message = await post(`${base}/api/message`, { text: 'hello prefs' })
      expect(message.status).toBe(202)
      const deadline = Date.now() + 8000
      let landed: string[] = []
      while (Date.now() < deadline) {
        // Sessions are directories (one per id) inside the session dir.
        const entries = await fs.readdir(storage, { withFileTypes: true }).catch(() => [] as Dirent[])
        landed = entries.filter((e) => e.isDirectory()).map((e) => e.name)
        if (landed.length) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(landed.length).toBeGreaterThan(0)
    } finally {
      await fs.rm(storage, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('clearing the session dir restores the workspace default location', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-clear-'))
    const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-clear-sessions-'))
    const { base } = await bootDesktop(workspace)
    expect((await post(`${base}/api/desktop/settings`, { sessionDir: storage })).status).toBe(200)
    const cleared = await post(`${base}/api/desktop/settings`, { sessionDir: null })
    expect(cleared.status).toBe(200)
    expect(((await cleared.json()) as DesktopSettingsState).sessionDir).toBe('')
  })

  it('creates a missing workspace with create and rejects it without', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-create-'))
    const fresh = path.join(workspace, 'brand-new')
    const { base } = await bootDesktop(workspace)
    expect((await post(`${base}/api/desktop/settings`, { workspace: fresh })).status).toBe(400)
    const created = await post(`${base}/api/desktop/settings`, { workspace: fresh, create: true })
    expect(created.status).toBe(200)
    const state = (await (await fetch(`${base}/api/state`)).json()) as { cwd: string }
    expect(path.resolve(state.cwd)).toBe(path.resolve(fresh))
    expect((await fs.stat(fresh)).isDirectory()).toBe(true)
  })

  it('spawns the agents configured for a workspace and skips unknown types', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-agents-'))
    await fs.mkdir(path.join(workspace, '.sakura', 'agents'), { recursive: true })
    await fs.writeFile(path.join(workspace, '.sakura', 'agents', 'researcher.md'), '---\ndescription:研究员\n---\n你是研究员。')
    const { base } = await bootDesktop(workspace)
    const set = await post(`${base}/api/desktop/settings`, { agents: ['researcher', 'does-not-exist'] })
    expect(set.status).toBe(200)
    const state = (await (await fetch(`${base}/api/state`)).json()) as { agents: Array<{ name: string; role: string }> }
    expect(state.agents.map((a) => a.name)).toContain('researcher')
    expect(state.agents.some((a) => a.name === 'does-not-exist')).toBe(false)
    // A repeated save does not duplicate already-spawned agents.
    await post(`${base}/api/desktop/settings`, { agents: ['researcher'] })
    const again = (await (await fetch(`${base}/api/state`)).json()) as { agents: Array<{ name: string }> }
    expect(again.agents.filter((a) => a.name === 'researcher')).toHaveLength(1)
  })

  it('keeps the new-workspace default dir in desktop state', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-default-'))
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-pref-parent-'))
    const { base, persisted } = await bootDesktop(workspace)
    const res = await post(`${base}/api/desktop/settings`, { newWorkspaceDir: parent })
    expect(res.status).toBe(200)
    expect(((await res.json()) as DesktopSettingsState).newWorkspaceDir).toBe(parent)
    expect(persisted.at(-1)?.newWorkspaceDir).toBe(parent)
  })
})

describe('web server — weixin integration endpoints', () => {
  async function bootWeixin(transport: Record<string, unknown>) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-weixin-'))
    await fs.writeFile(path.join(tmpDir, 'package.json'), '{"type":"module"}')
    const persisted: unknown[] = []
    const handle = await runWebServer({
      cwd: tmpDir,
      adapter: new MockAdapter([text('ok')]),
      approvalMode: 'yolo',
      quiet: true,
      open: false,
      onPersistSettings: undefined,
      onPersistWeixin: async (settings: unknown) => { persisted.push(settings) },
      weixinTransport: transport as never,
    })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })
    return { handle, base: handle.url.replace(/\/$/, ''), tmpDir, persisted }
  }

  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('exposes a local-only status and hides weixin on remote servers', async () => {
    const transport = {
      async getQr() { return { qrcode: 'q', content: 'c' } },
      async pollQr() { return { status: 'wait' } },
      async getUpdates() { return { msgs: [], get_updates_buf: 'c' } },
      async sendText() { /* offline */ },
    }
    const { base } = await bootWeixin(transport)
    const status = await (await fetch(`${base}/api/state`)).json() as { weixin?: { phase: string; bound: boolean } }
    expect(status.weixin?.phase).toBe('unbound')
    const login = await post(`${base}/api/weixin/login`, {})
    expect(login.status).toBe(200)
    const state = (await login.json()) as { phase: string; available: boolean }
    expect(state.available).toBe(true)
    expect(state.phase).toBe('qr')
    const bad = await post(`${base}/api/weixin/settings`, { allowControl: 'yes' })
    expect(bad.status).toBe(400)
    await post(`${base}/api/weixin/cancel`, { loginId: (await (await fetch(`${base}/api/state`)).json()).weixin?.login?.id })
      .then((res) => expect(res.status).toBe(200))
  })

  it('validates settings patches before persisting', async () => {
    const transport = {
      async getQr() { return { qrcode: 'q', content: 'c' } },
      async pollQr() { return { status: 'wait' } },
      async getUpdates() { return { msgs: [], get_updates_buf: 'c' } },
      async sendText() { /* offline */ },
    }
    const { base, persisted } = await bootWeixin(transport)
    const bad = await post(`${base}/api/weixin/settings`, { allowControl: 'maybe' })
    expect(bad.status).toBe(400)
    expect(persisted).toHaveLength(0)
    // Disconnect is idempotent on an unbound workspace and still clears saved state.
    const cleared = await post(`${base}/api/weixin/disconnect`, {})
    expect(cleared.status).toBe(200)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({ enabled: false, allowControl: false, notifications: true })
  })
})

describe('web server — sessions titles and upstream model list', () => {
  const post = (url: string, body: unknown) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('creates a session with a title and renames it', async () => {
    const { base } = await boot([text('ok')])
    const created = await (await post(`${base}/api/sessions`, { title: '修复登录页' })).json() as { sessionId: string }
    expect(created.sessionId).toBeTruthy()
    let state = await (await fetch(`${base}/api/state`)).json() as { sessions: Array<{ id: string; title: string }> }
    expect(state.sessions.find((s) => s.id === created.sessionId)?.title).toBe('修复登录页')

    const renamed = await fetch(`${base}/api/sessions/${created.sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ' renamed title ' }),
    })
    expect(renamed.status).toBe(200)
    state = await (await fetch(`${base}/api/state`)).json() as { sessions: Array<{ id: string; title: string }> }
    expect(state.sessions.find((s) => s.id === created.sessionId)?.title).toBe('renamed title')

    const empty = await fetch(`${base}/api/sessions/${created.sessionId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: ' ' }),
    })
    expect(empty.status).toBe(400)
    const missing = await fetch(`${base}/api/sessions/nope-123`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    })
    expect(missing.status).toBe(404)
  })

  it('rejects a newline in a session title', async () => {
    const { base } = await boot([text('ok')])
    expect((await post(`${base}/api/sessions`, { title: 'bad\ntitle' })).status).toBe(400)
  })

  it('exposes registered upstream providers in state', async () => {
    const { base } = await boot([text('ok')])
    const state = await (await fetch(`${base}/api/state`)).json() as { providers: Array<{ id: string; format: string; baseURL?: string }> }
    expect(state.providers.length).toBeGreaterThanOrEqual(1)
    const row = state.providers.find((p) => p.id === 'default')
    expect(row?.format).toBe('chat-completions')
    expect(row?.baseURL).toBeDefined()
  })

  it('pulls an upstream model list over loopback', async () => {
    const { base } = await boot([text('ok')])
    const server = http.createServer((req, res) => {
      expect(req.url).toBe('/models')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4o' }] }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      const result = await (await post(`${base}/api/models/upstream`, { baseURL: `http://127.0.0.1:${port}` })).json() as { models: string[] }
      expect(result.models).toEqual(['gpt-4o', 'gpt-4o-mini'])
    } finally {
      server.close()
    }
  })

  it('rejects non-loopback HTTP and invalid upstream list payloads', async () => {
    const { base } = await boot([text('ok')])
    expect((await post(`${base}/api/models/upstream`, { baseURL: 'http://example.com/v1' })).status).toBe(400)
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ unexpected: true }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      expect((await post(`${base}/api/models/upstream`, { baseURL: `http://127.0.0.1:${port}` })).status).toBe(400)
    } finally {
      server.close()
    }
  })
})

describe('web server — update checks', () => {
  const post = (url: string) => fetch(url, { method: 'POST' })

  /** Local fake release feed; tagSequence is served one entry per request. */
  async function feed(tags: string[]): Promise<{ url: string; requests: number; close(): Promise<void> }> {
    const requests = { count: 0 }
    const server = http.createServer((req, res) => {
      requests.count += 1
      const tag = tags[Math.min(requests.count - 1, tags.length - 1)] ?? tags.at(-1) ?? ''
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: tag, html_url: `https://example.com/releases/${tag}` }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return {
      url: `http://127.0.0.1:${port}/releases/latest`,
      get requests() { return requests.count },
      async close() {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  it('reports the latest release and an available update', async () => {
    const release = await feed(['v99.0.0'])
    cleanups.push(async () => { await release.close() })
    const { handle, base } = await boot([text('ok')], 'yolo', { updatesBaseUrl: release.url, updatesAutoCheck: false })
    const info = await (await post(`${base}/api/updates/check`)).json() as {
      current: string; latest: string; hasUpdate: boolean; releaseUrl: string
    }
    expect(info.current).toBe(pkg.version)
    expect(info).toMatchObject({ latest: '99.0.0', hasUpdate: true, releaseUrl: 'https://github.com/Guyao146/SakuraCode/releases/tag/v99.0.0' })
    // The cached result is mirrored into the state snapshot so reloads keep the badge.
    const state = await (await fetch(`${base}/api/state`)).json() as { update?: { latest?: string } }
    expect(state.update).toMatchObject({ latest: '99.0.0', hasUpdate: true })
    expect(handle.url).toBeTruthy()
  })

  it('reports "already up to date" for an equal version', async () => {
    const release = await feed([`v${pkg.version}`])
    cleanups.push(async () => { await release.close() })
    const { base } = await boot([text('ok')], 'yolo', { updatesBaseUrl: release.url, updatesAutoCheck: false })
    const info = await (await post(`${base}/api/updates/check`)).json() as { hasUpdate: boolean; latest: string }
    expect(info).toMatchObject({ latest: pkg.version, hasUpdate: false })
  })

  it('rejects prerelease feeds and reports older stable releases as no update', async () => {
    const release = await feed(['v0.7.0-rc1', 'v0.6.2'])
    cleanups.push(async () => { await release.close() })
    const { base } = await boot([text('ok')], 'yolo', { updatesBaseUrl: release.url, updatesAutoCheck: false })
    const first = await (await post(`${base}/api/updates/check`)).json() as { hasUpdate: boolean; error?: string }
    expect(first.hasUpdate).toBe(false)
    expect(first.error).toBeTruthy()
    const second = await (await post(`${base}/api/updates/check`)).json() as { hasUpdate: boolean }
    expect(second.hasUpdate).toBe(false)
  })

  it('keeps serving when the release feed is unreachable and reports the error', async () => {
    // Port 1 is reserved and never accepts connections on loopback.
    const { base } = await boot([text('ok')], 'yolo', {
      updatesBaseUrl: 'http://127.0.0.1:1/releases/latest', updatesAutoCheck: false,
    })
    const response = await post(`${base}/api/updates/check`)
    expect(response.status).toBe(200)
    const info = await response.json() as { hasUpdate: boolean; error?: string }
    expect(info.hasUpdate).toBe(false)
    expect(info.error).toBeTruthy()
    // The failure is cached in state, not fatal to the rest of the API.
    const state = await (await fetch(`${base}/api/state`)).json() as { update?: { error?: string } }
    expect(state.update?.error).toBeTruthy()
  })

  it('notifies SSE clients once per release from the background check', async () => {
    const release = await feed(['v99.0.0'])
    cleanups.push(async () => { await release.close() })
    const { base } = await boot([text('ok')], 'yolo', {
      updatesBaseUrl: release.url, updatesAutoCheck: true, updatesInitialDelayMs: 100,
    })
    const sse = sseCollect(base)
    cleanups.push(async () => { await sse.stop() })
    await vi.waitFor(() => {
      expect(sse.frames.filter((f) => f.type === 'update' && f.notify === true)).toHaveLength(1)
    }, { timeout: 5_000 })
    await post(`${base}/api/updates/check`)
    await vi.waitFor(() => expect(sse.frames.filter((f) => f.type === 'update')).toHaveLength(2))
    expect(sse.frames.filter((f) => f.type === 'update' && f.notify === true)).toHaveLength(1)
    expect(sse.frames.filter((f) => f.type === 'notice' && String(f.message).includes('发现新版本'))).toHaveLength(0)
    expect(release.requests).toBe(2)
  })
})

describe('web server — collaborative expert session', () => {
  const post = (url: string, body?: unknown) => fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })

  it('spawns the expert team, delivers the opening task and fans out later messages', async () => {
    const received: string[] = []
    const adapter = new MockAdapter([(req) => {
      received.push(String(req.messages.at(-1)?.content ?? ''))
      return text('expert reply')
    }])
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-experts-'))
    const handle = await runWebServer({ cwd: tmpDir, sessionDir: 'sessions', jobsDir: 'jobs', adapter, approvalMode: 'yolo', quiet: true, open: false })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    })
    try {
      const started = await (await post(handle.url + 'api/experts/start', { task: '重构登录模块' })).json() as { expertMode: boolean; started: string[] }
      expect(started.expertMode).toBe(true)
      expect(started.started).toEqual(['架构师', '实现者', '审查者'])
      const state = await (await fetch(handle.url + 'api/state')).json() as {
        expertMode: boolean
        agents: Array<{ name: string; expert?: string; description?: string }>
      }
      expect(state.expertMode).toBe(true)
      expect(state.agents.map((a) => a.name).sort()).toEqual(['main', '实现者', '架构师', '审查者'].sort())
      // Experts carry their preset key and role description for the roster badge.
      const architect = state.agents.find((a) => a.name === '架构师')
      expect(architect?.expert).toBe('architect')
      expect(architect?.description).toContain('方案分解')
      // The opening task is recorded by main and all three experts.
      await vi.waitFor(() => expect(received.filter((m) => m === '重构登录模块').length).toBe(4), { timeout: 10_000 })
      // A user message reaches main + all three experts (4 requests).
      await post(handle.url + 'api/message', { text: '补充测试用例' })
      await vi.waitFor(() => expect(received.filter((m) => m === '补充测试用例').length).toBe(4), { timeout: 10_000 })
      expect(received).toHaveLength(8)
    } catch (error) {
      throw error
    }
  })

  it('stop ends the fan-out but keeps the experts on the roster', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-experts-stop-'))
    const handle = await runWebServer({ cwd: tmpDir, sessionDir: 'sessions', jobsDir: 'jobs', adapter: new MockAdapter([text('ok')]), approvalMode: 'yolo', quiet: true, open: false })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    })
    await (await post(handle.url + 'api/experts/start')).json()
    const stateAfter = await (await fetch(handle.url + 'api/state')).json() as { expertMode: boolean; agents: Array<{ name: string }> }
    expect(stateAfter.expertMode).toBe(true)
    const stopped = await (await post(handle.url + 'api/experts/stop')).json() as { ok: boolean; stopped: boolean }
    expect(stopped).toEqual({ ok: true, stopped: true })
    const state = await (await fetch(handle.url + 'api/state')).json() as { expertMode: boolean; agents: Array<{ name: string }> }
    expect(state.expertMode).toBe(false)
    expect(state.agents.map((a) => a.name)).toContain('架构师')
    // stop is idempotent: a second call reports nothing to stop.
    const again = await (await post(handle.url + 'api/experts/stop')).json() as { stopped: boolean }
    expect(again.stopped).toBe(false)
  })

  it('rejects unknown expert keys and an empty task', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-experts-bad-'))
    const handle = await runWebServer({ cwd: tmpDir, sessionDir: 'sessions', jobsDir: 'jobs', adapter: new MockAdapter([text('ok')]), approvalMode: 'yolo', quiet: true, open: false })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    })
    expect((await post(handle.url + 'api/experts/start', { experts: ['ghost'] })).status).toBe(400)
    expect((await post(handle.url + 'api/experts/start', { task: '   ' })).status).toBe(400)
    // A single valid subset starts only that member.
    const started = await (await post(handle.url + 'api/experts/start', { experts: ['reviewer'] })).json() as { started: string[] }
    expect(started.started).toEqual(['审查者'])
  })

  it('exposes mounted skills in the state snapshot', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-experts-skills-'))
    await fs.mkdir(path.join(tmpDir, '.sakura', 'skills', 'bug-hunt'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, '.sakura', 'skills', 'bug-hunt', 'SKILL.md'), '---\nname: bug-hunt\ndescription: 定位 bug\nwhenToUse: 修 bug 时\n---\n按步骤定位问题。\n')
    const handle = await runWebServer({ cwd: tmpDir, sessionDir: 'sessions', jobsDir: 'jobs', adapter: new MockAdapter([text('ok')]), approvalMode: 'yolo', quiet: true, open: false })
    cleanups.push(async () => {
      await handle.close()
      await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    })
    const state = await (await fetch(handle.url + 'api/state')).json() as { skills: Array<{ name: string; description: string; whenToUse: string; source: string }> }
    expect(state.skills).toContainEqual({ name: 'bug-hunt', description: '定位 bug', whenToUse: '修 bug 时', source: 'project' })
    // Detail endpoint exposes the full SKILL.md body (read-only).
    const detail = await (await fetch(handle.url + 'api/skills/bug-hunt')).json() as { name: string; body: string; source: string }
    expect(detail).toMatchObject({ name: 'bug-hunt', source: 'project' })
    expect(detail.body).toContain('按步骤定位问题。')
    expect((await fetch(handle.url + 'api/skills/nope')).status).toBe(404)
  })
})
