/**
 * ctx.llm — message/stream vocabulary and the model adapter seam.
 * Providers register adapters on ctx.llm; requests flow through the
 * `llm/stream` waterfall so listeners can wrap the stream source
 * (telemetry, logging, failover) before a token is consumed.
 */

import type { Context } from '../kernel/index.js'
import type { ChatMessage, LLMRequest, ModelAdapter, StreamChunk, ThinkingLevel, UsageStats } from './types.js'
import type { RetryService } from './retry.js'
import { LLMRequestError, retryableStatus, retryAfterMilliseconds } from '../util/retry.js'

/** A configuration assessment, never a connectivity probe or a credentials dump. */
export interface ModelStatus {
  adapter: string
  model: string
  configured: boolean
  requiresApiKey: boolean
  baseURL?: string
  thinking: {
    supported: boolean
    param: 'none' | 'reasoning_effort' | 'thinking' | 'model' | 'unknown'
    levels: ThinkingLevel[]
  }
}

export interface ModelConfigurationPatch {
  /** Omitted keeps the selection; null restores the workspace's default model. */
  model?: string | null
  /** Omitted keeps the endpoint; null restores the workspace's configured endpoint. */
  baseURL?: string | null
  /** Omitted keeps credentials; null/empty explicitly removes them (not the environment). */
  apiKey?: string | null
  /** Omitted keeps the upstream request format (chat-completions | responses). */
  format?: UpstreamFormat
  /**
   * Target a registered adapter id other than the currently selected one, so a
   * settings form can edit several upstream sites without switching first.
   */
  provider?: string
}

export class LLMService {
  private adapters = new Map<string, ModelAdapter>()
  /** Original workspace registrations, before any desktop overrides. */
  private configuredAdapters = new Map<string, ModelAdapter>()
  private configuredDefaultId?: string
  private defaultId?: string
  /**
   * Model name chosen by the last setDefault()/select() — the one request
   * construction sends when a request does not name a model itself. Without
   * it a switch would only re-route, leaving the adapter free to send its own
   * default model (the `/model <secondary>` bug).
   */
  private selection?: string
  /** Current reasoning-effort level applied to every request ('off' sends nothing). */
  thinking: ThinkingLevel = 'off'

  constructor(private ctx: Context) {}

  setThinking(level: ThinkingLevel): void {
    this.thinking = level
  }

  /** App-owned routing policy. Discards configuration/environment providers
   * without changing their files; the CLI's normal multi-provider API remains. */
  replaceAdapters(adapter: ModelAdapter): void {
    this.adapters = new Map([[adapter.id, adapter]])
    this.configuredAdapters = new Map([[adapter.id, adapter]])
    this.defaultId = this.configuredDefaultId = adapter.id
    this.selection = adapter.defaultModel
  }

  register(adapter: ModelAdapter, opts: { default?: boolean; replace?: boolean } = {}): () => void {
    if (this.adapters.has(adapter.id)) {
      if (!opts.replace) throw new Error(`model adapter "${adapter.id}" already registered`)
      this.adapters.delete(adapter.id)
    }
    this.adapters.set(adapter.id, adapter)
    this.configuredAdapters.set(adapter.id, adapter)
    if (opts.default || !this.defaultId) {
      this.defaultId = adapter.id
      this.configuredDefaultId = adapter.id
    }
    return () => {
      // Disposing an old registration must not remove its replacement.
      if (this.adapters.get(adapter.id) === adapter) this.adapters.delete(adapter.id)
      if (this.configuredAdapters.get(adapter.id) === adapter) this.configuredAdapters.delete(adapter.id)
    }
  }

