/**
 * core-hooks — user shell hooks as kernel listeners. No harness: the kernel
 * is assembled from Context + toolsPlugin + a minimal tool family + hooksPlugin
 * (same style as tests/mcp.test.ts). Hook commands are cross-platform `node -e`
 * one-liners; spawned via shell:true they work identically on Windows and POSIX.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { hooksPlugin, type HookConfig } from '../src/hooks/index.js'
import type { ToolContext, ToolDefinition } from '../src/core/types.js'

// Every test mounts its own kernel; dispose unwinds listeners.
const contexts: Context[] = []
const tempDirs: string[] = []
afterEach(() => {
  while (contexts.length) contexts.pop()?.dispose()
  while (tempDirs.length) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

const makeTc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

/** Forward-slashed absolute path, safe to embed in a single-quoted JS string. */
const inlinePath = (p: string): string => p.replace(/\\/g, '/')

const newTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sakura-hooks-'))
  tempDirs.push(dir)
  return dir
}

interface Mounted {
  ctx: Context
  tools: ToolsService
  /** execution counter per tool name — a hook veto keeps it undefined */
  executions: Record<string, number>
}

async function mount(hooks?: HookConfig[]): Promise<Mounted> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(toolsPlugin)
  const tools = ctx.get<ToolsService>('tools')
  const executions: Record<string, number> = {}
  const simpleTool = (name: string): ToolDefinition => ({
    name,
    description: `test ${name} tool`,
    kind: name === 'write' ? 'write' : name === 'read' ? 'read' : 'execute',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      executions[name] = (executions[name] ?? 0) + 1
      return `${name}-ok`
    },
  })
  tools.register(simpleTool('write'))
  tools.register(simpleTool('read'))
  tools.register(simpleTool('bash'))
  await ctx.plugin(hooksPlugin, { hooks })
  return { ctx, tools, executions }
}

describe('hooksPlugin — user shell hooks', () => {
  it('pre-tool-call hook exiting 0 lets the tool run', async () => {
    const { tools, executions } = await mount([{ event: 'pre-tool-call', command: 'node -e "process.exit(0)"' }])

    const result = await tools.execute('c1', 'write', '{}', makeTc())
    expect(result.output).toBe('write-ok')
    expect(result.isError).toBeFalsy()
    expect(executions.write).toBe(1)
  })

  it('pre-tool-call hook exiting 1 vetoes matching tools only', async () => {
    const { tools, executions } = await mount([
      { event: 'pre-tool-call', matcher: 'write', command: 'node -e "process.exit(1)"' },
    ])

    const blocked = await tools.execute('c1', 'write', '{}', makeTc())
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain('rejected')
    expect(executions.write).toBeUndefined() // execute never ran

    const allowed = await tools.execute('c2', 'read', '{}', makeTc())
    expect(allowed.output).toBe('read-ok')
    expect(allowed.isError).toBeFalsy()
    expect(executions.read).toBe(1)
  })

  it('exposes SAKURA_TOOL_NAME and SAKURA_TOOL_ARGS to pre-tool-call hooks', async () => {
    const outFile = inlinePath(join(newTempDir(), 'env.txt'))
    const { tools } = await mount([
      {
        event: 'pre-tool-call',
        matcher: 'write',
        command: `node -e "require('fs').writeFileSync('${outFile}', process.env.SAKURA_TOOL_NAME + '|' + process.env.SAKURA_TOOL_ARGS)"`,
      },
    ])

    await tools.execute('c1', 'write', JSON.stringify({ path: 'a.md' }), makeTc())
    expect(readFileSync(outFile, 'utf8')).toBe('write|{"path":"a.md"}')
  })

  it('times out a stuck pre-tool-call hook and vetoes with a timeout reason', async () => {
    const { tools, executions } = await mount([
      { event: 'pre-tool-call', command: 'node -e "setTimeout(()=>{},10000)"', timeoutMs: 300 },
    ])

    const result = await tools.execute('c1', 'write', '{}', makeTc())
    expect(result.isError).toBe(true)
    expect(result.output).toContain('timeout')
    expect(executions.write).toBeUndefined()
  }, 15_000)

  it('post-tool-call hooks run after the tool and cannot corrupt its result', async () => {
    const outFile = inlinePath(join(newTempDir(), 'post.txt'))
    const { tools } = await mount([
      {
        event: 'post-tool-call',
        matcher: 'write',
        command: `node -e "require('fs').writeFileSync('${outFile}', 'post-ran')"`,
      },
      { event: 'post-tool-call', command: 'node -e "process.exit(1)"' },
    ])

    const result = await tools.execute('c1', 'write', '{}', makeTc())
    expect(result.output).toBe('write-ok') // exit-1 hook did not touch the result
    expect(result.isError).toBeFalsy()
    expect(existsSync(outFile)).toBe(true)
    expect(readFileSync(outFile, 'utf8')).toBe('post-ran')
  })

  it('mounts cleanly with empty or missing hooks config', async () => {
    const bare = await mount() // no config at all
    const empty = await mount([]) // empty list
    for (const { tools } of [bare, empty]) {
      const result = await tools.execute('c1', 'write', '{}', makeTc())
      expect(result.output).toBe('write-ok')
      expect(result.isError).toBeFalsy()
    }
  })

  it('matcher glob: write* matches write but not bash', async () => {
    const { tools, executions } = await mount([
      { event: 'pre-tool-call', matcher: 'write*', command: 'node -e "process.exit(1)"' },
    ])

    const write = await tools.execute('c1', 'write', '{}', makeTc())
    expect(write.isError).toBe(true)
    expect(write.output).toContain('rejected')

    const bash = await tools.execute('c2', 'bash', '{}', makeTc())
    expect(bash.output).toBe('bash-ok')
    expect(executions.bash).toBe(1)
  })

  it('turn-end hook fires on turn/end with SAKURA_TURN_ERROR', async () => {
    const outFile = inlinePath(join(newTempDir(), 'turnend.txt'))
    const { ctx } = await mount([
      {
        event: 'turn-end',
        command: `node -e "require('fs').writeFileSync('${outFile}', String(process.env.SAKURA_TURN_ERROR))"`,
      },
    ])

    ctx.emit('turn/end', { agentId: 'a', sessionId: 's', error: 'boom' })
    await vi.waitFor(() => expect(existsSync(outFile)).toBe(true), { timeout: 10_000, interval: 50 })
    expect(readFileSync(outFile, 'utf8')).toBe('boom')
  })

  it('session-start hook fires on ui/turn/start with the event name in env', async () => {
    const outFile = inlinePath(join(newTempDir(), 'sessionstart.txt'))
    const { ctx } = await mount([
      {
        event: 'session-start',
        command: `node -e "require('fs').writeFileSync('${outFile}', String(process.env.SAKURA_EVENT) + ':' + String(process.env.SAKURA_SESSION_ID))"`,
      },
    ])

    ctx.emit('ui/turn/start', { agentId: 'a', sessionId: 's' })
    await vi.waitFor(() => expect(existsSync(outFile)).toBe(true), { timeout: 10_000, interval: 50 })
    expect(readFileSync(outFile, 'utf8')).toBe('session-start:s')
  })
})
