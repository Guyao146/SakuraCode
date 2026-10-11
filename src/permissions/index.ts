/**
 * Permission rules — allow/deny lists evaluated before the
 * classic approval flow (src/core/approval.ts). Rules glob-match tool
 * names (or `kind:*` class forms) with optional argument-prefix
 * constraints. deny always beats allow; anything unmatched falls
 * through to the normal ApprovalService.check.
 */

import { globToRegExp } from '../tools/util.js'

export interface PermissionRule {
  effect: 'allow' | 'deny'
  /** Tool-name glob (`read`, `write*`, `*`); `kind:write` form matches a whole ToolKind class. */
  tools: string
  /** Optional argument constraints: every `argName`'s value must be a string starting with the given prefix. */
  args?: Record<string, string>
  /** Human explanation, surfaced in the deny reason. */
  reason?: string
}

export type ApprovalMode = 'plan' | 'default' | 'acceptEdits' | 'yolo'

export interface PermissionVerdict {
  /** 'deny' rejected by a rule; 'allow' allowed by a rule or session grant; 'default' falls through to the approval flow. */
  outcome: 'allow' | 'deny' | 'default'
  reason?: string
  /** The matched rule (present when the outcome came from a rule, absent for session grants and default). */
  rule?: PermissionRule
}

/** Does a single rule match this tool call? Name/kind must match and every arg constraint must hold. */
function ruleMatches(
  rule: PermissionRule,
  tool: { name: string; kind: string },
  args: Record<string, unknown>,
): boolean {
  if (rule.tools.startsWith('kind:')) {
    if (!globToRegExp(rule.tools.slice('kind:'.length)).test(tool.kind)) return false
  } else if (!globToRegExp(rule.tools).test(tool.name)) {
    return false
  }
  for (const [argName, prefix] of Object.entries(rule.args ?? {})) {
    const value = args[argName]
    if (typeof value !== 'string' || !value.startsWith(prefix)) return false
  }
  return true
}

/** Copy every mutable layer so inspection cannot change a future verdict. */
function copyRule(rule: PermissionRule): PermissionRule {
  return { ...rule, ...(rule.args ? { args: { ...rule.args } } : {}) }
}

export class PermissionEngine {
  /**
   * The configured rules. Named to avoid clashing with the public rules()
   * accessor below (used by the /permissions REPL command and the GUI).
   */
  private readonly configured: PermissionRule[]
  private sessionAllows = new Set<string>()

  constructor(rules: PermissionRule[] = []) {
    this.configured = rules.map(copyRule)
  }

  /**
   * Evaluate permission rules for a tool call. Scan order: every deny
   * rule (first hit wins) → session grants → every allow rule → default.
   * A deny can never be overridden by a session grant or an allow rule;
   * no match at all means 'default' (the caller runs its own approval flow).
   */
  evaluate(tool: { name: string; kind: string }, args: Record<string, unknown>): PermissionVerdict {
    for (const rule of this.configured) {
      if (rule.effect === 'deny' && ruleMatches(rule, tool, args)) {
        return { outcome: 'deny', reason: `denied by permission rule${rule.reason ? ': ' + rule.reason : ''}`, rule: copyRule(rule) }
      }
    }
    if (this.sessionAllows.has(tool.name)) {
      return { outcome: 'allow', reason: 'allowed for session' }
    }
    for (const rule of this.configured) {
      if (rule.effect === 'allow' && ruleMatches(rule, tool, args)) {
        return { outcome: 'allow', reason: 'allowed by permission rule', rule: copyRule(rule) }
      }
    }
    return { outcome: 'default' }
  }

  /** "Always allow" button — remember this exact tool name for the process lifetime. */
  allowForSession(toolName: string): void {
    this.sessionAllows.add(toolName)
  }

  isSessionAllowed(toolName: string): boolean {
    return this.sessionAllows.has(toolName)
  }

  clearSessionAllows(): void {
    this.sessionAllows.clear()
  }

  /** Isolated snapshots of the loaded rules (for /permissions and the GUI). */
  rules(): PermissionRule[] {
    return this.configured.map(copyRule)
  }

  /** Tool names granted for this session by always-allow approvals. */
  sessionAllowed(): string[] {
    return [...this.sessionAllows]
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((v) => typeof v === 'string')
}

/** Parse raw config data into rules, skipping malformed entries with a console warning. */
export function parseRules(raw: unknown): PermissionRule[] {
  const rules: PermissionRule[] = []
  // Absent config is the normal case (no rules) — only a present-but-wrong
  // value is worth warning about, otherwise every harness pollutes stderr.
  if (raw === undefined || raw === null) return rules
  if (!Array.isArray(raw)) {
    console.warn('[permissions] rules config must be an array; ignoring it')
    return rules
  }
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      console.warn('[permissions] skipping permission rule: expected an object')
      continue
    }
    const rec = item as Record<string, unknown>
    const { effect, tools } = rec
    if (effect !== 'allow' && effect !== 'deny') {
      console.warn(
        `[permissions] skipping permission rule: effect must be "allow" or "deny" (got ${JSON.stringify(effect)})`,
      )
      continue
    }
    if (typeof tools !== 'string' || tools.trim() === '') {
      console.warn('[permissions] skipping permission rule: "tools" must be a non-empty glob string')
      continue
    }
    if (rec.args !== undefined && !isStringMap(rec.args)) {
      console.warn('[permissions] skipping permission rule: "args" must map argument names to string prefixes')
      continue
    }
    const rule: PermissionRule = { effect, tools }
    if (isStringMap(rec.args)) rule.args = { ...rec.args }
    if (typeof rec.reason === 'string') rule.reason = rec.reason
    rules.push(rule)
  }
  return rules
}