  /** Route subsequent requests through `id` and use that adapter's own default model. */
  setDefault(id: string): void {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`unknown model adapter "${id}"`)
    this.defaultId = id
    this.selection = adapter.defaultModel ?? adapter.models?.[0]
  }

  /**
   * Select a model the way `/model <name>` and the GUI picker do: an adapter
   * id picks that profile (and its default model), any other name picks the
   * adapter exposing it (multi-model profiles). Records the name so request
   * construction sends exactly that model, and reports what was resolved.
   */
  select(name: string): { adapter: string; model?: string } {
    const owner = this.owner(name)
    if (!owner) throw new Error(`unknown model "${name}"`)
    // An adapter id means "that profile, its default model"; any other name is
    // already a model id and is sent unchanged.
    const model = owner.id === name ? (owner.defaultModel ?? owner.models?.[0]) : name
    this.defaultId = owner.id
    this.selection = model
    return { adapter: owner.id, model }
  }

  /** Model name requests resolve to when they do not name one (undefined = let the adapter decide). */
  selectedModel(): string | undefined {
    return this.selection
  }

  /** Adapter serving `model`: by adapter id first, then by any name it exposes. */
  private owner(model: string): ModelAdapter | undefined {
    const byId = this.adapters.get(model)
    if (byId) return byId
    const adapters = [...this.adapters.values()]
    // An explicit `models` list is a routing declaration and outranks an
    // adapter that merely defaults to that name: core-llm's own `model` can
    // name a model one of the profiles routes (`--model glm-4.7`). The
    // defaultModel pass keeps every name listModels() offers routable.
    return adapters.find((a) => a.models?.includes(model)) ?? adapters.find((a) => a.defaultModel === model)
  }

  /**
   * Prepare a desktop edit without mutating the live routing. The owner of a
   * registered model is updated as well as selected: selecting an existing
   * profile must never discard a simultaneous URL/key edit. The rollback is
   * used if the desktop persistence callback rejects the transaction.
   */
  prepareConfiguration(patch: ModelConfigurationPatch): { commit(): void; rollback(): void } {
    const before = new Map(this.adapters)
    const beforeDefault = this.defaultId
    const beforeSelection = this.selection
    const beforeThinking = this.thinking
    const resetModel = patch.model === null || patch.model === ''
    const baselineDefault = this.configuredAdapters.get(this.configuredDefaultId ?? '')
    let adapter = resetModel
      ? this.adapters.get(this.configuredDefaultId ?? '')
      : patch.model ? this.owner(patch.model) : this.adapters.get(this.defaultId ?? '')
    // The settings form can target a specific upstream site directly.
    if (patch.provider && this.adapters.has(patch.provider)) adapter = this.adapters.get(patch.provider)
    let model = resetModel ? baselineDefault?.defaultModel : patch.model
      ? (adapter?.id === patch.model ? adapter.defaultModel ?? adapter.models?.[0] : patch.model)
      : this.selection ?? adapter?.defaultModel
    if (!adapter && patch.model) {
      // A new model name belongs to the built-in compatible provider.
      adapter = this.adapters.get('default')
      model = patch.model
    }
    if (!adapter) throw new Error('no model adapter is available for these settings')
    const baseline = this.configuredAdapters.get(adapter.id)
    const changesProvider = patch.baseURL !== undefined || patch.apiKey !== undefined || patch.format !== undefined ||
      (model !== undefined && model !== adapter.defaultModel && !adapter.models?.includes(model))
    let next = adapter
    if (changesProvider) {
      if (!(adapter instanceof OpenAICompatAdapter)) {
        throw new Error('the selected custom adapter does not accept API URL or key overrides')
      }
      const configured = baseline instanceof OpenAICompatAdapter ? baseline.opts : adapter.opts
      const headers = { ...adapter.opts.headers }
      // A new/cleared key must not be overridden by an old Authorization header.
      if (patch.apiKey !== undefined) {
        for (const name of Object.keys(headers)) if (isCredentialHeader(name)) delete headers[name]
      }
      next = new OpenAICompatAdapter({
        ...adapter.opts,
        baseURL: patch.baseURL === undefined ? adapter.opts.baseURL : patch.baseURL || configured.baseURL,
        apiKey: patch.apiKey === undefined ? adapter.opts.apiKey : patch.apiKey || undefined,
        model: model ?? adapter.defaultModel,
        models: [...new Set([...(adapter.models ?? [adapter.defaultModel]), ...(model ? [model] : [])])],
        format: patch.format ?? adapter.opts.format ?? 'chat-completions',
        headers,
      })
    }
    return {
      commit: () => {
        this.adapters.set(next.id, next)
        this.defaultId = next.id
        this.selection = model
      },
      rollback: () => {
        this.adapters = before
        this.defaultId = beforeDefault
        this.selection = beforeSelection
        this.thinking = beforeThinking
      },
    }
  }

  /** Backwards-compatible built-in adapter update; workspace defaults survive resets. */
  updateDefaultAdapter(opts: ModelConfigurationPatch): void {
    const selected = this.defaultId
    const selection = this.selection
    this.defaultId = 'default'
    this.selection = this.adapters.get('default')?.defaultModel
    try {
      this.prepareConfiguration(opts).commit()
    } catch (error) {
      this.defaultId = selected
      this.selection = selection
      throw error
    }
  }

  /** Safe provider metadata for the workbench; does not perform a network request. */
  modelStatus(model?: string): ModelStatus {
    let adapter: ModelAdapter
    try { adapter = this.pick(model || this.selection) }
    catch {
      return { adapter: '', model: model || '', configured: false, requiresApiKey: false,
        thinking: { supported: false, param: 'none', levels: ['off'] } }
    }
    const selectedModel = model || this.selection || adapter.defaultModel || ''
    if (!(adapter instanceof OpenAICompatAdapter)) {
      return { adapter: adapter.id, model: selectedModel, configured: true, requiresApiKey: false,
        thinking: { supported: false, param: 'unknown', levels: ['off'] } }
    }
    const opts = adapter.opts
    let endpoint: URL | undefined
    try { endpoint = new URL(opts.baseURL) } catch { /* invalid config is not ready */ }
    const validEndpoint = !!endpoint && ['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password
    const local = !!endpoint && /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(endpoint.hostname)
    const requiresApiKey = opts.requiresApiKey ?? !local
    const hasCredential = !!opts.apiKey || Object.entries(opts.headers ?? {}).some(([name, value]) => isCredentialHeader(name) && !!value)
    const param = opts.thinkingParam && opts.thinkingParam !== 'none' ? opts.thinkingParam : opts.thinkingModel ? 'model' : 'none'
    const levels: ThinkingLevel[] = param === 'reasoning_effort' ? ['off', 'low', 'medium', 'high'] : param === 'none' ? ['off'] : ['off', 'high']
    return {
      adapter: adapter.id,
      model: selectedModel,
      configured: validEndpoint && !!selectedModel && (!requiresApiKey || hasCredential),
      requiresApiKey,
      ...(endpoint ? { baseURL: endpoint.origin + endpoint.pathname } : {}),
      thinking: { supported: param !== 'none', param, levels },
    }
  }

  /** Scrub known credentials before surfacing provider/plugin errors in the GUI. */
  redactError(message: string): string {
    let safe = message
    for (const adapter of [...this.adapters.values(), ...this.configuredAdapters.values()]) {
      if (!(adapter instanceof OpenAICompatAdapter)) continue
      const secrets = [adapter.opts.apiKey, ...Object.values(adapter.opts.headers ?? {})]
      for (const secret of secrets) {
        if (!secret) continue
        for (const value of [secret, encodeURIComponent(secret)]) safe = safe.split(value).join('[redacted]')
      }
    }
    return safe
  }

  pick(model?: string): ModelAdapter {
    if (model) {
      const owner = this.owner(model)
      if (owner) return owner
    }
    if (!this.defaultId) throw new Error('no model adapter registered — mount the core-llm plugin or register an adapter on ctx.llm')
    return this.adapters.get(this.defaultId)!
  }

  listModels(): Array<{ adapter: string; model?: string; default: boolean }> {
    return [...this.adapters.values()].flatMap((a) =>
      (a.models?.length ? a.models : [a.defaultModel]).map((m) => ({
        adapter: a.id,
        model: m,
        // The * marker follows the explicit selection when there is one —
        // otherwise the adapter's documented default is what requests fall
        // back to (`/model` with no argument lists these rows).
        default: a.id === this.defaultId && (this.selection !== undefined ? m === this.selection : m === a.defaultModel || !a.models),
      })),
    ) as Array<{ adapter: string; model?: string; default: boolean }>
  }

  /** Registered upstream sites for the settings view; keys/credentials are never included. */
  listProviders(): Array<{ id: string; model?: string; models?: string[]; default: boolean; format?: UpstreamFormat; baseURL?: string }> {
    return [...this.adapters.values()].map((a) => {
      const opts = a instanceof OpenAICompatAdapter ? a.opts : undefined
      return {
        id: a.id,
        model: a.defaultModel,
        models: a.models,
        default: a.id === this.defaultId,
        format: opts?.format ?? 'chat-completions',
        ...(opts ? { baseURL: opts.baseURL } : {}),
      }
    })
  }

  /**
   * Stream a completion. The base of the `llm/stream` waterfall opens the
   * adapter stream; listeners may replace payload.source (or req) first.
   */
  async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    // The request's own model wins (subagents and agent-defs pin theirs), then
    // the explicit selection, then the adapter's documented default. A request
    // may also carry '' — `agent.model` is '' until a model is named, and ''
    // is not nullish, so the adapter's `req.model ?? opts.model` fallback would
    // otherwise send an empty `model` field.
    const requested = req.model || this.selection || undefined
    const adapter = this.pick(requested)
    const model = requested ?? adapter.defaultModel
    const resolved: LLMRequest = model && model !== req.model ? { ...req, model } : req
    const ctx = this.ctx
    const source = async function* (request: LLMRequest): AsyncIterable<StreamChunk> {
      const payload = await ctx.waterfall<{ req: LLMRequest; source: AsyncIterable<StreamChunk> | null }>(
        'llm/stream', async p => ({ ...p, source: adapter.stream(p.req) }), { req: request, source: null },
      )
      if (!payload.source) throw new Error('llm/stream pipeline produced no stream source')
      yield* payload.source
    }
    const retry = ctx.peek<RetryService>('retry')
    if (retry) yield* retry.stream(source, resolved)
    else yield* source(resolved)
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible adapter (OpenAI / GLM / Moonshot / local endpoints)
// ---------------------------------------------------------------------------

/** Built-in default chat model (what `--dump-config` and the REPL banner report). */
export const DEFAULT_MODEL = 'gpt-4o-mini'

/** Effective chat model: explicit config → SAKURA_MODEL → built-in default. */
export function resolveModelName(configModel?: string): string {
  return configModel ?? process.env.SAKURA_MODEL ?? DEFAULT_MODEL
}

/** Upstream request protocol spoken by the adapter. */
export type UpstreamFormat = 'chat-completions' | 'responses'

export interface OpenAICompatOptions {
  id?: string
  baseURL: string
  apiKey?: string
  model: string
  models?: string[]
  headers?: Record<string, string>
  /**
   * Upstream request format. 'chat-completions' (default) posts OpenAI
   * Chat Completions to {baseURL}/chat/completions; 'responses' posts the
   * OpenAI Responses API to {baseURL}/responses (input items, output items
   * and its own SSE event vocabulary).
   */
  format?: UpstreamFormat
  /**
   * How to pass a thinking level to the API. 'reasoning_effort' sends
   * `reasoning_effort: <level>` (OpenAI o-series style), 'thinking' sends
   * `thinking: {type:'enabled'}` (GLM style), 'none' (default) drops it.
   */
  thinkingParam?: 'reasoning_effort' | 'thinking' | 'none'
  /** Model substituted when a thinking level is requested (e.g. o3-mini). */
  thinkingModel?: string
  /** Explicit credential requirement; unset infers from the endpoint host (loopback = no key). */
  requiresApiKey?: boolean
  /** Private transport injection for offline acceptance; not a user/YAML setting. */
  fetch?: typeof globalThis.fetch
  /** Fixed-origin providers must not forward their credentials through redirects. */
  redirect?: 'error'
}

/** Header names that carry credentials — used for scrubbing and readiness checks. */
function isCredentialHeader(name: string): boolean {
  return /^(authorization|proxy-authorization|x-api-key|api-key)$/i.test(name)
}

/** Shared by startup and desktop hot updates, so clearing an override restores
 * the current workspace's config/environment rather than the last UI value. */
export function resolveDefaultAdapterOptions(config: Partial<OpenAICompatOptions> = {}): OpenAICompatOptions {
  return {
    ...config,
    id: 'default',
    baseURL: config.baseURL ?? process.env.SAKURA_BASE_URL ?? 'https://api.openai.com/v1',
    apiKey: config.apiKey ?? process.env.SAKURA_API_KEY,
    model: resolveModelName(config.model),
  }
}

interface SSEChoiceDelta {
  content?: string | null
  reasoning_content?: string | null
  reasoning?: string | null
  tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>
  finish_reason?: string | null
}

/**
 * Usage objects as OpenAI-compatible providers send them: OpenAI spells the
 * details `prompt_tokens_details.cached_tokens`, DeepSeek reports top-level
 * `prompt_cache_hits`, and the Responses API uses `input_tokens_details`.
 */
interface SSEUsage {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
  /** DeepSeek-style aliases. */
  prompt_cache_hits?: number
  reasoning_tokens?: number
}

/** Project the union of provider usage spellings onto UsageStats. */
function usageChunk(usage: SSEUsage): UsageStats {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hits,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  }
}

