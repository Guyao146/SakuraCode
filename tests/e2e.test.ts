/**
 * End-to-end suite — no adapter override anywhere: the REAL OpenAICompatAdapter
 * (src/core/llm.ts) talks HTTP SSE to scripts/mock-openai-server.ts through the
 * full plugin harness, and the CLI is smoked via spawnSync.
 *
 *   1. tool round-trip (bash → tool/result → final answer, 2 requests)
 *   2. direct text answer with a custom server script (1 request)
 *   3. resume: history reconstructed from session.jsonl reaches the model
 *   4. CLI smoke: --version / --dump-config
 */

import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import pkg from '../package.json'
import { createHarness, type Harness } from '../src/harness.js'
import {
  framesForText,
  startMockServer,
  type ChatRequestBody,
  type MockServer,
  type ScriptFn,
} from '../scripts/mock-openai-server.js'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const CLI_TIMEOUT = 120_000

// Everything created by a test is registered here and torn down in afterEach.
const servers: MockServer[] = []
const harnesses: Harness[] = []
const tmpDirs: string[] = []

afterEach(async () => {
  while (harnesses.length) harnesses.pop()?.dispose()
  while (servers.length) await servers.pop()?.close()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function freshTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-e2e-'))
  tmpDirs.push(dir)
  return dir
}

async function freshServer(script?: ScriptFn[]): Promise<MockServer> {
  const server = await startMockServer(script ? { script } : {})
  servers.push(server)
  return server
}

/** A full harness wired to the mock server through the real OpenAICompatAdapter. */
async function freshHarness(cwd: string, baseURL: string): Promise<Harness> {
  const harness = await createHarness({
    cwd,
    baseURL,
    apiKey: 'test-key',
    model: 'mock-chat',
    approvalMode: 'yolo',
    renderer: false,
  })
  harnesses.push(harness)
  return harness
}

function readSessionEvents(file: string): Promise<Array<{ type?: string; [key: string]: unknown }>> {
  return fs
    .readFile(file, 'utf8')
    .then((raw) =>
      raw
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as { type?: string; [key: string]: unknown }),
    )
}

