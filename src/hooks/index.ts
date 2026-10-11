/**
 * core-hooks — user-defined shell hooks on kernel lifecycle events.
 *
 * Mapping (HookConfig.event → kernel event):
 *   pre-tool-call  → tools/pre-execute (waterfall) — veto gate: exit 0 allows
 *                    the call, anything else (non-zero exit, timeout, spawn
 *                    failure) sets payload.blockedReason and short-circuits,
 *                    so the tool never executes. Matching hooks run serially
 *                    in config order; the first veto stops the rest.
 *   post-tool-call → tools/post-execute (waterfall) — observer: the payload
 *                    is passed through untouched; a failing hook only emits
 *                    kernel/error and never affects the tool result.
 *   turn-end       → turn/end (emit) — observer, failures only kernel/error.
 *   session-start  → ui/turn/start (emit) — the kernel has no session/start
 *                    event, so this stands in: every turn start fires the
 *                    session-start hooks (once per turn, not once per
 *                    process). Failures only emit kernel/error.
 *
 * Hook processes receive the event context as SAKURA_* environment variables
 * (SAKURA_EVENT, SAKURA_TOOL_NAME, SAKURA_TOOL_ARGS, SAKURA_TOOL_OUTPUT —
 * truncated to 4000 chars, SAKURA_SESSION_ID, SAKURA_AGENT_ID,
 * SAKURA_TURN_ERROR) and the full JSON payload {event, tool, args, output,
 * sessionId, agentId} on stdin.
 *
 * matcher filters tool-event hooks by glob against the tool name ('*'
 * wildcard, e.g. 'write*', 'bash'); an unset matcher matches every tool.
 * Events without a tool name (turn-end / session-start) ignore matcher.
 * Default timeout is 30s (timeoutMs overrides); a timed-out hook is killed
 * (win32: taskkill /PID <pid> /T /F, posix: process-group SIGKILL) and
 * counted as a failure — i.e. a veto for pre-tool-call, a kernel/error note
 * for the observer events.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Context, Plugin } from '../kernel/index.js'
import type { ToolsExecutePayload } from '../core/tools.js'

export type HookEvent = 'pre-tool-call' | 'post-tool-call' | 'turn-end' | 'session-start'

export const HOOK_EVENTS: HookEvent[] = ['pre-tool-call', 'post-tool-call', 'turn-end', 'session-start']

export interface HookConfig {
  event: HookEvent
  /** Glob against the tool name ('*' wildcard, e.g. 'write*'); unset matches every tool. */
  matcher?: string
  command: string
  timeoutMs?: number
}

export interface HooksPluginConfig {
  cwd?: string
  hooks?: HookConfig[]
}

/** turn/end payload shape (see DefaultAgentLoop in core/agent.ts). */
export interface TurnEndPayload {
  agentId: string
  sessionId: string
  output?: string
  steps?: number
  error?: string
  cancelled?: boolean
}

/** ui/turn/start payload shape (see DefaultAgentLoop in core/agent.ts). */
export interface SessionStartPayload {
  agentId: string
  sessionId: string
}

const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const OUTPUT_TRUNCATE = 4_000 // SAKURA_TOOL_OUTPUT cap
const MAX_CAPTURE = 16_000 // stdout/stderr capture guard
const REASON_STDERR_TAIL = 200

