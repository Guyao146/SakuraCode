/** Lossless Markdown spans with stable content identities. Unchanged entries
 * keep their disabled state across restarts and edits to neighbouring entries. */
import { createHash } from 'node:crypto'

export type MemoryCollection = 'longTerm' | 'pending'
export interface MemoryEntry { id: string; content: string; enabled: boolean }
export interface MemoryEntrySpan extends MemoryEntry { start: number; end: number }
export interface MemoryEntryOperation {
  collection: MemoryCollection
  id: string
  action: 'delete' | 'toggle' | 'replace'
  enabled?: boolean
  content?: string
}

export function memoryEntrySpans(text: string, collection: MemoryCollection, disabled: readonly string[] = []): MemoryEntrySpan[] {
  const lines = text.split('\n')
  const boundaries = [0]
  let offset = 0
  let fence = ''
  let previousBlank = false
  const pendingSections = collection === 'pending' && /^##\s/m.test(text)
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    const inFence = !!fence
    if (marker && (!fence || marker[0] === fence[0] && marker.length >= fence.length)) fence = fence ? '' : marker
    if (!inFence && !fence && line.trim() && offset > 0) {
      const boundary = pendingSections ? /^##\s/.test(line)
        : /^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s)/.test(line) || previousBlank
      if (boundary) boundaries.push(offset)
    }
    previousBlank = !line.trim()
    offset += line.length + 1
  }
  boundaries.push(text.length)
  const occurrences = new Map<string, number>()
  const off = new Set(disabled)
  const entries: MemoryEntrySpan[] = []
  for (let index = 0; index < boundaries.length - 1; index++) {
    const start = boundaries[index]!, end = boundaries[index + 1]!
    const content = text.slice(start, end).trim()
    if (!content) continue
    const hash = createHash('sha256').update(collection + '\0' + content).digest('hex').slice(0, 24)
    const occurrence = occurrences.get(hash) ?? 0
    occurrences.set(hash, occurrence + 1)
    const id = `${hash}-${occurrence}`
    entries.push({ id, content, start, end, enabled: !off.has(id) })
  }
  return entries
}

export function activeMemoryContent(state: { content: string; disabledEntries?: readonly string[] }): string {
  if (!state.disabledEntries?.length) return state.content
  return memoryEntrySpans(state.content, 'longTerm', state.disabledEntries).filter(entry => entry.enabled).map(entry => entry.content).join('\n\n')
}

/** Model-generated replacements cannot delete or implicitly re-enable user-disabled notes. */
export function preserveDisabledMemory(content: string, previous: { content: string; disabledEntries: readonly string[] }): { content: string; disabledEntries: string[] } {
  const disabled = memoryEntrySpans(previous.content, 'longTerm', previous.disabledEntries).filter(entry => !entry.enabled)
  if (!disabled.length) return { content, disabledEntries: [] }
  const offText = new Set(disabled.map(entry => entry.content))
  const active = memoryEntrySpans(content, 'longTerm').filter(entry => !offText.has(entry.content)).map(entry => entry.content)
  const merged = [...active, ...disabled.map(entry => entry.content)].join('\n\n')
  return { content: merged, disabledEntries: memoryEntrySpans(merged, 'longTerm').filter(entry => offText.has(entry.content)).map(entry => entry.id) }
}