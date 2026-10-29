/** User-selected Skill files are data, never packages to install or scripts to execute. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { parse as parseYaml } from 'yaml'

export const SKILL_IMPORT_MAX_BYTES = 4 * 1024 * 1024
export const SKILL_IMPORT_MAX_FILES = 128
const MAX_SKILL_BYTES = 256 * 1024

export interface SkillImportFile { path: string; content: string }
export interface SkillImportRequest { scope: 'project' | 'user'; files: SkillImportFile[] }
export interface SkillImportResult { name: string; scope: 'project' | 'user'; dir: string; files: number }

export class SkillImportError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'SkillImportError' }
}

function safePart(part: string): boolean {
  return !!part && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f<>:"|?*]/.test(part) &&
    !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
}

function skillName(raw: string, fallback: string): string {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  let meta: unknown
  try { meta = frontmatter ? parseYaml(frontmatter[1] ?? '', { maxAliasCount: 0 }) : undefined }
  catch { throw new SkillImportError(400, 'SKILL.md 的 YAML 元数据无效。') }
  if (meta != null && (typeof meta !== 'object' || Array.isArray(meta))) throw new SkillImportError(400, 'Skill 元数据必须是键值对象。')
  const row = meta as Record<string, unknown> | undefined
  if (row?.name !== undefined && typeof row.name !== 'string') throw new SkillImportError(400, 'Skill 名称必须是文本。')
  const name = typeof row?.name === 'string' ? row.name.trim() : fallback
  if (name.length > 100 || !safePart(name) || /[\\/]/.test(name)) throw new SkillImportError(400, 'Skill 名称必须是安全的单级目录名（不超过 100 字）。')
  const body = frontmatter ? raw.slice(frontmatter[0].length).trim() : raw.trim()
  if (!body) throw new SkillImportError(400, 'SKILL.md 需要非空指令正文。')
  return name
}

function normalizeFiles(value: unknown): { files: SkillImportFile[]; fallback: string } {
  if (!Array.isArray(value) || !value.length || value.length > SKILL_IMPORT_MAX_FILES) throw new SkillImportError(400, `请选择 1–${SKILL_IMPORT_MAX_FILES} 个 Skill 文本文件。`)
  const files: SkillImportFile[] = []
  let bytes = 0
  for (const item of value) {
    const row = item as Record<string, unknown> | null
    if (!row || typeof row.path !== 'string' || typeof row.content !== 'string' || row.content.includes('\0')) throw new SkillImportError(400, 'Skill 文件必须包含相对路径及文本内容。')
    const file = row.path.replace(/\\/g, '/')
    if (file.length > 240 || file.split('/').some(part => !safePart(part))) throw new SkillImportError(400, 'Skill 文件路径不能包含绝对路径、..、特殊设备名或控制字符。')
    bytes += Buffer.byteLength(row.content, 'utf8')
    if (bytes > SKILL_IMPORT_MAX_BYTES) throw new SkillImportError(413, 'Skill 导入总大小不能超过 4 MiB。')
    files.push({ path: file, content: row.content.replace(/^\uFEFF/, '') })
  }
  const markers = files.filter(file => /(?:^|\/)SKILL\.md$/i.test(file.path))
  if (markers.length !== 1) throw new SkillImportError(400, '一次导入一个 Skill，需要且只能包含一个 SKILL.md。')
  const marker = markers[0]!
  const prefix = marker.path.slice(0, marker.path.lastIndexOf('/') + 1)
  if (files.some(file => !file.path.startsWith(prefix))) throw new SkillImportError(400, '所有文件必须属于同一个 Skill 文件夹。')
  const fallback = prefix ? prefix.slice(0, -1).split('/').at(-1)! : 'imported-skill'
  const seen = new Set<string>()
  const normalized = files.map(file => {
    let relative = file.path.slice(prefix.length)
    if (/^SKILL\.md$/i.test(relative)) relative = 'SKILL.md'
    const key = relative.toLowerCase()
    if (seen.has(key)) throw new SkillImportError(400, 'Skill 中存在重复或大小写冲突的文件路径。')
    seen.add(key)
    return { path: relative, content: file.content }
  })
  for (const file of normalized) {
    const parents = file.path.split('/').slice(0, -1)
    for (let i = 1; i <= parents.length; i++) if (seen.has(parents.slice(0, i).join('/').toLowerCase())) throw new SkillImportError(400, 'Skill 文件和目录路径冲突。')
  }
  if (Buffer.byteLength(marker.content, 'utf8') > MAX_SKILL_BYTES) throw new SkillImportError(413, 'SKILL.md 不能超过 256 KiB。')
  return { files: normalized, fallback }
}

/** Walk from a trusted selected workspace/home, rejecting junctions and symlink descendants. */
async function ensureDirectory(base: string, parts: string[]): Promise<string> {
  let dir = path.resolve(base)
  if (!(await fs.stat(dir)).isDirectory()) throw new SkillImportError(400, '导入目标不是目录。')
  for (const part of parts) {
    dir = path.join(dir, part)
    await fs.mkdir(dir).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    const stat = await fs.lstat(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillImportError(400, 'Skill 目标目录不能是符号链接或联接。')
  }
  return dir
}

export async function importSkill(cwd: string, value: unknown): Promise<SkillImportResult> {
  const row = value as Record<string, unknown> | null
  if (!row || typeof row !== 'object' || Array.isArray(row) || !['project', 'user'].includes(String(row.scope)) ||
    Object.keys(row).some(key => !['scope', 'files'].includes(key))) throw new SkillImportError(400, '请选择导入到当前工作区或用户 Skill 库。')
  const scope = row.scope as 'project' | 'user'
  const { files, fallback } = normalizeFiles(row.files)
  const name = skillName(files.find(file => file.path === 'SKILL.md')!.content, fallback)
  const root = await ensureDirectory(scope === 'project' ? cwd : os.homedir(), ['.sakura', 'skills'])
  const target = path.join(root, name)
  // Never merge or overwrite a user's installed skill implicitly.
  if ((await fs.readdir(root)).some(entry => entry.toLowerCase() === name.toLowerCase())) throw new SkillImportError(409, '同名 Skill 已存在，请修改名称后导入；原文件未改动。')
  const temp = path.join(root, `.import-${randomUUID()}`)
  try {
    await fs.mkdir(temp, { mode: 0o700 })
    for (const file of files) {
      const absolute = path.join(temp, ...file.path.split('/'))
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      await fs.writeFile(absolute, file.content, { flag: 'wx', mode: 0o600 })
    }
    await fs.rename(temp, target)
    return { name, scope, dir: target, files: files.length }
  } catch (error) {
    if (error instanceof SkillImportError) throw error
    throw new SkillImportError(500, 'Skill 导入失败，请检查目录权限；没有执行任何导入文件。')
  } finally { await fs.rm(temp, { recursive: true, force: true }).catch(() => {}) }
}