/**
 * ctx.agents / ctx.agentLoop — the Agent interface and the default driver.
 *
 * Turn flow:
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
import type { AssistantMessage, ChatMessage, CheckpointTarget, StreamSummary, ToolCallId, TurnMetrics } from './types.js'
import { storeChatFiles, type ChatUploadFile, type StoredChatFiles } from './attachments.js'
import { estimateRequestContextTokens } from '../util/context.js'
import { TurnMeter } from '../util/turn-metrics.js'

export interface TurnResult {
  output: string
  steps: number
  cancelled?: boolean
  error?: string
  metrics?: TurnMetrics
  userSeq?: number
}

export interface AgentMeta {
  checkpoint?: CheckpointTarget
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

/** Explicit per-turn images/files; file bytes are saved in this agent's own session. */
export interface TurnOptions {
  /** Internal edit retry: continue a persisted final user message exactly once. */
  resumeUserSeq?: number
  originalText?: string
  checkpoint?: CheckpointTarget
  images?: string[]
  files?: readonly ChatUploadFile[]
  /** HTTP uploads are fully saved before acceptance, including queued turns. */
  preparedFiles?: StoredChatFiles
  /** Internal provenance: generated summaries and mailbox traffic are never user memory. */
  source?: 'user' | 'agent' | 'expert-summary'
  from?: string
  expertMode?: boolean
  teamSize?: number
  /** Local accounting group; checkpoints propagate it to delegated mailbox turns. */
  turnGroup?: string
  /** Fan-out waits only for the one canonical user write, never for the main reply. */
  sharedUser?: Promise<{ sessionId: string; userSeq: number } | undefined>
  onUserMessage?: (record: { sessionId: string; userSeq: number }) => void
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
  sharedContext?: { session: Sessionish; userSeq?: number; mirroredUser: boolean }
}

// ---------------------------------------------------------------------------
// Default loop
// ---------------------------------------------------------------------------

const SUBAGENT_FAMILY = new Set(['subagent', 'list_subagent_models'])
const EXPERT_MEMORY_NOTE = '专家协作的长期记忆仅采集用户明确提出的调整方向，不记成员发言、工具输出或自行推导的结论。不要尝试通过 memory_write、命令或文件工具写记忆；用户仍可在设置中手动管理。'

export class DefaultAgentLoop implements AgentLoop {
  constructor(private ctx: HarnessContext) {}

