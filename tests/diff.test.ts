import { describe, expect, it } from 'vitest'
import { lineDiff, renderUnifiedDiff, MAX_LCS_LINES } from '../src/util/diff.js'

describe('lineDiff', () => {
  it('marks identical text as all same', () => {
    const out = lineDiff('a\nb\nc', 'a\nb\nc')
    expect(out.every((l) => l.type === 'same')).toBe(true)
    expect(out.map((l) => l.text)).toEqual(['a', 'b', 'c'])
  })

  it('detects a single-line replacement', () => {
    const out = lineDiff('one\ntwo\nthree', 'one\nTWO\nthree')
    expect(out.map((l) => `${l.type}:${l.text}`)).toEqual([
      'same:one',
      'del:two',
      'add:TWO',
      'same:three',
    ])
  })

  it('detects an inserted line', () => {
    const out = lineDiff('a\nc', 'a\nb\nc')
    expect(out.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['b'])
    expect(out.filter((l) => l.type === 'del')).toEqual([])
  })

  it('detects a deleted line', () => {
    const out = lineDiff('a\nb\nc', 'a\nc')
    expect(out.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['b'])
    expect(out.filter((l) => l.type === 'add')).toEqual([])
  })

  it('treats empty strings as zero lines', () => {
    expect(lineDiff('', '')).toEqual([])
    expect(lineDiff('', 'x\ny').filter((l) => l.type === 'add').length).toBe(2)
    expect(lineDiff('x\ny', '').filter((l) => l.type === 'del').length).toBe(2)
  })

  it('strips CRLF before comparing', () => {
    const out = lineDiff('one\r\ntwo\r\n', 'one\r\nTWO\r\n')
    expect(out.filter((l) => l.type === 'del').map((l) => l.text)).toEqual(['two'])
    expect(out.filter((l) => l.type === 'add').map((l) => l.text)).toEqual(['TWO'])
  })

  it('preserves blank lines instead of treating a newline-only file as empty', () => {
    expect(lineDiff('', '\n')).toEqual([{ type: 'add', text: '' }])
    expect(lineDiff('\r\n', '')).toEqual([{ type: 'del', text: '' }])
    expect(lineDiff('\n', '\n\n')).toEqual([{ type: 'same', text: '' }, { type: 'add', text: '' }])
    expect(lineDiff('\na\n\nb\n', '\na\n\nb\n')).toEqual([
      { type: 'same', text: '' },
      { type: 'same', text: 'a' },
      { type: 'same', text: '' },
      { type: 'same', text: 'b' },
    ])
  })

  it('ignores the final line terminator, not a trailing blank line or trailing spaces', () => {
    expect(lineDiff('a', 'a\n')).toEqual([{ type: 'same', text: 'a' }])
    expect(lineDiff('a\n', 'a\n\n')).toEqual([{ type: 'same', text: 'a' }, { type: 'add', text: '' }])
    expect(lineDiff('a ', 'a')).toEqual([{ type: 'del', text: 'a ' }, { type: 'add', text: 'a' }])
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n')).toEqual([
      { type: 'same', text: 'a' }, { type: 'same', text: 'b' },
    ])
  })

  it('recognizes identical large texts before the replacement size guard', () => {
    const lines = Array.from({ length: MAX_LCS_LINES + 100 }, (_, i) => `line-${i}`)
    const out = lineDiff(lines.join('\n'), lines.join('\n'))
    expect(out).toHaveLength(lines.length)
    expect(out.every((line) => line.type === 'same')).toBe(true)
    expect(lineDiff(lines.join('\r\n') + '\r\n', lines.join('\n'))).toEqual(out)
  })

  it('degrades to whole-block replacement above the LCS size guard', () => {
    const a = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `old-${i}`).join('\n') + '\nchanged\n'
    const b = Array.from({ length: MAX_LCS_LINES + 1 }, (_, i) => `old-${i}`).join('\n') + '\nCHANGED\n'
    const out = lineDiff(a, b)
    expect(out.filter((l) => l.type === 'del').length).toBe(MAX_LCS_LINES + 2)
    expect(out.filter((l) => l.type === 'add').length).toBe(MAX_LCS_LINES + 2)
    expect(out.length).toBe((MAX_LCS_LINES + 2) * 2)
  })
})

