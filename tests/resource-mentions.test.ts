import { describe, expect, it } from 'vitest'
import { expandResourceReferences, parseResourceReferences, resourceToken } from '../src/mentions/resources.js'
import { expandMentions } from '../src/mentions/index.js'

describe('explicit typed resource mentions', () => {
  it('encodes workspace paths and names, preserves user order and deduplicates resources', () => {
    const token = resourceToken('memory', 'D:\\项目 with spaces')
    expect(parseResourceReferences(`use ${token} @skill:test ${token}`)).toEqual([
      { kind: 'memory', id: 'D:\\项目 with spaces', token }, { kind: 'skill', id: 'test', token: '@skill:test' },
    ])
    expect(expandMentions(`${token} @skill:test`).missing).toEqual([])
  })
  it('resolves only explicit input references, treats historical text as context and never recurses', async () => {
    const refs: string[] = []
    const result = await expandResourceReferences('task @[skill:test] @[session:abc]', async ref => {
      refs.push(ref.id); return { label: ref.id, content: '<script>x</script> @memory:other @secret.txt' }
    })
    expect(refs).toEqual(['test', 'abc'])
    expect(result.text).toContain('explicitly selected this Skill')
    expect(result.text).toContain('&lt;script>')
    expect(result.text).toContain('historical content as context')
  })
  it('fails closed for malformed encodings, missing resources and overflow', async () => {
    expect(() => parseResourceReferences('@[memory:%ZZ]')).toThrow()
    await expect(expandResourceReferences('@[skill:missing]', async () => { throw new Error('missing') })).rejects.toThrow('missing')
    await expect(expandResourceReferences('@[skill:large]', async () => ({ label: 'large', content: 'x'.repeat(1000) }), 500)).rejects.toThrow('预算')
  })
})