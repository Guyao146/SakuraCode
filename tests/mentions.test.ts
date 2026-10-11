/**
 * tests/mentions.test.ts — expandMentions against a temporary directory tree.
 * Relative mention paths resolve against process.cwd(), so tests chdir into
 * the fixture and MUST restore the original cwd afterwards.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandMentions } from '../src/mentions/index.js'

const originalCwd = process.cwd()
const createdDirs: string[] = []

afterEach(async () => {
  process.chdir(originalCwd)
  while (createdDirs.length) {
    const dir = createdDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Create a temp tree from relative paths, return the root. */
async function makeTree(files: Record<string, string | Uint8Array>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-mentions-'))
  createdDirs.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content)
  }
  return dir
}

describe('expandMentions', () => {
  it('expands a simple mention into a line-numbered file block', async () => {
    const root = await makeTree({ 'a.txt': 'alpha\nbeta\ngamma' })
    process.chdir(root)

    const result = expandMentions('看看 @a.txt')

    expect(result.text.startsWith('看看 @a.txt')).toBe(true)
    expect(result.text).toContain('<file path="a.txt">')
    expect(result.text).toContain('1\talpha')
    expect(result.text).toContain('3\tgamma')
    expect(result.text).not.toContain('lines=')
    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]!.mention).toBe('@a.txt')
    expect(result.resolved[0]!.path).toBe(path.join(root, 'a.txt'))
    expect(result.resolved[0]!.startLine).toBeUndefined()
    expect(result.resolved[0]!.endLine).toBeUndefined()
    expect(result.missing).toEqual([])
  })

  it('expands a 1-based inclusive line range with a lines attribute', async () => {
    const root = await makeTree({ 'a.txt': 'one\ntwo\nthree\nfour' })
    process.chdir(root)

    const result = expandMentions('look at @a.txt:2-3')

    expect(result.text).toContain('<file path="a.txt" lines="2-3">')
    expect(result.text).toContain('2\ttwo')
    expect(result.text).toContain('3\tthree')
    expect(result.text).not.toContain('1\tone')
    expect(result.text).not.toContain('4\tfour')
    expect(result.resolved[0]).toMatchObject({ mention: '@a.txt:2-3', startLine: 2, endLine: 3 })
    expect(result.missing).toEqual([])
  })

  it('reports missing files and leaves the text untouched', async () => {
    const root = await makeTree({})
    process.chdir(root)

    const result = expandMentions('see @nope.txt now')

    expect(result.text).toBe('see @nope.txt now')
    expect(result.missing).toEqual([{ mention: '@nope.txt', reason: 'not found' }])
    expect(result.resolved).toEqual([])
  })

  it('reports directory mentions as missing', async () => {
    const root = await makeTree({ 'sub/x.txt': 'x' })
    process.chdir(root)

    const result = expandMentions('see @sub')

    expect(result.text).toBe('see @sub')
    expect(result.missing).toEqual([{ mention: '@sub', reason: 'is a directory' }])
    expect(result.resolved).toEqual([])
  })

  it('truncates files beyond the 2000-line cap and annotates the block', async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`)
    const root = await makeTree({ 'big.txt': lines.join('\n') })
    process.chdir(root)

    const result = expandMentions('read @big.txt')

    expect(result.text).toContain('[truncated]')
    expect(result.text).toContain('1\tline-1')
    expect(result.text).toContain('2000\tline-2000')
    expect(result.text).not.toContain('2001\t')
    expect(result.resolved).toHaveLength(1)
  })

  it('drops later mentions once maxTotalChars is exhausted', async () => {
    const big = Array.from({ length: 3000 }, () => 'x'.repeat(50)).join('\n')
    const root = await makeTree({ 'one.txt': big, 'two.txt': big })
    process.chdir(root)

    const result = expandMentions('a @one.txt and @two.txt', { maxTotalChars: 70_000 })

    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]!.mention).toBe('@one.txt')
    expect(result.text).toContain('<file path="one.txt">')
    expect(result.text).not.toContain('<file path="two.txt">')
    expect(result.missing).toEqual([{ mention: '@two.txt', reason: 'context budget exhausted' }])
  })

  it('rejects binary content', async () => {
    const root = await makeTree({ 'bin.dat': Uint8Array.from([0x50, 0x4b, 0x00, 0x01, 0x0a]) })
    process.chdir(root)

    const result = expandMentions('see @bin.dat')

    expect(result.text).toBe('see @bin.dat')
    expect(result.missing).toEqual([{ mention: '@bin.dat', reason: 'binary file' }])
    expect(result.resolved).toEqual([])
  })

  it('parses Windows drive paths and keeps colon ranges distinct from drive letters', async () => {
    const root = await makeTree({ 'a.txt': 'r1\nr2\nr3' })
    process.chdir(root)
    const abs = path.join(root, 'a.txt') // under os.tmpdir(), an absolute C:\... path on Windows

    const byAbs = expandMentions(`check @${abs}`)
    expect(byAbs.resolved).toHaveLength(1)
    expect(byAbs.text).toContain('2\tr2')
    expect(byAbs.missing).toEqual([])

    // A nonexistent drive path still parses as ONE token: drive + path + range.
    const drive = expandMentions('x @Q:\\no\\such\\file.txt:5-6')
    expect(drive.missing).toEqual([{ mention: '@Q:\\no\\such\\file.txt:5-6', reason: 'not found' }])

    // `a` in `@a.txt:1-2` is a file stem, not a drive letter.
    const ranged = expandMentions('check @a.txt:1-2')
    expect(ranged.text).toContain('<file path="a.txt" lines="1-2">')
    expect(ranged.resolved[0]).toMatchObject({ mention: '@a.txt:1-2', startLine: 1, endLine: 2 })
    expect(ranged.missing).toEqual([])
  })

  it('returns the input unchanged when there are no mentions', async () => {
    const root = await makeTree({ 'a.txt': 'hi' })
    process.chdir(root)

    const result = expandMentions('plain text with an email user@example.com')

    expect(result.text).toBe('plain text with an email user@example.com')
    expect(result.resolved).toEqual([])
    expect(result.missing).toEqual([])
  })

  it('treats @file:N as "from line N to end of file"', async () => {
    const root = await makeTree({ 'a.txt': 'one\ntwo\nthree' })
    process.chdir(root)

    const result = expandMentions('tail @a.txt:2')

    expect(result.text).toContain('<file path="a.txt" lines="2-3">')
    expect(result.text).toContain('2\ttwo')
    expect(result.text).toContain('3\tthree')
    expect(result.text).not.toContain('1\tone')
    expect(result.resolved[0]!.startLine).toBe(2)
    expect(result.resolved[0]!.endLine).toBeUndefined()
    expect(result.missing).toEqual([])
  })
})