describe('renderUnifiedDiff', () => {
  it('returns empty string for identical text', () => {
    expect(renderUnifiedDiff('a\nb', 'a\nb')).toBe('')
  })

  it('emits a hunk header and prefixed lines for a replacement', () => {
    const out = renderUnifiedDiff('one\ntwo\nthree', 'one\nTWO\nthree')
    expect(out.startsWith('@@ -1,3 +1,3 @@')).toBe(true)
    const lines = out.split('\n')
    expect(lines[1]).toBe(' one')
    expect(lines[2]).toBe('-two')
    expect(lines[3]).toBe('+TWO')
    expect(lines[4]).toBe(' three')
  })

  it('respects contextLines to bound surrounding context', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    const newText = oldText.replace('l5', 'L5')
    const out = renderUnifiedDiff(oldText, newText, 1)
    const lines = out.split('\n')
    expect(lines[0]).toBe('@@ -5,3 +5,3 @@')
    expect(lines.slice(1)).toEqual([' l4', '-l5', '+L5', ' l6'])
  })

  it('splits far-apart changes into separate hunks with correct headers', () => {
    // 10 same lines between two single-line changes (gap > 2*3) → 2 hunks
    const a = ['x', ...Array.from({ length: 10 }, (_, i) => `m${i}`), 'y'].join('\n')
    const b = ['X', ...Array.from({ length: 10 }, (_, i) => `m${i}`), 'Y'].join('\n')
    const out = renderUnifiedDiff(a, b, 3)
    // First hunk: x + m0..m2 → old lines 1..4 (no room for leading context)
    // Second hunk: m7..m9 + y → old lines 9..12
    expect(out).toBe(
      '@@ -1,4 +1,4 @@\n' +
      '-x\n+X\n m0\n m1\n m2\n' +
      '@@ -9,4 +9,4 @@\n' +
      ' m7\n m8\n m9\n-y\n+Y'
    )
  })

  it('merges hunks when the gap fits inside the context windows', () => {
    // 4 same lines between changes, context 3 (gap 4 <= 2*3) → one hunk
    const a = ['x', 'p', 'q', 'r', 's', 'y'].join('\n')
    const b = ['X', 'p', 'q', 'r', 's', 'Y'].join('\n')
    const out = renderUnifiedDiff(a, b, 3)
    expect(out).toBe('@@ -1,6 +1,6 @@\n-x\n+X\n p\n q\n r\n s\n-y\n+Y')
  })

  it('uses zero as the line before an empty file on insertion or deletion', () => {
    expect(renderUnifiedDiff('', 'a\nb\n')).toBe('@@ -0,0 +1,2 @@\n+a\n+b')
    expect(renderUnifiedDiff('a\nb\n', '')).toBe('@@ -1,2 +0,0 @@\n-a\n-b')
    expect(renderUnifiedDiff('', '\n')).toBe('@@ -0,0 +1,1 @@\n+')
    expect(renderUnifiedDiff('\r\n', '')).toBe('@@ -1,1 +0,0 @@\n-')
  })

  it.each([
    ['a\nc', 'b\na\nc', '@@ -0,0 +1,1 @@\n+b'],
    ['a\nc', 'a\nb\nc', '@@ -1,0 +2,1 @@\n+b'],
    ['a\nc', 'a\nc\nb', '@@ -2,0 +3,1 @@\n+b'],
    ['b\na\nc', 'a\nc', '@@ -1,1 +0,0 @@\n-b'],
    ['a\nb\nc', 'a\nc', '@@ -2,1 +1,0 @@\n-b'],
    ['a\nc\nb', 'a\nc', '@@ -3,1 +2,0 @@\n-b'],
  ])('anchors zero-context empty ranges at the preceding line (%s → %s)', (before, after, expected) => {
    expect(renderUnifiedDiff(before, after, 0)).toBe(expected)
  })

  it('renders a real trailing blank line but ignores LF/CRLF and final-terminator differences', () => {
    expect(renderUnifiedDiff('a\r\nb\r\n', 'a\nb')).toBe('')
    expect(renderUnifiedDiff('a\n', 'a\n\n', 0)).toBe('@@ -1,0 +2,1 @@\n+')
    expect(renderUnifiedDiff('\na\n\nb\n', '\na\n\nB\n', 1)).toBe('@@ -3,2 +3,2 @@\n \n-b\n+B')
  })

  it('returns no hunks for identical text above the LCS guard', () => {
    const text = Array.from({ length: MAX_LCS_LINES + 100 }, (_, i) => `line-${i}`).join('\n')
    expect(renderUnifiedDiff(text, text)).toBe('')
    expect(renderUnifiedDiff(text.replace(/\n/g, '\r\n') + '\r\n', text)).toBe('')
  })

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid contextLines=%s rather than producing NaN ranges', (context) => {
    expect(() => renderUnifiedDiff('a', 'b', context)).toThrow(RangeError)
  })

  it('keeps large dissimilar inputs bounded by the replacement fallback', () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `old-${i}`).join('\n')
    const after = Array.from({ length: 10_000 }, (_, i) => `new-${i}`).join('\n')
    const out = renderUnifiedDiff(before, after)
    expect(out.startsWith('@@ -1,10000 +1,10000 @@\n-old-0\n')).toBe(true)
    expect(out.endsWith('+new-9999')).toBe(true)
    expect(out).not.toMatch(/NaN|undefined/)
  })

  it('renders pure insertion with the right counts', () => {
    const out = renderUnifiedDiff('a\nc', 'a\nb\nc', 1)
    expect(out).toBe('@@ -1,2 +1,3 @@\n a\n+b\n c')
  })
})
