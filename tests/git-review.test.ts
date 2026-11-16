import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitReviewService, type GitReviewSnapshot } from '../src/git/index.js'
import { GitReviewStore } from '../src/git/store.js'
import { operation } from '../src/git/process.js'
import { GIT_REVIEW_LIMITS } from '../src/git/types.js'
import { gitPath, nulRecords, utf8 } from '../src/git/safety.js'
import { resolveGit } from '../src/git/process.js'

const roots: string[] = []
const cleanEnv = (home: string): NodeJS.ProcessEnv => {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'absent-global-config'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: '',
    GIT_AUTHOR_NAME: 'Git Review Test', GIT_AUTHOR_EMAIL: 'review@example.invalid',
    GIT_COMMITTER_NAME: 'Git Review Test', GIT_COMMITTER_EMAIL: 'review@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' }
}

async function git(cwd: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  const executable = await resolveGit()
  if (!executable) throw new Error('Tests require an installed local Git; this test must not be skipped.')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], {
      cwd, env: cleanEnv(path.dirname(cwd)), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = [], err: Buffer[] = []
    child.stdout.on('data', chunk => out.push(chunk))
    child.stderr.on('data', chunk => err.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`fixture git ${args[0]} failed (${code}): ${Buffer.concat(err)}`)))
    child.stdin.on('error', reject)
    child.stdin.end(input)
  })
}

async function fixture(files: Record<string, string | Buffer> = { 'one.txt': 'one\nbase\n' }, commit = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-git-review-test-'))
  roots.push(root)
  const cwd = path.join(root, 'repo')
  await fs.mkdir(cwd)
  await git(cwd, ['init', '-q', '--initial-branch=main'])
  await git(cwd, ['config', 'core.autocrlf', 'false'])
  for (const [name, content] of Object.entries(files)) await write(cwd, name, content)
  if (commit) { await git(cwd, ['add', '--', '.']); await git(cwd, ['commit', '-qm', 'initial']) }
  return { root, cwd, service: new GitReviewService(cwd) }
}

async function write(cwd: string, name: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(path.join(cwd, name)), { recursive: true })
  await fs.writeFile(path.join(cwd, name), content)
}
const file = (snapshot: GitReviewSnapshot, range: keyof GitReviewSnapshot['ranges'], name: string) => {
  const found = snapshot.ranges[range].find(value => value.path === name)
  expect(found, `${range} contains ${JSON.stringify(name)}`).toBeDefined()
  return found!
}
const bytesHash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function diskState(cwd: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {}
  const walk = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const name = path.relative(cwd, target).split(path.sep).join('/')
      if (name === '.sakura/git-review') continue
      if (entry.isSymbolicLink()) state[name] = 'link:' + await fs.readlink(target)
      else if (entry.isDirectory()) await walk(target)
      else state[name] = bytesHash(await fs.readFile(target))
    }
  }
  await walk(cwd)
  return state
}

afterEach(async () => { while (roots.length) await fs.rm(roots.pop()!, { recursive: true, force: true }) })

