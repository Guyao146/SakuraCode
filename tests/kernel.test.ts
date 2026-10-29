import { describe, expect, it } from 'vitest'
import { Context, definePlugin } from '../src/kernel/index.js'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// Service registry: provide / set / get / has / peek
// ---------------------------------------------------------------------------

describe('Context — service registry', () => {
  it('provide/set/get: claim a key, assign it, resolve it', () => {
    const ctx = new Context()
    expect(ctx.has('svc')).toBe(false)

    ctx.provide('svc')
    expect(ctx.has('svc')).toBe(true)
    // Claimed but not yet assigned: get throws, peek is safe.
    expect(() => ctx.get('svc')).toThrow(/provided but not yet assigned/)
    expect(ctx.peek('svc')).toBeUndefined()

    ctx.set('svc', { answer: 42 })
    expect(ctx.get<{ answer: number }>('svc')).toEqual({ answer: 42 })
  })

  it('get() on a missing key throws a helpful error; peek() returns undefined', () => {
    const ctx = new Context()
    expect(() => ctx.get('ghost')).toThrow(/is not available/)
    expect(ctx.peek('ghost')).toBeUndefined()
  })

  it('set() without a prior provide() throws', () => {
    const ctx = new Context()
    expect(() => ctx.set('nope', 1)).toThrow(/call ctx\.provide\("nope"\) first/)
  })

  it('providing the same key twice on one context throws', () => {
    const ctx = new Context()
    ctx.provide('dup')
    expect(() => ctx.provide('dup')).toThrow(/already provided/)
  })

  it('the disposer returned by provide() releases the key (re-claimable afterwards)', () => {
    const ctx = new Context()
    const release = ctx.provide('tmp')
    ctx.set('tmp', 1)
    release()
    expect(ctx.has('tmp')).toBe(false)

    ctx.provide('tmp')
    ctx.set('tmp', 2)
    expect(ctx.get('tmp')).toBe(2)
  })

  it('registries are shared with the tree: child services resolve everywhere', () => {
    const parent = new Context()
    parent.provide('svc')
    parent.set('svc', 42)

    const child = parent.fork()
    expect(child.has('svc')).toBe(true)
    expect(child.get<number>('svc')).toBe(42)

    // Shared registry: a child's provide is visible to the parent too —
    // this is what lets a plugin's service satisfy another plugin's inject.
    child.provide('own')
    child.set('own', 'x')
    expect(child.has('own')).toBe(true)
    expect(parent.has('own')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Events — emit
// ---------------------------------------------------------------------------

describe('Context — emit', () => {
  it('fires listeners synchronously in registration order and forwards args', () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('e', (a: number, b: number) => order.push(`first:${a}${b}`))
    ctx.on('e', () => order.push('second'))

    ctx.emit('e', 1, 2)
    expect(order).toEqual(['first:12', 'second'])
  })

  it('swallows listener errors and reports them on kernel/error', () => {
    const ctx = new Context()
    const errors: Array<{ event: string; error: Error }> = []
    ctx.on('kernel/error', (payload) => errors.push(payload))
    ctx.on('boom', () => {
      throw new Error('kaboom')
    })
    const order: string[] = []
    ctx.on('boom', () => order.push('still-ran'))

    ctx.emit('boom')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.event).toBe('boom')
    expect(errors[0]!.error.message).toBe('kaboom')
    expect(order).toEqual(['still-ran'])
  })

  it('listeners live in one shared registry: parent and child hear each other', () => {
    const parent = new Context()
    const child = parent.fork()
    const order: string[] = []
    parent.on('e', () => order.push('parent'))
    child.on('e', () => order.push('child'))

    child.emit('e')
    expect(order).toEqual(['parent', 'child'])

    order.length = 0
    parent.emit('e')
    expect(order).toEqual(['parent', 'child'])
  })
})

// ---------------------------------------------------------------------------
// Events — parallel
// ---------------------------------------------------------------------------

describe('Context — parallel', () => {
  it('awaits all listeners, running them concurrently', async () => {
    const ctx = new Context()
    const gates: Array<() => void> = []
    const started: string[] = []
    const done: string[] = []

    ctx.on('p', async () => {
      started.push('a')
      await new Promise<void>((resolve) => gates.push(resolve))
      done.push('a')
    })
    ctx.on('p', async () => {
      started.push('b')
      await new Promise<void>((resolve) => gates.push(resolve))
      done.push('b')
    })

    const dispatch = ctx.parallel('p')
    // Both listeners started before any of them finished => concurrent, not serial.
    expect(started).toEqual(['a', 'b'])
    expect(done).toEqual([])

    // Release in reverse order to prove the listeners are independent.
    gates[1]!()
    gates[0]!()
    await dispatch
    expect(done).toHaveLength(2)
  })

  it('swallows listener errors and reports them on kernel/error', async () => {
    const ctx = new Context()
    const errors: Array<{ event: string; error: Error }> = []
    ctx.on('kernel/error', (payload) => errors.push(payload))
    ctx.on('p', async () => {
      throw new Error('parallel boom')
    })

    await ctx.parallel('p')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.event).toBe('p')
    expect(errors[0]!.error.message).toBe('parallel boom')
  })
})

// ---------------------------------------------------------------------------
// Events — serial
// ---------------------------------------------------------------------------

describe('Context — serial', () => {
  it('awaits listeners in registration order and collects return values', async () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.on('s', async () => {
      await tick(5)
      order.push('a-done')
      return 'r1'
    })
    ctx.on('s', () => {
      order.push('b-called')
      return 'r2'
    })

    const results = await ctx.serial('s')
    expect(results).toEqual(['r1', 'r2'])
    // 'b' only ran after 'a' fully finished.
    expect(order).toEqual(['a-done', 'b-called'])
  })
})

// ---------------------------------------------------------------------------
// Events — bail
// ---------------------------------------------------------------------------

describe('Context — bail', () => {
  it('stops at the first non-undefined return value', async () => {
    const ctx = new Context()
    const calls: string[] = []
    ctx.on('b', async () => {
      calls.push('1')
      return undefined
    })
    ctx.on('b', async () => {
      calls.push('2')
      return 'hit'
    })
    ctx.on('b', async () => {
      calls.push('3')
      return 'never'
    })

    const result = await ctx.bail('b')
    expect(result).toBe('hit')
    expect(calls).toEqual(['1', '2'])
  })

  it('returns undefined when every listener returns undefined', async () => {
    const ctx = new Context()
    ctx.on('b', () => undefined)
    expect(await ctx.bail('b')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Events — waterfall
// ---------------------------------------------------------------------------

describe('Context — waterfall', () => {
  it('runs the base handler directly when there are no listeners', async () => {
    const ctx = new Context()
    const basePayloads: string[] = []
    const result = await ctx.waterfall<string>(
      'wf',
      async (payload) => {
        basePayloads.push(payload)
        return `${payload}-base`
      },
      'in',
    )
    expect(result).toBe('in-base')
    expect(basePayloads).toEqual(['in'])
  })

  it('a listener calling next() delegates to the base handler', async () => {
    const ctx = new Context()
    let basePayload: string | undefined
    ctx.on('wf', (_payload: string, next: (r?: string) => Promise<string>) => next())
    const result = await ctx.waterfall<string>(
      'wf',
      async (payload) => {
        basePayload = payload
        return payload
      },
      'in',
    )
    expect(basePayload).toBe('in')
    expect(result).toBe('in')
  })

  it('a listener can delegate with a replacement payload', async () => {
    const ctx = new Context()
    let basePayload: string | undefined
    ctx.on('wf', (_payload: string, next: (r?: string) => Promise<string>) => next('replaced'))
    const result = await ctx.waterfall<string>(
      'wf',
      async (payload) => {
        basePayload = payload
        return payload
      },
      'in',
    )
    expect(basePayload).toBe('replaced')
    expect(result).toBe('replaced')
  })

  it('chains middleware in registration order: first listener is outermost', async () => {
    const ctx = new Context()
    let basePayload: string | undefined
    ctx.on('wf', (p: string, next: (r?: string) => Promise<string>) => next(`${p}>1`))
    ctx.on('wf', (p: string, next: (r?: string) => Promise<string>) => next(`${p}>2`))
    const result = await ctx.waterfall<string>(
      'wf',
      async (payload) => {
        basePayload = payload
        return payload
      },
      'in',
    )
    expect(basePayload).toBe('in>1>2')
    expect(result).toBe('in>1>2')
  })

  it('returning without calling next() short-circuits (base handler skipped)', async () => {
    const ctx = new Context()
    let baseRan = false
    ctx.on('wf', (p: number, next: (r?: number) => Promise<number>) => next(p + 1))
    ctx.on('wf', (p: number, _next: (r?: number) => Promise<number>) => p * 100)
    const result = await ctx.waterfall<number>(
      'wf',
      async (payload) => {
        baseRan = true
        return payload
      },
      1,
    )
    expect(result).toBe(200) // (1 + 1) * 100
    expect(baseRan).toBe(false)
  })

  it('listeners walk parent contexts: the parent listener is the outer middleware', async () => {
    const parent = new Context()
    const child = parent.fork()
    parent.on('wf', (p: string, next: (r?: string) => Promise<string>) => next(`${p}P`))
    child.on('wf', (p: string, next: (r?: string) => Promise<string>) => next(`${p}C`))
    const result = await child.waterfall<string>('wf', async (payload) => `${payload}!`, 'in')
    expect(result).toBe('inPC!')
  })
})

// ---------------------------------------------------------------------------
// effect()
// ---------------------------------------------------------------------------

describe('Context — effect()', () => {
  it('runs setup immediately and its disposer on dispose, in LIFO order', () => {
    const ctx = new Context()
    const order: string[] = []
    ctx.effect(() => {
      order.push('setup-1')
      return () => order.push('dispose-1')
    })
    ctx.effect(() => {
      order.push('setup-2')
      return () => order.push('dispose-2')
    })
    ctx.effect(() => {
      order.push('setup-3')
      return () => order.push('dispose-3')
    })

    expect(order).toEqual(['setup-1', 'setup-2', 'setup-3'])
    ctx.dispose()
    expect(order).toEqual(['setup-1', 'setup-2', 'setup-3', 'dispose-3', 'dispose-2', 'dispose-1'])
  })

  it('an effect whose setup returns nothing disposes harmlessly', () => {
    const ctx = new Context()
    expect(() => ctx.effect(() => {})).not.toThrow()
    expect(() => ctx.dispose()).not.toThrow()
    expect(ctx.isDisposed()).toBe(true)
  })

  it('an early-disposed effect runs once and is removed from the unwind list', () => {
    const ctx = new Context()
    let runs = 0
    const disposeEarly = ctx.effect(() => () => {
      runs++
    })
    disposeEarly()
    ctx.dispose()
    expect(runs).toBe(1)
  })

  it('a disposer that throws during dispose is reported on kernel/error and does not stop the unwind', () => {
    const ctx = new Context()
    const errors: Array<{ event: string; error: Error }> = []
    ctx.on('kernel/error', (payload) => errors.push(payload))
    const order: string[] = []
    ctx.effect(() => () => {
      throw new Error('cleanup fail')
    })
    ctx.effect(() => () => order.push('second'))

    expect(() => ctx.dispose()).not.toThrow()
    expect(order).toEqual(['second'])
    expect(errors).toHaveLength(1)
    expect(errors[0]!.event).toBe('dispose')
    expect(errors[0]!.error.message).toBe('cleanup fail')
    expect(ctx.isDisposed()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// plugin()
// ---------------------------------------------------------------------------

describe('Context — plugin()', () => {
  it('mounts a module plugin, passing config through and returning a child scope', async () => {
    const ctx = new Context()
    const config = { tier: 'free' }
    let sawConfig: unknown
    let sawCtx: unknown

    const scope = await ctx.plugin({
      name: 'greeter',
      apply(c: Context, cfg: typeof config) {
        sawCtx = c
        sawConfig = cfg
      },
    }, config)

    expect(sawConfig).toBe(config)
    expect(sawCtx).toBe(scope)
    expect(scope.parent).toBe(ctx)
    expect(scope.pluginId).not.toBe(ctx.pluginId)
    expect(scope.isDisposed()).toBe(false)
  })

  it('resolves inject and passes required services positionally in inject order', async () => {
    const ctx = new Context()
    ctx.provide('a')
    ctx.set('a', 'A')
    ctx.provide('b')
    ctx.set('b', 'B')

    const seen: unknown[] = []
    await ctx.plugin({
      name: 'inj',
      inject: ['a', 'b'],
      apply(_ctx, _config, a, b) {
        seen.push(a, b)
      },
    })

    expect(seen).toEqual(['A', 'B'])
  })

  it('mounting a plugin whose inject cannot be satisfied rejects, naming the missing key', async () => {
    const ctx = new Context()
    await expect(
      ctx.plugin({ name: 'thirsty', inject: ['nope'], apply: () => {} }),
    ).rejects.toThrow(/plugin "thirsty" cannot mount: missing required service\(s\) \[nope\]/)
  })

  it('apply() throwing rejects with a wrapped error message', async () => {
    const ctx = new Context()
    await expect(
      ctx.plugin({
        name: 'boom',
        apply() {
          throw new Error('inner failure')
        },
      }),
    ).rejects.toThrow(/plugin "boom" failed to apply: inner failure/)
  })

  it('disposing the plugin scope removes its registrations (listeners, services, effects)', async () => {
    const ctx = new Context()
    const order: string[] = []

    const scope = await ctx.plugin({
      name: 'scoped',
      apply(s) {
        s.provide('psvc')
        s.set('psvc', 42)
        s.on('p-event', () => order.push('listener'))
        s.effect(() => () => order.push('effect'))
      },
    })

    scope.emit('p-event')
    expect(order).toEqual(['listener'])
    expect(scope.get('psvc')).toBe(42)

    scope.dispose()
    expect(scope.isDisposed()).toBe(true)
    scope.emit('p-event')
    expect(scope.has('psvc')).toBe(false)
    expect(order).toEqual(['listener', 'effect'])

    // The mounting context is unaffected and never saw the plugin's private listener.
    ctx.emit('p-event')
    expect(order).toEqual(['listener', 'effect'])
  })

  it('apply returning a Disposable registers it as a disposer', async () => {
    const ctx = new Context()
    let disposed = false
    const scope = await ctx.plugin({
      name: 'disposable',
      apply: () => () => {
        disposed = true
      },
    })

    expect(disposed).toBe(false)
    scope.dispose()
    expect(disposed).toBe(true)
  })

  it('apply returning a ServiceLifecycle registers stop() as the disposer', async () => {
    const ctx = new Context()
    let stopped = false
    const scope = await ctx.plugin({
      name: 'lifecycle',
      apply: () => ({
        stop: () => {
          stopped = true
        },
      }),
    })

    expect(stopped).toBe(false)
    scope.dispose()
    expect(stopped).toBe(true)
  })

  it('disposing the mounting context cascades into plugin scopes, LIFO across plugins', async () => {
    const ctx = new Context()
    const order: string[] = []

    const scope1 = await ctx.plugin({
      name: 'p1',
      apply: (s) => {
        s.effect(() => () => order.push('p1'))
      },
    })
    const scope2 = await ctx.plugin({
      name: 'p2',
      apply: (s) => {
        s.effect(() => () => order.push('p2'))
      },
    })

    ctx.dispose()
    expect(order).toEqual(['p2', 'p1'])
    expect(scope1.isDisposed()).toBe(true)
    expect(scope2.isDisposed()).toBe(true)
    expect(ctx.isDisposed()).toBe(true)
  })

  it('definePlugin is an identity helper; its module mounts like any other', async () => {
    const ctx = new Context()
    const mod = definePlugin({
      name: 'dp',
      apply(c) {
        c.provide('x')
        c.set('x', 1)
      },
    })
    const scope = await ctx.plugin(mod)
    expect(scope.get('x')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// fork()
// ---------------------------------------------------------------------------

describe('Context — fork()', () => {
  it('child shares parent services', () => {
    const parent = new Context()
    parent.provide('svc')
    parent.set('svc', { v: 7 })

    const child = parent.fork()
    expect(child.get<{ v: number }>('svc')).toEqual({ v: 7 })
  })

  it('listeners live in a shared registry: parent and child see each other', () => {
    const parent = new Context()
    const child = parent.fork()
    const order: string[] = []
    parent.on('e', () => order.push('parent'))
    child.on('e', () => order.push('child'))

    child.emit('e')
    expect(order).toEqual(['parent', 'child'])

    order.length = 0
    parent.emit('e')
    expect(order).toEqual(['parent', 'child'])
  })

  it('registries are shared (cordis-style) but disposal is scoped to each context', () => {
    const parent = new Context()
    const child = parent.fork()

    // A scope's provides are visible to the whole tree — this is what lets
    // one plugin satisfy another plugin's inject.
    child.provide('csvc')
    child.set('csvc', 1)
    expect(parent.has('csvc')).toBe(true)

    const order: string[] = []
    const removeChildListener = child.on('e', () => order.push('child'))
    parent.emit('e')
    expect(order).toEqual(['child'])

    // Disposing the child unwinds exactly the child's own registrations.
    let effectDisposed = false
    child.effect(() => () => {
      effectDisposed = true
    })
    child.dispose()
    expect(effectDisposed).toBe(true)
    expect(parent.has('csvc')).toBe(false)
    removeChildListener()
  })

  it('disposing the child does not kill the parent', () => {
    const parent = new Context()
    parent.provide('svc')
    parent.set('svc', 1)
    const hits: string[] = []
    parent.on('e', () => hits.push('parent'))

    const child = parent.fork()
    child.on('e', () => hits.push('child'))
    let effectDisposed = false
    child.effect(() => () => {
      effectDisposed = true
    })

    child.dispose()
    expect(child.isDisposed()).toBe(true)
    expect(parent.isDisposed()).toBe(false)
    expect(parent.get<number>('svc')).toBe(1)

    parent.emit('e')
    expect(hits).toEqual(['parent'])
    expect(effectDisposed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Subclassing via createContext()
// ---------------------------------------------------------------------------

class SubContext extends Context {
  readonly kind = 'sub'

  protected override createContext(parent?: Context): Context {
    return new SubContext(parent)
  }
}

describe('Context — subclassing via createContext()', () => {
  it('fork() returns the subclass, wired to its parent', () => {
    const root = new SubContext()
    const child = root.fork()
    expect(child).toBeInstanceOf(SubContext)
    expect(child).toHaveProperty('kind', 'sub')
    expect(child.parent).toBe(root)
  })

  it('plugin scopes are the subclass; services flow through the parent chain', async () => {
    const root = new SubContext()
    root.provide('svc')
    root.set('svc', 7)

    const scope = await root.plugin({ name: 'p', apply() {} })
    expect(scope).toBeInstanceOf(SubContext)
    expect(scope).toHaveProperty('kind', 'sub')
    expect(scope.parent).toBe(root)
    expect(scope.get<number>('svc')).toBe(7)

    // Plugins mounted on a plugin scope are subclasses too.
    const inner = await scope.plugin({ name: 'inner', apply() {} })
    expect(inner).toBeInstanceOf(SubContext)
    expect(inner.parent).toBe(scope)
  })
})
