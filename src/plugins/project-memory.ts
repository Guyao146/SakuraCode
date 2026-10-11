/**
 * core-project-memory — AGENTS.md / CLAUDE.md project memory. Memory files are
 * discovered from the configured cwd (the harness working directory) upward to
 * the filesystem root (nearest first, AGENTS.md preferred over CLAUDE.md in the
 * same directory) and exposed as a reversible system-prompt section so models
 * pick up per-project instructions without any configuration.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { PluginModule } from '../kernel/index.js'

export interface MemoryFile {
  /** Absolute path of the memory file. */
  path: string
  /** Character count of the (possibly truncated) loaded content. */
  chars: number
}

export interface ProjectMemoryService {
  /** Currently loaded memory files (nearest first). */
  files(): MemoryFile[]
  /** Drop the scan result and content cache; the next read rescans from cwd. */
  reload(): void
}

export interface ProjectMemoryConfig {
  /** Directory the upward scan starts from. Default process.cwd(). */
  cwd?: string
  /** Maximum number of memory files loaded (nearest first). Default 3. */
  maxFiles?: number
  /** Per-file character cap. Default 8000. */
  maxChars?: number
}

/** Candidate basenames per directory; first existing one wins (AGENTS.md first). */
const MEMORY_BASENAMES = ['AGENTS.md', 'CLAUDE.md'] as const

interface CacheEntry {
  mtimeMs: number
  content: string
}

class ProjectMemory implements ProjectMemoryService {
  private discovered: string[] | null = null
  private cache = new Map<string, CacheEntry>()

  constructor(
    private cwd: string,
    private maxFiles: number,
    private maxChars: number,
  ) {}

  reload(): void {
    this.discovered = null
    this.cache.clear()
  }

  files(): MemoryFile[] {
    const out: MemoryFile[] = []
    for (const abs of this.discover()) {
      const content = this.load(abs)
      if (content !== undefined) out.push({ path: abs, chars: content.length })
    }
    return out
  }

  /**
   * Render the system-prompt section body: one `## Project instructions`
   * block per file, path shown relative to the scan root. Empty string when
   * no memory files exist (empty sections are dropped by assemble()).
   */
  render(): string {
    const parts: string[] = []
    for (const abs of this.discover()) {
      const content = this.load(abs)
      if (content === undefined) continue
      const rel = path.relative(this.cwd, abs).split(path.sep).join('/')
      parts.push(`## Project instructions — ${rel}\n\n${content}`)
    }
    return parts.join('\n\n')
  }

  /** Lazily scan once from the configured cwd upward; nearest-first, capped at maxFiles. */
  private discover(): string[] {
    if (this.discovered) return this.discovered
    const found: string[] = []
    let dir = this.cwd
    for (;;) {
      for (const base of MEMORY_BASENAMES) {
        const candidate = path.join(dir, base)
        try {
          if (fs.statSync(candidate).isFile()) {
            found.push(candidate)
            break
          }
        } catch {
          // missing or unreadable — try the next basename
        }
      }
      if (found.length >= this.maxFiles) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    this.discovered = found
    return found
  }

  /** Read with an mtime cache: unchanged files are not re-read. */
  private load(abs: string): string | undefined {
    try {
      const stat = fs.statSync(abs)
      const cached = this.cache.get(abs)
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content
      const raw = fs.readFileSync(abs, 'utf8')
      const content = raw.length > this.maxChars ? raw.slice(0, this.maxChars) : raw
      this.cache.set(abs, { mtimeMs: stat.mtimeMs, content })
      return content
    } catch {
      return undefined
    }
  }
}

export const projectMemoryPlugin: PluginModule<ProjectMemoryConfig> = {
  name: 'core-project-memory',
  description: 'Loads AGENTS.md/CLAUDE.md project memory from cwd upward into the system prompt',
  inject: ['systemPrompt'],
  config: {
    type: 'object',
    properties: {
      cwd: { type: 'string', description: 'directory the upward AGENTS.md/CLAUDE.md scan starts from (default process.cwd())' },
      maxFiles: { type: 'number', description: 'maximum memory files loaded, nearest first (default 3)' },
      maxChars: { type: 'number', description: 'per-file character cap (default 8000)' },
    },
  },
  apply(ctx, config, systemPromptLike: unknown) {
    const systemPrompt = systemPromptLike as {
      add(id: string, content: string | (() => string), priority?: number): () => void
    }
    // Discovery follows the harness cwd (like core-skills / core-agent-defs),
    // not process.cwd() — embedders such as the Web GUI never chdir.
    const cwd = config?.cwd ?? process.cwd()
    const maxFiles = Math.max(1, Math.floor(config?.maxFiles ?? 3))
    const maxChars = Math.max(1, Math.floor(config?.maxChars ?? 8000))
    const memory = new ProjectMemory(cwd, maxFiles, maxChars)

    ctx.provide('projectMemory')
    ctx.set('projectMemory', memory)

    // Function content: re-rendered on every assemble() so mtime-cached file
    // contents stay fresh without re-mounting the plugin.
    const dispose = systemPrompt.add('project-memory', () => memory.render(), 30)
    ctx.effect(() => dispose)
  },
}