describe('GitReviewService bounded, read-only snapshots', () => {
  it('separates staged/unstaged/baseline and does not read untracked or ignored content by default', async () => {
    const { cwd, service } = await fixture({ 'one.txt': 'base\n', '.gitignore': 'ignored.txt\n' })
    await write(cwd, 'one.txt', 'staged\n')
    await git(cwd, ['add', '--', 'one.txt'])
    await write(cwd, 'one.txt', 'working\n')
    await write(cwd, 'new.txt', 'explicit secret\n')
    await write(cwd, 'ignored.txt', 'ignored secret\n')
    const before = await diskState(cwd)
    const snapshot = await service.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.base.oid).toBe(snapshot.headOid)
    expect(file(snapshot, 'staged', 'one.txt').patch).toContain('-base\n+staged\n')
    expect(file(snapshot, 'unstaged', 'one.txt').patch).toContain('-staged\n+working\n')
    expect(file(snapshot, 'baseline', 'one.txt').patch).toContain('-base\n+working\n')
    expect(snapshot.ranges.untracked.map(value => value.path)).toEqual(['new.txt'])
    expect(file(snapshot, 'untracked', 'new.txt').text).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('explicit secret')
    const selected = await service.readUntracked({ expectedSnapshotId: snapshot.snapshotId, path: 'new.txt' })
    expect(file(selected, 'untracked', 'new.txt').text).toBe('explicit secret\n')
    expect(selected.snapshotId).not.toBe(snapshot.snapshotId)
    expect(await diskState(cwd)).toEqual(before)
    expect(await service.getTrackedFingerprint()).toEqual(snapshot.trackedFingerprint)
  })

  it('reports no repository, missing Git, and unborn HEAD without creating repository state', async () => {
    const { root, cwd, service } = await fixture({}, false)
    const outsideTemp = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'Temp') : '/tmp'
    const nonrepo = await fs.mkdtemp(path.join(outsideTemp, 'sakura-git-nonrepo-test-'))
    roots.push(nonrepo)
    expect((await new GitReviewService(nonrepo).getSnapshot()).status).toBe('not_repository')
    expect((await new GitReviewService(cwd, { gitPath: path.join(root, 'absent-bin', process.platform === 'win32' ? 'git.exe' : 'git') }).getSnapshot()).status).toBe('git_unavailable')
    const empty = await service.getSnapshot()
    expect(empty.status).toBe('unborn')
    expect(empty.headOid).toBeNull()
    expect(empty.ranges.staged).toEqual([])
    await write(cwd, 'first.txt', 'first\n')
    await git(cwd, ['add', '--', 'first.txt'])
    const first = await service.getSnapshot()
    expect(file(first, 'staged', 'first.txt').status).toBe('added')
    expect(file(first, 'staged', 'first.txt').patch).toContain('new file mode 100644')
    const patch = await service.exportPatch({ expectedSnapshotId: first.snapshotId, range: 'staged', fileIds: [file(first, 'staged', 'first.txt').id] })
    await git(cwd, ['apply', '--cached', '--reverse', '--check', '-'], patch.patch)
  })

  it('preserves literal special filenames, deletions, and old/new rename paths', async () => {
    const names = process.platform === 'win32'
      ? ['space name.txt', '--output=sentinel.txt', '[literal].txt', '日本語.txt', 'quote\'name.txt']
      : ['space name.txt', '--output=sentinel.txt', '[literal].txt', '日本語.txt', 'quote\'name.txt', 'line\nbreak\t.txt', ':(glob)*.txt']
    const initial = Object.fromEntries(names.map(name => [name, `base ${name}\n`]))
    const { cwd, service } = await fixture({ ...initial, 'old name.txt': 'identical rename\n', 'delete.txt': 'delete me\n' })
    for (const name of names) await write(cwd, name, `new ${name}\n`)
    await git(cwd, ['mv', '--', 'old name.txt', 'renamed name.txt'])
    await git(cwd, ['rm', '--', 'delete.txt'])
    const before = await diskState(cwd)
    const snapshot = await service.getSnapshot()
    expect(file(snapshot, 'staged', 'renamed name.txt')).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', newPath: 'renamed name.txt', similarity: 100 })
    expect(file(snapshot, 'staged', 'delete.txt')).toMatchObject({ status: 'deleted', oldPath: 'delete.txt', newPath: null })
    for (const name of names) expect(file(snapshot, 'unstaged', name).exportable).toBe(true)
    const patch = await service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'unstaged', fileIds: snapshot.ranges.unstaged.map(value => value.id) })
    await git(cwd, ['apply', '--cached', '--check', '-'], patch.patch)
    expect(await diskState(cwd)).toEqual(before)
  })

  it('limits an ancestor repository to the workspace and resolves only local commit baselines', async () => {
    const { cwd } = await fixture({ 'inside/a.txt': 'a\n', 'outside.txt': 'outside\n' })
    const original = (await git(cwd, ['rev-parse', 'HEAD'])).toString().trim()
    await git(cwd, ['tag', 'baseline', original])
    await write(cwd, 'inside/a.txt', 'committed\n')
    await git(cwd, ['add', '--', '.']); await git(cwd, ['commit', '-qm', 'second'])
    await write(cwd, 'inside/a.txt', 'working\n'); await write(cwd, 'outside.txt', 'do not expose\n')
    const service = new GitReviewService(path.join(cwd, 'inside'))
    const snapshot = await service.getSnapshot({ baseRef: 'baseline' })
    expect(snapshot.scope).toBe('inside')
    expect(snapshot.base.oid).toBe(original)
    expect(snapshot.ranges.baseline.map(value => value.path)).toEqual(['inside/a.txt'])
    expect(JSON.stringify(snapshot)).not.toContain('do not expose')
    expect(file(snapshot, 'baseline', 'inside/a.txt').patch).toContain('-a\n+working\n')
    for (const baseRef of ['--output=x', 'HEAD~1', 'main^{tree}', 'HEAD:inside/a.txt', 'https://example.invalid/repo']) {
      await expect(service.getSnapshot({ baseRef })).rejects.toMatchObject({ code: 'INVALID_REF' })
    }
    const before = await diskState(cwd)
    const patch = await service.exportPatch({ baseRef: 'baseline', expectedSnapshotId: snapshot.snapshotId, range: 'baseline', fileIds: snapshot.ranges.baseline.map(value => value.id) })
    expect(patch.patch).not.toContain('outside.txt')
    expect(await diskState(cwd)).toEqual(before)
  })
})