  async run(agent: AgentRuntime, session: Sessionish, input: string, signal: AbortSignal, opts?: TurnOptions): Promise<TurnResult> {
    const meter = new TurnMeter()
    if (opts?.resumeUserSeq !== undefined) {
      const last = session.events.at(-1)
      const claimed = last?.type === 'session/note' && (last.payload as { note?: string; userSeq?: number }).note === 'generation-start' &&
        (last.payload as { userSeq?: number }).userSeq === opts.resumeUserSeq
      const user = session.events.find(record => record.seq === opts.resumeUserSeq)
      if (!claimed || !user || user.type !== 'user/message') throw new Error('编辑后的消息已改变，未重复生成。')
    }
    // turn/start — listeners may claim or rewrite the input; throw to reject the turn.
    let payload: { input: string; agent: AgentRuntime; session: Sessionish }
    try {
      payload = await this.ctx.waterfall('turn/start', async (p) => p, { input, agent, session })
      if (opts?.resumeUserSeq !== undefined && payload.input !== input) throw new Error('编辑消息已经保存；插件不能在重新生成时再次改写它，请发送新消息。')
    } catch (error) {
      await opts?.preparedFiles?.remove()
      const output = `turn rejected: ${(error as Error).message}`
      await session.append({ type: 'session/note', payload: { note: output } })
      const metrics = meter.finish('rejected')
      this.ctx.emit('ui/turn/end', { agentId: agent.id, sessionId: session.id, error: output, metrics, main: agent.meta.role === 'main' })
      return { output, steps: 0, error: output, metrics }
    }
    input = payload.input

    if (opts?.files?.length && !session.dir) throw new Error('附件需要可持久保存的会话目录。')
    if (opts?.files?.length) signal.throwIfAborted()
    const uploaded = opts?.preparedFiles ?? (opts?.files?.length ? await storeChatFiles(session.dir!, opts.files) : undefined)
    const images = [...(opts?.images ?? []), ...(uploaded?.images ?? [])]
    let userSeq = opts?.resumeUserSeq
    try {
      if (uploaded) signal.throwIfAborted()
      if (userSeq === undefined) {
        const record = await session.append({
          type: 'user/message',
          payload: { content: input + (uploaded?.context ?? ''), originalText: opts?.originalText,
            from: opts?.from ?? agent.meta.parentAgent, source: opts?.source ?? (agent.meta.parentAgent ? 'agent' : 'user'),
            ...(opts?.expertMode || agent.meta.expertContext ? { expertMode: true } : {}),
            ...(images.length ? { images } : {}), ...(uploaded ? { attachments: uploaded.attachments } : {}) },
        }) as { seq?: number } | undefined
        userSeq = record?.seq
      }
    } catch (error) { await uploaded?.remove(); throw error }

    if (userSeq !== undefined) opts?.onUserMessage?.({ sessionId: session.id, userSeq })
    let publishedSeq = agent.sharedContext?.mirroredUser ? userSeq ?? 0 : (userSeq ?? 1) - 1
    const publish = async (metrics?: TurnMetrics): Promise<void> => {
      const shared = agent.sharedContext
      if (!shared || userSeq === undefined) return
      const lastSeq = session.events.at(-1)?.seq ?? publishedSeq
      const messages = metrics ? [] : session.deriveMessages({ fromSeq: publishedSeq + 1, committedOnly: true }).filter(message => message.role !== 'system')
      if (!messages.length && !metrics) return
      await shared.session.append({ type: 'collaboration/message', payload: {
        key: `${session.id}:${userSeq}:${metrics ? 'end' : lastSeq}`, agentId: agent.id, agentName: agent.name,
        ...(typeof agent.meta.expert === 'string' ? { expert: agent.meta.expert } : {}), sourceSessionId: session.id,
        turnSeq: userSeq, userSeq: shared.userSeq, messages, ...(metrics ? { metrics } : {}),
      } })
      if (!metrics) publishedSeq = lastSeq
    }
    const finish = async (result: TurnResult): Promise<TurnResult> => {
      await publish()
      await this.serialStopping(agent, session)
      const metrics = meter.finish(result.cancelled ? 'cancelled' : result.error ? 'error' : 'done')
      const completed = { ...result, userSeq, metrics }
      await session.append({ type: 'session/note', payload: { note: 'turn-summary', userSeq, metrics,
        ...(opts?.teamSize ? { teamSize: opts.teamSize } : {}) } })
      await publish(metrics)
      this.ctx.emit('turn/end', { agentId: agent.id, sessionId: session.id, ...completed })
      this.ctx.emit('ui/turn/end', { agentId: agent.id, sessionId: session.id, ...completed,
        ...(meter.usage ? { usage: meter.usage } : {}), ...(opts?.teamSize ? { teamSize: opts.teamSize } : {}), main: agent.meta.role === 'main' })
      return completed
    }

    const checkpoint = opts?.checkpoint ?? (agent.sharedContext?.userSeq !== undefined ?
      { sessionId: agent.sharedContext.session.id, turnSeq: agent.sharedContext.userSeq } : undefined) ??
      (Number.isSafeInteger(userSeq) ? { sessionId: session.id, turnSeq: userSeq! } : undefined)
    this.ctx.emit('ui/turn/start', { agentId: agent.id, sessionId: session.id, userSeq, originalText: opts?.originalText,
      startedAt: meter.startedAt, ...(opts?.teamSize ? { teamSize: opts.teamSize } : {}), main: agent.meta.role === 'main' })
    const isMain = agent.meta.role === 'main'
    let steps = 0
    let lastText = ''
    let turnError: string | undefined
    let summary: StreamSummary | undefined
    let assistantLogged = false
    let inputEstimate = 0
    let attemptAccounted = false
    let activeCalls = new Map<number, ToolCallId>()
    let attemptStarted = 0
    const answered = new Set<string>()

    try {
      while (steps < agent.maxSteps) {
        if (signal.aborted) throw new CancellationError()
        summary = undefined
        assistantLogged = false
        attemptAccounted = false
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
        const shared = agent.sharedContext
        const throughSeq = shared?.session.events.at(-1)?.seq
        const messages: ChatMessage[] = shared ? [
          ...shared.session.deriveMessages({ userSeq: shared.userSeq, throughSeq, committedOnly: true }),
          ...session.deriveMessages({ fromSeq: publishedSeq + 1, committedOnly: true }).filter(message => message.role !== 'system'),
        ] : session.deriveMessages()
        if (shared) await session.append({ type: 'session/note', payload: { note: 'expert-context', contextSessionId: shared.session.id,
          throughSeq, userSeq: shared.userSeq, ownFromSeq: publishedSeq + 1, step: steps } })
        if (messages[0]?.role === 'system') messages[0].content = system
        else messages.unshift({ role: 'system', content: system })

        const toolsSchemas = this.ctx.tools.schemas(agent.toolFilter)
        const thinking = this.ctx.llm.thinking
        const request = {
          model: agent.model,
          messages,
          tools: toolsSchemas,
          signal,
          retryContext: { agentId: agent.id, sessionId: session.id, main: isMain },
          ...(thinking !== 'off' ? { thinking } : {}),
        }

        // agent/request — prepareCall(); listeners may rewrite the request.
        const reqPayload = await this.ctx.waterfall('agent/request', async (p) => p, {
          agent,
          session,
          request,
        })
        inputEstimate = estimateRequestContextTokens(reqPayload.request.messages, reqPayload.request.tools ?? [])

        // llm/stream — consume the model stream, accumulate the assistant message.
        summary = { text: '', toolCalls: [], durationMs: 0 }
        let thinkingText = ''
        let started = Date.now()
        const calls = new Map<number, ToolCallId>()
        activeCalls = calls; attemptStarted = started
        for await (const chunk of this.ctx.llm.stream(reqPayload.request)) {
          if (signal.aborted) throw new CancellationError()
          if (chunk.type === 'reset') {
            summary.durationMs = Date.now() - started
            summary.toolCalls = [...calls.values()]
            meter.attempt(summary, inputEstimate, true)
            await session.append({ type: 'assistant/attempt', payload: { error: chunk.error, stream: { ...summary }, retry: true } })
            summary = { text: '', toolCalls: [], durationMs: 0 }
            thinkingText = ''
            calls.clear()
            attemptAccounted = false
            started = Date.now()
            attemptStarted = started
            this.ctx.emit('ui/stream/reset', { agentId: agent.id, sessionId: session.id, main: isMain })
          } else if (chunk.type === 'text') {
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
            summary.usage ??= {}
            for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'reasoningTokens'] as const) {
              if (typeof chunk[field] === 'number' && Number.isFinite(chunk[field]) && chunk[field]! >= 0) summary.usage[field] = chunk[field]
            }
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
        meter.attempt(summary, inputEstimate)
        attemptAccounted = true

        const assistantMessage: AssistantMessage = {
          role: 'assistant',
          content: summary.text || null,
          ...(summary.toolCalls.length ? { tool_calls: summary.toolCalls } : {}),
        }
        await session.append({ type: 'assistant/message', payload: { ...assistantMessage, stream: summary } })
        assistantLogged = true
        lastText = summary.text

        if (!summary.toolCalls.length) {
          await publish()
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
            checkpoint,
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
          if (signal.aborted) throw new CancellationError()
        }
        await publish()
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
        if (!assistantLogged) { summary.toolCalls = [...activeCalls.values()]; summary.durationMs = Date.now() - attemptStarted }
        if (!attemptAccounted) { meter.attempt(summary, inputEstimate); attemptAccounted = true }
        for (const call of assistantLogged ? summary.toolCalls : []) {
          if (answered.has(call.id)) continue
          await session.append({
            type: 'tool/result',
            payload: { id: call.id, name: call.function.name, output: 'error: turn ended before this call ran', isError: true, durationMs: 0 },
          })
        }
      }
      if (error instanceof CancellationError || (error as Error)?.name === 'AbortError') {
        await session.append({ type: 'assistant/attempt', payload: { error: 'cancelled', ...(!assistantLogged && summary ? { stream: summary } : {}) } })
        return finish({ output: lastText, steps, cancelled: true })
      }
      turnError = this.ctx.llm.redactError(error instanceof Error ? error.message : String(error))
      await session.append({ type: 'assistant/attempt', payload: { error: turnError, ...(!assistantLogged && summary ? { stream: summary } : {}) } })
      return finish({ output: lastText, steps, error: turnError })
    }

    // Non-throwing limits are failed attempts too. Persist the outcome before
    // stopping hooks and publish the same result the agents service receives.
    if (turnError) await session.append({ type: 'assistant/attempt', payload: { error: turnError } })
    const result: TurnResult = { output: lastText, steps, ...(turnError ? { error: turnError } : {}) }
    return finish(result)
  }

