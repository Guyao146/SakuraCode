/**
 * ctx.skills — SKILL.md discovery (project/user/extra), frontmatter parsing,
 * reload, the `skill` tool and the system-prompt section. No harness: the
 * minimal kernel is assembled from Context + toolsPlugin + systemPromptPlugin
 * + skillsPlugin (same style as tests/mcp.test.ts).
 *
 * os.homedir is mocked so "user" skills land in a temp dir, and process.cwd
 * is spied so "project" skills never touch the repository.
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
import { toolsPlugin, type ToolsService } from '../src/core/tools.js'
import { systemPromptPlugin, type SystemPromptService } from '../src/core/system-prompt.js'
import { skillsPlugin, type SkillsService } from '../src/skills/index.js'
import type { ToolContext } from '../src/core/types.js'

const makeTc = (): ToolContext => ({ sessionId: 's', agentId: 'a', signal: new AbortController().signal })

let projDir = ''
let homeDir = ''
let cwdSpy: { mockRestore(): void } | undefined

beforeEach(() => {
  projDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-skills-proj-'))
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-skills-home-'))
  state.home = homeDir
})

afterEach(() => {
  cwdSpy?.mockRestore()
  cwdSpy = undefined
  rmSync(projDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

/** Write `<root>/.sakura/skills/<dirName>/SKILL.md`; returns the skill dir. */
function writeSkill(root: string, dirName: string, frontmatter: string, body = 'Body instructions.'): string {
  const dir = path.join(root, '.sakura', 'skills', dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`)
  return dir
}

/** Point process.cwd() at the temp project dir for the duration of the test. */
function useProjectCwd(): void {
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projDir)
}

async function mountSkills(config: { extraDirs?: string[] } = {}) {
  const ctx = new Context()
  await ctx.plugin(toolsPlugin)
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(skillsPlugin, config)
  return ctx
}

describe('skillsPlugin — discovery', () => {
  it('lists project and user skills with correct sources and dirs', async () => {
    writeSkill(projDir, 'alpha', 'name: alpha\ndescription: project alpha skill')
    writeSkill(homeDir, 'beta', 'description: user beta skill\nwhenToUse: when writing tests')
    useProjectCwd()
    const ctx = await mountSkills()
    const service = ctx.get<SkillsService>('skills')

    const list = service.list()
    expect(list.map((s) => s.name)).toEqual(['alpha', 'beta'])
    expect(list[0]).toMatchObject({
      name: 'alpha',
      description: 'project alpha skill',
      source: 'project',
      dir: path.join(projDir, '.sakura', 'skills', 'alpha'),
    })
    expect(list[1]).toMatchObject({
      name: 'beta',
      description: 'user beta skill',
      whenToUse: 'when writing tests',
      source: 'user',
      dir: path.join(homeDir, '.sakura', 'skills', 'beta'),
    })
  })

  it('prefers the project skill on name conflicts', async () => {
    writeSkill(projDir, 'dup', 'description: project dup')
    writeSkill(homeDir, 'dup', 'name: dup\ndescription: user dup')
    useProjectCwd()
    const ctx = await mountSkills()
    const list = ctx.get<SkillsService>('skills').list()

    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'dup', source: 'project', description: 'project dup' })
  })

  it('supports config.extraDirs resolved relative to cwd', async () => {
    writeSkill(projDir, 'alpha', 'description: project alpha')
    const extraDir = path.join(projDir, 'more-skills', 'gamma')
    mkdirSync(extraDir, { recursive: true })
    writeFileSync(path.join(extraDir, 'SKILL.md'), '---\ndescription: gamma from extra\n---\nGamma body.')
    useProjectCwd()
    const ctx = await mountSkills({ extraDirs: ['more-skills'] })

    const list = ctx.get<SkillsService>('skills').list()
    expect(list.map((s) => [s.name, s.source])).toEqual([
      ['alpha', 'project'],
      ['gamma', 'extra'],
    ])
  })
})

describe('skillsPlugin — frontmatter', () => {
  it('parses name/description/whenToUse and defaults name to the directory name', async () => {
    writeSkill(projDir, 'noname', 'description: no explicit name')
    writeSkill(projDir, 'full', 'name: renamed\ndescription: desc here\nwhenToUse: when unit-testing')
    useProjectCwd()
    const ctx = await mountSkills()
    const service = ctx.get<SkillsService>('skills')

    const list = service.list()
    expect(list.map((s) => s.name)).toEqual(['noname', 'renamed'])
    expect(list[0]).toMatchObject({ name: 'noname', description: 'no explicit name' })
    expect(list[1]).toMatchObject({ name: 'renamed', description: 'desc here', whenToUse: 'when unit-testing' })
    expect(service.get('renamed')?.body).toBe('Body instructions.')
    expect(service.get('noname')?.body).toBe('Body instructions.')
  })

  it('skips a skill with malformed YAML without throwing (warns once)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeSkill(projDir, 'good', 'description: fine')
    writeSkill(projDir, 'bad', 'description: [unclosed')
    useProjectCwd()
    const ctx = await mountSkills()
    const service = ctx.get<SkillsService>('skills')

    expect(service.list().map((s) => s.name)).toEqual(['good'])
    expect(service.get('bad')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})

describe('skillsPlugin — reload', () => {
  it('picks up skills written after the first scan only after reload()', async () => {
    writeSkill(projDir, 'alpha', 'description: a')
    useProjectCwd()
    const ctx = await mountSkills()
    const service = ctx.get<SkillsService>('skills')

    expect(service.list().map((s) => s.name)).toEqual(['alpha'])

    writeSkill(projDir, 'beta', 'description: b')
    expect(service.list().map((s) => s.name)).toEqual(['alpha']) // still cached

    service.reload()
    expect(service.list().map((s) => s.name)).toEqual(['alpha', 'beta'])
  })
})

describe('skillsPlugin — skill tool', () => {
  it('returns the skill body through ctx.tools and errors on unknown names', async () => {
    writeSkill(projDir, 'alpha', 'description: the alpha skill', 'Do the alpha thing.')
    useProjectCwd()
    const ctx = await mountSkills()
    const tools = ctx.get<ToolsService>('tools')

    const ok = await tools.execute('c1', 'skill', JSON.stringify({ name: 'alpha', note: 'needed' }), makeTc())
    expect(ok.output).toBe('# skill: alpha\n\nDo the alpha thing.')
    expect(ok.isError).toBeFalsy()

    const bad = await tools.execute('c2', 'skill', JSON.stringify({ name: 'nope' }), makeTc())
    expect(bad.isError).toBe(true)
    expect(bad.output).toContain('unknown skill')
    expect(bad.output).toContain('alpha') // lists the available skill names
  })
})

describe('skillsPlugin — system-prompt section', () => {
  it('lists skills in the prompt, refreshes on reload, and is disposed with the context', async () => {
    writeSkill(projDir, 'alpha', 'description: the alpha skill')
    useProjectCwd()
    const ctx = await mountSkills()
    const sp = ctx.get<SystemPromptService>('systemPrompt')
    const service = ctx.get<SkillsService>('skills')

    const assembled = sp.assemble()
    expect(assembled).toContain('## Skills')
    expect(assembled).toContain('- alpha — the alpha skill')

    rmSync(path.join(projDir, '.sakura', 'skills', 'alpha'), { recursive: true, force: true })
    service.reload()
    expect(sp.assemble()).not.toContain('alpha')
    expect(sp.assemble()).not.toContain('## Skills') // empty section is dropped

    ctx.dispose()
    expect(sp.has('skills')).toBe(false)
  })
})
