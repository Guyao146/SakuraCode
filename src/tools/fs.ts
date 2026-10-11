/**
 * tool-fs — read / write / edit. Aligns with dsh-tool-fs: line-numbered
 * reads, a read-before-write policy, exact-match string editing.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { formatLineNumbers, resolvePath, truncate } from './util.js'

export interface FsToolsConfig {
  cwd?: string
  maxReadLines?: number
}

/** Key for the read-before-write set; case-folded on Windows (NTFS is case-insensitive). */
function readKey(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

export const fsToolsPlugin: PluginModule<FsToolsConfig> = {
  name: 'tool-fs',
  description: 'read / write / edit — filesystem text tools with a read-before-write policy',
  inject: ['tools'],
  config: {
    type: 'object',
    properties: { maxReadLines: { type: 'number', description: 'default cap on lines returned by read' } },
  },
  apply(ctx, config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const cwd = config?.cwd ?? process.cwd()
    const maxReadLines = config?.maxReadLines ?? 2000
    const readFiles = new Set<string>()

    tools.register({
      name: 'read',
      description:
        'Read a text file with line numbers. Supports offset (1-based starting line) and limit. ' +
        'You must read a file before editing or overwriting it.',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file (absolute or relative to the working directory).' },
          offset: { type: 'number', description: '1-based line number to start from.' },
          limit: { type: 'number', description: `Max lines to return (default ${maxReadLines}).` },
        },
        required: ['file_path'],
      },
      execute: async (args) => {
        const file = resolvePath(String(args.file_path), cwd)
        const content = await fs.readFile(file, 'utf8')
        readFiles.add(readKey(file))
        const body = formatLineNumbers(content, Math.max(1, Number(args.offset ?? 1)), Number(args.limit ?? maxReadLines))
        const total = content.split('\n').length
        const end = Math.max(1, Number(args.offset ?? 1)) + body.split('\n').length - 1
        const note = end < total ? `\n… [file has ${total} lines; showing up to ${end}]` : ''
        return { output: truncate(body + note), ui: { file, lines: total } }
      },
    })

    tools.register({
      name: 'write',
      description:
        'Write content to a file, creating it (and parent directories) as needed. ' +
        'If the file already exists you must read it first.',
      kind: 'write',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to write.' },
          content: { type: 'string', description: 'Full content to write (replaces the file).' },
        },
        required: ['file_path', 'content'],
      },
      execute: async (args) => {
        const file = resolvePath(String(args.file_path), cwd)
        const exists = await fs
          .access(file)
          .then(() => true)
          .catch(() => false)
        if (exists && !readFiles.has(readKey(file))) {
          return {
            output: `error: ${file} exists but has not been read this session — call read first, then write.`,
            isError: true,
          }
        }
        await fs.mkdir(path.dirname(file), { recursive: true })
        const content = String(args.content ?? '')
        await fs.writeFile(file, content, 'utf8')
        readFiles.add(readKey(file))
        return { output: `wrote ${content.split('\n').length} lines to ${file}`, ui: { file, bytes: Buffer.byteLength(content) } }
      },
    })

    tools.register({
      name: 'edit',
      description:
        'Edit a file by exact string replacement. old_string must match exactly and uniquely ' +
        'unless replace_all is true. You must read the file first.',
      kind: 'write',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Path to the file to edit.' },
          old_string: { type: 'string', description: 'Exact text to replace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
      execute: async (args) => {
        const file = resolvePath(String(args.file_path), cwd)
        if (!readFiles.has(readKey(file))) {
          return { output: `error: read ${file} before editing it.`, isError: true }
        }
        const oldString = String(args.old_string ?? '')
        const newString = String(args.new_string ?? '')
        if (oldString === '') return { output: 'error: old_string must be non-empty.', isError: true }
        const content = await fs.readFile(file, 'utf8')
        const occurrences = content.split(oldString).length - 1
        if (occurrences === 0) {
          return { output: `error: old_string not found in ${file}.`, isError: true }
        }
        if (occurrences > 1 && !args.replace_all) {
          return {
            output: `error: old_string appears ${occurrences} times in ${file}; make it unique or pass replace_all.`,
            isError: true,
          }
        }
        const updated = args.replace_all
          ? content.split(oldString).join(newString)
          : content.replace(oldString, () => newString) // function replacement: literal, no $-pattern expansion
        await fs.writeFile(file, updated, 'utf8')
        return { output: `edited ${file} (${occurrences === 1 ? 1 : occurrences} replacement(s))`, ui: { file } }
      },
    })

    // Registrations unwind when the plugin scope is disposed.
    ctx.effect(() => () => readFiles.clear())
  },
}
