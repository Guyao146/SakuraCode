/** Workspace memory tools use the normal read/write approval pipeline. */
import * as path from 'node:path'
import type { PluginModule } from '../kernel/index.js'
import { params, type ToolsService } from '../core/tools.js'
import type { SystemPromptService } from '../core/system-prompt.js'
import type { LLMRequest } from '../core/types.js'
import type { AgentsService } from '../core/agent.js'
import type { WorkspaceMemoryService } from '../plugins/workspace-memory.js'
import { activeMemoryContent } from '../plugins/memory-entries.js'

const MEMORY_TOOLS = new Set(['memory_read', 'memory_write'])

export const workspaceMemoryToolsPlugin: PluginModule = {
  name: 'tool-workspace-memory',
  description: 'Read and update durable workspace notes',
  inject: ['tools', 'workspaceMemory', 'systemPrompt'],
  apply(ctx, _config, toolsLike: unknown, memoryLike: unknown, promptLike: unknown) {
    const tools = toolsLike as ToolsService
    const memory = memoryLike as WorkspaceMemoryService
    const prompt = promptLike as SystemPromptService
    const disposers = [
      tools.register({
        name: 'memory_read', kind: 'read',
        description: 'Read this workspace\'s durable notes and revision before updating them. Available only when workspace memory is enabled.',
        parameters: params({}),
        execute: async () => {
          const saved = await memory.reload()
          if (!saved.enabled) return { output: 'error: workspace memory is disabled or unavailable', isError: true }
          return { output: JSON.stringify({ content: activeMemoryContent(saved), revision: saved.revision }) }
        },
      }),
      tools.register({
        name: 'memory_write', kind: 'write',
        description: 'Save the complete updated durable notes for this workspace. First use memory_read, preserve still-relevant notes, and pass its revision to avoid overwriting another agent\'s update. Save only confirmed long-term preferences and useful project facts, never credentials or transient task logs. Normal write approval applies.',
        parameters: params({ content: { type: 'string', description: 'The complete updated notes (maximum 16000 characters).' },
          revision: { type: 'integer', description: 'Revision returned by memory_read; a stale revision is rejected.' } }, ['content', 'revision']),
        execute: async (args, tc) => {
          if (ctx.peek<AgentsService>('agents')?.userOnlyMemory(tc.agentId)) return {
            output: 'error: expert mode memory is user-only; user adjustment requests are collected automatically, agent conclusions must not be written', isError: true,
          }
          const saved = await memory.update({ content: args.content as string }, args.revision as number,
            { requireEnabled: true, signal: tc.signal })
          return { output: `workspace memory saved (${saved.content.length} chars, revision ${saved.revision})` }
        },
      }),
      prompt.add('workspace-memory-tools', () => memory.status().enabled
        ? 'Workspace memory is enabled. Use memory_read/memory_write to remember confirmed, reusable project facts and user preferences when useful; do not save secrets, unverified guesses, or every conversation. Never enable memory yourself. Writes follow the current approval policy.' : '', 32),
    ]
    ctx.effect(() => () => disposers.forEach(dispose => dispose()))
    ctx.on('agent/request', (payload: { request: LLMRequest; agent: { id: string } }, next) => {
      if (!memory.status().enabled && payload.request.tools) {
        payload.request.tools = payload.request.tools.filter(tool => !MEMORY_TOOLS.has(tool.name))
      }
      if (ctx.peek<AgentsService>('agents')?.userOnlyMemory(payload.agent.id) && payload.request.tools) {
        payload.request.tools = payload.request.tools.filter(tool => tool.name !== 'memory_write')
      }
      return next(payload)
    })
    ctx.on('tools/pre-execute', (payload, next) => {
      if (MEMORY_TOOLS.has(payload.name) && !memory.status().enabled) {
        payload.blockedReason = 'workspace memory is disabled or unavailable'
        return payload
      }
      if (payload.name === 'memory_write' && ctx.peek<AgentsService>('agents')?.userOnlyMemory(payload.tc.agentId)) {
        payload.blockedReason = 'expert mode memory is user-only; agent utterances cannot become durable user preferences'
        return payload
      }
      const file = payload.args?.file_path
      if (ctx.peek<AgentsService>('agents')?.userOnlyMemory(payload.tc.agentId) && ['write', 'edit'].includes(payload.name) && typeof file === 'string') {
        const saved = memory.snapshot().path, root = path.resolve(path.dirname(saved), '..'), resolved = path.resolve(root, file)
        const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
        if ([saved, path.join(path.dirname(saved), 'workspace-memory.json')].some(target => normalize(path.resolve(target)) === normalize(resolved))) {
          payload.blockedReason = 'expert mode memory is user-only; use the automatic user-request collector instead of file writes'
          return payload
        }
      }
      return next(payload)
    }, { prepend: true })
  },
}