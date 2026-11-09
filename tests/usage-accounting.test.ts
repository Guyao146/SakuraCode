/**
 * Token accounting: provider usage parsing (cache hits, reasoning tokens),
 * per-turn aggregation across steps, and session-level stats.
 */
import { promises as fs, readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAICompatAdapter } from '../src/core/llm.js'
import type { ChatMessage, SessionEventRecord, ToolSchema, UsageStats } from '../src/core/types.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { MockAdapter, text, toolCall, tmpHarness } from './helpers.js'
import { cacheHitRate, summarizeUsage } from '../src/util/tokens.js'
import { estimateRequestContextTokens } from '../src/util/context.js'

const nativeFetch = globalThis.fetch
beforeEach(() => {
  vi.stubEnv('SAKURA_API_KEY', 'fake-usage-test-key')
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input))
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('External network is disabled in usage tests')
    return nativeFetch(input, init)
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); globalThis.fetch = nativeFetch })

/** Encode chat-completions SSE frames, terminated by [DONE]. */
function chatSse(...events: Record<string, unknown>[]): string {
  return [...events.map((event) => `data: ${JSON.stringify(event)}`), 'data: [DONE]', ''].join('\n\n')
}

/** Encode Responses-API SSE frames (no [DONE] sentinel). */
function responsesSse(...events: Record<string, unknown>[]): string {
  return [...events.map((event) => `data: ${JSON.stringify(event)}`), ''].join('\n\n')
}

function streamed(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

async function collect(adapter: OpenAICompatAdapter): Promise<UsageStats[]> {
  const usage: UsageStats[] = []
  for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
    if (chunk.type === 'usage') {
      const { type: _type, ...stats } = chunk
      usage.push(stats)
    }
  }
  return usage
}

describe('usage parsing (OpenAI-compatible adapter)', () => {
  it('reads OpenAI-style prompt_tokens_details and completion_tokens_details', async () => {
    vi.stubGlobal('fetch', async () => streamed(chatSse({
      choices: [{ delta: { content: 'answer' }, finish_reason: null }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        prompt_tokens_details: { cached_tokens: 7 },
        completion_tokens_details: { reasoning_tokens: 2 },
      },
    })))
    const adapter = new OpenAICompatAdapter({ baseURL: 'https://fake.test/v1', model: 'm' })
    await expect(collect(adapter)).resolves.toEqual([
      { inputTokens: 10, outputTokens: 3, cachedTokens: 7, reasoningTokens: 2 },
    ])
  })

  it('reads DeepSeek-style top-level cache aliases', async () => {
    vi.stubGlobal('fetch', async () => streamed(chatSse({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hits: 64, reasoning_tokens: 5 },
    })))
    const adapter = new OpenAICompatAdapter({ baseURL: 'https://fake.test/v1', model: 'm' })
    await expect(collect(adapter)).resolves.toEqual([
      { inputTokens: 100, outputTokens: 20, cachedTokens: 64, reasoningTokens: 5 },
    ])
  })

  it('leaves cache fields undefined when the provider reports nothing', async () => {
    vi.stubGlobal('fetch', async () => streamed(chatSse({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    })))
    const adapter = new OpenAICompatAdapter({ baseURL: 'https://fake.test/v1', model: 'm' })
    await expect(collect(adapter)).resolves.toEqual([{ inputTokens: 10, outputTokens: 1 }])
  })

  it('reads input_tokens_details from the Responses API stream', async () => {
    vi.stubGlobal('fetch', async () => streamed(responsesSse({
      type: 'response.output_text.delta',
      delta: 'answer',
    }, {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 500,
          output_tokens: 40,
          input_tokens_details: { cached_tokens: 300 },
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
    })))
    const adapter = new OpenAICompatAdapter({ baseURL: 'https://fake.test/v1', model: 'm', format: 'responses' })
    await expect(collect(adapter)).resolves.toEqual([
      { inputTokens: 500, outputTokens: 40, cachedTokens: 300, reasoningTokens: 12 },
    ])
  })
})

