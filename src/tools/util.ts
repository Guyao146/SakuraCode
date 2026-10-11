/** Shared helpers for tool plugins. */

import * as path from 'node:path'

export const MAX_OUTPUT = 30_000

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… [output truncated at ${max} chars]`
}

/** Resolve a tool path argument against the working directory. */
export function resolvePath(p: string, cwd = process.cwd()): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p)
}

/** Directories never worth walking for search tools. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.sakura', '__pycache__', '.venv'])

export function formatLineNumbers(content: string, offset = 1, limit = 2000): string {
  const lines = content.split('\n')
  const slice = lines.slice(offset - 1, offset - 1 + limit)
  const width = String(offset - 1 + slice.length).length
  return slice
    .map((line, i) => {
      const text = line.length > 2000 ? line.slice(0, 2000) + '… [line truncated]' : line
      return String(offset + i).padStart(width, ' ') + '\t' + text
    })
    .join('\n')
}

/** Translate a glob pattern (* ? and **) into a RegExp. Brace alternation {a,b} is not supported. */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**/' crosses directories; '**' at end matches everything below.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i++
        }
      } else {
        re += '[^/\\\\]*'
      }
    } else if (c === '?') {
      re += '[^/\\\\]'
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}