  /** Assemble the system prompt; append a system/message when it changed. */
  private async syncSystemPrompt(session: Sessionish, agent: AgentRuntime): Promise<string> {
    const base = this.ctx.systemPrompt.assemble()
    const system = [base, agent.systemPrompt, agent.meta.expertContext ? EXPERT_MEMORY_NOTE : ''].filter((s) => s && s.trim()).join('\n\n')
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
  dir?: string
  events: ReadonlyArray<{ seq: number; time: string; type: string; payload: unknown }>
  append(event: import('./types.js').SessionEventPayload): Promise<unknown>
  deriveMessages(options?: { fromSeq?: number; throughSeq?: number; userSeq?: number; committedOnly?: boolean }): ChatMessage[]
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
  private turnGroups = new Map<string, string>()
  private turnSeq = 0
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
    if (meta.parentAgent && this.userOnlyMemory(meta.parentAgent)) meta.expertContext = true
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
      pendingTurns: 0,
      chain: Promise.resolve({ output: '', steps: 0 }),
      toolFilter,
    }
    this.agents.set(id, entry)
    this.ctx.emit('agent/spawned', {
      agent: { id, name, role: meta.role ?? 'sub', status: 'idle', model: entry.handle.model, sessionId: entry.handle.sessionId },
    })

