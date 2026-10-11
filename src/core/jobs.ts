/**
 * ctx.jobs — background job registry. Shell tools with run_in_background
 * hand their process here; job_* tools inspect it. Without this service the
 * shell tools simply drop the background option (the seam is optional).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { killProcessTree, missingShellMessage, resolveShell, shellSpawnDetached, type ShellKind } from './shell.js'

export interface JobSummary {
  id: string
  command: string
  /** The shell the job runs under (also recorded for display). */
  shell: ShellKind
  status: 'running' | 'done' | 'failed' | 'killed'
  exitCode?: number | null
  startedAt: string
  outputBytes: number
}

export interface JobRecord extends JobSummary {
  file: string
  proc?: ChildProcess
  output?: string
  /** Set when we killed the job ourselves — on Windows a forced kill surfaces as exit code 1, not a signal. */
  killedByUs?: boolean
}

const MAX_CAPTURE = 400_000 // bytes kept in memory per job

let jobSeq = 0

export class JobsService {
  private jobs = new Map<string, JobRecord>()

  constructor(private dir: string) {}

  start(command: string, shell: ShellKind, cwd: string): JobRecord {
    const id = `job-${++jobSeq}`
    const file = path.join(this.dir, `${id}.log`)
    const record: JobRecord = {
      id,
      command,
      shell,
      status: 'running',
      startedAt: new Date().toISOString(),
      outputBytes: 0,
      file,
    }
    this.jobs.set(id, record)

    // A missing interpreter is a configuration problem, not a crash: record it
    // as a failed job whose output explains the fix.
    const resolved = resolveShell(shell)
    if (!resolved) {
      const message = missingShellMessage(shell).replace(/^error: /, '')
      record.status = 'failed'
      record.exitCode = null
      record.output = `# ${message}\n`
      void fs.mkdir(this.dir, { recursive: true }).catch(() => {})
      void fs.writeFile(file, record.output).catch(() => {})
      return record
    }

    // The log directory may not exist yet on a fresh checkout.
    void fs.mkdir(this.dir, { recursive: true }).catch(() => {})

    const child = spawn(resolved.exe, [...resolved.args, command], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: shellSpawnDetached(),
    })
    record.proc = child

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const capture = (chunk: Buffer, decoder: StringDecoder) => {
      record.outputBytes += chunk.length
      if (record.outputBytes <= MAX_CAPTURE) {
        record.output = (record.output ?? '') + decoder.write(chunk)
      }
      void fs.appendFile(file, chunk).catch(() => {})
    }
    child.stdout?.on('data', (chunk: Buffer) => capture(chunk, stdoutDecoder))
    child.stderr?.on('data', (chunk: Buffer) => capture(chunk, stderrDecoder))

    // Spawn failures (ENOENT, bad cwd) arrive as an async 'error' event; an
    // unhandled one would crash the whole CLI. Surface the reason in the log
    // and in job_output instead of leaving the job silently empty.
    child.on('error', (error) => {
      record.status = 'failed'
      record.exitCode = null
      record.proc = undefined
      const note = `# spawn failed: ${error.message}\n`
      record.output = (record.output ?? '') + note
      void fs.appendFile(file, note).catch(() => {})
    })

    child.on('close', (code, signal) => {
      record.output = (record.output ?? '') + stdoutDecoder.end() + stderrDecoder.end()
      record.exitCode = code
      record.status = signal || record.killedByUs ? 'killed' : code === 0 ? 'done' : 'failed'
      record.proc = undefined
      void fs.appendFile(file, `# exit=${code ?? ''} signal=${signal ?? ''}\n`).catch(() => {})
    })
    return record
  }

  /** Kill every live job (called when the harness disposes) so background
   *  children cannot keep the process alive after a one-shot run. */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      if (job.proc) {
        job.killedByUs = true
        killProcessTree(job.proc)
        job.status = 'killed'
        job.proc = undefined
      }
    }
  }

  get(id: string): JobRecord | undefined {
    return this.jobs.get(id)
  }

  list(): JobSummary[] {
    return [...this.jobs.values()].map(({ proc, file, ...rest }) => {
      void proc
      void file
      return rest
    })
  }

  output(id: string, maxBytes = 20_000): string | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    const text = job.output ?? ''
    return text.length > maxBytes ? text.slice(0, maxBytes) + `\n… (truncated, full log: ${job.file})` : text
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job?.proc) return false
    job.killedByUs = true
    killProcessTree(job.proc)
    return true
  }
}

export const jobsPlugin = {
  name: 'core-jobs',
  description: 'Background job registry (ctx.jobs)',
  config: {
    type: 'object',
    properties: { dir: { type: 'string', description: 'where job logs live' } },
  } as const,
  apply(ctx: import('../kernel/index.js').Context, config?: { dir?: string }) {
    ctx.provide('jobs')
    const service = new JobsService(config?.dir ?? '.sakura/jobs')
    ctx.set('jobs', service)
    ctx.effect(() => () => service.stopAll())
  },
}
