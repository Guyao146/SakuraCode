/**
 * tests/renderer.test.ts — the ui-renderer plugin driven directly: mounted
 * on a bare kernel Context and fed ui/* events with the same payload shapes
 * the agent loop emits (main:true/false explicit), with process.stdout
 * captured via a spy.
 */

import { Context } from '../src/kernel/index.js'
import { rendererPlugin, type RendererConfig } from '../src/plugins/renderer.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

// -- local helpers ------------------------------------------------------------

const restores: Array<() => void> = []

afterEach(() => {
  while (restores.length) restores.pop()?.()
})

interface MountedRenderer {
  ctx: Context
  /** Everything the renderer wrote to stdout so far, as a single string. */
  out: () => string
  /** Diagnostics must remain off headless stdout. */
  err: () => string
}

async function mountRenderer(config: RendererConfig): Promise<MountedRenderer> {
  const ctx = new Context()
  await ctx.plugin(rendererPlugin, config)

  const chunks: string[] = []
  const spy = vi.spyOn(process.stdout, 'write')
  spy.mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }) as typeof process.stdout.write)
  restores.push(() => spy.mockRestore())
  const errors: string[] = []
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errors.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'))
    return true
  }) as typeof process.stderr.write)
  restores.push(() => stderr.mockRestore())
  restores.push(() => ctx.dispose())

  return { ctx, out: () => chunks.join(''), err: () => errors.join('') }
}

// -- tests --------------------------------------------------------------------

describe('headless mode', () => {
  it('buffers main-agent text and flushes it exactly once at the main turn end', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'headless', color: false, showToolOutput: true })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'ANS', main: true })
    // Subagent output mid-turn: neither its text nor its turn end may print.
    ctx.emit('ui/text', { agentId: 'sub', delta: 'SUB', main: false })
    ctx.emit('ui/turn/end', { agentId: 'sub', main: false })
    expect(out()).toBe('')

    ctx.emit('ui/text', { agentId: 'a1', delta: 'WER', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })

    expect(out()).toBe('\nANSWER\n')
  })

  it('keeps thinking, tools and todos off stdout while preserving the final answer', async () => {
    const { ctx, out, err } = await mountRenderer({ mode: 'headless', color: false })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'private reasoning', main: true })
    ctx.emit('ui/thinking', { agentId: 'sub', delta: 'child reasoning', main: false })
    ctx.emit('ui/tool/call', { agentId: 'a1', name: 'read', argsRaw: '{"path":"file.ts"}', main: true })
    ctx.emit('ui/tool/result', { agentId: 'a1', name: 'read', output: 'file contents', main: true })
    ctx.emit('ui/todos', { todos: [{ id: '1', content: 'check changes', status: 'in_progress' }] })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'ANSWER', main: true })
    expect(out()).toBe('')

    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('\nANSWER\n')
    expect(err()).toContain('read(')
    expect(err()).toContain('file contents')
    expect(err()).toContain('check changes')
    expect(err()).not.toContain('reasoning')
  })

  it('sends interruption and error notices to stderr, not the headless answer stream', async () => {
    const { ctx, out, err } = await mountRenderer({ mode: 'headless', color: false })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'partial answer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', cancelled: true, error: 'boom', main: true })

    expect(out()).toBe('\npartial answer\n')
    expect(err()).toContain('[interrupted]')
    expect(err()).toContain('[error] boom')
  })

  it('does not flush an empty or whitespace-only answer at turn end', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'headless', color: false })

    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('')
  })

  it("keeps another agent's text out of the main answer even when it is mislabeled main", async () => {
    const { ctx, out } = await mountRenderer({ mode: 'headless', color: false })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'ANS', main: true })
    // Same turn, but the deltas come from a different agent and claim
    // main:true anyway (a mislabeling or third-party producer, or a helper
    // spawned with meta.role 'main'). The answer is bound to the agent that
    // produced it, so this text must never be printed on top of it.
    ctx.emit('ui/text', { agentId: 'sub', delta: 'SUB', main: true })
    ctx.emit('ui/turn/end', { agentId: 'sub', main: false })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'WER', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })

    expect(out()).toBe('\nANSWER\n')
  })

  it("a foreign turn end neither flushes nor clears the main agent's buffered answer", async () => {
    const { ctx, out } = await mountRenderer({ mode: 'headless', color: false })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'ANS', main: true })
    // No `main` flag on a turn end defaults to main, but the buffered text
    // belongs to a1: printing or dropping it here would split/truncate the
    // answer the main turn is still assembling.
    ctx.emit('ui/turn/end', { agentId: 'sub' })
    expect(out()).toBe('')

    ctx.emit('ui/text', { agentId: 'a1', delta: 'WER', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('\nANSWER\n')
  })
})

