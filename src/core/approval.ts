/**
 * Approval gate — policy as a tools/pre-execute listener, nothing more.
 * Modes: plan (read-only) → default (confirm writes/commands) →
 * acceptEdits (auto-approve file writes) → yolo (auto-approve everything).
 */

import type { Context } from '../kernel/index.js'
import type { ToolDefinition } from './types.js'
import { PermissionEngine, parseRules } from '../permissions/index.js'

export type ApprovalMode = 'plan' | 'default' | 'acceptEdits' | 'yolo'

export const APPROVAL_MODES: ApprovalMode[] = ['plan', 'default', 'acceptEdits', 'yolo']

export interface ApprovalRequest {
  tool: ToolDefinition
  args: Record<string, unknown>
  agentId: string
  /** Optional for third-party callers; tools pass their turn cancellation signal. */
  signal?: AbortSignal
}

export type ConfirmHandler = (req: ApprovalRequest) => Promise<boolean> | boolean

export class ApprovalService {
  mode: ApprovalMode = 'default'
  private handler?: ConfirmHandler
  /** Rule engine (glob allow/deny + session allows); rules override the mode gates below. */
  engine: PermissionEngine = new PermissionEngine()

  setMode(mode: ApprovalMode): void {
    this.mode = mode
  }

  /** Replace the rule engine (mounted from the core-approval config rows). */
  setEngine(engine: PermissionEngine): void {
    this.engine = engine
  }

  /** Interactive UIs install a handler (e.g. readline y/n); headless runs fail closed. */
  setConfirmHandler(handler: ConfirmHandler | undefined): void {
    this.handler = handler
  }

  async check(req: ApprovalRequest): Promise<{ allowed: boolean; reason?: string }> {
    if (this.mode === 'yolo') return { allowed: true }
    if (req.tool.kind === 'read') return { allowed: true }
    if (this.mode === 'plan') {
      return { allowed: false, reason: 'plan mode is read-only; switch approval mode to apply changes' }
    }
    if (this.mode === 'acceptEdits' && req.tool.kind === 'write') return { allowed: true }
    // Rule engine: deny rules win, allow rules and session allows skip the
    // interactive handler.
    const verdict = this.engine.evaluate({ name: req.tool.name, kind: req.tool.kind }, req.args)
    if (verdict.outcome === 'deny') return { allowed: false, reason: verdict.reason }
    if (verdict.outcome === 'allow') return { allowed: true }
    if (!this.handler) {
      return {
        allowed: false,
        reason: `tool "${req.tool.name}" needs approval but no interactive handler is available (run in a TTY or use --yolo)`,
      }
    }
    let ok: boolean
    try {
      ok = await this.handler(req)
    } catch (error) {
      return { allowed: false, reason: `confirmation handler failed: ${(error as Error).message}` }
    }
    return ok ? { allowed: true } : { allowed: false, reason: 'denied by user' }
  }
}

export const approvalPlugin = {
  name: 'core-approval',
  description: 'Permission gates wired as a tools/pre-execute listener (ctx.approval)',
  config: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: APPROVAL_MODES, description: 'initial approval mode' },
    },
  } as const,
  apply(ctx: Context, config?: { mode?: ApprovalMode; rules?: unknown }) {
    ctx.provide('approval')
    const service = new ApprovalService()
    if (config?.mode) service.mode = config.mode
    service.setEngine(new PermissionEngine(parseRules(config?.rules)))
    ctx.set('approval', service)

    ctx.on('tools/pre-execute', async (payload, next) => {
      if (!payload.tool) return next(payload)
      const verdict = await service.check({ tool: payload.tool, args: payload.args, agentId: payload.tc.agentId, signal: payload.tc.signal })
      if (!verdict.allowed) {
        payload.blockedReason = verdict.reason
        return payload // short-circuit without next(): the call never executes
      }
      return next(payload)
    })
  },
}