describe('GitReviewService special files and hostile local configuration', () => {
  it('returns binary, conflict stages, gitlink and executable modes but refuses unsafe patch exports', async () => {
    const { cwd, service } = await fixture({ 'binary.bin': Buffer.from([1, 0, 2]), 'conflict.txt': 'base\n', 'executable.sh': 'script\n' })
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).toString().trim()
    const base = (await git(cwd, ['rev-parse', 'HEAD:conflict.txt'])).toString().trim()
    const ours = (await git(cwd, ['hash-object', '-w', '--stdin'], 'ours\n')).toString().trim()
    const theirs = (await git(cwd, ['hash-object', '-w', '--stdin'], 'theirs\n')).toString().trim()
    const zero = '0'.repeat(head.length)
    await git(cwd, ['update-index', '--index-info'], `0 ${zero}\tconflict.txt\n100644 ${base} 1\tconflict.txt\n100644 ${ours} 2\tconflict.txt\n100644 ${theirs} 3\tconflict.txt\n`)
    await git(cwd, ['update-index', '--add', '--cacheinfo', `160000,${head},module`])
    await git(cwd, ['update-index', '--chmod=+x', '--', 'executable.sh'])
    await write(cwd, 'binary.bin', Buffer.from([3, 0, 4]))
    await write(cwd, 'conflict.txt', '<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n')
    const before = await diskState(cwd)
    const snapshot = await service.getSnapshot()
    expect(file(snapshot, 'unstaged', 'binary.bin')).toMatchObject({ binary: true, exportable: false })
    expect(file(snapshot, 'staged', 'conflict.txt')).toMatchObject({ conflict: true, status: 'conflicted', exportable: false,
      conflictStages: [{ stage: 1, oid: base, mode: '100644' }, { stage: 2, oid: ours, mode: '100644' }, { stage: 3, oid: theirs, mode: '100644' }] })
    expect(file(snapshot, 'staged', 'module')).toMatchObject({ submodule: true, newMode: '160000', submoduleDirty: null, exportable: false })
    expect(file(snapshot, 'staged', 'executable.sh')).toMatchObject({ oldMode: '100644', newMode: '100755' })
    for (const [range, name] of [['unstaged', 'binary.bin'], ['staged', 'conflict.txt'], ['staged', 'module']] as const) {
      await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range, fileIds: [file(snapshot, range, name).id] })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    }
    expect(await diskState(cwd)).toEqual(before)
  })

  it('does not follow untracked external directory links or render tracked symlinks as text patches', async () => {
    const { root, cwd, service } = await fixture({ 'ordinary.txt': 'ordinary\n' })
    const external = path.join(root, 'external')
    await fs.mkdir(external); await write(external, 'secret.txt', 'external secret sentinel\n')
    await fs.symlink(external, path.join(cwd, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    const target = '../external/secret.txt'
    const oid = (await git(cwd, ['hash-object', '-w', '--stdin'], target)).toString().trim()
    await git(cwd, ['update-index', '--add', '--cacheinfo', `120000,${oid},tracked-link`])
    // On Windows without symlink privilege Git represents an indexed symlink with a target-text file.
    await write(cwd, 'tracked-link', target)
    const before = await diskState(cwd)
    const snapshot = await service.getSnapshot()
    expect(file(snapshot, 'staged', 'tracked-link')).toMatchObject({ symlink: true, newMode: '120000', newLinkTarget: target, exportable: false })
    expect(snapshot.ranges.untracked.some(value => value.path === 'outside-link/secret.txt')).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('external secret sentinel')
    await expect(service.readUntracked({ expectedSnapshotId: snapshot.snapshotId, path: 'outside-link' })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'staged', fileIds: [file(snapshot, 'staged', 'tracked-link').id] })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    expect(await diskState(cwd)).toEqual(before)
    expect(await fs.readFile(path.join(external, 'secret.txt'), 'utf8')).toBe('external secret sentinel\n')
  })

  it('isolates external diff, textconv, filters, fsmonitor, pager, includes and inherited Git overrides', async () => {
    const { root, cwd, service } = await fixture({ '.gitattributes': '*.txt filter=evil diff=evil\n', 'one.txt': 'before\n' })
    const sentinel = path.join(root, 'executed-sentinel').split(path.sep).join('/')
    const script = path.join(root, 'user-script.sh')
    await fs.writeFile(script, `#!/bin/sh\nprintf executed > '${sentinel}'\nexit 1\n`)
    const command = `sh '${script.split(path.sep).join('/')}'`
    const configValues: Record<string, string> = {
      'diff.external': command, 'diff.evil.command': command, 'diff.evil.textconv': command,
      'filter.evil.clean': command, 'filter.evil.smudge': command, 'filter.evil.process': command,
      'filter.evil.required': 'true', 'core.fsmonitor': command, 'core.pager': command,
      'core.sshCommand': command, 'core.hooksPath': root,
      'core.worktree': path.join(root, 'not-the-worktree'),
      'include.path': path.join(root, 'malicious-include'), 'remote.origin.url': 'https://example.invalid/repo',
      'remote.origin.promisor': 'true', 'remote.origin.partialclonefilter': 'blob:none',
    }
    // core.worktree goes last so the fixture helper never starts commands from an absent worktree.
    for (const [key, value] of Object.entries(configValues).filter(([key]) => key !== 'core.worktree')) await git(cwd, ['config', key, value])
    await fs.writeFile(path.join(root, 'malicious-include'), '[core]\nfsmonitor = bad-command\n[include]\npath = missing-never-opened\n')
    await git(cwd, ['config', 'core.worktree', configValues['core.worktree']!])
    await write(cwd, 'one.txt', 'after\n')
    const before = await diskState(cwd)
    const envKeys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_EXTERNAL_DIFF', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_PAGER']
    const saved = new Map(envKeys.map(key => [key, process.env[key]]))
    try {
      Object.assign(process.env, { GIT_DIR: path.join(root, 'bad-repo'), GIT_WORK_TREE: root, GIT_INDEX_FILE: path.join(root, 'bad-index'),
        GIT_EXTERNAL_DIFF: command, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'filter.evil.process', GIT_CONFIG_VALUE_0: command,
        GIT_SSH_COMMAND: command, GIT_ASKPASS: command, GIT_PAGER: command })
      const snapshot = await service.getSnapshot()
      expect(file(snapshot, 'unstaged', 'one.txt').patch).toContain('-before\n+after\n')
      const exported = await service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'unstaged', fileIds: [file(snapshot, 'unstaged', 'one.txt').id] })
      expect(exported.patch).toContain('-before\n+after\n')
      expect(await service.getTrackedFingerprint()).toEqual(snapshot.trackedFingerprint)
    } finally {
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    }
    await expect(fs.stat(path.join(root, 'executed-sentinel'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await diskState(cwd)).toEqual(before)
  })

  it('uses NUL record boundaries, rejects non-UTF8 and platform-unsafe paths without shell interpretation', () => {
    const names = ['tab\tname', 'line\nbreak', '--option', ':(glob)*', "quote'name", 'ユニコード', '\ufeffleading-bom']
    expect(nulRecords(Buffer.from(names.join('\0') + '\0')).map(bytes => utf8(bytes))).toEqual(names)
    expect(() => nulRecords(Buffer.from('unterminated'))).toThrow()
    expect(() => utf8(Buffer.from([0xff]))).toThrow()
    for (const name of ['../escape', '/absolute', 'dir/../escape', '.git/config', 'C:/drive', 'null\0byte']) expect(() => gitPath(name)).toThrow()
    expect(gitPath('--option')).toBe('--option')
    if (process.platform === 'win32') for (const name of ['NUL.txt', 'a:stream', 'dir\\escape', 'trailing.']) expect(() => gitPath(name)).toThrow()
    else for (const name of names) expect(gitPath(name)).toBe(name)
  })
})

