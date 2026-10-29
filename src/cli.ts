#!/usr/bin/env node
/**
 * SakuraCode CLI — a plugin-first coding agent.
 *   sakura                     interactive REPL
 *   sakura -p "task"           one-shot (headless)
 *   sakura --dump-config       print the resolved composition
 *   sakura --profile <name>    pick a profile from sakura.yml
 */

import * as readline from 'node:readline'
import { createHarness, BASE_BUNDLE } from './harness.js'
import { loadConfig, flagsToPatch, deepMerge, resolveProfile, CONFIG_FILES, type SakuraConfig } from './config.js'
import { resolveModelName } from './core/llm.js'
import type { ApprovalMode } from './core/index.js'
import { APPROVAL_MODES } from './core/index.js'
import type { PluginRegistry } from './tools/plugin-manager.js'
import { isSessionId } from './core/session.js'

import { estimateMessagesTokens, summarizeUsage } from './util/tokens.js'
import { spawnExperts } from './experts.js'
import { UpdateChecker } from './updates.js'
const VERSION = '1.0.0'

interface ParsedArgs {
  print: boolean
  yolo: boolean
  mode?: ApprovalMode
  model?: string
  baseURL?: string
  maxSteps?: number
  allowNested?: boolean
  resume?: string
  dumpConfig: boolean
  configPath?: string
  patch?: string
  profile?: string
  help: boolean
  version: boolean
  web: boolean
  desktopHost: boolean
  port?: number
  host?: string
  publicOrigin?: string
  open: boolean
  prompt: string
}

function usage(): string {
  return [
    'SakuraCode — a plugin-first coding agent (everything is a plugin)',
    '',
    'Usage:',
    '  sakura [options] [prompt]',
    '',
    'Options:',
    '  -p, --print          one-shot: run the prompt and exit',
    '  --web                serve the Web GUI (http://127.0.0.1:3099)',
    '  --port <n>           port for --web (default: 3099)',
    '  --host <address>     Web bind address (default: 127.0.0.1); remote requires SAKURA_WEB_TOKEN',
    '  --public-origin <u>  HTTPS origin of a reverse proxy (requires Web authentication)',
    '  --no-open            with --web: do not open the browser automatically',
    '  --yolo               auto-approve all tool calls',
    '  --mode <mode>        approval mode: plan | default | acceptEdits | yolo',
    '  --model <model>      chat model (default: gpt-4o-mini)',
    '  --base-url <url>     OpenAI-compatible API base URL',
    '  --max-steps <n>      per-turn step cap (default 40)',
    '  --allow-nested       let subagents spawn subagents',
    '  --resume <id>        resume a previous session id',
    '  --profile <name>     pick a named profile from the config',
    '  --config <file>      config file to load',
    '  --patch <yaml>       inline YAML patch applied last',
    '  --dump-config        print the resolved configuration and exit',
    '  -h, --help           show this help',
    '  --version            show version',
    '',
    'REPL commands: /help /exit /agents /experts /update /mode /model /thinking /tools /plugins /sessions /resume /skills /compact /memory /export /hooks /permissions /usage',
    'Custom commands: .sakura/commands/<name>.md (project) or ~/.sakura/commands/<name>.md → /<name> [args]',
    '',
    `API: set SAKURA_API_KEY, optional SAKURA_BASE_URL, SAKURA_MODEL.`,
    'Web: SAKURA_WEB_TOKEN for operators; optional SAKURA_WEB_VIEWER_TOKEN for read-only viewers.',
    `Config: ${CONFIG_FILES.join(' / ')} in the working directory, or ~/.sakura/config.yml.`,
  ].join('\n')
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {
    print: false,
    yolo: false,
    dumpConfig: false,
    help: false,
    version: false,
    web: false,
    desktopHost: false,
    open: true,
    prompt: '',
  }
  const rest: string[] = []
  let i = 0
  const needValue = (flag: string): string => {
    const value = argv[++i]
    if (value === undefined || value === '') throw new Error(`option ${flag} requires a value (see --help)`)
    return value
  }
  for (i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    switch (arg) {
      case '-p':
      case '--print':
        args.print = true
        break
      case '--yolo':
        args.yolo = true
        break
      case '--mode': {
        const value = needValue(arg)
        if (!APPROVAL_MODES.includes(value as ApprovalMode)) {
          throw new Error(`--mode must be one of: ${APPROVAL_MODES.join(', ')}`)
        }
        args.mode = value as ApprovalMode
        break
      }
      case '--model':
        args.model = needValue(arg)
        break
      case '--base-url':
        args.baseURL = needValue(arg)
        break
      case '--max-steps': {
        const value = Number(needValue(arg))
        if (!Number.isInteger(value) || value <= 0) throw new Error('--max-steps must be a positive integer')
        args.maxSteps = value
        break
      }
      case '--allow-nested':
        args.allowNested = true
        break
      case '--resume':
        args.resume = needValue(arg)
        break
      case '--web':
        args.web = true
        break
      case '--desktop-host':
        args.desktopHost = true
        break
      case '--port': {
        const value = Number(needValue(arg))
        if (!Number.isInteger(value) || value <= 0 || value > 65535) throw new Error('--port must be an integer in 1-65535')
        args.port = value
        break
      }
      case '--no-open':
        args.open = false
        break
      case '--host':
        args.host = needValue(arg)
        break
      case '--public-origin':
        args.publicOrigin = needValue(arg)
        break
      case '--dump-config':
        args.dumpConfig = true
        break
      case '--config':
        args.configPath = needValue(arg)
        break
      case '--patch':
        args.patch = needValue(arg)
        break
      case '--profile':
        args.profile = needValue(arg)
        break
      case '-h':
      case '--help':
        args.help = true
        break
      case '--version':
        args.version = true
        break
      default:
        if (arg.startsWith('-')) throw new Error(`unknown option "${arg}" (see --help)`)
        rest.push(arg)
    }
  }
  args.prompt = rest.join(' ')
  return args
}

