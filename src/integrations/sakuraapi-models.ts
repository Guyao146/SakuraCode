import { OpenAICompatAdapter, type OpenAICompatOptions, type UpstreamFormat } from '../core/llm.js'
import type { LLMRequest, StreamChunk } from '../core/types.js'
import { SAKURA_MODEL_BASE_URL } from './sakuraapi-authorization.js'
import { LLMRequestError, isRetryableFailure } from '../util/retry.js'

export interface SakuraApiModel {
  id: string
  format: UpstreamFormat
  reasoning: boolean
}

/** A fixed-origin adapter: model, protocol and credential come only from the
 * authorized catalog. Pinned subagent models cannot escape to a YAML provider. */
export class SakuraApiModelAdapter extends OpenAICompatAdapter {
  constructor(key: string | undefined, private readonly catalog: readonly SakuraApiModel[], model: string,
    fetcher?: typeof globalThis.fetch) {
    const selected = catalog.find(row => row.id === model)
    super({ id: 'sakuraapi', baseURL: SAKURA_MODEL_BASE_URL, apiKey: key,
      model: selected?.id ?? '', models: catalog.map(row => row.id), requiresApiKey: true,
      format: selected?.format ?? 'chat-completions', thinkingParam: selected?.reasoning ? 'reasoning_effort' : 'none',
      redirect: 'error', fetch: fetcher })
  }

  override async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    if (!this.opts.apiKey) throw new Error('请先授权登录 SakuraAPI，并同步可用模型。')
    const model = this.catalog.find(row => row.id === (req.model || this.defaultModel))
    if (!model) throw new Error('该模型不在 SakuraAPI 授权 Key 的可用列表中，请刷新模型后重新选择。')
    const options: OpenAICompatOptions = { ...this.opts, model: model.id, format: model.format,
      thinkingParam: model.reasoning ? 'reasoning_effort' : 'none' }
    try { yield* new OpenAICompatAdapter(options).stream({ ...req, model: model.id }) }
    catch (error) {
      if (req.signal?.aborted || error instanceof Error && error.name === 'AbortError') throw error
      // Provider error bodies can echo Authorization. Do not publish their
      // arbitrary content into session logs, SSE or model-visible transcripts.
      const status = /HTTP (\d{3})/.exec(error instanceof Error ? error.message : '')?.[1]
      throw new LLMRequestError('SakuraAPI 模型请求失败' + (status ? `（HTTP ${status}）` : '（网络或响应异常）') + '。请刷新授权并在官网检查 Key、分组和额度。',
        isRetryableFailure(error), error instanceof LLMRequestError ? error.retryAfterMs : 0, status ? Number(status) : undefined)
    }
  }
}