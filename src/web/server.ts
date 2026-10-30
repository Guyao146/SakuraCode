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
import { APPROVAL_MODES, type ApprovalMode, type AgentHandle, type ConfirmHandler, type HarnessContext } from '../core/index.js'
import { isSessionId, SessionError, SessionService, type SessionActivity } from '../core/session.js'
import { CheckpointError } from '../core/checkpoints.js'
import { ConversationHistoryService, type HistoryMode } from '../core/conversation-history.js'
import { fetchUpstreamModels, type UpstreamFormat } from '../core/llm.js'
import { loadConfig, resolveProfile, type SakuraConfig } from '../config.js'
import { listCommands as listSlashCommands, expandCommand as expandSlashCommand } from '../skills/commands.js'
import { expandMentions } from '../mentions/index.js'
import { summarizeUsage, type SessionTokenStats } from '../util/tokens.js'
import { DEFAULT_CONTEXT_WINDOW_TOKENS, inspectContext, validateContextBudget, type ContextBreakdown, type ContextBudgetSettings } from '../util/context.js'
import { parseQuotaDisplay, type DesktopAppearance } from '../util/appearance.js'
import { DEFAULT_RETRY_POLICY, validateRetryPolicy, type RetryPolicy } from '../util/retry.js'
import type { RetryService } from '../core/retry.js'
import { importSkill, SkillImportError, SKILL_IMPORT_MAX_BYTES } from '../skills/import.js'
import type { SkillsService } from '../skills/index.js'
import type { AgentDefsService } from '../agents/index.js'
import { expandResourceReferences, resourceToken, type ResourceReference, type ResourceCandidate } from '../mentions/resources.js'
import type { CompactionService } from '../plugins/compaction.js'
import { isLoopbackHost, WebAccess, type WebPrincipal } from './access.js'
import { BLOCKED_WEB_PORTS, HttpError, json, readJson } from './http.js'
import { PendingRequests } from './pending.js'
import type { ToolContext, TurnMetrics } from '../core/types.js'
import type { TurnResult } from '../core/agent.js'
import { WeixinBridge, WeixinBridgeError, type WeixinSaved } from '../integrations/weixin.js'
import type { WeixinTransport } from '../integrations/weixin-client.js'
import { DEFAULT_UPDATES_URL, parseUpdateSettings, UpdateChecker, type UpdateInfo, type UpdateSettings } from '../updates.js'
import { buildExpertSummary, resolveExperts, spawnExperts } from '../experts.js'
import { WorkspaceMemoryError, WorkspaceMemoryStore, validateMemoryProcessing, WORKSPACE_MEMORY_MAX_CHARS, type WorkspaceMemoryService } from '../plugins/workspace-memory.js'
import type { MemoryProcessingService } from '../plugins/memory-processing.js'
import { activeMemoryContent, type MemoryEntryOperation } from '../plugins/memory-entries.js'
import { SakuraApiAccount, SakuraApiError, type SakuraApiSaved } from '../integrations/sakuraapi.js'
import { openSakuraApiPage, SAKURA_MODEL_BASE_URL, type SakuraOfficialPage, type SiteAuthorizationWindow } from '../integrations/sakuraapi-authorization.js'
import { PluginMarketplace } from './plugin-marketplace.js'
import { CHAT_FILE_LIMITS, parseChatFiles, parseChatImages, ChatAttachmentError, type ChatUploadFile, type StoredChatFiles } from '../core/attachments.js'
import { recordedTurnSummaries, teamMetrics } from '../util/turn-metrics.js'
import { parseDesktopViewport, type DesktopViewport } from '../util/viewport.js'

const VERSION = '1.1.0'

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
  'ui/turn/summary',
  'ui/stream/reset',
  'retry/status',
  'retry/finished',
  'ui/todos',
  'agent/spawned',
  'agent/status',
  'mcp/status',
  'compaction/done',
  'compaction/status',
] as const

/** Structural type for core-skills so this module doesn't import the plugin. */
interface SkillMetaLike {
  name: string
  description: string
  whenToUse?: string
  source: string
}

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
  /** Threshold edits wait for the launcher's disk-save acknowledgement. */
  onPersistContextBudget?: (settings: DesktopSettingsState) => Promise<void>
  /** Non-secret desktop display preferences, restored independently of the HTTP port. */
  appearance?: DesktopAppearance
  onPersistAppearance?: (settings: DesktopAppearance) => Promise<void>
  retry?: RetryPolicy
  onPersistRetry?: (settings: RetryPolicy) => Promise<void>
  /** Private launcher bridge; absent on ordinary Web servers. */
  onWindowAction?: (action: 'minimize' | 'maximize' | 'close' | 'drag' | 'reflow' | 'ready') => void
  /** Private desktop channel; credentials are never included in public snapshots. */
  weixin?: WeixinSaved
  onPersistWeixin?: (settings: WeixinSaved) => Promise<void>
  /** Account credentials stay on the private launcher pipe, never in state/SSE. */
  sakuraApi?: SakuraApiSaved
  onPersistSakuraApi?: (settings: SakuraApiSaved | null) => Promise<void>
  sakuraApiFetch?: typeof globalThis.fetch
  sakuraApiOpenLogin?: () => Promise<SiteAuthorizationWindow>
  sakuraApiOpenPage?: (page: SakuraOfficialPage) => Promise<void>
  /** Desktop product policy, supplied by its private host, never by HTTP/YAML. */
  sakuraApiOnly?: boolean
  /** Injected transport for offline integration tests or a compatible provider. */
  weixinTransport?: WeixinTransport
  /** Override the release URL the update check polls (tests use a local server). */
  updatesBaseUrl?: string
  /** Run background update checks; SAKURA_UPDATES_AUTO_CHECK=0 disables the default. */
  updatesAutoCheck?: boolean
  updatesFetch?: typeof globalThis.fetch
  /** Global update preferences, separate from workspace/model credentials. */
  updates?: UpdateSettings
  onPersistUpdates?: (settings: UpdateSettings) => Promise<void>
  /** Injected public-metadata transport; origin/scope remain fixed in product code. */
  pluginMarketplaceFetch?: typeof globalThis.fetch
  pluginMarketplaceTimeoutMs?: number
  updatesInitialDelayMs?: number
  updatesIntervalMs?: number
}

export interface WebServerHandle {
  server: Server
  port: number
  url: string
  /** The live harness — replaced whenever the desktop settings view switches the workspace. */
  harness: Harness
  updateDesktopViewport(viewport: DesktopViewport): void
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
  /** Global display preferences, not a workspace/model configuration. */
  appearance?: DesktopAppearance
  retry?: RetryPolicy
  updates?: UpdateSettings
}

/** Per-workspace prefs: where sessions live and which agents open with it. */
export interface WorkspacePrefs {
  /** Overrides <workspace>/.sakura/sessions; absolute or relative to the workspace. */
  sessionDir?: string
  /** Agent types (core-agent-defs) spawned when the workspace is mounted. */
  agents?: string[]
  /** Persisted desktop planning budget and independent auto-compaction triggers. */
  contextBudget?: ContextBudgetSettings
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
  /** Present for members of the built-in expert team (the preset key). */
  expert?: string
}

interface CollaborationWorkspace {
  path: string
  name: string
  active: boolean
  live: boolean
  running: number
  pending: number
  agents: AgentProjection[]
  todos: unknown[]
  sessions: Array<{
    id: string; title: string; updatedAt: string; size: number
    activity?: SessionActivity; agents: AgentProjection[]; status: string
  }>
  error?: string
}

