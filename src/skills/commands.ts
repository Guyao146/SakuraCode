/**
 * Custom slash-command discovery for the REPL: `<dir>/<command-name>.md`
 * files whose YAML frontmatter carries an optional `description` and whose
 * body is a prompt template supporting `$ARGUMENTS` (the full argument
 * string, verbatim) and `$1..$9` (whitespace-split positional tokens).
 *
 * Commands are discovered from the project's `.sakura/commands/` and the
 * user's `~/.sakura/commands/` (project wins on name conflicts). Pure
 * functions — the REPL calls these directly, no kernel involvement.
 */

import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'

export interface SlashCommand {
  name: string
  description: string
  source: 'project' | 'user'
  file: string
}

/**
 * Read a command file into its frontmatter description and template body.
 * Lenient by design: malformed frontmatter keeps the command usable (the
 * block is dropped, description stays ''); only an unreadable file throws.
 */
function readCommandFile(raw: string): { description: string; body: string } {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!match) return { description: '', body: raw.trim() }
  let description = ''
  try {
    const parsed = parseYaml(match[1] ?? '')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const d = (parsed as Record<string, unknown>).description
      if (typeof d === 'string') description = d
    }
  } catch {
    // malformed frontmatter — the command stays, without a description
  }
  return { description, body: raw.slice((match[0] ?? raw).length).trim() }
}

function listCommandDir(dir: string, source: SlashCommand['source']): SlashCommand[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return [] // missing or unreadable root — no commands from this source
  }
  const commands: SlashCommand[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(dir, entry.name)
    let description = ''
    try {
      description = readCommandFile(readFileSync(file, 'utf8')).description
    } catch {
      continue // unreadable file — it could not be expanded later anyway
    }
    commands.push({ name: entry.name.slice(0, -3), description, source, file })
  }
  return commands
}

/** All commands visible from `cwd`, sorted by name; project overrides user. */
export function listCommands(cwd: string): SlashCommand[] {
  const roots: Array<{ source: SlashCommand['source']; dir: string }> = [
    { source: 'user', dir: path.join(os.homedir(), '.sakura', 'commands') },
    { source: 'project', dir: path.join(cwd, '.sakura', 'commands') },
  ]
  const byName = new Map<string, SlashCommand>()
  for (const { source, dir } of roots) {
    // The project root is scanned last, so its entries overwrite user ones.
    for (const command of listCommandDir(dir, source)) byName.set(command.name, command)
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Expand a command file with an argument string. `$ARGUMENTS` is handled
 * first: the template is segmented on it before positional filling, so the
 * argument text (which may itself contain "$1") is spliced in verbatim and
 * never re-scanned. `$1..$9` become whitespace-split tokens; a missing
 * position expands to the empty string.
 */
export function expandCommand(file: string, args: string): { name: string; prompt: string } {
  const name = path.basename(file).replace(/\.md$/i, '')
  const { body } = readCommandFile(readFileSync(file, 'utf8'))
  const tokens = args.trim() ? args.trim().split(/\s+/) : []
  const fillPositional = (segment: string): string =>
    segment.replace(/\$([1-9])(?!\d)/g, (_match, digit: string) => tokens[Number(digit) - 1] ?? '')
  const prompt = body.split('$ARGUMENTS').map(fillPositional).join(args)
  return { name, prompt }
}
