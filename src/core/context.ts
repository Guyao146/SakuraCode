/**
 * HarnessContext — the Context subtype a running SakuraCode harness uses.
 * Adds typed service accessors (ctx.tools / ctx.llm / ctx.sessions
 * / ctx.agents / …) on top of the kernel's key-based registry. Plugin scopes
 * and forks are also HarnessContexts via createContext().
 */

import { Context, type Disposable } from '../kernel/index.js'
import type { AgentsService, DefaultAgentLoop } from './agent.js'
import type { ApprovalService } from './approval.js'
import type { LLMService } from './llm.js'
import type { SessionService } from './session.js'
import type { SystemPromptService } from './system-prompt.js'
import type { ToolsService } from './tools.js'

export class HarnessContext extends Context {
  /** Append-only session log. */
  get sessions(): SessionService {
    return this.get<SessionService>('sessions')
  }
  /** Optional per-turn filesystem preimages. */
  get checkpoints(): import('./checkpoints.js').CheckpointService | undefined {
    return this.peek<import('./checkpoints.js').CheckpointService>('checkpoints')
  }
  /** Model adapters / streaming. */
  get llm(): LLMService {
    return this.get<LLMService>('llm')
  }
  /** Tool registry + guarded pipeline. */
  get tools(): ToolsService {
    return this.get<ToolsService>('tools')
  }
  /** Prompt assembly. */
  get systemPrompt(): SystemPromptService {
    return this.get<SystemPromptService>('systemPrompt')
  }
  /** Permission gates. */
  get approval(): ApprovalService {
    return this.get<ApprovalService>('approval')
  }
  /** Multi-agent roster. */
  get agents(): AgentsService {
    return this.get<AgentsService>('agents')
  }
  /** Default turn/step driver. */
  get agentLoop(): DefaultAgentLoop {
    return this.get<DefaultAgentLoop>('agentLoop')
  }
  /** Background jobs registry (optional service). */
  get jobs(): import('./jobs.js').JobsService | undefined {
    return this.peek<import('./jobs.js').JobsService>('jobs')
  }
  /** MCP server manager (optional service — mounted by the mcp-manager plugin). */
  get mcp(): import('../mcp/index.js').McpService | undefined {
    return this.peek<import('../mcp/index.js').McpService>('mcp')
  }

  /** Mount a plugin and keep its disposers tracked on this context. */
  async use(plugin: Parameters<Context['plugin']>[0], config?: unknown): Promise<Disposable> {
    const scope = await this.plugin(plugin, config)
    return () => scope.dispose()
  }

  protected override createContext(parent?: Context): Context {
    return new HarnessContext(parent)
  }
}