export class OpenAICompatAdapter implements ModelAdapter {
  readonly id: string
  readonly defaultModel: string
  readonly models?: string[]

  /** The full adapter options — LLMService.updateDefaultAdapter() merges over them. */
  readonly opts: OpenAICompatOptions

  constructor(opts: OpenAICompatOptions) {
    this.opts = opts
    this.id = opts.id ?? 'openai-compat'
    this.defaultModel = opts.model
    this.models = opts.models
  }

  async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    if (this.opts.format === 'responses') yield* this.streamResponses(req)
    else yield* this.streamChatCompletions(req)
  }

  private async post(url: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> {
    const response = await (this.opts.fetch ?? fetch)(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        ...this.opts.headers,
      },
      body: JSON.stringify(body),
      signal,
      credentials: 'omit',
      ...(this.opts.redirect ? { redirect: this.opts.redirect } : {}),
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      const quotaFailure = /insufficient_quota|quota_exhausted|insufficient_balance|billing_hard_limit_reached/i.test(detail)
      throw new LLMRequestError(`LLM request failed: HTTP ${response.status} ${detail.slice(0, 400)}`,
        !quotaFailure && retryableStatus(response.status), retryAfterMilliseconds(response.headers.get('retry-after')), response.status)
    }
    return response
  }

  private modelFor(req: LLMRequest): string {
    const thinking = req.thinking && req.thinking !== 'off' ? req.thinking : undefined
    return (thinking && this.opts.thinkingModel) ? this.opts.thinkingModel : (req.model ?? this.opts.model)
  }

  private async *streamChatCompletions(req: LLMRequest): AsyncIterable<StreamChunk> {
    const url = this.opts.baseURL.replace(/\/+$/, '') + '/chat/completions'
    const thinking = req.thinking && req.thinking !== 'off' ? req.thinking : undefined
    const body: Record<string, unknown> = {
      model: this.modelFor(req),
      messages: req.messages,
      stream: true,
      stream_options: { include_usage: true },
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    const thinkingParam = this.opts.thinkingParam ?? 'none'
    if (thinking && thinkingParam === 'reasoning_effort') body.reasoning_effort = thinking
    if (thinking && thinkingParam === 'thinking') body.thinking = { type: 'enabled' }

    const response = await this.post(url, body, req.signal)
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop'
    let finished = false
    for await (const event of sseEvents(response.body!)) {
      if (!event) continue
      if (event === '[DONE]') { finished = true; break }
      let parsed: {
        choices?: Array<{ delta?: SSEChoiceDelta; finish_reason?: string | null }>
        usage?: SSEUsage
        error?: { message?: string; status?: number; code?: string }
      }
      try {
        parsed = JSON.parse(event)
      } catch {
        continue
      }
      if (parsed.error) {
        const status = Number(parsed.error.status)
        throw new LLMRequestError(`LLM request failed: ${parsed.error.message ?? 'upstream stream error'}`,
          retryableStatus(status) || ['rate_limit_exceeded', 'server_error', 'overloaded_error'].includes(parsed.error.code ?? ''))
      }
      const choice = parsed.choices?.[0]
      const delta = choice?.delta
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (reasoning) yield { type: 'thinking', delta: reasoning }
      if (delta?.content) yield { type: 'text', delta: delta.content }
      if (delta?.tool_calls) {
        finishReason = 'tool_calls'
        for (const call of delta.tool_calls) {
          yield {
            type: 'tool_call',
            index: call.index,
            id: call.id,
            name: call.function?.name,
            argsDelta: call.function?.arguments,
          }
        }
      }
      const fr = choice?.finish_reason
      if (fr) finished = true
      if (fr === 'tool_calls') finishReason = 'tool_calls'
      else if (fr === 'length') finishReason = 'length'
      if (parsed.usage) yield { type: 'usage', ...usageChunk(parsed.usage) }
    }
    if (!finished) throw new LLMRequestError('LLM stream interrupted before completion', true)
    yield { type: 'done', reason: finishReason }
  }

  /**
   * OpenAI Responses API ({baseURL}/responses). Messages map onto `input`
   * items; tool calls come back as function_call output items; streaming uses
   * the response.* event vocabulary. The final `response.completed` event is
   * also used as a fallback for providers that answer without deltas.
   */
  private async *streamResponses(req: LLMRequest): AsyncIterable<StreamChunk> {
    const url = this.opts.baseURL.replace(/\/+$/, '') + '/responses'
    const thinking = req.thinking && req.thinking !== 'off' ? req.thinking : undefined
    const body: Record<string, unknown> = {
      model: this.modelFor(req),
      input: toResponsesInput(req.messages),
      stream: true,
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }))
      body.tool_choice = 'auto'
    }
    if (req.maxTokens) body.max_output_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (thinking && this.opts.thinkingParam === 'reasoning_effort') {
      body.reasoning = { effort: thinking === 'low' ? 'low' : thinking === 'high' ? 'high' : 'medium' }
    }

    const response = await this.post(url, body, req.signal)

    const calls = new Map<string, { index: number; callId?: string; name?: string; argsEmitted: boolean }>()
    let nextIndex = 0
    let anyText = false
    let completed = false
    let finishReason: 'stop' | 'tool_calls' | 'length' = 'stop'
    const pendingUsage: UsageStats = {}

    const emitCall = (item: { itemId?: string; callId?: string; name?: string; arguments?: string; argsDelta?: string }) => {
      const id = item.itemId ?? item.callId ?? ''
      if (!id) return
      let entry = calls.get(id)
      if (!entry) {
        entry = { index: nextIndex++, callId: item.callId, name: item.name, argsEmitted: false }
        calls.set(id, entry)
      }
      if (item.callId && !entry.callId) entry.callId = item.callId
      if (item.name && !entry.name) entry.name = item.name
      finishReason = 'tool_calls'
      if (item.argsDelta) { entry.argsEmitted = true; return { type: 'tool_call' as const, index: entry.index, id: entry.callId ?? id, name: entry.name, argsDelta: item.argsDelta } }
      if (item.arguments && !entry.argsEmitted) { entry.argsEmitted = true; return { type: 'tool_call' as const, index: entry.index, id: entry.callId ?? id, name: entry.name, argsDelta: item.arguments } }
      return null
    }

    for await (const event of sseEvents(response.body!)) {
      if (!event || event === '[DONE]') break
      let parsed: Record<string, unknown>
      try { parsed = JSON.parse(event) } catch { continue }
      const type = String(parsed.type ?? '')
      if (type === 'error' || type === 'response.failed') {
        const failure = (type === 'response.failed' ? (parsed.response as { error?: unknown } | undefined)?.error : parsed.error ?? parsed) as { message?: string; code?: string; status?: number } | undefined
        const message = failure?.message ?? 'upstream responses error'
        throw new LLMRequestError(`LLM request failed: ${message}`, ['rate_limit_exceeded', 'server_error', 'overloaded_error'].includes(failure?.code ?? '') || retryableStatus(failure?.status ?? 0))
      }
      if (type === 'response.output_text.delta') {
        const delta = String(parsed.delta ?? '')
        if (delta) { anyText = true; yield { type: 'text', delta } }
        continue
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning.delta' || type === 'response.reasoning_summary_text.done') {
        const delta = String(parsed.delta ?? '')
        if (delta && type !== 'response.reasoning_summary_text.done') yield { type: 'thinking', delta }
        continue
      }
      if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        const item = parsed.item as Record<string, unknown> | undefined
        if (item?.type === 'function_call') {
          const chunk = emitCall({
            itemId: String(item.id ?? ''),
            callId: item.call_id as string | undefined,
            name: item.name as string | undefined,
            arguments: item.arguments as string | undefined,
          })
          if (chunk) yield chunk
        }
        continue
      }
      if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
        const chunk = emitCall({
          itemId: String(parsed.item_id ?? ''),
          argsDelta: type === 'response.function_call_arguments.delta' ? String(parsed.delta ?? '') : undefined,
          arguments: type === 'response.function_call_arguments.done' ? parsed.arguments as string | undefined : undefined,
        })
        if (chunk) yield chunk
        continue
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        completed = true
        const responsePayload = parsed.response as Record<string, unknown> | undefined
        const usage = responsePayload?.usage as
          | {
              input_tokens?: number
              output_tokens?: number
              input_tokens_details?: { cached_tokens?: number }
              output_tokens_details?: { reasoning_tokens?: number }
            }
          | undefined
        if (usage) {
          pendingUsage.inputTokens = usage.input_tokens
          pendingUsage.outputTokens = usage.output_tokens
          pendingUsage.cachedTokens = usage.input_tokens_details?.cached_tokens
          pendingUsage.reasoningTokens = usage.output_tokens_details?.reasoning_tokens
        }
        // Fallback for providers that complete without streaming deltas.
        if (type === 'response.completed' && !anyText) {
          const text = responsePayload?.output_text as string | undefined
          if (text) { anyText = true; yield { type: 'text', delta: text } }
          for (const item of Array.isArray(responsePayload?.output) ? responsePayload.output as unknown[] : []) {
            const row = item as Record<string, unknown>
            if (row?.type === 'function_call') {
              const chunk = emitCall({ itemId: String(row.id ?? ''), callId: row.call_id as string | undefined, name: row.name as string | undefined, arguments: row.arguments as string | undefined })
              if (chunk) yield chunk
            }
          }
        }
        if (type === 'response.incomplete') finishReason = 'length'
      }
    }
    if (!completed) throw new LLMRequestError('LLM responses stream interrupted before completion', true)
    if (pendingUsage.inputTokens !== undefined || pendingUsage.outputTokens !== undefined) {
      yield { type: 'usage', ...pendingUsage }
    }
    yield { type: 'done', reason: calls.size ? 'tool_calls' : finishReason }
  }
}

