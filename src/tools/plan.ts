/**
 * tool-plan — exit_plan: the plan-mode handshake. While approval mode is
 * 'plan' the agent researches read-only; when its plan is ready it presents
 * it through this tool, the UI renders an approval card, and an approve
 * decision flips the mode to acceptEdits so execution can begin.
 */

import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { params } from '../core/tools.js'

export type PlanDecision = 'approve' | 'reject'
export type PlanHandler = (req: { id: string; plan: string }) => Promise<PlanDecision | null> | PlanDecision | null

export interface PlanService {
  setHandler(handler: PlanHandler | undefined): void
  propose(plan: string): Promise<{ id: string; decision: PlanDecision | null }>
}

export const planToolsPlugin: PluginModule = {
  name: 'tool-plan',
  description: 'exit_plan — present the plan for approval while in plan mode',
  inject: ['tools'],
  apply(ctx, _config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    let handler: PlanHandler | undefined
    let planSeq = 0

    const service: PlanService = {
      setHandler(h) {
        handler = h
      },
      async propose(plan) {
        const id = `plan-${++planSeq}`
        ctx.emit('plan/propose', { id, plan })
        let decision: PlanDecision | null = null
        if (handler) {
          try {
            decision = await handler({ id, plan })
          } catch {
            decision = null // a broken handler must not fail the tool call
          }
        }
        ctx.emit('plan/resolved', { id, decision })
        return { id, decision }
      },
    }
    ctx.provide('plan')
    ctx.set('plan', service)

    tools.register({
      name: 'exit_plan',
      description:
        'Present your plan for user approval. Use this while in plan mode after you have finished ' +
        'read-only research: pass the full plan as markdown (goal, steps, files to touch, risks). ' +
        'When the user approves, the session switches to acceptEdits and you execute the plan in ' +
        'this same turn. If rejected, keep researching or revise and call this again.',
      kind: 'read',
      parameters: params(
        { plan: { type: 'string', description: 'The complete plan in markdown.' } },
        ['plan'],
      ),
      execute: async (args) => {
        const plan = String(args.plan ?? '').trim()
        if (!plan) return { output: 'error: plan is required', isError: true }
        const { decision } = await service.propose(plan.slice(0, 16_000))
        if (decision === 'approve') {
          const approval = ctx.peek<{ setMode(mode: 'plan' | 'default' | 'acceptEdits' | 'yolo'): void }>('approval')
          approval?.setMode('acceptEdits')
          return {
            output:
              'PLAN APPROVED — approval mode switched to acceptEdits. Execute the plan now, ' +
              'starting with the first step. Keep going until the plan completes.',
          }
        }
        return {
          output:
            'PLAN REJECTED' +
            (decision === null ? ' (no interactive UI answered — stay in plan mode)' : ' — the user wants changes') +
            '. Continue read-only research or revise the plan and call exit_plan again. Do NOT edit files.',
        }
      },
    })
  },
}
