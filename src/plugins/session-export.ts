/**
 * core-session-export — transcript rendering for the session log: markdown
 * (chat-style, with collapsible thinking/tool sections) and filtered JSON.
 * The web GUI's download button and the REPL's /export consume this.
 */

import type { Plugin } from '../kernel/index.js'
import type { SessionService } from '../core/session.js'
import type { SessionEventRecord } from '../core/types.js'

export interface SessionExportConfig {
  /** Markdown total-length cap (default 200_000). */
  maxOutputChars?: number
}

export interface SessionExportService {
  toMarkdown(sessionId: string): Promise<string>
  toJson(sessionId: string): Promise<unknown>
}

function escapeLt(text: string): string {
  return text.replace(/</g, '&lt;')
}

export const sessionExportPlugin: Plugin = {
  name: 'core-session-export',
  description: 'Session transcript export: markdown and filtered JSON (ctx.sessionExport)',
  inject: ['sessions'],
  apply(ctx: import('../kernel/index.js').Context, config?: SessionExportConfig, sessionsLike?: unknown) {
    const sessions = (sessionsLike ?? ctx.peek<SessionService>('sessions')) as SessionService
    const maxChars = config?.maxOutputChars ?? 200_000

    const open = (sessionId: string) => sessions.open(sessionId) // throws ENOENT for unknown ids

    const service: SessionExportService = {
      async toMarkdown(sessionId: string): Promise<string> {
        const session = await open(sessionId)
        const records = session.events
        const lines: string[] = [
          `# SakuraCode 会话 ${sessionId}`,
          '',
          `> 导出于 ${new Date().toISOString()} · ${records.length} 条记录`,
          '',
        ]
        let currentRole: 'user' | 'assistant' | null = null
        const closeSection = (): void => {
          if (currentRole) lines.push('', '---', '')
        }
        const openSection = (role: 'user' | 'assistant'): void => {
          if (currentRole !== role) {
            closeSection()
            lines.push(role === 'user' ? '## 👤 用户' : '## 🤖 助手', '')
            currentRole = role
          }
        }

        for (const record of records) {
          if (record.type === 'user/message') {
            openSection('user')
            lines.push(escapeLt(record.payload.content), '')
          } else if (record.type === 'assistant/message') {
            const content = record.payload.content
            if (content) {
              openSection('assistant')
              lines.push(escapeLt(content), '')
            }
            const thinking = record.payload.stream?.thinking
            if (thinking) {
              openSection('assistant')
              lines.push('<details><summary>💭 思考</summary>', '', escapeLt(thinking), '', '</details>', '')
            }
          } else if (record.type === 'tool/result') {
            openSection('assistant')
            const { name, output, isError, durationMs, images } = record.payload
            lines.push(`<details><summary>🔧 工具 ${name}${isError ? '（⚠ 出错）' : `（exit 0 · ${durationMs}ms）`}</summary>`, '')
            if (images?.length) lines.push(`[图片 ×${images.length}]`, '')
            lines.push('**输出**', '', '```', output.replace(/```/g, '``\u200b`'), '```', '', '</details>', '')
          } else if (record.type === 'session/note' && (record.payload as { note?: string }).note === 'compaction') {
            lines.push('> [上下文已压缩]', '')
          }
          // system/message, agent/meta, tool/call, other notes: observability only.
        }
        closeSection()

        let md = lines.join('\n').replace(/\n{3,}/g, '\n\n')
        if (md.length > maxChars) md = `${md.slice(0, maxChars)}\n\n…[truncated]`
        return md
      },

      async toJson(sessionId: string): Promise<unknown> {
        const session = await open(sessionId)
        return session.events
          .filter((r) => r.type !== 'agent/meta' && r.type !== 'system/message')
          .map((r: SessionEventRecord) => {
            if (r.type === 'tool/result') {
              const { images, ...rest } = r.payload
              return { seq: r.seq, time: r.time, type: r.type, payload: { ...rest, ...(images?.length ? { images: images.length } : {}) } }
            }
            return { seq: r.seq, time: r.time, type: r.type, payload: r.payload }
          })
      },
    }

    ctx.provide('sessionExport')
    ctx.set('sessionExport', service)
  },
}
