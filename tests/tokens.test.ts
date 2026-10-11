import { describe, expect, it } from 'vitest'
import { estimateMessagesTokens, estimateTokens, IMAGE_TOKENS, MESSAGE_OVERHEAD } from '../src/util/tokens.js'

describe('estimateTokens', () => {
  it('returns 0 for empty and whitespace-only text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   \n\t ')).toBe(0)
  })

  it('estimates ASCII words at ~4 chars per token', () => {
    // 'hello' → ceil(5/4) = 2, 'world' → 2 → 4
    expect(estimateTokens('hello world')).toBe(4)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('counts CJK characters at 1 token each', () => {
    expect(estimateTokens('你好世界')).toBe(4)
    expect(estimateTokens('。')).toBe(1) // CJK punctuation
  })

  it('handles mixed CJK and ASCII', () => {
    // '你好' = 2 CJK + ' hello' → ceil(5/4)=2 → 4
    expect(estimateTokens('你好 hello')).toBe(4)
    // Same visual length of pure ASCII is cheaper than CJK-heavy text
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('八个汉字')).toBe(4)
  })

  it('grows when content doubles', () => {
    const one = 'do the thing carefully'
    expect(estimateTokens(one + ' ' + one)).toBeGreaterThan(estimateTokens(one))
  })
})

describe('estimateMessagesTokens', () => {
  it('sums string contents plus per-message overhead', () => {
    const total = estimateMessagesTokens([
      { role: 'system', content: 'hello world' }, // 4 + 4
      { role: 'user', content: 'a b c' }, // 3 + 4
    ])
    // 'a b c' → three runs of 1 char → 3
    expect(total).toBe((4 + 4) + (3 + 4))
  })

  it('charges image parts a flat cost', () => {
    const total = estimateMessagesTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abcd' }, // 1
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' } },
        ],
      },
    ])
    expect(total).toBe(1 + IMAGE_TOKENS + MESSAGE_OVERHEAD)
  })

  it('includes assistant tool_call function names and arguments', () => {
    const args = JSON.stringify({ command: 'echo hi' })
    const total = estimateMessagesTokens([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: args } }] },
    ])
    expect(total).toBe(MESSAGE_OVERHEAD + estimateTokens('bash ' + args))
  })

  it('includes tool message contents', () => {
    const total = estimateMessagesTokens([{ role: 'tool', tool_call_id: 'c1', content: 'abcdefgh' }])
    expect(total).toBe(MESSAGE_OVERHEAD + 2)
  })

  it('is monotonic as the conversation grows', () => {
    const one = estimateMessagesTokens([{ role: 'user', content: '八个汉字' }])
    const two = estimateMessagesTokens([
      { role: 'user', content: '八个汉字' },
      { role: 'assistant', content: '收到，马上处理' },
    ])
    expect(two).toBeGreaterThan(one)
  })
})
