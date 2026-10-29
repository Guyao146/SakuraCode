/**
 * createHarness — composes the running harness (the base
 * bundle): core services, the shipped tool plugins, identity prompt,
 * out-of-tree bundles, and plugin-config/disabled rows from the YAML config.
 * Everything below is a plugin; the composition itself is data.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { HarnessContext, type TurnResult, type AgentHandle, type ModelAdapter } from './core/index.js'
import {
  sessionPlugin,
  checkpointsPlugin,
  systemPromptPlugin,
  approvalPlugin,
  llmPlugin,
  toolsPlugin,
  jobsPlugin,
  agentPlugin,
  type ApprovalMode,
} from './core/index.js'
import {
  fsToolsPlugin,
  fsSearchPlugin,
  shellToolsPlugin,
  jobToolsPlugin,
    todoToolsPlugin,
    planToolsPlugin,
    webToolsPlugin,
  webSearchToolsPlugin,
  computerToolsPlugin,
  browserToolsPlugin,
  subagentToolsPlugin,
  subagentControlPlugin,
  pluginManagerToolPlugin,
  pluginRegistryPlugin,
  PluginRegistry,
} from './tools/index.js'
import { agentDefsPlugin } from './agents/index.js'
import { sessionExportPlugin } from './plugins/session-export.js'
import { identityPlugin } from './plugins/identity.js'
import { rendererPlugin, type RendererConfig } from './plugins/renderer.js'
import { compactionPlugin } from './plugins/compaction.js'
import { interactionPlugin, askUserToolsPlugin } from './plugins/ask-user.js'
import { projectMemoryPlugin } from './plugins/project-memory.js'
import { workspaceMemoryPlugin } from './plugins/workspace-memory.js'
import { memoryProcessingPlugin } from './plugins/memory-processing.js'
import { workspaceMemoryToolsPlugin } from './tools/memory.js'
import { modelProfilesPlugin } from './plugins/model-profiles.js'
import { retryPlugin } from './core/retry.js'
import { mcpPlugin } from './mcp/index.js'
import { hooksPlugin } from './hooks/index.js'
import { skillsPlugin } from './skills/index.js'
import type { Plugin } from './kernel/index.js'
import { resolveProfile, type SakuraConfig } from './config.js'

/** The shipped composition, in mount order (inject resolves the rest). */
export const BASE_BUNDLE: Array<{ plugin: Plugin; name: string }> = [
  { name: 'core-session', plugin: sessionPlugin },
  { name: 'core-checkpoints', plugin: checkpointsPlugin },
  { name: 'core-system-prompt', plugin: systemPromptPlugin },
  { name: 'core-plugin-registry', plugin: pluginRegistryPlugin },
  { name: 'core-identity', plugin: identityPlugin },
  { name: 'core-project-memory', plugin: projectMemoryPlugin },
  { name: 'core-workspace-memory', plugin: workspaceMemoryPlugin },
  { name: 'core-approval', plugin: approvalPlugin },
  { name: 'core-hooks', plugin: hooksPlugin },
  { name: 'core-retry', plugin: retryPlugin },
  { name: 'core-llm', plugin: llmPlugin },
  { name: 'core-model-profiles', plugin: modelProfilesPlugin },
  { name: 'core-tools', plugin: toolsPlugin },
  { name: 'core-agent-defs', plugin: agentDefsPlugin },
  { name: 'core-skills', plugin: skillsPlugin },
  { name: 'core-jobs', plugin: jobsPlugin },
  { name: 'core-agent', plugin: agentPlugin },
  { name: 'core-memory-processing', plugin: memoryProcessingPlugin },
  { name: 'core-compaction', plugin: compactionPlugin },
  { name: 'core-interaction', plugin: interactionPlugin },
  { name: 'core-session-export', plugin: sessionExportPlugin },
  { name: 'tool-fs', plugin: fsToolsPlugin },
  { name: 'tool-workspace-memory', plugin: workspaceMemoryToolsPlugin },
  { name: 'tool-fs-search', plugin: fsSearchPlugin },
  { name: 'tool-shell', plugin: shellToolsPlugin },
  { name: 'tool-jobs', plugin: jobToolsPlugin },
  { name: 'tool-todo', plugin: todoToolsPlugin },
  { name: 'tool-plan', plugin: planToolsPlugin },
  { name: 'tool-web', plugin: webToolsPlugin },
  { name: 'tool-web-search', plugin: webSearchToolsPlugin },
  { name: 'tool-ask-user', plugin: askUserToolsPlugin },
  { name: 'tool-computer', plugin: computerToolsPlugin },
  { name: 'tool-browser', plugin: browserToolsPlugin },
  { name: 'tool-subagent', plugin: subagentToolsPlugin },
  { name: 'tool-subagent-control', plugin: subagentControlPlugin },
  { name: 'mcp-manager', plugin: mcpPlugin },
  { name: 'tool-plugin-manager', plugin: pluginManagerToolPlugin },
]

