/**
 * Multimodal replay: tool/result images enter the model-visible context as a
 * synthetic user message with OpenAI content parts — but only for the most
 * recent image-carrying result; older ones degrade to a text note.
 */

import { describe, expect, it } from 'vitest'
import { Session } from '../src/core/session.js'

const IMG_A = 'data:image/png;base64,AAAA'
const IMG_B = 'data:image/png;base64,BBBB'

describe('Session.deriveMessages — tool images', () => {
  it('replays the most recent tool image as a user content-part message', async () => {
    const s = new Session('t', 'tmp')
    await s.append({ type: 'user/message', payload: { content: 'take a shot' } })
    await s.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'computer_screenshot', output: 'screenshot 100x100', durationMs: 5, images: [IMG_A] },
    })
    const msgs = s.deriveMessages()
    const tool = msgs.find((m) => m.role === 'tool')
    expect(tool).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'screenshot 100x100' })
    const imageMsgs = msgs.filter((m) => m.role === 'user' && Array.isArray(m.content))
    expect(imageMsgs).toHaveLength(1)
    const parts = imageMsgs[0]!.content
    expect(parts[0]).toEqual({ type: 'text', text: 'Image(s) produced by tool "computer_screenshot":' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: IMG_A } })
  })

  it('keeps only the latest image set; older ones are elided to a note', async () => {
    const s = new Session('t', 'tmp')
    await s.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'computer_screenshot', output: 'shot one', durationMs: 5, images: [IMG_A] },
    })
    await s.append({
      type: 'tool/result',
      payload: { id: 'c2', name: 'computer_screenshot', output: 'shot two', durationMs: 5, images: [IMG_B] },
    })
    const msgs = s.deriveMessages()
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    expect(toolMsgs[0]).toMatchObject({ tool_call_id: 'c1' })
    expect(String(toolMsgs[0]!.content)).toContain('elided')
    expect(String(toolMsgs[1]!.content)).toBe('shot two')
    const imageMsgs = msgs.filter((m) => m.role === 'user' && Array.isArray(m.content))
    expect(imageMsgs).toHaveLength(1)
    const parts = imageMsgs[0]!.content
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: IMG_B } })
  })

  it('adds no synthetic message when a result has no images', async () => {
    const s = new Session('t', 'tmp')
    await s.append({ type: 'tool/result', payload: { id: 'c1', name: 'bash', output: 'ok', durationMs: 1 } })
    const msgs = s.deriveMessages()
    expect(msgs.filter((m) => m.role === 'user')).toHaveLength(0)
  })

  it('user string messages stay plain strings alongside image parts', async () => {
    const s = new Session('t', 'tmp')
    await s.append({ type: 'user/message', payload: { content: 'hi' } })
    await s.append({
      type: 'tool/result',
      payload: { id: 'c1', name: 'shot', output: 'ok', durationMs: 1, images: [IMG_A] },
    })
    const msgs = s.deriveMessages()
    expect(msgs[0]).toEqual({ role: 'user', content: 'hi' })
  })
})
