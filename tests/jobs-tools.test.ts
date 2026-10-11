/**
 * tests/jobs-tools.test.ts — background jobs end to end: bash
 * run_in_background returning a job id, job_output polling, job_list
 * status transitions, job_kill, and JobsService.stopAll on disposal.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarness, type Harness } from '../src/harness.js'
import type { JobsService, ToolContext } from '../src/core/index.js'

// -- local helpers (independent of tests/helpers.ts) -------------------------

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const dispose = cleanups.pop()
    await dispose?.()
  }
})

async function mkHarness(): Promise<{ ctx: Harness['ctx']; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-jobs-test-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}))
  const harness = await createHarness({
    cwd: dir,
    jobsDir: '.sakura/jobs',
    approvalMode: 'yolo',
    renderer: false,
  })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil(check: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
    await sleep(50)
  }
}

/** Extract the "job-N" id from a run_in_background tool output. */
function jobId(output: string): string {
  const match = output.match(/job-\d+/)
  if (!match) throw new Error(`no job id found in output: ${output}`)
  return match[0]
}

// A long-running blocker built purely from bash builtins. A command like
// `sleep 5` runs as a bash grandchild that survives a bare proc.kill() on
// Windows and keeps the stdio pipes open — the job's 'close' event (and its
// 'killed' status) only arrives when the grandchild exits. A builtin spin
// loop dies together with its bash, so kill status transitions promptly.
const BLOCKER = 'while : ; do : ; done'

// -- tests --------------------------------------------------------------------

describe('bash run_in_background', () => {
  it('returns a job id immediately and job_output eventually carries the output', async () => {
    const { ctx } = await mkHarness()

    const started = await call(ctx, 'bash', { command: 'echo bg-hello', run_in_background: true })
    expect(started.isError).toBeFalsy()
    const id = jobId(started.output)
    expect(started.output).toContain(id)
    expect(started.output).toContain(`job_output("${id}")`)

    await pollUntil(
      async () => (await call(ctx, 'job_output', { id })).output.includes('bg-hello'),
      5000,
      `'bg-hello' in job_output`,
    )
  })

  it('job_list shows the job and settles to done once the child exits', async () => {
    const { ctx } = await mkHarness()

    const started = await call(ctx, 'bash', { command: 'echo bg-list', run_in_background: true })
    const id = jobId(started.output)

    const listing = await call(ctx, 'job_list', {})
    expect(listing.isError).toBeFalsy()
    expect(listing.output).toContain(id)
    expect(listing.output).toContain('echo bg-list')

    await pollUntil(
      async () => (await call(ctx, 'job_list', {})).output.includes('done'),
      5000,
      'job status done',
    )
  })
})

describe('job_kill', () => {
  it('kills a running job, which then shows up as killed in job_list', async () => {
    const { ctx } = await mkHarness()

    const started = await call(ctx, 'bash', { command: BLOCKER, run_in_background: true })
    const id = jobId(started.output)

    // The job is live before the kill.
    const before = await call(ctx, 'job_list', {})
    expect(before.output).toContain('running')

    const killed = await call(ctx, 'job_kill', { id })
    expect(killed.isError).toBeFalsy()
    expect(killed.output).toBe(`killed ${id}`)

    await pollUntil(
      async () => (await call(ctx, 'job_list', {})).output.includes('killed'),
      3000,
      'job status killed in job_list',
    )
  })

  it('reports an error for a job that is not running', async () => {
    const { ctx } = await mkHarness()

    const result = await call(ctx, 'job_kill', { id: 'job-999' })
    expect(result.isError).toBe(true)
    expect(result.output).toBe('error: job "job-999" is not running')
  })
})

describe('JobsService.stopAll', () => {
  it('marks every live job killed and does not leave it running', async () => {
    const { ctx, dir } = await mkHarness()
    const jobs = ctx.peek<JobsService>('jobs')
    expect(jobs).toBeDefined()

    const first = jobs!.start(BLOCKER, 'bash', dir)
    const second = jobs!.start(BLOCKER, 'bash', dir)
    expect(first.status).toBe('running')
    expect(second.status).toBe('running')

    jobs!.stopAll()

    const statuses = jobs!.list().filter((j) => j.id === first.id || j.id === second.id)
    expect(statuses).toHaveLength(2)
    for (const job of statuses) expect(job.status).toBe('killed')
  })
})
