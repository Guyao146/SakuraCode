/**
 * SakuraCode Web GUI — an authenticated HTTP bridge between the harness and a browser
 * client. SSE fans harness events out (ui/*, turn/*, agent/*, mcp/*), REST
 * actions come in (messages, approvals, sessions, agents, settings).
 * Zero runtime deps (node:http). The single-file client is embedded into the
 * SEA build via a virtual module and read from disk in dev.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { createHarness, type Harness, type HarnessOptions } from '../harness.js'
import { APPROVAL_MODES, type ApprovalMode, type ConfirmHandler, type HarnessContext } from '../core/index.js'
import { isSessionId, SessionError } from '../core/session.js'
import { fetchUpstreamModels, type UpstreamFormat } from '../core/llm.js'
import { loadConfig, type SakuraConfig } from '../config.js'
import { listCommands as listSlashCommands, expandCommand as expandSlashCommand } from '../skills/commands.js'
import { expandMentions } from '../mentions/index.js'
import { estimateMessagesTokens } from '../util/tokens.js'
import { isLoopbackHost, WebAccess, type WebPrincipal } from './access.js'
import { HttpError, json, readJson } from './http.js'
import { PendingRequests } from './pending.js'
import type { ToolContext } from '../core/types.js'
import { WeixinBridge, WeixinBridgeError, type WeixinSaved } from '../integrations/weixin.js'
import type { WeixinTransport } from '../integrations/weixin-client.js'
import { UpdateChecker, type UpdateInfo } from '../updates.js'

const VERSION = '0.7.1'

/** Harness events mirrored verbatim to SSE clients ({ type, ...payload }). */
const FORWARD_EVENTS = [
  'turn/start',
  'turn/end',
  'ui/turn/start',
  'ui/text',
  'ui/thinking',
  'ui/tool/call',
  'ui/tool/result',
  'ui/turn/end',
  'ui/todos',
  'agent/spawned',
  'agent/status',
  'mcp/status',
  'compaction/done',
] as const

/** Structural type for the ask_user interaction service so this module doesn't import the plugin. */
interface InteractionLike {
  setHandler(handler: ((req: { id: string; question: string; options: string[] }) => Promise<string | null>) | undefined): void
}

/** Structural type for the session export service. */
interface SessionExportLike {
  toMarkdown(sessionId: string): Promise<string>
}

/** Structural type for the exit_plan plan service. */
interface PlanLike {
  setHandler(handler: ((req: { id: string; plan: string }) => Promise<'approve' | 'reject' | null>) | undefined): void
}

export interface WebServerOptions {
  port?: number
  host?: string
  /** Operator token; null explicitly disables inherited credentials (loopback desktop only). */
  token?: string | null
  /** Separate read-only token; null disables inheritance, without bypassing remote-access checks. */
  viewerToken?: string | null
  /** Exact HTTPS origin behind a reverse proxy; never trusts forwarded headers. */
  publicOrigin?: string
  /** Browser login lifetime (12 hours by default). */
  authSessionTtlMs?: number
  open?: boolean
  resumeSessionId?: string
  quiet?: boolean
  // Passed through to createHarness (tests / env wiring).
  cwd?: string
  adapter?: HarnessOptions['adapter']
  approvalMode?: ApprovalMode
  sessionDir?: string
  jobsDir?: string
  model?: string
  baseURL?: string
  apiKey?: string
  maxSteps?: number
  /** Full resolved config (sakura.yml layers + patches) — MCP servers live here. */
  config?: SakuraConfig
  /** Max time a request body may take to arrive (default 15s); lower it in tests. */
  bodyTimeoutMs?: number
  /** Workspaces offered in the desktop settings view (desktop mode only). */
  recentWorkspaces?: string[]
  /** Default parent directory for newly created workspaces (desktop mode). */
  newWorkspaceDir?: string
  /** Per-workspace prefs keyed by absolute path (desktop mode, launcher-persisted). */
  workspacePrefs?: Record<string, WorkspacePrefs>
  /** Whether the launcher persists an encrypted API key (initial checkbox state). */
  desktopRememberKey?: boolean
  /**
   * Desktop-mode hook: while present the workspace can be switched at runtime
   * and settings changes are handed to the launcher (DPAPI key encryption).
   * Remote servers keep a fixed workspace and never expose these routes.
   */
  onPersistSettings?: (settings: DesktopSettingsState) => void
  /** Private desktop channel; credentials are never included in public snapshots. */
  weixin?: WeixinSaved
  onPersistWeixin?: (settings: WeixinSaved) => Promise<void>
  /** Injected transport for offline integration tests or a compatible provider. */
  weixinTransport?: WeixinTransport
  /** Override the release URL the update check polls (tests use a local server). */
  updatesBaseUrl?: string
  /** Run the periodic background update check (default true). */
  updatesAutoCheck?: boolean
}

export interface WebServerHandle {
  server: Server
  port: number
  url: string
  /** The live harness — replaced whenever the desktop settings view switches the workspace. */
  harness: Harness
  close(): Promise<void>
}

/** Workspace/model settings as the desktop launcher persists them. */
export interface DesktopSettingsState {
  workspace: string
  recentWorkspaces: string[]
  baseURL: string
  model: string
  rememberKey: boolean
  hasApiKey: boolean
  /** Only present when the key should be (re-)encrypted by the launcher. */
  apiKey?: string
  /** Default parent directory for newly created workspaces. */
  newWorkspaceDir?: string
  /** Session directory override for the current workspace ('' = workspace default). */
  sessionDir?: string
  /** Agent types spawned when the current workspace is mounted. */
  agents?: string[]
  /** Full per-workspace pref map; only populated in persist frames. */
  workspacePrefs?: Record<string, WorkspacePrefs>
}

/** Per-workspace prefs: where sessions live and which agents open with it. */
export interface WorkspacePrefs {
  /** Overrides <workspace>/.sakura/sessions; absolute or relative to the workspace. */
  sessionDir?: string
  /** Agent types (core-agent-defs) spawned when the workspace is mounted. */
  agents?: string[]
}

/** Case-insensitive-free dedupe for workspace paths, first occurrence wins. */
function dedupeWorkspaces(entries: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    result.push(entry)
  }
  return result
}

/** Structural type for the MCP service so this module doesn't import the plugin. */
interface McpLike {
  status(): Array<{ name: string; state: string; toolCount: number; error?: string }>
  reconnect(name?: string): Promise<void>
  stopAll(): Promise<void>
}

interface AgentProjection {
  id: string
  name: string
  role: string
  status: string
  model: string
  sessionId: string
  description?: string
  error?: string
}