async function buildConfig(args: ParsedArgs): Promise<SakuraConfig> {
  const config = await loadConfig({ configPath: args.configPath, patch: args.patch })
  if (args.profile) config.profile = args.profile
  deepMerge(
    config as unknown as Record<string, unknown>,
    flagsToPatch({
      model: args.model,
      baseURL: args.baseURL,
      approvalMode: args.mode,
      maxSteps: args.maxSteps,
      allowNested: args.allowNested,
    }),
  )
  return config
}

async function main(): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(String((error as Error).message))
    return 2
  }
  if (args.help) {
    console.log(usage())
    return 0
  }
  if (args.version) {
    console.log(VERSION)
    return 0
  }

  if (args.desktopHost) {
    const { runDesktopHost } = await import('./desktop/host.js')
    await runDesktopHost()
    return 0
  }

  let config: SakuraConfig
  try {
    config = await buildConfig(args)
  } catch (error) {
    console.error(`config error: ${(error as Error).message}`)
    return 2
  }

  if (args.dumpConfig) {
    const { plugins } = resolveProfile(config)
    const disabled = Object.entries(plugins).filter(([, r]) => r.disabled).map(([n]) => n)
    console.log(
      JSON.stringify(
        {
          profile: config.profile ?? 'default',
          pluginsDir: config.pluginsDir,
          bundles: resolveProfile(config).bundles,
          disabledPlugins: disabled,
          model: resolveModelName((plugins['core-llm']?.config as { model?: string } | undefined)?.model),
          approvalMode: (plugins['core-approval']?.config as { mode?: ApprovalMode } | undefined)?.mode ?? 'default',
          pluginRows: plugins,
        },
        null,
        2,
      ),
    )
    return 0
  }

  // Approval mode precedence: --yolo/--mode flags → core-approval row from
  // the resolved profile (config + profile layers) → 'default'.
  const profileRows = resolveProfile(config).plugins
  const flagMode: ApprovalMode | undefined = args.yolo ? 'yolo' : args.mode
  const approvalMode: ApprovalMode =
    flagMode ?? ((profileRows['core-approval']?.config as { mode?: ApprovalMode } | undefined)?.mode ?? 'default')

  // The Web server owns its Harness. Do not mount plugins/MCP a second time in a REPL Harness.
  if (args.web) {
    const { runWebServer } = await import('./web/server.js')
    const handle = await runWebServer({
      config,
      port: args.port ?? config.web?.port ?? 3099,
      host: args.host,
      publicOrigin: args.publicOrigin,
      open: args.open,
      resumeSessionId: args.resume,
      approvalMode,
      model: args.model,
      baseURL: args.baseURL,
      maxSteps: args.maxSteps,
    })
    await new Promise<void>((resolve, reject) => {
      const shutdown = (): void => {
        process.off('SIGINT', shutdown)
        process.off('SIGTERM', shutdown)
        void handle.close().then(resolve, reject)
      }
      process.once('SIGINT', shutdown)
      process.once('SIGTERM', shutdown)
    })
    return 0
  }

  // In the REPL, confirmations go through the main readline (a second
  // readline on stdin would echo every keystroke twice). One-shot mode on a
  // TTY falls back to a dedicated readline.
  type ConfirmReq = Parameters<import('./core/index.js').ConfirmHandler>[0]
  let interactiveConfirm: ((req: ConfirmReq, summary: string) => Promise<boolean>) | undefined
  const describeArgs = (args: Record<string, unknown>): string =>
    Object.entries(args)
      .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.slice(0, 80) : JSON.stringify(v)?.slice(0, 80)}`)
      .join(', ')
  const confirmHandler: import('./core/index.js').ConfirmHandler | undefined =
    approvalMode === 'yolo' || !process.stdin.isTTY
      ? undefined
      : async (req) => {
          const summary = describeArgs(req.args)
          if (interactiveConfirm) return interactiveConfirm(req, summary)
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
          const answer = await new Promise<string>((resolve) =>
            rl.question(`allow ${req.tool.kind} "${req.tool.name}" (${summary})? [y/N] `, resolve),
          ).finally(() => rl.close())
          return /^y(es)?$/i.test(answer.trim())
        }

  const harness = await createHarness({
    config,
    approvalMode: flagMode, // profile/config rows reach the plugin through `config` itself
    renderer: { mode: args.print ? 'headless' : 'repl' },
    confirmHandler,
  })

  const modeLabel = approvalMode === 'yolo' ? 'yolo' : approvalMode

  if (args.print) {
    if (!args.prompt) {
      console.error('error: -p/--print requires a prompt (sakura -p "task")')
      harness.dispose()
      return 2
    }
    try {
      const result = await harness.run(args.prompt)
      return result.error && !result.output ? 1 : 0
    } finally {
      harness.dispose()
    }
  }

  // ------------------------------------------------------------------
  // Interactive REPL
  // ------------------------------------------------------------------

  harness.main(args.resume ? { resumeSessionId: args.resume } : {})
  if (args.resume) {
    try {
      const session = await harness.ctx.sessions.open(args.resume)
      console.log(`resumed session ${session.id} (${session.events.length} events in history)`)
    } catch (error) {
      console.error(`resume failed: ${(error as Error).message}`)
      harness.dispose()
      return 2
    }
  }

  const resolvedModel = resolveModelName(
    (resolveProfile(config).plugins['core-llm']?.config as { model?: string } | undefined)?.model,
  )
  console.log(`SakuraCode v${VERSION} — everything is a plugin`)
  console.log(`  model: ${resolvedModel} · approval: ${modeLabel} · profile: ${config.profile ?? 'default'}`)
  console.log(`  plugins: ${BASE_BUNDLE.length} builtin · tools: ${harness.ctx.tools.names().length}`)
  console.log('  type /help for commands, Ctrl+C twice to exit\n')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[35msakura\x1b[0m> ',
  })
  rl.prompt()

  const updateChecker = new UpdateChecker(VERSION, process.env.SAKURA_UPDATES_URL)
  let updateTimer: ReturnType<typeof setTimeout> | undefined
  if (process.stdin.isTTY && process.env.SAKURA_UPDATES_AUTO_CHECK !== '0') {
    updateTimer = setTimeout(() => {
      void updateChecker.checkAndDetectChange().then(({ info, isNew }) => {
        if (isNew && info.latest) {
          console.log(`\n〔更新〕发现新版本 v${info.latest}（当前 v${VERSION}）— ${info.releaseUrl}`)
          if (!running && !confirming) rl.prompt(true)
        }
      })
    }, 2_000)
    updateTimer.unref()
  }
  harness.ctx.effect(() => () => {
    if (updateTimer) clearTimeout(updateTimer)
    updateChecker.close()
  })

  let running = false
  let confirming = false
  /**
   * Collaborative expert session (CLI side): every user line goes to the main
   * agent AND each live expert; the team dies with /new and /resume (they
   * dispose the roster like the web GUI does on session switch).
   */
  const expertHandles: Array<import('./core/agent.js').AgentHandle> = []
  const expertNames = () => expertHandles.map((h) => h.name).filter((n) => n)
  function expertModeOn(): boolean {
    for (let i = expertHandles.length - 1; i >= 0; i--) {
      if (!harness.ctx.agents.get(expertHandles[i]!.id)) expertHandles.splice(i, 1)
    }
    return expertHandles.length > 0
  }
  const runTeam = async (text: string) => {
    const main = harness.main()
    const members = expertModeOn() ? [...expertHandles] : []
    if (!members.length) return harness.run(text)
    let resolveUser!: (record: { sessionId: string; userSeq: number } | undefined) => void
    const sharedUser = new Promise<{ sessionId: string; userSeq: number } | undefined>(resolve => { resolveUser = resolve })
    const turn = main.turn(text, { expertMode: true, onUserMessage: record => resolveUser(record) })
    void turn.finally(() => resolveUser(undefined)).catch(() => {})
    return Promise.all([turn, ...members.map(handle => handle.turn(text, { sharedUser, expertMode: true }))])
  }
  interactiveConfirm = async (req, summary) => {
    confirming = true
    try {
      const answer = await new Promise<string>((resolve) =>
        rl.question(`allow ${req.tool.kind} "${req.tool.name}" (${summary})? [y/N] `, resolve),
      )
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      confirming = false
    }
  }
  const retry = harness.ctx.peek<import('./core/retry.js').RetryService>('retry')
  if (retry && process.stdin.isTTY) retry.setConfirmHandler(async request => {
    if (confirming) return false
    confirming = true
    try {
      console.log(`\n自动重试已暂停（${request.retries}/${request.maxRetries} 次，${request.windowMs / 1000} 秒窗口）：${request.error}`)
      const answer = await new Promise<string>(resolve => {
        const abort = (): void => resolve('')
        request.signal?.addEventListener('abort', abort, { once: true })
        rl.question('确认再请求一次模型？不会重放已执行工具。[y/N] ', value => { request.signal?.removeEventListener('abort', abort); resolve(value) })
      })
      return /^y(es)?$/i.test(answer.trim())
    } finally { confirming = false }
  })
  // exit_plan: the model's plan proposals route through the same readline.
  type PlanReq = { id: string; plan: string }
  const planService = harness.ctx.peek<{
    setHandler(handler: ((req: PlanReq) => Promise<'approve' | 'reject' | null>) | undefined): void
  }>('plan')
  if (planService && process.stdin.isTTY) {
    planService.setHandler(async (p) => {
      confirming = true
      try {
        console.log(`\n📋 计划：\n${p.plan}`)
        const answer = await new Promise<string>((resolve) => rl.question('批准执行？[y/N] ', resolve))
        return /^y(es)?$/i.test(answer.trim()) ? 'approve' : 'reject'
      } finally {
        confirming = false
      }
    })
  }
  // ask_user: the model's structured questions route through the same readline.
  type QuestionReq = { id: string; question: string; options: string[] }
  const interaction = harness.ctx.peek<{
    setHandler(handler: ((req: QuestionReq) => Promise<string | null>) | undefined): void
  }>('interaction')
  if (interaction && process.stdin.isTTY) {
    interaction.setHandler(async (q) => {
      confirming = true
      try {
        console.log(`\n? ${q.question}`)
        q.options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`))
        const answer = await new Promise<string>((resolve) =>
          rl.question(`choice [1-${q.options.length}] or free text (empty = skip): `, resolve),
        )
        const trimmed = answer.trim()
        const n = Number(trimmed)
        if (Number.isInteger(n) && n >= 1 && n <= q.options.length) return q.options[n - 1]!
        return trimmed || null
      } finally {
        confirming = false
      }
    })
  }
  const READ_ONLY_SLASH = new Set(['/help', '/agents', '/sessions', '/tools', '/plugins', '/mode', '/skills', '/memory', '/model', '/thinking', '/export', '/hooks', '/permissions'])
  /** stdin hit EOF while a turn (or a model-backed slash command) was running: finish it, then exit. */
  let pendingExit = false
  let slashInFlight = false
  /**
   * stdin closed while a turn (or model-backed slash command) was running:
   * run it to completion, then let the process wind down. Calling
   * process.exit() here trips a libuv "handle already closing" assertion on
   * Windows because readline's stdin teardown is still in flight; draining the
   * loop (plus harness.dispose()) exits cleanly and still flushes sessions.
   */
  const maybeExitAfterTurn = (): void => {
    if (!pendingExit) return
    pendingExit = false
    harness.dispose()
    process.exitCode = 0
  }
  rl.on('line', (line) => {
    const text = line.trim()
    if (confirming) return // the pending confirm question() consumes this line
    if (running || slashInFlight) {
      if (text.startsWith('/') && READ_ONLY_SLASH.has(text.split(/\s+/)[0] ?? '')) {
        void handleSlash(text).catch(() => {})
      } else if (text) {
        console.log('(busy — wait for the current turn to finish, or press Ctrl+C to interrupt)')
      }
      return
    }
    if (!text) {
      rl.prompt()
      return
    }
    if (text.startsWith('/')) {
      slashInFlight = true
      handleSlash(text)
        .catch((error) => console.log(`error: ${(error as Error).message}`))
        .finally(() => {
          slashInFlight = false
          if (pendingExit) {
            maybeExitAfterTurn()
            return
          }
          rl.prompt()
        })
      return
    }
    running = true
    // @-mentions: @path[:line] tokens expand into appended context blocks.
    void (async () => {
      const { expandMentions } = await import('./mentions/index.js')
      const expansion = expandMentions(text, { cwd: process.cwd() })
      for (const miss of expansion.missing) console.log(`[mention] ${miss.mention}: ${miss.reason}`)
      return expansion.text
    })()
      .then(runTeam)
      .then(() => {})
      .catch((error) => console.error(`[error] ${(error as Error).message}`))
      .finally(() => {
        running = false
        if (pendingExit) {
          maybeExitAfterTurn()
          return // stdin already closed — no prompt, the exit is scheduled
        }
        rl.prompt()
      })
  }).on('close', () => {
    // Piped input (`echo "task" | sakura`) reaches EOF right after its last
    // line, so the turn the 'line' handler just started would be killed here
    // mid-flight. Defer to its completion instead; Ctrl+D with nothing
    // running still exits immediately, and Ctrl+C can still interrupt.
    if (running || slashInFlight) {
      pendingExit = true
      return
    }
    harness.dispose()
    process.exit(0)
  })

  // Validate the destination before releasing the current roster and history.
  async function switchMainSession(id?: string): Promise<string> {
    if (harness.ctx.agents.list().some((agent) => agent.status === 'running')) {
      throw new Error('agents are running; interrupt them or wait before switching sessions')
    }
    const sessionId = id ? (await harness.ctx.sessions.open(id)).id : (await harness.ctx.sessions.create()).id
    if (harness.ctx.agents.list().some((agent) => agent.status === 'running')) {
      throw new Error('agents started work while the session was opening; retry after completion')
    }
    harness.ctx.agents.disposeAll()
    expertHandles.length = 0
    harness.main({ resumeSessionId: sessionId })
    // A fresh main agent is born with the configured default model — carry the
    // `/model` switch over so the selection survives /new and /resume.
    applySelectedModel()
    return sessionId
  }

  /**
   * `/model` must reach the wire: the loop reads `agent.model` when each turn
   * starts, so the selection is written onto the main agent's handle (the
   * object the loop reads from). Subagents keep their own pinned models.
   */
  function applySelectedModel(): void {
    const model = harness.ctx.llm.selectedModel()
    if (model) (harness.main() as { model: string }).model = model
  }

  async function handleSlash(text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ')
    switch (cmd) {
      case '/help':
        console.log(usage())
        break
      case '/exit':
      case '/quit':
        harness.dispose()
        process.exit(0)
        break
      case '/mode': {
        const mode = arg as ApprovalMode
        if (!APPROVAL_MODES.includes(mode)) {
          console.log(`modes: ${APPROVAL_MODES.join(', ')} (current: ${harness.ctx.approval.mode})`)
        } else {
          harness.ctx.approval.setMode(mode)
          console.log(`approval mode → ${mode}`)
        }
        break
      }
      case '/thinking': {
        const levels = ['off', 'low', 'medium', 'high'] as const
        if (!levels.includes(arg as (typeof levels)[number])) {
          console.log(`thinking: ${levels.join(', ')} (current: ${harness.ctx.llm.thinking})`)
        } else {
          harness.ctx.llm.setThinking(arg as (typeof levels)[number])
          console.log(`thinking → ${arg}`)
        }
        break
      }
      case '/model': {
        if (!arg) {
          for (const m of harness.ctx.llm.listModels()) {
            console.log(`${m.default ? '*' : ' '} ${m.adapter.padEnd(20)} ${m.model ?? ''}`)
          }
          console.log('usage: /model <adapter-or-model-name>')
        } else {
          try {
            const selection = harness.ctx.llm.select(arg)
            applySelectedModel()
            console.log(`model → ${selection.model ?? arg} (new turns use it; existing agents keep theirs)`)
          } catch (error) {
            console.log(`model switch failed: ${(error as Error).message}`)
          }
        }
        break
      }
      case '/agents': {
        const list = harness.ctx.agents.list()
        if (!list.length) console.log('no agents spawned yet')
        for (const agent of list) {
          console.log(`${agent.id} ${agent.name} — ${agent.status}${agent.result ? ` · ${agent.result.slice(0, 80)}` : ''}`)
        }
        break
      }
      case '/experts': {
        // usage: /experts (status) | /experts on [opening task] | /experts off
        const sub = rest[0] ?? 'status'
        if (sub === 'off') {
          expertHandles.length = 0
          harness.ctx.agents.setExpertMemoryMode(harness.main().id, false)
          console.log('专家协同模式已关闭；专家成员保留在 /agents 花名册中，可继续投递消息。')
          break
        }
        if (sub !== 'on' && sub !== 'status') {
          console.log('usage: /experts | /experts on [开场任务] | /experts off')
          break
        }
        if (sub === 'status') {
          if (!expertModeOn()) console.log('专家协同模式关闭中。/experts on [开场任务] 开启三人专家组并行处理同一个任务。')
          else for (const name of expertNames()) console.log(`${name} — 专家（专家模式开启，每条消息同时发给主智能体与全部专家）`)
          break
        }
        const task = rest.slice(1).join(' ').trim()
        harness.main()
        const { spawned, reused, skipped } = spawnExperts(harness.ctx.agents)
        expertHandles.splice(0, expertHandles.length, ...spawned, ...reused)
        if (!expertHandles.length) {
          console.log('专家名称与普通成员冲突；请用 /agents 查看花名册。')
          break
        }
        console.log(`专家协同模式已开启：${expertNames().join('、')}${skipped.length ? `（${skipped.join('、')}重名，未加入）` : ''}。`)
        console.log('之后每条消息同时发给主智能体与全部专家；/experts off 关闭分发。')
        if (task) {
          const { expandMentions } = await import('./mentions/index.js')
          const expansion = expandMentions(task, { cwd: process.cwd() })
          for (const miss of expansion.missing) console.log(`[mention] ${miss.mention}: ${miss.reason}`)
          await runTeam(expansion.text)
        }
        break
      }
      case '/update': {
        const { info } = await updateChecker.checkAndDetectChange()
        if (info.error) console.log(`检查更新失败：${info.error}`)
        else if (info.hasUpdate) console.log(`发现新版本 v${info.latest}（当前 v${info.current}）：https://github.com/Guyao146/SakuraCode/releases/latest`)
        else console.log(`已是最新版本 v${info.current}。`)
        break
      }
      case '/tools':
      case '/plugins': {
        if (cmd === '/tools') {
          for (const tool of harness.ctx.tools.list()) console.log(`${tool.name.padEnd(24)} ${tool.kind.padEnd(8)} ${tool.description.split('.')[0]}`)
        } else {
          const registry = harness.ctx.peek<PluginRegistry>('plugins')
          for (const entry of registry?.list() ?? []) console.log(`${entry.name.padEnd(24)} ${entry.source.padEnd(8)} ${entry.description ?? ''}`)
        }
        break
      }
      case '/sessions': {
        for (const meta of await harness.ctx.sessions.list()) console.log(`${meta.id}  ${meta.events} events  ${meta.startedAt}`)
        break
      }
      case '/resume': {
        if (!arg) {
          console.log('usage: /resume <session-id>   (list ids with /sessions)')
          break
        }
        try {
          await switchMainSession(arg)
          const session = await harness.ctx.sessions.open(arg)
          console.log(`resumed session ${session.id} (${session.events.length} events) — new turns extend it`)
        } catch (error) {
          console.log(`resume failed: ${(error as Error).message}`)
        }
        break
      }
      case '/new': {
        const sessionId = await switchMainSession()
        console.log(`started new session ${sessionId}`)
        break
      }
      case '/export': {
        const exporter = harness.ctx.peek<{ toMarkdown(sessionId: string): Promise<string> }>('sessionExport')
        if (!exporter) {
          console.log('session export plugin is not mounted')
          break
        }
        const sessionId = harness.main().sessionId
        const md = await exporter.toMarkdown(sessionId)
        const { writeFileSync } = await import('node:fs')
        const file = arg || `session-${sessionId}.md`
        writeFileSync(file, md, 'utf8')
        console.log(`exported ${md.length} chars → ${file}`)
        break
      }
      case '/skills': {
        const skills = harness.ctx.peek<{ list(): Array<{ name: string; description: string; source: string; whenToUse?: string }> }>('skills')
        const list = skills?.list() ?? []
        if (!list.length) console.log('no skills found — put them at .sakura/skills/<name>/SKILL.md or ~/.sakura/skills/')
        for (const s of list) {
          console.log(`${s.name.padEnd(20)} [${s.source}] ${s.description}${s.whenToUse ? `  (when: ${s.whenToUse})` : ''}`)
        }
        break
      }
      case '/compact': {
        const compaction = harness.ctx.peek<{
          compact(sessionId: string, opts?: { focus?: string }): Promise<{ summary: string; deferred?: boolean }>
        }>('compaction')
        if (!compaction) {
          console.log('compaction plugin is not mounted')
          break
        }
        const session = harness.main().sessionId
        console.log('compacting session — summarizing older turns with the model…')
        const { summary, deferred } = await compaction.compact(session, arg ? { focus: arg } : undefined)
        console.log(
          deferred
            ? 'compaction deferred — a step is still running; retry once the turn finishes (the marker must not land mid-step)'
            : `compacted: ${summary.length} chars of summary now stand in for the older turns`,
        )
        break
      }
      case '/usage': {
        // Sum the real usage rows logged on assistant/message events.
        const sessionId = harness.main().sessionId
        if (!isSessionId(sessionId)) {
          console.log('no session yet — send a message first')
          break
        }
        const session = await harness.ctx.sessions.open(sessionId)
        const stats = summarizeUsage(session.events)
        const inT = stats.inputTokens, outT = stats.outputTokens, cached = stats.cachedTokens
        const rate = inT ? Math.round((cached * 100) / inT) : 0
        console.log(`session ${sessionId} — ${stats.requests} model request(s)`)
        console.log(`input  ${inT.toLocaleString()} tokens (cache hits ${cached.toLocaleString()} · ${rate}%)`)
        console.log(`output ${outT.toLocaleString()} tokens${stats.reasoningTokens ? ` (reasoning ${stats.reasoningTokens.toLocaleString()})` : ''}`)
        console.log(`context estimate ${estimateMessagesTokens(session.deriveMessages()).toLocaleString()} tokens (heuristic, not for billing)`)
        break
      }
      case '/memory': {
        const pm = harness.ctx.peek<{ files(): Array<{ path: string; chars: number }> }>('projectMemory')
        const files = pm?.files() ?? []
        if (!files.length) console.log('no AGENTS.md found from the working directory upward')
        for (const f of files) console.log(`${f.path}  (${f.chars} chars)`)
        const memory = await harness.ctx.peek<import('./plugins/workspace-memory.js').WorkspaceMemoryService>('workspaceMemory')?.reload()
        if (memory) {
          console.log(`workspace memory: ${memory.enabled ? 'enabled' : 'disabled'} — ${memory.path} (${memory.content.length} chars)`)
          if (memory.error) console.log(memory.error)
          else if (memory.enabled && memory.content) console.log(memory.content)
        }
        break
      }
      case '/hooks': {
        const hooks = harness.ctx.peek<{ rules(): Array<{ event: string; script: string; matcher?: string }> }>('hooks')
        const rules = hooks?.rules() ?? []
        if (!rules.length) {
          console.log('no hooks configured — .sakura/hooks/*.json or config hooks')
          break
        }
        for (const h of rules) {
          console.log(`${h.event.padEnd(16)} ${h.script}${h.matcher ? `  (tools: ${h.matcher})` : ''}`)
        }
        break
      }
      case '/permissions': {
        const engine = harness.ctx.approval.engine
        const rules = engine?.rules() ?? []
        if (!rules.length) {
          console.log('no permission rules — every tool call uses the current approval mode')
          break
        }
        for (const r of rules) {
          console.log(`${r.effect.padEnd(6)} tools=${(r.tools ?? '*').padEnd(16)}${r.reason ? `  # ${r.reason}` : ''}`)
        }
        const allowed = engine?.sessionAllowed() ?? []
        if (allowed.length) console.log(`allowed for this session: ${allowed.join(', ')}`)
        break
      }
      default: {
        // Custom slash commands: .sakura/commands/<name>.md → expanded prompt.
        const name = (cmd ?? '').slice(1)
        if (!name) {
          console.log(`unknown command ${cmd} — try /help`)
          break
        }
        const { listCommands, expandCommand } = await import('./skills/commands.js')
        const hit = listCommands(process.cwd()).find((c) => c.name === name)
        if (!hit) {
          console.log(`unknown command ${cmd} — try /help`)
          break
        }
        const expanded = expandCommand(hit.file, arg)
        console.log(`[${hit.source}] /${hit.name} — running…`)
        running = true
        try {
          await harness.run(expanded.prompt)
        } finally {
          running = false
        }
      }
    }
  }

  return 0
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code
  })
  .catch((error) => {
    console.error(`fatal: ${(error as Error).message}`)
    process.exit(1)
  })
