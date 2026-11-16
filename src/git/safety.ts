import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { GitReviewError } from './types.js'

export const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export const digestParts = (parts: unknown): string => digest(JSON.stringify(parts))
export const missing = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')
export const sameIdentity = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory()
const normalize = (name: string): string => process.platform === 'win32' ? path.resolve(name).toLowerCase() : path.resolve(name)
export const samePath = (a: string, b: string): boolean => normalize(a) === normalize(b)

export function inside(root: string, target: string): boolean {
  const relative = path.relative(normalize(root), normalize(target))
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function localPath(name: string): void {
  if (!path.isAbsolute(name) || /\0/.test(name) || /^(?:\\\\|\/\/)/.test(name)) {
    throw new GitReviewError('UNSAFE_PATH', 'Only absolute local filesystem paths are supported.')
  }
}

/** Decode NUL-delimited Git paths without ever treating quoting, tabs or newlines as delimiters. */
export function utf8(bytes: Buffer, label = 'Git path'): string {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { throw new GitReviewError('UNSAFE_PATH', `${label} is not valid UTF-8; lossless display is not supported.`) }
}

export function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true }
  catch { return false }
}

export function nulRecords(bytes: Buffer): Buffer[] {
  if (!bytes.length) return []
  if (bytes[bytes.length - 1] !== 0) throw new GitReviewError('GIT_FAILED', 'Git returned incomplete NUL-delimited metadata.', 502)
  const records: Buffer[] = []
  let start = 0
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) {
    records.push(bytes.subarray(start, i))
    start = i + 1
  }
  return records
}

export function gitPath(name: string): string {
  if (!name || Buffer.byteLength(name) > 4096 || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new GitReviewError('UNSAFE_PATH', 'Unsafe repository-relative path.')
  }
  const parts = name.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.toLowerCase() === '.git') throw new GitReviewError('UNSAFE_PATH', 'Unsafe repository path component.')
    if (process.platform === 'win32' && (/[\\:*?"<>|\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw new GitReviewError('UNSAFE_PATH', 'This Git path cannot be represented safely on Windows.')
    }
  }
  return name
}

export const inScope = (name: string, scope: string): boolean => !scope || name.startsWith(scope + '/')
export const diskPath = (root: string, name: string): string => path.join(root, ...gitPath(name).split('/'))

export async function statOrNull(name: string): Promise<Stats | null> {
  try { return await fs.lstat(name) } catch (error) { if (missing(error)) return null; throw error }
}

/** Refuse reparse points/symlinks in every directory component, including on Windows. */
export async function guardDirectory(name: string): Promise<Stats> {
  localPath(name)
  const parsed = path.parse(path.resolve(name))
  let current = parsed.root
  for (const component of path.resolve(name).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    const info = await fs.lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(current), current)) {
      throw new GitReviewError('UNSAFE_PATH', 'A filesystem directory is linked or has changed.')
    }
  }
  return fs.lstat(name)
}

export interface SafeBytes { bytes: Buffer; stat: Stats }

/** Handle identity checks and O_NOFOLLOW complement parent containment checks. Never read a device/FIFO. */
export async function readRegular(name: string, maxBytes: number, singleLink = false): Promise<SafeBytes> {
  await guardDirectory(path.dirname(name))
  const before = await fs.lstat(name)
  if (!before.isFile() || before.isSymbolicLink() || (singleLink && before.nlink !== 1)) {
    throw new GitReviewError('UNSAFE_PATH', 'Expected an ordinary, unlinked file.')
  }
  if (before.size > maxBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'A file exceeds the configured byte limit.', 413)
  const handle = await fs.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!sameIdentity(before, opened) || !opened.isFile() || (singleLink && opened.nlink !== 1)) {
      throw new GitReviewError('STATE_CHANGED', 'The file changed while opening it.', 409)
    }
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1))
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    const after = await handle.stat()
    const current = await fs.lstat(name)
    await guardDirectory(path.dirname(name))
    if (!sameIdentity(opened, current) || current.isSymbolicLink() || !sameIdentity(opened, after) ||
        opened.size !== after.size || offset !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs ||
        (singleLink && (after.nlink !== 1 || current.nlink !== 1))) {
      throw new GitReviewError('STATE_CHANGED', 'The file changed during the read.', 409)
    }
    if (offset > maxBytes) throw new GitReviewError('LIMIT_EXCEEDED', 'A file exceeds the configured byte limit.', 413)
    return { bytes: buffer.subarray(0, offset), stat: after }
  } finally { await handle.close() }
}

export async function readLink(name: string): Promise<SafeBytes> {
  await guardDirectory(path.dirname(name))
  const before = await fs.lstat(name)
  if (!before.isSymbolicLink()) throw new GitReviewError('STATE_CHANGED', 'The symbolic link changed.', 409)
  const bytes = await fs.readlink(name, { encoding: 'buffer' })
  const after = await fs.lstat(name)
  await guardDirectory(path.dirname(name))
  if (!sameIdentity(before, after) || !after.isSymbolicLink() || before.ctimeMs !== after.ctimeMs) {
    throw new GitReviewError('STATE_CHANGED', 'The symbolic link changed during the read.', 409)
  }
  return { bytes, stat: after }
}

export async function optionalRegular(name: string, maxBytes: number, singleLink = false): Promise<Buffer | null> {
  try { return (await readRegular(name, maxBytes, singleLink)).bytes }
  catch (error) { if (missing(error)) return null; throw error }
}
