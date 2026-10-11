/**
 * tests/plugin-loading.test.ts — out-of-tree plugin loading: the drop-in
 * pluginsDir scan (plugin folder with index.js + top-level *.js), bundle
 * rows with and without a ./ prefix, name-based dedupe between a bundle row
 * and a drop-in folder, disabled rows, and the two failure paths (an import
 * error rejects createHarness; an apply() error degrades gracefully).
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../src/harness.js'
import type { SakuraConfig } from '../src/config.js'
import type { ToolContext } from '../src/core/index.js'
import type { PluginRegistry } from '../src/tools/index.js'

// -- local helpers (independent of tests/helpers.ts) -------------------------

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const dispose = cleanups.pop()
    await dispose?.()
  }
})

async function tmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-plugin-test-'))
  // Drop-in plugins live outside the repo, so pin the module type — without
  // a nearby package.json, plain .js files would be parsed as CommonJS.
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8')
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
  return dir
}

async function harnessIn(cwd: string, config: SakuraConfig = {}): Promise<Harness> {
  const harness = await createHarness({ cwd, config, approvalMode: 'yolo', renderer: false })
  cleanups.push(() => harness.dispose())
  return harness
}

let callSeq = 0
function call(ctx: Harness['ctx'], name: string, args: unknown = {}) {
  callSeq++
  const tc: ToolContext = { sessionId: 's', agentId: 'a', signal: new AbortController().signal }
  return ctx.tools.execute(`call-${callSeq}`, name, JSON.stringify(args), tc)
}

function registry(ctx: Harness['ctx']): PluginRegistry | undefined {
  return ctx.peek<PluginRegistry>('plugins')
}

// -- plugin fixtures ----------------------------------------------------------

const ECHO_CLOCK_JS = `
export const name = 'echo-clock'
export const description = 'now — test drop-in plugin'
export const inject = ['tools']
export function apply(ctx) {
  ctx.get('tools').register({
    name: 'now',
    description: 'Return the drop-in tick.',
    kind: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: 'tick' }),
  })
}
`

const LOOSE_JS = `
export const name = 'loose'
export const description = 'top-level single-file plugin'
export const inject = ['tools']
export function apply(ctx) {
  ctx.get('tools').register({
    name: 'loose_tool',
    description: 'Tool from a loose top-level plugin file.',
    kind: 'read',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ output: 'loose' }),
  })
}
`

const BAD_JS = `
export const name = 'bad'
export const description = 'plugin whose apply throws'
export const inject = ['tools']
export function apply() {
  throw new Error('boom-from-bad-plugin')
}
`

async function writePluginFile(dir: string, relPath: string, source: string): Promise<void> {
  const file = path.join(dir, relPath)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, source, 'utf8')
}

// -- tests --------------------------------------------------------------------

describe('drop-in plugins (pluginsDir scan)', () => {
  it('mounts a plugin folder with index.js and its tool executes', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/echo-clock/index.js', ECHO_CLOCK_JS)
    const harness = await harnessIn(dir, { pluginsDir: 'plugins' })

    expect(harness.ctx.tools.get('now')).toBeDefined()
    const result = await call(harness.ctx, 'now')
    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('tick')

    const entry = registry(harness.ctx)?.list().find((e) => e.name === 'echo-clock')
    expect(entry?.source).toBe('external')
  })

  it('mounts top-level *.js files in the plugins directory', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/loose.js', LOOSE_JS)
    const harness = await harnessIn(dir, { pluginsDir: 'plugins' })

    expect(harness.ctx.tools.get('loose_tool')).toBeDefined()
    const result = await call(harness.ctx, 'loose_tool')
    expect(result.output).toBe('loose')
  })
})

describe('bundle rows and dedupe', () => {
  it('loads a bundle path without a ./ prefix (importExternal path detection)', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/echo-clock/index.js', ECHO_CLOCK_JS)
    const harness = await harnessIn(dir, { bundles: ['plugins/echo-clock/index.js'] })

    const result = await call(harness.ctx, 'now')
    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('tick')

    const entry = registry(harness.ctx)?.list().find((e) => e.name === 'echo-clock')
    expect(entry?.source).toBe('external')
  })

  it('mounts a plugin listed as a bundle AND present as a drop-in exactly once', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/echo-clock/index.js', ECHO_CLOCK_JS)
    const harness = await harnessIn(dir, {
      pluginsDir: 'plugins',
      bundles: ['plugins/echo-clock/index.js'],
    })

    // One working registration: a second apply() would throw
    // "tool now is already registered" and the mount would degrade.
    const result = await call(harness.ctx, 'now')
    expect(result.isError).toBeFalsy()
    expect(result.output).toBe('tick')

    const rows = registry(harness.ctx)?.list().filter((e) => e.name === 'echo-clock') ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0]?.source).toBe('external')
  })
})

describe('disabled rows', () => {
  it('keeps a drop-in plugin disabled by name unmounted', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/echo-clock/index.js', ECHO_CLOCK_JS)
    const harness = await harnessIn(dir, {
      pluginsDir: 'plugins',
      plugins: { 'echo-clock': { disabled: true } },
    })

    expect(harness.ctx.tools.get('now')).toBeUndefined()
    const result = await call(harness.ctx, 'now')
    expect(result.output).toBe('error: unknown tool "now"')
    expect(result.isError).toBe(true)
    expect(registry(harness.ctx)?.list().some((e) => e.name === 'echo-clock')).toBe(false)
  })
})

describe('external plugin failure paths', () => {
  it('rejects createHarness when a bundle cannot be imported', async () => {
    const dir = await tmpDir()
    // The bundles loop awaits importExternal outside any try/catch, so a
    // missing module takes the whole harness down instead of degrading.
    await expect(
      createHarness({
        cwd: dir,
        config: { bundles: ['plugins/missing-plugin/index.js'] },
        approvalMode: 'yolo',
        renderer: false,
      }),
    ).rejects.toThrow()
  })

  it('degrades gracefully when a plugin apply() throws; siblings still mount', async () => {
    const dir = await tmpDir()
    await writePluginFile(dir, 'plugins/echo-clock/index.js', ECHO_CLOCK_JS)
    await writePluginFile(dir, 'plugins/bad/index.js', BAD_JS)
    // Mount errors from externals are caught and downgraded to kernel/error.
    const harness = await harnessIn(dir, { pluginsDir: 'plugins' })

    // The broken plugin never recorded itself in the registry...
    expect(registry(harness.ctx)?.list().some((e) => e.name === 'bad')).toBe(false)
    // ...while the healthy sibling mounted and works.
    const now = await call(harness.ctx, 'now')
    expect(now.output).toBe('tick')
  })
})
