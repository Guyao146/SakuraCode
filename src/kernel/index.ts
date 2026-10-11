/**
 * @sakura/kernel — a Cordis-style microkernel.
 *
 * Design aligns with DeepSeek Harness (dsh): "Everything is a Plugin".
 * A running harness is a Context — a repository of services. Plugins are
 * plain modules exporting `name` / `inject` / `apply(ctx, config)`, or a
 * Service subclass whose lifecycle the kernel mounts into the context.
 *
 * Event dispatch modes (the mode is part of the event's public contract):
 *   emit      — fire-and-forget, registration order, no return value
 *   parallel  — awaited, concurrent, no return value
 *   serial    — awaited, registration order, collects return values
 *   bail      — awaited, until one listener returns non-undefined
 *   waterfall — around-middleware: a listener receives (...args, next);
 *               calling next() delegates the (possibly wrapped) result
 *               onward; returning without next() short-circuits.
 *
 * Every registration is reversible: effect()/on() return a disposer, and
 * disposing a context unwinds registrations in LIFO order.
 */

export type Disposable = () => void

export type ServiceLifecycle = {
  start?: () => Promise<void> | void
  stop?: () => Promise<void> | void
}

/** A plugin is a plain function carrying optional `inject`/`name` fields, or a module object. */
export interface PluginModule<C = any> {
  name?: string
  /** Required service keys; the kernel mounts this plugin only once they all exist. */
  inject?: readonly string[]
  /** Required services are also passed positionally after ctx, in inject order. */
  apply?: (ctx: Context, config: C, ...injected: unknown[]) => void | Promise<void> | Disposable | ServiceLifecycle
  /** Config schema description — plain JSON Schema object, documentation only in v0. */
  config?: Record<string, unknown>
  /** Human-readable plugin description. */
  description?: string
}

export type Plugin<C = any> =
  | PluginModule<C>
  | (((ctx: Context, config: C, ...injected: unknown[]) => void | Promise<void> | Disposable | ServiceLifecycle) & {
      name?: string
      inject?: readonly string[]
      description?: string
    })

export type Listener = (...args: any[]) => any

export interface ListenerEntry {
  event: string
  listener: Listener
  prepend?: boolean
}

type PendingPlugin = {
  plugin: Plugin
  config: unknown
  id: string
}

let pluginSeq = 0

export class Context {
  /**
   * Service registry — SHARED with the root context (scopes and forks see
   * every service, cordis-style). Scoping happens through per-context
   * disposers, not through map isolation.
   */
  private readonly services: Map<string, unknown>
  /** Listener registry — shared with the root context, same semantics. */
  private readonly listeners: Map<string, ListenerEntry[]>
  private disposers: Disposable[] = []
  private mounted = new Map<string, { ctx: Context; plugin: Plugin }>()
  private pending: PendingPlugin[] = []
  private disposed = false
  readonly parent?: Context
  /** Kernel-internal id for this plugin scope (used by agents/subagents naming). */
  readonly pluginId: string

  constructor(parent?: Context) {
    this.parent = parent
    this.services = parent ? parent.services : new Map()
    this.listeners = parent ? parent.listeners : new Map()
    this.pluginId = `ctx-${++pluginSeq}`
  }

  /** Subclass hook: scopes and forks should share the subclass type. */
  protected createContext(parent?: Context): Context {
    return new Context(parent)
  }

  // ------------------------------------------------------------------
  // Service registry
  // ------------------------------------------------------------------

  /**
   * Claim a stable service key on this context, e.g. ctx.tools / ctx.llm / ctx.sessions.
   * Returns a disposer. Assign the service value via `ctx.provide(key)` then `ctx[key] = value`.
   */
  provide(key: string): Disposable {
    if (this.services.has(key)) throw new Error(`service "${key}" is already provided on this context`)
    this.services.set(key, undefined)
    const dispose = () => {
      this.services.delete(key)
      const i = this.disposers.indexOf(dispose)
      if (i >= 0) this.disposers.splice(i, 1)
    }
    this.disposers.push(dispose)
    return dispose
  }

  has(key: string): boolean {
    return this.services.has(key)
  }