/**
 * Map Chat Completions messages onto Responses API `input` items: roles stay
 * roles, historical assistant tool_calls become function_call items, and tool
 * results become function_call_output items — otherwise a resumed session's
 * tool history would not be accepted by the Responses endpoint.
 */
export function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'system') {
      input.push({ role: message.role, content: message.content })
      continue
    }
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content })
      continue
    }
    if (message.role === 'assistant') {
      if (message.content) input.push({ role: 'assistant', content: message.content })
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
      }
      continue
    }
    input.push({ role: 'user', content: message.content })
  }
  return input
}

/** Parse an SSE byte stream into `data:` event payloads. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line.startsWith('data:')) yield line.slice(5).trim()
    }
  }
  const rest = buffer.trim()
  if (rest.startsWith('data:')) yield rest.slice(5).trim()
}

/**
 * Fetch the model list an upstream exposes at `{baseURL}/models` (the OpenAI
 * `/v1/models` contract: `{data: [{id}]}`). HTTPS is required, except loopback
 * endpoints for local model servers. Never returns credentials; reads only.
 */
export async function fetchUpstreamModels(baseURL: string, apiKey?: string): Promise<string[]> {
  let url: URL
  try { url = new URL(baseURL.replace(/\/+$/, '') + '/models') } catch { throw new Error('invalid model API base URL') }
  const loopback = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new Error('model API must be an HTTPS origin (HTTP only for a local model server), without credentials, query or fragment')
  }
  const response = await fetch(url, {
    headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`upstream model list failed: HTTP ${response.status} ${detail.slice(0, 200)}`)
  }
  const text = await response.text()
  if (text.length > 1024 * 1024) throw new Error('upstream model list is too large')
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('upstream model list is not valid JSON') }
  const rows = (parsed as { data?: unknown }).data
  if (!Array.isArray(rows)) throw new Error('upstream model list has no data array')
  const names = rows
    .map((row) => (row as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id))
  return [...new Set(names)].sort().slice(0, 512)
}

