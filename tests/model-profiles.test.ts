/**
 * tests/model-profiles.test.ts — core-model-profiles against a hand-assembled
 * kernel (Context + core-llm + model-profiles). No network: route-only tests
 * never stream, and the switch tests replace the profile adapters' stream()
 * with a recording stub before any request is made.
 *
 * Auth behavior (Authorization header) is intentionally not asserted:
 * OpenAICompatAdapter keeps its opts private, so verifying the header would
 * require a mock LLM server. Per spec only registration-level behavior is
 * covered here (profiles register whether or not the key source resolves).
 *
 * The last two blocks (model switch end to end, local server hardening) drive
 * the real web server through runWebServer; the local-hardening cases live in
 * tests/web-server.test.ts.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { llmPlugin, OpenAICompatAdapter, type LLMService } from '../src/core/llm.js'
import { modelProfilesPlugin, type ModelProfileConfig, type ModelProfilesService } from '../src/plugins/model-profiles.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/index.js'
import { MockAdapter, text, type MockStep } from './helpers.js'

const contexts: Context[] = []
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  delete process.env.TEST_KEY_X
  vi.restoreAllMocks()
  while (contexts.length) contexts.pop()?.dispose()
  while (cleanups.length) await cleanups.pop()?.()
})

/**
 * Mount the minimal kernel. The core-llm row is pinned (explicit baseURL/model)
 * so SAKURA_* / DEEPSEEK_* env vars on the dev machine cannot skew the tests.
 */
async function mount(profiles?: Record<string, ModelProfileConfig>): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(llmPlugin, { baseURL: 'https://llm.test/v1', model: 'orig-model' })
  await ctx.plugin(modelProfilesPlugin, profiles === undefined ? undefined : { profiles })
  return ctx
}

/** The two multi-model profiles the switch tests exercise. */
const PROFILES: Record<string, ModelProfileConfig> = {
  glm: { baseURL: 'https://glm.test/api/paas/v4', apiKeyEnv: 'TEST_KEY_X', model: 'glm-4.7', models: ['glm-4.7', 'glm-4.7-air'] },
  qwen: { baseURL: 'https://qwen.test/compatible-mode/v1', apiKey: 'sk-test', model: 'qwen-max', models: ['qwen-vl-max', 'qwen-max'] },
}

/**
 * Replace an adapter's stream() with a stub that records the `model` field of
 * every request it is handed — the value that would go on the wire.
 */