export async function runWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  const web = opts.config?.web
  const access = new WebAccess({
    host: opts.host ?? web?.host ?? '127.0.0.1',
    token: opts.token === null ? undefined : opts.token ?? process.env[web?.tokenEnv ?? 'SAKURA_WEB_TOKEN'],
    viewerToken: opts.viewerToken === null ? undefined : opts.viewerToken ?? process.env[web?.viewerTokenEnv ?? 'SAKURA_WEB_VIEWER_TOKEN'],
    publicOrigin: opts.publicOrigin ?? web?.publicOrigin,
    sessionTtlMs: opts.authSessionTtlMs,
  })
  const host = access.host
  const requestedPort = opts.port ?? web?.port ?? 0
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new Error('web port must be an integer in 0-65535')
  }
  const startedAt = new Date().toISOString()
  const toolContext = new AsyncLocalStorage<ToolContext>()
  // The bound harness — replaced wholesale when the desktop settings view
  // switches the workspace (see mountHarness / switchWorkspace).
  let harness: Harness
  let ctx: HarnessContext
  let switching = false
  let deletingSession: string | null = null
  /** True while the whole harness is being remounted on a new workspace —
   *  in-flight requests then see 503 because their context is being dispose()d. */
  let switchingWorkspace = false
  let settingsUpdating = false
  /** Bumped on every successful workspace remount; identifies stale client actions. */
  let workspaceEpoch = 0
  const workspaceId = (): string => `${startedAt}:${workspaceEpoch}`
  /** Current workspace; desktop mode can switch it at runtime. */
  let workspaceCwd = opts.cwd ?? process.cwd()
  const recentWorkspaces = dedupeWorkspaces([workspaceCwd, ...(opts.recentWorkspaces ?? [])])
  /** Default parent directory for newly created workspaces (desktop mode). */
  let newWorkspaceDir = opts.newWorkspaceDir ?? ''
  /**
   * Per-workspace prefs keyed by the resolved workspace path (desktop mode).
   * A missing entry means "workspace defaults" — sessions under .sakura/sessions
   * and no auto-spawned agents.
   */
  const workspacePrefs = new Map<string, WorkspacePrefs>(
    Object.entries(opts.workspacePrefs ?? {}).map(([key, value]) => [path.resolve(key), value ?? {}]),
  )
  /** Read (or create) the prefs entry for a resolved workspace path. */
  function prefsFor(target: string): WorkspacePrefs {
    const key = path.resolve(target)
    let prefs = workspacePrefs.get(key)
    if (!prefs) { prefs = {}; workspacePrefs.set(key, prefs) }
    return prefs
  }
  /** User-level overrides carried into every harness (re)mount. */
  const overrides: { model?: string; baseURL?: string; apiKey?: string } = {
    model: opts.model,
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
  }
  const providerOverrides = new Map<string, { baseURL?: string; apiKey?: string }>()
  if (opts.baseURL !== undefined || opts.apiKey !== undefined) {
    providerOverrides.set('default', { baseURL: opts.baseURL, apiKey: opts.apiKey })
  }
  let currentApiKey = opts.apiKey ?? ''
  let desktopRememberKey = !!opts.desktopRememberKey
  /** The approval mode follows the user's live choice across workspace switches. */
  let liveApprovalMode = opts.approvalMode
  let contextCache: { key: string; tokens: number } | null = null
  const persistSettings = opts.onPersistSettings
  /** Release feed for the settings "check for updates" card; failures land in `error`, never throw. */
  const updateChecker = new UpdateChecker(VERSION, opts.updatesBaseUrl)

  // ------------------------------------------------------------------
  // SSE fan-out
  // ------------------------------------------------------------------
  const clients = new Map<ServerResponse, WebPrincipal>()
  let revision = 0
  /** Set once close() begins; listeners must not touch the harness afterwards. */
  let closed = false
  let weixin: WeixinBridge | undefined
  const broadcast = (event: Record<string, unknown>): void => {
    if (closed) return
    if (event.type === 'workspace/changed') weixin?.workspaceChanged()
    else weixin?.observe(event)
    if (event.type !== 'state') revision++
    const frame = `data: ${JSON.stringify({ ...event, revision })}\n\n`
    for (const [res, principal] of clients) {
      if (res.writableEnded || res.destroyed || !access.isActive(principal)) {
        clients.delete(res)
        res.destroy()
        continue
      }
      try {
        if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res) }
        else res.write(frame)
      } catch {
        clients.delete(res)
      }
    }
  }

  const refreshState = async (): Promise<void> => {
    if (closed) return
    try {
      broadcast({ type: 'state', state: await stateSnapshot() })
    } catch {
      /* harness already torn down — nothing to report */
    }
  }

  // ------------------------------------------------------------------
  // Update checks — the periodic background poll notifies SSE clients exactly
  // once per release. A failed poll (offline, blocked) only caches `error`.
  // ------------------------------------------------------------------
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
  const runUpdateCheck = async (): Promise<void> => {
    if (closed) return
    try {
      const { info, isNew } = await updateChecker.checkAndDetectChange()
      if (closed) return
      if (isNew) {
        // The notice renders as a chat line; the 'update' frame drives the
        // settings badge and survives reloads via state.update.
        broadcast({ type: 'notice', level: 'info', message: `发现新版本 v${info.latest}，可在设置中查看详情。` })
        broadcast({ type: 'update', update: info })
      } else {
        // Keep state.update fresh (checkedAt / recovery after an error).
        void refreshState()
      }
    } catch {
      /* checkAndDetectChange never throws; defensive only */
    } finally {
      if (!closed && updateTimer !== undefined) {
        updateTimer = setTimeout(() => void runUpdateCheck(), UPDATE_CHECK_INTERVAL_MS)
      }
    }
  }
  if (opts.updatesAutoCheck !== false) {
    updateTimer = setTimeout(() => void runUpdateCheck(), 5_000)
  }

  // ------------------------------------------------------------------
  // Harness mounting — the workspace can be switched at runtime (desktop
  // mode). The previous context is unwound first; interactive bridges and
  // the SSE fan-out are rebound onto the fresh context.
  // ------------------------------------------------------------------
  async function createWorkspaceHarness(cwd: string, config?: SakuraConfig, prefs?: WorkspacePrefs): Promise<Harness> {
    return createHarness({
      cwd,
      config,
      adapter: opts.adapter,
      approvalMode: liveApprovalMode,
      // A per-workspace session location wins over the process-level override;
      // both fall back to <workspace>/.sakura/sessions inside the harness.
      sessionDir: prefs?.sessionDir || opts.sessionDir,
      jobsDir: opts.jobsDir,
      maxSteps: opts.maxSteps,
      renderer: false,
    })
  }

  function configureWorkspaceHarness(next: Harness, selectedModel: string | undefined,
    providers: ReadonlyMap<string, { baseURL?: string; apiKey?: string }>): void {
    const llm = next.ctx.llm
    const baseline = llm.modelStatus().adapter
    for (const [adapter, config] of providers) {
      if (!llm.listModels().some(row => row.adapter === adapter)) continue
      llm.prepareConfiguration({
        model: adapter,
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      }).commit()
    }
    if (baseline) llm.setDefault(baseline)
    if (selectedModel !== undefined) llm.prepareConfiguration({ model: selectedModel }).commit()
  }

  async function mountHarness(mountOpts: {
    cwd: string
    config?: SakuraConfig
    resumeSessionId?: string
  }): Promise<void> {
    const next = await createWorkspaceHarness(mountOpts.cwd, mountOpts.config, prefsFor(mountOpts.cwd))
    try {
      const providers = new Map(providerOverrides)
      if (overrides.model && (overrides.baseURL !== undefined || overrides.apiKey !== undefined)) {
        const tx = next.ctx.llm.prepareConfiguration({ model: overrides.model })
        tx.commit()
        providers.clear()
        providers.set(next.ctx.llm.modelStatus().adapter, { baseURL: overrides.baseURL, apiKey: overrides.apiKey })
        tx.rollback()
      }
      configureWorkspaceHarness(next, overrides.model, providers)
      providerOverrides.clear()
      for (const [id, values] of providers) providerOverrides.set(id, values)
      if (mountOpts.resumeSessionId) next.main({ resumeSessionId: mountOpts.resumeSessionId })
    } catch (error) {
      next.dispose()
      throw error
    }
    bindHarness(next)
    await spawnWorkspaceAgents(mountOpts.cwd)
  }

  /**
   * Spawn the agents configured for a workspace. The roster is rebuilt on
   * every mount (bindHarness disposes the old one), so this is also where
   * a same-workspace agents patch takes effect for the missing types; types
   * removed from the prefs simply no longer come back on the next switch.
   */
  async function spawnWorkspaceAgents(target: string): Promise<void> {
    const agents = prefsFor(target).agents
    if (!agents?.length) return
    const defs = ctx.peek<{
      get(name: string): { name: string; description?: string; model?: string; tools?: 'full' | 'core' | string[]; systemPrompt: string } | undefined
    }>('agentDefs')
    for (const name of agents) {
      const def = defs?.get(name)
      if (!def) {
        broadcast({ type: 'notice', level: 'error', message: `工作区配置的智能体「${name}」未注册,已跳过` })
        continue
      }
      if (ctx.agents.list().some((agent) => agent.meta.agentType === name)) continue
      try {
        ctx.agents.spawn({
          name,
          seed: '',
          autoStart: false,
          persistentSession: true,
          model: def.model,
          systemPrompt: def.systemPrompt,
          tools: def.tools,
          meta: { role: 'sub', agentType: name, ...(def.description ? { description: def.description } : {}) },
        })
      } catch (error) {
        broadcast({ type: 'notice', level: 'error', message: `智能体「${name}」启动失败:${error instanceof Error ? error.message : String(error)}` })
      }
    }
  }

  function bindHarness(next: Harness): void {
    contextCache = null
    const previous: Harness | undefined = harness
    previous?.dispose()
    harness = next
    ctx = next.ctx
    // Carry caller/signal into interactive services without changing any plugin interface.
    ctx.on('tools/execute', (payload, next) => toolContext.run(payload.tc, () => next(payload)))
    for (const event of FORWARD_EVENTS) {
      ctx.on(event, (payload: Record<string, unknown>) => {
        if (event === 'ui/tool/call') {
          let args: unknown = {}
          try {
            args = JSON.parse(String(payload.argsRaw ?? '{}'))
          } catch {
            args = { raw: String(payload.argsRaw ?? '') }
          }
          broadcast({ type: event, ...payload, args })
          return
        }
        // Contract normalization: the harness ends turns with either `error`,
        // `cancelled`, or a plain `output` — the UI contract is a single `ok`.
        if (event === 'ui/turn/end') {
          broadcast({ type: event, ...payload, ok: !payload.error && !payload.cancelled })
          return
        }
        broadcast({ type: event, ...payload })
      })
    }
    ctx.on('kernel/error', (payload: { event?: string; error?: unknown }) => {
      const message = payload.error instanceof Error ? payload.error.message : String(payload.error ?? 'unknown')
      broadcast({ type: 'notice', level: 'error', message })
      if (payload.event === 'compaction') void refreshState()
    })
    ctx.on('agent/spawned', () => void refreshState())
    ctx.on('agent/status', () => void refreshState())
    ctx.on('ui/turn/end', () => void refreshState())
    ctx.on('compaction/done', () => void refreshState())
    ctx.on('mcp/status', () => void refreshState())
    ctx.approval.setConfirmHandler(confirmHandler)
    const interaction = ctx.peek<InteractionLike>('interaction')
    if (interaction) {
      interaction.setHandler(async (req) => {
        if (closed) return null
        const tc = toolContext.getStore()
        return pendingQuestions.wait({
          type: 'interaction/request',
          id: req.id,
          agentId: tc?.agentId,
          question: req.question,
          options: req.options,
        }, tc?.signal)
      })
    }
    const planService = ctx.peek<PlanLike>('plan')
    if (planService) {
      planService.setHandler(async (req) => {
        if (closed) return null
        const tc = toolContext.getStore()
        return pendingPlans.wait({ type: 'plan/propose', id: req.id, plan: req.plan, agentId: tc?.agentId }, tc?.signal)
      })
    }
    applySelectedModel()
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  /** The main agent as it currently stands — never re-passes the startup resume id (see above). */
  const mainAgent = (): import('../core/index.js').AgentHandle => harness.main()

  /**
   * The loop reads `agent.model` when each turn starts, so a model selected
   * through /api/settings is written onto the main agent's handle to reach the
   * next request. Subagents keep their own pinned models, and a main agent
   * that does not exist yet picks the selection up on its next spawn.
   */
  const applySelectedModel = (): void => {
    const model = ctx.llm.selectedModel()
    if (!model) return
    const main = ctx.agents.list().find((a) => a.meta.role === 'main')
    if (main) (main as { model: string }).model = model
  }

  const projectAgent = (a: {
    id: string
    name: string
    sessionId: string
    model: string
    status: string
    meta: { role?: string; description?: string }
    error?: string
  }): AgentProjection => ({
    id: a.id,
    name: a.name,
    role: a.meta.role ?? 'sub',
    status: a.status,
    model: a.model,
    sessionId: a.sessionId,
    description: a.meta.description,
    error: a.error,
  })

  /**
   * Estimated context size of the main session, memoized by event count so
   * every state snapshot doesn't rebuild the whole transcript.
   */
  async function contextTokens(): Promise<number> {
    const mount = ctx
    const epoch = workspaceEpoch
    const main = mainAgent()
    const sessionId = main.sessionId
    if (!sessionId) return 0
    try {
      const session = await mount.sessions.open(sessionId)
      const key = `${epoch}:${sessionId}:${session.events.length}`
      if (contextCache?.key === key) return contextCache.tokens
      const tokens = estimateMessagesTokens(session.deriveMessages())
      if (mount === ctx) contextCache = { key, tokens }
      return tokens
    } catch {
      return 0
    }
  }

  /**
   * Auto-compaction thresholds for the GUI's context meter; null when the
   * compaction plugin is not mounted (the meter then hides the threshold).
   */
  function contextBudget(): { autoThreshold: number; autoTokensThreshold: number } | null {
    const compaction = ctx.peek<{ autoThreshold: number; autoTokensThreshold: number }>('compaction')
    if (!compaction) return null
    return { autoThreshold: compaction.autoThreshold, autoTokensThreshold: compaction.autoTokensThreshold }
  }

  /** Dedicated summary model when set; the client shows it next to the model picker. */
  function compactionModel(): string | undefined {
    const compaction = ctx.peek<{ compactModel?: string }>('compaction')
    return compaction?.compactModel || undefined
  }

  async function stateSnapshot() {
    const mount = ctx
    const snapshotRevision = revision
    const snapshotWorkspace = workspaceId()
    const sessions = await mount.sessions.list()
    const tokens = await contextTokens()
    if (closed) throw new HttpError(503, 'server is shutting down')
    const main = mainAgent()
    // Never stamp an older disk listing with a newer revision (or workspace).
    // Otherwise an in-flight snapshot can resurrect a just-deleted session.
    if (mount !== ctx || snapshotWorkspace !== workspaceId() || snapshotRevision !== revision) return stateSnapshot()
    const plugins = ctx.peek<{ list(): Array<{ name: string; description?: string; source: string }> }>('plugins')
    const mcp = ctx.peek<McpLike>('mcp')
    return {
      version: VERSION,
      revision,
      server: { startedAt, remote: access.remote, authenticated: access.required },
      pendingRequests: [...pending.snapshot(), ...pendingQuestions.snapshot(), ...pendingPlans.snapshot()],
      cwd: workspaceCwd,
      workspaceId: snapshotWorkspace,
      /** Desktop mode: the settings view and workspace switching are mounted; absent on remote servers. */
      desktop: persistSettings ? currentDesktopState() : undefined,
      weixin: weixin?.status(),
      model: main.model || 'default',
      models: ctx.llm.listModels(),
      providers: ctx.llm.listProviders(),
      modelStatus: ctx.llm.modelStatus(),
      thinking: ctx.llm.thinking,
      approvalMode: ctx.approval.mode as ApprovalMode,
      busy: main.status === 'running',
      sessionId: isSessionId(main.sessionId) ? main.sessionId : null,
      contextTokens: tokens,
      contextBudget: contextBudget(),
      /** Present only when the compaction plugin is mounted; a value is a dedicated summary model. */
      compactModel: compactionModel(),
      /** Cached update-check result; absent until the first check completes. */
      update: updateChecker.cached(),
      sessions: sessions.map((s) => ({ id: s.id, title: s.title ?? s.id, updatedAt: s.startedAt, size: s.events, deleteBlocked: sessionDeletionBlock(s.id) })),
      agents: ctx.agents.list().map(projectAgent),
      tools: ctx.tools.list().map((t) => ({
        name: t.name,
        kind: t.kind,
        description: t.description,
        source: t.name.startsWith('mcp__') ? 'mcp' : t.name.startsWith('computer_') ? 'computer' : 'builtin',
      })),
      plugins: plugins?.list().map((p) => ({ name: p.name, description: p.description, source: p.source })) ?? [],
      agentTypes: ctx.peek<{ list(): Array<{ name: string; description: string }> }>('agentDefs')?.list().map((d) => ({ name: d.name, description: d.description })) ?? [],
      todos: ctx.peek<{ todos: Array<{ content: string; status: string; priority: string }> }>('todos')?.todos ?? [],
      mcp: mcp?.status() ?? [],
    }
  }

  // ------------------------------------------------------------------
  // Approval bridge: pending confirmations surface as SSE approval/request
  // frames and are resolved by POST /api/approvals/:id.
  // ------------------------------------------------------------------
  const pending = new PendingRequests<boolean>(broadcast, 'approval/resolved', 'allow', false, 5 * 60_000)

  const summarize = (args: Record<string, unknown>): string => {
    const preferred = args.path ?? args.file ?? args.command ?? args.pattern ?? args.url ?? args.query
    const text = typeof preferred === 'string' && preferred ? preferred : JSON.stringify(args) ?? ''
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }

  const confirmHandler: ConfirmHandler = async (req) => {
    if (closed) return false
    return pending.wait({
      type: 'approval/request',
      id: randomUUID(),
      agentId: req.agentId,
      toolName: req.tool.name,
      kind: req.tool.kind,
      summary: summarize(req.args),
      mode: ctx.approval.mode,
    }, req.signal)
  }

  // ------------------------------------------------------------------
  // ask_user bridge: interaction/request surfaces as an SSE frame with
  // option cards; POST /api/questions/:id resolves it.
  // ------------------------------------------------------------------
  const pendingQuestions = new PendingRequests<string | null>(broadcast, 'interaction/resolved', 'answer', null, 5 * 60_000)

  // ------------------------------------------------------------------
  // Plan bridge: exit_plan proposals surface as plan/propose SSE frames
  // with an approval card; POST /api/plans/:id resolves them.
  // ------------------------------------------------------------------
  const pendingPlans = new PendingRequests<'approve' | 'reject' | null>(broadcast, 'plan/resolved', 'decision', null, 10 * 60_000)

  // ------------------------------------------------------------------
  // Session switching: the roster is cleared (subagents included) and a
  // fresh main agent adopts the target session.
  // ------------------------------------------------------------------
  function assertAgentsIdle(): void {
    if (ctx.agents.list().some((agent) => agent.status === 'running')) {
      throw new HttpError(409, 'agents are running; interrupt them or wait before switching sessions')
    }
  }

  async function switchSession(id?: string, title?: string): Promise<string> {
    if (id !== undefined && !isSessionId(id)) {
      throw new HttpError(400, 'invalid session id')
    }
    if (settingsUpdating || deletingSession) throw new HttpError(409, 'a settings or session change is in progress; retry after it completes')
    if (switchingWorkspace) throw new HttpError(503, 'a workspace switch is in progress; retry')
    if (switching) throw new HttpError(409, 'a session switch is already in progress; retry after it completes')
    assertAgentsIdle()
    switching = true
    try {
      const sessionId = id
        ? (await ctx.sessions.open(id)).id // throws ENOENT → 404 upstream
        : (await ctx.sessions.create(title ? { title } : undefined)).id
      if (closed) throw new HttpError(503, 'server is shutting down')
      // Disk I/O yielded: another device may have started work in the meantime.
      // Never dispose its active agent just because this request arrived first.
      assertAgentsIdle()
      pending.cancel()
      pendingQuestions.cancel()
      pendingPlans.cancel()
      ctx.agents.disposeAll()
      ctx.approval.engine.clearSessionAllows()
      harness.main({ resumeSessionId: sessionId })
      // Preserve the selected model on the new main agent.
      applySelectedModel()
      broadcast({ type: 'session/changed', sessionId })
      await refreshState()
      return sessionId
    } finally {
      switching = false
    }
  }

  function sameSession(a: string | undefined, b: string): boolean {
    return process.platform === 'win32' ? a?.toLowerCase() === b.toLowerCase() : a === b
  }

  function sessionDeletionBlock(id: string): 'running' | 'bound' | 'compacting' | 'pending' | null {
    const agents = ctx.agents.list()
    const current = agents.some((agent) => agent.meta.role === 'main' && sameSession(agent.sessionId, id))
    if (agents.some((agent) => agent.status === 'running' &&
      (current || sameSession(agent.sessionId, id) || sameSession(agent.meta.parentSession, id)))) return 'running'
    if (agents.some((agent) => agent.meta.role !== 'main' && sameSession(agent.sessionId, id))) return 'bound'
    if (ctx.peek<{ isCompacting(id: string): boolean }>('compaction')?.isCompacting(id)) return 'compacting'
    if (current && (pending.snapshot().length || pendingQuestions.snapshot().length || pendingPlans.snapshot().length)) return 'pending'
    return null
  }

  async function deleteSession(id: string) {
    if (settingsUpdating || switching || deletingSession) throw new HttpError(409, 'a settings or session change is in progress; retry after it completes')
    if (switchingWorkspace) throw new HttpError(503, 'a workspace switch is in progress; retry')
    const mount = ctx
    const epoch = workspaceEpoch
    const assertDeletable = (): void => {
      if (closed || mount !== ctx || epoch !== workspaceEpoch || switchingWorkspace) {
        throw new HttpError(503, 'the workspace is changing or shutting down; retry')
      }
      const reason = sessionDeletionBlock(id)
      const messages = {
        running: 'agents are running; interrupt them or wait before deleting this session',
        bound: 'session is bound to a collaboration agent; start or switch the main session to release it first',
        compacting: 'session compaction is in progress; wait before deleting this session',
        pending: 'resolve pending approvals or questions before deleting this session',
      }
      if (reason) throw new HttpError(409, messages[reason])
    }
    deletingSession = id
    try {
      assertDeletable()
      await mount.sessions.delete(id, assertDeletable)
      if (closed) throw new HttpError(503, 'server is shutting down')
      const current = sameSession(mainAgent().sessionId, id)
      if (current) {
        pending.cancel()
        pendingQuestions.cancel()
        pendingPlans.cancel()
        mount.agents.disposeAll()
        mount.approval.engine.clearSessionAllows()
        const todos = mount.peek<{ todos: unknown[] }>('todos')
        if (todos) todos.todos = []
        harness.main() // New blank conversation; no directory until the next turn.
        applySelectedModel()
        contextCache = null
      }
      const sessionId = isSessionId(mainAgent().sessionId) ? mainAgent().sessionId : null
      const result = { deletedId: id, sessionId, workspaceId: workspaceId() }
      broadcast({ type: 'session/deleted', ...result })
      await refreshState()
      return { ok: true, ...result }
    } finally {
      deletingSession = null
    }
  }

  // Desktop workspace and provider edits share one transaction gate. A rejected
  // edit must leave both the mounted harness and its credentials unchanged.

  /** Validates a candidate workspace (path, directory, config load) before any
   *  mutation, so a rejected switch keeps the running workspace live. With
   *  create=true a missing directory is created (recursively) instead of
   *  rejecting — the "new workspace" flow. */
  async function resolveWorkspaceTarget(cwd: string, create?: boolean): Promise<string> {
    let target: string
    try {
      target = path.resolve(cwd)
    } catch {
      throw new HttpError(400, 'workspace must be an absolute directory path')
    }
    if (!path.isAbsolute(target)) throw new HttpError(400, 'workspace must be an absolute directory path')
    let isDirectory = false
    try {
      isDirectory = (await stat(target)).isDirectory()
    } catch {
      isDirectory = false
    }
    if (!isDirectory) {
      if (!create) throw new HttpError(400, 'workspace directory does not exist or is not readable')
      try {
        await mkdir(target, { recursive: true })
      } catch {
        throw new HttpError(400, 'cannot create the workspace directory (check the path and permissions)')
      }
    }
    return target
  }

  function currentDesktopState(full?: boolean): DesktopSettingsState {
    const prefs = prefsFor(workspaceCwd)
    return {
      workspace: workspaceCwd,
      recentWorkspaces: [...recentWorkspaces],
      baseURL: overrides.baseURL ?? '',
      model: overrides.model ?? '',
      rememberKey: desktopRememberKey,
      hasApiKey: Boolean(currentApiKey),
      newWorkspaceDir,
      sessionDir: prefs.sessionDir ?? '',
      agents: prefs.agents ?? [],
      ...(full ? { workspacePrefs: Object.fromEntries(workspacePrefs) } : {}),
    }
  }

  async function applyDesktopSettings(patch: {
    workspace?: string
    baseURL?: string
    model?: string
    apiKey?: string
    rememberKey?: boolean
    /** Create the target directory when it does not exist (new workspace flow). */
    create?: boolean
    /** Upstream request format for the targeted provider. */
    format?: UpstreamFormat
    /** Registered adapter id to edit, instead of the currently selected one. */
    provider?: string
    /** Global default parent for newly created workspaces ('' clears). */
    newWorkspaceDir?: string | null
    /** Session directory override for the target workspace (''/null restores the default). */
    sessionDir?: string | null
    /** Agent types to spawn when the target workspace mounts (null/[] = none). */
    agents?: string[] | null
  }): Promise<void> {
    if (closed) throw new HttpError(503, 'server is shutting down')
    if (settingsUpdating || switching || deletingSession || switchingWorkspace) {
      throw new HttpError(409, 'a workspace or settings change is in progress; retry')
    }
    assertAgentsIdle()
    const compaction = ctx.peek<{ isCompacting(id: string): boolean }>('compaction')
    if (ctx.agents.list().some(agent => compaction?.isCompacting(agent.sessionId))) {
      throw new HttpError(409, 'context compaction is running; wait before changing settings')
    }
    settingsUpdating = true
    const previousWorkspace = workspaceCwd
    const nextOverrides = { ...overrides }
    if (patch.model !== undefined) nextOverrides.model = patch.model || undefined
    if (patch.baseURL !== undefined) nextOverrides.baseURL = patch.baseURL || undefined
    if (patch.apiKey !== undefined) nextOverrides.apiKey = patch.apiKey
    const nextKey = patch.apiKey ?? currentApiKey
    const nextRemember = patch.rememberKey ?? desktopRememberKey
    const nextProviders = new Map(providerOverrides)
    let candidate: Harness | undefined
    let transaction: { commit(): void; rollback(): void } | undefined
    let committed = false
    try {
      const target = patch.workspace === undefined ? workspaceCwd : await resolveWorkspaceTarget(patch.workspace, patch.create)
      const willSwitch = path.resolve(target) !== path.resolve(workspaceCwd)
      // A session-location change on the current workspace also requires a
      // remount: sessions are bound to a directory at harness creation.
      const sessionDirChanged = !willSwitch && patch.sessionDir !== undefined &&
        (patch.sessionDir || '') !== (prefsFor(workspaceCwd).sessionDir ?? '')
      const needsRemount = willSwitch || sessionDirChanged
      // Per-workspace prefs and the global new-workspace default apply to the
      // target workspace before the remount and before persistence, so both
      // the candidate harness and the persist frame carry them.
      const targetPrefs = prefsFor(target)
      if (patch.sessionDir !== undefined) targetPrefs.sessionDir = patch.sessionDir || undefined
      if (patch.agents !== undefined) targetPrefs.agents = patch.agents?.length ? [...new Set(patch.agents)] : undefined
      if (patch.newWorkspaceDir !== undefined) newWorkspaceDir = patch.newWorkspaceDir || ''
      if (needsRemount) {
        let config: SakuraConfig
        try { config = await loadConfig({ cwd: target }) }
        catch { throw new HttpError(400, 'cannot load the target workspace configuration') }
        liveApprovalMode = ctx.approval.mode
        candidate = await createWorkspaceHarness(target, config, prefsFor(target))
        configureWorkspaceHarness(candidate, overrides.model, nextProviders)
        candidate.ctx.llm.setThinking(ctx.llm.thinking)
      }
      if (closed) throw new HttpError(503, 'server is shutting down')
      assertAgentsIdle()
      const llm = candidate?.ctx.llm ?? ctx.llm
      if (patch.model !== undefined || patch.baseURL !== undefined || patch.apiKey !== undefined) {
        transaction = llm.prepareConfiguration({
          ...(patch.model !== undefined ? { model: patch.model || null } : {}),
          ...(patch.baseURL !== undefined ? { baseURL: patch.baseURL || null } : {}),
          ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
          ...(patch.format !== undefined ? { format: patch.format } : {}),
          ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        })
        transaction.commit()
        const owner = llm.modelStatus().adapter
        const provider = { ...nextProviders.get(owner) }
        if (patch.baseURL !== undefined) {
          if (patch.baseURL) provider.baseURL = patch.baseURL
          else delete provider.baseURL
        }
        if (patch.apiKey !== undefined) provider.apiKey = patch.apiKey
        nextProviders.set(owner, provider)
      }
      const ordered = willSwitch ? [target, ...recentWorkspaces.filter(entry => entry !== target)].slice(0, 12) : [...recentWorkspaces]
      const persisted: DesktopSettingsState = {
        workspace: target,
        recentWorkspaces: ordered,
        baseURL: nextOverrides.baseURL ?? '',
        model: nextOverrides.model ?? '',
        rememberKey: nextRemember,
        hasApiKey: Boolean(nextKey),
        ...(nextRemember ? { apiKey: nextKey } : {}),
        newWorkspaceDir,
        sessionDir: targetPrefs.sessionDir ?? '',
        agents: targetPrefs.agents ?? [],
        workspacePrefs: Object.fromEntries(workspacePrefs),
      }
      try { await persistSettings?.(persisted) }
      catch { throw new HttpError(500, 'cannot persist desktop settings; previous configuration is unchanged') }
      if (closed) throw new HttpError(503, 'server is shutting down')
      if (candidate) {
        switchingWorkspace = true
        pending.cancel()
        pendingQuestions.cancel()
        pendingPlans.cancel()
        workspaceCwd = target
        workspaceEpoch++
        bindHarness(candidate)
        candidate = undefined
        // Fresh roster: bring up the agents configured for this workspace.
        await spawnWorkspaceAgents(target)
      } else if (patch.agents !== undefined || patch.sessionDir !== undefined) {
        // Same workspace, no remount: spawn the newly configured agent types.
        await spawnWorkspaceAgents(target)
      }
      overrides.model = nextOverrides.model
      overrides.baseURL = nextOverrides.baseURL
      overrides.apiKey = nextOverrides.apiKey
      currentApiKey = nextKey
      desktopRememberKey = nextRemember
      providerOverrides.clear()
      for (const [id, provider] of nextProviders) providerOverrides.set(id, provider)
      recentWorkspaces.splice(0, recentWorkspaces.length, ...ordered)
      applySelectedModel()
      committed = true
      if (needsRemount) broadcast({ type: 'workspace/changed', workspace: target, previous: previousWorkspace })
    } catch (error) {
      if (!committed) transaction?.rollback()
      if (error instanceof HttpError) throw error
      let message = ctx.llm.redactError(error instanceof Error ? error.message : String(error))
      if (patch.apiKey) message = message.split(patch.apiKey).join('[redacted]')
      throw new HttpError(400, message)
    } finally {
      candidate?.dispose()
      settingsUpdating = false
      switchingWorkspace = false
    }
  }

  /** The port actually listening — needed to judge a browser Origin. */
  function boundPort(): number {
    const address = server.address()
    return typeof address === 'object' && address ? address.port : (opts.port ?? 0)
  }

  const bodyJson = (req: IncomingMessage, cap?: number) => readJson(req, opts.bodyTimeoutMs, cap)

  const indexHtmlCache: { html?: string } = {}
  async function getIndexHtml(): Promise<string> {
    if (indexHtmlCache.html) return indexHtmlCache.html
    try {
      // Embedded by scripts/build-client.mjs (virtual module); throws in dev.
      // @ts-expect-error virtual module — resolved by the esbuild embed plugin
      const mod = (await import('sakura-web-index-embed')) as { default?: string }
      if (typeof mod.default === 'string' && mod.default.length > 0) {
        indexHtmlCache.html = mod.default
        return indexHtmlCache.html
      }
    } catch {
      /* dev mode: not embedded — read from disk on every request so edits hot-reload */
    }
    return readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.html'), 'utf8')
  }

  function decodeSessionId(value: string): string {
    let id: string
    try { id = decodeURIComponent(value) } catch { throw new HttpError(400, 'invalid session id') }
    if (!isSessionId(id)) throw new HttpError(400, 'invalid session id')
    return id
  }

  // The startup mount binds the initial workspace (and any --resume) before
  // the first request can arrive; desktop settings may later replace it.
  await mountHarness({ cwd: workspaceCwd, config: opts.config, resumeSessionId: opts.resumeSessionId })

  const server: Server = createServer((req, res) => {
    void route(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : error instanceof SessionError
        ? ({ EINVAL: 400, ENOENT: 404, EBUSY: 409 } as const)[error.code]
        : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 : 500
      try {
        if (status === 408 || status === 413) {
          res.setHeader('connection', 'close')
          res.once('finish', () => req.destroy())
        }
        if (status === 429) res.setHeader('retry-after', '60')
        json(res, status, { error: error instanceof Error ? error.message : String(error) })
      } catch {
        res.destroy() // headers already sent (e.g. mid-SSE)
      }
    })
  })

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('cache-control', 'no-store')
    access.guard(req, boundPort())
    const url = new URL(req.url ?? '/', 'http://local')
    const { pathname } = url
    const method = req.method ?? 'GET'

    if (['/', '/index.html', '/dashboard'].includes(pathname) && method === 'GET') {
      const html = await getIndexHtml()
      // The HTML tokenizer normalizes CRLF/CR to LF before the script text reaches the
      // DOM, so the CSP hash must cover the normalized text or the browser will reject
      // its own inline script when index.html carries Windows line endings.
      const rawScript = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? ''
      const script = rawScript.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      const hash = createHash('sha256').update(script, 'utf8').digest('base64')
      res.setHeader('content-security-policy', `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    if (pathname === '/api/auth' && method === 'GET') {
      json(res, 200, access.status(req, boundPort()))
      return
    }
    if (pathname === '/api/auth/login' && method === 'POST') {
      if (!access.required) throw new HttpError(400, 'authentication is not enabled')
      access.beginLogin(req.socket.remoteAddress ?? 'unknown')
      const body = await bodyJson(req, 4096)
      const principal = access.login(body.token)
      // Replacing a login also revokes that browser's previous session.
      access.logout(req, boundPort())
      res.setHeader('set-cookie', access.cookie(principal.sessionId!, boundPort()))
      json(res, 200, { ok: true, role: principal.role, expiresAt: principal.expiresAt })
      return
    }
    if (pathname === '/api/auth/logout' && method === 'POST') {
      access.logout(req, boundPort())
      res.setHeader('set-cookie', access.cookie('', boundPort()))
      for (const [client, principal] of clients) {
        if (!access.isActive(principal)) { client.destroy(); clients.delete(client) }
      }
      json(res, 200, { ok: true })
      return
    }

    const principal = access.principal(req, boundPort())
    if (!principal) {
      res.setHeader('www-authenticate', 'Bearer realm="SakuraCode"')
      throw new HttpError(401, 'authentication required')
    }
    if (principal.role === 'viewer' && method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(403, 'read-only viewer cannot modify the workspace')
    }
    // Requests that started on an older workspace must not act on the new one
    // after an await: 503 makes the client retry against the current mount.
    const workspaceEpochAtEntry = workspaceEpoch
    const assertWorkspaceSame = (): void => {
      if (settingsUpdating) throw new HttpError(409, 'settings are being saved; retry after completion')
      if (workspaceEpochAtEntry !== workspaceEpoch || switchingWorkspace) {
        throw new HttpError(503, 'the workspace switched while this request was in flight; retry')
      }
      if (req.headers['x-sakura-workspace'] !== undefined && req.headers['x-sakura-workspace'] !== workspaceId()) {
        throw new HttpError(409, 'the workspace changed; refresh before retrying this operation')
      }
      if (deletingSession && method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(409, 'a session deletion is in progress; retry after it completes')
      }
    }

    // A workspace switch rebuilds the harness; mid-switch requests must not
    // race the disposal. SSE clients retry automatically (retry: 2000).
    // A session switch only rebinds agents, so it keeps its own 409 contract.
    if (switchingWorkspace && !pathname.startsWith('/api/auth')) {
      throw new HttpError(503, 'a workspace switch is in progress; retry in a moment')
    }
    assertWorkspaceSame()

    if (pathname === '/api/events' && method === 'GET') {
      if (clients.size >= 64) throw new HttpError(503, 'too many event stream clients')
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      res.write('retry: 2000\n\n')
      clients.set(res, principal)
      let expiry: NodeJS.Timeout | undefined
      if (principal.expiresAt) {
        expiry = setTimeout(() => { clients.delete(res); res.destroy() }, Math.max(1, principal.expiresAt - Date.now()))
        expiry.unref()
      }
      res.on('close', () => { clients.delete(res); clearTimeout(expiry) })
      const state = await stateSnapshot()
      if (!access.isActive(principal)) { res.destroy(); clients.delete(res); return }
      res.write(`data: ${JSON.stringify({ type: 'state', state })}\n\n`)
      return
    }

    if (pathname === '/api/state' && method === 'GET') {
      json(res, 200, await stateSnapshot())
      return
    }

    if (pathname === '/api/updates/check' && method === 'POST') {
      // Read-only and workspace-independent: available to viewers too, so a
      // read-only dashboard still shows the version banner.
      const info = await updateChecker.check()
      if (info.hasUpdate) broadcast({ type: 'update', update: info })
      json(res, 200, info)
      return
    }

    if (pathname.startsWith('/api/weixin/')) {
      if (!weixin || access.remote || principal.role !== 'operator') throw new HttpError(404, 'Weixin settings are available only in the local desktop app')
      if (pathname === '/api/weixin/status' && method === 'GET') { json(res, 200, weixin.status()); return }
      if (method !== 'POST') throw new HttpError(405, 'POST required')
      const body = await bodyJson(req, 4096)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      try {
        let result
        if (pathname === '/api/weixin/login') result = await weixin.beginLogin()
        else if (pathname === '/api/weixin/settings') {
          const patch: { enabled?: boolean; allowControl?: boolean; notifications?: boolean } = {}
          for (const key of ['enabled', 'allowControl', 'notifications'] as const) {
            if (body[key] === undefined) continue
            if (typeof body[key] !== 'boolean') throw new HttpError(400, `${key} must be boolean`)
            patch[key] = body[key]
          }
          result = await weixin.configure(patch)
        } else if (pathname === '/api/weixin/disconnect') result = await weixin.disconnect()
        else {
          if (typeof body.loginId !== 'string' || body.loginId.length > 100) throw new HttpError(400, 'loginId is required')
          if (pathname === '/api/weixin/verify') {
            if (typeof body.code !== 'string') throw new HttpError(400, 'verification code is required')
            result = weixin.verify(body.loginId, body.code)
          } else if (pathname === '/api/weixin/confirm') result = await weixin.confirm(body.loginId)
          else if (pathname === '/api/weixin/cancel') result = weixin.cancel(body.loginId)
          else throw new HttpError(404, 'unknown Weixin operation')
        }
        json(res, 200, result)
      } catch (error) {
        if (error instanceof WeixinBridgeError) throw new HttpError(error.status, error.message)
        throw error
      }
      return
    }

    if (pathname === '/api/message' && method === 'POST') {
      const body = await bodyJson(req)
      assertWorkspaceSame()
      if (typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'text is required' })
        return
      }
      let text: string = body.text.trim()
      // Attached images (GUI paste/upload) — data URLs only, capped at 8 MB total.
      let images: string[] | undefined
      if (Array.isArray(body.images) && body.images.length) {
        const ok = body.images.filter((s): s is string => typeof s === 'string' && s.startsWith('data:image/'))
        const total = ok.reduce((n, s) => n + s.length, 0)
        if (total > 8 * 1024 * 1024) {
          json(res, 413, { error: 'images too large (8 MB cap)' })
          return
        }
        images = ok.length ? ok : undefined
      }
      // Custom slash commands: "/name args" expands to the markdown prompt.
      if (text.startsWith('/')) {
        const [cmd, ...rest] = text.split(/\s+/)
        const arg = rest.join(' ')
        const hit = listSlashCommands(workspaceCwd).find((c) => c.name === (cmd ?? '').slice(1))
        if (!hit) {
          json(res, 400, { error: `unknown command ${cmd}` })
          return
        }
        text = expandSlashCommand(hit.file, arg).prompt
      }
      // @-mentions: @path[:line] tokens expand into appended context blocks.
      const expansion = expandMentions(text, { cwd: workspaceCwd })
      text = expansion.text
      for (const miss of expansion.missing) {
        broadcast({ type: 'notice', level: 'info', message: `${miss.mention}: ${miss.reason}` })
      }
      const main = mainAgent()
      // The agent's mailbox serializes turns — sending while busy queues
      // behind the running turn instead of failing.
      const queued = main.status === 'running'
      void main
        .turn(text, images?.length ? { images } : undefined)
        .then((result) => {
          if (result.error) broadcast({ type: 'notice', level: 'error', message: result.error })
        })
        .catch((error: unknown) => {
          broadcast({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) })
        })
      json(res, 202, { ok: true, queued })
      return
    }

    if (pathname === '/api/interrupt' && method === 'POST') {
      const main = mainAgent()
      main.interrupt()
      pending.cancel(main.id)
      json(res, 200, { ok: true })
      return
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([\w-]+)$/)
    if (approvalMatch && method === 'POST') {
      const body = await bodyJson(req, 4096)
      if (typeof body.allow !== 'boolean' || (body.always !== undefined && typeof body.always !== 'boolean')) {
        throw new HttpError(400, 'allow must be boolean; always must be boolean when supplied')
      }
      const entry = pending.get(approvalMatch[1]!)
      if (!entry || !pending.resolve(approvalMatch[1]!, body.allow)) {
        json(res, 404, { error: 'unknown or already-resolved approval' })
        return
      }
      if (body.allow === true && body.always === true) {
        ctx.approval.engine.allowForSession(String(entry.toolName))
        broadcast({ type: 'notice', level: 'info', message: `"${entry.toolName}" allowed for this session` })
      }
      json(res, 200, { ok: true })
      return
    }

    const questionMatch = pathname.match(/^\/api\/questions\/([\w-]+)$/)
    if (questionMatch && method === 'POST') {
      const body = await bodyJson(req, 64 * 1024)
      if (typeof body.answer !== 'string' || !body.answer.trim()) throw new HttpError(400, 'answer is required')
      if (!pendingQuestions.resolve(questionMatch[1]!, body.answer.trim())) {
        json(res, 404, { error: 'unknown or already-answered question' })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    const planMatch = pathname.match(/^\/api\/plans\/([\w-]+)$/)
    if (planMatch && method === 'POST') {
      const body = await bodyJson(req, 4096)
      if (body.decision !== 'approve' && body.decision !== 'reject') throw new HttpError(400, 'decision must be approve or reject')
      if (!pendingPlans.resolve(planMatch[1]!, body.decision)) {
        json(res, 404, { error: 'unknown or already-resolved plan' })
        return
      }
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/commands' && method === 'GET') {
      json(res, 200, { commands: listSlashCommands(workspaceCwd) })
      return
    }

    if (pathname === '/api/sessions' && method === 'POST') {
      const body = await bodyJson(req) as { id?: unknown; title?: unknown }
      assertWorkspaceSame()
      let title: string | undefined
      if (body.title !== undefined && body.title !== null && body.title !== '') {
        if (typeof body.title !== 'string' || /[\x00-\x1f\x7f]/.test(body.title)) {
          throw new HttpError(400, 'title must be a single line of 1-60 characters')
        }
        title = body.title.trim().slice(0, 60) || undefined
      }
      const sessionId = await switchSession(body.id as string | undefined, title)
      json(res, 200, { sessionId })
      return
    }

    const renameMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (renameMatch && method === 'PATCH') {
      const id = decodeSessionId(renameMatch[1]!)
      const body = await bodyJson(req) as { title?: unknown }
      assertWorkspaceSame()
      if (typeof body.title !== 'string' || !body.title.trim() || /[\x00-\x1f\x7f]/.test(body.title)) {
        throw new HttpError(400, 'title is required (single line, ≤60 characters)')
      }
      const title = body.title.trim().slice(0, 60)
      try {
        await ctx.sessions.rename(id, title)
      } catch (error) {
        if (error instanceof SessionError && error.code === 'ENOENT') throw new HttpError(404, `session "${id}" not found`)
        throw error
      }
      for (const session of await ctx.sessions.list()) {
        if (session.id === id) { session.title = title; break }
      }
      await refreshState()
      json(res, 200, { sessionId: id, title })
      return
    }

    const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const id = decodeSessionId(deleteMatch[1]!)
      json(res, 200, await deleteSession(id))
      return
    }

    const recordsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/records$/)
    if (recordsMatch && method === 'GET') {
      const id = decodeSessionId(recordsMatch[1]!)
      assertWorkspaceSame()
      try {
        const session = await ctx.sessions.open(id)
        json(res, 200, { records: session.events })
      } catch {
        json(res, 404, { error: `session "${id}" not found` })
      }
      return
    }

    const exportMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/export$/)
    if (exportMatch && method === 'GET') {
      const id = decodeSessionId(exportMatch[1]!)
      assertWorkspaceSame()
      const exporter = ctx.peek<SessionExportLike>('sessionExport')
      if (!exporter) {
        json(res, 404, { error: 'session export is not mounted' })
        return
      }
      try {
        const md = await exporter.toMarkdown(id)
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${id}.md"`,
        })
        res.end(md)
      } catch (error) {
        json(res, 404, { error: error instanceof Error ? error.message : `session "${id}" not found` })
      }
      return
    }

    if (pathname === '/api/agents' && method === 'POST') {
      const body = await bodyJson(req) as {
        name?: string
        model?: string
        systemPrompt?: string
        tools?: 'full' | 'core' | string[]
        background?: boolean
        description?: string
        agent?: string
      }
      assertWorkspaceSame()
      // Predefined agent type (core-agent-defs) supplies model/tools/systemPrompt.
      let defSystemPrompt: string | undefined
      let defModel: string | undefined
      let defTools: 'full' | 'core' | string[] | undefined
      if (body.agent) {
        const defs = ctx.peek<{
          get(name: string): { name: string; model?: string; tools?: 'full' | 'core' | string[]; systemPrompt: string } | undefined
        }>('agentDefs')
        const def = defs?.get(body.agent)
        if (!def) {
          json(res, 400, { error: `unknown agent type "${body.agent}"` })
          return
        }
        defSystemPrompt = def.systemPrompt
        defModel = def.model
        defTools = def.tools
      }
      const handle = ctx.agents.spawn({
        name: body.name,
        seed: '',
        autoStart: false,
        persistentSession: true,
        background: body.background,
        model: body.model ?? defModel,
        systemPrompt: body.systemPrompt ?? defSystemPrompt,
        tools: body.tools ?? defTools,
        meta: { role: 'sub', ...(body.agent ? { agentType: body.agent } : {}), ...(body.description ? { description: body.description } : {}) },
      })
      json(res, 200, { agent: projectAgent(handle) })
      return
    }

    const agentMessageMatch = pathname.match(/^\/api\/agents\/([^/]+)\/message$/)
    if (agentMessageMatch && method === 'POST') {
      const body = await bodyJson(req)
      assertWorkspaceSame()
      if (typeof body.text !== 'string' || !body.text.trim()) {
        json(res, 400, { error: 'text is required' })
        return
      }
      try {
        ctx.agents.deliver(decodeURIComponent(agentMessageMatch[1]!), body.text)
        json(res, 202, { ok: true })
      } catch {
        json(res, 404, { error: 'unknown agent' })
      }
      return
    }

    const agentInterruptMatch = pathname.match(/^\/api\/agents\/([^/]+)\/interrupt$/)
    if (agentInterruptMatch && method === 'POST') {
      const id = decodeURIComponent(agentInterruptMatch[1]!)
      const ok = ctx.agents.interrupt(id)
      if (ok) pending.cancel(id)
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'agent not found or not running' })
      return
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await bodyJson(req)
      assertWorkspaceSame()
      // Validate the entire patch before changing permissions or live routing.
      // In particular, an invalid model must not partially relax approval mode.
      const levels = ['off', 'low', 'medium', 'high'] as const
      if (body.approvalMode !== undefined && !APPROVAL_MODES.includes(body.approvalMode as ApprovalMode)) {
        throw new HttpError(400, `approvalMode must be one of: ${APPROVAL_MODES.join(', ')}`)
      }
      if (body.thinking !== undefined && !levels.includes(body.thinking as (typeof levels)[number])) {
        throw new HttpError(400, 'thinking must be one of: off, low, medium, high')
      }
      let modelUpdate: { commit(): void } | undefined
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || !body.model) throw new HttpError(400, 'model must be a non-empty string')
        try {
          // This picker accepts only registered models (unlike desktop edits,
          // which may introduce a new name on the compatible provider).
          const owner = ctx.llm.pick(body.model)
          if (owner.id !== body.model && owner.defaultModel !== body.model && !owner.models?.includes(body.model)) {
            throw new Error(`unknown model "${body.model}"`)
          }
          modelUpdate = ctx.llm.prepareConfiguration({ model: body.model })
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error))
        }
      }
      // The summary model only affects future compactions, so it may change
      // while agents run; the running-agent guard below is about the routing
      // of live requests (model/thinking), not about summary scheduling.
      const compaction = body.compactModel !== undefined
        ? ctx.peek<{ setCompactModel(model?: string | null): void }>('compaction')
        : undefined
      if (body.compactModel !== undefined && !compaction) {
        throw new HttpError(400, 'compaction is not mounted; this server cannot set a compaction model')
      }
      if (body.compactModel !== undefined && body.compactModel !== null) {
        if (typeof body.compactModel !== 'string' || !body.compactModel) {
          throw new HttpError(400, 'compactModel must be a non-empty string or null')
        }
        try {
          const owner = ctx.llm.pick(body.compactModel)
          if (owner.id !== body.compactModel && owner.defaultModel !== body.compactModel && !owner.models?.includes(body.compactModel)) {
            throw new Error(`unknown model "${body.compactModel}"`)
          }
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error))
        }
      }
      if ((body.model !== undefined || body.thinking !== undefined) && ctx.agents.list().some(agent => agent.status === 'running')) {
        throw new HttpError(409, 'agents are running; interrupt them or wait before changing model or thinking settings')
      }
      // No await between validation and commit: a turn cannot start halfway
      // through this patch. Approval-only edits remain available mid-turn.
      modelUpdate?.commit()
      if (body.model !== undefined) applySelectedModel()
      if (body.thinking !== undefined) ctx.llm.setThinking(body.thinking as (typeof levels)[number])
      if (body.approvalMode !== undefined) ctx.approval.setMode(body.approvalMode as ApprovalMode)
      if (body.compactModel !== undefined) compaction!.setCompactModel(body.compactModel as string | null)
      await refreshState()
      json(res, 200, { approvalMode: ctx.approval.mode, thinking: ctx.llm.thinking, compactModel: compactionModel() })
      return
    }

    if (pathname === '/api/models/upstream' && method === 'POST') {
      assertWorkspaceSame()
      const body = await bodyJson(req, 4096) as { baseURL?: unknown; apiKey?: unknown }
      if (typeof body.baseURL !== 'string' || !body.baseURL) throw new HttpError(400, 'baseURL is required')
      if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(body.apiKey))) {
        throw new HttpError(400, 'API key contains invalid whitespace or control characters')
      }
      try {
        const models = await fetchUpstreamModels(body.baseURL, body.apiKey || undefined)
        json(res, 200, { models })
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : 'cannot fetch the upstream model list')
      }
      return
    }

    if (pathname === '/api/desktop/settings' && (method === 'GET' || method === 'POST')) {
      if (!persistSettings) {
        json(res, 404, { error: 'workspace settings are available only in the desktop app' })
        return
      }
      if (method === 'GET') {
        json(res, 200, currentDesktopState())
        return
      }
      const body = await bodyJson(req) as {
        workspace?: unknown
        baseURL?: unknown
        model?: unknown
        apiKey?: unknown
        rememberKey?: unknown
        create?: unknown
        newWorkspaceDir?: unknown
        sessionDir?: unknown
        agents?: unknown
        format?: unknown
        provider?: unknown
      }
      assertWorkspaceSame()
      const patch: {
        workspace?: string; baseURL?: string; model?: string; apiKey?: string; rememberKey?: boolean
        create?: boolean; newWorkspaceDir?: string | null; sessionDir?: string | null; agents?: string[] | null
        format?: UpstreamFormat; provider?: string
      } = {}
      if (body.workspace !== undefined) {
        if (typeof body.workspace !== 'string' || !path.isAbsolute(body.workspace)) {
          throw new HttpError(400, 'workspace must be an absolute directory path')
        }
        patch.workspace = path.resolve(body.workspace)
      }
      if (body.baseURL !== undefined) {
        if (body.baseURL !== '') {
          if (typeof body.baseURL !== 'string') throw new HttpError(400, 'invalid model API URL')
          let url: URL
          try {
            url = new URL(body.baseURL)
          } catch {
            throw new HttpError(400, 'invalid model API URL')
          }
          if (
            (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) ||
            url.username || url.password || url.search || url.hash
          ) {
            throw new HttpError(400, 'model API URL must use HTTPS (HTTP is allowed only for a local model), without credentials, query or fragment')
          }
        }
        patch.baseURL = String(body.baseURL)
      }
      if (body.model !== undefined) {
        if (body.model !== '' && (typeof body.model !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(body.model))) {
          throw new HttpError(400, 'model name must be a single line of 1-200 characters')
        }
        patch.model = String(body.model)
      }
      if (body.apiKey !== undefined) {
        if (body.apiKey !== '' && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\x00-\x20\x7f]/.test(body.apiKey))) {
          throw new HttpError(400, 'API key contains invalid whitespace or control characters')
        }
        patch.apiKey = String(body.apiKey)
      }
      if (body.rememberKey !== undefined) {
        if (typeof body.rememberKey !== 'boolean') throw new HttpError(400, 'rememberKey must be a boolean')
        patch.rememberKey = body.rememberKey
      }
      if (body.format !== undefined) {
        if (body.format !== 'chat-completions' && body.format !== 'responses') {
          throw new HttpError(400, 'format must be one of: chat-completions, responses')
        }
        patch.format = body.format
      }
      if (body.provider !== undefined) {
        if (typeof body.provider !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.provider)) {
          throw new HttpError(400, 'provider must be a registered adapter id')
        }
        patch.provider = body.provider
      }
      if (body.create !== undefined) {
        if (typeof body.create !== 'boolean') throw new HttpError(400, 'create must be a boolean')
        patch.create = body.create
      }
      if (body.newWorkspaceDir !== undefined) {
        if (body.newWorkspaceDir !== null && body.newWorkspaceDir !== '') {
          if (typeof body.newWorkspaceDir !== 'string' || !path.isAbsolute(body.newWorkspaceDir) || body.newWorkspaceDir.includes('\0')) {
            throw new HttpError(400, 'newWorkspaceDir must be an absolute directory path')
          }
          patch.newWorkspaceDir = path.resolve(body.newWorkspaceDir)
        } else {
          patch.newWorkspaceDir = body.newWorkspaceDir === null ? null : ''
        }
      }
      if (body.sessionDir !== undefined) {
        if (body.sessionDir !== null && body.sessionDir !== '') {
          if (typeof body.sessionDir !== 'string' || /[\x00-\x1f\x7f]/.test(body.sessionDir) || body.sessionDir.length > 4096) {
            throw new HttpError(400, 'sessionDir must be a single-line path')
          }
          patch.sessionDir = body.sessionDir.trim()
        } else {
          patch.sessionDir = body.sessionDir === null ? null : ''
        }
      }
      if (body.agents !== undefined) {
        if (body.agents === null) {
          patch.agents = null
        } else {
          if (!Array.isArray(body.agents) || body.agents.some((entry) => typeof entry !== 'string' || !entry || /[\x00-\x1f\x7f]/.test(entry))) {
            throw new HttpError(400, 'agents must be an array of agent type names')
          }
          patch.agents = body.agents as string[]
        }
      }
      await applyDesktopSettings(patch)
      await refreshState()
      json(res, 200, currentDesktopState())
      return
    }

    if (pathname === '/api/mcp' && method === 'GET') {
      const mcp = ctx.peek<McpLike>('mcp')
      json(res, 200, { servers: mcp?.status() ?? [] })
      return
    }

    const mcpReconnectMatch = pathname.match(/^\/api\/mcp\/([^/]+)\/reconnect$/)
    if (mcpReconnectMatch && method === 'POST') {
      const mcp = ctx.peek<McpLike>('mcp')
      if (!mcp) {
        json(res, 404, { error: 'mcp service is not mounted' })
        return
      }
      try {
        await mcp.reconnect(decodeURIComponent(mcpReconnectMatch[1]!))
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 502, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    json(res, 404, { error: `no route: ${method} ${pathname}` })
  }

  // Heartbeat keeps proxies/idle sockets from closing the SSE stream.
  const heartbeat = setInterval(() => {
    for (const [res, principal] of clients) {
      try {
        if (!access.isActive(principal) || res.destroyed || res.writableLength > 1024 * 1024) {
          res.destroy()
          clients.delete(res)
        } else res.write(': ping\n\n')
      } catch {
        clients.delete(res)
      }
    }
  }, 25_000)
  heartbeat.unref()

  const port = await new Promise<number>((resolve, reject) => {
    const failed = (error: Error): void => {
      clearInterval(heartbeat)
      harness.dispose()
      reject(error)
    }
    server.once('error', failed)
    server.listen(requestedPort, host, () => {
      server.off('error', failed)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : (opts.port ?? 0))
    })
  })
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host
  const url = access.publicOrigin ? access.publicOrigin + '/' : `http://${displayHost}:${port}/`

  if (opts.onPersistWeixin && !access.remote) {
    weixin = new WeixinBridge({
      saved: opts.weixin,
      transport: opts.weixinTransport,
      persist: opts.onPersistWeixin,
      changed: state => broadcast({ type: 'weixin/state', state }),
      redact: text => ctx.llm.redactError(text),
      workspace: () => ({
        id: workspaceId(), name: path.basename(workspaceCwd) || '当前工作区',
        agents: ctx.agents.list().map(agent => ({ id: agent.id, name: agent.name, role: agent.meta.role ?? 'sub', status: agent.status, model: agent.model })),
        pendingCount: pending.snapshot().length + pendingQuestions.snapshot().length + pendingPlans.snapshot().length,
      }),
      command: action => {
        if (closed || settingsUpdating || switchingWorkspace || switching || deletingSession || action.workspaceId !== workspaceId()) {
          throw new Error('workspace unavailable')
        }
        const agent = action.agentId ? ctx.agents.get(action.agentId) : mainAgent()
        if (!agent) throw new Error('agent no longer exists')
        if (action.type === 'stop') {
          agent.interrupt()
          pending.cancel(agent.id)
          pendingQuestions.cancel(agent.id)
          pendingPlans.cancel(agent.id)
          return `已请求停止 ${agent.name} 的当前回合，排队任务不会删除。`
        }
        const text = action.text?.trim()
        if (!text || text.length > 8000) throw new Error('invalid task')
        const queued = agent.status === 'running'
        // The same mailbox and approval pipeline as the GUI; phone text is not
        // expanded into local files or custom slash commands.
        void agent.turn(text).catch(() => broadcast({ type: 'notice', level: 'error', message: '微信发起的任务未能完成，请查看会话。' }))
        return `${queued ? '已排队' : '已发送'}给 ${agent.name}，进度将通过微信通知。需要审批时请回到电脑。`
      },
    })
    weixin.start()
  }

  if (opts.open !== false) openBrowser(url)
  if (!opts.quiet) {
    console.log(`SakuraCode Web GUI → ${url}  (cwd: ${workspaceCwd})`)
    console.log(`Dashboard → ${url}dashboard · ${access.required ? 'token login required' : 'local access only'}`)
    if (access.remote && !access.publicOrigin) {
      if (host === '0.0.0.0') {
        for (const info of Object.values(networkInterfaces()).flat()) {
          if (info?.family === 'IPv4' && !info.internal) console.log(`LAN → http://${info.address}:${port}/dashboard`)
        }
      }
      console.log('Warning: HTTP is not encrypted. Use a trusted LAN/VPN or an HTTPS reverse proxy; do not expose this port to the Internet.')
    }
    console.log('Ctrl+C to stop.')
  }

  return {
    server,
    port,
    url,
    /** The live harness — replaced when the workspace is switched. */
    get harness() {
      return harness
    },
    async close() {
      if (closed) return
      closed = true
      clearInterval(heartbeat)
      if (updateTimer !== undefined) clearTimeout(updateTimer)
      await weixin?.close()
      ctx.agents.disposeAll()
      pending.cancel()
      pendingQuestions.cancel()
      pendingPlans.cancel()
      access.dispose()
      for (const res of clients.keys()) res.destroy()
      clients.clear()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      harness.dispose()
    },
  }
}

function openBrowser(url: string): void {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch {
    /* headless environments: the URL is printed instead */
  }
}
