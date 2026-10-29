/** Versioned conversation rewind. Copy an immutable prefix to a fully independent
 * session; neither model context nor exports need a second projection format. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { CHAT_ATTACHMENT_MARKER, CHAT_FILE_LIMITS, ChatAttachmentError, storeChatFiles, type ChatUploadFile, type StoredChatFiles } from './attachments.js'
import type { CheckpointPlan, CheckpointService } from './checkpoints.js'
import { SessionError, type Session, type SessionService } from './session.js'
import type { SessionEventRecord } from './types.js'

export type HistoryMode = 'conversation' | 'code' | 'both'
export interface HistoryPreview {
  sessionId: string
  turnSeq: number
  contextRevision: number
  fingerprint: string
  text: string
  attachments: Array<{ name: string; kind: string; size: number }>
  discardedMessages: number
  checkpoint: CheckpointPlan | null
  warnings: string[]
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export function messageText(record: Extract<SessionEventRecord, { type: 'user/message' }>): string {
  return record.payload.originalText ?? record.payload.content.split(CHAT_ATTACHMENT_MARKER)[0]!
    .replace(/\n\nThe user explicitly selected this (?:Skill|reference)[\s\S]*$/, '')
}

function userTurn(source: Session, turnSeq: number): Extract<SessionEventRecord, { type: 'user/message' }> {
  const record = source.events.find(record => record.seq === turnSeq)
  if (!Number.isSafeInteger(turnSeq) || !record || record.type !== 'user/message' || record.payload.from || record.payload.source && record.payload.source !== 'user') {
    throw new SessionError('EINVAL', '只能编辑或回滚当前会话中已经保存的用户消息。')
  }
  return record
}

async function safeAttachment(sessionDir: string, file: string, size: number, sha256: string): Promise<Buffer> {
  const root = path.resolve(sessionDir, 'attachments'), resolved = path.resolve(file), relative = path.relative(root, resolved)
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep) ||
      !Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ChatAttachmentError(500, '附件不是当前会话的安全副本，未创建新分支。')
  }
  let current = path.parse(resolved).root
  for (const part of path.relative(current, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    if (info.isSymbolicLink() || (current === resolved ? !info.isFile() || info.nlink !== 1 || info.size !== size : !info.isDirectory())) {
      throw new ChatAttachmentError(500, '附件含符号链接、联接或已改变，未创建新分支。')
    }
  }
  const bytes = await fs.readFile(resolved)
  if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== sha256) {
    throw new ChatAttachmentError(500, '原附件缺失或已改变，请保留原会话；未创建新分支。')
  }
  return bytes
}

async function copyMessageFiles(record: Extract<SessionEventRecord, { type: 'user/message' }>, sourceDir: string, destinationDir: string): Promise<StoredChatFiles | undefined> {
  if (!record.payload.attachments?.length) return undefined
  if (record.payload.attachments.length > CHAT_FILE_LIMITS.count || record.payload.attachments.reduce((sum, file) => sum + file.size, 0) > CHAT_FILE_LIMITS.totalBytes) {
    throw new ChatAttachmentError(500, '原附件数量或大小超过安全限制，未创建新分支。')
  }
  const files: ChatUploadFile[] = await Promise.all(record.payload.attachments.map(async file => ({
    name: file.name, mimeType: file.mimeType, bytes: await safeAttachment(sourceDir, file.path, file.size, file.sha256),
  })))
  return storeChatFiles(destinationDir, files)
}

export class ConversationHistoryService {
  constructor(private sessions: SessionService, private checkpoints?: CheckpointService) {}

  async preview(sessionId: string, turnSeq: number): Promise<HistoryPreview> {
    const source = await this.sessions.open(sessionId), target = userTurn(source, turnSeq)
    if (source.archived) throw new SessionError('EBUSY', '对话已归档，请先恢复后再编辑或回滚。')
    const discarded = source.events.filter(record => record.seq >= turnSeq)
    const warnings: string[] = []
    warnings.push('回滚不会撤销其他独立会话或协作者的修改，也不会改写长期记忆、Git 提交或外部系统。')
    if (discarded.some(record => record.type === 'tool/call' && !['read', 'write', 'edit', 'glob', 'grep', 'todo_write', 'list_agents', 'list_subagent_models'].includes(record.payload.name))) {
      warnings.push('命令行、外部工具、后台任务、网络及长期记忆等副作用无法保证撤销；只恢复有快照的 write/edit 项目文件。')
    }
    let checkpoint: CheckpointPlan | null = null
    try { checkpoint = this.checkpoints ? await this.checkpoints.plan(sessionId, turnSeq) : null }
    catch { warnings.push('代码快照不可读；仅能回滚对话，代码与原始快照保持不变。') }
    if (!checkpoint || !checkpoint.files.length) warnings.push('此处没有已跟踪的代码快照；旧会话的代码修改不会自动恢复。')
    if (checkpoint?.untracked.length) warnings.push('部分文件在工作区外、内部目录、含链接或超出大小限制，未提供自动代码回滚。')
    const contextRevision = source.events.at(-1)?.seq ?? 0
    return { sessionId, turnSeq, contextRevision,
      fingerprint: digest(JSON.stringify({ sessionId, turnSeq, records: source.events, checkpoint: checkpoint?.fingerprint ?? null })),
      text: messageText(target), attachments: (target.payload.attachments ?? []).map(({ name, kind, size }) => ({ name, kind, size })),
      discardedMessages: discarded.filter(record => record.type === 'user/message' || record.type === 'assistant/message').length,
      checkpoint, warnings }
  }

  /** The caller owns the workspace write gate and synchronously adopts the
   * returned session. Failures remove only the unpublished new branch. */
  async rewind(options: {
    sessionId: string; turnSeq: number; contextRevision: number; fingerprint: string; mode: HistoryMode
    edit?: { task: string; originalText: string }; title?: string
  }, assertIdle: () => void): Promise<{ session: Session; restoredFiles: number }> {
    if (!['conversation', 'code', 'both'].includes(options.mode) || options.edit &&
        (!options.edit.originalText.trim() || options.edit.originalText.length > 64_000)) throw new SessionError('EINVAL', '无效的回滚范围或编辑消息。')
    const source = await this.sessions.open(options.sessionId)
    const transaction = () => source.exclusive(async () => {
      const preview = await this.preview(options.sessionId, options.turnSeq)
      if (preview.contextRevision !== options.contextRevision || preview.fingerprint !== options.fingerprint) {
        throw new SessionError('EBUSY', '对话或代码已改变，请重新预览并确认；未执行回滚。')
      }
      if (options.mode === 'code' && options.edit) throw new SessionError('EINVAL', '仅回滚代码不能同时编辑消息。')
      if (options.mode !== 'conversation' && !preview.checkpoint && this.checkpoints) throw new SessionError('EBUSY', '代码快照不可读，请选择只回滚对话。')
      if (options.mode === 'code' && !preview.checkpoint?.files.length) throw new SessionError('EINVAL', '没有可恢复的代码快照。')
      if (options.mode !== 'conversation' && preview.checkpoint?.files.some(file => file.conflict)) {
        throw new SessionError('EBUSY', '存在代码冲突，请处理后重新预览，或选择只回滚对话。')
      }
      assertIdle()
      if (options.mode === 'code') {
        const restoredFiles = preview.checkpoint ? await this.checkpoints!.restore(preview.checkpoint, assertIdle) : 0
        return { session: source, restoredFiles }
      }
      const target = userTurn(source, options.turnSeq)
      let branch: Session | undefined
      try {
        branch = await this.sessions.create({ title: options.title ?? (options.edit ? '编辑分支' : '回滚分支'),
          branchOf: source.id, beforeSeq: target.seq, action: options.edit ? 'edit' : 'rewind', codeMode: options.mode })
        const seqMap = new Map<number, number>()
        for (const record of source.events) {
          if (record.seq >= target.seq || record.type === 'agent/meta' || record.type === 'session/note' && ['title', 'archive'].includes(String(record.payload.note))) continue
          let payload = structuredClone(record.payload)
          if (record.type === 'session/note' && record.payload.note === 'turn-summary') {
            payload = { ...payload, userSeq: seqMap.get(Number(record.payload.userSeq)) }
          } else if (record.type === 'collaboration/message' && record.payload.userSeq !== undefined) {
            payload = { ...payload, userSeq: seqMap.get(record.payload.userSeq) }
          }
          if (record.type === 'user/message' && record.payload.attachments?.length) {
            const copy = await copyMessageFiles(record, source.dir, branch.dir)
            payload = { ...record.payload, content: record.payload.content.split(CHAT_ATTACHMENT_MARKER)[0]! + copy!.context,
              images: copy!.images.length ? copy!.images : record.payload.images, attachments: copy!.attachments }
          }
          const cloned = await branch.append({ type: record.type, payload } as import('./types.js').SessionEventPayload)
          seqMap.set(record.seq, cloned.seq)
        }
        // A corrupt old checkpoint need not prevent a conversation-only branch;
        // that mode explicitly promises no restoration of code.
        if (this.checkpoints && preview.checkpoint) await this.checkpoints.inherit(source.id, branch.id, seqMap)
        if (options.edit) {
          const copy = await copyMessageFiles(target, source.dir, branch.dir)
          await branch.append({ type: 'session/note', payload: { note: 'edited-message', originalSeq: target.seq } })
          await branch.append({ type: 'user/message', payload: {
            content: options.edit.task + (copy?.context ?? ''), originalText: options.edit.originalText,
            ...(copy ? { attachments: copy.attachments, images: copy.images.length ? copy.images : target.payload.images }
              : target.payload.images ? { images: target.payload.images } : {}),
          } })
        }
        assertIdle()
        const restoredFiles = options.mode === 'both' && preview.checkpoint ? await this.checkpoints!.restore(preview.checkpoint, assertIdle) : 0
        return { session: branch, restoredFiles }
      } catch (error) {
        if (branch) {
          try { await this.sessions.delete(branch.id) }
          catch { throw new SessionError('EBUSY', `回滚未完成，未发布分支 ${branch.id} 清理失败，请备份后检查；原对话未删除。`) }
        }
        throw error
      }
    }, assertIdle)
    return this.checkpoints ? this.checkpoints.locked(transaction) : transaction()
  }
}