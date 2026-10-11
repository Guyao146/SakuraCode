/**
 * Custom slash-command discovery: listCommands (project + user merge with
 * project precedence) and expandCommand ($ARGUMENTS / $1..$9 templates).
 * os.homedir is mocked so "user" commands land in a temp dir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const mocked = { ...actual, homedir: () => state.home }
  return { ...mocked, default: mocked }
})

import { expandCommand, listCommands } from '../src/skills/commands.js'

let projDir = ''
let homeDir = ''

beforeEach(() => {
  projDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-cmds-proj-'))
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'sakura-cmds-home-'))
  state.home = homeDir
})

afterEach(() => {
  rmSync(projDir, { recursive: true, force: true })
  rmSync(homeDir, { recursive: true, force: true })
})

/** Write `<root>/.sakura/commands/<fileName>`; returns the file path. */
function writeCommand(root: string, fileName: string, frontmatter: string, body: string): string {
  const dir = path.join(root, '.sakura', 'commands')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, fileName)
  writeFileSync(file, frontmatter ? `---\n${frontmatter}\n---\n${body}` : body)
  return file
}

describe('listCommands', () => {
  it('merges project and user commands with project precedence, sorted by name', () => {
    writeCommand(projDir, 'deploy.md', 'description: deploy the app', 'Deploy $1')
    writeCommand(homeDir, 'test.md', 'description: run the tests', 'Test $ARGUMENTS')
    writeCommand(homeDir, 'deploy.md', 'description: user deploy', 'User deploy')

    const commands = listCommands(projDir)
    expect(commands.map((c) => [c.name, c.source, c.description])).toEqual([
      ['deploy', 'project', 'deploy the app'],
      ['test', 'user', 'run the tests'],
    ])
    expect(commands[0]!.file).toBe(path.join(projDir, '.sakura', 'commands', 'deploy.md'))
    expect(commands[1]!.file).toBe(path.join(homeDir, '.sakura', 'commands', 'test.md'))
  })

  it('defaults description to empty string and ignores non-md files', () => {
    writeCommand(projDir, 'plain.md', '', 'Just a template')
    writeCommand(homeDir, 'plain.md', 'description: user plain', 'Ignored: project wins')
    writeFileSync(path.join(projDir, '.sakura', 'commands', 'notes.txt'), 'not a command')

    const commands = listCommands(projDir)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ name: 'plain', description: '', source: 'project' })
  })
})

describe('expandCommand', () => {
  it('expands $ARGUMENTS and $1..$9 positional tokens', () => {
    const file = writeCommand(projDir, 'deploy.md', 'description: d', 'Deploy $1 to $2 with $ARGUMENTS')
    expect(expandCommand(file, 'prod east --verbose')).toEqual({
      name: 'deploy',
      prompt: 'Deploy prod to east with prod east --verbose',
    })
  })

  it('replaces missing positional args with empty strings', () => {
    const file = writeCommand(projDir, 'greet.md', '', 'Hello $1 and $2 and $3!')
    expect(expandCommand(file, 'alice bob')).toEqual({
      name: 'greet',
      prompt: 'Hello alice and bob and !',
    })
  })

  it('never re-scans expanded arguments for placeholders', () => {
    // "keep $9 here" is inserted verbatim by $ARGUMENTS (its "$9" must
    // survive), while $1 expands to the first whitespace token only.
    const file = writeCommand(projDir, 'raw.md', '', '$ARGUMENTS then $1')
    expect(expandCommand(file, 'keep $9 here')).toEqual({
      name: 'raw',
      prompt: 'keep $9 here then keep',
    })
  })
})