describe('GitReviewService safe durable store and freshness gates', () => {
  it('preserves corrupt and hardlinked store files, rejects linked storage directories', async () => {
    const { root, cwd, service } = await fixture()
    await write(cwd, 'one.txt', 'edit\n')
    const directory = path.join(cwd, '.sakura', 'git-review')
    await fs.mkdir(directory, { recursive: true })
    const state = path.join(directory, 'state.json')
    await fs.writeFile(state, '{ corrupt original')
    await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    expect(await fs.readFile(state, 'utf8')).toBe('{ corrupt original')
    await fs.unlink(state)
    const outside = path.join(root, 'original-store.json')
    const content = '{"version":1,"records":[]}\n'
    await fs.writeFile(outside, content); await fs.link(outside, state)
    await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'UNSAFE_STORE' })
    expect(await fs.readFile(outside, 'utf8')).toBe(content)
    await fs.unlink(state); await fs.rmdir(directory)
    const external = path.join(root, 'external-store'); await fs.mkdir(external)
    await fs.symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.getSnapshot()).rejects.toMatchObject({ code: 'UNSAFE_STORE' })
    expect(await fs.readdir(external)).toEqual([])
  })

  it('checks store fingerprints under a write lock and preserves the original on stale saves', async () => {
    const { cwd, service } = await fixture()
    await write(cwd, 'one.txt', 'edit\n')
    const snapshot = await service.getSnapshot()
    const target = file(snapshot, 'unstaged', 'one.txt')
    const saved = await service.markReviewed({ expectedSnapshotId: snapshot.snapshotId, expectedStoreFingerprint: snapshot.storeFingerprint, fileId: target.id, reviewed: true })
    const statePath = path.join(cwd, '.sakura', 'git-review', 'state.json')
    const bytes = await fs.readFile(statePath)
    await expect(service.markReviewed({ expectedSnapshotId: saved.snapshotId, expectedStoreFingerprint: snapshot.storeFingerprint, fileId: target.id, reviewed: false })).rejects.toMatchObject({ code: 'STALE_STORE' })
    expect(await fs.readFile(statePath)).toEqual(bytes)
    await fs.writeFile(path.join(path.dirname(statePath), 'write.lock'), 'owned by another writer')
    await expect(service.markReviewed({ expectedSnapshotId: saved.snapshotId, fileId: target.id, reviewed: false })).rejects.toMatchObject({ code: 'STORE_BUSY' })
    expect(await fs.readFile(path.join(path.dirname(statePath), 'write.lock'), 'utf8')).toBe('owned by another writer')
    expect(await fs.readFile(statePath)).toEqual(bytes)
  })

  it('serializes independent store writers without clobbering and detects raw external edits', async () => {
    const { cwd } = await fixture()
    const store = new GitReviewStore(cwd, { ...GIT_REVIEW_LIMITS })
    const initial = await store.read()
    const firstOp = operation(30_000), secondOp = operation(30_000)
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const hasEntered = new Promise<void>(resolve => { entered = resolve })
    const first = store.update(initial.fingerprint, firstOp, async data => { entered(); await gate; return data })
    await hasEntered
    await expect(new GitReviewStore(cwd, { ...GIT_REVIEW_LIMITS }).update(initial.fingerprint, secondOp, async data => data)).rejects.toMatchObject({ code: 'STORE_BUSY' })
    release(); await first
    const before = await store.read()
    await expect(store.update(before.fingerprint, firstOp, async data => {
      await fs.writeFile(store.file, '{"version":1,"records":[]}  \n')
      return data
    })).rejects.toMatchObject({ code: 'STALE_STORE' })
    expect(await fs.readFile(store.file, 'utf8')).toBe('{"version":1,"records":[]}  \n')
    expect((await fs.readdir(store.directory)).filter(name => name !== 'state.json')).toEqual([])
    firstOp.dispose(); secondOp.dispose()
  })

  it('invalidates reviewed files when the baseline moves and rejects ambiguous or noncommit refs', async () => {
    const { cwd, service } = await fixture({ 'one.txt': 'base\n' })
    const initial = (await git(cwd, ['rev-parse', 'HEAD'])).toString().trim()
    await git(cwd, ['tag', 'chosen', initial])
    await write(cwd, 'one.txt', 'second\n'); await git(cwd, ['add', '--', '.']); await git(cwd, ['commit', '-qm', 'second'])
    await write(cwd, 'one.txt', 'third\n')
    const old = await service.getSnapshot({ baseRef: 'chosen' })
    await service.markReviewed({ baseRef: 'chosen', expectedSnapshotId: old.snapshotId, fileId: file(old, 'baseline', 'one.txt').id, reviewed: true })
    await git(cwd, ['tag', '-f', 'chosen', 'HEAD'])
    const next = await service.getSnapshot({ baseRef: 'chosen' })
    expect(file(next, 'baseline', 'one.txt').reviewed).toBe(false)
    await expect(service.exportPatch({ baseRef: 'chosen', expectedSnapshotId: old.snapshotId, range: 'baseline', fileIds: [file(old, 'baseline', 'one.txt').id] })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    await git(cwd, ['branch', 'chosen'])
    await expect(service.getSnapshot({ baseRef: 'chosen' })).rejects.toMatchObject({ code: 'INVALID_REF' })
    const tree = (await git(cwd, ['rev-parse', 'HEAD^{tree}'])).toString().trim()
    await expect(service.getSnapshot({ baseRef: tree })).rejects.toMatchObject({ code: 'INVALID_REF' })
    expect((await service.getSnapshot({ baseRef: initial })).base.oid).toBe(initial)
  })

  it('rejects metadata-only untracked marks, untracked patch selections, file-count excess and concurrent excess', async () => {
    const { cwd, service } = await fixture()
    await write(cwd, 'new.txt', 'untracked\n')
    const snapshot = await service.getSnapshot()
    const untracked = file(snapshot, 'untracked', 'new.txt')
    await expect(service.markReviewed({ expectedSnapshotId: snapshot.snapshotId, fileId: untracked.id, reviewed: true })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
    await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'unstaged', fileIds: [untracked.id] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await write(cwd, 'second-new.txt', 'more')
    await expect(new GitReviewService(cwd, { limits: { maxUntrackedFiles: 1 } }).getSnapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await git(cwd, ['add', '--', 'second-new.txt'])
    await expect(new GitReviewService(cwd, { limits: { maxFiles: 1 } }).getSnapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    const bounded = new GitReviewService(cwd, { limits: { maxConcurrent: 1 } })
    const running = bounded.getSnapshot()
    await expect(bounded.getTrackedFingerprint()).rejects.toMatchObject({ code: 'BUSY' })
    await running
  })
})

describe('GitReviewService repository boundary regressions', () => {
  it('keeps index-deleted residual files untracked and never hashes their unselected content', async () => {
    const { cwd, service } = await fixture({ 'removed.txt': 'base\n', 'keep.txt': 'keep\n' })
    await git(cwd, ['rm', '--cached', '--', 'removed.txt'])
    await write(cwd, 'removed.txt', 'residual private sentinel one\n')
    const snapshot = await service.getSnapshot()
    expect(file(snapshot, 'staged', 'removed.txt').status).toBe('deleted')
    expect(file(snapshot, 'baseline', 'removed.txt').status).toBe('deleted')
    expect(file(snapshot, 'untracked', 'removed.txt').selected).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('residual private sentinel')
    const first = await service.getTrackedFingerprint()
    await write(cwd, 'removed.txt', 'different private sentinel two\n')
    expect(await service.getTrackedFingerprint()).toEqual(first)
    const next = await service.getSnapshot()
    const selected = await service.readUntracked({ expectedSnapshotId: next.snapshotId, path: 'removed.txt' })
    expect(file(selected, 'untracked', 'removed.txt').text).toBe('different private sentinel two\n')
  })

  it('honors safe ignore rules without reading unselected large files or traversing ignored directories', async () => {
    const { cwd, service } = await fixture({ '.gitignore': 'ignored-dir/\n*.secret\n!keep.secret\n', 'nested/.gitignore': '*.tmp\n' })
    await write(cwd, '.git/info/exclude', 'private-exclude.txt\n')
    await write(cwd, 'ignored-dir/deep/huge.txt', 'ignored')
    await write(cwd, 'hide.secret', 'hidden'); await write(cwd, 'keep.secret', 'visible')
    await write(cwd, 'nested/hide.tmp', 'hidden'); await write(cwd, 'nested/show.txt', 'visible')
    await write(cwd, 'private-exclude.txt', 'hidden')
    await write(cwd, '[literal].txt', 'literal'); await write(cwd, '--danger.txt', 'literal')
    await write(cwd, 'huge-untracked.txt', 'x'.repeat(1024 * 1024 * 3))
    if (process.platform !== 'win32') await write(cwd, ':(glob)*.txt', 'literal')
    const snapshot = await service.getSnapshot()
    const names = snapshot.ranges.untracked.map(value => value.path)
    expect(names).toContain('keep.secret'); expect(names).toContain('nested/show.txt')
    expect(names).toContain('[literal].txt'); expect(names).toContain('--danger.txt'); expect(names).toContain('huge-untracked.txt')
    for (const absent of ['hide.secret', 'nested/hide.tmp', 'private-exclude.txt', 'ignored-dir/deep/huge.txt']) expect(names).not.toContain(absent)
    expect(file(snapshot, 'untracked', 'huge-untracked.txt').text).toBeUndefined()
    await expect(service.readUntracked({ expectedSnapshotId: snapshot.snapshotId, path: 'huge-untracked.txt' })).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
  })

  it('reads packed annotated refs and linked worktree metadata with split indexes without mutation', async () => {
    const { root, cwd } = await fixture({ 'one.txt': 'base\n' })
    const initial = (await git(cwd, ['rev-parse', 'HEAD'])).toString().trim()
    await git(cwd, ['tag', '-a', 'annotated', '-m', 'annotation'])
    await git(cwd, ['pack-refs', '--all'])
    const worktree = path.join(root, 'linked-worktree')
    await git(cwd, ['worktree', 'add', '-q', '-b', 'linked', worktree])
    await git(worktree, ['config', 'core.splitIndex', 'true'])
    await git(worktree, ['update-index', '--split-index'])
    await write(worktree, 'one.txt', 'linked working\n')
    const beforeMain = await diskState(cwd), beforeWorktree = await diskState(worktree)
    const service = new GitReviewService(worktree)
    const snapshot = await service.getSnapshot({ baseRef: 'refs/tags/annotated' })
    expect(snapshot.base.oid).toBe(initial)
    expect(file(snapshot, 'unstaged', 'one.txt').patch).toContain('+linked working\n')
    expect(await service.getTrackedFingerprint()).toEqual(snapshot.trackedFingerprint)
    expect(await diskState(cwd)).toEqual(beforeMain); expect(await diskState(worktree)).toEqual(beforeWorktree)
  })

  it('hashes raw bytes despite assume-unchanged and handles absent skip-worktree files without fake deletions', async () => {
    const { cwd, service } = await fixture({ 'one.txt': 'base\n', 'sparse.txt': 'sparse base\n' })
    await git(cwd, ['update-index', '--assume-unchanged', '--', 'one.txt'])
    await git(cwd, ['update-index', '--skip-worktree', '--', 'sparse.txt'])
    await fs.unlink(path.join(cwd, 'sparse.txt'))
    await write(cwd, 'one.txt', 'raw edited\n')
    const before = await diskState(cwd)
    const snapshot = await service.getSnapshot()
    expect(snapshot.ranges.unstaged.map(value => value.path)).toEqual(['one.txt'])
    expect(file(snapshot, 'unstaged', 'one.txt').patch).toContain('+raw edited\n')
    expect(await service.getTrackedFingerprint()).toEqual(snapshot.trackedFingerprint)
    expect(await diskState(cwd)).toEqual(before)
  })

  it('will not export unselected binary children through a literal directory pathspec', async () => {
    const { cwd, service } = await fixture({ 'path': 'ordinary old text\n' })
    await git(cwd, ['rm', '--', 'path'])
    await write(cwd, 'path/child.bin', Buffer.from([1, 0, 2]))
    await git(cwd, ['add', '--', 'path/child.bin'])
    const snapshot = await service.getSnapshot()
    const deletion = file(snapshot, 'staged', 'path')
    expect(deletion.patch).toBeUndefined()
    expect(deletion.exportable).toBe(false)
    await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'staged', fileIds: [deletion.id] })).rejects.toMatchObject({ code: 'UNSUPPORTED_FILE' })
  })
})

