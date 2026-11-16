import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { GitReviewError, type GitChangeStatus, type GitConflictStage, type GitReviewFile, type GitReviewRange } from './types.js'
import { digestParts, diskPath, gitPath, guardDirectory, inScope, isText, nulRecords, readLink, readRegular, statOrNull, utf8 } from './safety.js'
import { IsolatedRepository, type ObjectEntry, submoduleHead } from './repository.js'

export interface ContentEntry extends ObjectEntry { bytes?: Buffer; directory?: boolean }
export type ContentMap = Map<string, ContentEntry>
interface LoadedObject { type: string; bytes: Buffer }

export class GitObjects {
  private readonly cache = new Map<string, LoadedObject>()
  private consumed = 0
  private readonly metadataObjects = new Set<string>()
  readonly patchWorktree: string

  constructor(readonly isolated: IsolatedRepository) { this.patchWorktree = path.join(isolated.tempRoot, 'empty-worktree') }

  account(bytes: number): void {
    this.isolated.git.op.check()
    this.consumed += bytes
    if (this.consumed > this.isolated.git.limits.maxTotalBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'Snapshot content exceeds the aggregate byte limit.', 413)
  }

  private async prefetch(oids: string[]): Promise<void> {
    const missing = [...new Set(oids)].filter(oid => !this.cache.has(oid))
    if (!missing.length) return
    const length = this.isolated.repo.format === 'sha1' ? 40 : 64
    for (const oid of missing) {
      this.isolated.git.op.check()
      if (!new RegExp(`^[0-9a-f]{${length}}$`).test(oid)) throw new GitReviewError('INVALID_REF', 'Invalid object ID.')
      const loose = path.join(this.isolated.repo.commonDir, 'objects', oid.slice(0, 2), oid.slice(2))
      const looseInfo = await statOrNull(loose)
      if (looseInfo) {
        await guardDirectory(path.dirname(loose))
        if (!looseInfo.isFile() || looseInfo.isSymbolicLink()) throw new GitReviewError('UNSAFE_REPOSITORY', 'Linked or special Git objects are not supported.')
      }
    }
    const headers = (await this.isolated.run(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], Buffer.from(missing.join('\n') + '\n'))).toString('ascii').trimEnd().split('\n')
    if (headers.length !== missing.length) throw new GitReviewError('GIT_FAILED', 'Git returned incomplete object metadata.', 422)
    const metadata = missing.map((oid, index) => {
      const header = headers[index]!
      const match = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header)
      if (!match || match[1] !== oid) throw new GitReviewError('INVALID_REF', 'Required object is not present locally; lazy fetching is disabled.')
      const size = Number(match[3])
      const maximum = match[2] === 'blob' ? this.isolated.git.limits.maxFileBytes : this.isolated.git.limits.maxMetadataBytes
      if (!Number.isSafeInteger(size) || size > maximum) throw new GitReviewError('LIMIT_EXCEEDED', 'A Git object exceeds its configured byte limit.', 413)
      this.account(size)
      return { oid, type: match[2]!, size, header }
    })
    for (let start = 0; start < metadata.length;) {
      this.isolated.git.op.check()
      let end = start
      let budget = 0
      while (end < metadata.length) {
        const object = metadata[end]!
        const nextSize = object.size + object.header.length + 2
        if (nextSize > this.isolated.git.limits.maxOutputBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'Git object output exceeds the configured byte limit.', 413)
        if (end > start && budget + nextSize > Math.min(this.isolated.git.limits.maxOutputBytes, 4 * 1024 * 1024)) break
        budget += nextSize
        end++
      }
      const group = metadata.slice(start, end)
      const output = await this.isolated.run(['cat-file', '--batch'], Buffer.from(group.map(object => object.oid).join('\n') + '\n'))
      let offset = 0
      for (const object of group) {
        const separator = output.indexOf(10, offset)
        const finish = separator + 1 + object.size
        if (separator < 0 || output.subarray(offset, separator).toString('ascii') !== object.header || finish >= output.length || output[finish] !== 10) {
          throw new GitReviewError('GIT_FAILED', 'Git returned incomplete object content.', 422)
        }
        const bytes = output.subarray(separator + 1, finish)
        if (this.objectId(object.type, bytes) !== object.oid) throw new GitReviewError('UNSAFE_REPOSITORY', 'Git object content does not match its object ID.')
        this.cache.set(object.oid, { type: object.type, bytes })
        offset = finish + 1
      }
      if (offset !== output.length) throw new GitReviewError('GIT_FAILED', 'Unexpected data followed Git object content.', 422)
      start = end
    }
  }

  async object(oid: string): Promise<LoadedObject> {
    await this.prefetch([oid])
    return this.cache.get(oid)!
  }

  async commit(oid: string): Promise<string> {
    const seen = new Set<string>()
    for (let depth = 0; depth < 8; depth++) {
      if (seen.has(oid)) break
      seen.add(oid)
      const object = await this.object(oid)
      if (object.type === 'commit') return oid
      if (object.type !== 'tag') break
      const match = /^object ([0-9a-f]+)\n/.exec(object.bytes.toString('utf8'))
      if (!match) break
      oid = match[1]!
    }
    throw new GitReviewError('INVALID_REF', 'The local baseline must resolve to a commit.')
  }

  objectId(type: string, bytes: Buffer): string {
    return createHash(this.isolated.repo.format).update(`${type} ${bytes.length}\0`).update(bytes).digest('hex')
  }

  /** Private, ephemeral object files only: no Git write command and no real index/object mutation. */
  async materialize(type: 'blob' | 'tree', bytes: Buffer): Promise<string> {
    this.isolated.git.op.check()
    const oid = this.objectId(type, bytes)
    if (!this.metadataObjects.has(oid)) {
      const directory = path.join(this.isolated.gitDir, 'objects', oid.slice(0, 2))
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const content = deflateSync(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes]))
      await fs.writeFile(path.join(directory, oid.slice(2)), content, { flag: 'wx', mode: 0o600 })
      this.metadataObjects.add(oid)
    }
    return oid
  }

  async load(entries: ObjectEntry[]): Promise<ContentMap> {
    const result: ContentMap = new Map()
    await this.prefetch(entries.filter(entry => entry.stage === 0 && entry.mode !== '160000').map(entry => entry.oid))
    for (const entry of entries) {
      this.isolated.git.op.check()
      if (entry.stage !== 0) continue
      if (!['100644', '100755', '120000', '160000'].includes(entry.mode)) throw new GitReviewError('UNSUPPORTED_REPOSITORY', `Unsupported index/tree mode ${entry.mode}.`)
      if (entry.mode === '160000') { result.set(entry.path, entry); continue }
      const object = await this.object(entry.oid)
      if (object.type !== 'blob') throw new GitReviewError('UNSAFE_REPOSITORY', 'A tracked file does not refer to a blob.')
      await this.materialize('blob', object.bytes)
      result.set(entry.path, { ...entry, bytes: object.bytes })
    }
    return result
  }

  async worktree(entries: ObjectEntry[], materialize = true): Promise<ContentMap> {
    const expected = new Map<string, ObjectEntry>()
    for (const entry of entries) if (!expected.has(entry.path) || entry.stage === 0) expected.set(entry.path, entry)
    if (expected.size > this.isolated.git.limits.maxFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many tracked files in the selected scope.', 413)
    const skipWorktree = new Set<string>()
    const flags = nulRecords(await this.isolated.run(['ls-files', '-t', '-z', '--cached', '--full-name', '--', ...(this.isolated.repo.scope ? [this.isolated.repo.scope] : [])]))
    for (const flag of flags) if (flag[0] === 83 && flag[1] === 32) skipWorktree.add(gitPath(utf8(flag.subarray(2))))
    const result: ContentMap = new Map()
    for (const [name, entry] of [...expected].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      this.isolated.git.op.check()
      const target = diskPath(this.isolated.repo.root, name)
      const stat = await statOrNull(target)
      if (!stat) {
        // An absent skip-worktree path belongs to a sparse checkout, not a user deletion.
        if (skipWorktree.has(name)) {
          if (materialize) {
            const content = (await this.load([{ ...entry, stage: 0 }])).get(name)
            if (content) result.set(name, content)
          } else result.set(name, { ...entry, stage: 0 })
        }
        continue
      }
      await guardDirectory(path.dirname(target))
      if (entry.mode === '160000' && stat.isDirectory() && !stat.isSymbolicLink()) {
        result.set(name, { ...entry, stage: 0, oid: await submoduleHead(this.isolated.repo, name, this.isolated.git.limits, this.isolated.git.op) ?? entry.oid })
        continue
      }
      // A file replaced by an ordinary directory is a deletion; do not recurse into it.
      if (stat.isDirectory() && !stat.isSymbolicLink()) continue
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new GitReviewError('UNSAFE_PATH', 'A tracked path is a device or other special file.')
      const read = stat.isSymbolicLink() ? await readLink(target) : await readRegular(target, this.isolated.git.limits.maxFileBytes)
      if (read.bytes.length > this.isolated.git.limits.maxFileBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'A symbolic link exceeds the file byte limit.', 413)
      this.account(read.bytes.length)
      const mode = stat.isSymbolicLink() ? '120000' : this.isolated.repo.fileMode
        ? (read.stat.mode & 0o111 ? '100755' : '100644') : (entry.mode === '100755' ? '100755' : '100644')
      const oid = materialize ? await this.materialize('blob', read.bytes) : this.objectId('blob', read.bytes)
      result.set(name, { path: name, stage: 0, mode, oid, bytes: read.bytes })
    }
    return result
  }

  async tree(entries: ContentMap): Promise<string> {
    interface Directory { files: Map<string, ContentEntry>; directories: Map<string, Directory> }
    const make = (): Directory => ({ files: new Map(), directories: new Map() })
    const root = make()
    for (const entry of entries.values()) {
      const components = gitPath(entry.path).split('/')
      let directory = root
      for (const component of components.slice(0, -1)) {
        if (directory.files.has(component)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Conflicting file and directory paths in Git metadata.')
        let child = directory.directories.get(component)
        if (!child) { child = make(); directory.directories.set(component, child) }
        directory = child
      }
      const name = components[components.length - 1]!
      if (directory.directories.has(name) || directory.files.has(name)) throw new GitReviewError('UNSAFE_REPOSITORY', 'Duplicate Git tree paths.')
      directory.files.set(name, entry)
    }
    const write = async (directory: Directory): Promise<string> => {
      const parts: { name: string; mode: string; oid: string; order: Buffer }[] = []
      for (const [name, file] of directory.files) parts.push({ name, mode: file.mode.replace(/^0+/, ''), oid: file.oid, order: Buffer.from(name) })
      for (const [name, child] of directory.directories) parts.push({ name, mode: '40000', oid: await write(child), order: Buffer.from(name + '/') })
      parts.sort((a, b) => Buffer.compare(a.order, b.order))
      return this.materialize('tree', Buffer.concat(parts.map(part => Buffer.concat([Buffer.from(`${part.mode} ${part.name}\0`), Buffer.from(part.oid, 'hex')]))))
    }
    return write(root)
  }

  async diff(oldTree: string, newTree: string, patch: boolean, paths: string[] = []): Promise<Buffer> {
    await fs.mkdir(this.patchWorktree, { recursive: true, mode: 0o700 })
    const args = ['diff-tree', '--no-commit-id', '-r', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none',
      '--find-renames=50%', '-l200', '--full-index', '--diff-algorithm=myers', '--no-indent-heuristic',
      ...(patch ? ['--patch', '--unified=3', '--src-prefix=a/', '--dst-prefix=b/'] : ['--raw', '-z', '--no-abbrev']),
      oldTree, newTree, '--', ...paths.map(gitPath)]
    const output = await this.isolated.git.run(this.isolated.gitDir, this.patchWorktree, args)
    if (patch && output.length > this.isolated.git.limits.maxPatchBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'The complete patch exceeds the configured byte limit.', 413)
    return output
  }
}

export interface RangeView { files: GitReviewFile[]; oldTree: string; newTree: string; before: ContentMap; after: ContentMap }
const statusMap: Record<string, GitChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', T: 'type_changed', U: 'conflicted' }
const zeroOid = (oid: string): string | null => /^0+$/.test(oid) ? null : oid
const ordinary = (entry: ContentEntry | undefined): boolean => !entry || entry.mode === '100644' || entry.mode === '100755'

function fileMetadata(range: GitReviewRange, oldPath: string | null, newPath: string | null, before: ContentEntry | undefined, after: ContentEntry | undefined, status: GitChangeStatus): GitReviewFile {
  const name = newPath ?? oldPath!
  const binary = Boolean((before?.bytes && !isText(before.bytes)) || (after?.bytes && !isText(after.bytes)))
  const symlink = before?.mode === '120000' || after?.mode === '120000'
  const submodule = before?.mode === '160000' || after?.mode === '160000'
  const fingerprint = digestParts([range, oldPath, newPath, before?.mode ?? null, before?.oid ?? null, after?.mode ?? null, after?.oid ?? null])
  return {
    id: digestParts([range, oldPath, newPath]), range, status, path: name, oldPath, newPath,
    oldMode: before?.mode ?? null, newMode: after?.mode ?? null, oldOid: before?.oid ?? null, newOid: after?.oid ?? null,
    oldBytes: before?.bytes?.length ?? null, newBytes: after?.bytes?.length ?? null,
    binary, conflict: false, submodule, symlink,
    ...(submodule ? { submoduleDirty: null } : {}),
    ...(before?.mode === '120000' && before.bytes ? { oldLinkTarget: utf8(before.bytes, 'Symbolic link') } : {}),
    ...(after?.mode === '120000' && after.bytes ? { newLinkTarget: utf8(after.bytes, 'Symbolic link') } : {}),
    fingerprint, reviewed: false, exportable: range !== 'untracked' && !binary && !symlink && !submodule && ordinary(before) && ordinary(after),
  }
}

export async function rangeView(objects: GitObjects, range: Exclude<GitReviewRange, 'untracked'>, before: ContentMap, after: ContentMap, conflicts: Map<string, ObjectEntry[]>): Promise<RangeView> {
  const oldTree = await objects.tree(before)
  const newTree = await objects.tree(after)
  const records = nulRecords(await objects.diff(oldTree, newTree, false))
  const files: GitReviewFile[] = []
  let patchBytes = 0
  for (let i = 0; i < records.length; i++) {
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDRTU])(\d*)$/.exec(records[i]!.toString('ascii'))
    if (!match || !records[i + 1]) throw new GitReviewError('GIT_FAILED', 'Malformed raw Git diff.', 422)
    const first = gitPath(utf8(records[++i]!))
    const code = match[5]!
    const second = code === 'R' ? gitPath(utf8(records[++i] ?? Buffer.alloc(0))) : first
    if (!inScope(first, objects.isolated.repo.scope) || !inScope(second, objects.isolated.repo.scope)) throw new GitReviewError('UNSAFE_PATH', 'Git diff escaped the workspace scope.')
    const oldPath = code === 'A' ? null : first
    const newPath = code === 'D' ? null : second
    const oldEntry = oldPath ? before.get(oldPath) : undefined
    const newEntry = newPath ? after.get(newPath) : undefined
    if (conflicts.has(first) || conflicts.has(second)) continue
    if (zeroOid(match[3]!) !== (oldEntry?.oid ?? null) || zeroOid(match[4]!) !== (newEntry?.oid ?? null)) throw new GitReviewError('GIT_FAILED', 'Git diff object metadata disagrees with the captured content.', 422)
    const file = fileMetadata(range, oldPath, newPath, oldEntry, newEntry, statusMap[code]!)
    if ((oldPath && after.has(oldPath) && oldPath !== newPath) || (newPath && before.has(newPath) && newPath !== oldPath) ||
        [...before.keys(), ...after.keys()].some(name => [oldPath, newPath].some(selected => selected !== null && name.startsWith(selected + '/')))) file.exportable = false
    if (code === 'R') file.similarity = Number(match[6])
    if (file.exportable) {
      const paths = [...new Set([oldPath, newPath].filter((name): name is string => name !== null))]
      const oldSelected: ContentMap = new Map(paths.flatMap(name => { const entry = before.get(name); return entry ? [[name, entry] as const] : [] }))
      const newSelected: ContentMap = new Map(paths.flatMap(name => { const entry = after.get(name); return entry ? [[name, entry] as const] : [] }))
      const patch = await objects.diff(await objects.tree(oldSelected), await objects.tree(newSelected), true, paths)
      patchBytes += patch.length
      if (patchBytes > objects.isolated.git.limits.maxPatchBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'Review patches exceed the aggregate byte limit.', 413)
      file.patch = utf8(patch, 'Git patch')
    }
    files.push(file)
  }
  for (const [name, entries] of conflicts) {
    const file = fileMetadata(range, before.has(name) ? name : null, name, before.get(name), after.get(name), 'conflicted')
    file.conflict = true
    file.exportable = false
    file.conflictStages = entries.map(entry => ({ stage: entry.stage as GitConflictStage['stage'], oid: entry.oid, mode: entry.mode }))
    for (const entry of entries) {
      if (entry.mode === '160000') { file.submodule = true; file.submoduleDirty = null }
      else {
        const object = await objects.object(entry.oid)
        if (object.type !== 'blob') throw new GitReviewError('UNSAFE_REPOSITORY', 'A conflict stage does not refer to a blob.')
        file.binary ||= !isText(object.bytes)
        file.symlink ||= entry.mode === '120000'
      }
    }
    file.fingerprint = digestParts([file.fingerprint, file.conflictStages])
    files.push(file)
  }
  if (files.length > objects.isolated.git.limits.maxFiles) throw new GitReviewError('LIMIT_EXCEEDED', 'Too many changed files.', 413)
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  return { files, oldTree, newTree, before, after }
}