describe('repl mode', () => {
  it('streams each main-agent delta immediately and closes the turn with a newline', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'Hel', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'lo', main: true })
    expect(out()).toBe('Hello')

    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Hello\n')
  })

  it('a subagent turn end mid-turn writes nothing itself and streaming continues', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })

    ctx.emit('ui/text', { agentId: 'a1', delta: 'Hel', main: true })
    expect(out()).toBe('Hel')

    ctx.emit('ui/turn/end', { agentId: 'sub', main: false })
    expect(out()).toBe('Hel')

    ctx.emit('ui/text', { agentId: 'a1', delta: 'lo', main: true })
    expect(out()).toBe('Hello')
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Hello\n')
  })

  it('renders subagent errors inline with the subagent marker', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })

    ctx.emit('ui/turn/end', { agentId: 'sub', main: false, error: 'boom' })
    expect(out()).toBe('  [subagent error] boom\n')
  })
})

describe('thinking boundaries', () => {
  it('ignores subagent and unlabeled thinking rather than mixing it into the main stream', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })
    ctx.emit('ui/thinking', { agentId: 'sub', delta: 'child scratchpad', main: false })
    ctx.emit('ui/thinking', { agentId: 'unknown', text: 'unlabeled scratchpad' })
    expect(out()).toBe('')
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Answer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Answer\n')
  })

  it.each([false, true])('separates streamed thinking from the final answer (color=%s)', async (color) => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'Think', main: true })
    ctx.emit('ui/thinking', { agentId: 'a1', text: 'ing', main: true })
    ctx.emit('ui/turn/end', { agentId: 'sub', main: false })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Ans', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'wer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    const plain = out().replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain).toBe('Thinking\nAnswer\n')
    if (color) expect(out()).toContain('\x1b[2m')
  })

  it('closes a thinking-only turn and resets before the next answer', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'Thinking', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Answer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Thinking\nAnswer\n')
  })

  it('does not add a blank line when the thinking chunk already ends with a newline', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'Thinking\n', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Answer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Thinking\nAnswer\n')
  })

  it('starts tool output and later thinking on separate lines', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false, showToolOutput: false })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'Thinking', main: true })
    ctx.emit('ui/tool/call', { agentId: 'a1', name: 'read', argsRaw: '{}', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Answer', main: true })
    ctx.emit('ui/thinking', { agentId: 'a1', delta: 'More thinking', main: true })
    ctx.emit('ui/text', { agentId: 'a1', delta: 'Final answer', main: true })
    ctx.emit('ui/turn/end', { agentId: 'a1', main: true })
    expect(out()).toBe('Thinking\n● read()\nAnswer\nMore thinking\nFinal answer\n')
  })
})

describe('tool lines', () => {
  it("renders '● name(args)' for calls and '  ⎿ first-line' for results (color off)", async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false, showToolOutput: true })

    ctx.emit('ui/tool/call', { agentId: 'a1', name: 'bash', argsRaw: '{"command":"echo hi"}', main: true })
    expect(out()).toBe('● bash(command: echo hi)\n')

    ctx.emit('ui/tool/result', { agentId: 'a1', name: 'bash', output: 'hi\n[exit code: 0]', main: true })
    expect(out()).toBe('● bash(command: echo hi)\n  ⎿ hi\n')
  })

  it('showToolOutput:false suppresses result lines but keeps call lines', async () => {
    const { ctx, out } = await mountRenderer({ mode: 'repl', color: false, showToolOutput: false })

    ctx.emit('ui/tool/call', { agentId: 'a1', name: 'bash', argsRaw: '{"command":"echo hi"}', main: true })
    ctx.emit('ui/tool/result', { agentId: 'a1', name: 'bash', output: 'hi\n[exit code: 0]', main: true })

    expect(out()).toBe('● bash(command: echo hi)\n')
  })
})
