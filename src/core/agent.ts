/**
 * ctx.agents / ctx.agentLoop — the Agent interface and the default driver.
 *
 * Turn flow (aligns with dsh):
 *   turn/start → append user/message → for each step:
 *     agent/pre-step (waterfall; rejection closes the turn without a step)
 *     → step/start → assemble prompt + tool schemas → agent/request
 *     (prepareCall) → llm/stream → tool calls through the guarded pipeline
 *     → step/end → repeat until nothing is owed
 *   → agent/turn-stopping (serial) → turn/end
 *
 * Multi-agent: AgentsService.spawn() forks a child agent with its own
 * session (ctx.agents.create-style). Children run on the same loop, expose
 * a mailbox (send_message) and are interruptible.
 */

import type { Context } from '../kernel/index.js'
import type { HarnessContext } from './context.js'
import { SessionService } from './session.js'
import type { LLMService } from './llm.js'
import type { AssistantMessage, ChatMessage, StreamSummary, ToolCallId } from './types.js'

export interface TurnResult {
  output: string
  steps: number
  cancelled?: boolean
  error?: string
}

export interface AgentMeta {
  parentSession?: string
  parentAgent?: string
  description?: string
  /** 'main' marks the harness's primary agent; ui/* events carry main=true for it. */
  role?: 'main' | 'sub'
  [key: string]: unknown
}

export type ToolPolicy = 'full' | 'core' | string[]

export interface AgentCreateOptions {
  name?: string
  seed: string
  model?: string
  /** Extra prompt section scoped to this agent. */
  systemPrompt?: string
  /** 'full' keeps every tool; 'core' drops the subagent family; or an explicit allow-list. */
  tools?: ToolPolicy
  background?: boolean
  maxSteps?: number
  meta?: AgentMeta
  /**
   * Main-agent options: keep one session across turns (persistentSession)
   * or adopt an existing session (resumeSessionId). Subagents default to a
   * fresh session per turn.
   */
  autoStart?: boolean
  persistentSession?: boolean
  resumeSessionId?: string
}

export type AgentStatus = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentHandle {
  readonly id: string
  readonly name: string
  readonly sessionId: string
  readonly model: string
  readonly meta: AgentMeta
  status: AgentStatus
  result?: string
  error?: string
  turn(input: string, opts?: TurnOptions): Promise<TurnResult>
  /** Resolve when the agent is idle with an empty mailbox. */
  wait(): Promise<TurnResult>
  interrupt(): void
}

/** Optional per-turn extras (e.g. user-attached images as data URLs). */
export interface TurnOptions {
  images?: string[]
}

export interface AgentLoop {
  run(agent: AgentRuntime, session: { id: string }, input: string, signal: AbortSignal, opts?: TurnOptions): Promise<TurnResult>
}

/** What the loop needs from an agent; AgentsService builds this. */
export interface AgentRuntime {
  id: string
  name: string
  model: string
  systemPrompt?: string
  toolFilter?: (name: string) => boolean
  maxSteps: number
  meta: AgentMeta
}

// ---------------------------------------------------------------------------
// Default loop
// ---------------------------------------------------------------------------

const SUBAGENT_FAMILY = new Set(['subagent', 'list_subagent_models'])

export class DefaultAgentLoop implements AgentLoop {
  constructor(private ctx: HarnessContext) {}