// ---------------------------------------------------------------------------
// matcher — glob ('*' wildcard) against the tool name
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('*')
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`)
}

function matches(matcher: string | undefined, name: string): boolean {
  if (!matcher) return true
  return globToRegExp(matcher).test(name)
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

interface HookResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

/** Kill a spawned shell and its process tree (mirrors tool-shell). */
function killTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill()
    return
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}

/** Run one hook command; never throws — every failure lands in the result. */
function runHook(hook: HookConfig, env: Record<string, string>, payload: Record<string, unknown>, cwd: string, signal: AbortSignal): Promise<HookResult> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, {
      shell: true,
      cwd,
      env: { ...process.env, ...env },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const onAbort = () => killTree(child)
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)
    // Give a stuck tree a second chance with an escalated kill (mirrors tool-shell).
    const escalation = setTimeout(() => {
      if (!child.killed && !settled) killTree(child)
    }, timeoutMs + 2_000)

    const finish = (result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      signal.removeEventListener('abort', onAbort)
      resolve({ ...result, ok: !signal.aborted && !result.spawnError && !result.timedOut && result.code === 0 })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString('utf8')
    })
    // A hook that exits without draining stdin would EPIPE our write — swallow it.
    child.stdin?.on('error', () => {})

    child.on('error', (error) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: error.message })
    })
    child.on('close', (code) => {
      finish({ code, stdout, stderr, timedOut })
    })

    child.stdin?.end(JSON.stringify(payload))
  })
}

// ---------------------------------------------------------------------------
// Per-event bookkeeping
// ---------------------------------------------------------------------------

interface HookContextInfo {
  cwd: string
  signal: AbortSignal
  tool?: string
  args?: Record<string, unknown>
  output?: string
  turnError?: string
  sessionId?: string
  agentId?: string
}

function buildEnv(event: HookEvent, info: HookContextInfo): Record<string, string> {
  const env: Record<string, string> = { SAKURA_EVENT: event }
  if (info.tool !== undefined) env.SAKURA_TOOL_NAME = info.tool
  if (info.args !== undefined) env.SAKURA_TOOL_ARGS = JSON.stringify(info.args)
  if (info.output !== undefined) env.SAKURA_TOOL_OUTPUT = info.output.slice(0, OUTPUT_TRUNCATE)
  if (info.sessionId !== undefined) env.SAKURA_SESSION_ID = info.sessionId
  if (info.agentId !== undefined) env.SAKURA_AGENT_ID = info.agentId
  if (info.turnError !== undefined) env.SAKURA_TURN_ERROR = info.turnError
  return env
}

function buildStdin(event: HookEvent, info: HookContextInfo): Record<string, unknown> {
  const payload: Record<string, unknown> = { event, sessionId: info.sessionId, agentId: info.agentId }
  if (info.tool !== undefined) payload.tool = info.tool
  if (info.args !== undefined) payload.args = info.args
  if (info.output !== undefined) payload.output = info.output
  return payload
}

const stderrTail = (stderr: string): string => (stderr ? `: ${stderr.slice(-REASON_STDERR_TAIL)}` : '')

function describeFailure(hook: HookConfig, info: HookContextInfo, result: HookResult): string {
  const target = info.tool ? ` ${info.tool}` : ''
  if (result.spawnError) return `hook "${hook.command}" failed${target}: ${result.spawnError}`
  if (result.timedOut) {
    return `hook "${hook.command}" rejected${target} (timeout after ${hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS}ms)${stderrTail(result.stderr)}`
  }
  return `hook "${hook.command}" rejected${target} (exit ${result.code ?? 'unknown'})${stderrTail(result.stderr)}`
}

/** Run the matching hooks of one event serially in config order; stop at the first failure. */
async function runHooks(hooks: HookConfig[], event: HookEvent, info: HookContextInfo): Promise<{ ok: boolean; reason?: string }> {
  for (const hook of hooks) {
    if (info.signal.aborted) return { ok: false, reason: 'hook cancelled' }
    if (info.tool !== undefined && !matches(hook.matcher, info.tool)) continue
    let result: HookResult
    try {
      result = await runHook(hook, buildEnv(event, info), buildStdin(event, info), info.cwd, info.signal)
    } catch (error) {
      return { ok: false, reason: `hook "${hook.command}" failed: ${(error as Error).message}` }
    }
    if (!result.ok) return { ok: false, reason: describeFailure(hook, info, result) }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const hooksPlugin: Plugin = {
  name: 'core-hooks',
  description: 'User shell hooks: pre-tool-call veto gate plus post-tool-call / turn-end / session-start observers (SAKURA_* env + JSON stdin)',
  config: {
    type: 'object',
    properties: {
      hooks: {
        type: 'array',
        description: 'Shell hooks run at lifecycle points; exit 0 passes, non-zero/timeout vetoes pre-tool-call',
        items: {
          type: 'object',
          properties: {
            event: { type: 'string', enum: HOOK_EVENTS, description: 'lifecycle point that triggers the hook' },
            matcher: { type: 'string', description: "glob against the tool name ('write*', 'bash'); unset matches all" },
            command: { type: 'string', description: 'shell command to run (SAKURA_* env, JSON payload on stdin)' },
            timeoutMs: { type: 'number', description: 'kill the hook after this many ms (default 30000)' },
          },
          required: ['event', 'command'],
        },
      },
    },
  } as const,
  apply(ctx: Context, config?: HooksPluginConfig) {
    const hooks = config?.hooks ?? []
    const cwd = config?.cwd ?? process.cwd()
    const lifetime = new AbortController()
    ctx.effect(() => () => lifetime.abort())
    // Read-only view so the REPL's /hooks command (and diagnostics) can show
    // what is actually wired up. The runtime filters below keep reading
    // `hooks` directly; this projection only reflects the configured rows.
    ctx.provide('hooks')
    ctx.set('hooks', {
      rules: () => hooks.map((h) => ({ event: h.event, script: h.command, matcher: h.matcher })),
    })
    const hooksFor = (event: HookEvent): HookConfig[] =>
      hooks.filter((h) => h.event === event && typeof h.command === 'string' && h.command.trim().length > 0)

    // pre-tool-call — veto gate. Unknown tools skip hooks (nothing to judge),
    // mirroring core-approval's `if (!payload.tool) return next(payload)`.
    ctx.on(
      'tools/pre-execute',
      async (
        payload: ToolsExecutePayload,
        next: (replacement?: ToolsExecutePayload) => Promise<ToolsExecutePayload>,
      ) => {
        const matching = hooksFor('pre-tool-call')
        if (!matching.length || !payload.tool) return next(payload)
        const outcome = await runHooks(matching, 'pre-tool-call', {
          cwd,
          signal: AbortSignal.any([lifetime.signal, payload.tc.signal]),
          tool: payload.name,
          args: payload.args,
          sessionId: payload.tc.sessionId,
          agentId: payload.tc.agentId,
        })
        if (!outcome.ok) {
          payload.blockedReason = outcome.reason
          return payload // short-circuit without next(): the call never executes
        }
        return next(payload)
      },
    )

    // post-tool-call — observer: always pass the payload through; failures
    // are reported on kernel/error and never touch the tool result.
    ctx.on(
      'tools/post-execute',
      async (
        payload: ToolsExecutePayload,
        next: (replacement?: ToolsExecutePayload) => Promise<ToolsExecutePayload>,
      ) => {
        const matching = hooksFor('post-tool-call')
        if (!matching.length) return next(payload)
        const outcome = await runHooks(matching, 'post-tool-call', {
          cwd,
          signal: AbortSignal.any([lifetime.signal, payload.tc.signal]),
          tool: payload.name,
          args: payload.args,
          output: payload.output ?? '',
          sessionId: payload.tc.sessionId,
          agentId: payload.tc.agentId,
        }).catch((error) => ({ ok: false, reason: String((error as Error)?.message ?? error) }))
        if (!outcome.ok) {
          ctx.emit('kernel/error', { event: 'hook:post-tool-call', error: new Error(outcome.reason ?? 'hook failed') })
        }
        return next(payload)
      },
    )

    // turn-end — fire-and-forget emitter context: the listener must never
    // reject, so failures are funneled into kernel/error.
    ctx.on('turn/end', (payload: TurnEndPayload) => {
      const matching = hooksFor('turn-end')
      if (!matching.length) return
      void runHooks(matching, 'turn-end', {
        cwd,
        signal: lifetime.signal,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        turnError: payload.error,
      }).then(
        (outcome) => {
          if (!outcome.ok) {
            ctx.emit('kernel/error', { event: 'hook:turn-end', error: new Error(outcome.reason ?? 'hook failed') })
          }
        },
        (error) => {
          ctx.emit('kernel/error', { event: 'hook:turn-end', error })
        },
      )
    })

    // session-start — stands in on ui/turn/start (the kernel has no
    // session/start): fires once per turn start, not once per process.
    ctx.on('ui/turn/start', (payload: SessionStartPayload) => {
      const matching = hooksFor('session-start')
      if (!matching.length) return
      void runHooks(matching, 'session-start', {
        cwd,
        signal: lifetime.signal,
        sessionId: payload.sessionId,
        agentId: payload.agentId,
      }).then(
        (outcome) => {
          if (!outcome.ok) {
            ctx.emit('kernel/error', { event: 'hook:session-start', error: new Error(outcome.reason ?? 'hook failed') })
          }
        },
        (error) => {
          ctx.emit('kernel/error', { event: 'hook:session-start', error })
        },
      )
    })
  },
}
