/**
 * ctx.mcp — the MCP client manager plugin, exercised against a fake stdio
 * MCP server (tests/fixtures/fake-mcp-server.mjs). No harness: the minimal
 * kernel is assembled from Context + toolsPlugin + mcpPlugin.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '../src/kernel/index.js'
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { mcpPlugin, type McpServerStatus, type McpService } from '../src/mcp/index.js'
import type { ToolContext } from '../src/core/types.js'

const fixture = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))

// Every test mounts its own kernel; dispose kills the spawned servers.
const contexts: Context[] = []
afterEach(() => {
  while (contexts.length) contexts.pop()?.dispose()
})

const makeTc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

async function mountMcp(servers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(mcpPlugin, { servers })
  return ctx
}

describe('mcpPlugin — stdio MCP client', () => {
  it('connects to a stdio MCP server and registers its tools', async () => {
    const ctx = await mountMcp({ demo: { command: process.execPath, args: [fixture] } })
    const mcp = ctx.get<McpService>('mcp')

    const status = mcp.status()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: 'demo', state: 'connected', toolCount: 2 })

    const tools = ctx.get<ToolsService>('tools')
    const echo = tools.get('mcp__demo__echo')
    expect(echo).toBeDefined()
    expect(echo!.kind).toBe('execute')
    expect(echo!.description).toBe('[mcp:demo] Echo back')
    expect(echo!.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    })

    expect(mcp.listTools()).toEqual([
      { server: 'demo', name: 'mcp__demo__echo', description: '[mcp:demo] Echo back' },
      { server: 'demo', name: 'mcp__demo__fail', description: '[mcp:demo] Always errors' },
    ])
  })

  it('executes an MCP tool through ctx.tools', async () => {
    const ctx = await mountMcp({ demo: { command: process.execPath, args: [fixture] } })
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c1', 'mcp__demo__echo', JSON.stringify({ text: 'hi' }), makeTc())
    expect(result.output).toBe('echo:hi')
    expect(result.isError).toBeFalsy()
  })

  it('surfaces MCP tool errors as isError results', async () => {
    const ctx = await mountMcp({ demo: { command: process.execPath, args: [fixture] } })
    const tools = ctx.get<ToolsService>('tools')

    const result = await tools.execute('c2', 'mcp__demo__fail', '{}', makeTc())
    expect(result.output).toBe('boom')
    expect(result.isError).toBe(true)
  })

  it('reconnects a server and re-registers its tools', async () => {
    const ctx = await mountMcp({ demo: { command: process.execPath, args: [fixture] } })
    const mcp = ctx.get<McpService>('mcp')

    await mcp.reconnect('demo')

    const status = mcp.status()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: 'demo', state: 'connected', toolCount: 2 })

    const tools = ctx.get<ToolsService>('tools')
    const result = await tools.execute('c1', 'mcp__demo__echo', JSON.stringify({ text: 'again' }), makeTc())
    expect(result.output).toBe('echo:again')
  })

  it('marks a crashed server as error, unregisters its tools and emits mcp/status', async () => {
    const ctx = await mountMcp({
      demo: { command: process.execPath, args: [fixture], env: { FAKE_SUICIDE_AFTER: '1' } },
    })
    const mcp = ctx.get<McpService>('mcp')
    const tools = ctx.get<ToolsService>('tools')

    const events: Array<{ server: McpServerStatus }> = []
    ctx.on('mcp/status', (payload: { server: McpServerStatus }) => {
      events.push(payload)
    })

    // First call succeeds; the second makes the fixture process.exit(1).
    const first = await tools.execute('c1', 'mcp__demo__echo', JSON.stringify({ text: 'one' }), makeTc())
    expect(first.output).toBe('echo:one')
    await tools.execute('c2', 'mcp__demo__echo', JSON.stringify({ text: 'two' }), makeTc())

    await vi.waitFor(
      () => {
        expect(mcp.status()[0]!.state).toBe('error')
      },
      { timeout: 10_000, interval: 50 },
    )

    const status = mcp.status()[0]!
    expect(status.error).toContain('server exited')
    expect(tools.get('mcp__demo__echo')).toBeUndefined()
    expect(events.some((e) => e.server.name === 'demo' && e.server.state === 'error')).toBe(true)
  })

  it('stopAll stops every server and unregisters its tools', async () => {
    const ctx = await mountMcp({ demo: { command: process.execPath, args: [fixture] } })
    const mcp = ctx.get<McpService>('mcp')
    const tools = ctx.get<ToolsService>('tools')

    await mcp.stopAll()

    const status = mcp.status()
    expect(status).toHaveLength(1)
    expect(status[0]).toMatchObject({ name: 'demo', state: 'stopped', toolCount: 0 })
    expect(tools.get('mcp__demo__echo')).toBeUndefined()
  })
})