  async run(agent: AgentRuntime, session: Sessionish, input: string, signal: AbortSignal, opts?: TurnOptions): Promise<TurnResult> {
    // turn/start — listeners may claim or rewrite the input; throw to reject the turn.
    let payload: { input: string; agent: AgentRuntime; session: Sessionish }
    try {
      payload = await this.ctx.waterfall('turn/start', async (p) => p, { input, agent, session })
    } catch (error) {
      const output = `turn rejected: ${(error as Error).message}`
      await session.append({ type: 'session/note', payload: { note: output } })
      return { output, steps: 0 }
    }
    input = payload.input

    await session.append({
      type: 'user/message',
      payload: { content: input, from: agent.meta.parentAgent, ...(opts?.images?.length ? { images: opts.images } : {}) },
    })

    this.ctx.emit('ui/turn/start', { agentId: agent.id, sessionId: session.id })
    const isMain = agent.meta.role === 'main'
    let steps = 0
    let lastText = ''
    let turnError: string | undefined
    let summary: StreamSummary | undefined
    const answered = new Set<string>()

    try {
      while (steps < agent.maxSteps) {
        // agent/pre-step — listeners may rewrite or reject; rejection closes the turn.
        const pre = await this.ctx.waterfall('agent/pre-step', async (p) => p, {
          agent,
          session,
          step: steps,
          blocked: false,
        })
        if (pre.blocked) break
        steps++
        this.ctx.emit('step/start', { agentId: agent.id, step: steps, sessionId: session.id })

        // Assemble request: prompt assembly (logged when changed) + tool schemas + frozen history.
        const system = await this.syncSystemPrompt(session, agent)
        const messages: ChatMessage[] = session.deriveMessages()
        if (messages[0]?.role === 'system') messages[0].content = system
        else messages.unshift({ role: 'system', content: system })

        const toolsSchemas = this.ctx.tools.schemas(agent.toolFilter)
        const thinking = this.ctx.llm.thinking
        const request = {
          model: agent.model,
          messages,
          tools: toolsSchemas,
          signal,
          ...(thinking !== 'off' ? { thinking } : {}),
        }

        // agent/request — prepareCall(); listeners may rewrite the request.
        const reqPayload = await this.ctx.waterfall('agent/request', async (p) => p, {
          agent,
          session,
          request,
        })

        // llm/stream — consume the model stream, accumulate the assistant message.
        summary = { text: '', toolCalls: [], durationMs: 0 }
        let thinkingText = ''
        const started = Date.now()
        const calls = new Map<number, ToolCallId>()
        for await (const chunk of this.ctx.llm.stream(reqPayload.request)) {
          if (signal.aborted) throw new CancellationError()
          if (chunk.type === 'text') {
            summary.text += chunk.delta
            this.ctx.emit('ui/text', {
              agentId: agent.id,
              sessionId: session.id,
              delta: chunk.delta,
              main: isMain,
            })
          } else if (chunk.type === 'thinking') {
            thinkingText += chunk.delta
            summary.thinking = thinkingText
            this.ctx.emit('ui/thinking', {
              agentId: agent.id,
              sessionId: session.id,
              delta: chunk.delta,
              main: isMain,
            })
          } else if (chunk.type === 'tool_call') {
            const existing = calls.get(chunk.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
            if (chunk.id) existing.id = chunk.id
            if (chunk.name) existing.function.name += chunk.name
            if (chunk.argsDelta) existing.function.arguments += chunk.argsDelta
            calls.set(chunk.index, existing)
          } else if (chunk.type === 'usage') {
            summary.usage = { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens }
          } else if (chunk.type === 'error') {
            throw new Error(chunk.error)
          } else if (chunk.type === 'done') {
            if (chunk.reason === 'cancelled') throw new CancellationError()
            if (chunk.reason === 'length') turnError = 'stopped: max output length reached'
          }
        }
        summary.durationMs = Date.now() - started
        summary.toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
        for (const call of summary.toolCalls) {
          if (!call.id) call.id = `${agent.id}-call-${steps}-${call.function.name}-${Math.random().toString(36).slice(2, 8)}`
        }

        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: summary.text || null,
          ...(summary.toolCalls.length ? { tool_calls: summary.toolCalls } : {}),
        }
        await session.append({ type: 'assistant/message', payload: { ...assistantMessage, stream: summary } })
        lastText = summary.text

        if (!summary.toolCalls.length) {
          this.ctx.emit('step/end', { agentId: agent.id, step: steps, sessionId: session.id })
          break // nothing is owed — the turn closes
        }

        // Execute each owed tool call through the guarded pipeline.
        for (const call of summary.toolCalls) {
          if (signal.aborted) throw new CancellationError()
          this.ctx.emit('ui/tool/call', {
            agentId: agent.id,
            sessionId: session.id,
            callId: call.id,
            name: call.function.name,
            argsRaw: call.function.arguments,
            main: isMain,
          })
          await session.append({
            type: 'tool/call',
            payload: { id: call.id, name: call.function.name, arguments: call.function.arguments },
          })
          const result = await this.ctx.tools.execute(call.id, call.function.name, call.function.arguments, {
            sessionId: session.id,
            agentId: agent.id,
            signal,
          })
          answered.add(call.id)
          await session.append({
            type: 'tool/result',
            payload: {
              id: call.id,
              name: call.function.name,
              output: result.output,
              isError: result.isError,
              durationMs: result.durationMs ?? 0,
              ...(result.images ? { images: result.images } : {}),
            },
          })
          this.ctx.emit('ui/tool/result', {
            agentId: agent.id,
            sessionId: session.id,
            callId: call.id,
            name: call.function.name,
            output: result.output,
            isError: result.isError,
            durationMs: result.durationMs ?? 0,
            ...(result.images ? { images: result.images } : {}),
            main: isMain,
          })
        }
        this.ctx.emit('step/end', { agentId: agent.id, step: steps, sessionId: session.id })
        if (turnError) break
      }

      // Text accompanying tool calls is not a final answer. Preserve a more
      // specific provider failure (e.g. length) when it coincides with the cap.
      if (!turnError && steps >= agent.maxSteps && (!lastText || summary?.toolCalls.length)) {
        turnError = `reached max steps (${agent.maxSteps}) without a final answer`
      }
    } catch (error) {
      // Reconcile any owed tool calls so the log never holds a dangling
      // assistant(tool_calls) without matching tool results — that would
      // make the session unopenable by the model API on the next turn.
      if (summary) {
        for (const call of summary.toolCalls) {
          if (answered.has(call.id)) continue
          await session.append({
            type: 'tool/result',
            payload: { id: call.id, name: call.function.name, output: 'error: turn ended before this call ran', isError: true, durationMs: 0 },
          })
        }
      }
      if (error instanceof CancellationError || (error as Error)?.name === 'AbortError') {
        await session.append({ type: 'assistant/attempt', payload: { error: 'cancelled' } })
        await this.serialStopping(agent, session)
        this.ctx.emit('turn/end', { agentId: agent.id, sessionId: session.id, cancelled: true })
        this.ctx.emit('ui/turn/end', { agentId: agent.id, sessionId: session.id, cancelled: true, main: isMain })
        return { output: lastText, steps, cancelled: true }
      }
      turnError = error instanceof Error ? error.message : String(error)
      await session.append({ type: 'assistant/attempt', payload: { error: turnError } })
      await this.serialStopping(agent, session)
      this.ctx.emit('turn/end', { agentId: agent.id, sessionId: session.id, error: turnError })
      this.ctx.emit('ui/turn/end', { agentId: agent.id, sessionId: session.id, error: turnError, main: isMain })
      return { output: lastText, steps, error: turnError }
    }

    // Non-throwing limits are failed attempts too. Persist the outcome before
    // stopping hooks and publish the same result the agents service receives.
    if (turnError) await session.append({ type: 'assistant/attempt', payload: { error: turnError } })
    const result: TurnResult = { output: lastText, steps, ...(turnError ? { error: turnError } : {}) }
    await this.serialStopping(agent, session)
    this.ctx.emit('turn/end', { agentId: agent.id, sessionId: session.id, ...result })
    this.ctx.emit('ui/turn/end', {
      agentId: agent.id,
      sessionId: session.id,
      ...result,
      ...(summary?.usage ? { usage: summary.usage } : {}),
      main: isMain,
    })
    return result
  }

