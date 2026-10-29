import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { importSkill } from '../src/skills/import.js'
import { createHarness, type Harness } from '../src/harness.js'
import type { SkillsService } from '../src/skills/index.js'

const dirs: string[] = [], harnesses: Harness[] = []
afterEach(async () => { harnesses.splice(0).forEach(harness => harness.dispose()); while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }) })
async function workspace() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-skill-import-')); dirs.push(dir); return dir }
const md = '---\nname: custom-test\ndescription: test import\n---\nUse references/guide.md for testing.'

describe('Skill import', () => {
  it('imports a complete folder as inert files and reloads discovery without restarting', async () => {
    const cwd = await workspace(), harness = await createHarness({ cwd, renderer: false }); harnesses.push(harness)
    const skills = harness.ctx.get<SkillsService>('skills'); expect(skills.get('custom-test')).toBeUndefined()
    const result = await importSkill(cwd, { scope: 'project', files: [
      { path: 'downloaded/SKILL.md', content: md }, { path: 'downloaded/references/guide.md', content: 'Testing guide.' },
      { path: 'downloaded/scripts/do-not-execute.js', content: 'throw Error("must never execute")' },
    ] })
    expect(result).toMatchObject({ name: 'custom-test', scope: 'project', files: 3 })
    expect(await fs.readFile(path.join(result.dir, 'references', 'guide.md'), 'utf8')).toBe('Testing guide.')
    skills.reload(); expect(skills.get('custom-test')?.body).toContain('references/guide.md')
    expect((await fs.readdir(path.join(cwd, '.sakura', 'skills')))).toEqual(['custom-test'])
  })

  it('never overwrites a same-name Skill', async () => {
    const cwd = await workspace()
    await importSkill(cwd, { scope: 'project', files: [{ path: 'SKILL.md', content: md }] })
    await expect(importSkill(cwd, { scope: 'project', files: [{ path: 'SKILL.md', content: md.replace('Use references', 'Replace references') }] })).rejects.toMatchObject({ status: 409 })
    expect(await fs.readFile(path.join(cwd, '.sakura', 'skills', 'custom-test', 'SKILL.md'), 'utf8')).toBe(md)
  })

  it('rejects traversal, absolute paths, devices, duplicate paths, malformed metadata and binary data', async () => {
    const cwd = await workspace()
    for (const file of ['../SKILL.md', '/tmp/SKILL.md', 'C:/SKILL.md', 'folder/../SKILL.md', 'NUL/SKILL.md']) {
      await expect(importSkill(cwd, { scope: 'project', files: [{ path: file, content: md }] })).rejects.toMatchObject({ status: 400 })
    }
    for (const files of [
      [{ path: 'SKILL.md', content: md }, { path: 'skill.md', content: md }],
      [{ path: 'SKILL.md', content: '---\nname: [bad\n---\ninstructions' }],
      [{ path: 'SKILL.md', content: '---\nname: ../escape\n---\ninstructions' }],
      [{ path: 'SKILL.md', content: '\0binary' }],
      [{ path: 'SKILL.md', content: md }, { path: 'guide', content: 'one' }, { path: 'guide/a.md', content: 'two' }],
    ]) await expect(importSkill(cwd, { scope: 'project', files })).rejects.toMatchObject({ status: 400 })
    expect(await fs.readdir(cwd)).toEqual([])
  })

  it('refuses a .sakura junction or symlink target', async () => {
    const cwd = await workspace(), other = await workspace()
    await fs.symlink(other, path.join(cwd, '.sakura'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(importSkill(cwd, { scope: 'project', files: [{ path: 'SKILL.md', content: md }] })).rejects.toMatchObject({ status: 400 })
    expect(await fs.readdir(other)).toEqual([])
  })
})