export interface HarnessOptions {
  config?: SakuraConfig
  cwd?: string
  sessionDir?: string
  jobsDir?: string
  approvalMode?: ApprovalMode
  model?: string
  baseURL?: string
  apiKey?: string
  models?: string[]
  maxSteps?: number
  allowNestedSubagents?: boolean
  systemPrompt?: string
  renderer?: RendererConfig | false
  /** Replace the default OpenAI-compatible adapter (tests / custom providers). */
  adapter?: ModelAdapter
  /** Additional plugins to mount after the base bundle. */
  extraPlugins?: Array<{ plugin: Plugin; config?: unknown; source?: 'builtin' | 'external' }>
  /** Approval confirm handler for interactive use. */
  confirmHandler?: Parameters<import('./core/index.js').ApprovalService['setConfirmHandler']>[0]
}

export interface Harness {
  ctx: HarnessContext
  config: SakuraConfig
  /**
   * The main agent (role: 'main'), created lazily. Optionally bound to an existing
   * session id; requesting a different session rebinds the main agent to it.
   */
  main(opts?: { resumeSessionId?: string }): AgentHandle
  run(input: string): Promise<TurnResult>
  dispose(): void
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const ctx = new HarnessContext()
  try {
    return await composeHarness(ctx, opts)
  } catch (error) {
    // A failed workspace mount must not leave MCP servers or plugin effects
    // alive while the caller keeps using the previous harness.
    ctx.dispose()
    throw error
  }
}

