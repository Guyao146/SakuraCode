/**
 * interactionPlugin + askUserToolsPlugin — the ask_user tool and the
 * interaction service, exercised on a minimal kernel (Context + toolsPlugin),
 * mirroring tests/mcp.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { askUserToolsPlugin, interactionPlugin, type InteractionService } from '../src/plugins/ask-user.js'
import type { ToolContext } from '../src/core/types.js'

// Every test mounts its own kernel.
const contexts: Context[] = []
afterEach(() => {
  while (contexts.length) contexts.pop()?.dispose()
})

const makeTc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

async function mount(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(interactionPlugin)
  await ctx.plugin(askUserToolsPlugin)
  return ctx
}

describe('ask_user — interactive question tool', () => {
  it('returns the no-answer fallback and still emits request/resolved without a handler', async () => {
    const ctx = await mount()
    const tools = ctx.get<ToolsService>('tools')

    const requests: Array<{ id: string; question: string; options: string[] }> = []
    const resolved: Array<{ id: string; answer: string | null }> = []
    ctx.on('interaction/request', (p: { id: string; question: string; options: string[] }) => {
      requests.push(p)
    })
    ctx.on('interaction/resolved', (p: { id: string; answer: string | null }) => {
      resolved.push(p)
    })

    const result = await tools.execute(
      'c1',
      'ask_user',
      JSON.stringify({ question: 'Which path?', options: ['A', 'B'] }),
      makeTc(),
    )

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('no answer')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ question: 'Which path?', options: ['A', 'B'] })
    expect(requests[0]!.id).toBeTruthy()
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.id).toBe(requests[0]!.id)
    expect(resolved[0]!.answer).toBeNull()
  })

  it('returns the picked option and resolves with it', async () => {
    const ctx = await mount()
    const tools = ctx.get<ToolsService>('tools')
    const interaction = ctx.get<InteractionService>('interaction')
    interaction.setHandler(async () => '选项B')

    const resolved: Array<{ id: string; answer: string | null }> = []
    ctx.on('interaction/resolved', (p: { id: string; answer: string | null }) => {
      resolved.push(p)
    })

    const result = await tools.execute(
      'c2',
      'ask_user',
      JSON.stringify({ question: 'A or B?', options: ['选项A', '选项B'] }),
      makeTc(),
    )

    expect(result.output).toBe('User answered: 选项B')
    expect(result.isError).toBeFalsy()
    expect(resolved).toHaveLength(1)
    expect(resolved[0]!.answer).toBe('选项B')
  })

  it('falls back to no answer when the handler throws', async () => {
    const ctx = await mount()
    const tools = ctx.get<ToolsService>('tools')
    const interaction = ctx.get<InteractionService>('interaction')
    interaction.setHandler(async () => {
      throw new Error('handler exploded')
    })

    const result = await tools.execute(
      'c3',
      'ask_user',
      JSON.stringify({ question: 'Still there?', options: ['yes', 'no'] }),
      makeTc(),
    )

    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('no answer')
  })

  it('rejects bad arguments as tool errors', async () => {
    const ctx = await mount()
    const tools = ctx.get<ToolsService>('tools')

    const oneOption = await tools.execute('c4', 'ask_user', JSON.stringify({ question: 'q', options: ['only'] }), makeTc())
    expect(oneOption.isError).toBe(true)

    const fiveOptions = await tools.execute(
      'c5',
      'ask_user',
      JSON.stringify({ question: 'q', options: ['1', '2', '3', '4', '5'] }),
      makeTc(),
    )
    expect(fiveOptions.isError).toBe(true)

    const emptyQuestion = await tools.execute('c6', 'ask_user', JSON.stringify({ question: '' }), makeTc())
    expect(emptyQuestion.isError).toBe(true)
  })

  it('passes free-form handler answers through untouched', async () => {
    const ctx = await mount()
    const tools = ctx.get<ToolsService>('tools')
    const interaction = ctx.get<InteractionService>('interaction')
    interaction.setHandler(() => '自定义回答文本')

    const result = await tools.execute('c7', 'ask_user', JSON.stringify({ question: '自由输入？' }), makeTc())

    expect(result.output).toBe('User answered: 自定义回答文本')
    expect(result.isError).toBeFalsy()
  })
})
