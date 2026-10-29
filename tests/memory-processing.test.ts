import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tmpHarness, text, MockAdapter } from './helpers.js'
import { WorkspaceMemoryStore, type WorkspaceMemoryService } from '../src/plugins/workspace-memory.js'
import type { MemoryProcessingService } from '../src/plugins/memory-processing.js'
import type { LLMRequest } from '../src/core/types.js'

describe('durable Markdown memory processing', () => {
  it('defaults on and preserves explicitly disabled legacy JSON without overwriting it', async () => {
    const { tmpDir } = await tmpHarness()
    const dir = path.join(tmpDir, '.sakura'), file = path.join(dir, 'workspace-memory.json')
    await fs.mkdir(dir, { recursive: true })
    const legacy = JSON.stringify({ version: 1, enabled: false, content: 'OLD_NOTES', revision: 1, updatedAt: new Date().toISOString() })
    await fs.writeFile(file, legacy)
    const store = new WorkspaceMemoryStore(tmpDir)
    expect(await store.reload()).toMatchObject({ enabled: false, content: 'OLD_NOTES', revision: 1 })
    await store.update({ enabled: true }, 1)
    expect(await fs.readFile(file, 'utf8')).toBe(legacy)
    expect(await fs.readFile(store.file, 'utf8')).toContain('OLD_NOTES')
    expect(await new WorkspaceMemoryStore(tmpDir).reload()).toMatchObject({ enabled: true, content: 'OLD_NOTES', revision: 2 })
  })

  it('collects only completed conversation text and excludes sensitive, thought, system and tool content', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [text('verified reusable answer')] })
    await harness.run('remember preference apiKey=VERY_SECRET_VALUE @[skill:ref]')
    const snapshot = await ctx.get<WorkspaceMemoryService>('workspaceMemory').reload()
    expect(snapshot.pendingContent).toContain('verified reusable answer')
    expect(snapshot.pendingContent).not.toContain('VERY_SECRET_VALUE')
    expect(snapshot.pendingContent).not.toContain('# Workspace memory')
    expect(snapshot.content).toBe('')
    expect(ctx.systemPrompt.assemble()).not.toContain('verified reusable answer')
  })

  it('consolidates pending data once at the size trigger, preserves existing notes and records processing metadata', async () => {
    const requests: LLMRequest[] = []
    const { ctx } = await tmpHarness({ adapter: new MockAdapter([request => { requests.push(request); return text('# 长期记忆\n- 已确认偏好：中文\n- 测试命令：npm test') }]) })
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory'), processor = ctx.get<MemoryProcessingService>('memoryProcessing')
    await memory.update({ content: 'EXISTING_NOTES', processing: { auto: true, thresholdChars: 1000, intervalMs: 0 } }, 0)
    await memory.appendPending('CONFIRMED_DATA '.repeat(100))
    await Promise.all([processor.maybeProcess(), processor.maybeProcess()])
    const snapshot = await memory.reload()
    expect(snapshot.pendingContent).toBe('')
    expect(snapshot.content).toContain('中文')
    expect(snapshot.lastProcessedAt).toEqual(expect.any(String))
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]?.messages)).toContain('EXISTING_NOTES')
    expect(requests[0]?.tools).toBeUndefined()
    expect(processor.status().active).toBe(false)
  })

  it('uses a waiting-time trigger and does not process while disabled or automatic processing is off', async () => {
    const { ctx } = await tmpHarness({ steps: [text('time summary')] })
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory'), processor = ctx.get<MemoryProcessingService>('memoryProcessing')
    await memory.update({ processing: { auto: true, thresholdChars: 0, intervalMs: 60000 } }, 0)
    await memory.appendPending('a stable fact')
    const now = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000)
    try { await processor.maybeProcess() } finally { clock.mockRestore() }
    expect((await memory.reload()).content).toBe('time summary')
    await memory.update({ enabled: false }, memory.snapshot().revision)
    await expect(memory.appendPending('no')).rejects.toMatchObject({ code: 'EDISABLED' })
    await processor.maybeProcess()
  })

  it('retains both pending and durable text on failed summaries and rejects stale concurrent writes', async () => {
    const { ctx } = await tmpHarness({ steps: [[{ type: 'error', error: 'fatal summary failure' }]] })
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory'), processor = ctx.get<MemoryProcessingService>('memoryProcessing')
    await memory.update({ content: 'KEEP_NOTES' }, 0)
    await memory.appendPending('KEEP_PENDING')
    const before = memory.snapshot()
    await expect(processor.process({ manual: true })).rejects.toThrow('fatal summary failure')
    expect(memory.snapshot()).toMatchObject({ content: before.content, pendingContent: before.pendingContent, processingPaused: true })
    expect(processor.status().paused).toBe(true)
    const attempts = vi.fn(); ctx.on('llm/stream', (payload, next) => { attempts(); return next(payload) })
    await processor.maybeProcess(); expect(attempts).not.toHaveBeenCalled()
    const other = new WorkspaceMemoryStore(path.dirname(path.dirname(before.path)))
    const paused = await other.reload(); await other.update({ content: 'NEWER_NOTES' }, paused.revision)
    await expect(memory.processed('STALE', before.revision)).rejects.toMatchObject({ code: 'ECONFLICT' })
    expect((await memory.reload()).content).toBe('NEWER_NOTES')
    expect(memory.snapshot().pendingContent).toBe('KEEP_PENDING')
  })

  it('never bypasses revision checks when given an undefined version', async () => {
    const { ctx } = await tmpHarness()
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory')
    await expect(memory.update({ content: 'INVALID' }, undefined as unknown as number)).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(memory.processed('INVALID', undefined as unknown as number)).rejects.toMatchObject({ code: 'EINVAL' })
    expect(memory.snapshot().content).toBe('')
  })

  it('preserves the automatic failure pause across restart and detects manual Markdown edits with fingerprints', async () => {
    const { ctx, tmpDir } = await tmpHarness()
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory')
    await memory.update({ content: 'ORIGINAL' }, 0)
    const snapshot = memory.snapshot()
    const file = await fs.readFile(snapshot.path, 'utf8')
    await fs.writeFile(snapshot.path, file.replace('ORIGINAL', 'EXTERNAL'))
    const fresh = new WorkspaceMemoryStore(tmpDir)
    await expect(fresh.update({ content: 'stale' }, snapshot.revision, { fingerprint: snapshot.fingerprint })).rejects.toMatchObject({ code: 'ECONFLICT' })
    await fresh.processingFailed('manual confirmation required')
    expect(await new WorkspaceMemoryStore(tmpDir).reload()).toMatchObject({ content: 'EXTERNAL', processingPaused: true, processingError: 'manual confirmation required' })
  })

  it('supports partial batches without discarding pending overflow and confirmed clearing removes both layers', async () => {
    const { ctx } = await tmpHarness()
    const memory = ctx.get<WorkspaceMemoryService>('workspaceMemory')
    await memory.appendPending('FIRST\nSECOND')
    await memory.processed('summary for first', memory.snapshot().revision, undefined, 6)
    expect(memory.snapshot().pendingContent).toBe('SECOND')
    await memory.update({ content: '', clearPending: true }, memory.snapshot().revision)
    expect(memory.snapshot()).toMatchObject({ content: '', pendingContent: '', pendingSince: null })
  })
})