/**
 * core/shell — cross-platform shell discovery and process-tree teardown.
 *
 * The shell tools and ctx.jobs both need a real interpreter, but "bash
 * exists" is platform-dependent: on Windows it is almost never on PATH
 * (Git for Windows keeps it under its own `bin/`, WSL exposes
 * `System32\bash.exe`, MSYS2/Cygwin have their own roots). Spawning a
 * hard-coded `bash.exe` therefore fails with ENOENT on a machine where
 * bash is installed and perfectly usable.
 *
 * Resolution order (first hit wins), cached for the process lifetime:
 *   env override (`SAKURA_BASH` / `SAKURA_PWSH`)
 *   → executable on PATH (preference order per shell kind)
 *   → well-known install locations
 *
 * `killProcessTree` lives here too: it is the other half of "run a shell",
 * and both the foreground tool and ctx.jobs must tear a shell down the same
 * way.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import * as path from 'node:path'

export type ShellKind = 'bash' | 'pwsh'

export interface ResolvedShell {
  kind: ShellKind
  /** Executable to spawn (absolute where we had to look one up). */
  exe: string
  /** Arguments that must precede the command string. */
  args: string[]
  /** How the executable was found — surfaced in diagnostics. */
  source: ShellSource
}

export type ShellSource = 'env' | 'path' | 'well-known'

const IS_WINDOWS = process.platform === 'win32'

/** Executable names per kind, in preference order. */
const EXE_NAMES: Record<ShellKind, string[]> = {
  bash: IS_WINDOWS ? ['bash.exe'] : ['bash'],
  // PowerShell 7 first, then the Windows PowerShell 5.1 that ships with Windows.
  pwsh: IS_WINDOWS ? ['pwsh.exe', 'powershell.exe'] : ['pwsh'],
}

/** Env var that overrides discovery for a shell kind. */
export const SHELL_ENV: Record<ShellKind, string> = { bash: 'SAKURA_BASH', pwsh: 'SAKURA_PWSH' }

function argsFor(kind: ShellKind): string[] {
  return kind === 'bash' ? ['-c'] : ['-NoProfile', '-Command']
}

