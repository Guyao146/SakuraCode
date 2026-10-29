/** Work-count regressions, not machine-dependent timing thresholds. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); while (cleanups.length) await cleanups.pop()?.() })

async function boot() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-startup-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  const handle = await runWebServer({ cwd, adapter: new MockAdapter([text('done')]), token: null, viewerToken: null,
    open: false, quiet: true, updatesAutoCheck: false })
  cleanups.push(() => handle.close())
  return handle
}

describe('startup and event-state work', () => {
  it('does not scan session logs for unobserved status events; the next REST read remains fresh', async () => {
    const handle = await boot()
    await (await fetch(handle.url + 'api/state')).json()
    const list = vi.spyOn(handle.harness.ctx.sessions, 'list')
    for (let n = 0; n < 24; n++) handle.harness.ctx.emit('agent/status', { agentId: 'probe', status: 'idle' })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(list).not.toHaveBeenCalled()
    const session = await handle.harness.ctx.sessions.create({ title: 'fresh history' })
    const state = await (await fetch(handle.url + 'api/state')).json() as { sessions: Array<{ id: string; title: string }> }
    expect(list).toHaveBeenCalledOnce()
    expect(state.sessions).toContainEqual(expect.objectContaining({ id: session.id, title: 'fresh history' }))
  })

  it('coalesces a burst of status events into one revision-checked SSE snapshot', async () => {
    const handle = await boot()
    await (await fetch(handle.url + 'api/state')).json()
    const controller = new AbortController()
    const response = await fetch(handle.url + 'api/events', { signal: controller.signal })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    const frames: Array<{ type: string; revision: number; state?: { revision: number } }> = []
    let buffer = ''
    const collecting = (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, newline); buffer = buffer.slice(newline + 2)
          const line = frame.split('\n').find(row => row.startsWith('data: '))
          if (line) frames.push(JSON.parse(line.slice(6)))
        }
      }
    })()
    let release = () => {}
    try {
      await vi.waitFor(() => expect(frames.some(frame => frame.type === 'state')).toBe(true))
      const originalList = handle.harness.ctx.sessions.list.bind(handle.harness.ctx.sessions)
      let entered!: () => void
      const gate = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
      let first = true
      const list = vi.spyOn(handle.harness.ctx.sessions, 'list').mockImplementation(async (...args) => {
        if (first) { first = false; entered(); await gate }
        return originalList(...args)
      })
      const before = frames.filter(frame => frame.type === 'state').length
      for (let n = 0; n < 24; n++) handle.harness.ctx.emit('agent/status', { agentId: 'probe', status: 'idle' })
      try { await reading } finally { release() }
      await vi.waitFor(() => expect(frames.filter(frame => frame.type === 'state')).toHaveLength(before + 1))
      expect(list).toHaveBeenCalledOnce()
      const state = frames.filter(frame => frame.type === 'state').at(-1)!
      expect(state.state?.revision).toBe(frames.filter(frame => frame.type === 'agent/status').at(-1)!.revision)
    } finally {
      release()
      controller.abort()
      await collecting.catch(() => {})
      reader.releaseLock()
    }
  })

  it('eventually publishes the last state after the snapshot retry budget is exhausted, without another event', async () => {
    const handle = await boot()
    await (await fetch(handle.url + 'api/state')).json()
    const controller = new AbortController()
    const response = await fetch(handle.url + 'api/events', { signal: controller.signal })
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    const states: Array<{ revision: number; sessions: Array<{ id: string }> }> = []
    let buffer = ''
    const collecting = (async () => {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n\n')) >= 0) {
          const line = buffer.slice(0, newline).split('\n').find(row => row.startsWith('data: '))
          buffer = buffer.slice(newline + 2)
          if (line) { const frame = JSON.parse(line.slice(6)); if (frame.type === 'state') states.push(frame.state) }
        }
      }
    })()
    try {
      await vi.waitFor(() => expect(states).toHaveLength(1))
      const history = await handle.harness.ctx.sessions.create({ title: 'must reach the last snapshot' })
      const originalList = handle.harness.ctx.sessions.list.bind(handle.harness.ctx.sessions)
      let reads = 0
      vi.spyOn(handle.harness.ctx.sessions, 'list').mockImplementation(async (...args) => {
        const rows = await originalList(...args)
        // Five changing revisions exhaust one stateSnapshot() pass. None of
        // these text events schedules another refresh; the pending work must.
        if (++reads <= 5) handle.harness.ctx.emit('ui/text', { main: true, delta: 'synthetic snapshot churn' })
        return rows
      })
      handle.harness.ctx.emit('agent/status', { id: 'probe', status: 'idle' })
      await vi.waitFor(() => expect(states.at(-1)?.sessions.some(row => row.id === history.id)).toBe(true))
      expect(reads).toBeGreaterThan(5)
    } finally {
      controller.abort(); await collecting.catch(() => {}); reader.releaseLock()
    }
  })
})