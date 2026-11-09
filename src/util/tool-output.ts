/** Fixed previews of recorded tool text; never truncates the stored output. */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, ToolOutputPreview } from '../core/types.js'

export const MAX_TOOL_OUTPUT_PAGE_CHARS = 12_000
export const MIN_TOOL_OUTPUT_PREVIEW_CHARS = 1024
export const MAX_TOOL_OUTPUT_PREVIEW_CHARS = 1_000_000

export function validateToolOutputBudget(value: unknown): number {
  if (value === undefined || value === 0) return 0
  if (!Number.isSafeInteger(value) || Number(value) < MIN_TOOL_OUTPUT_PREVIEW_CHARS || Number(value) > MAX_TOOL_OUTPUT_PREVIEW_CHARS) {
    throw new Error('outputPreviewChars must be 0 (disabled) or an integer from 1024 to 1000000')
  }
  return Number(value)
}

export function isToolOutputReference(value: unknown): value is string {
  return typeof value === 'string' && /^output_[0-9a-f]{32}$/.test(value)
}

export function previewToolOutput(output: string, budget: number, isError = false): ToolOutputPreview | undefined {
  if (!budget || output.length <= budget) return undefined
  const reference = `output_${randomUUID().replace(/-/g, '')}`
  const note = `\n\n[${isError ? 'ERROR; ' : ''}tool text preview; middle omitted. Recorded output: ${output.length} UTF-16 characters. ` +
    `Read the saved text with tool_output_read {"reference":"${reference}","offset":0,"limit":${Math.min(MAX_TOOL_OUTPUT_PAGE_CHARS, budget - 256)}}. ` +
    'Offsets/limits count UTF-16 characters. This is recorded output, not a new execution; earlier tool-side truncation cannot be recovered.]\n\n'
  const remaining = Math.max(0, budget - note.length)
  let head = Math.ceil(remaining * 2 / 3), tail = remaining - head
  // Do not split a surrogate pair at either edge of the omitted section.
  if (head && /[\uD800-\uDBFF]/.test(output[head - 1]!)) head--
  if (tail && /[\uDC00-\uDFFF]/.test(output[output.length - tail]!)) tail--
  return { reference, content: output.slice(0, head) + note + (tail ? output.slice(-tail) : '') }
}

/** Include only previews whose tool result actually belongs to this committed step. */
export function committedToolPreviews(
  events: readonly { type: string; payload: unknown }[], messages: readonly ChatMessage[],
): Record<string, ToolOutputPreview> | undefined {
  const ids = new Set(messages.filter(message => message.role === 'tool').map(message => message.tool_call_id))
  const previews: Record<string, ToolOutputPreview> = Object.create(null)
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const result = event.payload as { id?: string; modelPreview?: ToolOutputPreview }
    if (result.id && ids.has(result.id)) {
      if (result.modelPreview) previews[result.id] = result.modelPreview
      else delete previews[result.id]
    }
  }
  return Object.keys(previews).length ? previews : undefined
}