async function composeHarness(ctx: HarnessContext, opts: HarnessOptions): Promise<Harness> {
  const config = opts.config ?? {}
  const cwd = path.resolve(opts.cwd ?? process.cwd())

  // Feed harness-level overrides into the plugin rows, then honor disabled rows.
  const { bundles, plugins } = resolveProfile(config)
  // Harness-level defaults, but explicit sakura.yml rows win over them.
  const rows = { ...plugins }
  const setRow = (name: string, configPatch?: Record<string, unknown>) => {
    const existing = rows[name] ?? {}
    rows[name] = {
      disabled: existing.disabled,
      config: { ...(existing.config ?? {}), ...(configPatch ?? {}) },
    }
  }
  const userSessionDir = rows['core-session']?.config?.dir as string | undefined
  setRow('core-session', {
    dir: path.resolve(cwd, opts.sessionDir ?? userSessionDir ?? '.sakura/sessions'),
  })
  const userJobsDir = rows['core-jobs']?.config?.dir as string | undefined
  setRow('core-jobs', {
    dir: path.resolve(cwd, opts.jobsDir ?? userJobsDir ?? '.sakura/jobs'),
  })
  if (opts.approvalMode) setRow('core-approval', { mode: opts.approvalMode })
  setRow('core-llm', {
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.models ? { models: opts.models } : {}),
  })
  setRow('core-agent', {
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.allowNestedSubagents !== undefined ? { allowNestedSubagents: opts.allowNestedSubagents } : {}),
    ...(opts.model ? { defaultModel: opts.model } : {}),
  })
  setRow('core-identity', {
    ...(opts.systemPrompt || config.systemPrompt ? { prompt: opts.systemPrompt ?? config.systemPrompt } : {}),
    ...(cwd ? { cwd } : {}),
  })
  // Discovery plugins: keep .sakura/* lookups — and the AGENTS.md
  // scan — on the harness cwd, not process.cwd().
  if (cwd) {
    setRow('core-skills', { cwd })
    setRow('core-agent-defs', { cwd })
    setRow('core-project-memory', { cwd })
    setRow('core-workspace-memory', { cwd })
    setRow('core-checkpoints', { cwd })
    setRow('tool-fs', { cwd })
    setRow('tool-fs-search', { cwd })
    setRow('tool-shell', { cwd })
    setRow('core-hooks', { cwd })
    setRow('mcp-manager', { cwd })
  }
  // Top-level mcpServers rows feed the mcp-manager plugin (plugins.mcp-manager
  // rows still win when both are present).
  if (config.mcpServers) setRow('mcp-manager', { servers: config.mcpServers })
  // Top-level models rows feed the model-profiles plugin: named providers
  // switchable via /model and the GUI dropdown.
  if (config.models) setRow('core-model-profiles', { profiles: config.models })

  const registry = () => ctx.peek<PluginRegistry>('plugins')
  const isDisabled = (name: string) => rows[name]?.disabled === true
  const record = (name: string, plugin: Plugin, source: 'builtin' | 'external') => {
    registry()?.add({ name, description: (plugin as { description?: string }).description, source })
  }

  for (const { name, plugin } of BASE_BUNDLE) {
    if (isDisabled(name)) continue
    try {
      await ctx.plugin(plugin, rows[name]?.config)
      record(name, plugin, 'builtin')
    } catch (error) {
      // A failed optional plugin must not take the whole harness down —
      // its dependents fail to mount in turn and surface the same way.
      ctx.emit('kernel/error', { event: 'mount', error, plugin: name })
    }
  }

  // Default adapter registration override (tests / custom providers).
  if (opts.adapter) {
    ctx.peek<import('./core/index.js').LLMService>('llm')?.register(opts.adapter, { default: true, replace: true })
  }

  // Out-of-tree bundles: config rows + pluginsDir scan (deduped by name —
  // a bundle row and a drop-in folder must not mount the same plugin twice).
  const externals: Array<{ plugin: Plugin; name: string; specifier: string; config?: unknown }> = []
  for (const specifier of bundles) {
    const mod = await importExternal(specifier, cwd)
    externals.push({
      plugin: (mod.default ?? mod) as Plugin,
      name: (mod as { name?: string }).name ?? specifier,
      specifier,
      config: mod.config,
    })
  }
  const pluginsDir = config.pluginsDir ? path.join(cwd, config.pluginsDir) : null
  if (pluginsDir && (await exists(pluginsDir))) {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true })
    const candidates: string[] = []
    for (const entry of entries) {
      if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
        candidates.push(path.join(pluginsDir, entry.name))
      } else if (entry.isDirectory()) {
        for (const index of ['index.js', 'index.mjs', 'index.cjs']) {
          const candidate = path.join(pluginsDir, entry.name, index)
          if (await exists(candidate)) {
            candidates.push(candidate)
            break
          }
        }
      }
    }
    for (const file of candidates) {
      const mod = await importExternal(file, cwd)
      externals.push({
        plugin: (mod.default ?? mod) as Plugin,
        name: (mod as { name?: string }).name ?? path.basename(file),
        specifier: file,
        config: mod.config,
      })
    }
  }

  const mountedExternal = new Set<string>()
  for (const ext of externals) {
    if (isDisabled(ext.name) || isDisabled(ext.specifier) || mountedExternal.has(ext.name)) continue
    try {
      await ctx.plugin(ext.plugin, rows[ext.name]?.config ?? ext.config)
      mountedExternal.add(ext.name)
      record(ext.name, ext.plugin, 'external')
    } catch (error) {
      ctx.emit('kernel/error', { event: 'mount', error, plugin: ext.name })
    }
  }

  for (const extra of opts.extraPlugins ?? []) {
    const name = (extra.plugin as { name?: string }).name ?? 'extra'
    try {
      await ctx.plugin(extra.plugin, extra.config)
      record(name, extra.plugin, extra.source ?? 'builtin')
    } catch (error) {
      ctx.emit('kernel/error', { event: 'mount', error, plugin: name })
    }
  }

  if (opts.renderer !== false) {
    await ctx.plugin(rendererPlugin, { mode: 'repl', ...opts.renderer })
  }

  // The session the current main agent is bound to. A resumed agent exposes
  // its requested ID immediately; a brand-new session is created on first turn.
  let mainAgentId: string | undefined
  let mainSessionId: string | undefined

  const harness: Harness = {
    ctx,
    config,
    main(mainOpts: { resumeSessionId?: string } = {}) {
      const requested = mainOpts.resumeSessionId
      const existing = ctx.agents.list().find((a) => a.meta.role === 'main')
      // Reuse the current agent when no rebind is asked for, or when it already
      // serves the requested session — main() after main({ resumeSessionId })
      // must keep returning the agent that call bound.
      const serves =
        existing !== undefined && existing.id === mainAgentId && (requested === mainSessionId || requested === existing.sessionId)
      if (existing && (requested === undefined || serves)) return existing
      if (existing) {
        // An agent's session binding is fixed when it is spawned, so adopting a
        // different session replaces the main agent — and the roster with it
        // (AgentsService has no single-agent removal; this matches the CLI/GUI
        // session switch). A turn in flight is never dropped silently: the
        // caller interrupts or waits, then retries the rebind.
        if (existing.status === 'running') {
          throw new Error(`cannot resume session "${requested}": the main agent is mid-turn — interrupt() or wait() before rebinding`)
        }
        ctx.agents.disposeAll()
      }
      const agent = ctx.agents.spawn({
        name: 'main',
        seed: '',
        autoStart: false,
        persistentSession: true,
        resumeSessionId: requested,
        meta: { role: 'main' },
      })
      mainAgentId = agent.id
      mainSessionId = requested
      return agent
    },
    async run(input: string) {
      return harness.main().turn(input)
    },
    dispose() {
      ctx.dispose()
    },
  }

  if (opts.confirmHandler) {
    ctx.approval.setConfirmHandler(opts.confirmHandler)
  }

  return harness
}

async function importExternal(specifier: string, cwd: string): Promise<Record<string, unknown> & { default?: unknown }> {
  // Bare names (and @scope/pkg) import from node_modules; anything with a
  // path separator or a .js/.mjs/.cjs extension resolves against cwd.
  const looksLikePackage =
    specifier.startsWith('@') || (!/[\\/]/.test(specifier) && !/\.[cm]?js$/i.test(specifier))
  const resolved = looksLikePackage ? specifier : pathToFileURL(path.resolve(cwd, specifier)).href
  const mod = (await import(resolved)) as Record<string, unknown>
  if (typeof mod !== 'object' || mod === null) throw new Error(`plugin module "${specifier}" has no exports`)
  return mod
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
