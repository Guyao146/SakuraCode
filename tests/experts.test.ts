/**
 * spawnExperts — the shared expert-team spawn used by both the web GUI's
 * expert session and the CLI's /experts command. Pure roster mechanics;
 * the turn fan-out lives at the call sites.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { type Harness } from '../src/harness.js'
import { createHarness } from '../src/harness.js'
import { DEFAULT_EXPERTS, spawnExperts } from '../src/experts.js'

const harnesses: Harness[] = []
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()?.dispose()
})

async function boot(): Promise<Harness> {
  const harness = await createHarness({ renderer: false })
  harnesses.push(harness)
  return harness
}

describe('spawnExperts', () => {
  it('spawns the built-in three-member team with expert metadata', async () => {
    const harness = await boot()
    const { spawned, skipped } = spawnExperts(harness.ctx.agents)
    expect(spawned.map((h) => h.name)).toEqual(DEFAULT_EXPERTS.map((e) => e.name))
    expect(skipped).toEqual([])
    for (const handle of spawned) {
      expect(handle.meta.expert).toBe(DEFAULT_EXPERTS.find((e) => e.name === handle.name)?.key)
      expect(handle.meta.role).toBe('sub')
    }
    // The roster mirrors the team (the main agent only spawns on demand).
    expect(harness.ctx.agents.list().map((a) => a.name).sort()).toEqual(
      DEFAULT_EXPERTS.map((e) => e.name).sort(),
    )
  })

  it('reuses existing roster members instead of duplicating them', async () => {
    const harness = await boot()
    spawnExperts(harness.ctx.agents)
    const second = spawnExperts(harness.ctx.agents)
    expect(second.spawned).toEqual([])
    expect(second.skipped).toEqual(['架构师', '实现者', '审查者'])
    expect(harness.ctx.agents.list()).toHaveLength(3)
  })

  it('spawns a requested subset and skips unknown keys via resolveExperts', async () => {
    const harness = await boot()
    const { spawned } = spawnExperts(harness.ctx.agents, ['reviewer'])
    expect(spawned.map((h) => h.name)).toEqual(['审查者'])
    // Unknown keys are rejected before anything spawns.
    expect(() => spawnExperts(harness.ctx.agents, ['ghost'])).toThrow(/unknown expert "ghost"/)
  })
})
