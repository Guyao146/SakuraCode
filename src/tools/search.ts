/**
 * tool-fs-search — glob / grep. Pure-Node discovery (no packaged binary):
 * glob matches paths, grep regex-searches file contents; both cap results.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { SKIP_DIRS, globToRegExp, resolvePath, truncate } from './util.js'

const MAX_PATHS = 100
const MAX_MATCHES = 250

async function walk(root: string, base = root, found: string[] = [], wantDot = false): Promise<string[]> {
  if (found.length > 5000) return found
  let entries
  try {
    entries = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    // Dotfiles are skipped unless the pattern explicitly targets them
    // (e.g. ".gitignore", ".*", "config/.env*").
    if (!wantDot && entry.name.startsWith('.') && entry.name !== '.github') continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(full, base, found, wantDot)
    } else if (entry.isFile()) {
      found.push(path.relative(base, full).split(path.sep).join('/'))
      if (found.length > 5000) return found
    }
  }
  return found
}

/** Does the pattern explicitly reference dot-prefixed names? */
function wantsDotfiles(pattern: string): boolean {
  return /(^|\/)\./.test(pattern)
}

export const fsSearchPlugin: PluginModule<{ cwd?: string }> = {
  name: 'tool-fs-search',
  description: 'glob / grep — file discovery and content search',
  inject: ['tools'],
  apply(_ctx, config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const cwd = config?.cwd ?? process.cwd()

    tools.register({
      name: 'glob',
      description:
        'Find file paths matching a glob pattern (e.g. "**/*.ts", "src/**/*.test.js"). ' +
        'Returns up to 100 paths sorted by modification time (newest first).',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match file paths against.' },
          path: { type: 'string', description: 'Directory to search from (default: working directory).' },
        },
        required: ['pattern'],
      },
      execute: async (args) => {
        const base = resolvePath(String(args.path ?? '.'), cwd)
        const relative = await walk(base, base, [], wantsDotfiles(String(args.pattern)))
        const re = globToRegExp(String(args.pattern))
        const matches: Array<{ rel: string; full: string; mtime: number }> = []
        for (const rel of relative) {
          if (!re.test(rel)) continue
          const full = path.join(base, rel)
          try {
            const st = await fs.stat(full)
            matches.push({ rel, full, mtime: st.mtimeMs })
          } catch {
            /* raced away */
          }
        }
        matches.sort((a, b) => b.mtime - a.mtime)
        const shown = matches.slice(0, MAX_PATHS)
        const listing = shown.map((m) => m.rel).join('\n')
        return {
          output: listing
            ? truncate(listing) + (matches.length > MAX_PATHS ? `\n… and ${matches.length - MAX_PATHS} more` : '')
            : `no files matched ${args.pattern}`,
          ui: { count: matches.length },
        }
      },
    })

    tools.register({
      name: 'grep',
      description:
        'Search file contents with a regular expression. Output is file:line:text for each match ' +
        '(up to 250 matches). Use include to filter files by glob (e.g. "*.ts").',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regular expression to search for.' },
          path: { type: 'string', description: 'Directory or file to search (default: working directory).' },
          include: { type: 'string', description: 'Glob filter for files, e.g. "*.ts".' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false).' },
        },
        required: ['pattern'],
      },
      execute: async (args) => {
        const base = resolvePath(String(args.path ?? '.'), cwd)
        let re: RegExp
        try {
          re = new RegExp(String(args.pattern), args.ignore_case ? 'i' : '')
        } catch (error) {
          return { output: `error: invalid regex: ${(error as Error).message}`, isError: true }
        }
        const includeRe = args.include ? globToRegExp(String(args.include)) : undefined

        let walkRoot: string
        let files: string[]
        const baseStat = await fs.stat(base).catch(() => null)
        if (baseStat?.isFile()) {
          walkRoot = path.dirname(base)
          files = [path.basename(base)]
        } else {
          walkRoot = base
          files = await walk(base, base, [], wantsDotfiles(String(args.include ?? '')))
        }

        const out: string[] = []
        let total = 0
        for (const rel of files) {
          if (includeRe) {
            const base2 = path.basename(rel)
            if (!includeRe.test(base2) && !includeRe.test(rel)) continue
          }
          const full = path.join(walkRoot, rel)
          let content: string
          try {
            const buf = await fs.readFile(full)
            if (buf.includes(0)) continue // binary
            content = buf.toString('utf8')
          } catch {
            continue
          }
          const lines = content.split('\n')
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!.replace(/\r$/, '') // CRLF files: anchors like $ must see the real line
            if (re.test(line)) {
              total++
              if (total <= MAX_MATCHES) out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 300)}`)
            }
          }
          if (total >= MAX_MATCHES) break
        }
        if (total === 0) return { output: `no matches for /${args.pattern}/`, ui: { count: 0 } }
        const suffix = total > MAX_MATCHES ? `\n… and ${total - MAX_MATCHES} more matches` : ''
        return { output: truncate(out.join('\n')) + suffix, ui: { count: total } }
      },
    })
  },
}
