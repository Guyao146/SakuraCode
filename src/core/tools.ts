/**
 * ctx.tools — scoped tool registry and the guarded execution pipeline.
 * Every call flows tools/pre-execute → tools/execute → tools/post-execute
 * (all waterfalls). Listeners may reject (throw) in pre-execute, short-circuit
 * in execute, or rewrite the output in post-execute. Approval gates are just
 * a pre-execute listener.
 */

import type { Context } from '../kernel/index.js'
import type { JsonSchemaObject, ToolContext, ToolDefinition, ToolSchema } from './types.js'

export interface ToolsExecutePayload {
  callId: string
  name: string
  args: Record<string, unknown>
  argsRaw: string
  tc: ToolContext
  tool?: ToolDefinition
  output?: string
  isError?: boolean
  ui?: Record<string, unknown>
  images?: string[]
  blockedReason?: string
}

/** Describe an argument value for an error message. */
function describeValue(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Validate call arguments against the tool's own JSON schema.
 *
 * Arguments arrive from the model as raw JSON, and tools read them with
 * `String(args.file_path)`-style coercion. A missing argument therefore
 * becomes the literal string "undefined": `write` would create a file named
 * `undefined` in the working directory instead of reporting a bad call.
 * The schema is already attached to every definition, so the check belongs
 * here rather than in each tool.
 *
 * Only two rules are enforced — a missing required key, and a present value
 * whose declared type is `string` but which is not a string. Richer schema
 * validation stays the individual tool's business.
 */
function validateArgs(tool: ToolDefinition, args: Record<string, unknown>): string | undefined {
  const required = tool.parameters.required ?? []
  const missing = required.filter((key) => args[key] === undefined || args[key] === null)
  if (missing.length > 0) {
    const list = missing.map((key) => `"${key}"`).join(', ')
    return `missing required argument${missing.length > 1 ? 's' : ''}: ${list}`
  }
  const properties = (tool.parameters.properties ?? {}) as Record<string, { type?: string } | undefined>
  for (const [key, schema] of Object.entries(properties)) {
    const value = args[key]
    if (schema?.type === 'string' && value !== undefined && typeof value !== 'string') {
      return `argument "${key}" must be a string (got ${describeValue(value)})`
    }
  }
  return undefined
}

export class ToolsService {
  private defs = new Map<string, ToolDefinition>()

  constructor(private ctx: Context) {}

  /** Register a tool on ctx.tools; its schema joins prompt assembly. */
  register(def: ToolDefinition): () => void {
    if (this.defs.has(def.name)) throw new Error(`tool "${def.name}" is already registered`)
    this.defs.set(def.name, def)
    this.ctx.emit('tools/registered', def)
    return () => this.defs.delete(def.name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name)
  }

  names(): string[] {
    return [...this.defs.keys()]
  }

  /** Filter to the tools an agent may see (by name), then project to wire schemas. */
  schemas(filter?: (name: string) => boolean): ToolSchema[] {
    return [...this.defs.values()]
      .filter((t) => (filter ? filter(t.name) : true))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  }

  list(): ToolDefinition[] {
    return [...this.defs.values()]
  }

  /** Run one tool call through the guarded pipeline. Never throws. */
  async execute(
    callId: string,
    name: string,
    argsRaw: string,
    tc: ToolContext,
  ): Promise<{ output: string; isError?: boolean; ui?: Record<string, unknown>; images?: string[]; durationMs: number }> {
    const started = Date.now()
    const tool = this.defs.get(name)
    const finish = async (payload: Partial<ToolsExecutePayload>) => {
      const output = payload.output ?? ''
      const durationMs = Date.now() - started
      this.ctx.emit('tool/result', {
        callId,
        name,
        output,
        isError: payload.isError ?? false,
        durationMs,
        ...(payload.images ? { images: payload.images } : {}),
      })
      return {
        output,
        isError: payload.isError,
        ui: payload.ui,
        images: payload.images,
        durationMs,
      }
    }

    if (!tool) return finish({ output: `error: unknown tool "${name}"`, isError: true })

    let args: Record<string, unknown> = {}
    if (argsRaw && argsRaw.trim()) {
      try {
        const parsed = JSON.parse(argsRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
        else if (parsed !== undefined && parsed !== null) args = { value: parsed }
      } catch {
        return finish({ output: `error: tool "${name}" arguments are not valid JSON: ${argsRaw.slice(0, 200)}`, isError: true })
      }
    }

    this.ctx.emit('tool/call', { callId, name, args, argsRaw })

    // Reject bad arguments before the approval gate: there is nothing to
    // approve when the call cannot run, and the model gets a precise reason.
    const invalid = validateArgs(tool, args)
    if (invalid) return finish({ output: `error: tool "${name}" ${invalid}`, isError: true })

    let payload: ToolsExecutePayload = { callId, name, args, argsRaw, tc, tool }
    try {
      tc.signal.throwIfAborted()
      payload = await this.ctx.waterfall<ToolsExecutePayload>('tools/pre-execute', async (p) => p, payload)
      tc.signal.throwIfAborted()
      if (payload.blockedReason) {
        return finish({ output: `error: tool "${name}" blocked — ${payload.blockedReason}`, isError: true })
      }
      payload = await this.ctx.waterfall<ToolsExecutePayload>(
        'tools/execute',
        async (p) => {
          p.tc.signal.throwIfAborted()
          const result = await p.tool!.execute(p.args, p.tc)
          if (typeof result === 'string') p.output = result
          else {
            p.output = result.output
            p.isError = result.isError
            if (result.ui) p.ui = result.ui
            if (result.images) p.images = result.images
          }
          return p
        },
        payload,
      )
      payload = await this.ctx.waterfall<ToolsExecutePayload>('tools/post-execute', async (p) => p, payload)
      return finish(payload)
    } catch (error) {
      const message = tc.signal.aborted ? 'cancelled' : error instanceof Error ? error.message : String(error)
      return finish({ output: `error: ${message}`, isError: true })
    }
  }
}

export const toolsPlugin = {
  name: 'core-tools',
  description: 'Scoped tool registry and guarded execution pipeline (ctx.tools)',
  apply(ctx: import('../kernel/index.js').Context) {
    ctx.provide('tools')
    ctx.set('tools', new ToolsService(ctx))
  },
}

/** Helper for tool plugins: build a JSON-Schema parameters object. */
export function params(properties: Record<string, unknown>, required: string[] = []): JsonSchemaObject {
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}
