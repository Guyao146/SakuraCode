/**
 * tests/computer.test.ts — computer use tools (Windows).
 *
 * Pure-function coverage for SendKeys escaping and key-chord mapping, one
 * REAL primary-screen screenshot (this machine has a desktop; the pipeline
 * was verified end-to-end), and the argument-validation / abort paths that
 * must reject BEFORE any process spawns — no real mouse or keyboard input is
 * ever injected by these tests.
 */

import { describe, expect, it } from 'vitest'
import { HarnessContext } from '../src/core/index.js'
import { ToolsService } from '../src/core/tools.js'
import type { ToolContext } from '../src/core/types.js'
import { computerToolsPlugin, escapeSendKeys, mapKey } from '../src/tools/computer.js'

// -- helpers ------------------------------------------------------------------

function mkTc(signal = new AbortController().signal): ToolContext {
  return { sessionId: 's', agentId: 'a', signal }
}

/** Minimal context: only the tools service, then mount the plugin under test. */
async function mkContext(): Promise<HarnessContext> {
  const ctx = new HarnessContext()
  ctx.provide('tools')
  ctx.set('tools', new ToolsService(ctx))
  await ctx.plugin(computerToolsPlugin)
  return ctx
}

let callSeq = 0
async function call(
  ctx: HarnessContext,
  name: string,
  args: Record<string, unknown>,
  tc: ToolContext = mkTc(),
): Promise<{ output: string; isError?: boolean; images?: string[] }> {
  callSeq++
  return ctx.tools.execute(`computer-${callSeq}`, name, JSON.stringify(args), tc)
}

// -- registration -------------------------------------------------------------

describe('computerToolsPlugin', () => {
  it('registers the six computer tools', async () => {
    const ctx = await mkContext()
    const names = ctx.tools.names().filter((n) => n.startsWith('computer_'))
    expect(names).toEqual([
      'computer_screenshot',
      'computer_click',
      'computer_move',
      'computer_scroll',
      'computer_type',
      'computer_key',
    ])
  })
})

// -- escapeSendKeys (pure) ------------------------------------------------------

describe('escapeSendKeys', () => {
  it('leaves plain text unchanged', () => {
    expect(escapeSendKeys('hello world 123')).toBe('hello world 123')
    expect(escapeSendKeys('café 你好 🌸')).toBe('café 你好 🌸')
  })

  it('escapes every SendKeys syntax character', () => {
    // a literal '}' must become '{}}' — an unescaped '}' would throw at runtime
    // (out-of-context group delimiter), so braces are escaped pairwise.
    expect(escapeSendKeys('a+b{c}')).toBe('a{+}b{{}c{}}')
    expect(escapeSendKeys('^%~()')).toBe('{^}{%}{~}{(}{)}')
  })

  it('keeps square brackets literal (not SendKeys syntax)', () => {
    expect(escapeSendKeys('arr[0] = b}')).toBe('arr[0] = b{}}')
  })
})

// -- mapKey (pure) --------------------------------------------------------------

describe('mapKey', () => {
  it('maps plain key names to SendKeys sequences', () => {
    expect(mapKey('enter')).toBe('{ENTER}')
    expect(mapKey('f5')).toBe('{F5}')
    expect(mapKey('win')).toBe('^{ESC}')
  })

  it('builds chords from modifiers in the order written', () => {
    expect(mapKey('ctrl+s')).toBe('^s')
    expect(mapKey('alt+tab')).toBe('%{TAB}')
    expect(mapKey('shift+tab')).toBe('+{TAB}')
    expect(mapKey('ctrl+shift+esc')).toBe('^+{ESC}')
  })

  it('throws on unknown or invalid keys', () => {
    expect(() => mapKey('banana')).toThrow(/unknown key/)
    expect(() => mapKey('win+r')).toThrow(/Windows key/)
    expect(() => mapKey('ctrl+a+b')).toThrow(/multiple non-modifier/)
    expect(() => mapKey('')).toThrow()
  })
})

// -- computer_screenshot (real capture) ------------------------------------------

describe('computer_screenshot', () => {
  it(
    'captures the real primary screen as a PNG data URL',
    async () => {
      const ctx = await mkContext()
      // The capture depends on real hardware and a freshly spawned
      // powershell.exe; under heavy machine load a call can fail transiently
      // (observed once: fast non-zero exit). Allow one retry before failing.
      let result!: Awaited<ReturnType<typeof call>>
      for (let attempt = 1; attempt <= 2; attempt++) {
        result = await call(ctx, 'computer_screenshot', { monitor: 'primary' })
        if (!result.isError) break
      }
      expect(result.isError).toBeFalsy()
      expect(result.images).toHaveLength(1)
      const img = result.images?.[0] ?? ''
      expect(img).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/)
      const b64 = img.slice(img.indexOf(',') + 1)
      expect(b64.length).toBeGreaterThan(1000)
      expect(result.output).toMatch(/screenshot \d+x\d+ \(primary\)/)
    },
    30_000,
  )
})

// -- validation paths (never spawn, never touch the real desktop) ----------------

describe('argument validation rejects before spawning', () => {
  it('computer_click rejects negative x', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_click', { x: -1, y: 10 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('x must be >= 0')
  })

  it('computer_click rejects negative y', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_click', { x: 10, y: -1 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('y must be >= 0')
  })

  it('computer_click rejects non-integer coordinates', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_click', { x: 1.5, y: 10 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('x must be an integer')
  })

  it('computer_click rejects a missing coordinate', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_click', { x: 10 })
    expect(result.isError).toBe(true)
    // The schema guard in core/tools.ts rejects before the tool runs, so the
    // message is the pipeline's uniform one rather than getInt's `${name} is required`.
    expect(result.output).toContain('missing required argument')
    expect(result.output).toContain('"y"')
  })

  it('computer_move rejects negative coordinates', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_move', { x: 0, y: -2 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('y must be >= 0')
  })

  it('computer_scroll rejects a negative x position', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_scroll', { amount: 1, x: -3, y: 0 })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('x must be >= 0')
  })

  it('computer_scroll requires an integer amount', async () => {
    const ctx = await mkContext()
    const missing = await call(ctx, 'computer_scroll', {})
    expect(missing.isError).toBe(true)
    expect(missing.output).toContain('amount is required')
    const fractional = await call(ctx, 'computer_scroll', { amount: 0.5 })
    expect(fractional.isError).toBe(true)
    expect(fractional.output).toContain('amount must be an integer')
  })

  it('computer_key rejects unknown keys without pressing anything', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_key', { key: 'banana' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('unknown key')
  })

  it('computer_type rejects empty text', async () => {
    const ctx = await mkContext()
    const result = await call(ctx, 'computer_type', { text: '' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('text must be a non-empty string')
  })

  it('an already-aborted signal short-circuits valid calls without spawning', async () => {
    const ctx = await mkContext()
    const controller = new AbortController()
    controller.abort()
    const result = await call(ctx, 'computer_click', { x: 10, y: 10 }, mkTc(controller.signal))
    expect(result.isError).toBe(true)
    expect(result.output).toContain('cancelled')
  })
})