function isExecutableFile(file: string): boolean {
  try {
    const info = statSync(file)
    if (!info.isFile()) return false
    // Windows has no executable bit; the extension check already happened.
    return IS_WINDOWS ? true : (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Scan PATH for the first of `names`. Preference order is honoured across
 * directories (every PATH entry is tried for `pwsh.exe` before any is tried
 * for `powershell.exe`) so the documented preference is not defeated by
 * directory ordering.
 */
function findOnPath(names: string[]): string | undefined {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const name of names) {
    const candidates = path.extname(name) ? [name] : exts.map((ext) => name + (ext.startsWith('.') ? ext : `.${ext}`))
    for (const dir of entries) {
      for (const candidate of candidates) {
        const file = path.join(dir, candidate)
        if (isExecutableFile(file)) return file
      }
    }
  }
  return undefined
}

/** Well-known install locations that are typically absent from PATH. */
function wellKnownLocations(kind: ShellKind): string[] {
  const env = process.env
  const roots = [
    env['ProgramFiles'],
    env['ProgramFiles(x86)'],
    env['ProgramW6432'],
    env['LOCALAPPDATA'] && path.join(env['LOCALAPPDATA'], 'Programs'),
  ]
  const found: string[] = []
  if (IS_WINDOWS && kind === 'bash') {
    for (const root of roots) {
      if (!root) continue
      found.push(path.join(root, 'Git', 'bin', 'bash.exe'), path.join(root, 'Git', 'usr', 'bin', 'bash.exe'))
    }
    // MSYS2 default root on the system drive.
    const systemDrive = env['SystemDrive'] ?? 'C:'
    found.push(path.join(systemDrive, 'msys64', 'usr', 'bin', 'bash.exe'))
    // WSL's launcher; last resort because it fails without an installed distro.
    if (env['SystemRoot']) found.push(path.join(env['SystemRoot'], 'System32', 'bash.exe'))
    return found
  }
  if (kind === 'pwsh') {
    if (!IS_WINDOWS) return ['/usr/bin/pwsh', '/usr/local/bin/pwsh', '/opt/microsoft/powershell/7/pwsh']
    if (env['ProgramFiles']) found.push(path.join(env['ProgramFiles'], 'PowerShell', '7', 'pwsh.exe'))
    if (env['SystemRoot']) {
      found.push(path.join(env['SystemRoot'], 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    }
    return found
  }
  // POSIX bash: the canonical locations, then the POSIX-mandated /bin/sh.
  return ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/bin/sh']
}

// Cache per kind; `null` records a definitive miss so PATH is not rescanned
// on every tool call. resetShellCache() exists for tests and for callers that
// mutate PATH/SAKURA_* at runtime.
const cache = new Map<ShellKind, ResolvedShell | null>()

function discover(kind: ShellKind): ResolvedShell | undefined {
  const override = process.env[SHELL_ENV[kind]]?.trim()
  if (override) {
    if (isExecutableFile(override)) return { kind, exe: override, args: argsFor(kind), source: 'env' }
    // A broken override should not silently fall through to a different shell
    // than the operator asked for — but a working default beats no shell at
    // all, so warn on stderr and keep looking.
    process.emitWarning(`${SHELL_ENV[kind]}="${override}" is not an executable file; falling back to discovery`)
  }
  const onPath = findOnPath(EXE_NAMES[kind])
  if (onPath) return { kind, exe: onPath, args: argsFor(kind), source: 'path' }
  for (const candidate of wellKnownLocations(kind)) {
    if (isExecutableFile(candidate)) return { kind, exe: candidate, args: argsFor(kind), source: 'well-known' }
  }
  return undefined
}

/**
 * Resolve a shell interpreter, or undefined when the platform genuinely has
 * none. Results are cached; call resetShellCache() after changing PATH or the
 * SAKURA_* overrides.
 */
export function resolveShell(kind: ShellKind): ResolvedShell | undefined {
  const hit = cache.get(kind)
  if (hit !== undefined) return hit ?? undefined
  const resolved = discover(kind)
  cache.set(kind, resolved ?? null)
  return resolved
}

/** Drop the memoized resolutions (tests, and callers that mutate PATH). */
export function resetShellCache(): void {
  cache.clear()
}

/** One-line resolution report for diagnostics: `bash → C:\...\bash.exe (well-known)`. */
export function describeShell(kind: ShellKind): string {
  const resolved = resolveShell(kind)
  return resolved ? `${kind} → ${resolved.exe} (${resolved.source})` : `${kind} → not found`
}

/** Actionable message for tools that need a shell this machine does not have. */
export function missingShellMessage(kind: ShellKind): string {
  const hint =
    kind === 'bash'
      ? IS_WINDOWS
        ? 'Install Git for Windows (https://git-scm.com/download/win) or set SAKURA_BASH to your bash.exe.'
        : 'Install bash, or set SAKURA_BASH to the interpreter to use.'
      : 'Install PowerShell 7 (pwsh), or set SAKURA_PWSH to the interpreter to use.'
  return `error: no ${kind} interpreter found on this machine. ${hint}`
}

/**
 * Kill a spawned shell and its whole process tree.
 *
 * A bare `child.kill()` only signals the direct child: on Windows a shell's
 * grandchildren (`npm run …`, `sleep 5`) survive and keep the stdio pipes
 * open, so the 'close' event — and every status transition that waits on it —
 * never arrives. POSIX children are spawned in their own process group (see
 * `detached` at the call sites) so `kill(-pid)` reaches the whole tree.
 *
 * Never throws: killing an already-exited or never-spawned child raises
 * EINVAL/ESRCH on Windows, which must not escape into job bookkeeping.
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  // No pid means spawn failed (ENOENT) — the handle is dead and kill() throws.
  if (!pid || child.exitCode !== null || child.signalCode !== null) return
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => {})
    } catch {
      /* taskkill unavailable — the direct kill below is the fallback */
    }
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** Spawn options that put a POSIX child in its own process group (see killProcessTree). */
export function shellSpawnDetached(): boolean {
  return !IS_WINDOWS
}
