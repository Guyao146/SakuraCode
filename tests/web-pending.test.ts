import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingRequests } from '../src/web/pending.js'

afterEach(() => { vi.useRealTimers() })

describe('Web pending requests', () => {
  it('publishes only after registration and allows exactly one resolver', async () => {
    const events: Record<string, unknown>[] = []
    const requests = new PendingRequests<boolean>((frame) => events.push(frame), 'approval/resolved', 'allow', false, 1000)
    const result = requests.wait({ type: 'approval/request', id: 'a', agentId: 'agent-a', summary: 'write file' })
    expect(requests.snapshot()).toEqual([expect.objectContaining({ id: 'a', summary: 'write file', createdAt: expect.any(Number), expiresAt: expect.any(Number) })])
    expect(requests.resolve('a', true)).toBe(true)
    expect(requests.resolve('a', false)).toBe(false)
    expect(await result).toBe(true)
    expect(requests.snapshot()).toEqual([])
    expect(events.map((event) => event.type)).toEqual(['approval/request', 'approval/resolved'])
  })

  it('expires once and clears timers on cancellation', async () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const requests = new PendingRequests<string | null>(emit, 'interaction/resolved', 'answer', null, 1000)
    const result = requests.wait({ type: 'interaction/request', id: 'question' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toBeNull()
    expect(emit).toHaveBeenCalledTimes(2)
    requests.cancel()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels only the named agent and releases a signal-aborted request', async () => {
    const emit = vi.fn()
    const requests = new PendingRequests<boolean>(emit, 'approval/resolved', 'allow', false, 1000)
    const controller = new AbortController()
    const first = requests.wait({ type: 'approval/request', id: 'a', agentId: 'agent-a' })
    const second = requests.wait({ type: 'approval/request', id: 'b', agentId: 'agent-b' }, controller.signal)
    requests.cancel('agent-a')
    expect(await first).toBe(false)
    expect(requests.snapshot().map((entry) => entry.id)).toEqual(['b'])
    controller.abort()
    expect(await second).toBe(false)
    expect(requests.snapshot()).toEqual([])
    expect(await requests.wait({ type: 'approval/request', id: 'c' }, controller.signal)).toBe(false)
    expect(emit).toHaveBeenCalledTimes(4)
  })
})