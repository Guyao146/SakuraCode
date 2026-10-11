/**
 * ctx.agentDefs — `<name>.md` predefined agent type discovery
 * (project/user/extra), frontmatter parsing (description/model/tools),
 * reload and the system-prompt section. No harness: the minimal kernel is
 * assembled from Context + systemPromptPlugin + agentDefsPlugin (same style
 * as tests/skills.test.ts).
 *
 * os.homedir is mocked so "user" agent defs land in a temp dir, and
 * process.cwd is spied so "project" defs never touch the repository.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})

import { Context } from '../src/kernel/index.js'
import { systemPromptPlugin, type SystemPromptService } from '../src/core/system-prompt.js'
import { agentDefsPlugin, type AgentDefsService } from '../src/agents/index.js'

let projDir = ''
let homeDir = ''
let cwdSpy: { mockRestore(): void } | undefined

beforeEach(() => {
  projDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-agents-proj-'))
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-agents-home-'))
  state.home = homeDir
})

afterEach(() => {
  cwdSpy?.mockRestore()
  cwdSpy = undefined
  rmSync(projDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

/** Write `<root>/.sakura/agents/<name>.md`; returns the file path. */
function writeAgent(root: string, name: string, frontmatter: string, body = '你是代码库研究员。只读探索。'): string {
  const dir = path.join(root, '.sakura', 'agents')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.md`)
  writeFileSync(file, frontmatter ? `---\n${frontmatter}\n---\n${body}` : body)
  return file
}

/** Point process.cwd() at the temp project dir for the duration of the test. */
function useProjectCwd(): void {
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projDir)
}

async function mountAgents(config: { extraDirs?: string[] } = {}) {
  const ctx = new Context()
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(agentDefsPlugin, config)
  return ctx
}

describe('agentDefsPlugin — discovery', () => {
  it('lists project and user agent defs with correct sources and files', async () => {
    const projFile = writeAgent(projDir, 'explorer', 'description: 深挖代码库的只读研究员')
    const userFile = writeAgent(homeDir, 'reviewer', 'description: 代码审查专家')
    useProjectCwd()
    const ctx = await mountAgents()
    const list = ctx.get<AgentDefsService>('agentDefs').list()

    expect(list.map((d) => d.name)).toEqual(['explorer', 'reviewer'])
    expect(list[0]).toMatchObject({
      name: 'explorer',
      description: '深挖代码库的只读研究员',
      source: 'project',
      file: projFile,
      systemPrompt: '你是代码库研究员。只读探索。',
    })
    expect(list[1]).toMatchObject({
      name: 'reviewer',
      description: '代码审查专家',
      source: 'user',
      file: userFile,
    })
  })

  it('prefers the project agent def on name conflicts', async () => {
    writeAgent(projDir, 'dup', 'description: project dup')
    writeAgent(homeDir, 'dup', 'description: user dup')
    useProjectCwd()
    const ctx = await mountAgents()
    const list = ctx.get<AgentDefsService>('agentDefs').list()

    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'dup', source: 'project', description: 'project dup' })
  })

  it('supports config.extraDirs resolved relative to cwd, below project/user', async () => {
    writeAgent(projDir, 'alpha', 'description: project alpha')
    writeAgent(homeDir, 'dup2', 'description: user dup2')
    const extraDir = path.join(projDir, 'more-agents')
    mkdirSync(extraDir, { recursive: true })
    writeFileSync(path.join(extraDir, 'gamma.md'), '---\ndescription: gamma from extra\n---\nGamma prompt.')
    writeFileSync(path.join(extraDir, 'dup2.md'), '---\ndescription: extra dup2\n---\nExtra prompt.')
    useProjectCwd()
    const ctx = await mountAgents({ extraDirs: ['more-agents'] })
    const service = ctx.get<AgentDefsService>('agentDefs')

    expect(service.get('gamma')).toMatchObject({ source: 'extra', file: path.join(extraDir, 'gamma.md') })
    expect(service.get('dup2')).toMatchObject({ source: 'user', description: 'user dup2' })
  })
})

describe('agentDefsPlugin — frontmatter', () => {
  it('parses description/model and keeps tools "full"/"core" as-is', async () => {
    writeAgent(projDir, 'fulla', 'description: all tools\nmodel: reasoner-pro\ntools: full')
    writeAgent(projDir, 'cored', 'description: core tools\ntools: core')
    useProjectCwd()
    const ctx = await mountAgents()
    const service = ctx.get<AgentDefsService>('agentDefs')

    expect(service.get('fulla')).toMatchObject({
      description: 'all tools',
      model: 'reasoner-pro',
      tools: 'full',
    })
    expect(service.get('cored')?.tools).toBe('core') // passes through, not ['core']
  })

  it('splits a comma-separated tools allowlist into a trimmed array', async () => {
    writeAgent(projDir, 'restricted', 'description: allowlist\ntools: "read, grep"')
    useProjectCwd()
    const ctx = await mountAgents()

    expect(ctx.get<AgentDefsService>('agentDefs').get('restricted')?.tools).toEqual(['read', 'grep'])
  })

  it('skips a def with malformed YAML without throwing (warns once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeAgent(projDir, 'good', 'description: fine')
    writeAgent(projDir, 'bad', 'description: [unclosed')
    useProjectCwd()
    const ctx = await mountAgents()
    const service = ctx.get<AgentDefsService>('agentDefs')

    expect(service.list().map((d) => d.name)).toEqual(['good'])
    expect(service.get('bad')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('skips a def with an empty body (no system prompt) and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeAgent(projDir, 'real', 'description: has a prompt')
    writeAgent(projDir, 'hollow', 'description: no body', '   ')
    useProjectCwd()
    const ctx = await mountAgents()
    const service = ctx.get<AgentDefsService>('agentDefs')

    expect(service.list().map((d) => d.name)).toEqual(['real'])
    expect(service.get('hollow')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('agentDefsPlugin — reload', () => {
  it('picks up agent defs written after the first scan only after reload()', async () => {
    writeAgent(projDir, 'alpha', 'description: a')
    useProjectCwd()
    const ctx = await mountAgents()
    const service = ctx.get<AgentDefsService>('agentDefs')

    expect(service.list().map((d) => d.name)).toEqual(['alpha'])

    writeAgent(projDir, 'beta', 'description: b')
    expect(service.list().map((d) => d.name)).toEqual(['alpha']) // still cached

    service.reload()
    expect(service.list().map((d) => d.name)).toEqual(['alpha', 'beta'])
  })
})

describe('agentDefsPlugin — system-prompt section', () => {
  it('lists agent types in the prompt, refreshes on reload, and is disposed with the context', async () => {
    writeAgent(projDir, 'explorer', 'description: the explorer agent')
    useProjectCwd()
    const ctx = await mountAgents()
    const sp = ctx.get<SystemPromptService>('systemPrompt')
    const service = ctx.get<AgentDefsService>('agentDefs')

    const assembled = sp.assemble()
    expect(assembled).toContain('## Agent 类型')
    expect(assembled).toContain('- explorer — the explorer agent')

    rmSync(path.join(projDir, '.sakura', 'agents', 'explorer.md'), { force: true })
    service.reload()
    const after = sp.assemble()
    expect(after).not.toContain('explorer')
    expect(after).not.toContain('## Agent 类型') // empty section is dropped

    ctx.dispose()
    expect(sp.has('agent-defs')).toBe(false)
  })
})

describe('agentDefsPlugin — get', () => {
  it('returns undefined for an unknown name', async () => {
    writeAgent(projDir, 'alpha', 'description: a')
    useProjectCwd()
    const ctx = await mountAgents()

    expect(ctx.get<AgentDefsService>('agentDefs').get('nope')).toBeUndefined()
  })
})
