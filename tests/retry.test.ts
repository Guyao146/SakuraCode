import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { RetryService } from '../src/core/retry.js'
import { DEFAULT_RETRY_POLICY, LLMRequestError, validateRetryPolicy, retryAfterMilliseconds, isRetryableFailure } from '../src/util/retry.js'
import { tmpHarness, text, toolCall, MockAdapter } from './helpers.js'
import type { StreamChunk } from '../src/core/types.js'
import { OpenAICompatAdapter } from '../src/core/llm.js'
import { SakuraApiModelAdapter } from '../src/integrations/sakuraapi-models.js'
import { summarizeUsage } from '../src/util/tokens.js'

afterEach(() => vi.useRealTimers())

describe('bounded model request retry', () => {
  it('detects interrupted streams and Responses failure events, without retrying quota errors', async () => {
    const collect = async (adapter: OpenAICompatAdapter) => { for await (const _chunk of adapter.stream({ messages: [] })) { /* consume */ } }
    const adapter = (body: string, format: 'chat-completions' | 'responses' = 'chat-completions') => new OpenAICompatAdapter({
      baseURL: 'https://fake.test/v1', model: 'test', format, fetch: (async () => new Response(body)) as typeof fetch,
    })
    await expect(collect(adapter('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))).rejects.toMatchObject({ retryable: true })
    await expect(collect(adapter('data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"overloaded"}}}\n\n', 'responses'))).rejects.toMatchObject({ retryable: true })
    const quota = new OpenAICompatAdapter({ baseURL: 'https://fake.test/v1', model: 'test',
      fetch: (async () => new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })) as typeof fetch })
    await expect(collect(quota)).rejects.toMatchObject({ retryable: false })
  })

  it('preserves safe SakuraAPI retry information and keeps user cancellation intact', async () => {
    const adapter = new SakuraApiModelAdapter('SYNTHETIC_KEY', [{ id: 'test', format: 'chat-completions', reasoning: false }], 'test',
      (async () => new Response('PRIVATE_SENSITIVE_ERROR', { status: 503, headers: { 'retry-after': '2' } })) as typeof fetch)
    await expect((async () => { for await (const _chunk of adapter.stream({ messages: [] })) { /* consume */ } })()).rejects.toMatchObject({ retryable: true, retryAfterMs: 2000 })
    try { for await (const _chunk of adapter.stream({ messages: [] })) { /* consume */ } } catch (error) { expect(String(error)).not.toContain('PRIVATE_SENSITIVE_ERROR') }
    const controller = new AbortController()
    controller.abort()
    const cancelled = new SakuraApiModelAdapter('SYNTHETIC_KEY', [{ id: 'test', format: 'chat-completions', reasoning: false }], 'test',
      (async () => { throw controller.signal.reason }) as typeof fetch)
    await expect((async () => { for await (const _chunk of cancelled.stream({ messages: [], signal: controller.signal })) { /* consume */ } })()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('accounts provider-reported failed usage once while separating it from recovered output', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [
      [{ type: 'usage', inputTokens: 10, outputTokens: 2 }, { type: 'error', error: 'HTTP 503 temporary' }],
      [{ type: 'usage', inputTokens: 20, outputTokens: 3 }, ...text('recovered')],
    ], config: { plugins: { 'core-retry': { config: { delayMs: 0 } } } } })
    await harness.run('try')
    const session = await ctx.sessions.open(harness.main().sessionId)
    expect(summarizeUsage(session.events)).toMatchObject({ requests: 2, inputTokens: 30, outputTokens: 5 })
  })

  it('validates integer limits and excludes credentials/configuration/abort errors', () => {
    expect(validateRetryPolicy(DEFAULT_RETRY_POLICY)).toEqual(DEFAULT_RETRY_POLICY)
    for (const patch of [{ maxRetries: -1 }, { maxRetries: 21 }, { maxRetries: 1.5 }, { windowMs: 999 }, { delayMs: 60001 }, { enabled: 'yes' }, { apiKey: 'x' }, { delayMs: 60000 }]) {
      expect(() => validateRetryPolicy({ ...DEFAULT_RETRY_POLICY, ...patch })).toThrow()
    }
    for (const code of [400, 401, 402, 403, 404]) expect(isRetryableFailure(new LLMRequestError('failure', false, 0, code))).toBe(false)
    expect(isRetryableFailure(new Error('HTTP 503 unavailable'))).toBe(true)
    expect(retryAfterMilliseconds('3')).toBe(3000)
    expect(retryAfterMilliseconds('not-a-date')).toBe(0)
  })

  it('retries failed model steps without duplicating the user message or successful tools', async () => {
    const adapter = new MockAdapter([toolCall('write', JSON.stringify({ path: 'once.txt', content: 'written once' })),
      [{ type: 'text', delta: 'FAILED_PARTIAL' }, { type: 'error', error: 'HTTP 503 temporary' }], text('RECOVERED')])
    const { harness, ctx } = await tmpHarness({ adapter, config: { plugins: { 'core-retry': { config: { delayMs: 0 } } } } })
    const executions = vi.fn(); ctx.on('ui/tool/result', executions)
    const result = await harness.run('do it once')
    expect(result).toMatchObject({ output: 'RECOVERED', steps: 2 })
    expect(executions).toHaveBeenCalledTimes(1)
    const session = await ctx.sessions.open(harness.main().sessionId)
    expect(session.events.filter(event => event.type === 'user/message')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'assistant/attempt')).toMatchObject([{ payload: { retry: true, stream: { text: 'FAILED_PARTIAL' } } }])
    expect(JSON.stringify(session.deriveMessages())).not.toContain('FAILED_PARTIAL')
  })

  it('requires one new explicit confirmation for every attempt past the limit, even in yolo', async () => {
    const { harness, ctx } = await tmpHarness({ steps: [[{ type: 'error', error: 'HTTP 503 temporary' }]],
      config: { plugins: { 'core-retry': { config: { delayMs: 0, maxRetries: 2 } } } } })
    const retry = ctx.get<RetryService>('retry'), handler = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    retry.setConfirmHandler(handler)
    const requests = vi.fn(); ctx.on('llm/stream', (payload, next) => { requests(); return next(payload) })
    const result = await harness.run('fail')
    expect(requests).toHaveBeenCalledTimes(4) // initial + two automatic + one confirmed
    expect(handler).toHaveBeenCalledTimes(2)
    expect(result.error).toContain('手动确认')
    expect(retry.status()).toEqual([])
  })

  it('uses a deadline that cannot silently renew and respects Retry-After', async () => {
    const ctx = new Context(), retry = new RetryService(ctx, { enabled: true, windowMs: 1000, maxRetries: 10, delayMs: 0 })
    let attempts = 0
    const source = async function* (): AsyncIterable<StreamChunk> { attempts++; throw new LLMRequestError('rate limited', true, 2000) }
    await expect((async () => { for await (const _chunk of retry.stream(source, { messages: [] })) { /* consume */ } })()).rejects.toThrow('手动确认')
    expect(attempts).toBe(1)
    retry.dispose(); ctx.dispose()
  })

  it('cancels a waiting retry immediately and never asks headless background jobs for approval', async () => {
    const ctx = new Context(), retry = new RetryService(ctx), controller = new AbortController()
    const handler = vi.fn(async () => true); retry.setConfirmHandler(handler)
    const source = async function* (): AsyncIterable<StreamChunk> { throw new LLMRequestError('503', true) }
    const consume = async () => { for await (const _chunk of retry.stream(source, { messages: [], signal: controller.signal })) { /* consume */ } }
    const promise = consume()
    await vi.waitFor(() => expect(retry.status()[0]?.phase).toBe('waiting'))
    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    retry.configure({ ...DEFAULT_RETRY_POLICY, maxRetries: 0 })
    await expect((async () => { for await (const _chunk of retry.stream(source, { messages: [], retryContext: { interactive: false } })) { /* consume */ } })()).rejects.toThrow('手动确认')
    expect(handler).not.toHaveBeenCalled(); retry.dispose(); ctx.dispose()
  })
})