function recordRequests(adapter: ModelAdapter): string[] {
  const seen: string[] = []
  vi.spyOn(adapter, 'stream').mockImplementation(async function* (req: LLMRequest): AsyncGenerator<StreamChunk> {
    seen.push(req.model ?? '')
    yield { type: 'done', reason: 'stop' }
  })
  return seen
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

describe('modelProfilesPlugin', () => {
  it('registers profiles as named adapters and routes pick() by id and by models', async () => {
    const ctx = await mount({
      glm: {
        baseURL: 'https://glm.test/api/paas/v4',
        apiKeyEnv: 'TEST_KEY_X',
        model: 'glm-4.7',
        models: ['glm-4.7', 'glm-4.7-air'],
      },
      qwen: {
        baseURL: 'https://qwen.test/compatible-mode/v1',
        apiKey: 'sk-test',
        model: 'qwen-max',
        models: ['qwen-vl-max', 'qwen-max'],
      },
    })
    const llm = ctx.get<LLMService>('llm')

    const ids = new Set(llm.listModels().map((row) => row.adapter))
    expect(ids.has('glm')).toBe(true)
    expect(ids.has('qwen')).toBe(true)

    expect(llm.pick('glm').id).toBe('glm')
    // 'qwen-vl-max' is not an adapter id — routed through the qwen models array.
    expect(llm.pick('qwen-vl-max').id).toBe('qwen')
    const qwenModels = llm.listModels().filter((row) => row.adapter === 'qwen').map((row) => row.model)
    expect(qwenModels).toContain('qwen-vl-max')

    const svc = ctx.get<ModelProfilesService>('modelProfiles')
    expect(svc.names()).toEqual(['glm', 'qwen'])
    expect(svc.get('qwen')).toMatchObject({ baseURL: 'https://qwen.test/compatible-mode/v1', model: 'qwen-max' })
    expect(svc.get('nope')).toBeUndefined()
    // core-llm's adapter mounted first stays the default — profiles never steal it.
    expect(svc.currentDefault()).toBe('default')
  })

  it('resolves apiKeyEnv but never fails over auth sources', async () => {
    // Header behavior not asserted (see file header); registration must succeed
    // whether or not the env var is set.
    process.env.TEST_KEY_X = 'secret-123'
    const withEnv = await mount({ glm: { baseURL: 'https://glm.test/v4', apiKeyEnv: 'TEST_KEY_X', model: 'glm-4.7' } })
    expect(withEnv.get<ModelProfilesService>('modelProfiles').names()).toEqual(['glm'])

    delete process.env.TEST_KEY_X
    const withoutEnv = await mount({ glm: { baseURL: 'https://glm.test/v4', apiKeyEnv: 'TEST_KEY_X', model: 'glm-4.7' } })
    // Env unset: still registers — auth is a request-time concern, not a mount-time one.
    expect(withoutEnv.get<ModelProfilesService>('modelProfiles').names()).toEqual(['glm'])
  })

  it('skips conflicting profile names with a warning and leaves the default adapter intact', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(llmPlugin, { baseURL: 'https://llm.test/v1', model: 'orig-model' })
    // A bare adapter takes the fallback id 'openai-compat' — both it and the
    // core-llm 'default' adapter collide with same-named profiles below.
    ctx.get<LLMService>('llm').register(new OpenAICompatAdapter({ baseURL: 'https://bare.test/v1', model: 'bare-model' }))

    await ctx.plugin(modelProfilesPlugin, {
      profiles: {
        'openai-compat': { baseURL: 'https://x.test/v1', model: 'x-model' },
        default: { baseURL: 'https://y.test/v1', model: 'y-model' },
        glm: { baseURL: 'https://glm.test/v4', model: 'glm-4.7' },
      },
    })

    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.some((args) => String(args[0]).includes('"openai-compat"'))).toBe(true)
    expect(warn.mock.calls.some((args) => String(args[0]).includes('"default"'))).toBe(true)

    const svc = ctx.get<ModelProfilesService>('modelProfiles')
    expect(svc.names()).toEqual(['glm'])

    // The original default adapter was not replaced — pick() still routes to it.
    const defaultRow = ctx.get<LLMService>('llm').listModels().find((row) => row.default)
    expect(defaultRow).toMatchObject({ adapter: 'default', model: 'orig-model' })
  })

  it('mounts cleanly with empty or absent profiles', async () => {
    const absent = await mount()
    const svc = absent.get<ModelProfilesService>('modelProfiles')
    expect(svc.names()).toEqual([])
    expect(svc.get('glm')).toBeUndefined()
    // core-llm's own adapter is untouched and still the default.
    expect(svc.currentDefault()).toBe('default')

    const empty = await mount({})
    expect(empty.get<ModelProfilesService>('modelProfiles').names()).toEqual([])
  })

  it('registers profiles without any auth source (apiKey and apiKeyEnv unset)', async () => {
    const ctx = await mount({ bare: { baseURL: 'http://127.0.0.1:11434/v1', model: 'llama3.1' } })
    const svc = ctx.get<ModelProfilesService>('modelProfiles')
    expect(svc.names()).toEqual(['bare'])

    const llm = ctx.get<LLMService>('llm')
    expect(llm.pick('bare').id).toBe('bare')
    // models falls back to [model] — the profile's default model routes back to it.
    expect(llm.pick('llama3.1').id).toBe('bare')
  })
})

