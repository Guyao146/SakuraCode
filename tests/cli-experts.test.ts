import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { framesForText, startMockServer } from '../scripts/mock-openai-server.js'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-cli-experts-'))
  const workspace = path.join(dir, 'workspace')
  const home = path.join(dir, 'home')
  await Promise.all([fs.mkdir(workspace), fs.mkdir(home)])
  await fs.writeFile(path.join(workspace, 'sakura.yml'), 'pluginsDir: no-plugins\n')
  const feed = await startMockServer({ script: Array.from({ length: 40 }, () => () => framesForText('LOCAL_EXPERT_RESULT')) })
  const env = { ...process.env, HOME: home, USERPROFILE: home, SAKURA_BASE_URL: feed.url,
    SAKURA_API_KEY: 'dummy-local-key', SAKURA_MODEL: 'mock-chat', SAKURA_UPDATES_AUTO_CHECK: '0' }
  const child = spawn(process.execPath, [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'cli.ts')], {
    cwd: workspace, env, stdio: 'pipe', windowsHide: true,
  }) as ChildProcessWithoutNullStreams
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject) })
  cleanups.push(async () => {
    if (child.exitCode === null) child.kill()
    await exited.catch(() => {})
    await feed.close()
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  })
  const promptCount = () => (stdout.match(/sakura\x1b\[0m> /g) ?? []).length
  await vi.waitFor(() => expect(promptCount()).toBe(1), { timeout: 10_000 })
  async function command(text: string) {
    const count = promptCount()
    child.stdin.write(text + '\n')
    await vi.waitFor(() => expect(promptCount()).toBeGreaterThan(count), { timeout: 10_000 })
  }
  return { child, exited, command, feed, output: () => ({ stdout, stderr }) }
}

function userTexts(request: { messages?: Array<Record<string, unknown>> }) {
  return (request.messages ?? []).filter(message => message.role === 'user').map(message => String(message.content))
}

describe('CLI expert-session lifecycle', () => {
  it('re-enables the same experts with history and sends opening tasks to main exactly once', async () => {
    const run = await boot()
    await run.command('/experts on')
    expect(run.feed.requests).toHaveLength(0)
    await run.command('FIRST_EXPERT_TASK')
    expect(run.feed.requests).toHaveLength(4)
    await run.command('/experts off')
    await run.command('/experts on SECOND_EXPERT_TASK')
    expect(run.feed.requests).toHaveLength(8)
    for (const request of run.feed.requests.slice(4)) {
      expect(userTexts(request)).toEqual(['FIRST_EXPERT_TASK', 'SECOND_EXPERT_TASK'])
    }
    await run.command('/experts on THIRD_EXPERT_TASK')
    expect(run.feed.requests).toHaveLength(12)
    for (const request of run.feed.requests.slice(8)) {
      expect(userTexts(request)).toEqual(['FIRST_EXPERT_TASK', 'SECOND_EXPERT_TASK', 'THIRD_EXPERT_TASK'])
    }
    await run.command('/experts off')
    await run.command('MAIN_ONLY_TASK')
    expect(run.feed.requests).toHaveLength(13)
    expect(run.output().stderr).toBe('')
    run.child.stdin.end()
    expect(await run.exited).toBe(0)
  }, 30_000)

  it('keeps active expert context after invalid resume and clears it only for a valid new session', async () => {
    const run = await boot()
    await run.command('/experts on OPENING_TASK')
    expect(run.feed.requests).toHaveLength(4)
    await run.command('/resume invalid/session')
    expect(run.output().stdout).toContain('resume failed:')
    await run.command('AFTER_REJECTED_RESUME')
    expect(run.feed.requests).toHaveLength(8)
    for (const request of run.feed.requests.slice(4)) {
      expect(userTexts(request)).toEqual(['OPENING_TASK', 'AFTER_REJECTED_RESUME'])
    }
    await run.command('/new')
    await run.command('NEW_SESSION_ONLY')
    expect(run.feed.requests).toHaveLength(9)
    expect(userTexts(run.feed.requests[8]!)).toEqual(['NEW_SESSION_ONLY'])
    run.child.stdin.end()
    expect(await run.exited).toBe(0)
  }, 30_000)

  it('waits for all accepted opening-task turns when stdin closes', async () => {
    const run = await boot()
    run.child.stdin.end('/experts on FINISH_BEFORE_EOF\n')
    expect(await run.exited).toBe(0)
    expect(run.feed.requests).toHaveLength(4)
    expect(run.output().stderr).toBe('')
  }, 15_000)
})