  /** Assemble the system prompt; append a system/message when it changed. */
  private async syncSystemPrompt(session: Sessionish, agent: AgentRuntime): Promise<string> {
    const base = this.ctx.systemPrompt.assemble()
    const system = [base, agent.systemPrompt].filter((s) => s && s.trim()).join('\n\n')
    const lastSystem = [...session.events].reverse().find((e) => e.type === 'system/message')
    if (!lastSystem || (lastSystem.payload as { content: string }).content !== system) {
      await session.append({ type: 'system/message', payload: { content: system } })
    }
    return system
  }

  /** serial (agent/turn-stopping) with listener failures downgraded to kernel/error. */
  private async serialStopping(agent: AgentRuntime, session: Sessionish): Promise<void> {
    try {
      await this.ctx.serial('agent/turn-stopping', { agent, session })
    } catch (error) {
      this.ctx.emit('kernel/error', { event: 'agent/turn-stopping', error })
    }
  }
}

/** Structural subset of Session used by the loop (keeps tests light). */
export interface Sessionish {
  id: string
  events: ReadonlyArray<{ seq: number; time: string; type: string; payload: unknown }>
  append(event: import('./types.js').SessionEventPayload): Promise<unknown>
  deriveMessages(): ChatMessage[]
}

export class CancellationError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancellationError'
  }
}

// ---------------------------------------------------------------------------
// Agents service — multi-agent: create/fork, mailbox, interrupt
// ---------------------------------------------------------------------------

let agentSeq = 0

export class AgentsService {
  private agents = new Map<string, AgentEntry>()
  private defaultMaxSteps = 40
  private stopping = false

