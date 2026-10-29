/**
 * session-export — markdown transcript rendering and filtered JSON.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { sessionPlugin, SessionService } from '../src/core/session.js'
import { sessionExportPlugin } from '../src/plugins/session-export.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
})

async function setup(maxOutputChars?: number) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-export-'))
  cleanups.push(() => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}))
  const ctx = new Context()
  await ctx.plugin(sessionPlugin, { dir: path.join(tmpDir, 'sessions') })
  await ctx.plugin(sessionExportPlugin, maxOutputChars ? { maxOutputChars } : undefined)
  const sessions = ctx.peek<SessionService>('sessions')!
  const exporter = ctx.peek<import('../src/plugins/session-export.js').SessionExportService>('sessionExport')!
  return { tmpDir, sessions, exporter }
}

describe('session-export', () => {
  it('renders users, assistants, thinking and tool sections', async () => {
    const { sessions, exporter } = await setup()
    const session = await sessions.create()
    await session.append({ type: 'user/message', payload: { content: '第一问' } })
    await session.append({ type: 'user/message', payload: { content: '第二问' } })
    await session.append({
      type: 'assistant/message',
      payload: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        stream: { text: '', thinking: '考虑执行命令…', toolCalls: [], durationMs: 10 },
      },
    })
    await session.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'bash', output: 'sakura-e2e-ok', durationMs: 48 },
    })
    await session.append({
      type: 'assistant/message',
      payload: { role: 'assistant', content: '搞定 <b>了</b>', stream: { text: '搞定 <b>了</b>', toolCalls: [], durationMs: 5 } },
    })

    const md = await exporter.toMarkdown(session.id)
    expect(md).toContain(`# SakuraCode 会话 ${session.id}`)
    expect(md).toContain('条记录')
    // two consecutive user messages merge into one section
    expect(md.match(/## 👤 用户/g)).toHaveLength(1)
    expect(md).toContain('第一问')
    expect(md).toContain('第二问')
    expect(md).toContain('💭 思考')
    expect(md).toContain('考虑执行命令…')
    expect(md).toContain('🔧 工具 bash（exit 0 · 48ms）')
    expect(md).toContain('sakura-e2e-ok')
    // `<` escaped so raw markdown never turns into HTML
    expect(md).toContain('&lt;b>')
    expect(md).not.toContain('<b>了</b>')
  })

  it('marks failed tools and image placeholders, notes compaction', async () => {
    const { sessions, exporter } = await setup()
    const session = await sessions.create()
    await session.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'bash', output: 'boom', isError: true, durationMs: 3, images: ['data:image/png;base64,AAAA'] },
    })
    await session.append({ type: 'session/note', payload: { note: 'compaction', summary: 's' } })
    await session.clearContext()
    const md = await exporter.toMarkdown(session.id)
    expect(md).toContain('⚠ 出错')
    expect(md).toContain('[图片 ×1]')
    expect(md).not.toContain('data:image')
    expect(md).toContain('[上下文已压缩]')
    expect(md).toContain('[上下文已清空，历史记录保留]')
  })

  it('toJson drops meta/system and collapses images to counts', async () => {
    const { sessions, exporter } = await setup()
    const session = await sessions.create()
    await session.append({ type: 'user/message', payload: { content: 'hi' } })
    await session.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'shot', output: 'ok', durationMs: 1, images: ['data:x', 'data:y'] },
    })
    const json = (await exporter.toJson(session.id)) as Array<{ type: string; payload: Record<string, unknown> }>
    const types = json.map((r) => r.type)
    expect(types).not.toContain('agent/meta')
    expect(types).not.toContain('system/message')
    const tool = json.find((r) => r.type === 'tool/result')!
    expect(tool.payload.images).toBe(2)
  })

  it('rejects unknown session ids', async () => {
    const { exporter } = await setup()
    await expect(exporter.toMarkdown('nope-123')).rejects.toThrow()
  })

  it('truncates markdown at maxOutputChars', async () => {
    const { sessions, exporter } = await setup(600)
    const session = await sessions.create()
    await session.append({ type: 'user/message', payload: { content: '长'.repeat(5000) } })
    const md = await exporter.toMarkdown(session.id)
    expect(md.length).toBeLessThanOrEqual(600 + '\n\n…[truncated]'.length)
    expect(md).toContain('[truncated]')
  })
})