describe('e2e: harness over the real OpenAICompatAdapter (HTTP SSE)', () => {
  it('runs a tool round-trip: bash call, tool/result, final answer', async () => {
    const server = await freshServer()
    const tmp = await freshTmpDir()
    const harness = await freshHarness(tmp, server.url)

    const result = await harness.run('run the echo command')

    expect(result.error).toBeUndefined()
    expect(result.output).toBe('E2E_FINAL_ANSWER')
    expect(result.steps).toBe(2)
    expect(server.requests.length).toBe(2)

    // The second request carries the tool result back to the model.
    const second = server.requests[1] as ChatRequestBody
    const toolMessage = (second.messages ?? []).find((m) => m?.role === 'tool')
    expect(toolMessage).toBeDefined()
    expect(String(toolMessage?.content)).toContain('sakura-e2e-ok')

    // The session log on disk contains the tool/result event.
    const sessions = await harness.ctx.sessions.list()
    expect(sessions.length).toBeGreaterThan(0)
    const sessionId = sessions[0]!.id
    const sessionFile = path.join(tmp, '.sakura', 'sessions', sessionId, 'session.jsonl')
    const events = await readSessionEvents(sessionFile)
    expect(events.some((e) => e.type === 'tool/result')).toBe(true)
  })

  it('answers directly in a single step with a scripted text response', async () => {
    const server = await freshServer([() => framesForText('PLAIN ANSWER')])
    const tmp = await freshTmpDir()
    const harness = await freshHarness(tmp, server.url)

    const result = await harness.run('say something plain')

    expect(result.error).toBeUndefined()
    expect(result.output).toBe('PLAIN ANSWER')
    expect(result.steps).toBe(1)
    expect(server.requests.length).toBe(1)
  })

  it('resumes a session: JSONL history (assistant tool_calls + tool result) reaches the model', async () => {
    const server = await freshServer()
    const tmp = await freshTmpDir()

    // Phase 1 — the scenario-1 round trip, leaving a session on disk.
    const first = await freshHarness(tmp, server.url)
    const firstResult = await first.run('run the echo command')
    expect(firstResult.error).toBeUndefined()
    const metas = await first.ctx.sessions.list()
    const sessionId = metas[0]!.id

    // Phase 2 — a NEW harness bound to the same cwd adopts the session.
    const second = await freshHarness(tmp, server.url)
    second.main({ resumeSessionId: sessionId })
    const result = await second.main().turn('follow up')

    expect(result.error).toBeUndefined()
    expect(result.output).toBe('E2E_FINAL_ANSWER')
    expect(server.requests.length).toBe(3)

    // The third request was rebuilt from the JSONL: it contains the earlier
    // assistant message with tool_calls and the role:'tool' result message.
    const third = server.requests[2] as ChatRequestBody
    const messages = third.messages ?? []
    const assistant = messages.find(
      (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0,
    )
    expect(assistant).toBeDefined()
    expect(messages.some((m) => m?.role === 'tool')).toBe(true)
    expect(messages.some((m) => m?.role === 'user' && String(m.content).includes('follow up'))).toBe(true)
  })
})

describe('e2e: CLI smoke', () => {
  it('reports its version', () => {
    const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/cli.ts', '--version'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT,
      shell: process.platform === 'win32',
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(pkg.version)
  }, CLI_TIMEOUT)

  it('dumps the resolved configuration as JSON', () => {
    const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/cli.ts', '--dump-config'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: CLI_TIMEOUT,
      shell: process.platform === 'win32',
    })
    expect(run.status).toBe(0)
    const parsed = JSON.parse(run.stdout) as { pluginRows?: unknown }
    expect(parsed && typeof parsed === 'object').toBe(true)
    expect(parsed.pluginRows && typeof parsed.pluginRows === 'object').toBe(true)
  }, CLI_TIMEOUT)

  it('runs a task piped into the REPL stdin to completion before exiting', { timeout: CLI_TIMEOUT }, async () => {
    // stdin reaching EOF right after its last line used to make the 'close'
    // handler exit before the asynchronously-started turn produced anything.
    // Async spawn (not spawnSync) so the worker's loop keeps serving the mock
    // server the child talks to — spawnSync would deadlock the two.
    const server = await freshServer()
    const directory = await freshTmpDir()
    const workspace = path.join(directory, 'workspace'), home = path.join(directory, 'home')
    await Promise.all([fs.mkdir(workspace), fs.mkdir(home)])
    await fs.writeFile(path.join(workspace, 'sakura.yml'), 'pluginsDir: no-plugins\n')
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(REPO_ROOT, 'src', 'cli.ts'), '--base-url', server.url],
      {
        cwd: workspace,
        env: { ...process.env, HOME: home, USERPROFILE: home, SAKURA_API_KEY: 'test-key', SAKURA_MODEL: 'mock-chat', SAKURA_UPDATES_AUTO_CHECK: '0' },
      },
    )
    const stdout: string[] = []
    const stderr: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => stdout.push(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => stderr.push(chunk))

    // Feed the task, then close stdin: exactly what `echo task | sakura` does.
    child.stdin.on('error', () => {})
    child.stdin.write('run the echo command\n')
    child.stdin.end()

    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    const kill = setTimeout(() => child.kill('SIGKILL'), CLI_TIMEOUT - 10_000)
    const code = await exit
    clearTimeout(kill)

    // The tool was blocked headless (approval gate), the model still answered,
    // and the process left on its own once the turn finished.
    expect(code).toBe(0)
    const out = stdout.join('')
    expect(out).toContain('needs approval')
    expect(out).toContain('E2E_FINAL_ANSWER')
    expect(stderr.join('')).toBe('')
    expect(server.requests.length).toBeGreaterThanOrEqual(1)
  })
})