  constructor(
    private ctx: Context,
    private sessions: SessionService,
    private loop: AgentLoop,
    private config: { allowNestedSubagents?: boolean; maxSteps?: number; defaultModel?: string } = {},
  ) {
    if (config.maxSteps) this.defaultMaxSteps = config.maxSteps
  }

  spawn(opts: AgentCreateOptions): AgentHandle {
    if (this.stopping || this.ctx.isDisposed()) throw new Error('agents are stopping')
    const id = `agent-${++agentSeq}`
    const name = opts.name ?? `subagent-${id}`
    const meta: AgentMeta = opts.meta ?? {}
    const allowNested = this.config.allowNestedSubagents ?? false
    const toolFilter = toolPolicyFilter(opts.tools ?? 'full', allowNested, meta.role)
    const entry: AgentEntry = {
      handle: {
        id,
        name,
        sessionId: opts.resumeSessionId ?? '(creating…)',
        model: opts.model ?? this.config.defaultModel ?? '',
        meta,
        status: 'idle',
        turn: async (input: string, opts?: TurnOptions) => this.drive(entry, input, opts),
        wait: () => this.settle(entry),
        interrupt: () => entry.controller?.abort(),
      },
      opts,
      controller: null,
      generation: 0,
      chain: Promise.resolve({ output: '', steps: 0 }),
      toolFilter,
    }
    this.agents.set(id, entry)
    this.ctx.emit('agent/spawned', {
      agent: { id, name, role: meta.role ?? 'sub', status: 'idle', model: entry.handle.model, sessionId: entry.handle.sessionId },
    })

    // Kick off with the seed; the returned promise chain keeps background runs alive.
    if (opts.seed && opts.autoStart !== false) {
      void entry.handle.turn(opts.seed).catch(() => {})
    }
    return entry.handle
  }

  list(): AgentHandle[] {
    return [...this.agents.values()].map((e) => e.handle)
  }

  get(id: string): AgentHandle | undefined {
    return this.agents.get(id)?.handle
  }

  interrupt(id: string): boolean {
    const entry = this.agents.get(id)
    if (!entry?.controller) return false
    entry.controller.abort()
    return true
  }

  /** Fire-and-forget mailbox delivery: enqueue a turn without awaiting it. */
  deliver(id: string, message: string): void {
    const entry = this.agents.get(id)
    if (!entry) throw new Error(`unknown agent "${id}"`)
    void entry.handle.turn(`[message from parent] ${message}`).catch(() => {})
  }

  /** Mailbox: deliver a message; runs now if idle, queues otherwise. Resolves with that turn's result. */
  async sendMessage(id: string, message: string): Promise<TurnResult> {
    const entry = this.agents.get(id)
    if (!entry) throw new Error(`unknown agent "${id}"`)
    return entry.handle.turn(`[message from parent] ${message}`)
  }

  /** Abort every live agent and forget the roster (used on harness disposal and session switches). */
  disposeAll(): void {
    for (const entry of this.agents.values()) {
      entry.generation++
      entry.controller?.abort()
    }
    this.agents.clear()
  }

  /** Cancel running turns and queued mail, but retain sessions for a failed
   * workspace switch. No new agents or turns may start until all have settled. */
  async stopAll(): Promise<void> {
    this.stopping = true
    const entries = [...this.agents.values()]
    for (const entry of entries) {
      entry.generation++
      entry.controller?.abort()
    }
    try {
      await Promise.all(entries.map((entry) => entry.chain))
    } finally {
      this.stopping = false
    }
  }

  private emitStatus(handle: AgentHandle): void {
    this.ctx.emit('agent/status', {
      id: handle.id,
      status: handle.status,
      ...(handle.error ? { error: handle.error } : {}),
    })
  }

  listModels(): Array<{ adapter: string; model?: string; default: boolean }> {
    return this.ctx.peek<LLMService>('llm')?.listModels() ?? []
  }

  // ------------------------------------------------------------------

