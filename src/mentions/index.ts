/**
 * mentions — expand `@path` / `@path:start-end` tokens in user input into
 * appended file-context blocks (prompt injection).
 * Pure functions only: upstream wiring decides when to call expandMentions;
 * this module registers nothing.
 *
 * Token grammar (paths never contain whitespace):
 *   @<path>            whole file
 *   @<path>:<start>    from 1-based line <start> to end of file
 *   @<path>:<s>-<e>    1-based closed interval [<s>, <e>]
 * A Windows drive prefix (`C:`) is only recognized when immediately followed
 * by `\` or `/`, so `@a.txt:1-2` parses as a range on `a.txt`, not as drive
 * `a` + path `.txt`. The mention tokens stay in the original text; expanded
 * blocks are appended after it.
 */

import { readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { formatLineNumbers } from '../tools/util.js'

export interface MentionExpansion {
  /** 展开后的完整提示词（原文 + 附加块）。无提及且找不到文件时等于原文。 */
  text: string
  /** 命中的提及列表（供 UI 提示）。 */
  resolved: Array<{ mention: string; path: string; startLine?: number; endLine?: number; chars: number }>
  /** 未命中的提及（文件不存在等），供 UI 警示。 */
  missing: Array<{ mention: string; reason: string }>
}

/** Per-file caps: a single mention never injects more than this. */
const MAX_FILE_LINES = 2000
const MAX_FILE_CHARS = 64 * 1024
const DEFAULT_TOTAL_CHARS = 192_000

/**
 * Mention token. The optional drive prefix needs a separator right after the
 * colon (lookahead); otherwise `@a.txt:1-2` would backtrack into drive `a`.
 */
const MENTION_RE = /(?<=^|\s)@((?:[A-Za-z]:(?=[\\/]))?[^\s:]+)(?::(\d+)(?:-(\d+))?)?/g

/** Escape a path for use inside a double-quoted XML-ish attribute. */
function escapeAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function expandMentions(input: string, opts?: { cwd?: string; maxTotalChars?: number }): MentionExpansion {
  const cwd = opts?.cwd ?? process.cwd()
  const resolved: MentionExpansion['resolved'] = []
  const missing: MentionExpansion['missing'] = []
  const blocks: string[] = []
  let budgetLeft = opts?.maxTotalChars ?? DEFAULT_TOTAL_CHARS
  let budgetExhausted = false

  for (const m of input.matchAll(MENTION_RE)) {
    const mention = m[0]!
    const rawPath = m[1]!
    const startLine = m[2] !== undefined ? Number(m[2]) : undefined
    const endLine = m[3] !== undefined ? Number(m[3]) : undefined

    const file = path.resolve(cwd, rawPath)
    let isDir = false
    try {
      isDir = statSync(file).isDirectory()
    } catch {
      missing.push({ mention, reason: 'not found' })
      continue
    }
    if (isDir) {
      missing.push({ mention, reason: 'is a directory' })
      continue
    }
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch (err) {
      missing.push({ mention, reason: err instanceof Error ? err.message : 'read error' })
      continue
    }
    if (content.includes('\0')) {
      missing.push({ mention, reason: 'binary file' })
      continue
    }

    const totalLines = content.split('\n').length
    let start = 1
    let end = totalLines
    let truncated = false
    if (startLine !== undefined) {
      start = Math.max(1, startLine)
      if (start > totalLines) {
        missing.push({ mention, reason: 'line range beyond end of file' })
        continue
      }
      end = Math.min(Math.max(endLine ?? totalLines, start), totalLines)
    }
    if (end - start + 1 > MAX_FILE_LINES) {
      end = start + MAX_FILE_LINES - 1
      truncated = true
    }

    let body = formatLineNumbers(content, start, end - start + 1)
    if (body.length > MAX_FILE_CHARS) {
      body = body.slice(0, MAX_FILE_CHARS)
      truncated = true
    }
    if (truncated) body += '\n[truncated]'

    const linesAttr =
      startLine !== undefined ? ` lines="${start === end ? String(start) : `${start}-${end}`}"` : ''
    const block = `\n\n<file path="${escapeAttr(rawPath)}"${linesAttr}>\n${body}\n</file>`

    // Budget: blocks are appended in mention order. The first block that no
    // longer fits — and every mention after it — is reported as missing; no
    // partial blocks, no reordering.
    if (budgetExhausted || block.length > budgetLeft) {
      budgetExhausted = true
      missing.push({ mention, reason: 'context budget exhausted' })
      continue
    }
    budgetLeft -= block.length
    blocks.push(block)
    resolved.push({
      mention,
      path: file,
      ...(startLine !== undefined ? { startLine, endLine } : {}),
      chars: body.length,
    })
  }

  return { text: input + blocks.join(''), resolved, missing }
}