describe('per-turn aggregation across steps', () => {
  it('sums usage of every step, not just the last one', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        // Step 1 issues a tool call (so the loop continues) and reports usage.
        [
          { type: 'usage', inputTokens: 100, outputTokens: 5, cachedTokens: 60 },
          ...toolCall('todo_write', JSON.stringify({ todos: [{ content: 'a', status: 'in_progress', priority: 'high' }] })),
        ],
        [
          { type: 'usage', inputTokens: 120, outputTokens: 8, cachedTokens: 80, reasoningTokens: 4 },
          { type: 'text', delta: 'FINAL' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    const uiEnds: Array<{ usage?: UsageStats }> = []
    ctx.on('ui/turn/end', (payload: { usage?: UsageStats }) => { uiEnds.push(payload) })
    const main = harness.main()
    await main.turn('do it')
    expect(uiEnds).toHaveLength(1)
    expect(uiEnds[0]?.usage).toEqual({ inputTokens: 220, outputTokens: 13, cachedTokens: 140, reasoningTokens: 4 })
  })

  it('persists per-step usage on assistant/message so session stats survive reload', async () => {
    const { harness, ctx } = await tmpHarness({
      steps: [
        [
          { type: 'usage', inputTokens: 10, outputTokens: 2 },
          ...toolCall('todo_write', JSON.stringify({ todos: [{ content: 'a', status: 'pending', priority: 'medium' }] })),
        ],
        [
          { type: 'usage', inputTokens: 30, outputTokens: 4, cachedTokens: 20 },
          { type: 'text', delta: 'FINAL' },
          { type: 'done', reason: 'stop' },
        ],
      ],
    })
    await harness.run('go')
    const session = await ctx.sessions.open(harness.main().sessionId!)
    const rows = session.events
      .filter((e) => e.type === 'assistant/message')
      .map((e) => (e.payload as { stream?: { usage?: UsageStats } }).stream?.usage)
    expect(rows).toEqual([
      { inputTokens: 10, outputTokens: 2 },
      { inputTokens: 30, outputTokens: 4, cachedTokens: 20 },
    ])
    // summarizeUsage (CLI /usage, server tokenStats) reads the same log.
    expect(summarizeUsage(session.events)).toEqual({
      requests: 2, inputTokens: 40, outputTokens: 6, cachedTokens: 20, reasoningTokens: 0,
      cacheCoverage: { requests: 2, reportedRequests: 1, rateRequests: 1, inputTokens: 30, cachedTokens: 20 },
    })
  })
})

describe('CLI /usage reporting', () => {
  it('estimates messages plus only current visible schemas without making a model request', async () => {
    const source = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8')
    const start = source.indexOf("      case '/usage': {")
    const end = source.indexOf("      case '/memory':", start)
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
    const body = source.slice(source.indexOf('{', start) + 1, end).replace(/\s*break\s*\n\s*}\s*$/, '')
    const script = new Script('(async function () { switch ("/usage") { case "/usage": {' + body + '\n} } })()')
    const messages: ChatMessage[] = [{ role: 'system', content: 'fixture system' }, { role: 'user', content: 'fixture user' }]
    const definitions: ToolSchema[] = [
      { name: 'visible_fixture', description: 'visible schema', parameters: { type: 'object' } },
      { name: 'hidden_fixture', description: 'excluded schema '.repeat(100), parameters: { type: 'object' } },
    ]
    const filter = (name: string) => name === 'visible_fixture'
    const schemas = vi.fn((visible?: (name: string) => boolean) => definitions.filter(tool => !visible || visible(tool.name)))
    const toolFilterFor = vi.fn(() => filter), log = vi.fn()
    let rows: SessionEventRecord[] = []
    const session = { get events() { return rows }, deriveMessages: () => messages }
    const main = { id: 'main-fixture', sessionId: 'fixture-session' }
    const harness = { main: () => main, ctx: { sessions: { open: vi.fn(async () => session) }, tools: { schemas }, agents: { toolFilterFor },
      llm: { stream: vi.fn(() => { throw new Error('/usage must not request a model') }) } } }
    const scope = { harness, isSessionId: () => true, summarizeUsage, cacheHitRate, estimateRequestContextTokens, console: { log } }
    const run = async (usageRows: Array<UsageStats | undefined>) => {
      rows = usageRows.map((usage, index) => ({ seq: index + 1, time: new Date(index).toISOString(), type: 'assistant/message',
        payload: { role: 'assistant', content: '', stream: { text: '', toolCalls: [], durationMs: 0, ...(usage ? { usage } : {}) } } }))
      log.mockClear(); await script.runInNewContext(scope)
      return log.mock.calls.map(args => args.join(' ')).join('\n')
    }
    const unknown = await run([{ inputTokens: 100, outputTokens: 5 }, undefined])
    expect(unknown).toContain('cache 未报告')
    expect(unknown).toContain('cache reported 0/2 requests')
    expect(unknown).not.toContain('0%')
    const zero = await run([{ inputTokens: 100, outputTokens: 0, cachedTokens: 0 }])
    expect(zero).toContain('cache hits 0 · 0%')
    const missingInput = await run([{ outputTokens: 2, cachedTokens: 0 }])
    expect(missingInput).toContain('cache hits 0 · 比例未报告')
    expect(missingInput).not.toContain('0%')
    const partial = await run([{ inputTokens: 900, outputTokens: 10 }, { inputTokens: 100, outputTokens: 20, cachedTokens: 50 }, { cachedTokens: 30 }])
    expect(partial).toContain('cache hits 80 · 50%')
    expect(partial).toContain('cache reported 2/3 requests, rate coverage 1/3 requests')
    expect(partial).toContain('denominator 100 input tokens, numerator 50 cached tokens')
    const estimate = estimateRequestContextTokens(messages, definitions.filter(tool => filter(tool.name)))
    expect(partial).toContain('context estimate ' + estimate.toLocaleString() + ' tokens')
    expect(estimate).toBeLessThan(estimateRequestContextTokens(messages, definitions))
    expect(toolFilterFor).toHaveBeenLastCalledWith(main.id)
    expect(schemas).toHaveBeenLastCalledWith(filter)
    expect(harness.ctx.llm.stream).not.toHaveBeenCalled()
  })
})