  /**
   * Mailbox semantics: turns are serialized through the entry's promise
   * chain — a turn issued while the agent is running queues behind it.
   */
  private drive(entry: AgentEntry, input: string, opts?: TurnOptions): Promise<TurnResult> {
    const generation = entry.generation
    if (this.stopping) return Promise.resolve({ output: '', steps: 0, cancelled: true })
    const run = async (): Promise<TurnResult> => {
      if (entry.generation !== generation || this.agents.get(entry.handle.id) !== entry || this.ctx.isDisposed()) {
        return { output: '', steps: 0, cancelled: true }
      }
      const handle = entry.handle
      delete handle.error
      handle.status = 'running'
      this.ctx.emit('agent/status', { id: handle.id, status: 'running' })
      // Fresh controller per turn: an interrupt cancels only the turn it
      // interrupted, and the agent stays usable afterwards.
      const controller = new AbortController()
      entry.controller = controller
      try {
        let session = entry.session
        if (!session) {
          session = entry.opts.resumeSessionId
            ? await this.sessions.open(entry.opts.resumeSessionId)
            : await this.sessions.create({
                agent: handle.name,
                model: handle.model,
                parentSession: handle.meta.parentSession,
                parentAgent: handle.meta.parentAgent,
              })
          if (entry.opts.persistentSession || entry.opts.resumeSessionId) entry.session = session
        }
        ;(handle as { sessionId: string }).sessionId = session.id
        if (!handle.meta.parentSession) (handle.meta as { parentSession?: string }).parentSession = session.id
        const runtime: AgentRuntime = {
          id: handle.id,
          name: handle.name,
          model: handle.model,
          systemPrompt: entry.opts.systemPrompt,
          toolFilter: entry.toolFilter,
          maxSteps: entry.opts.maxSteps ?? this.defaultMaxSteps,
          meta: handle.meta,
        }
        const result = await this.loop.run(runtime, session, input, controller.signal, opts)
        if (!result.error) handle.result = result.output
        if (result.cancelled) handle.status = 'cancelled'
        else if (result.error) {
          handle.status = 'error'
          handle.error = result.error
        } else handle.status = 'done'
        entry.last = result
        this.emitStatus(handle)
        return result
      } catch (error) {
        handle.status = 'error'
        handle.error = error instanceof Error ? error.message : String(error)
        entry.last = { output: '', steps: 0, error: handle.error }
        this.emitStatus(handle)
        return entry.last
      } finally {
        if (entry.controller === controller) entry.controller = null
      }
    }
    const next = entry.chain.then(run, run)
    entry.chain = next // run() never rejects; keep the mailbox chain alive
    return next
  }

  private settle(entry: AgentEntry): Promise<TurnResult> {
    return entry.chain.then(() => entry.last ?? { output: '', steps: 0 })
  }
}

interface AgentEntry {
  handle: AgentHandle & { sessionId: string }
  opts: AgentCreateOptions
  /** Controller of the in-flight turn only; null when idle (recreated per turn). */
  controller: AbortController | null
  generation: number
  chain: Promise<TurnResult>
  last?: TurnResult
  session?: Sessionish
  toolFilter: (name: string) => boolean
}

/**
 * Tool visibility policy. 'full' gives the main agent everything (including
 * the subagent family — delegation is the point); subagents get the family
 * only when allowNestedSubagents is on. 'core' drops the family for everyone;
 * an explicit array is an allow-list.
 */
export function toolPolicyFilter(policy: ToolPolicy, allowNested: boolean, role?: 'main' | 'sub'): (name: string) => boolean {
  if (Array.isArray(policy)) {
    const allow = new Set(policy)
    return (name) => allow.has(name)
  }
  if (policy === 'core') return (name) => !SUBAGENT_FAMILY.has(name)
  if (role === 'main') return () => true
  return allowNested ? () => true : (name) => !SUBAGENT_FAMILY.has(name)
}

/** Registers ctx.agents + ctx.agentLoop. */
export const agentPlugin = {
  name: 'core-agent',
  description: 'Agent interface, default turn/step loop and the multi-agent roster (ctx.agents / ctx.agentLoop)',
  inject: ['sessions'] as const,
  config: {
    type: 'object',
    properties: {
      maxSteps: { type: 'number', description: 'default per-turn step cap' },
      allowNestedSubagents: { type: 'boolean', description: 'let subagents spawn subagents' },
      defaultModel: { type: 'string', description: 'model used when an agent does not name one' },
    },
  } as const,
  apply(ctx: Context, config: { maxSteps?: number; allowNestedSubagents?: boolean; defaultModel?: string }, sessions: unknown) {
    ctx.provide('agentLoop')
    ctx.provide('agents')
    const loop = new DefaultAgentLoop(ctx as HarnessContext)
    const agentsService = new AgentsService(ctx, sessions as SessionService, loop, config)
    ctx.set('agentLoop', loop)
    ctx.set('agents', agentsService)
    // Unmounting the harness aborts every live turn.
    ctx.effect(() => () => agentsService.disposeAll())
  },
}
