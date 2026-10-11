/**
 * core-agent-defs — predefined agent type discovery (`<name>.md` files) and a
 * system-prompt section. An agent def is a single markdown file with YAML
 * frontmatter (all fields optional) and a body that becomes the agent's
 * system prompt:
 *
 *   ---
 *   description: 深挖代码库的只读研究员
 *   model: o3-mini
 *   tools: core            # 'full' | 'core' | comma-separated allowlist "read,grep,glob"
 *   ---
 *   你是代码库研究员。……
 *
 * Discovered from, highest priority first (the first hit for a name wins):
 *   1. project: <cwd>/.sakura/agents/
 *   2. user:    ~/.sakura/agents/
 *   3. extra:   config.extraDirs (resolved relative to cwd)
 *
 * Discovery is lazy: the first list() call scans and caches; reload() drops
 * the cache. The prompt section reads through the service, so a reload
 * refreshes it. The `tools` field mirrors the harness ToolPolicy semantics
 * ('full' | 'core' | string[]) so upstream can feed ctx.agentDefs straight
 * into the subagent tool.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PluginModule } from '../kernel/index.js'
import type { ToolPolicy } from '../core/agent.js'
import type { SystemPromptService } from '../core/system-prompt.js'

export interface AgentDef {
  /** File name without the .md extension. */
  name: string
  description: string
  model?: string
  tools?: ToolPolicy
  /** Trimmed markdown body — the agent's system prompt. */
  systemPrompt: string
  source: 'project' | 'user' | 'extra'
  /** Absolute path of the source .md file. */
  file: string
}

export interface AgentDefsService {
  list(): AgentDef[]
  get(name: string): AgentDef | undefined
  reload(): void
}

type AgentSource = AgentDef['source']

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

/**
 * tools frontmatter semantics: 'full'/'core' pass through as-is; any other
 * string is a comma-separated allowlist split into a trimmed string[]; a YAML
 * list is accepted as an allowlist too. Anything else (or an empty result)
 * means "unset".
 */
function parseTools(value: unknown): ToolPolicy | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    if (trimmed === 'full' || trimmed === 'core') return trimmed
    const list = trimmed
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    return list.length > 0 ? list : undefined
  }
  if (Array.isArray(value)) {
    const list = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
    return list.length > 0 ? list : undefined
  }
  return undefined
}

interface AgentRoot {
  source: AgentSource
  root: string
}

/** Scan one root for `<name>.md` files; unreadable roots yield nothing. */
function scanAgentRoot(root: string, source: AgentSource): AgentDef[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return [] // missing or unreadable root — no agent defs from this source
  }
  const defs: AgentDef[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const name = entry.name.slice(0, -'.md'.length)
    if (!name) continue
    const file = path.join(root, entry.name)
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue // unreadable file — not an agent def
    }
    try {
      const { frontmatter, body } = splitFrontmatter(raw)
      const systemPrompt = body.trim()
      if (!systemPrompt) {
        // An agent def without a system prompt is meaningless.
        console.warn(`[core-agent-defs] skipping ${file}: empty system prompt (body is blank)`)
        continue
      }
      const fm = asRecord(frontmatter)
      defs.push({
        name,
        description: typeof fm?.description === 'string' ? fm.description : '',
        model: typeof fm?.model === 'string' && fm.model.trim() ? fm.model.trim() : undefined,
        tools: parseTools(fm?.tools),
        systemPrompt,
        source,
        file,
      })
    } catch (error) {
      console.warn(`[core-agent-defs] skipping ${file}: ${(error as Error).message}`)
    }
  }
  return defs
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function createAgentDefsService(roots: AgentRoot[]): AgentDefsService {
  let cache: AgentDef[] | null = null
  const service: AgentDefsService = {
    list() {
      if (!cache) {
        const seen = new Map<string, AgentDef>()
        for (const { source, root } of roots) {
          // Roots come in priority order; the first hit for a name wins.
          for (const def of scanAgentRoot(root, source)) {
            if (!seen.has(def.name)) seen.set(def.name, def)
          }
        }
        cache = [...seen.values()].sort(byName)
      }
      return cache
    },
    get(name) {
      return service.list().find((d) => d.name === name)
    },
    reload() {
      cache = null
    },
  }
  return service
}

/** The system-prompt listing; empty when no agent defs exist (assemble drops it). */
function renderAgentDefsSection(defs: AgentDef[]): string {
  if (defs.length === 0) return ''
  const lines = defs.map((d) => `- ${d.name} — ${d.description}`)
  return `## Agent 类型\n\n可用的预定义子智能体（派发子智能体时把 name 作为 agent 类型）：\n${lines.join('\n')}`
}

export const agentDefsPlugin: PluginModule<{ cwd?: string; extraDirs?: string[] }> = {
  name: 'core-agent-defs',
  description: '<name>.md predefined agent type discovery and a system-prompt section',
  inject: ['systemPrompt'],
  config: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'project root for .sakura/agents discovery (default process.cwd())' },
      extraDirs: { type: 'array', items: { type: 'string' }, description: 'additional agent definition directories (resolved relative to cwd)' },
    },
  },
  apply(ctx, config, systemPromptLike: unknown) {
    const systemPrompt = systemPromptLike as SystemPromptService
    const cwd = config?.cwd ?? process.cwd()
    const roots: AgentRoot[] = [
      { source: 'project', root: path.join(cwd, '.sakura', 'agents') },
      { source: 'user', root: path.join(os.homedir(), '.sakura', 'agents') },
      ...(config?.extraDirs ?? []).map((d) => ({ source: 'extra' as const, root: path.resolve(cwd, d) })),
    ]
    const service = createAgentDefsService(roots)
    ctx.provide('agentDefs')
    ctx.set('agentDefs', service)

    // Function content: the listing is re-rendered after every reload().
    const disposeSection = systemPrompt.add('agent-defs', () => renderAgentDefsSection(service.list()), 91)
    ctx.effect(() => disposeSection)
  },
}
