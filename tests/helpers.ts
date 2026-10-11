/**
 * Shared test helpers: a scripted ModelAdapter and a tmp-dir harness factory.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach } from 'vitest'
import { createHarness, type Harness } from '../src/harness.js'
import { HarnessContext, type LLMRequest, type ModelAdapter, type StreamChunk } from '../src/core/index.js'

/** One scripted adapter step: fixed chunks, or a function of the request. */
export type MockStep = StreamChunk[] | ((req: LLMRequest) => StreamChunk[])

/** text(s) → text chunks followed by a stop-done. */
export function text(s: string): StreamChunk[] {
  return [
    { type: 'text', delta: s },
    { type: 'done', reason: 'stop' },
  ]
}

/** toolCall(name, argsJson, id?) → one tool_call chunk followed by a tool_calls-done. */
export function toolCall(name: string, argsJson: string, id?: string): StreamChunk[] {
  return [
    { type: 'tool_call', index: 0, id: id ?? `call-${name}`, name, argsDelta: argsJson },
    { type: 'done', reason: 'tool_calls' },
  ]
}

/**
 * MockAdapter — consumes one scripted step per stream() call, in order.
 * The last step repeats once the script is exhausted, so always script enough
 * steps for every request that will be made (main + subagents).
 */
export class MockAdapter implements ModelAdapter {
  readonly id = 'mock-adapter'
  readonly defaultModel = 'mock-model'
  private index = 0

  constructor(private steps: MockStep[]) {}

  async *stream(req: LLMRequest): AsyncIterable<StreamChunk> {
    const step = this.steps[Math.min(this.index, this.steps.length - 1)] ?? text('ok')
    this.index++
    const chunks = typeof step === 'function' ? step(req) : step
    for (const chunk of chunks) {
      yield chunk
    }
  }
}

/** Anything registered here is disposed after each test (harnesses, tmp dirs). */
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanups.length) {
    const dispose = cleanups.pop()
    await dispose?.()
  }
})

export interface TmpHarness {
  harness: Harness
  ctx: Harness['ctx']
  tmpDir: string
  /** The adapter wired into the harness (a MockAdapter unless overridden). */
  adapter: ModelAdapter
}

/**
 * tmpHarness — a fresh harness in a fresh temp directory with the MockAdapter
 * wired in and the renderer disabled. Cleaned up automatically after the test.
 */
export async function tmpHarness(
  overrides: Partial<Parameters<typeof createHarness>[0]> & { steps?: MockStep[] } = {},
): Promise<TmpHarness> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-test-'))
  const adapter: ModelAdapter = overrides.adapter ?? new MockAdapter(overrides.steps ?? [text('ok')])
  const { steps: _steps, adapter: _adapter, ...rest } = overrides
  const harness = await createHarness({
    cwd: tmpDir,
    adapter,
    approvalMode: 'yolo',
    jobsDir: '.sakura/jobs',
    renderer: false,
    ...rest,
  })
  cleanups.push(async () => {
    try {
      harness.dispose()
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  })
  return { harness, ctx: harness.ctx, tmpDir, adapter }
}
