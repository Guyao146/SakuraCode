import { describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { OpenAICompatAdapter, type UpstreamFormat } from '../src/core/llm.js'
import { ToolsService } from '../src/core/tools.js'
import type { LLMRequest, StreamChunk, ToolDefinition } from '../src/core/types.js'

type CallChunk = Extract<StreamChunk, { type: 'tool_call' }>

function fixture(events: Record<string, unknown>[], format: UpstreamFormat = 'responses') {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ))
  return {
    fetch,
    adapter: new OpenAICompatAdapter({
      baseURL: 'http://127.0.0.1:1/v1', model: 'test-model', format, fetch,
    }),
  }
}

async function collect(adapter: OpenAICompatAdapter, req: LLMRequest = { messages: [] }): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(req)) chunks.push(chunk)
  return chunks
}

function callChunks(chunks: StreamChunk[]): CallChunk[] {
  return chunks.filter((chunk): chunk is CallChunk => chunk.type === 'tool_call')
}

function assembledCalls(chunks: StreamChunk[]) {
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  for (const chunk of callChunks(chunks)) {
    const call = calls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
    if (chunk.id) call.id = chunk.id
    if (chunk.name) call.name += chunk.name
    if (chunk.argsDelta) call.arguments += chunk.argsDelta
    calls.set(chunk.index, call)
  }
  return [...calls.entries()].map(([index, call]) => ({ index, ...call }))
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `Tool ${name}`,
    kind: 'read',
    parameters: {
      type: 'object',
      properties: {
        phase: { type: 'string', enum: ['z', 'A', 'b'] },
        value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
      required: ['value', 'phase'],
    },
    execute: async () => 'done',
  }
}

describe('wire tool schema ordering', () => {
  it('sorts ASCII names independently of registration order without changing registry or parameter arrays', () => {
    const names = ['z_tool', 'a_tool', 'A_tool', '_tool', 'a-tool', 'a0_tool']
    const definitions = names.map(tool)
    const before = JSON.stringify(definitions.map((definition) => definition.parameters))
    const first = new ToolsService(new Context())
    const second = new ToolsService(new Context())
    for (const definition of definitions) first.register(definition)
    for (const definition of [...definitions].reverse()) second.register(definition)

    expect(first.schemas().map((schema) => schema.name)).toEqual(['A_tool', '_tool', 'a-tool', 'a0_tool', 'a_tool', 'z_tool'])
    expect(first.schemas()).toEqual(second.schemas())
    expect(first.names()).toEqual(names)
    expect(first.list()).toEqual(definitions)
    expect(second.names()).toEqual([...names].reverse())
    expect(second.list()).toEqual([...definitions].reverse())
    expect(JSON.stringify(definitions.map((definition) => definition.parameters))).toBe(before)
    for (const schema of first.schemas()) expect(schema.parameters).toBe(first.get(schema.name)!.parameters)

    const visited: string[] = []
    expect(first.schemas((name) => {
      visited.push(name)
      return name === 'z_tool' || name === 'A_tool'
    }).map((schema) => schema.name)).toEqual(['A_tool', 'z_tool'])
    expect(visited).toEqual(names)
  })

  it.each(['chat-completions', 'responses'] as const)('keeps sorted schemas on the %s wire', async (format) => {
    const tools = new ToolsService(new Context())
    tools.register(tool('z_tool'))
    tools.register(tool('A_tool'))
    const schemas = tools.schemas()
    const terminal = format === 'responses'
      ? { type: 'response.completed', response: {} }
      : { choices: [{ delta: {}, finish_reason: 'stop' }] }
    const { adapter, fetch } = fixture([terminal], format)
    await collect(adapter, { messages: [], tools: schemas })

    expect(fetch).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body))
    const wire = format === 'responses' ? body.tools : body.tools.map((row: { function: unknown }) => row.function)
    expect(wire.map((row: { name: string }) => row.name)).toEqual(['A_tool', 'z_tool'])
    expect(wire.map((row: { parameters: unknown }) => row.parameters)).toEqual(schemas.map((schema) => schema.parameters))
    expect(tools.names()).toEqual(['z_tool', 'A_tool'])
  })
})

