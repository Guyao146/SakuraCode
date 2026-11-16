import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorktreeService } from '../src/worktrees/index.js'

const roots: string[] = []
afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true, maxRetries: 5 }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-isolated-tree-')); roots.push(root)
  const cwd = path.join(root, 'project'); await fs.mkdir(cwd)
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false')
  await fs.writeFile(path.join(cwd, 'one.txt'), 'before\n'); await fs.writeFile(path.join(cwd, 'two.txt'), 'unchanged\n')
  git('add', '.'); git('commit', '-m', 'synthetic baseline')
  const service = new WorktreeService(cwd, { managedRoot: path.join(root, 'managed') })
  const create = async (taskId = 'task-one') => { const preview = await service.previewCreate({ taskId }); return service.create({ previewId: preview.id, expectedFingerprint: preview.fingerprint }) }
  return { root, cwd, git, service, create }
}
describe('managed independent development trees', () => {
  it('creates registered private worktrees from committed bytes and integrates selected text without modifying the original index', async () => {
    const f = await fixture(), originalIndex = await fs.readFile(path.join(f.cwd, '.git/index'))
    await fs.writeFile(path.join(f.cwd, 'two.txt'), 'parent dirty\n'); await fs.writeFile(path.join(f.cwd, 'parent-secret.env'), 'not copied')
    const first = await f.create(), second = await f.create('task-two')
    expect(await fs.readFile(path.join(first.path, 'two.txt'), 'utf8')).toBe('unchanged\n')
    await expect(fs.stat(path.join(first.path, 'parent-secret.env'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(execFileSync('git', ['-C', first.path, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toContain(first.path.replaceAll('\\', '/'))
    expect(execFileSync('git', ['-C', first.path, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })).toBe('')
    await fs.writeFile(path.join(first.path, 'one.txt'), 'new\n'); await fs.writeFile(path.join(first.path, 'added.txt'), 'addition\n')
    expect(await fs.readFile(path.join(second.path, 'one.txt'), 'utf8')).toBe('before\n')
    const read = await f.service.read(first.id)
    expect(read.files.map(x => x.path).sort()).toEqual(['added.txt', 'one.txt'])
    const preview = await f.service.previewIntegrate({ id: first.id, expectedFingerprint: read.fingerprint, paths: ['one.txt', 'added.txt'] })
    expect(preview.canIntegrate).toBe(true)
    const result = await f.service.integrate({ previewId: preview.id, expectedFingerprint: preview.fingerprint })
    expect(result.indexUnchanged).toBe(true)
    expect(await fs.readFile(path.join(f.cwd, 'one.txt'), 'utf8')).toBe('new\n')
    expect(await fs.readFile(path.join(f.cwd, 'two.txt'), 'utf8')).toBe('parent dirty\n')
    expect(await fs.readFile(path.join(f.cwd, '.git/index'))).toEqual(originalIndex)
    const restarted = new WorktreeService(f.cwd, { managedRoot: path.join(f.root, 'managed') })
    expect((await restarted.list()).worktrees).toHaveLength(2)
    await fs.writeFile(path.join(first.dataDir, 'preserved-history.txt'), 'keep')
    const current = await f.service.read(first.id)
    await f.service.cleanup({ id: first.id, expectedFingerprint: current.fingerprint })
    expect(await fs.readFile(path.join(first.dataDir, 'preserved-history.txt'), 'utf8')).toBe('keep')
    await expect(fs.stat(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 60000)
  it('rejects conflicts, stale selections and unconfirmed disposal of changed files', async () => {
    const f = await fixture(), tree = await f.create()
    await fs.writeFile(path.join(tree.path, 'one.txt'), 'child\n')
    let read = await f.service.read(tree.id)
    await expect(f.service.cleanup({ id: tree.id, expectedFingerprint: read.fingerprint })).rejects.toMatchObject({ code: 'UNINTEGRATED_CHANGES' })
    await fs.writeFile(path.join(f.cwd, 'one.txt'), 'parent changed\n')
    const conflict = await f.service.previewIntegrate({ id: tree.id, expectedFingerprint: read.fingerprint, paths: ['one.txt'] })
    expect(conflict.canIntegrate).toBe(false)
    await expect(f.service.integrate({ previewId: conflict.id, expectedFingerprint: conflict.fingerprint })).rejects.toMatchObject({ code: 'CONFLICT' })
    await fs.writeFile(path.join(tree.path, 'one.txt'), 'child changed\n')
    await expect(f.service.previewIntegrate({ id: tree.id, expectedFingerprint: read.fingerprint, paths: ['one.txt'] })).rejects.toMatchObject({ status: 409 })
    read = await f.service.read(tree.id)
    await f.service.cleanup({ id: tree.id, expectedFingerprint: read.fingerprint, discard: true })
    expect(await fs.readFile(path.join(f.cwd, 'one.txt'), 'utf8')).toBe('parent changed\n')
  }, 60000)
})
