import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHarness, type Harness } from '../src/harness.js'
import { WorkspaceMemoryStore, WORKSPACE_MEMORY_MAX_CHARS, type WorkspaceMemoryService } from '../src/plugins/workspace-memory.js'
import { MockAdapter, text, toolCall } from './helpers.js'
import type { LLMRequest } from '../src/core/types.js'

const dirs: string[] = []
const harnesses: Harness[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (harnesses.length) harnesses.pop()?.dispose()
  while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
})
async function workspace(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-workspace-memory-'))
  dirs.push(cwd)
  return cwd
}
async function boot(cwd: string, options: Partial<Parameters<typeof createHarness>[0]> = {}): Promise<Harness> {
  const harness = await createHarness({ cwd, renderer: false, adapter: new MockAdapter([text('ok')]), ...options })
  harnesses.push(harness)
  return harness
}

describe('workspace memory store', () => {
  it('defaults on without creating files and keeps enabled/content across store restarts', async () => {
    const cwd = await workspace()
    const store = new WorkspaceMemoryStore(cwd)
    expect(await store.reload()).toMatchObject({ enabled: true, content: '', revision: 0 })
    expect(await fs.readdir(cwd)).toEqual([])
    expect(store.render()).toContain('No saved notes yet')
    const saved = await store.update({ enabled: true, content: '优先使用中文\r\n运行 npm test' }, 0)
    expect(saved).toMatchObject({ enabled: true, content: '优先使用中文\n运行 npm test', revision: 1 })
    expect(store.render()).toContain('优先使用中文')
    store.dispose()
    const reopened = new WorkspaceMemoryStore(cwd)
    expect(await reopened.reload()).toMatchObject({ ...saved })
    expect(await fs.readdir(path.join(cwd, '.sakura'))).toEqual(['workspace-memory.md'])
    await reopened.update({ enabled: false }, 1)
    expect(reopened.render()).toBe('')
    expect(reopened.snapshot().content).toBe(saved.content)
    await reopened.update({ enabled: true }, 2)
    expect(reopened.render()).toContain('运行 npm test')
  })

  it('isolates siblings and nested workspaces instead of scanning parent memory', async () => {
    const cwd = await workspace()
    const other = path.join(cwd, 'child')
    await fs.mkdir(other)
    const first = new WorkspaceMemoryStore(cwd)
    await first.update({ enabled: true, content: 'ONLY_PARENT' }, 0)
    const second = new WorkspaceMemoryStore(other)
    expect(await second.reload()).toMatchObject({ enabled: true, content: '' })
    await second.update({ enabled: true, content: 'ONLY_CHILD' }, 0)
    expect(first.render()).not.toContain('ONLY_CHILD')
    expect(second.render()).not.toContain('ONLY_PARENT')
  })

  it('rejects stale and concurrent revisions without losing notes', async () => {
    const cwd = await workspace()
    const first = new WorkspaceMemoryStore(cwd)
    await first.update({ enabled: true, content: 'initial' }, 0)
    const results = await Promise.allSettled([
      first.update({ content: 'first writer' }, 1),
      first.update({ content: 'second writer' }, 1),
    ])
    expect(results[0].status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'ECONFLICT' } })
    const second = new WorkspaceMemoryStore(cwd)
    await expect(second.update({ content: 'stale other process' }, 1)).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect(second.snapshot().content).toBe('first writer')
    const race = await Promise.allSettled([first.update({ content: 'race-a' }, 2), second.update({ content: 'race-b' }, 2)])
    expect(race.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect((await first.reload()).revision).toBe(3)
    expect(await fs.readdir(path.join(cwd, '.sakura'))).toEqual(['workspace-memory.md'])
  })

  it('validates content and revision and refuses disabled tool writes', async () => {
    const store = new WorkspaceMemoryStore(await workspace())
    for (const [patch, revision] of [
      [{ content: 'x'.repeat(WORKSPACE_MEMORY_MAX_CHARS + 1) }, 0],
      [{ content: 'has\0control' }, 0],
      [{ enabled: 'yes' }, 0],
      [{ content: 'valid' }, -1],
      [{ content: 'valid' }, 1.2],
    ] as const) await expect(store.update(patch as { content?: string; enabled?: boolean }, revision)).rejects.toMatchObject({ code: 'EINVAL' })
    await store.update({ enabled: false }, 0)
    await expect(store.update({ content: 'automatic' }, 1, { requireEnabled: true })).rejects.toMatchObject({ code: 'EDISABLED' })
    expect(store.snapshot().content).toBe('')
  })

  it('rejects an active interprocess lock and only reclaims a lock left by an exited owner', async () => {
    const cwd = await workspace()
    const store = new WorkspaceMemoryStore(cwd)
    const lock = path.join(cwd, '.sakura', 'workspace-memory.lock')
    await fs.mkdir(path.dirname(lock))
    const active = `${process.pid}:active-other-agent`
    await fs.writeFile(lock, active)
    await expect(store.update({ enabled: true, content: 'must not overwrite' }, 0)).rejects.toMatchObject({ code: 'EBUSY' })
    expect(await fs.readFile(lock, 'utf8')).toBe(active)
    expect(store.snapshot().revision).toBe(0)
    await fs.unlink(lock)
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true })
    await once(child, 'exit')
    expect(child.pid).toBeTruthy()
    await fs.writeFile(lock, `${child.pid}:crashed-owner`)
    expect(await store.update({ enabled: true, content: 'recovered safely' }, 0)).toMatchObject({ content: 'recovered safely', revision: 1 })
    expect(await fs.readdir(path.dirname(lock))).toEqual(['workspace-memory.md'])
  })

  it('preserves the previous atomic file and removes temporary/lock files when replacement fails', async () => {
    const store = new WorkspaceMemoryStore(await workspace())
    await store.update({ enabled: true, content: 'durable previous content' }, 0)
    const previous = await fs.readFile(store.file, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('replacement denied'))
    await expect(store.update({ content: 'failed replacement' }, 1)).rejects.toMatchObject({ code: 'EIO' })
    expect(await fs.readFile(store.file, 'utf8')).toBe(previous)
    expect(await fs.readdir(path.dirname(store.file))).toEqual(['workspace-memory.md'])
    expect(await store.reload()).toMatchObject({ enabled: true, content: 'durable previous content', revision: 1 })
  })

  it('keeps corrupt/oversized/non-regular files untouched and fails closed', async () => {
    const cwd = await workspace()
    const store = new WorkspaceMemoryStore(cwd)
    await fs.mkdir(path.dirname(store.file))
    await fs.writeFile(store.file, 'not JSON')
    expect(await store.reload()).toMatchObject({ enabled: false, error: expect.stringContaining('元数据') })
    await expect(store.update({ enabled: true }, 0)).rejects.toMatchObject({ code: 'EIO' })
    expect(await fs.readFile(store.file, 'utf8')).toBe('not JSON')
    await fs.writeFile(store.file, 'x'.repeat(120_000))
    expect((await store.reload()).error).toBeTruthy()
    await fs.unlink(store.file)
    await fs.mkdir(store.file)
    expect((await store.reload()).error).toBeTruthy()
    await expect(store.update({ content: 'replace directory' }, 0)).rejects.toMatchObject({ code: 'EIO' })
    expect((await fs.stat(store.file)).isDirectory()).toBe(true)
  })

  it('refuses external directory junctions and memory symlinks', async () => {
    const cwd = await workspace()
    const outside = await workspace()
    const store = new WorkspaceMemoryStore(cwd)
    await fs.writeFile(path.join(outside, 'workspace-memory.json'), 'EXTERNAL_MUST_SURVIVE')
    await fs.symlink(outside, path.join(cwd, '.sakura'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await store.reload()).error).toBeTruthy()
    await expect(store.update({ enabled: true }, 0)).rejects.toMatchObject({ code: 'EIO' })
    expect(await fs.readFile(path.join(outside, 'workspace-memory.json'), 'utf8')).toBe('EXTERNAL_MUST_SURVIVE')
    await fs.rm(path.join(cwd, '.sakura'), { recursive: true })
    await fs.mkdir(path.join(cwd, '.sakura'))
    try { await fs.symlink(path.join(outside, 'workspace-memory.json'), store.file, 'file') }
    catch (error) {
      // File symlinks require Windows Developer Mode; junction protection above is unconditional.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      return
    }
    await expect(store.update({ content: 'overwrite external' }, 0)).rejects.toMatchObject({ code: 'EIO' })
    expect(await fs.readFile(path.join(outside, 'workspace-memory.json'), 'utf8')).toBe('EXTERNAL_MUST_SURVIVE')
  })

  it('honors cancellation and disposal without writing or recreating the workspace', async () => {
    const cwd = await workspace()
    const store = new WorkspaceMemoryStore(cwd)
    const signal = AbortSignal.abort()
    await expect(store.update({ enabled: true }, 0, { signal })).rejects.toThrow()
    const pending = store.update({ enabled: true }, 0)
    store.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'ECLOSED' })
    expect(await fs.readdir(cwd)).toEqual([])
  })
})