  /** Resolve a service; throws if a provide()d key has not been assigned yet. */
  get<T = unknown>(key: string): T {
    const value = this.services.get(key)
    if (value === undefined) {
      if (!this.services.has(key)) {
        throw new Error(`service "${key}" is not available — did you forget to mount its plugin?`)
      }
      throw new Error(`service "${key}" is provided but not yet assigned`)
    }
    return value as T
  }

  /** Try to resolve a service, undefined if missing/unassigned. */
  peek<T = unknown>(key: string): T | undefined {
    try {
      return this.get<T>(key)
    } catch {
      return undefined
    }
  }

  // ------------------------------------------------------------------
  // Events — five dispatch modes
  // ------------------------------------------------------------------

  /** Register a listener (emit-mode contract); returns a disposer. */
  on(event: string, listener: Listener, opts: { prepend?: boolean } = {}): Disposable {
    let list = this.listeners.get(event)
    if (!list) this.listeners.set(event, (list = []))
    const entry: ListenerEntry = { event, listener, prepend: opts.prepend }
    if (opts.prepend) list.unshift(entry)
    else list.push(entry)
    const dispose = () => {
      const arr = this.listeners.get(event)
      if (!arr) return
      const i = arr.indexOf(entry)
      if (i >= 0) arr.splice(i, 1)
    }
    this.disposers.push(dispose)
    return dispose
  }

  private allListeners(event: string): Listener[] {
    // The listeners map is shared with the root context, so one lookup covers
    // listeners registered by any scope.
    return (this.listeners.get(event) ?? []).map((e) => e.listener)
  }

  /** emit: not awaited, registration order, no return value. */
  emit(event: string, ...args: any[]): void {
    for (const listener of this.allListeners(event)) {
      try {
        listener(...args)
      } catch (error) {
        if (event !== 'kernel/error') this.emit('kernel/error', { event, error })
      }
    }
  }

  /** parallel: awaited concurrently, no return values (listener errors are swallowed into kernel/error). */
  async parallel(event: string, ...args: any[]): Promise<void> {
    await Promise.all(
      this.allListeners(event).map(async (listener) => {
        try {
          await listener(...args)
        } catch (error) {
          this.emit('kernel/error', { event, error })
        }
      }),
    )
  }

  /** serial: awaited in registration order, collects return values; listener errors propagate (used by pipelines that must abort). */
  async serial(event: string, ...args: any[]): Promise<any[]> {
    const results: any[] = []
    for (const listener of this.allListeners(event)) {
      results.push(await listener(...args))
    }
    return results
  }

  /** bail: until one listener returns a non-undefined value. */
  async bail(event: string, ...args: any[]): Promise<any> {
    for (const listener of this.allListeners(event)) {
      const result = await listener(...args)
      if (result !== undefined) return result
    }
    return undefined
  }

  /**
   * waterfall: around-middleware. Each listener receives (...args, next);
   * calling next() delegates onward (passing replacement args if given);
   * returning a non-undefined value without calling next() short-circuits
   * (an undefined return passes the payload through unchanged). When every
   * listener delegates, the optional `base` handler runs.
   */
  async waterfall<T>(event: string, base: (payload: T) => Promise<T>, payload: T): Promise<T> {
    const listeners = this.allListeners(event)
    let index = 0
    const dispatch = async (current: T): Promise<T> => {
      if (index >= listeners.length) return base(current)
      const listener = listeners[index++]!
      let delegated = false
      const next = (replacement?: T) => {
        delegated = true
        return dispatch(replacement === undefined ? current : replacement)
      }
      const result = await listener(current, next)
      return delegated ? (result as T) : ((result === undefined ? current : result) as T)
    }
    return dispatch(payload)
  }

  // ------------------------------------------------------------------
  // Reversible registrations & plugins
  // ------------------------------------------------------------------

  /** Wrap side-effectful setup so teardown happens in one place, in LIFO order. */
  effect(setup: () => void | Disposable | void): Disposable {
    const cleanup = setup()
    const dispose = typeof cleanup === 'function' ? cleanup : () => {}
    this.disposers.push(dispose)
    return () => {
      const i = this.disposers.indexOf(dispose)
      if (i >= 0) this.disposers.splice(i, 1)
      dispose()
    }
  }

