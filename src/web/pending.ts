/** In-memory interactive requests survive browser disconnects, not server restarts. */
export interface PendingFrame extends Record<string, unknown> {
  type: string
  id: string
  agentId?: string
}

export class PendingRequests<T> {
  private readonly entries = new Map<string, {
    frame: PendingFrame
    resolve(value: T): void
    timer: NodeJS.Timeout
  }>()

  constructor(
    private readonly broadcast: (frame: Record<string, unknown>) => void,
    private readonly resolvedType: string,
    private readonly field: string,
    private readonly fallback: T,
    private readonly timeoutMs: number,
  ) {}

  wait(frame: PendingFrame, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.resolve(this.fallback)
    return new Promise<T>((resolve) => {
      const createdAt = Date.now()
      const timer = setTimeout(() => this.resolve(frame.id, this.fallback), this.timeoutMs)
      timer.unref()
      const request = { ...frame, createdAt, expiresAt: createdAt + this.timeoutMs }
      // Register before publishing: an immediate response must find the request.
      const abort = (): void => { this.resolve(frame.id, this.fallback) }
      this.entries.set(frame.id, { frame: request, resolve: (value) => {
        signal?.removeEventListener('abort', abort)
        resolve(value)
      }, timer })
      signal?.addEventListener('abort', abort, { once: true })
      this.broadcast(request)
    })
  }

  get(id: string): PendingFrame | undefined { return this.entries.get(id)?.frame }
  snapshot(): PendingFrame[] { return [...this.entries.values()].map((entry) => entry.frame) }

  /** Atomic single winner, even when two browsers submit simultaneously. */
  resolve(id: string, value: T): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    this.entries.delete(id)
    clearTimeout(entry.timer)
    this.broadcast({ type: this.resolvedType, id, [this.field]: value })
    entry.resolve(value)
    return true
  }

  cancel(agentId?: string): void {
    for (const [id, entry] of this.entries) {
      if (!agentId || entry.frame.agentId === agentId) this.resolve(id, this.fallback)
    }
  }
}