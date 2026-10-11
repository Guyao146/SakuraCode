/**
 * tests/tools-approval.test.ts — ToolsService.execute pipeline and the
 * ApprovalService gate across all four approval modes, plus fs tool behavior.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmpHarness } from './helpers.js'
import type { Harness } from '../src/harness.js'
import type { ToolsExecutePayload } from '../src/core/index.js'

let callSeq = 0

/** Drive ctx.tools.execute directly with a synthetic tool context. */
function call(ctx: Harness['ctx'], name: string, args: unknown): Promise<{ output: string; isError?: boolean }> {
  callSeq++
  return ctx.tools.execute(`call-${callSeq}`, name, JSON.stringify(args), {
    sessionId: 's',
    agentId: 'a',
    signal: new AbortController().signal,
  })
}

describe('tools/execute + approval gate', () => {
  it("mode 'default' without a confirm handler blocks bash/write/edit but allows read", async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'default' })
    const file = path.join(tmpDir, 'note.txt')
    await fs.writeFile(file, 'hello', 'utf8')

    for (const [name, args] of [
      ['bash', { command: 'echo hi' }],
      ['write', { file_path: file, content: 'nope' }],
      ['edit', { file_path: file, old_string: 'hello', new_string: 'bye' }],
    ] as const) {
      const result = await call(ctx, name, args)
      expect(result.output.startsWith('error:'), `${name}: ${result.output}`).toBe(true)
      expect(result.output).toContain('blocked')
      expect(result.isError).toBe(true)
    }
    // nothing was executed or written
    expect(await fs.readFile(file, 'utf8')).toBe('hello')

    const read = await call(ctx, 'read', { file_path: file })
    expect(read.isError).toBeFalsy()
    expect(read.output).toContain('hello')
  })

  it("mode 'yolo': write a new file without a prior read, then read it back", async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'yolo' })
    const file = path.join(tmpDir, 'fresh.txt')

    const write = await call(ctx, 'write', { file_path: file, content: 'alpha beta\ngamma delta' })
    expect(write.isError).toBeFalsy()
    expect(write.output).toContain('wrote 2 lines')
    expect(await fs.readFile(file, 'utf8')).toBe('alpha beta\ngamma delta')

    const read = await call(ctx, 'read', { file_path: file })
    expect(read.isError).toBeFalsy()
    expect(read.output).toContain('alpha beta')
    expect(read.output).toContain('gamma delta')
  })

  it("mode 'yolo': edit requires a prior read, enforces unique old_string, honors replace_all", async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'yolo' })
    const file = path.join(tmpDir, 'dup.txt')
    await fs.writeFile(file, 'one two one', 'utf8') // exists without a tool-side read

    // editing an existing file without a prior read errors
    const unregistered = await call(ctx, 'edit', { file_path: file, old_string: 'one', new_string: 'ONE' })
    expect(unregistered.output.startsWith('error:')).toBe(true)
    expect(unregistered.output).toContain('read')
    expect(await fs.readFile(file, 'utf8')).toBe('one two one')

    // after a read, the edit path opens up — but 'one' appears twice
    const read = await call(ctx, 'read', { file_path: file })
    expect(read.output).toContain('one two one')

    const nonUnique = await call(ctx, 'edit', { file_path: file, old_string: 'one', new_string: 'ONE' })
    expect(nonUnique.output.startsWith('error:')).toBe(true)
    expect(nonUnique.output).toContain('appears 2 times')
    expect(await fs.readFile(file, 'utf8')).toBe('one two one')

    const replaceAll = await call(ctx, 'edit', { file_path: file, old_string: 'one', new_string: 'ONE', replace_all: true })
    expect(replaceAll.isError).toBeFalsy()
    expect(replaceAll.output).toContain('edited')
    expect(await fs.readFile(file, 'utf8')).toBe('ONE two ONE')

    const unique = await call(ctx, 'edit', { file_path: file, old_string: 'two', new_string: '2' })
    expect(unique.isError).toBeFalsy()
    expect(await fs.readFile(file, 'utf8')).toBe('ONE 2 ONE')
  })

  it("mode 'plan' is read-only: write and bash blocked mentioning plan, read allowed", async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'plan' })
    const file = path.join(tmpDir, 'plan.txt')
    await fs.writeFile(file, 'visible', 'utf8')

    const write = await call(ctx, 'write', { file_path: file, content: 'nope' })
    expect(write.output.startsWith('error:')).toBe(true)
    expect(write.output).toContain('blocked')
    expect(write.output).toContain('plan mode is read-only')

    const bash = await call(ctx, 'bash', { command: 'echo hi' })
    expect(bash.output.startsWith('error:')).toBe(true)
    expect(bash.output).toContain('blocked')
    expect(bash.output).toContain('plan mode is read-only')
    expect(await fs.readFile(file, 'utf8')).toBe('visible')

    const read = await call(ctx, 'read', { file_path: file })
    expect(read.isError).toBeFalsy()
    expect(read.output).toContain('visible')
  })

  it("mode 'acceptEdits': write allowed, bash still blocked", async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'acceptEdits' })
    const file = path.join(tmpDir, 'accepted.txt')

    const write = await call(ctx, 'write', { file_path: file, content: 'edit me' })
    expect(write.isError).toBeFalsy()
    expect(write.output).toContain('wrote 1 lines')
    expect(await fs.readFile(file, 'utf8')).toBe('edit me')

    const bash = await call(ctx, 'bash', { command: 'echo hi' })
    expect(bash.output.startsWith('error:')).toBe(true)
    expect(bash.output).toContain('blocked')
    expect(bash.output).toContain('needs approval')
  })

  it('read: formats line numbers and honors offset/limit', async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'yolo' })
    const file = path.join(tmpDir, 'lines.txt')
    await fs.writeFile(file, 'l1\nl2\nl3', 'utf8')

    const full = await call(ctx, 'read', { file_path: file })
    expect(full.output.startsWith('1\t')).toBe(true)
    expect(full.output).toContain('2\tl2')
    expect(full.output).toContain('3\tl3')

    const window = await call(ctx, 'read', { file_path: file, offset: 2, limit: 1 })
    expect(window.output.startsWith('2\t')).toBe(true)
    expect(window.output).toContain('l2')
    expect(window.output).not.toContain('l3')
    expect(window.output).toContain('file has 3 lines')
  })

  it('unknown tool and invalid JSON args produce error outputs', async () => {
    const { ctx } = await tmpHarness({ approvalMode: 'yolo' })

    const unknown = await call(ctx, 'definitely_not_a_tool', {})
    expect(unknown.output.startsWith('error:')).toBe(true)
    expect(unknown.output).toContain('unknown tool')
    expect(unknown.isError).toBe(true)

    // invalid JSON argsRaw — exercised with a hand-written raw payload
    const raw = await ctx.tools.execute('call-raw', 'read', '{not json', {
      sessionId: 's',
      agentId: 'a',
      signal: new AbortController().signal,
    })
    expect(raw.output.startsWith('error:')).toBe(true)
    expect(raw.output).toContain('not valid JSON')
    expect(raw.isError).toBe(true)
  })

  it('tools/post-execute listeners can rewrite the output before it is returned', async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'yolo' })
    const file = path.join(tmpDir, 'shout.txt')
    await fs.writeFile(file, 'shout this', 'utf8')

    const dispose = ctx.on('tools/post-execute', (p: ToolsExecutePayload, next: (x?: ToolsExecutePayload) => Promise<ToolsExecutePayload>) => {
      if (typeof p.output === 'string') p.output = p.output.toUpperCase()
      return next(p)
    })
    try {
      const result = await call(ctx, 'read', { file_path: file })
      expect(result.isError).toBeFalsy()
      expect(result.output).toBe('1\tSHOUT THIS')
    } finally {
      dispose()
    }

    // the listener is reversible: output goes back to normal
    const after = await call(ctx, 'read', { file_path: file })
    expect(after.output).toBe('1\tshout this')
  })

  it('does not execute a tool if the turn is cancelled while waiting for approval', async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'default' })
    const controller = new AbortController()
    const file = path.join(tmpDir, 'cancelled-write.txt')
    ctx.approval.setConfirmHandler((request) => {
      expect(request.signal).toBe(controller.signal)
      controller.abort()
      return true // a late approval cannot revive an interrupted turn
    })
    const result = await ctx.tools.execute('cancelled-approval', 'write', JSON.stringify({ file_path: file, content: 'must not run' }), {
      agentId: 'a', sessionId: 's', signal: controller.signal,
    })
    expect(result).toMatchObject({ isError: true, output: 'error: cancelled' })
    await expect(fs.access(file)).rejects.toThrow()
  })

  it('rechecks cancellation after asynchronous execution middleware', async () => {
    const { ctx, tmpDir } = await tmpHarness({ approvalMode: 'yolo' })
    const controller = new AbortController()
    const file = path.join(tmpDir, 'cancelled-middleware.txt')
    const dispose = ctx.on('tools/execute', async (payload, next) => {
      await Promise.resolve()
      controller.abort()
      return next(payload)
    })
    try {
      const result = await ctx.tools.execute('cancelled-execute', 'write', JSON.stringify({ file_path: file, content: 'must not run' }), {
        agentId: 'a', sessionId: 's', signal: controller.signal,
      })
      expect(result).toMatchObject({ isError: true, output: 'error: cancelled' })
      await expect(fs.access(file)).rejects.toThrow()
    } finally { dispose() }
  })
})