  /**
   * Mount a plugin. Resolves `inject` by waiting for required services, then
   * calls apply(ctx, config, ...injected). Returns the plugin's own scope
   * context (unmount it with scope.dispose()).
   */
  async plugin(p: Plugin, config?: unknown): Promise<Context> {
    if (this.disposed) throw new Error('cannot mount plugin on a disposed context')
    const mod = (typeof p === 'function' ? { apply: p, name: p.name, inject: p.inject } : p) as PluginModule
    const id = `${mod.name ?? 'anonymous'}-${++pluginSeq}`
    const pending: PendingPlugin = { plugin: p, config, id }
    this.pending.push(pending)
    await this.flushPending(pending)
    return this.mounted.get(id)!.ctx
  }

  private async flushPending(until?: PendingPlugin): Promise<void> {
    // Attempt mounts round-robin until `until` is mounted or nothing can progress.
    let progressed = true
    while (progressed) {
      progressed = false
      for (let i = 0; i < this.pending.length; i++) {
        const pending = this.pending[i]!
        const mod = (typeof pending.plugin === 'function'
          ? { apply: pending.plugin, name: pending.plugin.name, inject: pending.plugin.inject }
          : pending.plugin) as PluginModule
        const inject = mod.inject ?? []
        // Wait for assignment, not just the provide() claim — a service that
        // is claimed but not yet set would fail resolution inside mount().
        const missing = inject.filter((key) => this.peek(key) === undefined)
        if (missing.length > 0) continue
        this.pending.splice(i, 1)
        progressed = true
        await this.mount(pending, mod, inject)
        break
      }
      if (until && this.mounted.has(until.id)) return
    }
    if (until && !this.mounted.has(until.id)) {
      const i = this.pending.indexOf(until)
      if (i >= 0) this.pending.splice(i, 1)
      const mod = (typeof until.plugin === 'function'
        ? { apply: until.plugin, name: until.plugin.name, inject: until.plugin.inject }
        : until.plugin) as PluginModule
      const missing = (mod.inject ?? []).filter((key) => !this.has(key))
      throw new Error(
        `plugin "${mod.name ?? 'anonymous'}" cannot mount: missing required service(s) [${missing.join(', ')}]`,
      )
    }
  }

  private async mount(pending: PendingPlugin, mod: PluginModule, inject: readonly string[]): Promise<void> {
    const scope = this.createContext(this)
    let applied: void | Disposable | ServiceLifecycle
    try {
      const injected = inject.map((key) => this.get(key))
      applied = await mod.apply?.(scope, pending.config, ...injected)
    } catch (error) {
      scope.dispose()
      throw new Error(`plugin "${mod.name ?? 'anonymous'}" failed to apply: ${(error as Error).message}`)
    }
    if (typeof applied === 'function') scope.disposers.push(applied)
    else if (applied && typeof applied === 'object') scope.disposers.push(() => applied.stop?.())
    this.mounted.set(pending.id, { ctx: scope, plugin: pending.plugin })
    this.disposers.push(() => {
      this.mounted.delete(pending.id)
      scope.dispose()
    })
  }

  // ------------------------------------------------------------------
  // Lifecycle & fork
  // ------------------------------------------------------------------

  /** Assign the implementation of a provided service key (provide() first). */
  set(key: string, value: unknown): void {
    if (!this.services.has(key)) {
      throw new Error(`cannot set service "${key}" — call ctx.provide("${key}") first`)
    }
    this.services.set(key, value)
  }

  /** Emit kernel/start to listeners; a hook for eager service warmup. */
  async start(): Promise<void> {
    await this.parallel('kernel/start')
  }

  /** Create a child context: shares parent services & listeners, owns its own registrations. */
  fork(): Context {
    return this.createContext(this)
  }

  /** Unwind this scope's registrations in LIFO order. Because every
   *  registration pushed a disposer, the shared registries lose exactly the
   *  entries this context owns — nothing else is touched. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of [...this.disposers].reverse()) {
      try {
        dispose()
      } catch (error) {
        this.emit('kernel/error', { event: 'dispose', error })
      }
    }
    this.disposers = []
  }

  isDisposed(): boolean {
    return this.disposed
  }
}

/** Convenience: declare a plugin module with typing help. */
export function definePlugin<C>(mod: PluginModule<C>): PluginModule<C> {
  return mod
}
