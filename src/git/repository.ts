import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { GitReviewError, type GitReviewLimits } from './types.js'
import { digestParts, diskPath, gitPath, guardDirectory, inScope, inside, localPath, nulRecords, optionalRegular, readRegular, statOrNull, utf8 } from './safety.js'
import { SafeGitProcess, type Operation } from './process.js'

export interface Repository {
  root: string
  workspace: string
  scope: string
  gitDir: string
  commonDir: string
  id: string
  format: 'sha1' | 'sha256'
  fileMode: boolean
}

export interface ObjectEntry { path: string; mode: string; oid: string; stage: number }
const validOid = (value: string, format: Repository['format']): boolean => new RegExp(`^[0-9a-f]{${format === 'sha1' ? 40 : 64}}$`).test(value)

async function metadataPointer(file: string, prefix: string, limit: number): Promise<string> {
  const text = utf8((await readRegular(file, limit, true)).bytes, 'Git metadata').trimEnd()
  if (!text.startsWith(prefix) || text.includes('\n') || text.includes('\r')) throw new GitReviewError('UNSAFE_REPOSITORY', 'Malformed Git metadata pointer.')
  const value = text.slice(prefix.length).trim()
  const target = path.resolve(path.dirname(file), value)
  localPath(target)
  await guardDirectory(target)
  return target
}