    // Kick off with the seed; the returned promise chain keeps background runs alive.
    if (opts.seed && opts.autoStart !== false) {
      void entry.handle.turn(opts.seed, meta.checkpoint ? { checkpoint: meta.checkpoint } : undefined).catch(() => {})
    }
    return entry.handle
  }

  list(): AgentHandle[] {
    return [...this.agents.values()].map((e) => e.handle)
  }

  get(id: string): AgentHandle | undefined {
    return this.agents.get(id)?.handle
  }

  /** One canonical context for a session's expert roster; archival sessions remain independent. */
  shareExpertContext(mainId: string, memberIds: readonly string[]): void {
    const main = this.agents.get(mainId)
    if (!main || main.handle.meta.role !== 'main') throw new Error('Expert context requires the current main agent')
    main.handle.meta.expertContext = true
    for (const id of memberIds) {
      const member = this.agents.get(id)
      if (!member || member.handle.meta.role !== 'sub' || !member.handle.meta.expert) throw new Error('Only explicit expert members may share context')
      member.sharedMainId = mainId
      member.handle.meta.expertContext = true
    }
  }

  /** Closing fan-out does not detach accepted peer turns or discard their shared evidence. */
  setExpertMemoryMode(mainId: string, enabled: boolean): void {
    const main = this.agents.get(mainId)
    if (main) main.handle.meta.expertContext = enabled
  }

  userOnlyMemory(id: string): boolean {
    const entry = this.agents.get(id)
    return !!entry && (entry.memoryUserOnly === true || entry.handle.meta.expertContext === true)
  }

  releaseTurnGroup(id: string): void {
    for (const [key, group] of this.turnGroups) if (group === id) this.turnGroups.delete(key)
  }

  /** Save explicit HTTP files without starting a model turn. Caller can roll
   * back all team copies if any member fails before the message is accepted. */
  async prepareFiles(id: string, files: readonly ChatUploadFile[]): Promise<StoredChatFiles> {
    const entry = this.agents.get(id)
    if (!entry || this.stopping || this.ctx.isDisposed()) throw new Error('智能体会话已关闭，附件未提交。')
    const generation = entry.generation
    const session = await this.openSession(entry)
    const prepared = await storeChatFiles(session.dir!, files)
    if (this.agents.get(id) !== entry || entry.generation !== generation || this.ctx.isDisposed()) {
      await prepared.remove(); throw new Error('智能体会话已改变，附件未提交。')
    }
    return prepared
  }

  /** Coalesce creation for concurrent first-message uploads and mailbox turns. */
  private async openSession(entry: AgentEntry): Promise<Sessionish> {
    if (entry.session) return entry.session
    const create = async (): Promise<Sessionish> => {
      const handle = entry.handle
      const session = entry.opts.resumeSessionId ? await this.sessions.open(entry.opts.resumeSessionId)
        : await this.sessions.create({ agent: handle.name, model: handle.model, role: handle.meta.role,
          ...(handle.meta.role === 'sub' && typeof handle.meta.expert === 'string' ? { expert: handle.meta.expert } : {}),
          parentSession: handle.meta.parentSession, parentAgent: handle.meta.parentAgent })
      handle.sessionId = session.id
      if (!handle.meta.parentSession) handle.meta.parentSession = session.id
      if (entry.opts.persistentSession || entry.opts.resumeSessionId) entry.session = session
      return session
    }
    if (!entry.opts.persistentSession && !entry.opts.resumeSessionId) return create()
    if (!entry.sessionOpening) entry.sessionOpening = create().finally(() => { entry.sessionOpening = undefined })
    return entry.sessionOpening
  }

  interrupt(id: string): boolean {
    const entry = this.agents.get(id)
    if (!entry?.controller) return false
    entry.controller.abort()
    return true
  }

  /** Fire-and-forget mailbox delivery: enqueue a turn without awaiting it. */
  deliver(id: string, message: string, opts?: Pick<TurnOptions, 'checkpoint' | 'from'>): void {
    const entry = this.agents.get(id)
    if (!entry) throw new Error(`unknown agent "${id}"`)
    void entry.handle.turn(`[message from parent] ${message}`, { ...opts, source: 'agent' }).catch(() => {})
  }

  /** Mailbox: deliver a message; runs now if idle, queues otherwise. Resolves with that turn's result. */
  async sendMessage(id: string, message: string, opts?: Pick<TurnOptions, 'checkpoint' | 'from'>): Promise<TurnResult> {
    const entry = this.agents.get(id)
    if (!entry) throw new Error(`unknown agent "${id}"`)
    return entry.handle.turn(`[message from parent] ${message}`, { ...opts, source: 'agent' })
  }

  /** Abort every live agent and forget the roster (used on harness disposal and session switches). */
  disposeAll(): void {
    for (const entry of this.agents.values()) {
      entry.generation++
      entry.controller?.abort()
    }
    this.agents.clear()
    this.turnGroups.clear()
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

  /** Mailbox entries count as busy before their run microtask starts. */
  hasPendingTurns(): boolean {
    return [...this.agents.values()].some(entry => entry.pendingTurns > 0)
  }

  // ------------------------------------------------------------------

  /**
   * Mailbox semantics: turns are serialized through the entry's promise
   * chain — a turn issued while the agent is running queues behind it.
   */
  private drive(entry: AgentEntry, input: string, opts?: TurnOptions): Promise<TurnResult> {
    const target = opts?.checkpoint ?? entry.handle.meta.checkpoint
    const turnGroup = opts?.turnGroup ?? (target ? this.turnGroups.get(`${target.sessionId}:${target.turnSeq}`) : undefined)
    if (turnGroup) {
      const notify = opts?.onUserMessage
      opts = { ...opts, turnGroup, onUserMessage: record => {
        if (entry.handle.meta.role === 'main') this.turnGroups.set(`${record.sessionId}:${record.userSeq}`, turnGroup)
        notify?.(record)
      } }
    }
    const turnId = `${entry.handle.id}:${++this.turnSeq}`
    const generation = entry.generation
    if (this.stopping) return (opts?.preparedFiles?.remove() ?? Promise.resolve()).then(() => ({ output: '', steps: 0, cancelled: true }))
    const run = async (): Promise<TurnResult> => {
      if (entry.generation !== generation || this.agents.get(entry.handle.id) !== entry || this.ctx.isDisposed()) {
        await opts?.preparedFiles?.remove()
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
      entry.memoryUserOnly = opts?.expertMode === true || handle.meta.expertContext === true
      const driveMeter = new TurnMeter()
      let loopEntered = false
      try {
        const session = await this.openSession(entry)
        let sharedContext: AgentRuntime['sharedContext']
        if (entry.sharedMainId) {
          const sharedUser = await opts?.sharedUser
          if (opts?.sharedUser && !sharedUser) { await opts.preparedFiles?.remove(); throw new CancellationError() }
          const parent = this.agents.get(entry.sharedMainId)
          if (!parent || this.agents.get(handle.id) !== entry) throw new CancellationError()
          const shared = await this.openSession(parent)
          if (sharedUser && sharedUser.sessionId !== shared.id) throw new CancellationError()
          const userSeq = sharedUser?.userSeq ?? (opts?.checkpoint?.sessionId === shared.id ? opts.checkpoint.turnSeq : undefined) ??
            [...shared.events].reverse().find(event => event.type === 'user/message')?.seq
          sharedContext = { session: shared, userSeq, mirroredUser: !!opts?.sharedUser }
        }
        const runtime: AgentRuntime = {
          id: handle.id,
          name: handle.name,
          model: handle.model,
          systemPrompt: entry.opts.systemPrompt,
          toolFilter: entry.toolFilter,
          maxSteps: entry.opts.maxSteps ?? this.defaultMaxSteps,
          meta: entry.memoryUserOnly ? { ...handle.meta, expertContext: true } : handle.meta,
          ...(sharedContext ? { sharedContext } : {}),
        }
        loopEntered = true
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
        if (!loopEntered) await opts?.preparedFiles?.remove()
        if (error instanceof CancellationError || (error as Error)?.name === 'AbortError') {
          handle.status = 'cancelled'
          entry.last = { output: '', steps: 0, cancelled: true, metrics: driveMeter.finish('cancelled') }
          this.ctx.emit('ui/turn/end', { agentId: handle.id, sessionId: handle.sessionId, ...entry.last, main: handle.meta.role === 'main' })
          this.emitStatus(handle)
          return entry.last
        }
        handle.status = 'error'
        handle.error = error instanceof Error ? error.message : String(error)
        entry.last = { output: '', steps: 0, error: handle.error, metrics: driveMeter.finish('error') }
        this.ctx.emit('ui/turn/end', { agentId: handle.id, sessionId: handle.sessionId, ...entry.last, main: handle.meta.role === 'main' })
        this.emitStatus(handle)
        return entry.last
      } finally {
        if (entry.controller === controller) entry.controller = null
        entry.memoryUserOnly = false
      }
    }
    entry.pendingTurns++
    if (turnGroup) this.ctx.emit('agent/turn-queued', { turnGroup, turnId, agentId: entry.handle.id })
    const settle = (result: TurnResult): TurnResult => {
      if (turnGroup) this.ctx.emit('agent/turn-settled', { turnGroup, turnId, agentId: entry.handle.id, result })
      return result
    }
    const next = entry.chain.then(run, run).then(settle, error => {
      settle({ output: '', steps: 0, error: error instanceof Error ? error.message : String(error) })
      throw error
    }).finally(() => { entry.pendingTurns-- })
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
  pendingTurns: number
  chain: Promise<TurnResult>
  last?: TurnResult
  session?: Sessionish
  sessionOpening?: Promise<Sessionish>
  toolFilter: (name: string) => boolean
  sharedMainId?: string
  memoryUserOnly?: boolean
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
