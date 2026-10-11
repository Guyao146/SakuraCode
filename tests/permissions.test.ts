/**
 * PermissionEngine — rule-based allow/deny evaluated before the classic
 * approval flow. Pure engine tests: no kernel, no IO, no approvals.
 */
import { describe, expect, it, vi } from 'vitest'
import { PermissionEngine, parseRules, type PermissionRule } from '../src/permissions/index.js'

const bash = { name: 'bash', kind: 'execute' }
const read = { name: 'read', kind: 'read' }
const write = { name: 'write', kind: 'write' }
const writeFile = { name: 'write_file', kind: 'write' }
const click = { name: 'computer_click', kind: 'execute' }

describe('PermissionEngine', () => {
  it('allows tools matched by an allow rule and defaults otherwise', () => {
    const engine = new PermissionEngine([{ effect: 'allow', tools: 'read' }])
    const verdict = engine.evaluate(read, {})
    expect(verdict.outcome).toBe('allow')
    expect(verdict.reason).toBe('allowed by permission rule')
    expect(verdict.rule).toEqual({ effect: 'allow', tools: 'read' })
    expect(engine.evaluate(bash, {}).outcome).toBe('default')
  })

  it('glob-matches tool names with *', () => {
    const engine = new PermissionEngine([{ effect: 'allow', tools: 'write*' }])
    expect(engine.evaluate(write, {}).outcome).toBe('allow')
    expect(engine.evaluate(writeFile, {}).outcome).toBe('allow')
    expect(engine.evaluate(bash, {}).outcome).toBe('default')
  })

  it('kind: prefixed rules match the whole class', () => {
    const engine = new PermissionEngine([{ effect: 'allow', tools: 'kind:execute' }])
    expect(engine.evaluate(bash, {}).outcome).toBe('allow')
    expect(engine.evaluate(click, {}).outcome).toBe('allow')
    expect(engine.evaluate(read, {}).outcome).toBe('default')
  })

  it('deny always beats allow regardless of rule order', () => {
    const allow = { effect: 'allow' as const, tools: 'bash' }
    const deny = { effect: 'deny' as const, tools: 'bash', reason: 'no shell' }
    expect(new PermissionEngine([allow, deny]).evaluate(bash, {})).toMatchObject({ outcome: 'deny' })
    const verdict = new PermissionEngine([deny, allow]).evaluate(bash, {})
    expect(verdict.outcome).toBe('deny')
    expect(verdict.reason).toBe('denied by permission rule: no shell')
  })

  it('prefix arg constraints narrow the match; non-string args never match', () => {
    const engine = new PermissionEngine([{ effect: 'deny', tools: 'bash', args: { command: 'rm ' } }])
    expect(engine.evaluate(bash, { command: 'rm -rf /' }).outcome).toBe('deny')
    expect(engine.evaluate(bash, { command: 'ls' }).outcome).toBe('default')
    expect(engine.evaluate(bash, { command: 42 }).outcome).toBe('default')

    // Every constraint must hold at once.
    const git = new PermissionEngine([{ effect: 'allow', tools: 'bash', args: { command: 'git ' } }])
    expect(git.evaluate(bash, { command: 'git push' }).outcome).toBe('allow')
    expect(git.evaluate(bash, { command: 'npm install' }).outcome).toBe('default')
  })

  it('session grants allow tools but never override deny rules', () => {
    const engine = new PermissionEngine()
    expect(engine.isSessionAllowed('bash')).toBe(false)
    engine.allowForSession('bash')
    expect(engine.isSessionAllowed('bash')).toBe(true)
    const granted = engine.evaluate(bash, {})
    expect(granted.outcome).toBe('allow')
    expect(granted.rule).toBeUndefined()
    engine.clearSessionAllows()
    expect(engine.isSessionAllowed('bash')).toBe(false)
    expect(engine.evaluate(bash, {}).outcome).toBe('default')

    const withDeny = new PermissionEngine([{ effect: 'deny', tools: 'bash' }])
    withDeny.allowForSession('bash')
    expect(withDeny.evaluate(bash, {}).outcome).toBe('deny')
  })

  it('returns on the first matching deny and keeps scanning when a deny misses', () => {
    const first = { effect: 'deny' as const, tools: 'bash', reason: 'first' }
    const second = { effect: 'deny' as const, tools: 'bash', reason: 'second' }
    const engine = new PermissionEngine([first, second, { effect: 'allow', tools: 'bash' }])
    const verdict = engine.evaluate(bash, {})
    expect(verdict.outcome).toBe('deny')
    expect(verdict.reason).toBe('denied by permission rule: first')
    expect(verdict.rule).toEqual(first)
    expect(verdict.rule).not.toBe(first) // callers receive an isolated rule snapshot

    // A non-matching deny does not shadow later rules.
    const scoped = new PermissionEngine([
      { effect: 'deny', tools: 'bash', args: { command: 'rm ' } },
      { effect: 'allow', tools: 'bash' },
    ])
    expect(scoped.evaluate(bash, { command: 'ls' }).outcome).toBe('allow')
  })

  it('copies configured rule objects and their argument constraints on construction', () => {
    const source: PermissionRule[] = [{ effect: 'deny', tools: 'bash', args: { command: 'rm ' }, reason: 'keep' }]
    const engine = new PermissionEngine(source)
    source[0]!.effect = 'allow'
    source[0]!.args!.command = 'git '
    source[0]!.reason = 'changed'
    source.push({ effect: 'allow', tools: '*' })

    engine.allowForSession('bash')
    expect(engine.evaluate(bash, { command: 'rm file' })).toMatchObject({
      outcome: 'deny',
      reason: 'denied by permission rule: keep',
    })
    expect(engine.evaluate(write, {}).outcome).toBe('default')
  })

  it('rules() returns independent snapshots including nested args', () => {
    const engine = new PermissionEngine([{ effect: 'deny', tools: 'bash', args: { command: 'rm ' } }])
    const rules = engine.rules()
    rules[0]!.effect = 'allow'
    rules[0]!.tools = 'read'
    rules[0]!.args!.command = 'git '
    rules.push({ effect: 'allow', tools: '*' })

    expect(engine.rules()).toEqual([{ effect: 'deny', tools: 'bash', args: { command: 'rm ' } }])
    expect(engine.evaluate(bash, { command: 'rm file' }).outcome).toBe('deny')
    expect(engine.evaluate(read, {}).outcome).toBe('default')
  })

  it.each(['allow', 'deny'] as const)('isolates the matched %s rule returned by evaluate()', (effect) => {
    const engine = new PermissionEngine([{ effect, tools: 'bash', args: { command: 'git ' } }])
    const verdict = engine.evaluate(bash, { command: 'git status' })
    verdict.rule!.effect = effect === 'allow' ? 'deny' : 'allow'
    verdict.rule!.args!.command = 'rm '

    expect(engine.evaluate(bash, { command: 'git status' }).outcome).toBe(effect)
    expect(engine.evaluate(bash, { command: 'rm file' }).outcome).toBe('default')
  })

  it('sessionAllowed() returns an independent grant list and does not weaken denies', () => {
    const engine = new PermissionEngine([{ effect: 'deny', tools: 'bash' }])
    engine.allowForSession('bash')
    engine.allowForSession('read')
    const granted = engine.sessionAllowed()
    granted.length = 0
    granted.push('write')

    expect(engine.sessionAllowed()).toEqual(['bash', 'read'])
    expect(engine.evaluate(bash, {}).outcome).toBe('deny')
    expect(engine.evaluate(read, {}).outcome).toBe('allow')
    expect(engine.evaluate(write, {}).outcome).toBe('default')
    engine.clearSessionAllows()
    expect(engine.sessionAllowed()).toEqual([])
  })

  it('parseRules does not retain the raw config argument map', () => {
    const raw = [{ effect: 'deny', tools: 'bash', args: { command: 'rm ' } }]
    const parsed = parseRules(raw)
    raw[0]!.args.command = 'git '
    expect(parsed[0]!.args).toEqual({ command: 'rm ' })
    parsed[0]!.args!.command = 'ls '
    expect(raw[0]!.args.command).toBe('git ')
  })

  it('parseRules skips malformed entries with a warning, without throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseRules(null)).toEqual([])
      expect(parseRules('rules')).toEqual([])
      expect(parseRules([{ tools: 'bash' }])).toEqual([]) // missing effect
      expect(parseRules([{ effect: 'deny' }])).toEqual([]) // missing tools
      expect(parseRules([{ effect: 'maybe', tools: 'bash' }])).toEqual([])
      expect(parseRules([{ effect: 'deny', tools: 'bash', args: { command: 1 } }])).toEqual([])
      expect(parseRules([42])).toEqual([])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('parseRules keeps well-formed rules', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(parseRules([])).toEqual([])
      expect(parseRules([{ effect: 'deny', tools: 'bash', args: { command: 'rm ' }, reason: 'danger' }])).toEqual([
        { effect: 'deny', tools: 'bash', args: { command: 'rm ' }, reason: 'danger' },
      ])
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