describe('Responses tool-call streaming', () => {
  it('emits names once and accumulates deltas without replaying done or final arguments', async () => {
    const item = { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'read_file', arguments: '{"path":"src/index.ts"}' }
    const { adapter } = fixture([
      { type: 'response.output_item.added', item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: '"src/' },
      { type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: 'index.ts"}' },
      { type: 'response.function_call_arguments.done', item_id: 'item-a', arguments: item.arguments },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { output: [item] } },
    ])
    const chunks = await collect(adapter)
    const calls = callChunks(chunks)
    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual({ type: 'tool_call', index: 0, id: 'call-a', name: 'read_file' })
    expect(calls.filter((call) => call.name !== undefined)).toHaveLength(1)
    expect(assembledCalls(chunks)).toEqual([{ index: 0, id: 'call-a', name: 'read_file', arguments: item.arguments }])
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'tool_calls' })
  })

  it.each([undefined, '', '{}'])('preserves argument-free calls (%j)', async (args) => {
    const item = { type: 'function_call', id: 'item-empty', call_id: 'call-empty', name: 'ping', arguments: args }
    const { adapter } = fixture([
      { type: 'response.output_item.added', item },
      { type: 'response.function_call_arguments.done', item_id: 'item-empty', arguments: args },
      { type: 'response.output_item.done', item },
      { type: 'response.completed', response: { output: [item] } },
    ])
    const chunks = await collect(adapter)
    expect(callChunks(chunks)).toHaveLength(1)
    expect(assembledCalls(chunks)).toEqual([{ index: 0, id: 'call-empty', name: 'ping', arguments: args ?? '' }])
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'tool_calls' })
  })

  it.each(['added', 'arguments.done', 'item.done', 'completed'] as const)('uses full arguments once from %s when no argument deltas exist', async (stage) => {
    const item = { type: 'function_call', id: 'item-full', call_id: 'call-full', name: 'lookup', arguments: '{"value":1}' }
    const events: Record<string, unknown>[] = [
      { type: 'response.output_item.added', item: { ...item, arguments: stage === 'added' ? item.arguments : '' } },
    ]
    if (stage === 'arguments.done') events.push({ type: 'response.function_call_arguments.done', item_id: item.id, arguments: item.arguments })
    if (stage === 'item.done') events.push({ type: 'response.output_item.done', item })
    events.push({ type: 'response.completed', response: { output: [item] } })
    const chunks = await collect(fixture(events).adapter)
    expect(callChunks(chunks).filter((call) => call.name !== undefined)).toHaveLength(1)
    expect(callChunks(chunks).filter((call) => call.argsDelta !== undefined)).toHaveLength(1)
    expect(assembledCalls(chunks)).toEqual([{ index: 0, id: 'call-full', name: 'lookup', arguments: item.arguments }])
  })

  it('keeps interleaved tools separate and delivers late metadata and ID-only updates', async () => {
    const first = { type: 'function_call', id: 'item-first', call_id: 'call-final', name: 'first', arguments: '{"left":1}' }
    const second = { type: 'function_call', id: 'item-second', call_id: 'call-second', name: 'second', arguments: '{"right":2}' }
    const { adapter } = fixture([
      { type: 'response.function_call_arguments.delta', item_id: first.id, delta: '{"left":' },
      { type: 'response.output_item.added', item: { ...second, arguments: '' } },
      { type: 'response.output_item.added', item: { ...first, call_id: 'call-initial', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: first.id, delta: '1}' },
      { type: 'response.function_call_arguments.delta', item_id: second.id, delta: second.arguments },
      { type: 'response.output_item.done', item: first },
      { type: 'response.function_call_arguments.done', call_id: second.call_id, arguments: second.arguments },
      { type: 'response.completed', response: { output: [{ ...first, id: '' }, second] } },
    ])
    const chunks = await collect(adapter)
    const calls = callChunks(chunks)
    expect(calls[0]).toEqual({ type: 'tool_call', index: 0, id: 'item-first', argsDelta: '{"left":' })
    expect(calls).toContainEqual({ type: 'tool_call', index: 0, id: 'call-final' })
    expect(calls.filter((call) => call.name !== undefined).map((call) => call.name)).toEqual(['second', 'first'])
    expect(assembledCalls(chunks)).toEqual([
      { index: 0, id: 'call-final', name: 'first', arguments: first.arguments },
      { index: 1, id: 'call-second', name: 'second', arguments: second.arguments },
    ])
  })

  it('accepts final-only tools alongside streamed text and falls back from empty item IDs to call IDs', async () => {
    const { adapter } = fixture([
      { type: 'response.output_text.delta', delta: 'summary' },
      { type: 'response.completed', response: {
        output_text: 'summary',
        output: [
          { type: 'function_call', id: '', call_id: 'call-ping', name: 'ping', arguments: '' },
          { type: 'function_call', id: 'item-lookup', call_id: 'call-lookup', name: 'lookup', arguments: '{"value":2}' },
        ],
      } },
    ])
    const chunks = await collect(adapter)
    expect(chunks.filter((chunk) => chunk.type === 'text')).toEqual([{ type: 'text', delta: 'summary' }])
    expect(assembledCalls(chunks)).toEqual([
      { index: 0, id: 'call-ping', name: 'ping', arguments: '' },
      { index: 1, id: 'call-lookup', name: 'lookup', arguments: '{"value":2}' },
    ])
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'tool_calls' })
  })

  it.each([true, false])('reports length for incomplete responses with calls (streamed: %s)', async (streamed) => {
    const item = { type: 'function_call', id: 'item-short', call_id: 'call-short', name: 'lookup', arguments: '{"value":1}' }
    const events: Record<string, unknown>[] = []
    if (streamed) {
      events.push(
        { type: 'response.output_item.added', item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"value":' },
      )
    }
    events.push(
      { type: 'response.incomplete', response: { output: [item], incomplete_details: { reason: 'max_output_tokens' } } },
      { type: 'response.output_item.done', item },
    )
    const chunks = await collect(fixture(events).adapter)
    expect(assembledCalls(chunks)).toEqual([{ index: 0, id: 'call-short', name: 'lookup', arguments: streamed ? '{"value":' : item.arguments }])
    expect(chunks.at(-1)).toEqual({ type: 'done', reason: 'length' })
  })

  it.each([
    { label: 'interrupted stream', events: [{ type: 'response.output_text.delta', delta: 'partial' }], retryable: true },
    { label: 'failed response', events: [{ type: 'response.failed', response: { error: { code: 'server_error', message: 'temporary' } } }], retryable: true },
    { label: 'nonretryable response', events: [{ type: 'error', error: { code: 'insufficient_quota', message: 'unavailable' } }], retryable: false },
  ])('preserves existing retry classification for $label', async ({ events, retryable }) => {
    await expect(collect(fixture(events).adapter)).rejects.toMatchObject({ retryable })
  })

  it('passes cancellation through the fetch seam without wrapping it as a retry failure', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      controller.signal.throwIfAborted()
      throw new Error('expected an aborted request')
    })
    const adapter = new OpenAICompatAdapter({ baseURL: 'http://127.0.0.1:1/v1', model: 'test-model', format: 'responses', fetch })
    await expect(collect(adapter, { messages: [], signal: controller.signal })).rejects.toBe(controller.signal.reason)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe.each(['chat-completions', 'responses'] as const)('%s cache usage aliases', (format) => {
  const cases: Array<{ label: string; details?: Record<string, unknown>; aliases: Record<string, unknown>; expected?: number }> = [
    { label: 'new top-level alias', aliases: { prompt_cache_hit_tokens: 64 }, expected: 64 },
    { label: 'explicit zero in the new alias', aliases: { prompt_cache_hit_tokens: 0 }, expected: 0 },
    { label: 'existing top-level alias wins', aliases: { prompt_cache_hits: 21, prompt_cache_hit_tokens: 31 }, expected: 21 },
    { label: 'existing top-level zero wins', aliases: { prompt_cache_hits: 0, prompt_cache_hit_tokens: 31 }, expected: 0 },
    { label: 'nested zero wins over both aliases', details: { cached_tokens: 0 }, aliases: { prompt_cache_hits: 21, prompt_cache_hit_tokens: 31 }, expected: 0 },
    { label: 'nullish aliases fall through', details: { cached_tokens: null }, aliases: { prompt_cache_hits: null, prompt_cache_hit_tokens: 18 }, expected: 18 },
    { label: 'missing cache remains undefined', aliases: {} },
  ]

  it.each(cases)('$label', async ({ details, aliases, expected }) => {
    const usage = format === 'responses'
      ? { input_tokens: 80, output_tokens: 4, input_tokens_details: details, ...aliases }
      : { prompt_tokens: 80, completion_tokens: 4, prompt_tokens_details: details, ...aliases }
    const terminal = format === 'responses'
      ? { type: 'response.completed', response: { usage } }
      : { choices: [{ delta: {}, finish_reason: 'stop' }], usage }
    const chunks = await collect(fixture([terminal], format).adapter)
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: 80, outputTokens: 4, cachedTokens: expected, reasoningTokens: undefined },
    ])
  })

  it('emits cache-only usage even when input and output totals are absent', async () => {
    const usage = { prompt_cache_hit_tokens: 0 }
    const terminal = format === 'responses'
      ? { type: 'response.completed', response: { usage } }
      : { choices: [{ delta: {}, finish_reason: 'stop' }], usage }
    const chunks = await collect(fixture([terminal], format).adapter)
    expect(chunks.filter((chunk) => chunk.type === 'usage')).toEqual([
      { type: 'usage', inputTokens: undefined, outputTokens: undefined, cachedTokens: 0, reasoningTokens: undefined },
    ])
  })
})
