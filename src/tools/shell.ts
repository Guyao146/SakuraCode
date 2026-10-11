/**
 * tool-shell — bash / pwsh. Shape: { command, description, timeoutMs, workdir,
 * run_in_background }. The background option requires ctx.jobs; without the
 * jobs seam it is simply unavailable.
 */

import { spawn } from 'node:child_process'
import type { PluginModule } from '../kernel/index.js'
import type { ToolDefinition } from '../core/types.js'
import type { ToolsService } from '../core/tools.js'
import {
  killProcessTree,
  missingShellMessage,
  resolveShell,
  shellSpawnDetached,
  type ShellKind,
} from '../core/shell.js'
import { resolvePath, truncate } from './util.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_CAPTURE = 60_000

function runShell(
  resolved: { exe: string; args: string[] },
  command: string,
  opts: { timeoutMs?: number; workdir?: string; signal?: AbortSignal },
): Promise<{ output: string; isError?: boolean }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(resolved.exe, [...resolved.args, command], {
        cwd: opts.workdir ? resolvePath(opts.workdir) : process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group on POSIX so a timeout kills the whole tree.
        detached: shellSpawnDetached(),
      })
    } catch (error) {
      resolve({ output: `error: failed to start ${resolved.exe}: ${(error as Error).message}`, isError: true })
      return
    }
    let out = ''
    let killed = false
    const capture = (chunk: Buffer) => {
      if (out.length < MAX_CAPTURE) out += chunk.toString('utf8')
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    const onAbort = () => {
      killed = true
      killProcessTree(child)
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timer = setTimeout(() => {
      killed = true
      killProcessTree(child)
    }, timeoutMs)
    // Give a stuck tree a second chance with an escalated kill.
    const escalation = setTimeout(() => {
      if (!child.killed) killProcessTree(child)
    }, timeoutMs + 5_000)

    let settled = false
    const finish = (result: { output: string; isError?: boolean }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(escalation)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve(result)
    }

    child.on('error', (error) => {
      finish({ output: `error: failed to start ${resolved.exe}: ${error.message}`, isError: true })
    })
    child.on('close', (code) => {
      const suffix = killed
        ? `\n[exit code: ${code ?? 'null'} — killed (${opts.signal?.aborted ? 'interrupted' : `${timeoutMs}ms timeout`})]`
        : `\n[exit code: ${code ?? 'null'}]`
      // A killed or timed-out command is a tool error, not a successful result.
      finish({ output: truncate((out || '(no output)') + suffix), isError: killed || undefined })
    })
  })
}

export const shellToolsPlugin: PluginModule<{ cwd?: string; defaultTimeoutMs?: number }> = {
  name: 'tool-shell',
  description: 'bash / pwsh — run shell commands, optionally in the background via ctx.jobs',
  inject: ['tools'],
  config: {
    type: 'object',
    properties: { defaultTimeoutMs: { type: 'number', description: 'default per-command timeout' } },
  },
  apply(ctx, config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const cwd = config?.cwd ?? process.cwd()
    const defaultTimeoutMs = config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

    const shellTool = (shell: ShellKind): ToolDefinition => {
      const isBash = shell === 'bash'
      const resolved = resolveShell(shell)
      return {
        name: shell,
        description: (isBash
          ? 'Run a shell command via bash -c. Prefer this for quick cross-platform commands; '
          : 'Run a PowerShell command. Use native C:\\... Windows paths; ') +
          'use run_in_background for long-running jobs (output via job_output).' +
          (resolved ? '' : ` Currently unavailable: no ${shell} interpreter was found on this machine.`),
        kind: 'execute' as const,
        parameters: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'One-line description of what this command does.' },
            command: { type: 'string', description: `The ${isBash ? 'bash' : 'PowerShell'} command to run.` },
            timeoutMs: { type: 'number', description: `Kill the command after this many ms (default ${defaultTimeoutMs}).` },
            workdir: { type: 'string', description: 'Working directory (default: current directory).' },
            run_in_background: {
              type: 'boolean',
              description: 'Start as a background job and return a job id immediately.',
            },
          },
          required: ['command'],
        },
        execute: async (args, tc) => {
          const command = String(args.command ?? '')
          if (!command.trim()) return { output: 'error: command must be non-empty', isError: true }
          if (args.run_in_background) {
            const jobs = ctx.peek<{ start(command: string, shell: ShellKind, cwd: string): { id: string } }>('jobs')
            if (!jobs) {
              return { output: 'error: run_in_background requires the core-jobs service (not mounted).', isError: true }
            }
            const job = jobs.start(command, shell, resolvePath(String(args.workdir ?? '.'), cwd))
            return { output: `started background ${shell} job ${job.id}; poll with job_output("${job.id}")` }
          }
          if (tc.signal.aborted) return { output: 'error: cancelled', isError: true }
          // Re-resolve per call: a long-lived REPL picks up an install that
          // happened (or a SAKURA_BASH that was set) after startup.
          const shellPath = resolved ?? resolveShell(shell)
          if (!shellPath) return { output: missingShellMessage(shell), isError: true }
          return runShell(shellPath, command, {
            timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : defaultTimeoutMs,
            workdir: resolvePath(String(args.workdir ?? '.'), cwd),
            signal: tc.signal,
          })
        },
      }
    }

    tools.register(shellTool('bash'))
    tools.register(shellTool('pwsh'))
  },
}