export async function runWebServer(opts: WebServerOptions = {}): Promise<WebServerHandle> {
  let desktopViewport: DesktopViewport | null = null
  const web = opts.config?.web
  const access = new WebAccess({
    host: opts.host ?? web?.host ?? '127.0.0.1',
    token: opts.token === null ? undefined : opts.token ?? process.env[web?.tokenEnv ?? 'SAKURA_WEB_TOKEN'],
    viewerToken: opts.viewerToken === null ? undefined : opts.viewerToken ?? process.env[web?.viewerTokenEnv ?? 'SAKURA_WEB_VIEWER_TOKEN'],
    publicOrigin: opts.publicOrigin ?? web?.publicOrigin,
    sessionTtlMs: opts.authSessionTtlMs,
  })
  const host = access.host
  const sakuraApiOnly = opts.sakuraApiOnly === true
  if (sakuraApiOnly && access.remote) throw new Error('SakuraAPI desktop authorization requires a local workspace')
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
  let sessionEpoch = 0
  let deletingSession: string | null = null
  /** True while the whole harness is being remounted on a new workspace —
   *  in-flight requests then see 503 because their context is being dispose()d. */
  let switchingWorkspace = false
  let settingsUpdating = false
  let appearanceUpdating = false
  let appearance: DesktopAppearance = { quotaDisplay: parseQuotaDisplay(opts.appearance?.quotaDisplay ?? 'always') }
  let retryPolicy: RetryPolicy = validateRetryPolicy(opts.retry ?? { ...DEFAULT_RETRY_POLICY, ...resolveProfile(opts.config ?? {}).plugins['core-retry']?.config })
  let retryUpdating = false
  /** Bumped on every successful workspace remount; identifies stale client actions. */
  let workspaceEpoch = 0
  const workspaceId = (): string => `${startedAt}:${workspaceEpoch}`
  /** Current workspace; desktop mode can switch it at runtime. */
  let workspaceCwd = path.resolve(opts.cwd ?? process.cwd())
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

  function knownMemoryWorkspace(value: string): string {
    const targets = persistSettings ? dedupeWorkspaces([workspaceCwd, ...recentWorkspaces, ...workspacePrefs.keys()]) : [workspaceCwd]
    const target = targets.find(cwd => cwd === value || (process.platform === 'win32' && cwd.toLowerCase() === value.toLowerCase()))
    if (!target) throw new HttpError(404, '只允许访问已知工作区的记忆，请先在桌面中打开该工作区。')
    return target
  }

  async function memoryCatalog() {
    const targets = persistSettings ? dedupeWorkspaces([workspaceCwd, ...recentWorkspaces, ...workspacePrefs.keys()]) : [workspaceCwd]
    const workspaces = []
    for (const cwd of targets) {
      const active = cwd === workspaceCwd
      const store = active ? ctx.peek<WorkspaceMemoryService>('workspaceMemory') : new WorkspaceMemoryStore(cwd)
      if (!store) continue
      await store.reload()
      workspaces.push({ workspace: cwd, name: path.basename(cwd), active, path: path.join(cwd, '.sakura', 'workspace-memory.md'), ...store.status() })
    }
    return workspaces
  }

  async function mentionCandidates(): Promise<ResourceCandidate[]> {
    const rows: ResourceCandidate[] = []
    const add = (kind: ResourceReference['kind'], id: string, label: string, description: string): void => {
      rows.push({ kind, id, token: resourceToken(kind, id), label, description })
    }
    for (const skill of ctx.peek<SkillsService>('skills')?.list() ?? []) add('skill', skill.name, skill.name, skill.description)
    for (const session of await ctx.sessions.list()) if (!isExpertHistory(session)) add('session', session.id, session.title ?? session.id, `会话 · ${session.updatedAt ?? session.startedAt}`)
    for (const agent of ctx.agents.list().filter(agent => agent.meta.role !== 'main')) add('agent', agent.id, agent.name, agent.meta.description ?? agent.status)
    for (const def of ctx.peek<AgentDefsService>('agentDefs')?.list() ?? []) add('agent-type', def.name, def.name, def.description)
    if (!access.remote) for (const memory of await memoryCatalog()) if (memory.enabled && !memory.error) add('memory', memory.workspace, memory.name, `${memory.chars} 字长期记忆 · ${memory.workspace}`)
    return rows.slice(0, 1_024)
  }
  /** User-level overrides carried into every harness (re)mount. */
  const overrides: { model?: string; baseURL?: string; apiKey?: string } = {
    model: sakuraApiOnly ? undefined : opts.model,
    baseURL: sakuraApiOnly ? SAKURA_MODEL_BASE_URL : opts.baseURL,
    apiKey: sakuraApiOnly ? undefined : opts.apiKey,
  }
  const providerOverrides = new Map<string, { baseURL?: string; apiKey?: string }>()
  if (!sakuraApiOnly && (opts.baseURL !== undefined || opts.apiKey !== undefined)) {
    providerOverrides.set('default', { baseURL: opts.baseURL, apiKey: opts.apiKey })
  }
  let currentApiKey = sakuraApiOnly ? '' : opts.apiKey ?? ''
  let desktopRememberKey = !sakuraApiOnly && !!opts.desktopRememberKey
  /** The approval mode follows the user's live choice across workspace switches. */
  let liveApprovalMode = opts.approvalMode
  let contextCache: { key: string; breakdown: ContextBreakdown; contextRevision: number } | null = null
  /** Manual operations own a write gate until the summary/reset is committed. */
  let contextOperation: { action: 'compact' | 'clear' | 'edit' | 'rewind'; sessionId: string } | null = null
  /** Real per-session usage (provider-reported), memoized like contextCache. */
  let statsCache: { key: string; stats: SessionTokenStats } | null = null
  const persistSettings = opts.onPersistSettings
  /**
   * Collaborative expert session: when on, every user message is delivered to
   * the main agent and each live expert. Cleared on workspace remount.
   */
  let expertMode = false
  let expertEpoch = 0
  const expertIds = new Set<string>()
  const teamTurns = new Map<string, { mount: Harness['ctx']; epoch: number; mainId: string; sessionId?: string; userSeq?: number;
    pending: Set<string>; rows: TurnMetrics[]; members: Set<string>; initializing: boolean }>()
  /** Release feed for the settings "check for updates" card; failures land in `error`, never throw. */
  let updateSettings = parseUpdateSettings(opts.updates ?? { feedUrl: opts.updatesBaseUrl ?? process.env.SAKURA_UPDATES_URL ?? '', autoCheck: true })
  let updateChecker = new UpdateChecker(VERSION, updateSettings.feedUrl || DEFAULT_UPDATES_URL, { fetch: opts.updatesFetch })
  let updatesUpdating = false
  const pluginMarketplace = new PluginMarketplace({ fetch: opts.pluginMarketplaceFetch, timeoutMs: opts.pluginMarketplaceTimeoutMs })
  const autoUpdateCheck = (): boolean => opts.updatesAutoCheck ?? (process.env.SAKURA_UPDATES_AUTO_CHECK !== '0' && updateSettings.autoCheck)
  const updateInterval = Math.max(10, opts.updatesIntervalMs ?? 6 * 60 * 60 * 1000)
  const updateInitialDelay = Math.max(0, opts.updatesInitialDelayMs ?? 5_000)

  // ------------------------------------------------------------------
  // SSE fan-out
  // ------------------------------------------------------------------
  const clients = new Map<ServerResponse, WebPrincipal>()
  let revision = 0
  /** Set once close() begins; listeners must not touch the harness afterwards. */
  let closed = false
  const shutdownController = new AbortController()
  const sakuraAccount = access.remote ? undefined : new SakuraApiAccount({ saved: opts.sakuraApi,
    persist: opts.onPersistSakuraApi, fetch: opts.sakuraApiFetch, openLogin: opts.sakuraApiOpenLogin })
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

  let stateRefresh: Promise<void> | undefined
  let stateRefreshTimer: ReturnType<typeof setTimeout> | undefined
  let stateRefreshDelay = 25
  const refreshState = (): Promise<void> => {
    // Events already carry their own revision. With no listeners, a full disk
    // listing has no consumer; the next REST/SSE read builds a fresh snapshot.
    if (closed || !clients.size) return Promise.resolve()
    if (stateRefresh) return stateRefresh
    if (stateRefreshTimer !== undefined) return Promise.resolve()
    // Spawn/status/turn events commonly arrive together. A single snapshot
    // rechecks the final revision instead of parsing the same histories once
    // per event. Explicit REST reads remain independent (no deletion deadlock).
    let deliveredRevision = -1, changing = false
    const work = Promise.resolve().then(async () => {
      try {
        const state = await stateSnapshot()
        deliveredRevision = state.revision
        broadcast({ type: 'state', state })
      } catch (error) {
        changing = error instanceof HttpError && error.status === 503 && error.message.startsWith('state is changing')
      }
    }).finally(() => {
      if (stateRefresh === work) stateRefresh = undefined
      // If the bounded snapshot pass exhausted its revision retries (or an
      // event arrived after its final check), the last state still needs a
      // consumer. Retry with capped backoff, not another concurrent full scan
      // or a busy loop, and stop when there are no subscribers/shutdown begins.
      if (!closed && clients.size && (changing || deliveredRevision >= 0 && deliveredRevision < revision)) {
        stateRefreshTimer = setTimeout(() => {
          stateRefreshTimer = undefined
          void refreshState()
        }, stateRefreshDelay)
        stateRefreshTimer.unref()
        stateRefreshDelay = Math.min(1000, stateRefreshDelay * 2)
      } else stateRefreshDelay = 25
    })
    stateRefresh = work
    return work
  }

  let updateTimer: ReturnType<typeof setTimeout> | undefined
  let updateInFlight: Promise<UpdateInfo> | undefined
  function runUpdateCheck(): Promise<UpdateInfo> {
    if (updateInFlight) return updateInFlight
    updateInFlight = updateChecker.checkAndDetectChange().then(({ info, isNew }) => {
      if (!closed) broadcast({ type: 'update', update: info, notify: isNew })
      return info
    }).finally(() => { updateInFlight = undefined })
    return updateInFlight
  }
  function scheduleUpdateCheck(delay: number): void {
    updateTimer = setTimeout(() => {
      if (updatesUpdating) { if (!closed && autoUpdateCheck()) scheduleUpdateCheck(updateInterval); return }
      void runUpdateCheck().finally(() => {
        if (!closed && autoUpdateCheck()) scheduleUpdateCheck(updateInterval)
      })
    }, delay)
    updateTimer.unref()
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
    if (sakuraApiOnly) {
      llm.replaceAdapters(sakuraAccount!.adapter())
      return
    }
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
      if (!sakuraApiOnly && overrides.model && (overrides.baseURL !== undefined || overrides.apiKey !== undefined)) {
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

  /** Live expert handles (dead ids are pruned); the team dies with its session. */
  function liveExperts(): AgentHandle[] {
    const handles: AgentHandle[] = []
    for (const id of expertIds) {
      const handle = ctx.agents.get(id)
      if (handle) handles.push(handle)
    }
    if (handles.length !== expertIds.size) {
      expertEpoch++
      for (const id of [...expertIds]) if (!ctx.agents.get(id)) expertIds.delete(id)
      if (expertIds.size === 0) expertMode = false
    }
    return handles
  }

  function isExpertHistory(session: { id: string; expert?: string }): boolean {
    return !!session.expert || ctx.agents.list().some(agent => agent.meta.role === 'sub' && agent.meta.expert && sameSession(agent.sessionId, session.id))
  }

  function startExpertTeam(keys?: string[]): { started: string[]; reused: string[]; skipped: string[] } {
    const { spawned, reused, skipped } = spawnExperts(ctx.agents, keys)
    const members = [...spawned, ...reused]
    if (!members.length) throw new HttpError(409, 'expert names are occupied by other agents; no expert team was started')
    expertIds.clear()
    for (const handle of members) expertIds.add(handle.id)
    expertMode = true
    expertEpoch++
    return { started: spawned.map((handle) => handle.name), reused: reused.map((handle) => handle.name), skipped }
  }

  async function prepareUserTask(text: string): Promise<string> {
    const mount = ctx
    const epoch = sessionEpoch
    const cwdAtEntry = workspaceCwd
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.split(/\s+/)
      const hit = listSlashCommands(workspaceCwd).find((command) => command.name === (cmd ?? '').slice(1))
      if (!hit) throw new HttpError(400, `unknown command ${cmd}`)
      text = expandSlashCommand(hit.file, rest.join(' ')).prompt
    }
    const expanded = await expandResourceReferences(text, async ref => {
      if (ref.kind === 'skill') {
        const detail = ctx.peek<SkillsService>('skills')?.get(ref.id)
        if (!detail) throw new HttpError(400, '引用的 Skill 已不存在，请重新选择。')
        return { label: detail.meta.name, content: `Skill directory (resolve referenced files here): ${detail.meta.dir}\n\n${detail.body}` }
      }
      if (ref.kind === 'session') {
        if (!isSessionId(ref.id)) throw new HttpError(400, '会话引用无效。')
        const session = await ctx.sessions.open(ref.id)
        const lines = session.events.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
          .map(event => event.type === 'user/message' ? `用户：${event.payload.content}` : event.type === 'assistant/message' ? `助手：${event.payload.content ?? ''}` : '')
        let content = lines.join('\n\n')
        if (content.length > 24_000) content = '[较早记录已省略；此引用不是完整会话]\n' + content.slice(-24_000)
        return { label: `会话 ${ref.id}`, content }
      }
      if (ref.kind === 'memory') {
        if (access.remote) throw new HttpError(404, '跨工作区记忆只在本机可用。')
        const cwd = knownMemoryWorkspace(ref.id)
        const store = cwd === workspaceCwd ? ctx.peek<WorkspaceMemoryService>('workspaceMemory') : new WorkspaceMemoryStore(cwd)
        if (!store) throw new HttpError(404, '记忆服务不可用。')
        const snapshot = await store.reload()
        if (!snapshot.enabled || snapshot.error) throw new HttpError(409, '该工作区记忆已关闭或不可读，未加入本次请求。')
        return { label: `记忆 · ${path.basename(cwd)}`, content: activeMemoryContent(snapshot) || '(尚无已启用长期记忆)' }
      }
      if (ref.kind === 'agent-type') {
        const def = ctx.peek<AgentDefsService>('agentDefs')?.get(ref.id)
        if (!def) throw new HttpError(400, '引用的智能体类型已不存在。')
        return { label: `智能体类型 ${def.name}`, content: `用户明确选择 ${def.name} 参与当前任务。使用 subagent 工具并指定 agent=${JSON.stringify(def.name)} 进行委派；仍须遵循审批模式。\n职责：${def.description}` }
      }
      const agent = ctx.agents.get(ref.id) ?? ctx.agents.list().find(agent => agent.name === ref.id)
      if (!agent) throw new HttpError(400, '引用的智能体已不存在，请重新选择。')
      return { label: `智能体 ${agent.name}`, content: `用户明确选择现有智能体 ${agent.name}（id=${agent.id}）参与任务。使用 send_message 工具明确投递相关子任务；不要把提及当作已完成委派。仍须遵循审批模式。\n职责：${agent.meta.description ?? '(未说明)'}` }
    }).catch(error => { if (error instanceof HttpError) throw error; throw new HttpError(400, error instanceof Error ? error.message : '引用内容无法读取。') })
    // Only scan the original text for files: referenced Skill/history cannot request extra file reads.
    const expansion = expandMentions(text, { cwd: workspaceCwd })
    for (const miss of expansion.missing) {
      broadcast({ type: 'notice', level: 'info', message: `${miss.mention}: ${miss.reason}` })
    }
    if (mount !== ctx || epoch !== sessionEpoch || cwdAtEntry !== workspaceCwd) throw new HttpError(409, '会话或工作区已改变，引用未提交。')
    return expanded.text + expansion.text.slice(text.length)
  }

  function submitUserTask(text: string, images?: string[], preparedFiles?: ReadonlyMap<string, StoredChatFiles>, originalText?: string): boolean {
    const main = mainAgent()
    const mount = ctx, epoch = sessionEpoch
    const experts = expertMode ? liveExperts() : []
    const queued = main.status === 'running'
    let canonical: { sessionId: string; userSeq: number } | undefined
    let resolveUser!: (record: typeof canonical) => void
    const sharedUser = new Promise<typeof canonical>(resolve => { resolveUser = resolve })
    const turnGroup = experts.length ? randomUUID() : undefined
    if (turnGroup) teamTurns.set(turnGroup, { mount, epoch, mainId: main.id, pending: new Set(), rows: [], members: new Set(), initializing: true })
    const extras = (agent: AgentHandle) => ({ originalText, images, expertMode: experts.length > 0, turnGroup,
      preparedFiles: preparedFiles?.get(agent.id), ...(agent.id !== main.id ? { sharedUser } : {}) })
    const mainTurn = main.turn(text, { ...extras(main), ...(experts.length ? { teamSize: experts.length + 1 } : {}),
      onUserMessage: record => {
        canonical = record; resolveUser(record)
        const team = turnGroup && teamTurns.get(turnGroup)
        if (team) { team.sessionId = record.sessionId; team.userSeq = record.userSeq }
      } })
    void mainTurn
      .then((result) => {
        if (result.error) broadcast({ type: 'notice', level: 'error', message: result.error })
      })
      .catch((error: unknown) => {
        broadcast({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) })
      })
    void mainTurn.finally(() => resolveUser(canonical)).catch(() => {})
    if (experts.length) {
      for (const handle of experts) void handle.turn(text, extras(handle)).catch(() => {})
      teamTurns.get(turnGroup!)!.initializing = false
    }
    return queued
  }

  function bindHarness(next: Harness): void {
    contextCache = null
    statsCache = null
    // The roster is rebuilt on remount, so the expert team cannot survive one.
    expertMode = false
    expertIds.clear()
    teamTurns.clear()
    const previous: Harness | undefined = harness
    previous?.dispose()
    harness = next
    ctx = next.ctx
    ctx.on('agent/turn-queued', (payload: { turnGroup: string; turnId: string; agentId: string }) => {
      const team = teamTurns.get(payload.turnGroup)
      if (team) { team.pending.add(payload.turnId); team.members.add(payload.agentId) }
    })
    ctx.on('agent/turn-settled', (payload: { turnGroup: string; turnId: string; result: TurnResult }) => {
      const team = teamTurns.get(payload.turnGroup)
      if (!team || !team.pending.delete(payload.turnId)) return
      if (payload.result.metrics) team.rows.push(payload.result.metrics)
      if (team.initializing || team.pending.size) return
      team.mount.agents.releaseTurnGroup(payload.turnGroup)
      if (!team.sessionId || !team.userSeq || team.mount !== ctx || team.epoch !== sessionEpoch || closed || !team.rows.length) {
        teamTurns.delete(payload.turnGroup); return
      }
      const metrics = { ...teamMetrics(team.rows), members: team.members.size }
      void (async () => {
        const session = await team.mount.sessions.open(team.sessionId!)
        if (team.mount !== ctx || team.epoch !== sessionEpoch || closed) return
        await session.append({ type: 'session/note', payload: { note: 'turn-summary', userSeq: team.userSeq, metrics } })
        team.mount.emit('ui/turn/summary', { agentId: team.mainId, sessionId: session.id, userSeq: team.userSeq, metrics, main: true })
        void refreshState()
      })().catch(error => { if (!closed && team.mount === ctx) broadcast({ type: 'notice', level: 'error', message: '团队回合统计未保存：' + team.mount.llm.redactError(String(error)) }) })
        .finally(() => { if (teamTurns.get(payload.turnGroup) === team) teamTurns.delete(payload.turnGroup) })
    })
    ctx.peek<MemoryProcessingService>('memoryProcessing')?.setBusyChecker(() =>
      settingsUpdating || !!contextOperation || switching || switchingWorkspace || !!deletingSession || closed)
    ctx.peek<RetryService>('retry')?.configure(retryPolicy)
    ctx.peek<RetryService>('retry')?.setConfirmHandler(async request => {
      if (closed) return false
      return pendingRetries.wait({ type: 'retry/request', id: randomUUID(), agentId: request.agentId,
        sessionId: request.sessionId, error: request.error, retries: request.retries,
        elapsedMs: request.elapsedMs, windowMs: request.windowMs, maxRetries: request.maxRetries }, request.signal)
    })
    const savedBudget = prefsFor(workspaceCwd).contextBudget
    if (savedBudget) ctx.peek<CompactionService>('compaction')?.setContextBudget(savedBudget)
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
    ctx.on('ui/turn/start', () => void refreshState())
    ctx.on('ui/turn/end', () => void refreshState())
    ctx.on('compaction/done', () => void refreshState())
    ctx.on('compaction/status', () => void refreshState())
    ctx.on('workspace-memory/changed', () => {
      broadcast({ type: 'workspace-memory/changed', memory: ctx.peek<WorkspaceMemoryService>('workspaceMemory')?.status() })
      void refreshState()
    })
    ctx.on('mcp/status', () => void refreshState())
    ctx.on('memory-processing/status', () => void refreshState())
    ctx.on('memory-processing/done', () => void refreshState())
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
  const mainAgent = (): import('../core/index.js').AgentHandle => {
    const main = harness.main()
    applySelectedModel() // The initial lazy spawn also inherits the live model selection.
    return main
  }

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
    meta: { role?: string; description?: string; expert?: string }
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
    expert: a.meta.expert,
  })

  /**
   * Estimated context size of the main session, memoized by event count so
   * every state snapshot doesn't rebuild the whole transcript.
   */
  async function contextSnapshot(): Promise<{ breakdown: ContextBreakdown; contextRevision: number }> {
    const mount = ctx
    const epoch = workspaceEpoch
    const main = mainAgent()
    const sessionId = main.sessionId
    if (!isSessionId(sessionId)) return { breakdown: inspectContext([]), contextRevision: 0 }
    try {
      const session = await mount.sessions.open(sessionId)
      const system = mount.systemPrompt.assemble()
      const tools = mount.tools.schemas()
      const signature = createHash('sha256').update(system).update(JSON.stringify(tools)).digest('hex')
      const key = `${epoch}:${sessionId}:${session.events.length}:${signature}`
      if (contextCache?.key === key) return contextCache
      const messages = session.deriveMessages()
      if (messages[0]?.role === 'system') messages[0].content = system
      else messages.unshift({ role: 'system', content: system })
      const breakdown = inspectContext(messages, tools, session.events)
      const contextRevision = session.events.at(-1)?.seq ?? 0
      if (mount === ctx) contextCache = { key, breakdown, contextRevision }
      return { breakdown, contextRevision }
    } catch {
      return { breakdown: inspectContext([]), contextRevision: 0 }
    }
  }

  /**
   * Real provider-reported usage summed over the main session's log — the
   * input/output/cache totals the GUI footer shows next to the estimate.
   * Memoized by event count alongside contextTokens().
   */
  async function tokenStats(): Promise<SessionTokenStats> {
    const mount = ctx
    const epoch = workspaceEpoch
    const main = mainAgent()
    const sessionId = main.sessionId
    if (!isSessionId(sessionId)) return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    try {
      const session = await mount.sessions.open(sessionId)
      const key = `${epoch}:${sessionId}:${session.events.length}`
      if (statsCache?.key === key) return statsCache.stats
      const stats = summarizeUsage(session.events)
      if (mount === ctx) statsCache = { key, stats }
      return stats
    } catch {
      return { requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 }
    }
  }

  /**
   * Auto-compaction thresholds for the GUI's context meter; null when the
   * compaction plugin is not mounted (the meter then hides the threshold).
   */
  function contextBudget() {
    const compaction = ctx.peek<CompactionService>('compaction')
    if (!compaction) return null
    const window = compaction.contextWindowTokens || DEFAULT_CONTEXT_WINDOW_TOKENS
    return { autoThreshold: compaction.autoThreshold, autoTokensThreshold: compaction.autoTokensThreshold,
      contextWindowTokens: window, thresholdPercent: compaction.autoTokensThreshold * 100 / window,
      source: 'local' as const, persisted: !!persistSettings }
  }

  /** Dedicated summary model when set; the client shows it next to the model picker. */
  function compactionModel(): string | undefined {
    const compaction = ctx.peek<{ compactModel?: string }>('compaction')
    return compaction?.compactModel || undefined
  }

  async function stateSnapshot(attempt = 0) {
    const mount = ctx
    // A lazy initial spawn is itself a revisioned event. Do it before taking
    // the stamp, not halfway through an otherwise unchanged disk listing.
    mainAgent()
    const snapshotRevision = revision
    const snapshotWorkspace = workspaceId()
    const sessions = await mount.sessions.list()
    const context = await contextSnapshot()
    const stats = await tokenStats()
    if (closed) throw new HttpError(503, 'server is shutting down')
    const main = mainAgent()
    const experts = liveExperts()
    let historyGenerationReady = false
    if (isSessionId(main.sessionId)) {
      try {
        const session = await mount.sessions.open(main.sessionId)
        historyGenerationReady = session.events.at(-1)?.type === 'user/message' &&
          session.events.some(record => record.type === 'agent/meta' && record.payload.action === 'edit')
      } catch { /* a concurrent delete/remount is reconciled by the revision check */ }
    }
    // Never stamp an older disk listing with a newer revision (or workspace).
    // Otherwise an in-flight snapshot can resurrect a just-deleted session.
    if (mount !== ctx || snapshotWorkspace !== workspaceId() || snapshotRevision !== revision) {
      if (attempt >= 4) throw new HttpError(503, 'state is changing too quickly; retry in a moment')
      return stateSnapshot(attempt + 1)
    }
    const plugins = ctx.peek<{ list(): Array<{ name: string; description?: string; source: string }> }>('plugins')
    const skills = ctx.peek<{
      list(): Array<{ name: string; description?: string; whenToUse?: string; source: string }>
    }>('skills')
    const mcp = ctx.peek<McpLike>('mcp')
    return {
      version: VERSION,
      revision,
      server: { startedAt, remote: access.remote, authenticated: access.required },
      pendingRequests: [...pending.snapshot(), ...pendingQuestions.snapshot(), ...pendingPlans.snapshot(), ...pendingRetries.snapshot()],
      cwd: workspaceCwd,
      workspaceId: snapshotWorkspace,
      /** Desktop mode: the settings view and workspace switching are mounted; absent on remote servers. */
      desktop: persistSettings && !access.remote ? currentDesktopState() : undefined,
      desktopWindow: !!opts.onWindowAction && !access.remote,
      desktopViewport: !access.remote ? desktopViewport : null,
      sakuraApiOnly,
      workspaceMemory: ctx.peek<WorkspaceMemoryService>('workspaceMemory')?.status(),
      memoryProcessing: ctx.peek<MemoryProcessingService>('memoryProcessing')?.status(),
      retryPolicy: { ...retryPolicy },
      retries: ctx.peek<RetryService>('retry')?.status() ?? [],
      weixin: weixin?.status(),
      model: main.model || 'default',
      models: ctx.llm.listModels(),
      providers: ctx.llm.listProviders(),
      modelStatus: ctx.llm.modelStatus(),
      thinking: ctx.llm.thinking,
      approvalMode: ctx.approval.mode as ApprovalMode,
      busy: main.status === 'running',
      sessionId: isSessionId(main.sessionId) ? main.sessionId : null,
      contextTokens: context.breakdown.totalTokens,
      contextBreakdown: context.breakdown,
      contextRevision: context.contextRevision,
      contextCompacting: ctx.peek<CompactionService>('compaction')?.isCompacting(main.sessionId) ?? false,
      contextOperation,
      historyGenerationReady,
      /** Real provider-reported usage for the main session (empty before the first answer). */
      tokenStats: stats,
      contextBudget: contextBudget(),
      /** Present only when the compaction plugin is mounted; a value is a dedicated summary model. */
      compactModel: compactionModel(),
      /** Cached update-check result; absent until the first check completes. */
      update: updateChecker.cached(),
      updateSettings: !access.remote ? { ...updateSettings } : undefined,
      updateAutomatic: autoUpdateCheck(),
      /** Collaborative expert session: user messages also go to the expert team. */
      expertMode,
      attachmentLimits: CHAT_FILE_LIMITS,
      expertIds: experts.map((agent) => agent.id),
      expertSummaryAvailable: experts.some((agent) => agent.status === 'done' && !!agent.result?.trim()),
      /** Mounted skills (.sakura/skills + user dir + extra dirs), absent without core-skills. */
      skills: skills?.list().map((s) => ({ name: s.name, description: s.description ?? '', whenToUse: s.whenToUse ?? '', source: s.source })) ?? [],
      sessions: sessions.filter(s => !isExpertHistory(s)).map((s) => {
        const members = ctx.agents.list().filter(agent => sameSession(agent.sessionId, s.id) ||
          sameSession(main.sessionId, s.id) && agent.meta.role === 'sub' && !!agent.meta.expert)
        const waiting = [...pending.snapshot(), ...pendingQuestions.snapshot(), ...pendingPlans.snapshot(), ...pendingRetries.snapshot()]
          .some(request => members.some(agent => agent.id === request.agentId))
        return { id: s.id, title: s.title ?? s.id, updatedAt: s.updatedAt ?? s.startedAt, size: s.events,
          activity: s.activity, status: waiting ? 'waiting' : members.some(agent => agent.status === 'running') ? 'running' : s.activity?.status ?? 'empty',
          deleteBlocked: sessionDeletionBlock(s.id) }
      }),
      expertSessions: sessions.filter(isExpertHistory).map(s => ({ id: s.id, title: s.title ?? s.id,
        expert: s.expert, updatedAt: s.updatedAt ?? s.startedAt, activity: s.activity })),
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
  const pendingRetries = new PendingRequests<boolean>(broadcast, 'retry/resolved', 'allow', false, 10 * 60_000)

  // ------------------------------------------------------------------
  // Session switching: the roster is cleared (subagents included) and a
  // fresh main agent adopts the target session.
  // ------------------------------------------------------------------
  function assertAgentsIdle(): void {
    if (ctx.peek<MemoryProcessingService>('memoryProcessing')?.status().active) throw new HttpError(409, '长期记忆正在整理，请等待完成。')
    if (teamTurns.size) throw new HttpError(409, '专家协作回合正在收尾，请等待统计保存完成。')
    if (ctx.agents.hasPendingTurns() || ctx.agents.list().some((agent) => agent.status === 'running')) {
      throw new HttpError(409, 'agents are running; interrupt them or wait before switching sessions')
    }
  }

  async function switchSession(id?: string, title?: string): Promise<string> {
    if (id !== undefined && !isSessionId(id)) {
      throw new HttpError(400, 'invalid session id')
    }
    if (settingsUpdating || deletingSession || contextOperation) throw new HttpError(409, 'a settings or context change is in progress; retry after it completes')
    if (switchingWorkspace) throw new HttpError(503, 'a workspace switch is in progress; retry')
    if (switching) throw new HttpError(409, 'a session switch is already in progress; retry after it completes')
    assertAgentsIdle()
    switching = true
    try {
      const target = id ? await ctx.sessions.open(id) : await ctx.sessions.create(title ? { title } : undefined)
      if (target.archived) throw new HttpError(409, '此对话已归档，请先在设置中恢复。')
      const sessionId = target.id
      if (closed) throw new HttpError(503, 'server is shutting down')
      // Disk I/O yielded: another device may have started work in the meantime.
      // Never dispose its active agent just because this request arrived first.
      assertAgentsIdle()
      pending.cancel()
      pendingQuestions.cancel()
      pendingPlans.cancel()
      pendingRetries.cancel()
      ctx.agents.disposeAll()
      sessionEpoch++
      // The expert team lived in the old session's roster; switching ends it.
      expertMode = false
      expertIds.clear()
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
    if (current && (pending.snapshot().length || pendingQuestions.snapshot().length || pendingPlans.snapshot().length || pendingRetries.snapshot().length)) return 'pending'
    return null
  }

  async function deleteSession(id: string) {
    if (settingsUpdating || switching || deletingSession || contextOperation) throw new HttpError(409, 'a settings or context change is in progress; retry after it completes')
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
        pendingRetries.cancel()
        mount.agents.disposeAll()
        sessionEpoch++
        expertMode = false
        expertIds.clear()
        mount.approval.engine.clearSessionAllows()
        const todos = mount.peek<{ todos: unknown[] }>('todos')
        if (todos) todos.todos = []
        harness.main() // New blank conversation; no directory until the next turn.
        applySelectedModel()
        contextCache = null
        statsCache = null
      }
      const sessionId = isSessionId(mainAgent().sessionId) ? mainAgent().sessionId : null
      const result = { deletedId: id, sessionId, workspaceId: workspaceId() }
      broadcast({ type: 'session/deleted', ...result })
      const deletedRevision = revision
      await refreshState()
      return { ok: true, ...result, revision: deletedRevision }
    } finally {
      deletingSession = null
    }
  }

  async function archiveSession(id: string, archived: boolean) {
    if (settingsUpdating || switching || deletingSession || contextOperation) throw new HttpError(409, '会话或设置正在变更，请稍后重试。')
    if (switchingWorkspace) throw new HttpError(503, '工作区正在切换，请稍后重试。')
    const mount = ctx, epoch = workspaceEpoch
    const assertIdle = (): void => {
      if (closed || mount !== ctx || epoch !== workspaceEpoch || switchingWorkspace) throw new HttpError(503, '工作区已改变，请刷新后重试。')
      if (ctx.peek<MemoryProcessingService>('memoryProcessing')?.status().active) throw new HttpError(409, '请等待长期记忆整理完成。')
      const reason = sessionDeletionBlock(id)
      if (reason) throw new HttpError(409, `此对话正在使用 (${reason})，请先结束相关任务或确认。`)
    }
    deletingSession = 'archive'
    try {
      assertIdle()
      await mount.sessions.setArchived(id, archived, assertIdle)
      const current = archived && sameSession(mainAgent().sessionId, id)
      if (current) {
        pending.cancel(); pendingQuestions.cancel(); pendingPlans.cancel(); pendingRetries.cancel()
        mount.agents.disposeAll()
        sessionEpoch++
        expertMode = false; expertIds.clear()
        mount.approval.engine.clearSessionAllows()
        const todos = mount.peek<{ todos: unknown[] }>('todos')
        if (todos) todos.todos = []
        harness.main(); applySelectedModel()
        contextCache = null; statsCache = null
      }
      const sessionId = isSessionId(mainAgent().sessionId) ? mainAgent().sessionId : null
      const result = { id, archived, sessionId, workspaceId: workspaceId() }
      broadcast({ type: 'session/archived', ...result })
      const archiveRevision = revision
      await refreshState()
      return { ok: true, ...result, revision: archiveRevision }
    } finally { deletingSession = null }
  }

  /** One write gate for the entire batch. Preflight every target before removal;
   * disk failures are reported explicitly instead of pretending the batch was atomic. */
  async function deleteSessions(ids: string[]) {
    if (settingsUpdating || switching || deletingSession || contextOperation) throw new HttpError(409, 'a settings or context change is in progress; retry after it completes')
    if (switchingWorkspace) throw new HttpError(503, 'a workspace switch is in progress; retry')
    const mount = ctx
    const epoch = workspaceEpoch
    const assertDeletable = (): void => {
      if (closed || mount !== ctx || epoch !== workspaceEpoch || switchingWorkspace) throw new HttpError(503, 'the workspace is changing or shutting down; retry')
      for (const id of ids) {
        const reason = sessionDeletionBlock(id)
        if (reason) throw new HttpError(409, `session "${id}" cannot be deleted (${reason}); resolve it before deleting this selection`)
      }
    }
    deletingSession = 'batch'
    const deletedIds: string[] = []
    const failed: Array<{ id: string; error: string }> = []
    try {
      assertDeletable()
      for (const id of ids) await mount.sessions.validateDeletion(id)
      assertDeletable()
      for (const id of ids) {
        try {
          await mount.sessions.delete(id, assertDeletable)
          deletedIds.push(id)
        } catch (error) {
          failed.push({ id, error: error instanceof SessionError ? error.message : '无法删除会话目录，请检查权限或文件占用。' })
        }
      }
      if (closed || mount !== ctx || epoch !== workspaceEpoch) throw new HttpError(503, 'workspace is shutting down or changed; refresh before retrying')
      if (deletedIds.some(id => sameSession(mainAgent().sessionId, id))) {
        pending.cancel(); pendingQuestions.cancel(); pendingPlans.cancel(); pendingRetries.cancel()
        mount.agents.disposeAll()
        sessionEpoch++
        expertMode = false
        expertIds.clear()
        mount.approval.engine.clearSessionAllows()
        const todos = mount.peek<{ todos: unknown[] }>('todos')
        if (todos) todos.todos = []
        harness.main()
        applySelectedModel()
        contextCache = null
        statsCache = null
      }
      const sessionId = isSessionId(mainAgent().sessionId) ? mainAgent().sessionId : null
      for (const deletedId of deletedIds) broadcast({ type: 'session/deleted', deletedId, sessionId, workspaceId: workspaceId() })
      const result = { ok: failed.length === 0, deletedIds, failed, sessionId, workspaceId: workspaceId(), revision }
      await refreshState()
      return result
    } finally { deletingSession = null }
  }

  /** Read unopened workspaces without mounting plugins, starting agents or changing
   * the current session. Only the current harness has a truthful live status. */
  async function collaborationSnapshot(attempt = 0): Promise<{
    workspaceId: string; revision: number; updatedAt: string; workspaces: CollaborationWorkspace[]
  }> {
    const mount = ctx
    const epoch = workspaceEpoch
    const snapshotRevision = revision
    const paths = persistSettings ? [...recentWorkspaces] : [workspaceCwd]
    const workspaces: CollaborationWorkspace[] = []
    for (const cwd of paths) {
      const active = cwd === workspaceCwd
      try {
        if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory')
        let service = mount.sessions
        if (!active) {
          const config = await loadConfig({ cwd })
          const configured = resolveProfile(config).plugins['core-session']?.config?.dir
          const directory = prefsFor(cwd).sessionDir || opts.sessionDir || (typeof configured === 'string' ? configured : '.sakura/sessions')
          service = new SessionService(path.resolve(cwd, directory))
        }
        const sessions = await service.list()
        const agents = active ? mount.agents.list().map(projectAgent) : []
        const requests = active ? [...pending.snapshot(), ...pendingQuestions.snapshot(), ...pendingPlans.snapshot(), ...pendingRetries.snapshot()] : []
        workspaces.push({ path: cwd, name: path.basename(cwd) || cwd, active, live: active,
          running: agents.filter(a => a.status === 'running').length, pending: requests.length,
          agents, todos: active ? mount.peek<{ todos: unknown[] }>('todos')?.todos ?? [] : [],
          sessions: sessions.filter(s => !s.expert && (!active || !isExpertHistory(s))).map(s => ({ id: s.id, title: s.title ?? s.id, updatedAt: s.updatedAt ?? s.startedAt,
            size: s.events, activity: s.activity, agents: agents.filter(a => sameSession(a.sessionId, s.id)),
            status: requests.some(r => agents.some(a => a.id === r.agentId && sameSession(a.sessionId, s.id))) ? 'waiting'
              : agents.find(a => sameSession(a.sessionId, s.id) && a.status === 'running') ? 'running'
                : agents.find(a => sameSession(a.sessionId, s.id))?.status ?? s.activity?.status ?? 'empty' })),
        })
      } catch {
        workspaces.push({ path: cwd, name: path.basename(cwd) || cwd, active, live: active,
          running: 0, pending: 0, agents: [], todos: [], sessions: [], error: '工作区目录或会话记录无法读取。' })
      }
    }
    if (closed || mount !== ctx || epoch !== workspaceEpoch) throw new HttpError(503, 'workspace changed; refresh collaboration')
    if (snapshotRevision !== revision) {
      if (attempt >= 4) throw new HttpError(503, 'collaboration is changing too quickly; retry in a moment')
      return collaborationSnapshot(attempt + 1)
    }
    return { workspaceId: workspaceId(), revision, updatedAt: new Date().toISOString(), workspaces }
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
      model: sakuraApiOnly ? sakuraAccount?.status().model ?? '' : overrides.model ?? '',
      rememberKey: desktopRememberKey,
      hasApiKey: sakuraApiOnly ? sakuraAccount?.status().phase === 'connected' : Boolean(currentApiKey),
      newWorkspaceDir,
      sessionDir: prefs.sessionDir ?? '',
      agents: prefs.agents ?? [],
      appearance: { ...appearance },
      retry: { ...retryPolicy },
      updates: { ...updateSettings },
      ...(full ? { workspacePrefs: Object.fromEntries(workspacePrefs), ...(desktopRememberKey ? { apiKey: currentApiKey } : {}) } : {}),
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
    if (settingsUpdating || switching || deletingSession || switchingWorkspace || contextOperation) {
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
      // Stage preferences for the candidate mount and persistence frame.
      // A rejected disk write must not leak a new directory into the live
      // state or a later workspace switch, even without a harness remount.
      const targetPrefs: WorkspacePrefs = { ...workspacePrefs.get(path.resolve(target)) }
      if (patch.sessionDir !== undefined) targetPrefs.sessionDir = patch.sessionDir || undefined
      if (patch.agents !== undefined) targetPrefs.agents = patch.agents?.length ? [...new Set(patch.agents)] : undefined
      const nextNewWorkspaceDir = patch.newWorkspaceDir === undefined ? newWorkspaceDir : patch.newWorkspaceDir || ''
      const nextWorkspacePrefs = new Map(workspacePrefs)
      nextWorkspacePrefs.set(path.resolve(target), targetPrefs)
      if (needsRemount) {
        let config: SakuraConfig
        try { config = await loadConfig({ cwd: target }) }
        catch { throw new HttpError(400, 'cannot load the target workspace configuration') }
        liveApprovalMode = ctx.approval.mode
        candidate = await createWorkspaceHarness(target, config, targetPrefs)
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
        newWorkspaceDir: nextNewWorkspaceDir,
        sessionDir: targetPrefs.sessionDir ?? '',
        agents: targetPrefs.agents ?? [],
        appearance: { ...appearance },
        retry: { ...retryPolicy },
        updates: { ...updateSettings },
        workspacePrefs: Object.fromEntries(nextWorkspacePrefs),
      }
      try { await persistSettings?.(persisted) }
      catch { throw new HttpError(500, 'cannot persist desktop settings; previous configuration is unchanged') }
      if (closed) throw new HttpError(503, 'server is shutting down')
      workspacePrefs.set(path.resolve(target), targetPrefs)
      newWorkspaceDir = nextNewWorkspaceDir
      if (candidate) {
        switchingWorkspace = true
        pending.cancel()
        pendingQuestions.cancel()
        pendingPlans.cancel()
        pendingRetries.cancel()
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

  const vipAssets = new Map<string, Buffer>()
  async function getVipAsset(name: string): Promise<Buffer> {
    const cached = vipAssets.get(name)
    if (cached) return cached
    try {
      // @ts-expect-error virtual module — embedded by the existing SEA builder
      const mod = await import('sakura-web-vip-embed') as { default?: Record<string, string> }
      const encoded = mod.default?.[name]
      if (typeof encoded === 'string') { const image = Buffer.from(encoded, 'base64'); vipAssets.set(name, image); return image }
    } catch { /* Node/dev builds serve only the fixed, bundled PNG files. */ }
    return readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'vip', name))
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
        : error instanceof CheckpointError ? ({ EINVAL: 400, ECONFLICT: 409, EIO: 500 } as const)[error.code]
        : error instanceof WorkspaceMemoryError
          ? ({ EINVAL: 400, ECONFLICT: 409, EBUSY: 409, EDISABLED: 409, ECLOSED: 503, EIO: 500 } as const)[error.code]
        : error instanceof SkillImportError ? error.status : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 404 : 500
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

    const vipAsset = pathname.match(/^\/assets\/vip\/(vip-(?:[1-9]|10)\.png)$/)
    if (vipAsset && method === 'GET') {
      const image = await getVipAsset(vipAsset[1]!)
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'public, max-age=86400' })
      res.end(image)
      return
    }

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
    const checkingUpdate = pathname === '/api/updates/check' && method === 'POST'
    if (principal.role === 'viewer' && method !== 'GET' && method !== 'HEAD' && !checkingUpdate) {
      throw new HttpError(403, 'read-only viewer cannot modify the workspace')
    }
    // Display preferences do not touch the harness or credentials. They remain
    // editable during a turn, but only a local operator can persist desktop data.
    if (pathname === '/api/desktop/appearance' && (method === 'GET' || method === 'POST')) {
      if (!persistSettings || access.remote || principal.role !== 'operator') {
        throw new HttpError(404, 'desktop appearance is available only to a local operator')
      }
      if (method === 'GET') { json(res, 200, { ...appearance }); return }
      const body = await bodyJson(req, 4096)
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (Object.keys(body).some(key => key !== 'quotaDisplay')) throw new HttpError(400, 'invalid desktop appearance fields')
      let candidate: DesktopAppearance
      try { candidate = { quotaDisplay: parseQuotaDisplay(body.quotaDisplay) } }
      catch (error) { throw new HttpError(400, (error as Error).message) }
      if (appearanceUpdating) throw new HttpError(409, '正在保存显示方式，请等待完成。')
      if (closed) throw new HttpError(503, 'server is shutting down')
      appearanceUpdating = true
      try {
        try {
          if (opts.onPersistAppearance) await opts.onPersistAppearance(candidate)
          else await persistSettings({ ...currentDesktopState(true), appearance: candidate })
        } catch { throw new HttpError(500, '无法保存额度显示方式，原设置未改变。') }
        if (closed) throw new HttpError(503, 'server is shutting down')
        appearance = candidate
        revision++
        await refreshState()
        json(res, 200, { ...appearance })
      } finally { appearanceUpdating = false }
      return
    }
    if (pathname === '/api/updates/settings' && (method === 'GET' || method === 'POST')) {
      if (access.remote || principal.role !== 'operator') throw new HttpError(404, '更新源设置仅供本机操作员使用。')
      if (method === 'GET') { json(res, 200, { ...updateSettings }); return }
      const body = await bodyJson(req, 4096)
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      let candidate: UpdateSettings
      try { candidate = parseUpdateSettings(body) } catch (error) { throw new HttpError(400, (error as Error).message) }
      if (updatesUpdating || updateInFlight) throw new HttpError(409, '更新检查或保存正在进行，请稍后重试。')
      if (closed) throw new HttpError(503, 'server is shutting down')
      updatesUpdating = true
      try {
        try {
          if (opts.onPersistUpdates) await opts.onPersistUpdates(candidate)
          else if (persistSettings) await persistSettings({ ...currentDesktopState(true), updates: candidate })
        } catch { throw new HttpError(500, '无法保存更新设置，原更新源与结果保持不变。') }
        if (closed) throw new HttpError(503, 'server is shutting down')
        if (candidate.feedUrl !== updateSettings.feedUrl) {
          updateChecker.close()
          updateChecker = new UpdateChecker(VERSION, candidate.feedUrl || DEFAULT_UPDATES_URL, { fetch: opts.updatesFetch })
        }
        updateSettings = candidate
        if (updateTimer !== undefined) clearTimeout(updateTimer)
        if (autoUpdateCheck()) scheduleUpdateCheck(updateInitialDelay)
        revision++
        await refreshState()
        json(res, 200, { ...updateSettings })
      } finally { updatesUpdating = false }
      return
    }
    if (checkingUpdate) {
      await bodyJson(req, 4096)
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (updatesUpdating) throw new HttpError(409, '正在保存更新设置，请稍后重试。')
      const info = await runUpdateCheck()
      json(res, 200, info)
      return
    }
    if (pathname === '/api/desktop/window' && method === 'POST') {
      if (!opts.onWindowAction || access.remote || principal.role !== 'operator') {
        throw new HttpError(404, 'window controls are available only in the local desktop app')
      }
      const body = await bodyJson(req, 1024)
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (typeof body.action !== 'string' || !['minimize', 'maximize', 'close', 'drag', 'reflow', 'ready'].includes(body.action)) throw new HttpError(400, 'invalid window action')
      // Window controls are app-scoped, not workspace/session-scoped. Keep
      // them before write locks so users can close during a save or switch.
      opts.onWindowAction(body.action as 'minimize' | 'maximize' | 'close' | 'drag' | 'reflow' | 'ready')
      json(res, 200, { ok: true })
      return
    }

    // Account access is app-scoped and local-operator only, not shared with remote viewers.
    if (pathname === '/api/account/sakura' && method === 'GET') {
      if (!sakuraAccount || principal.role !== 'operator') throw new HttpError(404, 'SakuraAPI account is available only to a local operator')
      json(res, 200, { ...sakuraAccount.status(), secureStorage: !!opts.onPersistSakuraApi, exclusiveUpstream: sakuraApiOnly })
      return
    }
    const accountAction = pathname.match(/^\/api\/account\/sakura\/(login|poll|retry|cancel|refresh|logout|remember|page|keys|key-select|key-prepare|key-create|key-cancel|activity)$/)
    if (accountAction && method === 'POST') {
      if (!sakuraAccount || principal.role !== 'operator') throw new HttpError(404, 'SakuraAPI account is available only to a local operator')
      const body = await bodyJson(req, 4096)
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      const action = accountAction[1]
      if (action === 'activity') {
        if (settingsUpdating || switchingWorkspace) throw new HttpError(409, '账号或工作区正在变更。')
        try { await sakuraAccount.foregroundActivity() }
        catch (error) {
          if (sakuraApiOnly && sakuraAccount.status().phase === 'expired') { ctx.llm.replaceAdapters(sakuraAccount.adapter()); await refreshState() }
          throw new HttpError(error instanceof SakuraApiError && error.status === 401 ? 409 : 502, error instanceof SakuraApiError ? error.message : '账号活跃上报失败。')
        }
        json(res, 200, { ...sakuraAccount.status(), secureStorage: !!opts.onPersistSakuraApi, exclusiveUpstream: sakuraApiOnly })
        return
      }
      if (action === 'page') {
        if (!['purchase', 'keys', 'profile'].includes(String(body.page))) throw new HttpError(400, 'invalid SakuraAPI official page')
        try { await (opts.sakuraApiOpenPage ?? openSakuraApiPage)(body.page as SakuraOfficialPage) }
        catch { throw new HttpError(502, '无法打开官网页面，请检查系统默认浏览器。') }
        json(res, 200, { opened: true })
        return
      }
      if (settingsUpdating || switchingWorkspace || deletingSession || switching || contextOperation) throw new HttpError(409, '工作区正在变更，请稍后处理授权。')
      // Refresh/poll can update the live model catalog and logout removes its
      // credential. No task may start during either network/storage operation.
      assertAgentsIdle()
      if (ctx.agents.list().some(agent => ctx.peek<{ isCompacting(id: string): boolean }>('compaction')?.isCompacting(agent.sessionId))) {
        throw new HttpError(409, '上下文压缩正在运行，请稍后处理授权。')
      }
      settingsUpdating = true
      try {
        let state
        if (action === 'login') {
          if (body.remember !== undefined && typeof body.remember !== 'boolean') throw new HttpError(400, 'remember must be boolean')
          state = await sakuraAccount.beginLogin(body.remember)
        } else if (action === 'remember') {
          if (typeof body.remember !== 'boolean') throw new HttpError(400, 'remember must be boolean')
          state = await sakuraAccount.setRemember(body.remember)
        } else if (action === 'poll' || action === 'retry') {
          if (typeof body.id !== 'string' || body.id.length > 100) throw new HttpError(400, 'invalid authorization operation')
          state = await sakuraAccount.pollLogin(body.id, action === 'retry')
        } else if (action === 'keys') state = await sakuraAccount.keyPage(body.page as number)
        else if (action === 'key-select') state = await sakuraAccount.selectKey(body.id as number)
        else if (action === 'key-prepare') {
          if (typeof body.name !== 'string' || !Array.isArray(body.groupIds)) throw new HttpError(400, '请输入 Key 名称并选择分组。')
          json(res, 200, sakuraAccount.prepareKey(body.name, body.groupIds as number[]))
          return
        } else if (action === 'key-create' || action === 'key-cancel') {
          if (typeof body.id !== 'string' || body.id.length > 100) throw new HttpError(400, 'invalid Key creation operation')
          if (action === 'key-create') {
            if (body.confirmed !== true) throw new HttpError(400, '创建 Key 需要明确确认。')
            state = await sakuraAccount.createKey(body.id)
          } else { sakuraAccount.cancelKeyCreation(body.id); state = sakuraAccount.status() }
        } else if (action === 'cancel') state = await sakuraAccount.cancelLogin()
        else if (action === 'refresh') state = await sakuraAccount.refresh()
        else state = await sakuraAccount.logout()
        if (sakuraApiOnly) {
          ctx.llm.replaceAdapters(sakuraAccount.adapter())
          overrides.model = state.model
          applySelectedModel()
        }
        settingsUpdating = false
        if (sakuraApiOnly && ['connected', 'expired', 'signed-out'].includes(state.phase)) await refreshState()
        json(res, 200, { ...state, secureStorage: !!opts.onPersistSakuraApi, exclusiveUpstream: sakuraApiOnly })
      } catch (error) {
        if (sakuraApiOnly && sakuraAccount.status().phase === 'expired') {
          ctx.llm.replaceAdapters(sakuraAccount.adapter())
          settingsUpdating = false
          await refreshState()
        }
        if (error instanceof SakuraApiError) throw new HttpError(error.status === 401 ? 409 : error.status, error.message)
        throw error
      } finally { settingsUpdating = false }
      return
    }
    // Requests that started on an older workspace must not act on the new one
    // after an await: 503 makes the client retry against the current mount.
    const workspaceEpochAtEntry = workspaceEpoch
    const sessionEpochAtEntry = sessionEpoch
    const assertWorkspaceSame = (): void => {
      if (settingsUpdating) throw new HttpError(409, 'settings are being saved; retry after completion')
      if (ctx.peek<MemoryProcessingService>('memoryProcessing')?.status().active && method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(409, '长期记忆正在整理，请等待完成后再提交任务或修改设置。')
      }
      if (workspaceEpochAtEntry !== workspaceEpoch || switchingWorkspace) {
        throw new HttpError(503, 'the workspace switched while this request was in flight; retry')
      }
      if (req.headers['x-sakura-workspace'] !== undefined && req.headers['x-sakura-workspace'] !== workspaceId()) {
        throw new HttpError(409, 'the workspace changed; refresh before retrying this operation')
      }
      if (deletingSession && method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(409, 'a session deletion is in progress; retry after it completes')
      }
      if (contextOperation && method !== 'GET' && method !== 'HEAD') {
        throw new HttpError(409, '上下文正在压缩或清空，请等待完成后再操作。')
      }
    }

    const assertSessionSame = (): void => {
      assertWorkspaceSame()
      if (closed) throw new HttpError(503, 'server is shutting down')
      if (switching || sessionEpochAtEntry !== sessionEpoch) {
        throw new HttpError(409, 'the session changed while this request was in flight; retry in the current session')
      }
    }

    const assertExpertTarget = (body: Record<string, unknown>): void => {
      assertSessionSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      const sessionId = isSessionId(mainAgent().sessionId) ? mainAgent().sessionId : null
      if (body.sessionId !== undefined && body.sessionId !== sessionId) {
        throw new HttpError(409, '会话已改变，专家操作未提交，请在当前会话确认后重试。')
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

    if (pathname === '/api/plugins/marketplace' && method === 'GET') {
      // The authenticated local operator opts into public network search.
      // Remote viewers/operators cannot cause requests from the host network.
      if (access.remote || principal.role !== 'operator') throw new HttpError(404, '插件市场搜索仅对本机操作员开放。')
      const result = await pluginMarketplace.search(url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? 1))
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      json(res, 200, result)
      return
    }

    if (pathname === '/api/skills/reload' && method === 'POST') {
      if (access.remote) throw new HttpError(404, 'Skill 刷新仅对本机操作员开放。')
      await bodyJson(req, 4096)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      ctx.peek<SkillsService>('skills')?.reload()
      await refreshState()
      json(res, 200, await stateSnapshot())
      return
    }

    if (pathname === '/api/retry/settings' && (method === 'GET' || method === 'POST')) {
      if (method === 'GET') { json(res, 200, { ...retryPolicy }); return }
      const body = await bodyJson(req, 4096)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      let candidate: RetryPolicy
      try { candidate = validateRetryPolicy(body) } catch (error) { throw new HttpError(400, (error as Error).message) }
      if (retryUpdating) throw new HttpError(409, '正在保存重试策略，请稍后。')
      retryUpdating = true
      try {
        if (!access.remote && persistSettings) {
          try {
            if (opts.onPersistRetry) await opts.onPersistRetry(candidate)
            else await persistSettings({ ...currentDesktopState(true), retry: candidate })
          } catch { throw new HttpError(500, '重试策略保存失败，原策略未改变。') }
        }
        if (closed) throw new HttpError(503, 'server is shutting down')
        retryPolicy = candidate
        ctx.peek<RetryService>('retry')?.configure(candidate)
        await refreshState()
        json(res, 200, { ...retryPolicy })
      } finally { retryUpdating = false }
      return
    }

    const retryMatch = pathname.match(/^\/api\/retries\/([\w-]+)$/)
    if (retryMatch && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertSessionSame()
      if (typeof body.allow !== 'boolean') throw new HttpError(400, 'allow must be boolean')
      if (!pendingRetries.resolve(retryMatch[1]!, body.allow)) throw new HttpError(404, 'unknown or already-resolved retry confirmation')
      json(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/mentions' && method === 'GET') {
      const candidates = await mentionCandidates()
      assertSessionSame()
      json(res, 200, { workspaceId: workspaceId(), candidates })
      return
    }

    if (pathname === '/api/skills/import' && method === 'POST') {
      if (access.remote) throw new HttpError(404, 'Skill import is available only on a local workspace')
      const body = await bodyJson(req, SKILL_IMPORT_MAX_BYTES * 6 + 8192)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      assertAgentsIdle()
      settingsUpdating = true
      try {
        const imported = await importSkill(workspaceCwd, body)
        ctx.peek<SkillsService>('skills')?.reload()
        await refreshState()
        json(res, 200, imported)
      } finally { settingsUpdating = false }
      return
    }

    if (pathname === '/api/workspace/memories' && method === 'GET') {
      if (access.remote || principal.role !== 'operator') throw new HttpError(404, 'memory management is available only locally')
      const workspaces = await memoryCatalog()
      assertWorkspaceSame()
      json(res, 200, { workspaceId: workspaceId(), workspaces })
      return
    }

    if (pathname === '/api/workspace/memory/process' && method === 'POST') {
      if (access.remote || principal.role !== 'operator') throw new HttpError(404, 'memory processing is available only locally')
      const body = await bodyJson(req, 4096)
      assertWorkspaceSame()
      const target = typeof body.workspace === 'string' ? knownMemoryWorkspace(body.workspace) : workspaceCwd
      if (target !== workspaceCwd) throw new HttpError(409, '自动整理只对当前打开的工作区运行，请先切换到该工作区；其他记忆仍可查看、编辑或 @ 引用。')
      if (body.confirmed !== true) throw new HttpError(400, '手动整理会调用模型，需要明确确认。')
      const processor = ctx.peek<MemoryProcessingService>('memoryProcessing')
      if (!processor) throw new HttpError(404, 'memory processing is not mounted')
      let entry: { id: string; revision: number; fingerprint: string } | undefined
      if (body.entryId !== undefined) {
        if (typeof body.entryId !== 'string' || !/^[a-f0-9]{24}-\d+$/.test(body.entryId) || !Number.isSafeInteger(body.revision) || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) throw new HttpError(400, '请选择有效记忆条目并刷新版本后重试。')
        entry = { id: body.entryId, revision: Number(body.revision), fingerprint: body.fingerprint }
      }
      assertAgentsIdle()
      if (ctx.agents.list().some(agent => ctx.peek<CompactionService>('compaction')?.isCompacting(agent.sessionId))) throw new HttpError(409, '请等待上下文压缩完成。')
      settingsUpdating = true
      try {
        const snapshot = await processor.process({ signal: shutdownController.signal, manual: true, entry })
        json(res, 200, { ...snapshot, workspaceId: workspaceId(), workspace: workspaceCwd })
      } finally { settingsUpdating = false; await refreshState() }
      return
    }

    if (pathname === '/api/workspace/memory/export' && method === 'GET') {
      if (access.remote || principal.role !== 'operator') throw new HttpError(404, 'memory export is available only locally')
      const target = knownMemoryWorkspace(url.searchParams.get('workspace') || workspaceCwd)
      const store = target === workspaceCwd ? ctx.peek<WorkspaceMemoryService>('workspaceMemory') : new WorkspaceMemoryStore(target)
      if (!store) throw new HttpError(404, 'memory unavailable')
      const snapshot = await store.reload()
      assertWorkspaceSame()
      if (snapshot.error) throw new HttpError(500, snapshot.error)
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': 'attachment; filename="workspace-memory.md"' })
      res.end('# Workspace memory\n\n' + snapshot.content + (snapshot.pendingContent ? '\n\n## 待整理记录（不是已确认长期记忆）\n\n' + snapshot.pendingContent : ''))
      return
    }

    if (pathname === '/api/context/settings' && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertSessionSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      const compaction = ctx.peek<CompactionService>('compaction')
      if (!compaction) throw new HttpError(400, '当前工作区未启用上下文压缩服务。')
      let settings: ContextBudgetSettings
      try { settings = validateContextBudget(body) }
      catch (error) { throw new HttpError(400, (error as Error).message) }
      assertAgentsIdle()
      if (ctx.agents.list().some(agent => compaction.isCompacting(agent.sessionId))) throw new HttpError(409, '上下文正在压缩，请完成后再修改阈值。')
      settingsUpdating = true
      try {
        const nextPrefs = new Map(workspacePrefs)
        nextPrefs.set(workspaceCwd, { ...prefsFor(workspaceCwd), contextBudget: settings })
        try { await (opts.onPersistContextBudget ?? persistSettings)?.({ ...currentDesktopState(true), workspacePrefs: Object.fromEntries(nextPrefs) }) }
        catch { throw new HttpError(500, '无法保存上下文阈值，原设置未改变。') }
        if (closed) throw new HttpError(503, 'server is shutting down')
        compaction.setContextBudget(settings)
        workspacePrefs.set(workspaceCwd, nextPrefs.get(workspaceCwd)!)
        broadcast({ type: 'context/budget', budget: contextBudget() })
      } finally { settingsUpdating = false }
      await refreshState()
      json(res, 200, { contextBudget: contextBudget() })
      return
    }

    const contextAction = pathname.match(/^\/api\/context\/(compact|clear)$/)
    if (contextAction && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertSessionSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (!isSessionId(body.sessionId) || !Number.isSafeInteger(body.contextRevision) || Number(body.contextRevision) < 0) {
        throw new HttpError(400, '请刷新当前会话后重试；操作需要会话 ID 与上下文版本。')
      }
      if (!sameSession(mainAgent().sessionId, body.sessionId)) throw new HttpError(409, '当前会话已改变，请重新选择操作。')
      const action = contextAction[1] as 'compact' | 'clear'
      if (action === 'clear' && body.confirmed !== true) throw new HttpError(400, '清空上下文需要明确确认；历史不会删除。')
      if (body.focus !== undefined && (typeof body.focus !== 'string' || body.focus.length > 1000)) throw new HttpError(400, '压缩重点必须是 1,000 字符以内的文本。')
      const mount = ctx
      const compaction = mount.peek<CompactionService>('compaction')
      if (action === 'compact' && !compaction) throw new HttpError(400, '当前工作区未启用上下文压缩服务。')
      const assertContextIdle = (): void => {
        if (closed || ctx !== mount || workspaceEpoch !== workspaceEpochAtEntry || sessionEpoch !== sessionEpochAtEntry || switching || switchingWorkspace) {
          throw new HttpError(409, '工作区或会话已改变，本次操作未继续。')
        }
        if (!sameSession(mainAgent().sessionId, body.sessionId as string)) throw new HttpError(409, '当前会话已改变，请刷新后重试。')
        assertAgentsIdle()
        if (pending.snapshot().length || pendingQuestions.snapshot().length || pendingPlans.snapshot().length || pendingRetries.snapshot().length) throw new HttpError(409, '请先处理待确认的审批、问题、计划或重试。')
        if (mount.agents.list().some(agent => compaction?.isCompacting(agent.sessionId))) throw new HttpError(409, '上下文已经在压缩，请等待完成。')
      }
      assertContextIdle()
      contextOperation = { action, sessionId: body.sessionId }
      broadcast({ type: 'context/status', ...contextOperation, active: true })
      void refreshState()
      let compactedEvents = 0
      try {
        const session = await mount.sessions.open(body.sessionId)
        assertContextIdle()
        if ((session.events.at(-1)?.seq ?? 0) !== body.contextRevision) throw new HttpError(409, '上下文内容已更新，请刷新后重新确认。')
        if (action === 'clear') {
          await session.clearContext(assertContextIdle)
          contextCache = null
          broadcast({ type: 'context/cleared', sessionId: session.id, workspaceId: workspaceId() })
        } else {
          const result = await compaction!.compact(session.id, { focus: body.focus as string | undefined, signal: shutdownController.signal })
          if (result.deferred) throw new HttpError(409, '上下文发生变化或仍有工具调用未完成，请待任务结束后再压缩。')
          compactedEvents = result.compactedEvents
        }
      } finally {
        contextOperation = null
        broadcast({ type: 'context/status', action, sessionId: body.sessionId, active: false })
        await refreshState()
      }
      json(res, 200, { ok: true, sessionId: body.sessionId, compactedEvents, workspaceId: workspaceId() })
      return
    }

    if (pathname === '/api/collaboration' && method === 'GET') {
      json(res, 200, await collaborationSnapshot())
      return
    }

    if (pathname === '/api/workspace/memory' && (method === 'GET' || method === 'POST')) {
      const requestedWorkspace = url.searchParams.get('workspace')
      const target = knownMemoryWorkspace(requestedWorkspace || workspaceCwd)
      const memory = target === workspaceCwd ? ctx.peek<WorkspaceMemoryService>('workspaceMemory') : new WorkspaceMemoryStore(target)
      if (!memory || access.remote || principal.role !== 'operator') {
        throw new HttpError(404, 'memory settings are available only in a local workspace')
      }
      if (method === 'GET') {
        assertWorkspaceSame()
        const snapshot = await memory.reload()
        assertWorkspaceSame()
        json(res, 200, { ...snapshot, workspaceId: workspaceId(), workspace: target })
        return
      }
      const body = await bodyJson(req, WORKSPACE_MEMORY_MAX_CHARS * 6 + 4096)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (!Number.isSafeInteger(body.revision) || Number(body.revision) < 0) throw new HttpError(400, 'memory revision is required')
      if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled must be boolean')
      if (Object.keys(body).some(key => !['revision', 'fingerprint', 'enabled', 'content', 'processing', 'clearPending', 'confirmed', 'entry'].includes(key))) throw new HttpError(400, 'invalid memory settings fields')
      if (body.fingerprint !== undefined && (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint))) throw new HttpError(400, 'invalid memory fingerprint')
      if (body.clearPending !== undefined && (typeof body.clearPending !== 'boolean' || body.clearPending && body.confirmed !== true)) throw new HttpError(400, '清空待整理记录需要明确确认。')
      if (body.entry !== undefined) {
        const entry = body.entry as Record<string, unknown> | null
        if (!entry || Array.isArray(entry) || Object.keys(entry).some(key => !['collection', 'id', 'action', 'enabled', 'content'].includes(key)) ||
          !['longTerm', 'pending'].includes(String(entry.collection)) || !['delete', 'toggle', 'replace'].includes(String(entry.action)) ||
          typeof entry.id !== 'string' || !/^[a-f0-9]{24}-\d+$/.test(entry.id) ||
          entry.action === 'delete' && body.confirmed !== true || body.content !== undefined || body.clearPending !== undefined) throw new HttpError(400, '请选择有效条目；删除条目需要明确确认。')
      }
      const processing = body.processing === undefined ? undefined : validateMemoryProcessing(body.processing)
      if (body.content !== undefined && (typeof body.content !== 'string' || body.content.length > WORKSPACE_MEMORY_MAX_CHARS || body.content.includes('\0'))) {
        throw new HttpError(400, `memory content must be text of at most ${WORKSPACE_MEMORY_MAX_CHARS} characters`)
      }
      assertAgentsIdle()
      const compacting = ctx.peek<{ isCompacting(id: string): boolean }>('compaction')
      if (ctx.agents.list().some(agent => compacting?.isCompacting(agent.sessionId))) throw new HttpError(409, 'context compaction is running; wait before editing memory')
      if (ctx.peek<MemoryProcessingService>('memoryProcessing')?.status().active) throw new HttpError(409, '长期记忆正在整理，请等待完成。')
      if (switching || switchingWorkspace) throw new HttpError(409, 'a workspace or session change is in progress; retry')
      settingsUpdating = true
      try {
        const saved = await memory.update({
          ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
          ...(body.content !== undefined ? { content: body.content as string } : {}),
          ...(processing ? { processing } : {}),
          ...(body.clearPending === true ? { clearPending: true } : {}),
          ...(body.entry !== undefined ? { entry: body.entry as unknown as MemoryEntryOperation } : {}),
        }, Number(body.revision), { fingerprint: typeof body.fingerprint === 'string' ? body.fingerprint : undefined })
        json(res, 200, { ...saved, workspaceId: workspaceId(), workspace: target })
      } finally { settingsUpdating = false }
      await refreshState()
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
      const body = await bodyJson(req, Math.ceil(CHAT_FILE_LIMITS.totalBytes / 3) * 4 + 1024 * 1024)
      assertSessionSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      const mainAtEntry = mainAgent()
      const targetSession = isSessionId(mainAtEntry.sessionId) ? mainAtEntry.sessionId : null
      const expertsAtEntry = expertMode ? liveExperts() : []
      const expertEpochAtEntry = expertEpoch
      const assertMessageTarget = (): void => {
        assertSessionSame()
        if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
        if (mainAgent() !== mainAtEntry || body.sessionId !== undefined && body.sessionId !== targetSession) {
          throw new HttpError(409, '会话已改变，附件与消息未提交，请在当前会话确认后发送。')
        }
        liveExperts()
        if (expertEpochAtEntry !== expertEpoch || body.expertMode !== undefined && body.expertMode !== expertMode) {
          throw new HttpError(409, '专家组已改变，附件与消息未发送；请确认后重新发送。')
        }
      }
      assertMessageTarget()
      let files: ChatUploadFile[]
      try { files = [...parseChatFiles(body.files), ...parseChatImages(body.images)] }
      catch (error) { if (error instanceof ChatAttachmentError) throw new HttpError(error.status, error.message); throw error }
      if (typeof body.text !== 'string' || !body.text.trim() && !files.length) {
        json(res, 400, { error: 'text is required' })
        return
      }
      const text = body.text.trim() || (Array.isArray(body.files) && body.files.length ? '请查看附件文件。' : '(see attached images)')
      if (files.length > CHAT_FILE_LIMITS.count) throw new HttpError(413, '文件与图片附件每条消息合计最多 12 个。')
      if (files.reduce((total, file) => total + file.bytes.length, 0) > CHAT_FILE_LIMITS.totalBytes) {
        throw new HttpError(413, '文件与图片附件合计不能超过 16 MiB。')
      }
      const task = await prepareUserTask(text)
      assertMessageTarget()
      if (sakuraAccount && !access.remote && principal.role === 'operator') {
        try { await sakuraAccount.foregroundActivity() }
        catch (error) {
          if (sakuraApiOnly && sakuraAccount.status().phase === 'expired') { ctx.llm.replaceAdapters(sakuraAccount.adapter()); await refreshState() }
          if (sakuraApiOnly) throw new HttpError(409, error instanceof SakuraApiError ? error.message : '客户端账号活跃验证失败，请同步授权后再发送。')
        }
        assertMessageTarget()
      }
      const prepared = new Map<string, StoredChatFiles>()
      if (files.length) {
        const mount = ctx
        try {
          for (const agent of [mainAtEntry, ...expertsAtEntry]) prepared.set(agent.id, await mount.agents.prepareFiles(agent.id, files))
          assertMessageTarget()
        } catch (error) {
          await Promise.all([...prepared.values()].map(file => file.remove()))
          await refreshState()
          if (error instanceof HttpError) throw error
          throw new HttpError(error instanceof ChatAttachmentError ? error.status : 500, '附件保存失败，消息没有发送；请保留草稿并检查磁盘权限或空间。')
        }
      }
      const queued = submitUserTask(task, undefined, prepared, text)
      json(res, 202, { ok: true, queued })
      return
    }

    if (pathname === '/api/experts/start' && method === 'POST') {
      const body = await bodyJson(req)
      assertExpertTarget(body)
      if (body.task !== undefined && body.task !== null && (typeof body.task !== 'string' || !body.task.trim())) {
        throw new HttpError(400, 'task must be a non-empty string')
      }
      if (body.experts !== undefined && (!Array.isArray(body.experts) || !body.experts.length || body.experts.some((key) => typeof key !== 'string'))) {
        throw new HttpError(400, 'experts must be a non-empty array of preset keys')
      }
      let keys: string[]
      try {
        keys = resolveExperts(body.experts as string[] | undefined).map((preset) => preset.key)
      } catch (error) {
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
      const task = typeof body.task === 'string' ? await prepareUserTask(body.task.trim()) : undefined
      assertExpertTarget(body)
      const result = startExpertTeam(keys)
      const queued = task ? submitUserTask(task) : false
      broadcast({ type: 'notice', key: 'expert-mode', level: 'info', message: `专家协同模式已开启：${[...result.started, ...result.reused].join('、')}${result.skipped.length ? `（${result.skipped.join('、')}与普通成员重名，未加入团队）` : ''}。共享当前对话上下文；长期记忆仅采集用户调整方向。` })
      await refreshState()
      json(res, 200, { expertMode: true, queued, ...result })
      return
    }

    if (pathname === '/api/experts/summarize' && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertExpertTarget(body)
      const summary = buildExpertSummary(liveExperts())
      if (!summary) throw new HttpError(409, 'experts have not produced any completed conclusions yet')
      const main = mainAgent()
      const queued = main.status === 'running'
      // Expert outputs are copied into this one main-agent request; summarizing
      // must not send a new round of work back to the expert team.
      void main.turn(summary, { source: 'expert-summary', expertMode: true }).then((result) => {
        if (result.error) broadcast({ type: 'notice', level: 'error', message: result.error })
      }).catch((error: unknown) => {
        broadcast({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) })
      })
      json(res, 202, { ok: true, queued })
      return
    }

    if (pathname === '/api/experts/stop' && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertExpertTarget(body)
      const stopped = expertMode
      expertMode = false
      ctx.agents.setExpertMemoryMode(mainAgent().id, false)
      if (stopped) expertEpoch++
      await refreshState()
      if (stopped) {
        broadcast({ type: 'notice', key: 'expert-mode', level: 'info', message: '专家协同模式已关闭；专家成员保留在花名册中，可继续单独对话或删除。' })
      }
      json(res, 200, { ok: true, stopped })
      return
    }

    if (pathname === '/api/interrupt' && method === 'POST') {
      const main = mainAgent()
      main.interrupt()
      pending.cancel(main.id)
      pendingRetries.cancel(main.id)
      json(res, 200, { ok: true })
      return
    }

    const approvalMatch = pathname.match(/^\/api\/approvals\/([\w-]+)$/)
    if (approvalMatch && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertSessionSame()
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
      assertSessionSame()
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
      assertSessionSame()
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

    if (pathname === '/api/sessions/archived' && method === 'GET') {
      const sessions = await ctx.sessions.list({ archived: true })
      assertWorkspaceSame()
      json(res, 200, { workspaceId: workspaceId(), sessions: sessions.map(session => ({ ...session, deleteBlocked: sessionDeletionBlock(session.id) })) })
      return
    }

    const archiveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/archive$/)
    if (archiveMatch && method === 'POST') {
      const id = decodeSessionId(archiveMatch[1]!)
      const body = await bodyJson(req, 4096)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (typeof body.archived !== 'boolean') throw new HttpError(400, '归档状态必须为布尔值。')
      json(res, 200, await archiveSession(id, body.archived))
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

    if (pathname === '/api/sessions/batch-delete' && method === 'POST') {
      const body = await bodyJson(req, 32 * 1024)
      assertWorkspaceSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100 || body.ids.some(id => !isSessionId(id))) {
        throw new HttpError(400, 'select 1-100 valid session IDs')
      }
      const unique = new Map<string, string>()
      for (const id of body.ids as string[]) unique.set(process.platform === 'win32' ? id.toLowerCase() : id, id)
      const ids = [...unique.values()]
      json(res, 200, await deleteSessions(ids))
      return
    }

    const deleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (deleteMatch && method === 'DELETE') {
      const id = decodeSessionId(deleteMatch[1]!)
      json(res, 200, await deleteSession(id))
      return
    }

    const historyMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/history\/(preview|edit|rewind)$/)
    if (historyMatch && method === 'POST') {
      const id = decodeSessionId(historyMatch[1]!), action = historyMatch[2]!
      const body = await bodyJson(req, 256 * 1024)
      assertSessionSame()
      if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
      if (!sameSession(mainAgent().sessionId, id)) throw new HttpError(409, '请先恢复此会话，再编辑或回滚；只读历史不会修改代码。')
      if (!Number.isSafeInteger(body.turnSeq) || Number(body.turnSeq) < 1) throw new HttpError(400, '需要已保存的用户消息序号。')
      const mount = ctx, history = new ConversationHistoryService(mount.sessions, mount.checkpoints)
      const restoresCode = action !== 'preview' && (body.mode === 'code' || body.mode === 'both')
      const codeRestoreBlockedReason = (): string => mount.jobs?.list().some(job => job.status === 'running')
        ? '后台命令仍在运行，暂不能恢复代码；可选择只回滚对话（保留代码和后台任务），或停止后台任务后刷新预览。' : ''
      const assertHistoryIdle = (): void => {
        if (closed || mount !== ctx || workspaceEpochAtEntry !== workspaceEpoch || sessionEpochAtEntry !== sessionEpoch || switching || switchingWorkspace ||
            !sameSession(mainAgent().sessionId, id)) throw new HttpError(409, '工作区或对话已改变，本次编辑或回滚未继续。')
        if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
        assertAgentsIdle()
        if (pending.snapshot().length || pendingQuestions.snapshot().length || pendingPlans.snapshot().length || pendingRetries.snapshot().length) throw new HttpError(409, '请先处理审批、问题、计划或重试确认。')
        if (mount.agents.list().some(agent => mount.peek<CompactionService>('compaction')?.isCompacting(agent.sessionId))) throw new HttpError(409, '上下文正在压缩，请稍后再编辑或回滚。')
        // A long-lived preview/dev server must not block a read-only preview or
        // an independent conversation branch. Only restoring project files can
        // race its side effects; recheck that gate throughout the transaction.
        const blocked = restoresCode ? codeRestoreBlockedReason() : ''
        if (blocked) throw new HttpError(409, blocked)
      }
      assertHistoryIdle()
      if (action === 'preview') {
        const preview = await history.preview(id, Number(body.turnSeq))
        assertSessionSame(); assertHistoryIdle()
        json(res, 200, { ...preview, codeRestoreBlockedReason: codeRestoreBlockedReason(), workspaceId: workspaceId() })
        return
      }
      if (body.confirmed !== true || !Number.isSafeInteger(body.contextRevision) || typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) {
        throw new HttpError(400, '请先预览影响范围，并明确确认对话与代码版本。')
      }
      if (!['conversation', 'code', 'both'].includes(String(body.mode))) throw new HttpError(400, '回滚范围必须为对话、代码或两者。')
      if (action === 'edit' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 64_000 || body.mode === 'code')) {
        throw new HttpError(400, '编辑消息须为 1～64,000 字符；可选择是否同时回滚代码。')
      }
      contextOperation = { action: action as 'edit' | 'rewind', sessionId: id }
      broadcast({ type: 'context/status', ...contextOperation, active: true })
      void refreshState()
      let result: Awaited<ReturnType<ConversationHistoryService['rewind']>>
      try {
        const task = action === 'edit' ? await prepareUserTask((body.text as string).trim()) : undefined
        assertHistoryIdle()
        result = await history.rewind({ sessionId: id, turnSeq: Number(body.turnSeq), contextRevision: Number(body.contextRevision),
          fingerprint: body.fingerprint, mode: body.mode as HistoryMode,
          ...(task !== undefined ? { edit: { task, originalText: (body.text as string).trim() } } : {}),
        }, assertHistoryIdle)
        if (result.session.id !== id) {
          pending.cancel(); pendingQuestions.cancel(); pendingPlans.cancel(); pendingRetries.cancel()
          mount.agents.disposeAll()
          sessionEpoch++; expertEpoch++
          expertMode = false; expertIds.clear()
          mount.approval.engine.clearSessionAllows()
          const todos = mount.peek<{ todos: unknown[] }>('todos')
          if (todos) todos.todos = []
          harness.main({ resumeSessionId: result.session.id }); applySelectedModel()
        }
        contextCache = null; statsCache = null
        mount.emit('session/branched', { sessionId: result.session.id, sourceId: id })
        broadcast({ type: 'session/rewound', sessionId: result.session.id, sourceId: id, mode: body.mode,
          action, restoredFiles: result.restoredFiles, workspaceId: workspaceId() })
      } finally {
        contextOperation = null
        broadcast({ type: 'context/status', action, sessionId: id, active: false })
      }
      await refreshState()
      json(res, 200, { ok: true, sessionId: result.session.id, sourceId: id, restoredFiles: result.restoredFiles, workspaceId: workspaceId(),
        edited: action === 'edit', generated: false })
      return
    }

    // Separate regeneration from the branch commit: a network failure can never
    // silently edit a second time or cause automatic duplicate model requests.
    if (pathname === '/api/conversation/generate' && method === 'POST') {
      const body = await bodyJson(req, 4096)
      assertSessionSame()
      if (!isSessionId(body.sessionId) || !sameSession(mainAgent().sessionId, body.sessionId)) throw new HttpError(409, '当前编辑分支已改变，未重新生成。')
      assertAgentsIdle()
      const mount = ctx, main = mainAgent()
      contextOperation = { action: 'edit', sessionId: body.sessionId }
      try {
        const session = await mount.sessions.open(body.sessionId)
        if (closed || mount !== ctx || sessionEpochAtEntry !== sessionEpoch || workspaceEpochAtEntry !== workspaceEpoch || main !== mainAgent()) throw new HttpError(409, '编辑分支已改变。')
        assertAgentsIdle()
        const last = session.events.at(-1)
        if (!last || last.type !== 'user/message' || !session.events.some(record => record.type === 'agent/meta' && record.payload.action === 'edit')) {
          throw new HttpError(409, '此编辑分支已经生成或已改变，未重复请求模型。')
        }
        if (pending.snapshot().length || pendingQuestions.snapshot().length || pendingPlans.snapshot().length || pendingRetries.snapshot().length ||
            mount.agents.list().some(agent => mount.peek<CompactionService>('compaction')?.isCompacting(agent.sessionId))) throw new HttpError(409, '请先完成待处理操作。')
        if (!access.isActive(principal)) throw new HttpError(401, 'authentication expired')
        await session.append({ type: 'session/note', payload: { note: 'generation-start', userSeq: last.seq } })
        // A durable claim prevents double submits and a duplicate user message.
        void main.turn(last.payload.content, { resumeUserSeq: last.seq, originalText: last.payload.originalText }).catch(error =>
          broadcast({ type: 'notice', level: 'error', message: error instanceof Error ? error.message : String(error) }))
      } finally { contextOperation = null }
      json(res, 202, { ok: true })
      return
    }

    const recordsMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/records$/)
    if (recordsMatch && method === 'GET') {
      const id = decodeSessionId(recordsMatch[1]!)
      assertWorkspaceSame()
      try {
        const session = await ctx.sessions.open(id)
        assertWorkspaceSame()
        json(res, 200, { records: session.events, turnSummaries: recordedTurnSummaries(session.events) })
      } catch (error) {
        if (error instanceof HttpError || error instanceof SessionError && error.code === 'EBUSY') throw error
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
        assertWorkspaceSame()
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${id}.md"`,
        })
        res.end(md)
      } catch (error) {
        if (error instanceof HttpError || error instanceof SessionError && error.code === 'EBUSY') throw error
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
      if (ok) { pending.cancel(id); pendingRetries.cancel(id) }
      json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'agent not found or not running' })
      return
    }

    if (pathname === '/api/settings' && method === 'POST') {
      const body = await bodyJson(req)
      assertSessionSame()
      if (sakuraApiOnly && ['baseURL', 'apiKey', 'provider', 'format'].some(key => Object.hasOwn(body, key))) {
        throw new HttpError(400, '桌面版只允许 SakuraAPI 授权的上游，不能填写地址或 Key。')
      }
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
      if (sakuraApiOnly && typeof body.model === 'string') {
        settingsUpdating = true
        try {
          await sakuraAccount!.selectModel(body.model)
          if (closed) throw new HttpError(503, 'server is shutting down')
          ctx.llm.replaceAdapters(sakuraAccount!.adapter())
          overrides.model = body.model
        } catch (error) {
          if (error instanceof SakuraApiError) throw new HttpError(error.status, error.message)
          throw error
        } finally { settingsUpdating = false }
      } else modelUpdate?.commit()
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
      assertWorkspaceSame()
      if (sakuraApiOnly) {
        if (body.baseURL !== undefined || body.apiKey !== undefined) throw new HttpError(400, '桌面版只使用 SakuraAPI 授权同步的模型，不允许指定地址或 Key。')
        json(res, 200, { models: sakuraAccount!.status().models })
        return
      }
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
      if (sakuraApiOnly) {
        if (['baseURL', 'apiKey', 'rememberKey', 'format', 'provider', 'model'].some(key => Object.hasOwn(body, key))) {
          throw new HttpError(400, '桌面版上游固定为 SakuraAPI；Key 与模型请使用官网授权和模型选择器同步，不允许手填。')
        }
      }
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

    const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/)
    if (skillMatch && method === 'GET') {
      // Read-only skill detail (SKILL.md body); viewers may read it too.
      const detail = ctx.peek<{ get(name: string): { meta: SkillMetaLike; body: string } | undefined }>('skills')
        ?.get(decodeURIComponent(skillMatch[1]!))
      if (!detail) throw new HttpError(404, 'skill not found')
      json(res, 200, {
        name: detail.meta.name,
        description: detail.meta.description,
        whenToUse: detail.meta.whenToUse,
        source: detail.meta.source,
        body: detail.body,
      })
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
      updateChecker.close()
      pluginMarketplace.close()
      access.dispose()
      harness.dispose()
      reject(error)
    }
    server.once('error', failed)
    const listen = (attempt: number): void => {
      server.listen(requestedPort, host, () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : requestedPort
        if (requestedPort === 0 && BLOCKED_WEB_PORTS.has(port)) {
          server.close(() => {
            if (attempt >= 31) failed(new Error('cannot allocate a browser-compatible Web port'))
            else listen(attempt + 1)
          })
          return
        }
        server.off('error', failed)
        resolve(port)
      })
    }
    listen(0)
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
        pendingCount: pending.snapshot().length + pendingQuestions.snapshot().length + pendingPlans.snapshot().length + pendingRetries.snapshot().length,
      }),
      command: action => {
        if (closed || settingsUpdating || switchingWorkspace || switching || deletingSession || contextOperation || action.workspaceId !== workspaceId()) {
          throw new Error('workspace unavailable')
        }
        const agent = action.agentId ? ctx.agents.get(action.agentId) : mainAgent()
        if (!agent) throw new Error('agent no longer exists')
        if (action.type === 'stop') {
          agent.interrupt()
          pending.cancel(agent.id)
          pendingQuestions.cancel(agent.id)
          pendingPlans.cancel(agent.id)
          pendingRetries.cancel(agent.id)
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

  if (autoUpdateCheck()) scheduleUpdateCheck(updateInitialDelay)
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
    updateDesktopViewport(value) {
      const viewport = parseDesktopViewport(value)
      if (closed || !opts.onWindowAction || access.remote || !viewport || viewport.version <= (desktopViewport?.version ?? 0)) return
      desktopViewport = viewport
      broadcast({ type: 'desktop/viewport', viewport })
    },
    async close() {
      if (closed) return
      closed = true
      shutdownController.abort()
      clearInterval(heartbeat)
      if (stateRefreshTimer !== undefined) clearTimeout(stateRefreshTimer)
      if (updateTimer !== undefined) clearTimeout(updateTimer)
      updateChecker.close()
      pluginMarketplace.close()
      await updateInFlight
      await sakuraAccount?.close()
      await weixin?.close()
      ctx.agents.disposeAll()
      pending.cancel()
      pendingQuestions.cancel()
      pendingPlans.cancel()
      pendingRetries.cancel()
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