/** Registers the ctx.llm service; provider plugins register adapters onto it. */
export const llmPlugin = {
  name: 'core-llm',
  description: 'Model adapter seam and stream vocabulary (ctx.llm)',
  config: {
    type: 'object',
    properties: {
      baseURL: { type: 'string', description: 'OpenAI-compatible base URL' },
      apiKey: { type: 'string', description: 'API key (prefer env SAKURA_API_KEY)' },
      model: { type: 'string', description: 'default chat model' },
      models: { type: 'array', items: { type: 'string' }, description: 'models offered to subagents' },
      format: { type: 'string', enum: ['chat-completions', 'responses'], description: 'upstream request format: OpenAI Chat Completions (/chat/completions) or Responses API (/responses)' },
      thinking: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: 'initial reasoning-effort level' },
      thinkingParam: { type: 'string', enum: ['reasoning_effort', 'thinking', 'none'], description: 'wire field for the thinking level' },
      thinkingModel: { type: 'string', description: 'model substituted when thinking is on' },
    },
  } as const,
  apply(
    ctx: import('../kernel/index.js').Context,
    config: {
      baseURL?: string
      apiKey?: string
      model?: string
      models?: string[]
      format?: UpstreamFormat
      thinking?: ThinkingLevel
      thinkingParam?: 'reasoning_effort' | 'thinking' | 'none'
      thinkingModel?: string
    },
  ) {
    ctx.provide('llm')
    const service = new LLMService(ctx)
    ctx.set('llm', service)
    const { baseURL, apiKey, model } = resolveDefaultAdapterOptions(config)
    if (apiKey || baseURL.startsWith('http://') || baseURL.startsWith('https://')) {
      // Always register the default adapter; auth errors surface at request time.
      service.register(
        new OpenAICompatAdapter({
          id: 'default',
          baseURL,
          apiKey,
          model,
          models: config.models,
          format: config.format,
          thinkingParam: config.thinkingParam,
          thinkingModel: config.thinkingModel,
        }),
      )
    }
    if (config.thinking) service.thinking = config.thinking
  },
}
