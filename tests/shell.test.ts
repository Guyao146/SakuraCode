/**
 * core/shell — cross-platform shell resolution and process-tree teardown.
 * The resolver's discovery order (env → PATH → well-known locations) is
 * exercised with a fake override; the machine's real shells are only used to
 * smoke-test that SOMETHING resolves when the platform has an interpreter.
 */

import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  describeShell,
  killProcessTree,
  resolveShell,
  resetShellCache,
  SHELL_ENV,
} from '../src/core/shell.js'

const ORIGINAL_BASH = process.env[SHELL_ENV.bash]
const ORIGINAL_PWSH = process.env[SHELL_ENV.pwsh]

afterEach(() => {
  // Never leak overrides into other suites (or later runs in this worker).
  if (ORIGINAL_BASH === undefined) delete process.env[SHELL_ENV.bash]
  else process.env[SHELL_ENV.bash] = ORIGINAL_BASH
  if (ORIGINAL_PWSH === undefined) delete process.env[SHELL_ENV.pwsh]
  else process.env[SHELL_ENV.pwsh] = ORIGINAL_PWSH
  resetShellCache()
})

describe('resolveShell', () => {
  it('the env override wins over PATH and well-known locations', () => {
    process.env[SHELL_ENV.bash] = process.execPath // node is an executable, good enough to test discovery
    resetShellCache()

    const resolved = resolveShell('bash')
    expect(resolved).toBeDefined()
    expect(resolved!.exe).toBe(process.execPath)
    expect(resolved!.source).toBe('env')
    expect(resolved!.args).toEqual(['-c'])
    expect(resolved!.kind).toBe('bash')
  })

  it('a broken override never wins; discovery falls through', () => {
    process.env[SHELL_ENV.bash] = `${process.cwd()}\\definitely-not-a-shell.exe`
    resetShellCache()

    const resolved = resolveShell('bash')
    // The nonexistent override must not be returned as the interpreter, and
    // must not mask a real one: on a machine with bash (this one has Git Bash)
    // discovery still finds it via path/well-known.
    if (resolved) {
      expect(resolved.source).not.toBe('env')
      expect(resolved.exe).not.toContain('definitely-not-a-shell')
    }
    // The fall-through result is memoized like any other.
    expect(resolveShell('bash')).toEqual(resolved)
  })

  it('results are cached until resetShellCache()', () => {
    delete process.env[SHELL_ENV.bash]
    resetShellCache()
    const first = resolveShell('bash')
    const second = resolveShell('bash')
    expect(second).toEqual(first)
  })

  it('describeShell reports the resolution source', () => {
    resetShellCache()
    const line = describeShell('bash')
    if (resolveShell('bash')) {
      expect(line).toMatch(/^bash → .+ \((env|path|well-known)\)$/)
    } else {
      expect(line).toBe('bash → not found')
    }
  })
})

describe('killProcessTree', () => {
  it('does not throw for an already-exited child (Windows EINVAL regression)', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', () => resolve())
    })
    // The handle is dead: kill() here used to raise `kill EINVAL` on Windows.
    expect(() => killProcessTree(child)).not.toThrow()
  })

  it('kills a live child so the close event fires promptly', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    })
    const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))

    killProcessTree(child)

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('child survived killProcessTree')), 8000),
    )
    await Promise.race([closed, timeout])
  }, 10_000)
})
