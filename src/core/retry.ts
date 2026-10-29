/** Retries one model stream only. Tool side effects and HTTP message submission are never replayed. */
import { randomUUID } from 'node:crypto'
import type { Context, PluginModule } from '../kernel/index.js'
import type { LLMRequest, StreamChunk } from './types.js'
import { DEFAULT_RETRY_POLICY, LLMRequestError, isRetryableFailure, validateRetryPolicy, type RetryPolicy } from '../util/retry.js'

export interface RetryRequest {
  id: string
  agentId?: string
  sessionId?: string
  main?: boolean
  purpose?: string
  error: string
  retries: number
  elapsedMs: number
  windowMs: number
  maxRetries: number
  signal?: AbortSignal
}

export interface RetryStatus extends Omit<RetryRequest, 'signal'> {
  phase: 'waiting' | 'requesting' | 'exhausted'
  dueAt?: number
}

export type RetryConfirmHandler = (request: RetryRequest) => boolean | Promise<boolean>

export class RetryLimitError extends Error {
  constructor(message: string) {
    super(message + '；自动重试已停止，需要手动确认后才能继续。')
    this.name = 'RetryLimitError'
  }
}

export class RetryService {
  private policy: RetryPolicy
  private handler?: RetryConfirmHandler
  private readonly active = new Map<string, RetryStatus>()
  private readonly controller = new AbortController()

  constructor(private readonly ctx: Context, policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY }) {
    this.policy = validateRetryPolicy(policy)
  }

  settings(): RetryPolicy { return { ...this.policy } }
  configure(policy: RetryPolicy): void { this.policy = validateRetryPolicy(policy) }
  setConfirmHandler(handler: RetryConfirmHandler | undefined): void { this.handler = handler }
  status(): RetryStatus[] { return [...this.active.values()].map(row => ({ ...row })) }
  dispose(): void { this.controller.abort(); this.active.clear(); this.handler = undefined }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (!ms) return
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  async *stream(factory: (request: LLMRequest) => AsyncIterable<StreamChunk>, request: LLMRequest): AsyncIterable<StreamChunk> {
    const policy = this.settings()
    const signal = request.signal ? AbortSignal.any([request.signal, this.controller.signal]) : this.controller.signal
    const req = { ...request, signal }
    const id = randomUUID()
    let retries = 0
    let automaticRetries = 0
    let manualOnly = false
    let failedAt: number | undefined
    let wasRetried = false
    let recovered = false
    const publish = (status: RetryStatus): void => {
      this.active.set(id, status)
      this.ctx.emit('retry/status', { ...status })
    }
    try {
      for (;;) {
        signal.throwIfAborted()
        try {
          for await (const chunk of factory(req)) {
            signal.throwIfAborted()
            if (chunk.type === 'error') throw new LLMRequestError(chunk.error, chunk.retryable ?? isRetryableFailure(new Error(chunk.error)), chunk.retryAfterMs)
            yield chunk
          }
          recovered = true
          return
        } catch (error) {
          signal.throwIfAborted()
          if (!policy.enabled || !isRetryableFailure(error)) throw error
          const rawMessage = error instanceof Error ? error.message : String(error)
          const message = this.ctx.peek<{ redactError(message: string): string }>('llm')?.redactError(rawMessage) ?? rawMessage
          failedAt ??= Date.now()
          const delayMs = Math.max(policy.delayMs, error instanceof LLMRequestError ? error.retryAfterMs : 0)
          const frame = { id, ...request.retryContext, error: message, retries,
            elapsedMs: Date.now() - failedAt, windowMs: policy.windowMs, maxRetries: policy.maxRetries }
          if (!manualOnly && automaticRetries < policy.maxRetries && Date.now() + delayMs < failedAt + policy.windowMs) {
            publish({ ...frame, phase: 'waiting', dueAt: Date.now() + delayMs })
            await this.wait(delayMs, signal)
            // A suspended process must not reset the time budget when it resumes.
            if (Date.now() < failedAt + policy.windowMs) { retries++; automaticRetries++ }
            else {
              publish({ ...frame, elapsedMs: Date.now() - failedAt, phase: 'exhausted' })
              if (!this.handler || request.retryContext?.interactive === false) throw new RetryLimitError(message)
              let allow = false
              try { allow = await this.handler({ ...frame, elapsedMs: Date.now() - failedAt, signal }) } catch { /* fail closed */ }
              signal.throwIfAborted()
              if (!allow) throw new RetryLimitError(message)
              manualOnly = true
              retries++
            }
          } else {
            publish({ ...frame, phase: 'exhausted' })
            if (!this.handler || request.retryContext?.interactive === false) throw new RetryLimitError(message)
            let allow = false
            try { allow = await this.handler({ ...frame, signal }) } catch { /* fail closed */ }
            signal.throwIfAborted()
            if (!allow) throw new RetryLimitError(message)
            manualOnly = true
            // Confirmation permits exactly one more request, not an unbounded new automatic streak.
            retries++
          }
          wasRetried = true
          yield { type: 'reset', error: message }
          publish({ ...frame, retries, elapsedMs: Date.now() - failedAt, phase: 'requesting' })
        }
      }
    } finally {
      this.active.delete(id)
      if (wasRetried || failedAt !== undefined) this.ctx.emit('retry/finished', { id, ...request.retryContext, recovered })
    }
  }
}

export const retryPlugin: PluginModule<Partial<RetryPolicy>> = {
  name: 'core-retry',
  description: 'Bounded model-request retries with mandatory confirmation after exhaustion',
  apply(ctx, config) {
    const retry = new RetryService(ctx, { ...DEFAULT_RETRY_POLICY, ...config })
    ctx.provide('retry')
    ctx.set('retry', retry)
    ctx.effect(() => () => retry.dispose())
  },
}