function repositoryConfig(bytes: Buffer | null): { format: Repository['format']; fileMode: boolean } {
  let section = ''
  let format: Repository['format'] = 'sha1'
  let fileMode = process.platform !== 'win32'
  for (const raw of (bytes?.toString('utf8') ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^[#;]/.test(line)) continue
    const header = /^\[([\w.-]+)(?:\s+".*")?\]/.exec(line)
    if (header) { section = header[1]!.toLowerCase(); continue }
    const pair = /^([\w.-]+)\s*(?:=\s*(.*))?$/.exec(line)
    if (!pair) continue
    const key = pair[1]!.toLowerCase()
    const value = (pair[2] ?? 'true').split(/\s[#;]/, 1)[0]!.trim().replace(/^"(.*)"$/, '$1').toLowerCase()
    if (section === 'extensions') {
      if (key === 'objectformat') {
        if (value !== 'sha1' && value !== 'sha256') throw new GitReviewError('UNSUPPORTED_REPOSITORY', 'Unsupported Git object format.')
        format = value
      } else if (key === 'refstorage' && value !== 'files') throw new GitReviewError('UNSUPPORTED_REPOSITORY', 'Only file-based Git references are supported.')
      else if (!['worktreeconfig', 'noop', 'preciousobjects', 'partialclone', 'refstorage', 'compatobjectformat'].includes(key)) {
        throw new GitReviewError('UNSUPPORTED_REPOSITORY', `Unsupported Git repository extension: ${key}.`)
      }
    }
    if (section === 'core' && key === 'filemode') fileMode = !['false', 'no', 'off', '0'].includes(value)
    if (section === 'core' && key === 'repositoryformatversion' && !['0', '1'].includes(value)) throw new GitReviewError('UNSUPPORTED_REPOSITORY', 'Unsupported repository format version.')
    if (section === 'core' && key === 'bare' && ['true', 'yes', 'on', '1'].includes(value)) throw new GitReviewError('UNSUPPORTED_REPOSITORY', 'Bare repositories have no reviewable worktree.')
  }
  return { format, fileMode }
}

export async function discoverRepository(cwd: string, limits: GitReviewLimits, op: Operation): Promise<Repository | null> {
  localPath(cwd)
  const workspace = await fs.realpath(cwd)
  localPath(workspace)
  await guardDirectory(workspace)
  let root = workspace
  while (true) {
    op.check()
    const marker = path.join(root, '.git')
    const info = await statOrNull(marker)
    if (info) {
      if (info.isSymbolicLink()) throw new GitReviewError('UNSAFE_REPOSITORY', 'Linked .git metadata is not supported.')
      const gitDir = info.isDirectory() ? marker : await metadataPointer(marker, 'gitdir:', limits.maxMetadataBytes)
      await guardDirectory(gitDir)
      const commonFile = path.join(gitDir, 'commondir')
      const commonDir = await statOrNull(commonFile) ? await metadataPointer(commonFile, '', limits.maxMetadataBytes) : gitDir
      const config = repositoryConfig(await optionalRegular(path.join(commonDir, 'config'), limits.maxMetadataBytes, true))
      const scope = path.relative(root, workspace).split(path.sep).join('/')
      if (scope) gitPath(scope)
      return { root, workspace, scope, gitDir, commonDir, id: digestParts([root, gitDir, commonDir]), ...config }
    }
    const parent = path.dirname(root)
    if (parent === root) return null
    root = parent
  }
}

function validateRefName(ref: string): string {
  if (!ref.startsWith('refs/') || ref.length > 512 || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.') || ref.endsWith('/')) {
    throw new GitReviewError('INVALID_REF', 'Expected a plain local ref, not a revision expression.')
  }
  for (const part of ref.split('/')) if (!part || part.startsWith('.') || part.endsWith('.lock')) throw new GitReviewError('INVALID_REF', 'Invalid local ref name.')
  return ref
}

export async function resolveRef(repo: Repository, requested: string, limits: GitReviewLimits, op: Operation): Promise<string | null> {
  op.check()
  const packed = await optionalRegular(path.join(repo.commonDir, 'packed-refs'), limits.maxMetadataBytes, true)
  const packedRefs = new Map<string, string>()
  for (const line of (packed?.toString('utf8') ?? '').split('\n')) {
    if (!line || line[0] === '#' || line[0] === '^') continue
    const split = line.indexOf(' ')
    if (split > 0) {
      const oid = line.slice(0, split)
      const ref = line.slice(split + 1).trimEnd()
      if (!validOid(oid, repo.format)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Malformed packed Git references.')
      packedRefs.set(ref, oid)
    }
  }
  const seen = new Set<string>()
  const read = async (ref: string, depth: number): Promise<string | null> => {
    op.check()
    if (depth > 8 || seen.has(ref)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Cyclic Git symbolic reference.')
    seen.add(ref)
    if (ref !== 'HEAD') validateRefName(ref)
    const base = ref === 'HEAD' || /^refs\/(?:worktree|bisect)\//.test(ref) ? repo.gitDir : repo.commonDir
    const value = await optionalRegular(path.join(base, ...ref.split('/')), limits.maxMetadataBytes, true)
    if (!value) return packedRefs.get(ref) ?? null
    const text = utf8(value, 'Git reference').trim()
    if (text.startsWith('ref: ')) return read(validateRefName(text.slice(5)), depth + 1)
    if (!validOid(text, repo.format)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Malformed Git reference object ID.')
    return text
  }
  if (requested === 'HEAD') return read('HEAD', 0)
  if (validOid(requested.toLowerCase(), repo.format)) return requested.toLowerCase()
  if (!requested || requested.startsWith('-') || requested.length > 512) throw new GitReviewError('INVALID_REF', 'Invalid local baseline reference.')
  const candidates = requested.startsWith('refs/') ? [validateRefName(requested)] : [validateRefName(`refs/heads/${requested}`), validateRefName(`refs/tags/${requested}`)]
  const found: string[] = []
  for (const candidate of candidates) { seen.clear(); const oid = await read(candidate, 0); if (oid) found.push(oid) }
  if (found.length !== 1) throw new GitReviewError('INVALID_REF', found.length ? 'Ambiguous local branch/tag; use the full ref.' : 'The requested local baseline does not exist.')
  return found[0]!
}

/** Only config-free read commands run here. The original repository is never a Git command target. */
export class IsolatedRepository {
  private constructor(
    readonly repo: Repository,
    readonly tempRoot: string,
    readonly gitDir: string,
    readonly git: SafeGitProcess,
    readonly indexBytes: Buffer | null,
  ) {}

  static async create(repo: Repository, executable: string, limits: GitReviewLimits, op: Operation): Promise<IsolatedRepository> {
    op.check()
    const tempBase = await fs.realpath(os.tmpdir())
    localPath(tempBase)
    const tempRoot = await fs.mkdtemp(path.join(tempBase, 'sakura-git-read-'))
    await fs.chmod(tempRoot, 0o700)
    const gitDir = path.join(tempRoot, 'metadata')
    try {
      for (const directory of ['objects/info', 'objects/pack', 'refs/heads']) await fs.mkdir(path.join(gitDir, directory), { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/isolated\n', { flag: 'wx', mode: 0o600 })
      const config = `[core]\nrepositoryformatversion = ${repo.format === 'sha256' ? 1 : 0}\nbare = false\nfilemode = ${repo.fileMode}\n` + (repo.format === 'sha256' ? '[extensions]\nobjectformat = sha256\n' : '')
      await fs.writeFile(path.join(gitDir, 'config'), config, { flag: 'wx', mode: 0o600 })
      const objects = path.join(repo.commonDir, 'objects')
      await guardDirectory(objects)
      const alternates = await optionalRegular(path.join(objects, 'info', 'alternates'), limits.maxMetadataBytes, true)
      if (alternates?.toString('utf8').trim()) throw new GitReviewError('UNSUPPORTED_REPOSITORY', 'Repositories with external object alternates are not read automatically.')
      // Do not let Git follow linked object shards/packs to a network or external filesystem.
      for (const name of await fs.readdir(objects)) {
        op.check()
        const item = path.join(objects, name)
        const info = await fs.lstat(item)
        if (info.isSymbolicLink()) throw new GitReviewError('UNSAFE_REPOSITORY', 'Linked Git object storage is not supported.')
        if (info.isDirectory()) {
          await guardDirectory(item)
          if (name === 'pack') {
            const packs = await fs.readdir(item)
            if (packs.length > limits.maxFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many Git pack metadata files.', 413)
            for (const pack of packs) if ((await fs.lstat(path.join(item, pack))).isSymbolicLink()) throw new GitReviewError('UNSAFE_REPOSITORY', 'Linked Git pack files are not supported.')
          }
        }
      }
      if (/[\r\n]/.test(objects)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Object storage paths containing newlines are unsupported.')
      await fs.writeFile(path.join(gitDir, 'objects', 'info', 'alternates'), objects.split(path.sep).join('/') + '\n', { flag: 'wx', mode: 0o600 })
      const indexBytes = await optionalRegular(path.join(repo.gitDir, 'index'), limits.maxMetadataBytes, true)
      if (indexBytes) await fs.writeFile(path.join(gitDir, 'index'), indexBytes, { flag: 'wx', mode: 0o600 })
      const sharedIndexes = (await fs.readdir(repo.gitDir)).filter(name => /^sharedindex\.[0-9a-f]{40,64}$/.test(name))
      if (sharedIndexes.length > 32) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many shared Git indexes.', 413)
      for (const name of sharedIndexes) {
        op.check()
        const bytes = (await readRegular(path.join(repo.gitDir, name), limits.maxMetadataBytes, true)).bytes
        await fs.writeFile(path.join(gitDir, name), bytes, { flag: 'wx', mode: 0o600 })
      }
      const excludes = await optionalRegular(path.join(repo.commonDir, 'info', 'exclude'), limits.maxMetadataBytes, true)
      if (excludes) { await fs.mkdir(path.join(gitDir, 'info')); await fs.writeFile(path.join(gitDir, 'info', 'exclude'), excludes, { flag: 'wx', mode: 0o600 }) }
      return new IsolatedRepository(repo, tempRoot, gitDir, new SafeGitProcess(executable, limits, op), indexBytes)
    } catch (error) { await fs.rm(tempRoot, { recursive: true, force: true }); throw error }
  }

  run(args: string[], input?: Buffer, allowedCodes?: number[]): Promise<Buffer> {
    return this.git.run(this.gitDir, this.repo.root, args, input, allowedCodes)
  }

  async index(): Promise<ObjectEntry[]> {
    const bytes = await this.run(['ls-files', '--stage', '--cached', '--full-name', '-z', '--', ...(this.repo.scope ? [this.repo.scope] : [])])
    const entries = nulRecords(bytes).map(record => {
      const tab = record.indexOf(9)
      const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/.exec(record.subarray(0, tab).toString('ascii'))
      if (tab < 0 || !match || !validOid(match[2]!, this.repo.format)) throw new GitReviewError('GIT_FAILED', 'Malformed Git index metadata.', 422)
      return { path: gitPath(utf8(record.subarray(tab + 1))), mode: match[1]!, oid: match[2]!, stage: Number(match[3]) }
    }).filter(entry => inScope(entry.path, this.repo.scope))
    if (new Set(entries.map(entry => entry.path)).size > this.git.limits.maxFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'The scoped index has too many files.', 413)
    return entries
  }

  async tree(commit: string): Promise<ObjectEntry[]> {
    const bytes = await this.run(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...(this.repo.scope ? [this.repo.scope] : [])])
    const entries = nulRecords(bytes).map(record => {
      const tab = record.indexOf(9)
      const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)$/.exec(record.subarray(0, tab).toString('ascii'))
      if (tab < 0 || !match || !validOid(match[2]!, this.repo.format)) throw new GitReviewError('GIT_FAILED', 'Malformed Git tree metadata.', 422)
      return { path: gitPath(utf8(record.subarray(tab + 1))), mode: match[1]!, oid: match[2]!, stage: 0 }
    }).filter(entry => inScope(entry.path, this.repo.scope))
    if (entries.length > this.git.limits.maxFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'The scoped baseline has too many files.', 413)
    return entries
  }

  async untracked(index: ObjectEntry[]): Promise<string[]> {
    const mirror = path.join(this.tempRoot, 'ignore-worktree')
    await fs.mkdir(mirror, { mode: 0o700 })
    const tracked = new Set(index.map(entry => entry.path))
    const names: string[] = []
    const ownStore = `${this.repo.scope ? this.repo.scope + '/' : ''}.sakura/git-review`
    let scanned = 0
    let ignoreBytes = 0
    const loadIgnore = async (relative: string): Promise<void> => {
      const sourceDirectory = relative ? diskPath(this.repo.root, relative) : this.repo.root
      const targetDirectory = relative ? diskPath(mirror, relative) : mirror
      await guardDirectory(sourceDirectory)
      await fs.mkdir(targetDirectory, { recursive: true, mode: 0o700 })
      const source = path.join(sourceDirectory, '.gitignore')
      const info = await statOrNull(source)
      // Git does not follow .gitignore symlinks. Ignore rules are data, never executable configuration.
      if (info?.isFile() && !info.isSymbolicLink()) {
        const bytes = (await readRegular(source, this.git.limits.maxMetadataBytes, true)).bytes
        ignoreBytes += bytes.length
        if (ignoreBytes > this.git.limits.maxMetadataBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'Ignore metadata exceeds the byte limit.', 413)
        await fs.writeFile(path.join(targetDirectory, '.gitignore'), bytes, { flag: 'wx', mode: 0o600 })
      }
    }
    await loadIgnore('')
    if (this.repo.scope) {
      const parts = this.repo.scope.split('/')
      for (let i = 1; i <= parts.length; i++) await loadIgnore(parts.slice(0, i).join('/'))
    }
    const add = (name: string) => {
      names.push(name)
      if (names.length > this.git.limits.maxUntrackedFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many untracked files in this workspace.', 413)
    }
    const visit = async (relative: string, depth: number): Promise<void> => {
      this.git.op.check()
      if (depth > 64) throw new GitReviewError('LIMIT_EXCEEDED', 'Untracked directory nesting exceeds the limit.', 413)
      const directory = relative ? diskPath(this.repo.root, relative) : this.repo.root
      await guardDirectory(directory)
      const children: { name: string; directory: boolean; linked: boolean }[] = []
      const handle = await fs.opendir(directory)
      for await (const entry of handle) {
        this.git.op.check()
        if (++scanned > this.git.limits.maxFiles + this.git.limits.maxUntrackedFiles * 4 + 1024) throw new GitReviewError('LIMIT_EXCEEDED', 'Untracked directory scan exceeds the entry limit.', 413)
        if (entry.name.toLowerCase() === '.git') continue
        const name = gitPath(relative ? `${relative}/${entry.name}` : entry.name)
        if (name === ownStore || tracked.has(name)) continue
        const info = await fs.lstat(diskPath(this.repo.root, name))
        const isDirectory = info.isDirectory() && !info.isSymbolicLink()
        if (isDirectory) await fs.mkdir(diskPath(mirror, name), { recursive: true, mode: 0o700 })
        children.push({ name, directory: isDirectory, linked: info.isSymbolicLink() })
      }
      if (!children.length) return
      // Only the safe mirror is visible to Git. Windows junctions must never be traversed by ls-files.
      const input = Buffer.from(children.map(child => './' + child.name + (child.directory ? '/' : '')).join('\0') + '\0')
      const ignored = new Set(nulRecords(await this.git.run(this.gitDir, mirror, ['check-ignore', '--no-index', '-z', '--stdin', '--'], input, [0, 1])).map(record => utf8(record)).map(name => name.replace(/^\.\//, '').replace(/\/$/, '')))
      for (const child of children) {
        this.git.op.check()
        if (ignored.has(child.name)) continue
        if (!child.directory || child.linked) { add(child.name); continue }
        await guardDirectory(diskPath(this.repo.root, child.name))
        // Nested repositories and submodules are metadata, never recursively scanned.
        if (await statOrNull(path.join(diskPath(this.repo.root, child.name), '.git'))) { add(child.name); continue }
        await loadIgnore(child.name)
        await visit(child.name, depth + 1)
      }
    }
    await visit(this.repo.scope, 0)
    return names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  }

  async assertIndexUnchanged(): Promise<void> {
    this.git.op.check()
    const current = await optionalRegular(path.join(this.repo.gitDir, 'index'), this.git.limits.maxMetadataBytes, true)
    if (Boolean(current) !== Boolean(this.indexBytes) || (current && this.indexBytes && !current.equals(this.indexBytes))) {
      throw new GitReviewError('STATE_CHANGED', 'The Git index changed while capturing the snapshot.', 409)
    }
  }

  async dispose(): Promise<void> { await fs.rm(this.tempRoot, { recursive: true, force: true }) }
}

export async function submoduleHead(repo: Repository, name: string, limits: GitReviewLimits, op: Operation): Promise<string | null> {
  const root = diskPath(repo.root, name)
  const info = await statOrNull(root)
  if (!info?.isDirectory() || info.isSymbolicLink()) return null
  const marker = path.join(root, '.git')
  const markerInfo = await statOrNull(marker)
  if (!markerInfo || markerInfo.isSymbolicLink()) return null
  const gitDir = markerInfo.isDirectory() ? marker : await metadataPointer(marker, 'gitdir:', limits.maxMetadataBytes)
  if (!inside(repo.commonDir, gitDir) && !inside(root, gitDir)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Submodule metadata points outside the containing repository.')
  await guardDirectory(gitDir)
  return resolveRef({ ...repo, root, gitDir, commonDir: gitDir }, 'HEAD', limits, op)
}
