/**
 * Line-level diff utilities — pure functions, zero dependencies.
 *
 * Used by the GUI edit-tool card to render a unified diff instead of two
 * raw old/new blocks. LCS-based with a size guard: typical edits are tens to
 * a few hundred lines, so O(n*m) is fine, but pathological multi-thousand-line
 * replacements would blow up memory — above MAX_LCS_LINES we degrade to the
 * trivial whole-block replacement.
 */

export type DiffLineType = 'same' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  text: string
}

/** Above this many lines on either side, skip the DP table. */
export const MAX_LCS_LINES = 2000

/**
 * lineDiff — LCS line diff. `\r` is stripped before comparison so CRLF files
 * diff the same as LF ones. An empty string counts as zero lines.
 */
export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = splitLines(oldStr)
  const b = splitLines(newStr)
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) {
    // Beyond the guard, identical inputs still render as unchanged rather
    // than as a giant del+add block.
    if (a.length === b.length && a.every((line, i) => line === b[i])) {
      return a.map<DiffLine>((text) => ({ type: 'same', text }))
    }
    return [
      ...a.map<DiffLine>((text) => ({ type: 'del', text })),
      ...b.map<DiffLine>((text) => ({ type: 'add', text })),
    ]
  }
  return lcsDiff(a, b)
}

/**
 * renderUnifiedDiff — unified-style text: `-`/`+`/space prefixes plus
 * `@@ -oldStart,oldCount +newStart,newCount @@` hunk headers with
 * `contextLines` of surrounding context (default 3).
 * Returns '' when the two texts are identical, so callers can skip rendering.
 */
export function renderUnifiedDiff(oldStr: string, newStr: string, contextLines = 3): string {
  if (!Number.isInteger(contextLines) || contextLines < 0) {
    throw new RangeError('contextLines must be a non-negative integer')
  }
  const lines = lineDiff(oldStr, newStr)
  if (!lines.some((l) => l.type !== 'same')) return ''

  // Prefix sums: oldNo[k]/newNo[k] = old/new lines consumed before diff index k.
  const oldNo: number[] = []
  const newNo: number[] = []
  let o = 0
  let n = 0
  for (const line of lines) {
    oldNo.push(o)
    newNo.push(n)
    if (line.type === 'add') n++
    else if (line.type === 'del') o++
    else {
      o++
      n++
    }
  }
  // Trailing entry so oldNo[end] is defined when end === lines.length.
  oldNo.push(o)
  newNo.push(n)

  // Group change indices: two changes merge into one hunk when the run of
  // same lines between them is <= 2 * contextLines (their context windows touch).
  const changes: number[] = []
  lines.forEach((line, k) => {
    if (line.type !== 'same') changes.push(k)
  })
  const groups: Array<[number, number]> = []
  for (const c of changes) {
    const last = groups[groups.length - 1]
    if (last && c - last[1] - 1 <= 2 * contextLines) last[1] = c
    else groups.push([c, c])
  }

  const hunks: string[] = []
  for (const [first, last] of groups) {
    const start = Math.max(first - contextLines, 0)
    const end = Math.min(last + 1 + contextLines, lines.length)
    const oldCount = oldNo[end]! - oldNo[start]!
    const newCount = newNo[end]! - newNo[start]!
    const body: string[] = []
    for (let k = start; k < end; k++) {
      const line = lines[k]!
      body.push((line.type === 'same' ? ' ' : line.type === 'add' ? '+' : '-') + line.text)
    }
    // Unified convention: a zero-count side points at the line the change
    // sits *before* (no +1), e.g. `@@ -0,0 +1,1 @@` for a leading insertion.
    const oldStart = oldCount === 0 ? oldNo[start]! : oldNo[start]! + 1
    const newStart = newCount === 0 ? newNo[start]! : newNo[start]! + 1
    hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join('\n')}`)
  }
  return hunks.join('\n')
}

function splitLines(s: string): string[] {
  if (s === '') return []
  // trimEnd first so a single trailing newline doesn't produce a phantom empty last line
  const normalized = s.replace(/\r\n?/g, '\n')
  const trimmed = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized
  // '\n' is one empty line, not zero lines.
  return trimmed === '' ? [''] : trimmed.split('\n')
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i]! === b[j]! ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i]! === b[j]!) {
      out.push({ type: 'same', text: a[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: 'del', text: a[i]! })
      i++
    } else {
      out.push({ type: 'add', text: b[j]! })
      j++
    }
  }
  while (i < n) out.push({ type: 'del', text: a[i++]! })
  while (j < m) out.push({ type: 'add', text: b[j++]! })
  return out
}
