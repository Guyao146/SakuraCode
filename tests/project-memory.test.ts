/**
 * tests/project-memory.test.ts — projectMemoryPlugin against a temporary
 * directory tree. Without a `cwd` config the plugin scans from process.cwd()
 * (the historical default), so those tests chdir into the fixture and MUST
 * restore the original cwd afterwards; the cwd/harness tests below never
 * chdir and prove the scan follows the configured directory.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { systemPromptPlugin, type SystemPromptService } from '../src/core/system-prompt.js'
import { projectMemoryPlugin, type ProjectMemoryService } from '../src/plugins/project-memory.js'
import { createHarness, type Harness } from '../src/harness.js'

const originalCwd = process.cwd()
const createdDirs: string[] = []
const contexts: Context[] = []
const harnesses: Harness[] = []

afterEach(async () => {
  process.chdir(originalCwd)
  while (contexts.length) contexts.pop()?.dispose()
  while (harnesses.length) harnesses.pop()?.dispose()
  while (createdDirs.length) {
    const dir = createdDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Create a temp tree from relative paths, return the root. */
async function makeTree(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-memory-'))
  createdDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf8')
  }
  return dir
}

async function mount(config?: { cwd?: string; maxFiles?: number; maxChars?: number }): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(projectMemoryPlugin, config)
  return ctx
}

const memoryOf = (ctx: Context) => ctx.get<ProjectMemoryService>('projectMemory')
const assemble = (ctx: Context) => ctx.get<SystemPromptService>('systemPrompt').assemble()

describe('projectMemoryPlugin', () => {
  it('finds nearest-first: cwd AGENTS.md before parent CLAUDE.md, with correct char counts', async () => {
    const root = await makeTree({
      'CLAUDE.md': 'p'.repeat(40),
      'inner/AGENTS.md': 'a'.repeat(10),
    })
    process.chdir(path.join(root, 'inner'))

    const ctx = await mount({ maxFiles: 2 })
    const files = memoryOf(ctx).files()

    expect(files).toHaveLength(2)
    expect(files[0]).toEqual({ path: path.join(root, 'inner', 'AGENTS.md'), chars: 10 })
    expect(files[1]).toEqual({ path: path.join(root, 'CLAUDE.md'), chars: 40 })
  })

  it('prefers AGENTS.md over CLAUDE.md when both live in the same directory', async () => {
    const root = await makeTree({
      'AGENTS.md': 'agents wins',
      'CLAUDE.md': 'claude loses',
    })
    process.chdir(root)

    const ctx = await mount({ maxFiles: 1 })
    const files = memoryOf(ctx).files()

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toBe(path.join(root, 'AGENTS.md'))
  })

  it('renders a system-prompt section with both contents and cwd-relative titles', async () => {
    const root = await makeTree({
      'CLAUDE.md': 'from the parent directory',
      'inner/AGENTS.md': 'from the working directory',
    })
    process.chdir(path.join(root, 'inner'))

    const ctx = await mount({ maxFiles: 2 })
    const prompt = assemble(ctx)

    expect(prompt).toContain('## Project instructions — AGENTS.md')
    expect(prompt).toContain('## Project instructions — ../CLAUDE.md')
    expect(prompt).toContain('from the working directory')
    expect(prompt).toContain('from the parent directory')
    const agentsAt = prompt.indexOf('AGENTS.md')
    const claudeAt = prompt.indexOf('../CLAUDE.md')
    expect(agentsAt).toBeGreaterThanOrEqual(0)
    expect(claudeAt).toBeGreaterThan(agentsAt)
  })

  it('reload() re-reads changed files: chars and assemble() reflect new content', async () => {
    const root = await makeTree({
      'inner/AGENTS.md': 'before reload',
      'CLAUDE.md': 'stable parent',
    })
    process.chdir(path.join(root, 'inner'))

    const ctx = await mount({ maxFiles: 2 })
    const memory = memoryOf(ctx)
    expect(memory.files()[0]!.chars).toBe('before reload'.length)

    await fs.writeFile(path.join(root, 'inner', 'AGENTS.md'), 'after reload with more content', 'utf8')
    memory.reload()

    expect(memory.files()[0]!.chars).toBe('after reload with more content'.length)
    const prompt = assemble(ctx)
    expect(prompt).toContain('after reload with more content')
    expect(prompt).not.toContain('before reload')
  })

  it('renders nothing when no memory files exist anywhere up the tree', async () => {
    const root = await makeTree({ 'inner/.keep': '' })
    process.chdir(path.join(root, 'inner'))

    const ctx = await mount()
    const memory = memoryOf(ctx)

    expect(memory.files()).toEqual([])
    expect(assemble(ctx)).not.toContain('Project instructions')
  })

  it('honors maxChars truncation and maxFiles cap', async () => {
    const root = await makeTree({
      'CLAUDE.md': 'x'.repeat(100),
      'inner/AGENTS.md': 'y'.repeat(50),
    })
    process.chdir(path.join(root, 'inner'))

    const ctx = await mount({ maxFiles: 1, maxChars: 20 })
    const files = memoryOf(ctx).files()

    expect(files).toHaveLength(1)
    expect(files[0]!.chars).toBe(20)
    expect(assemble(ctx)).toContain('y'.repeat(20))
    expect(assemble(ctx)).not.toContain('x'.repeat(20))
  })

  it('scans upward from the configured cwd without chdir', async () => {
    const root = await makeTree({ 'inner/AGENTS.md': 'configured cwd instructions' })
    const inner = path.join(root, 'inner')

    // process.cwd() stays the repo root (which has no memory file), so only the
    // config can explain a hit inside the fixture.
    const ctx = await mount({ cwd: inner, maxFiles: 1 })
    const files = memoryOf(ctx).files()

    expect(files).toEqual([{ path: path.join(inner, 'AGENTS.md'), chars: 'configured cwd instructions'.length }])
    expect(assemble(ctx)).toContain('## Project instructions — AGENTS.md')
    expect(assemble(ctx)).toContain('configured cwd instructions')
  })

  it('harness cwd is what the plugin discovers from (service listing and prompt)', async () => {
    const root = await makeTree({ 'AGENTS.md': 'harness scoped instructions' })

    // maxFiles: 1 comes from a config row, so this also pins that the harness
    // cwd is merged into (not replaced by) an explicit core-project-memory row.
    const harness = await createHarness({
      cwd: root,
      renderer: false,
      config: { plugins: { 'core-project-memory': { config: { maxFiles: 1 } } } },
    })
    harnesses.push(harness)

    const files = harness.ctx.get<ProjectMemoryService>('projectMemory').files()
    expect(files).toEqual([{ path: path.join(root, 'AGENTS.md'), chars: 'harness scoped instructions'.length }])
    const prompt = harness.ctx.get<SystemPromptService>('systemPrompt').assemble()
    expect(prompt).toContain('## Project instructions — AGENTS.md')
    expect(prompt).toContain('harness scoped instructions')
  })
})