describe('workspace memory harness integration', () => {
  it('injects opt-in notes into logged prompts for main and collaboration agents, never when off', async () => {
    const cwd = await workspace()
    const requests: LLMRequest[] = []
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_RULES_ALWAYS_ON')
    const harness = await boot(cwd, { adapter: new MockAdapter([req => { requests.push(req); return text('ok') }]) })
    const memory = harness.ctx.get<WorkspaceMemoryService>('workspaceMemory')
    await memory.update({ enabled: false }, 0)
    await harness.run('without memory')
    expect(String(requests[0]?.messages[0]?.content)).toContain('PROJECT_RULES_ALWAYS_ON')
    expect(requests[0]?.tools?.map(tool => tool.name)).not.toContain('memory_read')
    await memory.update({ enabled: true, content: 'DURABLE_ONLY_THIS_WORKSPACE' }, memory.snapshot().revision)
    await harness.run('with memory')
    const child = harness.ctx.agents.spawn({ name: 'collaborator', seed: '', autoStart: false, persistentSession: true, meta: { role: 'sub' } })
    await child.turn('shared workspace facts')
    for (const request of requests.slice(1)) {
      expect(String(request.messages[0]?.content)).toContain('DURABLE_ONLY_THIS_WORKSPACE')
      expect(request.tools?.map(tool => tool.name)).toContain('memory_write')
    }
    const session = await harness.ctx.sessions.open(harness.main().sessionId)
    expect(session.events.filter(event => event.type === 'system/message').at(-1)?.payload).toMatchObject({ content: expect.stringContaining('DURABLE_ONLY_THIS_WORKSPACE') })
    await memory.update({ enabled: false }, memory.snapshot().revision)
    await harness.run('disable in same session')
    expect(String(requests.at(-1)?.messages[0]?.content)).not.toContain('DURABLE_ONLY_THIS_WORKSPACE')
    expect(String(requests.at(-1)?.messages[0]?.content)).toContain('PROJECT_RULES_ALWAYS_ON')
    expect(memory.snapshot().content).toBe('DURABLE_ONLY_THIS_WORKSPACE')
  })

  it('allows the model to persist confirmed facts through the usual approved write tool', async () => {
    const cwd = await workspace()
    const initial = new WorkspaceMemoryStore(cwd)
    await initial.update({ enabled: true, content: '' }, 0)
    const harness = await boot(cwd, { approvalMode: 'default', confirmHandler: () => true,
      adapter: new MockAdapter([toolCall('memory_write', JSON.stringify({ revision: 1, content: 'CONFIRMED_PROJECT_FACT' })), text('saved')]) })
    expect((await harness.run('remember the verified project fact')).output).toBe('saved')
    expect((await new WorkspaceMemoryStore(cwd).reload()).content).toBe('CONFIRMED_PROJECT_FACT')
    harness.dispose()
    const restarted = await boot(cwd)
    expect(restarted.ctx.systemPrompt.assemble()).toContain('CONFIRMED_PROJECT_FACT')
  })

  it('respects plan/default write approval and refuses writes after disabling', async () => {
    const cwd = await workspace()
    const harness = await boot(cwd, { approvalMode: 'default' })
    const memory = harness.ctx.get<WorkspaceMemoryService>('workspaceMemory')
    await memory.update({ enabled: true, content: 'keep' }, 0)
    const call = () => harness.ctx.tools.execute('memory-test', 'memory_write', JSON.stringify({ content: 'forbidden', revision: 1 }),
      { agentId: 'a', sessionId: 's', signal: new AbortController().signal })
    expect((await call()).isError).toBe(true)
    harness.ctx.approval.setMode('plan')
    expect((await call()).output).toContain('plan mode')
    await memory.update({ enabled: false }, 1)
    harness.ctx.approval.setMode('yolo')
    expect((await call()).output).toContain('disabled')
    expect(memory.snapshot().content).toBe('keep')
  })
})