describe('server state token stats', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

  it('exposes per-session totals and cache-hit share via /api/state', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-usage-state-'))
    // A scripted adapter that reports a cached share; the server wires the
    // real agent loop, so the turn runs end to end.
    const adapter = new MockAdapter([
      [{ type: 'usage', inputTokens: 80, outputTokens: 4, cachedTokens: 40 }, ...text('ONE')],
      text('TWO'),
    ])
    const server: WebServerHandle = await runWebServer({
      cwd: tmpDir, adapter, approvalMode: 'yolo', quiet: true, open: false,
      updatesAutoCheck: false,
    })
    cleanups.push(async () => {
      await server.close()
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })
    await fetch(server.url + 'api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    })
    // Wait for the turn to land in the log (state is derived from session events).
    let stats: { requests: number; inputTokens: number; cachedTokens: number } | undefined
    for (let attempt = 0; attempt < 50 && stats?.requests !== 1; attempt++) {
      const state = await (await fetch(server.url + 'api/state')).json() as { tokenStats?: typeof stats }
      stats = state.tokenStats
      if (!stats?.requests) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(stats).toMatchObject({ requests: 1, inputTokens: 80, outputTokens: 4, cachedTokens: 40,
      cacheCoverage: { requests: 1, reportedRequests: 1, rateRequests: 1, inputTokens: 80, cachedTokens: 40 } })
    await fetch(server.url + 'api/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'second turn without usage' }),
    })
    await server.harness.main().wait()
    const next = await (await fetch(server.url + 'api/state')).json() as { tokenStats: { cacheCoverage: unknown } }
    expect(next.tokenStats).toMatchObject({ requests: 1, inputTokens: 80, outputTokens: 4, cachedTokens: 40,
      cacheCoverage: { requests: 2, reportedRequests: 1, rateRequests: 1, inputTokens: 80, cachedTokens: 40 } })
  })
})