describe('GitReviewService content-bound reviews and patch export', () => {
  it('persists reviewed marks, detects same-mtime edits, and excludes untracked task state from code fingerprints', async () => {
    const { cwd, service } = await fixture()
    await write(cwd, 'one.txt', 'one\nedit\n')
    const snapshot = await service.getSnapshot()
    const target = file(snapshot, 'unstaged', 'one.txt')
    const saved = await service.markReviewed({ expectedSnapshotId: snapshot.snapshotId, expectedStoreFingerprint: snapshot.storeFingerprint, fileId: target.id, reviewed: true })
    expect(file(saved, 'unstaged', 'one.txt').reviewed).toBe(true)
    expect(file(await new GitReviewService(cwd).getSnapshot(), 'unstaged', 'one.txt').reviewed).toBe(true)
    expect((await service.getTrackedFingerprint()).fingerprint).toBe(snapshot.trackedFingerprint.fingerprint)
    await write(cwd, '.sakura/tasks/state.json', '{"untracked":"task-store"}')
    expect((await service.getTrackedFingerprint()).fingerprint).toBe(snapshot.trackedFingerprint.fingerprint)
    const stat = await fs.stat(path.join(cwd, 'one.txt'))
    await write(cwd, 'one.txt', 'one\nEDIT\n')
    await fs.utimes(path.join(cwd, 'one.txt'), stat.atime, stat.mtime)
    const changed = await service.getSnapshot()
    expect(file(changed, 'unstaged', 'one.txt').reviewed).toBe(false)
    expect(changed.trackedFingerprint.fingerprint).not.toBe(snapshot.trackedFingerprint.fingerprint)
    await expect(service.markReviewed({ expectedSnapshotId: snapshot.snapshotId, fileId: target.id, reviewed: true })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
    await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'unstaged', fileIds: [target.id] })).rejects.toMatchObject({ code: 'STALE_SNAPSHOT' })
  })

  it('exports one complete original Git patch that actually applies without mutating source files/index', async () => {
    const { root, cwd, service } = await fixture({ 'one.txt': 'old\n', 'remove.txt': 'remove\n', 'rename old.txt': 'rename\n' })
    await write(cwd, 'one.txt', 'new\n')
    await git(cwd, ['rm', '--', 'remove.txt'])
    await git(cwd, ['mv', '--', 'rename old.txt', 'rename new.txt'])
    await write(cwd, 'add.txt', 'added\n'); await git(cwd, ['add', '--', 'add.txt'])
    const snapshot = await service.getSnapshot()
    const before = await diskState(cwd)
    const exported = await service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'baseline', fileIds: snapshot.ranges.baseline.map(value => value.id) })
    expect(exported.byteLength).toBe(Buffer.byteLength(exported.patch))
    expect(exported.patch.startsWith('diff --git ')).toBe(true)
    expect(exported.patch).toContain('rename from rename old.txt')
    const apply = path.join(root, 'apply')
    await fs.mkdir(apply)
    await git(apply, ['init', '-q', '--initial-branch=main'])
    for (const [name, content] of Object.entries({ 'one.txt': 'old\n', 'remove.txt': 'remove\n', 'rename old.txt': 'rename\n' })) await write(apply, name, content)
    await git(apply, ['add', '--', '.']); await git(apply, ['commit', '-qm', 'initial'])
    await git(apply, ['apply', '--check', '-'], exported.patch)
    await git(apply, ['apply', '-'], exported.patch)
    expect(await fs.readFile(path.join(apply, 'one.txt'), 'utf8')).toBe('new\n')
    expect(await fs.readFile(path.join(apply, 'add.txt'), 'utf8')).toBe('added\n')
    expect(await fs.readFile(path.join(apply, 'rename new.txt'), 'utf8')).toBe('rename\n')
    await expect(fs.stat(path.join(apply, 'remove.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await diskState(cwd)).toEqual(before)
    await expect(service.exportPatch({ expectedSnapshotId: snapshot.snapshotId, range: 'staged', fileIds: [file(snapshot, 'unstaged', 'one.txt').id] })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('fails explicitly at file/output/patch limits and on cancellation, never returns truncated downloads', async () => {
    const { cwd } = await fixture()
    await write(cwd, 'one.txt', 'x'.repeat(1024))
    await expect(new GitReviewService(cwd, { limits: { maxFileBytes: 512 } }).getSnapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(new GitReviewService(cwd, { limits: { maxOutputBytes: 10 } }).getSnapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    await expect(new GitReviewService(cwd, { limits: { maxPatchBytes: 40 } }).getSnapshot()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' })
    const controller = new AbortController(); controller.abort()
    await expect(new GitReviewService(cwd).getSnapshot({ signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    const during = new AbortController()
    const running = new GitReviewService(cwd).getSnapshot({ signal: during.signal })
    setTimeout(() => during.abort(), 10)
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(new GitReviewService(cwd, { limits: { timeoutMs: 1 } }).getSnapshot()).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})
