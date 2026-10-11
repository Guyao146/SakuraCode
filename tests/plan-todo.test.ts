/**
 * exit_plan handshake (plan card → approve flips the mode) and the todo
 * store exposure (ctx.todos + ui/todos events).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { approvalPlugin, type ApprovalService } from '../src/core/approval.js'
import { planToolsPlugin } from '../src/tools/plan.js'
import { todoToolsPlugin } from '../src/tools/todo.js'
import type { ToolContext } from '../src/core/types.js'

const tc: ToolContext = { sessionId: 's', agentId: 'a', signal: new AbortController().signal }

function setup() {
  const ctx = new Context()
  return ctx
}

describe('exit_plan', () => {
  it('approval flips the mode to acceptEdits', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(approvalPlugin, { mode: 'plan' })
    await ctx.plugin(planToolsPlugin)
    const plan = ctx.peek<import('../src/tools/plan.js').PlanService>('plan')!
    plan.setHandler(() => 'approve')
    const result = await ctx.peek<ToolsService>('tools')!.execute('c1', 'exit_plan', JSON.stringify({ plan: '# plan\n- step 1' }), tc)
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('PLAN APPROVED')
    expect(ctx.peek<ApprovalService>('approval')!.mode).toBe('acceptEdits')
  })

  it('rejection keeps plan mode and asks for revision', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(approvalPlugin, { mode: 'plan' })
    await ctx.plugin(planToolsPlugin)
    const plan = ctx.peek<import('../src/tools/plan.js').PlanService>('plan')!
    plan.setHandler(() => 'reject')
    const result = await ctx.peek<ToolsService>('tools')!.execute('c1', 'exit_plan', JSON.stringify({ plan: 'p' }), tc)
    expect(result.output).toContain('PLAN REJECTED')
    expect(ctx.peek<ApprovalService>('approval')!.mode).toBe('plan')
  })

  it('no handler → stays in plan mode with a note', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(approvalPlugin, { mode: 'plan' })
    await ctx.plugin(planToolsPlugin)
    const result = await ctx.peek<ToolsService>('tools')!.execute('c1', 'exit_plan', JSON.stringify({ plan: 'p' }), tc)
    expect(result.output).toContain('PLAN REJECTED')
    expect(result.output).toContain('no interactive UI')
  })

  it('emits plan/propose and plan/resolved events', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(planToolsPlugin)
    const events: string[] = []
    ctx.on('plan/propose', () => events.push('propose'))
    ctx.on('plan/resolved', () => events.push('resolved'))
    const plan = ctx.peek<import('../src/tools/plan.js').PlanService>('plan')!
    plan.setHandler(() => 'approve')
    await ctx.peek<ToolsService>('tools')!.execute('c1', 'exit_plan', JSON.stringify({ plan: 'p' }), tc)
    expect(events).toEqual(['propose', 'resolved'])
  })

  it('empty plan is an error', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(planToolsPlugin)
    const result = await ctx.peek<ToolsService>('tools')!.execute('c1', 'exit_plan', JSON.stringify({ plan: '' }), tc)
    expect(result.isError).toBe(true)
  })
})

describe('todo store exposure', () => {
  it('todo_write updates ctx.todos and emits ui/todos', async () => {
    const ctx = setup()
    await ctx.plugin(toolsPlugin)
    await ctx.plugin(todoToolsPlugin)
    const events: Array<Array<{ content: string; status: string }>> = []
    ctx.on('ui/todos', (p: { todos: Array<{ content: string; status: string }> }) => events.push(p.todos))
    const result = await ctx.peek<ToolsService>('tools')!.execute(
      'c1',
      'todo_write',
      JSON.stringify({ todos: [{ content: 'step one', status: 'in_progress', priority: 'high' }] }),
      tc,
    )
    expect(result.isError).toBeFalsy()
    const store = ctx.peek<{ todos: Array<{ content: string; status: string }> }>('todos')
    expect(store?.todos).toEqual([{ content: 'step one', status: 'in_progress', priority: 'high' }])
    expect(events).toHaveLength(1)
    expect(events[0]![0]!.content).toBe('step one')
  })
})
