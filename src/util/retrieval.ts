/** Dependency-free lexical retrieval. Scores describe matching text, never confidence. */
export interface RetrievalItem { id: string; content: string; source: string; startLine?: number }
export interface RetrievalHit {
  id: string
  source: string
  snippet: string
  score: number
  startLine?: number
  endLine?: number
  truncated: boolean
}

const FRAGMENT_CHARS = 480
const CONTEXT_CHARS = 96
const MAX_FRAGMENTS = 2
const GAP = '\n…\n'
interface Term { text: string; start: number; end: number }
interface Fragment { start: number; end: number; score: number }

function normalize(text: string): string { return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim() }

/** Han bigrams avoid treating an entire Chinese sentence as one word. Other
 * scripts use whole words, so e.g. "test" does not also match "latest". */
function* terms(text: string): Generator<Term> {
  // Include combining marks and the compatibility underscore before NFKC so
  // normalization does not silently split an English word or lose its offsets.
  const words = /\p{Script=Han}+|(?:(?!\p{Script=Han})[\p{L}\p{N}\p{M}_＿])+/gu
  for (const match of text.matchAll(words)) {
    const word = match[0], start = match.index!
    if (/^\p{Script=Han}+$/u.test(word)) {
      const chars = Array.from(word)
      let offset = start
      for (let index = 0; index < chars.length; index++) {
        const char = chars[index]!, next = chars[index + 1]
        if (next || chars.length === 1) yield {
          text: normalize(char + (next ?? '')), start: offset, end: offset + char.length + (next?.length ?? 0),
        }
        offset += char.length
      }
    } else yield { text: normalize(word), start, end: start + word.length }
  }
}

function fragments(content: string, query: string, queryTerms: ReadonlySet<string>, maxChars: number): Fragment[] {
  const matches = Array.from(terms(content)).filter(term => queryTerms.has(term.text))
  if (!matches.length) return []
  const candidates: Fragment[] = []
  const windowChars = Math.min(FRAGMENT_CHARS, maxChars)
  let through = 0
  const counts = new Map<string, number>()
  let left = 0
  let previousStart = -1
  for (const match of matches) {
    // A matching whole word / Han bigram must fit in the returned budget. A
    // prefix of an oversized token is not a searchable excerpt.
    if (match.end - match.start > windowChars) continue
    // Score bounded local windows, rather than accumulating relevance over a
    // whole document. Repeating one term cannot drown out broader coverage.
    const context = Math.min(CONTEXT_CHARS, windowChars - (match.end - match.start))
    let start = Math.max(0, match.start - context)
    if (start > 0 && /[\uD800-\uDBFF]/.test(content[start - 1]!) && /[\uDC00-\uDFFF]/.test(content[start]!)) start++
    if (start === previousStart) continue
    previousStart = start
    let end = Math.min(content.length, start + windowChars)
    if (end < content.length && /[\uD800-\uDBFF]/.test(content[end - 1]!) && /[\uDC00-\uDFFF]/.test(content[end]!)) end--
    while (through < matches.length && matches[through]!.end <= end) {
      const term = matches[through++]!.text
      counts.set(term, (counts.get(term) ?? 0) + 1)
    }
    while (left < through && matches[left]!.start < start) {
      const term = matches[left++]!.text, remaining = counts.get(term)! - 1
      if (remaining) counts.set(term, remaining)
      else counts.delete(term)
    }
    const occurrences = Array.from(counts.values()).reduce((sum, count) => sum + Math.min(count, 3), 0)
    const phrase = normalize(content.slice(start, end)).includes(query) ? 10 : 0
    candidates.push({ start, end, score: counts.size * 100 + occurrences + phrase })
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start)
  const selected: Fragment[] = []
  for (const fragment of candidates) {
    if (selected.some(previous => fragment.start < previous.end && fragment.end > previous.start)) continue
    selected.push(fragment)
    if (selected.length === MAX_FRAGMENTS) break
  }
  return selected
}

function sliceWithoutBrokenSurrogate(text: string, length: number): string {
  let end = Math.min(text.length, length)
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--
  return text.slice(0, end)
}

export function retrieveText(query: string, items: readonly RetrievalItem[], options?: { limit?: number; maxChars?: number }): { results: RetrievalHit[]; truncated: boolean } {
  if (typeof query !== 'string') throw new TypeError('query must be a string')
  const normalizedQuery = normalize(query)
  if (!normalizedQuery || normalizedQuery.length > 256) throw new RangeError('query must contain 1–256 normalized characters')
  const queryTerms = new Set(Array.from(terms(normalizedQuery), term => term.text))
  if (!queryTerms.size) throw new RangeError('query must contain searchable words or Chinese characters')
  const limit = options?.limit === undefined ? 5 : options.limit
  const maxChars = options?.maxChars === undefined ? 6000 : options.maxChars
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError('limit must be a safe integer from 1 to 20')
  if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 16000) throw new RangeError('maxChars must be a safe integer from 256 to 16000')
  const ranked = items.map((item, index) => {
    if (typeof item.id !== 'string' || typeof item.source !== 'string' || typeof item.content !== 'string' ||
      item.startLine !== undefined && (!Number.isSafeInteger(item.startLine) || item.startLine < 1)) throw new TypeError('invalid retrieval item')
    const selected = fragments(item.content, normalizedQuery, queryTerms, maxChars)
    return { item, index, selected, score: selected[0]?.score ?? 0 }
  }).filter(row => row.selected.length)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const results: RetrievalHit[] = []
  let remaining = maxChars
  let truncated = ranked.length > limit
  for (const { item, selected, score } of ranked.slice(0, limit)) {
    if (remaining <= 0) { truncated = true; break }
    // Spend the budget on the strongest matching window first. Sorting before
    // budgeting can otherwise let an earlier generic excerpt hide the rare match.
    const candidates = remaining >= maxChars ? selected : fragments(item.content, normalizedQuery, queryTerms, remaining)
    const bounded: Fragment[] = []
    let available = remaining
    for (const fragment of candidates) {
      const length = fragment.end - fragment.start + (bounded.length ? GAP.length : 0)
      if (length > available) { truncated = true; continue }
      bounded.push(fragment)
      available -= length
    }
    if (!bounded.length) { truncated = true; continue }
    const ordered = bounded.sort((a, b) => a.start - b.start)
    const parts: string[] = []
    let lastEnd = ordered[0]!.start
    let shortened = false
    for (const fragment of ordered) {
      const separator = parts.length ? GAP : ''
      if (remaining <= separator.length) { shortened = true; break }
      const text = sliceWithoutBrokenSurrogate(item.content.slice(fragment.start, fragment.end), remaining - separator.length)
      if (!text) { shortened = true; break }
      parts.push(separator + text)
      remaining -= separator.length + text.length
      lastEnd = fragment.start + text.length
      if (lastEnd < fragment.end) { shortened = true; break }
    }
    if (!parts.length) { truncated = true; break }
    const firstStart = ordered[0]!.start
    const hitTruncated = shortened || firstStart > 0 || lastEnd < item.content.length || parts.length > 1
    const lineAt = (offset: number) => item.startLine! + (item.content.slice(0, offset).match(/\n/g)?.length ?? 0)
    results.push({ id: item.id, source: item.source, snippet: parts.join(''), score, truncated: hitTruncated,
      ...(item.startLine === undefined ? {} : { startLine: lineAt(firstStart), endLine: lineAt(Math.max(firstStart, lastEnd - 1)) }) })
    truncated ||= hitTruncated
  }
  return { results, truncated }
}
