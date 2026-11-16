import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { killProcessTree, shellSpawnDetached } from '../core/shell.js'
import { GitReviewError, type GitReviewLimits } from './types.js'
import { inside, localPath, samePath } from './safety.js'

/** No PATH lookup in the workspace; explicit paths belong to the trusted application, not HTTP input. */
export async function resolveGit(explicit?: string): Promise<string | null> {
  const candidates = explicit ? [explicit] : process.platform === 'win32'
    ? ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/mingw64/bin/git.exe', 'C:/Program Files (x86)/Git/cmd/git.exe']
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/bin/git']
  for (const candidate of candidates) {
    localPath(candidate)
    if (process.platform === 'win32' && path.extname(candidate).toLowerCase() !== '.exe') throw new GitReviewError('INVALID_ARGUMENT', 'The trusted Git executable must be a native executable, not a shell wrapper.')
    try {
      const resolved = await fs.realpath(candidate)
      localPath(resolved)
      const info = await fs.stat(resolved)
      if (!info.isFile()) continue
      if (process.platform !== 'win32' && (info.mode & 0o111) === 0) continue
      return resolved
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  return null
}

export interface Operation {
  signal: AbortSignal
  check(): void
  dispose(): void
}

export function operation(timeoutMs: number, source?: AbortSignal): Operation {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  if (source?.aborted) cancel()
  else source?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  timer.unref()
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted) throw new GitReviewError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'Git review timed out.' : 'Git review cancelled.', timedOut ? 408 : 499)
    },
    dispose() { clearTimeout(timer); source?.removeEventListener('abort', cancel) },
  }
}

/** Environment allow-list. In particular no GIT_*, loaders, shell startup, proxy, or credential overrides survive. */
export function safeEnvironment(executable: string, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (process.platform === 'win32') {
    const windows = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
    env.SystemRoot = windows
    env.WINDIR = windows
    env.PATH = [path.dirname(executable), path.join(windows, 'System32')].join(path.delimiter)
  } else env.PATH = [path.dirname(executable), '/usr/bin', '/bin'].join(path.delimiter)
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    TEMP: home, TMP: home, TMPDIR: home, LC_ALL: 'C', LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: path.join(home, 'absent-system-config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'absent-global-config'), GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_PROTOCOL_FROM_USER: '0', GCM_INTERACTIVE: 'never',
  })
  return env
}

const commands = new Set(['ls-files', 'ls-tree', 'cat-file', 'diff-tree', 'check-ignore'])
const safeConfig = [
  'core.fsmonitor=false', 'core.untrackedCache=false', 'core.preloadIndex=false', 'core.quotePath=true',
  'core.pager=', 'core.hooksPath=', 'core.autocrlf=false', 'core.safecrlf=false',
  'core.attributesFile=', 'core.excludesFile=', 'credential.helper=', 'protocol.allow=never',
  'fetch.recurseSubmodules=false', 'submodule.recurse=false', 'diff.external=', 'diff.renames=true',
  'maintenance.auto=false', 'gc.auto=0', 'color.ui=false',
]

export class SafeGitProcess {
  constructor(readonly executable: string, readonly limits: GitReviewLimits, readonly op: Operation) {}

  async run(gitDir: string, cwd: string, args: string[], input?: Buffer, allowedCodes: number[] = [0]): Promise<Buffer> {
    this.op.check()
    const privateRoot = path.dirname(gitDir)
    const temporaryRoot = await fs.realpath(os.tmpdir())
    if (!commands.has(args[0] ?? '') || path.basename(gitDir) !== 'metadata' || !/^sakura-git-read-/.test(path.basename(privateRoot)) ||
        !inside(temporaryRoot, gitDir) || samePath(gitDir, cwd)) {
      throw new GitReviewError('UNSAFE_REPOSITORY', 'Git commands require a private isolated metadata directory.')
    }
    // check-ignore consumes literal filenames on NUL stdin, not pathspecs; Git rejects literal pathspec magic for it.
    const argv = ['--no-pager', ...(args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']), '--no-replace-objects', `--git-dir=${gitDir}`, `--work-tree=${cwd}`,
      ...safeConfig.flatMap(value => ['-c', value]), ...args]
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.executable, argv, {
        cwd, env: { ...safeEnvironment(this.executable, path.dirname(gitDir)),
          ...(args[0] === 'diff-tree' ? { GIT_INDEX_FILE: path.join(path.dirname(gitDir), 'absent-patch-index') } : {}),
          ...(args[0] === 'check-ignore' ? { GIT_LITERAL_PATHSPECS: '0' } : {}),
        }, shell: false,
        windowsHide: true, detached: shellSpawnDetached(), stdio: ['pipe', 'pipe', 'pipe'],
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let failure: Error | null = null
      let closed = false
      const stop = (error: Error) => {
        if (failure || closed) return
        failure = error
        killProcessTree(child)
      }
      const cancel = () => {
        try { this.op.check() } catch (error) { stop(error as Error) }
      }
      this.op.signal.addEventListener('abort', cancel, { once: true })
      if (this.op.signal.aborted) cancel()
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length
        if (outputBytes > this.limits.maxOutputBytes) stop(new GitReviewError('LIMIT_EXCEEDED', 'Git output exceeds the configured byte limit.', 413))
        else if (!failure) target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.once('error', error => { failure ??= new GitReviewError('GIT_FAILED', `Git could not start: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}.`, 503) })
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') stop(error) })
      child.once('close', code => {
        closed = true
        this.op.signal.removeEventListener('abort', cancel)
        if (failure) { reject(failure); return }
        if (!allowedCodes.includes(code ?? -1)) {
          // Limit and decontrol stderr before exposing it as diagnostics, never as an instruction.
          const diagnostic = Buffer.concat(stderr).toString('utf8').slice(0, 600).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
          reject(new GitReviewError('GIT_FAILED', `Git read failed (${args[0]}): ${diagnostic}`, 422))
        } else resolve(Buffer.concat(stdout))
      })
      child.stdin.end(input)
    })
  }
}
