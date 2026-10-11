/**
 * core-model-profiles — named model configuration profiles (sakura.yml).
 *
 * Declares multiple OpenAI-compatible providers and registers each one as a
 * named adapter on ctx.llm (adapter id = profile name), so `/model <name>`
 * and the GUI model picker can switch providers at runtime through
 * llm.pick(name | model).
 *
 * sakura.yml example:
 *
 *   plugins:
 *     core-model-profiles:
 *       config:
 *         profiles:
 *           glm:
 *             baseURL: https://open.bigmodel.cn/api/paas/v4
 *             apiKeyEnv: SAKURA_GLM_KEY        # key read from env at mount time
 *             model: glm-4.7
 *             models: [glm-4.7, glm-4.7-air, glm-4.7-flash]
 *           qwen:
 *             baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
 *             apiKey: sk-...                   # inline key wins over apiKeyEnv
 *             model: qwen-max
 *             models: [qwen-vl-max, qwen-max]
 *             headers:                         # extra headers for compat gateways
 *               X-Title: sakura
 *           local:
 *             baseURL: http://127.0.0.1:11434/v1   # no key needed
 *             model: llama3.1
 *
 * Semantics:
 * - Auth: `apiKey` wins over `apiKeyEnv`; an env var only counts when it is
 *   set to a non-empty value. With neither source the profile still registers
 *   and its requests simply carry no Authorization header — fine for local
 *   gateways that do not want one.
 * - `models` defaults to `[model]` when absent/empty, so the profile's own
 *   default model always routes back to it via llm.pick().
 * - Registration is plain `llm.register(adapter)` — no default, no replace.
 *   A profile whose name collides with an existing adapter id (e.g. the
 *   core-llm 'default' adapter) is skipped with a console.warn; the plugin
 *   never fails the mount over it. Profiles missing baseURL/model are
 *   skipped the same way (they could only produce dead adapters).
 * - ctx.modelProfiles exposes names()/get()/currentDefault() for /model and
 *   GUI dropdowns; it only lists profiles that actually registered.
 */

import { OpenAICompatAdapter } from '../core/llm.js'
import type { LLMService } from '../core/llm.js'
import type { Plugin } from '../kernel/index.js'

export interface ModelProfileConfig {
  baseURL: string
  /** Inline API key. Priority: apiKey > apiKeyEnv (env only used when non-empty). */
  apiKey?: string
  /** Env var name holding the API key (e.g. SAKURA_GLM_KEY); non-empty values only. */
  apiKeyEnv?: string
  /** Default model name (sent as the API `model` field). */
  model: string
  /** Models routable to this profile via llm.pick(model); always includes `model`. */
  models?: string[]
  /** Upstream request format; defaults to OpenAI Chat Completions. */
  format?: 'chat-completions' | 'responses'
  /** Extra headers attached to every request (compat gateways, e.g. anthropic-version). */
  headers?: Record<string, string>
}

export interface ModelProfilesConfig {
  profiles?: Record<string, ModelProfileConfig>
}

export interface ModelProfilesService {
  /** Names of the profiles that were successfully registered as adapters. */
  names(): string[]
  /** Declared config of a registered profile; undefined for unknown/skipped names. */
  get(name: string): ModelProfileConfig | undefined
  /** Current default adapter id (the default===true adapter in ctx.llm.listModels()). */
  currentDefault(): string | undefined
}

class ModelProfilesServiceImpl implements ModelProfilesService {
  constructor(
    private readonly registered: ReadonlyMap<string, ModelProfileConfig>,
    private readonly llm: LLMService,
  ) {}

  names(): string[] {
    return [...this.registered.keys()]
  }

  get(name: string): ModelProfileConfig | undefined {
    return this.registered.get(name)
  }

  currentDefault(): string | undefined {
    return this.llm.listModels().find((row) => row.default)?.adapter
  }
}

/** Inline apiKey first, then a non-empty apiKeyEnv value; neither → undefined (no auth header). */
function resolveApiKey(profile: ModelProfileConfig): string | undefined {
  const fromEnv = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined
  return profile.apiKey || fromEnv || undefined
}

export const modelProfilesPlugin: Plugin = {
  name: 'core-model-profiles',
  description:
    'Named model profiles (ctx.modelProfiles) — each sakura.yml profile registers as a switchable ctx.llm adapter',
  inject: ['llm'] as const,
  config: {
    type: 'object',
    properties: {
      profiles: {
        type: 'object',
        description: 'named OpenAI-compatible provider configs; each registers as an adapter (id = profile name)',
        additionalProperties: {
          type: 'object',
          properties: {
            baseURL: { type: 'string', description: 'OpenAI-compatible base URL' },
            apiKey: { type: 'string', description: 'inline API key (wins over apiKeyEnv)' },
            apiKeyEnv: { type: 'string', description: 'env var holding the API key (used only when non-empty)' },
            model: { type: 'string', description: 'default model (API `model` field)' },
            models: { type: 'array', items: { type: 'string' }, description: 'models routable to this profile' },
            format: { type: 'string', enum: ['chat-completions', 'responses'], description: 'upstream request format' },
            headers: { type: 'object', description: 'extra headers for every request' },
          },
          required: ['baseURL', 'model'],
        },
      },
    },
  } as const,
  apply(ctx, config, llmLike: unknown) {
    const llm = llmLike as LLMService
    const { profiles } = (config ?? {}) as ModelProfilesConfig

    const registered = new Map<string, ModelProfileConfig>()
    for (const [name, profile] of Object.entries(profiles ?? {})) {
      if (!profile?.baseURL || !profile.model) {
        console.warn(`[core-model-profiles] profile "${name}" skipped: baseURL and model are required`)
        continue
      }
      const adapter = new OpenAICompatAdapter({
        id: name,
        baseURL: profile.baseURL,
        apiKey: resolveApiKey(profile),
        model: profile.model,
        models: profile.models?.length ? profile.models : [profile.model],
        format: profile.format,
        headers: profile.headers,
      })
      try {
        // No default, no replace: profiles are opt-in via llm.pick(name | model).
        llm.register(adapter)
        registered.set(name, profile)
      } catch (error) {
        console.warn(`[core-model-profiles] profile "${name}" skipped: ${(error as Error).message}`)
      }
    }

    ctx.provide('modelProfiles')
    ctx.set('modelProfiles', new ModelProfilesServiceImpl(registered, llm))
  },
}