describe('ctx.llm model selection', () => {
  it('sends the selected model name on the wire, not the profile default', async () => {
    const ctx = await mount(PROFILES)
    const llm = ctx.get<LLMService>('llm')
    const glmSeen = recordRequests(llm.pick('glm'))
    const qwenSeen = recordRequests(llm.pick('qwen'))

    // `/model glm-4.7-air` — a secondary model of a multi-model profile. The
    // request must carry THAT name: the adapter would otherwise send its own
    // default (glm-4.7) to the API.
    expect(llm.select('glm-4.7-air')).toEqual({ adapter: 'glm', model: 'glm-4.7-air' })
    await collect(llm.stream({ messages: [] }))
    expect(glmSeen).toEqual(['glm-4.7-air'])
    expect(qwenSeen).toEqual([])

    // `/model glm` — selecting the profile by name picks its default model.
    expect(llm.select('glm')).toEqual({ adapter: 'glm', model: 'glm-4.7' })
    await collect(llm.stream({ messages: [] }))
    expect(glmSeen).toEqual(['glm-4.7-air', 'glm-4.7'])

    // A model name that is not an adapter id routes through that profile's models.
    expect(llm.select('qwen-vl-max')).toEqual({ adapter: 'qwen', model: 'qwen-vl-max' })
    await collect(llm.stream({ messages: [] }))
    expect(qwenSeen).toEqual(['qwen-vl-max'])

    // `/model` with no argument lists these rows — the * marker follows the selection.
    expect(llm.listModels().filter((row) => row.default)).toEqual([
      { adapter: 'qwen', model: 'qwen-vl-max', default: true },
    ])
    expect(llm.selectedModel()).toBe('qwen-vl-max')
  })

  it('fills an unnamed/empty request model with the selection but keeps per-agent pins', async () => {
    const ctx = await mount(PROFILES)
    const llm = ctx.get<LLMService>('llm')
    const glmSeen = recordRequests(llm.pick('glm'))
    const coreSeen = recordRequests(llm.pick('default'))

    llm.select('glm-4.7-air')
    // A plain `sakura` run spawns the main agent without a model: agent.model is
    // '' and '' is not nullish, so the adapter's own `?? opts.model` fallback
    // would send an empty `model` field.
    await collect(llm.stream({ model: '', messages: [] }))
    expect(glmSeen).toEqual(['glm-4.7-air'])

    // A model named by the request belongs to an agent that pinned it
    // (subagent `model:` / agent-defs) — the switch must not silently retarget it.
    await collect(llm.stream({ model: 'orig-model', messages: [] }))
    expect(coreSeen).toEqual(['orig-model'])
    expect(glmSeen).toEqual(['glm-4.7-air'])
  })

  it('rejects unknown model names instead of silently keeping the old model', async () => {
    const ctx = await mount(PROFILES)
    const llm = ctx.get<LLMService>('llm')
    expect(() => llm.select('glm-9.9')).toThrow('unknown model "glm-9.9"')
    // A failed switch leaves the previous routing untouched.
    expect(llm.pick('glm').id).toBe('glm')
  })
})

// ---------------------------------------------------------------------------
// Web server: the model picker (/api/settings) and local-server hardening.
// ---------------------------------------------------------------------------

async function bootServer(
  steps: MockStep[] = [text('ok')],
  opts: Partial<WebServerOptions> = {},
): Promise<{ base: string; handle: WebServerHandle }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-model-switch-'))
  const handle = await runWebServer({
    cwd: tmpDir,
    sessionDir: 'sessions',
    jobsDir: 'jobs',
    adapter: new MockAdapter(steps),
    approvalMode: 'yolo',
    quiet: true,
    open: false,
    ...opts,
  })
  cleanups.push(async () => {
    await handle.close()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })
  return { base: handle.url.replace(/\/$/, ''), handle }
}

describe('web server — /api/settings model switch', () => {
  it('sends the switched model, not the startup --model or the profile default', async () => {
    const { base, handle } = await bootServer([text('first'), text('second')], {
      // The reported repro: started on the profile's default model, then the
      // user switches to a secondary model of the same profile.
      model: 'glm-4.7',
      config: { models: { glm: PROFILES.glm } },
    })
    const seen = recordRequests(handle.harness.ctx.llm.pick('glm'))

    const first = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(first.status).toBe(202)
    // Reaching stream() is not turn completion: wait for session writes and
    // stopping hooks before changing the model used by the next request.
    const completed = await handle.harness.main().wait()
    expect(completed.error).toBeUndefined()
    expect(completed.cancelled).toBeUndefined()
    expect(seen).toEqual(['glm-4.7'])

    const switched = await fetch(`${base}/api/settings`, {
      method: 'POST',
      body: JSON.stringify({ model: 'glm-4.7-air' }),
    })
    expect(switched.status).toBe(200)

    const second = await fetch(`${base}/api/message`, { method: 'POST', body: JSON.stringify({ text: 'again' }) })
    expect(second.status).toBe(202)
    const next = await handle.harness.main().wait()
    expect(next.error).toBeUndefined()
    expect(next.cancelled).toBeUndefined()
    expect(seen).toEqual(['glm-4.7', 'glm-4.7-air'])
  })

  it('400s on an unknown model and keeps the current one', async () => {
    const { base } = await bootServer([text('ok')], { model: 'glm-4.7', config: { models: { glm: PROFILES.glm } } })
    const res = await fetch(`${base}/api/settings`, { method: 'POST', body: JSON.stringify({ model: 'glm-9.9' }) })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('unknown model')
  })
})
