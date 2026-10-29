/** Workspace-local Markdown memory. Existing JSON notes are read without destroying the legacy file. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { PluginModule } from '../kernel/index.js'
import type { SystemPromptService } from '../core/system-prompt.js'
import { activeMemoryContent, memoryEntrySpans, preserveDisabledMemory, type MemoryEntry, type MemoryEntryOperation } from './memory-entries.js'

export const WORKSPACE_MEMORY_MAX_CHARS = 16_000
export const WORKSPACE_MEMORY_PENDING_MAX_CHARS = 128_000
const MAX_FILE_BYTES = (WORKSPACE_MEMORY_MAX_CHARS + WORKSPACE_MEMORY_PENDING_MAX_CHARS) * 6 + 8192
const PENDING_MARKER = '\n\n<!-- sakura-memory-pending -->\n'

export interface MemoryProcessingPolicy { auto: boolean; thresholdChars: number; intervalMs: number }
export const DEFAULT_MEMORY_PROCESSING: Readonly<MemoryProcessingPolicy> = Object.freeze({ auto: true, thresholdChars: 8_000, intervalMs: 30 * 60_000 })

export function validateMemoryProcessing(value: unknown): MemoryProcessingPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkspaceMemoryError('EINVAL', '记忆整理策略必须是对象。')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['auto', 'thresholdChars', 'intervalMs'].includes(key)) || typeof row.auto !== 'boolean' ||
    !Number.isSafeInteger(row.thresholdChars) || Number(row.thresholdChars) < 0 || Number(row.thresholdChars) > 64_000 ||
    (Number(row.thresholdChars) > 0 && Number(row.thresholdChars) < 1_000) ||
    !Number.isSafeInteger(row.intervalMs) || Number(row.intervalMs) < 0 || Number(row.intervalMs) > 7 * 24 * 60 * 60_000 ||
    (Number(row.intervalMs) > 0 && Number(row.intervalMs) < 60_000)) {
    throw new WorkspaceMemoryError('EINVAL', '积累量为 0 或 1000–64000 字，等待时间为 0 或 1 分钟–7 天；0 关闭对应触发。')
  }
  return { auto: row.auto, thresholdChars: Number(row.thresholdChars), intervalMs: Number(row.intervalMs) }
}

export interface WorkspaceMemoryPatch { enabled?: boolean; content?: string; processing?: MemoryProcessingPolicy; clearPending?: boolean; entry?: MemoryEntryOperation }
export interface MemoryWriteOptions { requireEnabled?: boolean; signal?: AbortSignal; fingerprint?: string }

export interface WorkspaceMemoryState {
  enabled: boolean
  content: string
  revision: number
  updatedAt: string | null
  pendingContent: string
  pendingSince: string | null
  lastProcessedAt: string | null
  processing: MemoryProcessingPolicy
  processingPaused: boolean
  processingError: string | null
  disabledEntries: string[]
}

export interface WorkspaceMemoryStatus {
  enabled: boolean
  chars: number
  revision: number
  updatedAt: string | null
  pendingChars: number
  pendingSince: string | null
  lastProcessedAt: string | null
  processing: MemoryProcessingPolicy
  processingPaused: boolean
  processingError: string | null
  error?: string
}

export interface WorkspaceMemorySnapshot extends WorkspaceMemoryState {
  path: string
  maxChars: number
  fingerprint: string
  error?: string
  entries: MemoryEntry[]
  pendingEntries: MemoryEntry[]
}

export class WorkspaceMemoryError extends Error {
  constructor(readonly code: 'EINVAL' | 'ECONFLICT' | 'EBUSY' | 'EDISABLED' | 'ECLOSED' | 'EIO', message: string) {
    super(message)
    this.name = 'WorkspaceMemoryError'
  }
}

export interface WorkspaceMemoryService {
  snapshot(): WorkspaceMemorySnapshot
  status(): WorkspaceMemoryStatus
  reload(): Promise<WorkspaceMemorySnapshot>
  update(patch: WorkspaceMemoryPatch, revision: number,
    options?: MemoryWriteOptions): Promise<WorkspaceMemorySnapshot>
  appendPending(content: string, signal?: AbortSignal): Promise<WorkspaceMemorySnapshot>
  processed(content: string, revision: number, signal?: AbortSignal, consumedChars?: number, fingerprint?: string): Promise<WorkspaceMemorySnapshot>
  processedEntry(content: string, id: string, revision: number, signal?: AbortSignal, fingerprint?: string): Promise<WorkspaceMemorySnapshot>
  processingFailed(error: string, signal?: AbortSignal): Promise<WorkspaceMemorySnapshot>
}

const emptyState = (): WorkspaceMemoryState => ({ enabled: true, content: '', revision: 0, updatedAt: null,
  pendingContent: '', pendingSince: null, lastProcessedAt: null, processing: { ...DEFAULT_MEMORY_PROCESSING }, processingPaused: false, processingError: null, disabledEntries: [] })

function stateSignature(state: WorkspaceMemoryState): string {
  return JSON.stringify([state.enabled, state.content, state.revision, state.updatedAt, state.pendingContent,
    state.pendingSince, state.lastProcessedAt, state.processing.auto, state.processing.thresholdChars, state.processing.intervalMs, state.processingPaused, state.processingError, state.disabledEntries])
}

function parseState(raw: string): WorkspaceMemoryState {
  let value: unknown
  try { value = JSON.parse(raw) } catch { throw new WorkspaceMemoryError('EIO', '工作区记忆文件损坏，请修复文件后重试；未覆盖已有内容。') }
  const row = value as Record<string, unknown> | null
  if (!row || Array.isArray(row) || row.version !== 1 || typeof row.enabled !== 'boolean' ||
    typeof row.content !== 'string' || row.content.length > WORKSPACE_MEMORY_MAX_CHARS ||
    /\0/.test(row.content) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 ||
    typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) {
    throw new WorkspaceMemoryError('EIO', '工作区记忆文件格式无效，请修复文件后重试；未覆盖已有内容。')
  }
  return { ...emptyState(), enabled: row.enabled, content: row.content, revision: Number(row.revision), updatedAt: row.updatedAt }
}

function markdown(state: WorkspaceMemoryState): string {
  const { content, pendingContent, ...metadata } = state
  return '---\n' + JSON.stringify({ version: 2, ...metadata }, null, 2) + '\n---\n' + content + PENDING_MARKER + pendingContent
}

function parseMarkdown(raw: string): WorkspaceMemoryState {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  if (!match) throw new WorkspaceMemoryError('EIO', 'Markdown 记忆缺少有效元数据，原文件未覆盖。')
  let row: Record<string, unknown>
  try { row = JSON.parse(match[1]!) as Record<string, unknown> } catch { throw new WorkspaceMemoryError('EIO', 'Markdown 记忆元数据损坏，原文件未覆盖。') }
  const text = raw.slice(match[0].length).replace(/\r\n?/g, '\n')
  const separator = text.lastIndexOf(PENDING_MARKER)
  const parts = [text.slice(0, separator), text.slice(separator + PENDING_MARKER.length)]
  if (!row || row.version !== 2 || typeof row.enabled !== 'boolean' || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 ||
    typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt)) || separator < 0 ||
    parts[0]!.length > WORKSPACE_MEMORY_MAX_CHARS || parts[1]!.length > WORKSPACE_MEMORY_PENDING_MAX_CHARS || text.includes('\0')) {
    throw new WorkspaceMemoryError('EIO', 'Markdown 记忆格式无效，原文件未覆盖。')
  }
  for (const key of ['pendingSince', 'lastProcessedAt']) if (row[key] !== null && (typeof row[key] !== 'string' || !Number.isFinite(Date.parse(row[key] as string)))) throw new WorkspaceMemoryError('EIO', '记忆时间元数据无效。')
  if ((row.processingPaused !== undefined && typeof row.processingPaused !== 'boolean') ||
    (row.processingError != null && (typeof row.processingError !== 'string' || row.processingError.length > 1000))) throw new WorkspaceMemoryError('EIO', '记忆整理状态无效。')
  if (row.disabledEntries !== undefined && (!Array.isArray(row.disabledEntries) || row.disabledEntries.length > 8192 || row.disabledEntries.some(id => typeof id !== 'string' || !/^[a-f0-9]{24}-\d+$/.test(id)))) {
    throw new WorkspaceMemoryError('EIO', '记忆条目的启用状态无效；未覆盖原文件。')
  }
  return { enabled: row.enabled, content: parts[0]!, pendingContent: parts[1]!, revision: Number(row.revision), updatedAt: row.updatedAt,
    pendingSince: row.pendingSince as string | null, lastProcessedAt: row.lastProcessedAt as string | null, processing: validateMemoryProcessing(row.processing),
    processingPaused: row.processingPaused === true, processingError: typeof row.processingError === 'string' ? row.processingError : null,
    disabledEntries: (row.disabledEntries ?? []) as string[] }
}

export class WorkspaceMemoryStore implements WorkspaceMemoryService {
  readonly file: string
  readonly legacyFile: string
  private readonly dir: string
  private readonly cwd: string
  private state = emptyState()
  private error?: string
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(cwd: string, private readonly changed: (status: WorkspaceMemoryStatus) => void = () => {}) {
    this.cwd = path.resolve(cwd)
    this.dir = path.join(this.cwd, '.sakura')
    this.file = path.join(this.dir, 'workspace-memory.md')
    this.legacyFile = path.join(this.dir, 'workspace-memory.json')
  }

  snapshot(): WorkspaceMemorySnapshot {
    return { ...this.state, disabledEntries: [...this.state.disabledEntries], processing: { ...this.state.processing }, enabled: !this.error && this.state.enabled, path: this.file,
      entries: memoryEntrySpans(this.state.content, 'longTerm', this.state.disabledEntries).map(({ start: _start, end: _end, ...entry }) => entry),
      pendingEntries: memoryEntrySpans(this.state.pendingContent, 'pending').map(({ start: _start, end: _end, ...entry }) => entry),
      fingerprint: createHash('sha256').update(stateSignature(this.state)).digest('hex'),
      maxChars: WORKSPACE_MEMORY_MAX_CHARS, ...(this.error ? { error: this.error } : {}) }
  }

  status(): WorkspaceMemoryStatus {
    const { enabled, content, revision, updatedAt, error, pendingContent, pendingSince, lastProcessedAt, processing, processingPaused, processingError } = this.snapshot()
    return { enabled, chars: content.length, revision, updatedAt, pendingChars: pendingContent.length, pendingSince, lastProcessedAt, processing, processingPaused, processingError, ...(error ? { error } : {}) }
  }

  dispose(): void { this.closed = true }

  private assertOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted()
    if (this.closed) throw new WorkspaceMemoryError('ECLOSED', '工作区记忆已关闭，请在当前工作区重试。')
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.catch(() => {})
    return result
  }

  /** Never follow a .sakura junction or a memory-file symlink into another workspace. */
  private async checkDirectory(create = false): Promise<boolean> {
    const workspace = await fs.stat(this.cwd)
    if (!workspace.isDirectory()) throw new WorkspaceMemoryError('EIO', '工作区目录不存在或不可读，不会自动重建目录。')
    let stat
    try { stat = await fs.lstat(this.dir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!create) return false
      await fs.mkdir(this.dir, { recursive: true })
      stat = await fs.lstat(this.dir)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new WorkspaceMemoryError('EIO', '记忆目录必须是工作区内的普通目录，不能是符号链接或联接。')
    }
    return true
  }

  private async readDisk(): Promise<WorkspaceMemoryState> {
    if (!await this.checkDirectory()) return emptyState()
    let stat
    let file = this.file
    try { stat = await fs.lstat(this.file) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      file = this.legacyFile
      try { stat = await fs.lstat(file) }
      catch (legacyError) { if ((legacyError as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw legacyError }
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      throw new WorkspaceMemoryError('EIO', '记忆文件必须是大小受限的普通文件，不能是符号链接。')
    }
    const raw = await fs.readFile(file, 'utf8')
    return file === this.file ? parseMarkdown(raw) : parseState(raw)
  }

  private accept(state: WorkspaceMemoryState, error?: string): void {
    const before = JSON.stringify(this.snapshot())
    this.state = state
    this.error = error
    if (!this.closed && before !== JSON.stringify(this.snapshot())) this.changed(this.status())
  }

  reload(): Promise<WorkspaceMemorySnapshot> {
    return this.enqueue(async () => {
      this.assertOpen()
      try {
        const state = await this.readDisk()
        this.assertOpen()
        this.accept(state)
      } catch (error) {
        this.assertOpen()
        this.accept(emptyState(), error instanceof WorkspaceMemoryError ? error.message : '无法读取工作区记忆，请检查文件权限；已停止使用记忆。')
      }
      return this.snapshot()
    })
  }

  /** A short-lived exclusive file lock also excludes writers in another local process. */
  private async lock(): Promise<() => Promise<void>> {
    const file = path.join(this.dir, 'workspace-memory.lock')
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle
      try { handle = await fs.open(file, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        // A launcher crash may leave a lock behind; only reclaim a dead owner's lock.
        const stat = await fs.lstat(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) {
          throw new WorkspaceMemoryError('EBUSY', '工作区记忆被锁定，请检查记忆锁文件。')
        }
        const raw = await fs.readFile(file, 'utf8')
        const pid = Number(raw.split(':')[0])
        let dead = false
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0) } catch (failure) { dead = (failure as NodeJS.ErrnoException).code === 'ESRCH' }
        }
        if (!dead || attempt || await fs.readFile(file, 'utf8') !== raw) {
          throw new WorkspaceMemoryError('EBUSY', '另一个进程正在保存工作区记忆，请刷新后重试。')
        }
        await fs.unlink(file)
        continue
      }
      const owner = `${process.pid}:${randomUUID()}`
      try { await handle.writeFile(owner, 'utf8') }
      catch (error) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error }
      return async () => {
        await handle.close().catch(() => {})
        if (await fs.readFile(file, 'utf8').catch(() => '') === owner) await fs.unlink(file).catch(() => {})
      }
    }
    throw new WorkspaceMemoryError('EBUSY', '工作区记忆正在保存，请刷新后重试。')
  }

  update(patch: WorkspaceMemoryPatch, revision: number,
    options?: MemoryWriteOptions): Promise<WorkspaceMemorySnapshot> {
    if (!Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new WorkspaceMemoryError('EINVAL', '保存记忆必须提供有效版本。'))
    return this.commit(patch, revision, options)
  }

  appendPending(content: string, signal?: AbortSignal): Promise<WorkspaceMemorySnapshot> {
    return this.commit({}, undefined, { requireEnabled: true, signal }, content)
  }

  processed(content: string, revision: number, signal?: AbortSignal, consumedChars?: number, fingerprint?: string): Promise<WorkspaceMemorySnapshot> {
    if (!Number.isSafeInteger(revision) || revision < 0 || consumedChars !== undefined && (!Number.isSafeInteger(consumedChars) || consumedChars < 0)) {
      return Promise.reject(new WorkspaceMemoryError('EINVAL', '记忆整理需要有效版本和积累量。'))
    }
    return this.commit({ content }, revision, { requireEnabled: true, signal, fingerprint }, undefined, true, consumedChars)
  }

  processedEntry(content: string, id: string, revision: number, signal?: AbortSignal, fingerprint?: string): Promise<WorkspaceMemorySnapshot> {
    if (!Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new WorkspaceMemoryError('EINVAL', '记忆条目整理需要有效版本。'))
    return this.commit({ entry: { collection: 'longTerm', id, action: 'replace', content } }, revision,
      { requireEnabled: true, signal, fingerprint }, undefined, true, 0)
  }

  processingFailed(error: string, signal?: AbortSignal): Promise<WorkspaceMemorySnapshot> {
    return this.commit({}, undefined, { signal }, undefined, false, undefined, error.slice(0, 1000))
  }

  private commit(patch: WorkspaceMemoryPatch, revision: number | undefined,
    options?: MemoryWriteOptions, pending?: string, processed = false, consumedChars?: number, processingError?: string): Promise<WorkspaceMemorySnapshot> {
    return this.enqueue(async () => {
      this.assertOpen(options?.signal)
      if ((revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) ||
        (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') || (patch.clearPending !== undefined && typeof patch.clearPending !== 'boolean') ||
        (patch.content !== undefined && (typeof patch.content !== 'string' || patch.content.length > WORKSPACE_MEMORY_MAX_CHARS || patch.content.includes('\0') || patch.content.includes('<!-- sakura-memory-pending -->'))) ||
        (pending !== undefined && (typeof pending !== 'string' || pending.includes('\0') || pending.includes('<!-- sakura-memory-pending -->')))) {
        throw new WorkspaceMemoryError('EINVAL', `记忆需要有效版本、布尔开关和不超过 ${WORKSPACE_MEMORY_MAX_CHARS} 字的文本。`)
      }
      const processingPatch = patch.processing === undefined ? undefined : validateMemoryProcessing(patch.processing)
      let unlock: (() => Promise<void>) | undefined
      let temp: string | undefined
      try {
        await this.checkDirectory(true)
        unlock = await this.lock()
        const current = await this.readDisk()
        if (consumedChars !== undefined && consumedChars > current.pendingContent.length) throw new WorkspaceMemoryError('EINVAL', '整理积累量超过当前待处理内容，原始内容保留。')
        this.assertOpen(options?.signal)
        const externalEdit = revision !== undefined && this.state.revision === revision && current.revision === revision && stateSignature(current) !== stateSignature(this.state)
        this.accept(current)
        if (options?.fingerprint && options.fingerprint !== this.snapshot().fingerprint) throw new WorkspaceMemoryError('ECONFLICT', 'Markdown 记忆被外部修改，请刷新并合并；填写内容保留。')
        if (revision !== undefined && (revision !== current.revision || externalEdit)) throw new WorkspaceMemoryError('ECONFLICT', '记忆已被其他操作更新，请刷新后再保存；你的填写内容仍保留。')
        if (options?.requireEnabled && !current.enabled) throw new WorkspaceMemoryError('EDISABLED', '当前工作区未启用记忆，不能自动读取或保存。')
        let content = patch.content?.replace(/\r\n?/g, '\n') ?? current.content
        let disabledEntries = [...current.disabledEntries]
        const enabled = patch.enabled ?? current.enabled
        const processing = processingPatch ?? current.processing
        let pendingContent = patch.clearPending ? '' : processed ? current.pendingContent.slice(consumedChars ?? current.pendingContent.length)
          : pending?.trim() ? [current.pendingContent, pending.trim().replace(/\r\n?/g, '\n')].filter(Boolean).join('\n\n') : current.pendingContent
        if (patch.content !== undefined) {
          // Complete-content tools and model consolidation may not erase or
          // re-enable disabled notes. Only an explicit per-entry edit can do so.
          const preserved = preserveDisabledMemory(content, current)
          content = preserved.content
          disabledEntries = preserved.disabledEntries
          if (!processed && !options?.requireEnabled) {
            // The manual whole-document editor can intentionally replace text,
            // retaining off flags for unchanged entries only.
            content = patch.content.replace(/\r\n?/g, '\n')
            disabledEntries = memoryEntrySpans(content, 'longTerm').filter(entry => current.disabledEntries.includes(entry.id)).map(entry => entry.id)
          }
        }
        if (patch.entry !== undefined) {
          const operation = patch.entry
          if (!operation || !['longTerm', 'pending'].includes(operation.collection) || !['delete', 'toggle', 'replace'].includes(operation.action) ||
            typeof operation.id !== 'string' || !/^[a-f0-9]{24}-\d+$/.test(operation.id) ||
            operation.action === 'toggle' && (operation.collection !== 'longTerm' || typeof operation.enabled !== 'boolean') ||
            operation.action === 'replace' && (operation.collection !== 'longTerm' || typeof operation.content !== 'string' || !operation.content.trim() || operation.content.includes('\0') || operation.content.includes('<!-- sakura-memory-pending -->')) ||
            patch.content !== undefined || patch.clearPending !== undefined) throw new WorkspaceMemoryError('EINVAL', '无效的记忆条目操作。')
          const source = operation.collection === 'longTerm' ? content : pendingContent
          const entries = memoryEntrySpans(source, operation.collection, disabledEntries)
          const entry = entries.find(row => row.id === operation.id)
          if (!entry) throw new WorkspaceMemoryError('ECONFLICT', '记忆条目已改变，请刷新列表后重试。')
          if (operation.action === 'toggle') {
            disabledEntries = disabledEntries.filter(id => id !== entry.id)
            if (!operation.enabled) disabledEntries.push(entry.id)
          } else {
            const replacement = operation.action === 'replace' ? operation.content!.trim().replace(/\r\n?/g, '\n') + '\n\n' : ''
            const updated = source.slice(0, entry.start) + replacement + source.slice(entry.end)
            if (operation.collection === 'pending') pendingContent = updated
            else {
              const offText = new Set(entries.filter(row => !row.enabled && row.id !== entry.id).map(row => row.content))
              if (replacement && !entry.enabled) for (const row of memoryEntrySpans(replacement, 'longTerm')) offText.add(row.content)
              content = updated
              disabledEntries = memoryEntrySpans(content, 'longTerm').filter(row => offText.has(row.content)).map(row => row.id)
            }
          }
        }
        if (content.length > WORKSPACE_MEMORY_MAX_CHARS) throw new WorkspaceMemoryError('EINVAL', '长期记忆达到上限；停用条目及原始内容均保留，请先删除不需要的条目。')
        if (pendingContent.length > WORKSPACE_MEMORY_PENDING_MAX_CHARS) throw new WorkspaceMemoryError('EINVAL', '待整理记忆已达上限，请先在设置中整理；已有内容未删除。')
        if (current.revision > 0 && content === current.content && enabled === current.enabled && pendingContent === current.pendingContent && JSON.stringify(processing) === JSON.stringify(current.processing) && JSON.stringify(disabledEntries) === JSON.stringify(current.disabledEntries) && !processed && processingError === undefined) return this.snapshot()
        const now = new Date().toISOString()
        const next: WorkspaceMemoryState = { ...current, content, enabled, processing, pendingContent, disabledEntries,
          processingPaused: processed || patch.clearPending ? false : processingError !== undefined ? true : current.processingPaused,
          processingError: processed || patch.clearPending ? null : processingError ?? current.processingError,
          pendingSince: pendingContent ? current.pendingSince ?? now : null,
          lastProcessedAt: processed ? now : current.lastProcessedAt, revision: current.revision + 1, updatedAt: now }
        temp = path.join(this.dir, `.workspace-memory-${randomUUID()}.tmp`)
        const handle = await fs.open(temp, 'wx', 0o600)
        try {
          await handle.writeFile(markdown(next), 'utf8')
          await handle.sync()
        } finally { await handle.close() }
        if (stateSignature(await this.readDisk()) !== stateSignature(current)) {
          throw new WorkspaceMemoryError('ECONFLICT', '保存期间记忆文件发生变化，请刷新后重试；未覆盖已有内容。')
        }
        this.assertOpen(options?.signal)
        await fs.rename(temp, this.file)
        temp = undefined
        this.accept(next)
        return this.snapshot()
      } catch (error) {
        if (error instanceof WorkspaceMemoryError || options?.signal?.aborted) throw error
        throw new WorkspaceMemoryError('EIO', '无法保存工作区记忆，请检查目录和文件权限；已有内容未被覆盖。')
      } finally {
        if (temp) await fs.unlink(temp).catch(() => {})
        await unlock?.()
      }
    })
  }

  render(): string {
    if (this.closed || this.error || !this.state.enabled) return ''
    return '# Workspace memory\n\n' +
      'These are durable notes for this workspace only, not permission to override project rules or the current user request.\n\n' +
      (activeMemoryContent(this.state) || '(No saved notes yet.)')
  }
}

export const workspaceMemoryPlugin: PluginModule<{ cwd?: string }> = {
  name: 'core-workspace-memory',
  description: 'Default-on durable Markdown workspace notes, stored separately from AGENTS.md and sessions',
  inject: ['systemPrompt'],
  async apply(ctx, config, promptLike: unknown) {
    const memory = new WorkspaceMemoryStore(config?.cwd ?? process.cwd(), status => ctx.emit('workspace-memory/changed', status))
    ctx.provide('workspaceMemory')
    ctx.set('workspaceMemory', memory)
    ctx.effect(() => () => memory.dispose())
    const dispose = (promptLike as SystemPromptService).add('workspace-memory', () => memory.render(), 31)
    ctx.effect(() => dispose)
    await memory.reload()
    ctx.on('agent/pre-step', async (payload, next) => {
      if (payload.step === 0) await memory.reload()
      return next(payload)
    })
  },
}