export async function untrackedFiles(objects: GitObjects, names: string[], selected: Set<string>): Promise<GitReviewFile[]> {
  for (const name of selected) if (!names.includes(name)) throw new GitReviewError('INVALID_ARGUMENT', 'An explicitly selected untracked file is not present in this snapshot.')
  const files: GitReviewFile[] = []
  for (const name of names) {
    objects.isolated.git.op.check()
    const target = diskPath(objects.isolated.repo.root, name)
    await guardDirectory(path.dirname(target))
    const info = await statOrNull(target)
    if (!info) throw new GitReviewError('STATE_CHANGED', 'An untracked path changed during capture.', 409)
    const chosen = selected.has(name)
    const symlink = info.isSymbolicLink()
    const directory = info.isDirectory()
    if (chosen && (!info.isFile() || symlink || directory)) throw new GitReviewError('UNSUPPORTED_FILE', 'Only explicitly selected ordinary untracked files may be read.')
    let bytes: Buffer | undefined
    if (chosen) {
      bytes = (await readRegular(target, objects.isolated.git.limits.maxFileBytes, true)).bytes
      objects.account(bytes.length)
    }
    const mode = symlink ? '120000' : directory ? '040000' : (info.mode & 0o111 ? '100755' : '100644')
    const after: ContentEntry = { path: name, oid: bytes ? objects.objectId('blob', bytes) : '', mode, stage: 0, bytes }
    const file = fileMetadata('untracked', null, name, undefined, after, 'untracked')
    file.newOid = null
    file.newBytes = info.size
    file.selected = chosen
    file.exportable = false
    file.fingerprint = chosen ? digestParts([name, mode, after.oid]) : digestParts(['untracked-metadata-only', name, mode, info.size])
    if (bytes && isText(bytes)) file.text = bytes.toString('utf8')
    files.push(file)
  }
  return files
}

export const mapFingerprint = (map: ContentMap): unknown[] => [...map.values()].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(entry => [entry.path, entry.mode, entry.oid])
