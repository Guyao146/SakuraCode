/**
 * tool-subagent — subagent / list_subagent_models: delegate self-contained
 * work to a child agent with its own session, optionally in the background.
 * Companion control tools (list_agents / send_message / interrupt_agent)
 * live in tool-subagent-control.
 */

import type { PluginModule } from '../kernel/index.js'
import type { AgentsService, AgentHandle } from '../core/agent.js'
import type { ToolsService } from '../core/tools.js'
import { truncate } from './util.js'

export interface SubagentToolConfig {
  toolName?: string
}

function describeAgent(handle: AgentHandle): string {
  const lines = [
    `${handle.id} (${handle.name}) — status: ${handle.status}, session: ${handle.sessionId}, model: ${handle.model || 'default'}`,
    `  task: ${handle.meta.description ?? '(not recorded)'}`,
  ]
  if (handle.result) lines.push(`  last result: ${handle.result.slice(0, 200)}`)
  if (handle.error) lines.push(`  error: ${handle.error}`)
  return lines.join('\n')
}

export const subagentToolsPlugin: PluginModule<SubagentToolConfig> = {
  name: 'tool-subagent',
  description: 'subagent — delegate work to a child agent (multi-agent)',
  inject: ['tools', 'agents'],
  config: {
    type: 'object',
    properties: {
      toolName: {
        type: 'string',
        description: 'config-driven tool name (default "subagent"). Note: toolPolicyFilter excludes nesting by the default names — renaming changes nested-spawn policy.',
      },
    },
  },
  apply(ctx, config, toolsLike: unknown, agentsLike: unknown) {
    const tools = toolsLike as ToolsService
    const agents = agentsLike as AgentsService
    const toolName = config?.toolName ?? 'subagent'

    tools.register({
      name: toolName,
      description:
        'Delegate self-contained work to a subagent: a fresh agent with its own session, system ' +
        'prompt and toolset. Write a complete, unambiguous prompt — the subagent cannot see this ' +
        'conversation. Returns the subagent final message (or, with run_in_background, a handle ' +
        'you can message later).',
      kind: 'agent',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short label for the delegation, e.g. "explore auth module".' },
          prompt: { type: 'string', description: 'Complete task instructions for the subagent, including expected deliverable.' },
          agent: { type: 'string', description: 'Optional predefined agent type name (see the system prompt agent-defs list) — applies its model, toolset and system prompt.' },
          model: { type: 'string', description: 'Model id for the subagent (see list_subagent_models).' },
          run_in_background: { type: 'boolean', description: 'Run detached; interact later via send_message/list_agents.' },
        },
        required: ['description', 'prompt'],
      },
      execute: async (args) => {
        const description = String(args.description ?? '')
        const prompt = String(args.prompt ?? '')
        if (!prompt.trim()) return { output: 'error: prompt must be non-empty', isError: true }
        // Predefined agent type (core-agent-defs): model/tools/systemPrompt template.
        let defSystemPrompt: string | undefined
        let defModel: string | undefined
        let defTools: 'full' | 'core' | string[] | undefined
        const defName = args.agent ? String(args.agent) : ''
        if (defName) {
          const defs = ctx.peek<{
            list(): Array<{ name: string }>
            get(name: string): { name: string; model?: string; tools?: 'full' | 'core' | string[]; systemPrompt: string } | undefined
          }>('agentDefs')
          const def = defs?.get(defName)
          if (!def) {
            const known = defs?.list().map((d) => d.name).join(', ') || '(none)'
            return { output: `error: unknown agent type "${defName}" — known types: ${known}`, isError: true }
          }
          defSystemPrompt = def.systemPrompt
          defModel = def.model
          defTools = def.tools
        }
        const handle = agents.spawn({
          name: description ? `subagent(${description.slice(0, 40)})` : undefined,
          seed: prompt,
          model: args.model ? String(args.model) : defModel,
          tools: defTools ?? 'full',
          background: Boolean(args.run_in_background),
          meta: { description, ...(defName ? { agentType: defName } : {}), spawnedByTool: true },
          systemPrompt:
            (defSystemPrompt ? defSystemPrompt + '\n\n' : '') +
            `You are a subagent spawned to handle one delegated task: "${description}". ` +
            'Work autonomously with your tools; produce a clear, complete final message with the ' +
            'deliverable and any file paths you touched. You cannot see the parent conversation.',
        })
        if (args.run_in_background) {
          return { output: `started ${handle.id} (${handle.name}) in the background; use list_agents / send_message to interact` }
        }
        const result = await handle.wait()
        if (result.cancelled) return { output: `subagent ${handle.id} was interrupted.`, isError: true }
        const body = result.output || result.error || '(no output)'
        return { output: truncate(body), ui: { agentId: handle.id, steps: result.steps } }
      },
    })

    tools.register({
      name: 'list_subagent_models',
      description: 'List model ids that subagents can be spawned with.',
      kind: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const models = agents.listModels()
        if (!models.length) return { output: 'no models registered' }
        return {
          output: models
            .map((m) => `${m.model ?? '?'} (adapter: ${m.adapter}${m.default ? ', default' : ''})`)
            .join('\n'),
        }
      },
    })
  },
}

export const subagentControlPlugin: PluginModule = {
  name: 'tool-subagent-control',
  description: 'list_agents / send_message / interrupt_agent — steer running agents',
  inject: ['tools', 'agents'],
  apply(_ctx, _config, toolsLike: unknown, agentsLike: unknown) {
    const tools = toolsLike as ToolsService
    const agents = agentsLike as AgentsService

    tools.register({
      name: 'list_agents',
      description: 'List all agents in this harness with their status and sessions.',
      kind: 'read',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const list = agents.list()
        if (!list.length) return { output: 'no agents have been spawned' }
        return { output: list.map(describeAgent).join('\n') }
      },
    })

    tools.register({
      name: 'send_message',
      description: 'Deliver a message to another agent. If it is running, the message queues in its mailbox.',
      kind: 'agent',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Target agent id, e.g. "agent-2".' },
          message: { type: 'string', description: 'Message text.' },
          wait: { type: 'boolean', description: 'Wait for the agent to finish processing (default false).' },
        },
        required: ['agent_id', 'message'],
      },
      execute: async (args) => {
        const agentId = String(args.agent_id ?? '')
        const message = String(args.message ?? '')
        if (args.wait) {
          try {
            const result = await agents.sendMessage(agentId, message)
            return { output: result.output || result.error || '(no reply)' }
          } catch (error) {
            return { output: `error: ${(error as Error).message}`, isError: true }
          }
        }
        // Fire-and-forget: enqueue without awaiting the target's turn —
        // awaiting would deadlock when the target messages us back.
        try {
          agents.deliver(agentId, message)
          return { output: `delivered to ${agentId} (queued; check status with list_agents)` }
        } catch (error) {
          return { output: `error: ${(error as Error).message}`, isError: true }
        }
      },
    })

    tools.register({
      name: 'interrupt_agent',
      description: 'Interrupt a running agent, cancelling its current turn.',
      kind: 'agent',
      parameters: {
        type: 'object',
        properties: { agent_id: { type: 'string', description: 'Target agent id.' } },
        required: ['agent_id'],
      },
      execute: async (args) => {
        const ok = agents.interrupt(String(args.agent_id))
        return { output: ok ? `interrupted ${args.agent_id}` : `error: unknown agent "${args.agent_id}"`, isError: !ok }
      },
    })
  },
}
