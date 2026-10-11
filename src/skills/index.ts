/**
 * core-skills — SKILL.md discovery, the `skill` tool and a system-prompt
 * section. A skill lives in `<dir>/<skill-name>/SKILL.md` (YAML frontmatter
 * + markdown body) and is discovered from, highest priority first (the first
 * hit for a name wins):
 *   1. project: <cwd>/.sakura/skills/
 *   2. user:    ~/.sakura/skills/
 *   3. extra:   config.extraDirs (resolved relative to cwd)
 *
 * Discovery is lazy: the first list() call scans and caches; reload() drops
 * the cache. The tool and the prompt section always read through the
 * service, so a reload refreshes both.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PluginModule } from '../kernel/index.js'
import { params, type ToolsService } from '../core/tools.js'
import type { SystemPromptService } from '../core/system-prompt.js'

export interface SkillMeta {
  name: string
  description: string
  whenToUse?: string
  source: 'project' | 'user' | 'extra'
  /** Absolute directory holding this skill's SKILL.md. */
  dir: string
}

export interface SkillDetail {
  meta: SkillMeta
  body: string
}

export interface SkillsService {
  list(): SkillMeta[]
  get(name: string): SkillDetail | undefined
  reload(): void
}

type SkillSource = SkillMeta['source']

/**
 * Split raw markdown into YAML frontmatter (kept unknown on purpose) and a
 * trimmed body. Throws when the frontmatter block is malformed YAML.
 */
function splitFrontmatter(raw: string): { frontmatter: unknown; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!match) return { frontmatter: undefined, body: raw.trim() }
  let parsed: unknown
  try {
    parsed = parseYaml(match[1] ?? '')
  } catch (error) {
    throw new Error(`invalid YAML frontmatter: ${(error as Error).message}`)
  }
  return { frontmatter: parsed, body: raw.slice((match[0] ?? raw).length).trim() }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

interface SkillRoot {
  source: SkillSource
  root: string
}

/** Scan one root for `<name>/SKILL.md` directories; unreadable roots yield nothing. */
function scanSkillRoot(root: string, source: SkillSource): SkillMeta[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // missing or unreadable root — no skills from this source
  }
  const metas: SkillMeta[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(root, entry.name)
    let raw: string
    try {
      raw = readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
    } catch {
      continue // no SKILL.md — not a skill directory
    }
    try {
      const { frontmatter } = splitFrontmatter(raw)
      const fm = asRecord(frontmatter)
      metas.push({
        name: typeof fm?.name === 'string' && fm.name.trim() ? fm.name.trim() : entry.name,
        description: typeof fm?.description === 'string' ? fm.description : '',
        whenToUse: typeof fm?.whenToUse === 'string' ? fm.whenToUse : undefined,
        source,
        dir,
      })
    } catch (error) {
      console.warn(`[core-skills] skipping ${dir}: ${(error as Error).message}`)
    }
  }
  return metas
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function createSkillsService(roots: SkillRoot[]): SkillsService {
  let cache: SkillMeta[] | null = null
  const service: SkillsService = {
    list() {
      if (!cache) {
        const seen = new Map<string, SkillMeta>()
        for (const { source, root } of roots) {
          // Roots come in priority order; the first hit for a name wins.
          for (const meta of scanSkillRoot(root, source)) {
            if (!seen.has(meta.name)) seen.set(meta.name, meta)
          }
        }
        cache = [...seen.values()].sort(byName)
      }
      return cache
    },
    get(name) {
      const meta = service.list().find((m) => m.name === name)
      if (!meta) return undefined
      try {
        const raw = readFileSync(path.join(meta.dir, 'SKILL.md'), 'utf8')
        return { meta, body: splitFrontmatter(raw).body }
      } catch {
        return undefined // vanished or now malformed — treat as unknown
      }
    },
    reload() {
      cache = null
    },
  }
  return service
}

/** The system-prompt listing; empty when no skills are available (assemble drops it). */
function renderSkillsSection(metas: SkillMeta[]): string {
  if (metas.length === 0) return ''
  const lines = metas.map((m) => `- ${m.name} — ${m.description}${m.whenToUse ? `（whenToUse: ${m.whenToUse}）` : ''}`)
  return `## Skills\n\n可用技能（用 skill 工具加载完整指令）：\n${lines.join('\n')}`
}

export const skillsPlugin: PluginModule<{ cwd?: string; extraDirs?: string[] }> = {
  name: 'core-skills',
  description: 'SKILL.md discovery, the `skill` tool and a system-prompt section',
  inject: ['tools', 'systemPrompt'],
  config: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'project root for .sakura/skills discovery (default process.cwd())' },
      extraDirs: { type: 'array', items: { type: 'string' }, description: 'additional skill directories (resolved relative to cwd)' },
    },
  },
  apply(ctx, config, toolsLike: unknown, systemPromptLike: unknown) {
    const tools = toolsLike as ToolsService
    const systemPrompt = systemPromptLike as SystemPromptService
    const cwd = config?.cwd ?? process.cwd()
    const roots: SkillRoot[] = [
      { source: 'project', root: path.join(cwd, '.sakura', 'skills') },
      { source: 'user', root: path.join(os.homedir(), '.sakura', 'skills') },
      ...(config?.extraDirs ?? []).map((d) => ({ source: 'extra' as const, root: path.resolve(cwd, d) })),
    ]
    const service = createSkillsService(roots)
    ctx.provide('skills')
    ctx.set('skills', service)

    tools.register({
      name: 'skill',
      description:
        '加载某个技能的完整指令并严格遵循。name 必须是系统提示 Skills 列表中列出的技能之一；调用前先查看列表，不要臆造技能名。',
      kind: 'read',
      parameters: params(
        {
          name: { type: 'string', description: '技能名（Skills 列表中的 name）' },
          note: { type: 'string', description: '可选：一句话说明为什么调用该技能' },
        },
        ['name'],
      ),
      execute: async (args) => {
        const name = String(args.name ?? '')
        const detail = service.get(name)
        if (!detail) {
          const available = service.list().map((m) => m.name)
          return {
            output: `error: unknown skill "${name}" — 可用技能：${available.length > 0 ? available.join(', ') : '(none)'}`,
            isError: true,
          }
        }
        return { output: `# skill: ${name}\n\n${detail.body}` }
      },
    })

    // Function content: the listing is re-rendered after every reload().
    const disposeSection = systemPrompt.add('skills', () => renderSkillsSection(service.list()), 90)
    ctx.effect(() => disposeSection)
  },
}
