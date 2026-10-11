/**
 * tests/web-search-tools.test.ts — web_fetch against a local node:http
 * server (html→text conversion, the 400000-byte streaming cap, the scheme
 * gate) and the glob/grep search tools (dotfile heuristic, ** recursion,
 * CRLF line handling, include filter, no-match output).
 */

import * as http from 'node:http'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../src/harness.js'
import type { ToolContext } from '../src/core/index.js'

// -- local helpers (independent of tests/helpers.ts) -------------------------

const servers: http.Server[] = []
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  while (cleanups.length) {
    const dispose = cleanups.pop()
    await dispose?.()
  }
})

async function mkHarness(): Promise<{ ctx: Harness['ctx']; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-test-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
  const harness = await createHarness({ cwd: dir, approvalMode: 'yolo', renderer: false })
  cleanups.push(() => harness.dispose())
  return { ctx: harness.ctx, dir }
}

let callSeq = 0
async function call(
  ctx: Harness['ctx'],
  name: string,
  args: unknown,
): Promise<{ output: string; isError?: boolean }> {
  callSeq++
  const tc: ToolContext = { sessionId: 's', agentId: 'a', signal: new AbortController().signal }
  return ctx.tools.execute(`call-${callSeq}`, name, JSON.stringify(args), tc)
}

/** Start an ephemeral-port http server; returns its base URL. */
async function startServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

async function writeGlobFixture(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'a.ts'), 'export {}\n', 'utf8')
  await fs.writeFile(path.join(dir, 'b.ts'), 'export {}\n', 'utf8')
  await fs.mkdir(path.join(dir, 'sub'), { recursive: true })
  await fs.writeFile(path.join(dir, 'sub', 'c.ts'), 'export {}\n', 'utf8')
  await fs.writeFile(path.join(dir, '.hidden'), 'secret\n', 'utf8')
}

function sortedLines(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort()
}

// -- tests --------------------------------------------------------------------

describe('web_fetch', () => {
  it('strips html tags, script and style blocks down to readable text', async () => {
    const base = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><style>x</style></head><body><h1>Hello</h1><script>bad()</script><p>World</p></body></html>')
    })
    const { ctx } = await mkHarness()

    const result = await call(ctx, 'web_fetch', { url: `${base}/page` })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('Hello')
    expect(result.output).toContain('World')
    expect(result.output).not.toContain('bad()')
    expect(result.output).not.toContain('<h1>')
    expect(result.output).toBe('Hello World')
  })

  it('truncates a body larger than the 400000-byte cap', async () => {
    const base = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('a'.repeat(500_000))
    })
    const { ctx } = await mkHarness()

    const result = await call(ctx, 'web_fetch', { url: `${base}/big` })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('[content truncated at 400000 bytes]')
  })

  it('rejects non-http(s) URLs with an error output', async () => {
    const { ctx } = await mkHarness()

    const result = await call(ctx, 'web_fetch', { url: 'ftp://example.com/file.txt' })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('only http(s)')
  })
})

describe('glob', () => {
  it("'*.ts' matches only top-level ts files and skips dotfiles", async () => {
    const { ctx, dir } = await mkHarness()
    await writeGlobFixture(dir)

    const result = await call(ctx, 'glob', { pattern: '*.ts', path: dir })
    expect(result.isError).toBeFalsy()
    expect(sortedLines(result.output)).toEqual(['a.ts', 'b.ts'])
  })

  it("'**/*.ts' descends into subdirectories", async () => {
    const { ctx, dir } = await mkHarness()
    await writeGlobFixture(dir)

    const result = await call(ctx, 'glob', { pattern: '**/*.ts', path: dir })
    expect(sortedLines(result.output)).toEqual(['a.ts', 'b.ts', 'sub/c.ts'])
  })

  it('a pattern naming a dotfile surfaces it (dotfile heuristic)', async () => {
    const { ctx, dir } = await mkHarness()
    await fs.writeFile(path.join(dir, '.hidden'), 'secret\n', 'utf8')

    const result = await call(ctx, 'glob', { pattern: '.hidden', path: dir })
    expect(result.output).toBe('.hidden')
  })
})

describe('grep', () => {
  it('matches CRLF files with end-of-line anchors (Windows line-ending fix)', async () => {
    const { ctx, dir } = await mkHarness()
    // The line ends with "foo" before the CRLF: /foo$/ fails against
    // 'value = foo\r' and only matches because grep strips the trailing \r.
    await fs.writeFile(path.join(dir, 'crlf.ts'), 'const a = 1\r\nvalue = foo\r\nbar()\r\n', 'utf8')

    const result = await call(ctx, 'grep', { pattern: 'foo$', path: dir })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('crlf.ts:2: value = foo')
  })

  it('honors the include glob filter', async () => {
    const { ctx, dir } = await mkHarness()
    await fs.writeFile(path.join(dir, 'code.ts'), 'function foo()\nmore\n', 'utf8')
    await fs.writeFile(path.join(dir, 'note.md'), 'function foo()\n', 'utf8')

    const result = await call(ctx, 'grep', { pattern: 'foo', include: '*.ts', path: dir })
    expect(result.output).toContain('code.ts:1: function foo()')
    expect(result.output).not.toContain('note.md')
  })

  it("reports 'no matches' when nothing hits", async () => {
    const { ctx, dir } = await mkHarness()
    await fs.writeFile(path.join(dir, 'plain.txt'), 'hello world\n', 'utf8')

    const result = await call(ctx, 'grep', { pattern: 'zzz_no_hit', path: dir })
    expect(result.output).toBe('no matches for /zzz_no_hit/')
  })
})
