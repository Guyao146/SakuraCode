/** Read a recorded tool output using a local reference, never an arbitrary path or session id. */
import type { PluginModule } from '../kernel/index.js'
import { isSessionId, type Session, type SessionService } from '../core/session.js'
import type { ToolsService } from '../core/tools.js'
import type { ToolContext } from '../core/types.js'
import { isToolOutputReference, MAX_TOOL_OUTPUT_PAGE_CHARS } from '../util/tool-output.js'

function availableEvents(session: Session, options?: { throughSeq: number; userSeq: number }) {
  const snapshot = options ? session.events.filter(event => event.seq <= options.throughSeq) : session.events
  const nextUser = options && snapshot.find(event => event.type === 'user/message' && event.seq > options.userSeq &&
    !event.payload.from && (!event.payload.source || event.payload.source === 'user'))
  const events = snapshot.filter(event => !nextUser || event.seq < nextUser.seq || event.type === 'collaboration/message' &&
    (event.payload.userSeq ?? Infinity) <= options!.userSeq)
  let clear = -1
  for (const event of events) if (event.type === 'session/note' && event.payload.note === 'context-clear') clear = event.seq
  return events.filter(event => event.seq > clear)
}

function recordedOutput(session: Session, reference: string,
  options?: { throughSeq: number; userSeq: number }): string | undefined {
  for (const event of availableEvents(session, options)) {
    if (event.type === 'tool/result' && event.payload.modelPreview?.reference === reference) return event.payload.output
    if (event.type !== 'collaboration/message' || !isSessionId(event.payload.sourceSessionId)) continue
    const match = Object.entries(event.payload.toolPreviews ?? {}).find(([, preview]) => preview.reference === reference)
    if (!match) continue
    // The committed collaboration stores its own full copy, independent of the peer archive.
    const result = event.payload.messages.find(message => message.role === 'tool' && message.tool_call_id === match[0])
    if (result?.role === 'tool') return result.content
  }
  return undefined
}

export const toolOutputReadPlugin: PluginModule = {
  name: 'tool-output-read',
  description: 'Read recorded tool text by reference with bounded character pages',
  inject: ['tools', 'sessions'],
  apply(ctx, _config, toolsLike: unknown, sessionsLike: unknown) {
    const tools = toolsLike as ToolsService, sessions = sessionsLike as SessionService
    ctx.effect(() => tools.register({
      name: 'tool_output_read',
      description: 'Read the saved full text behind a tool preview. Uses its output_ reference, not a path. ' +
        'offset is 0-based and limit counts UTF-16 characters; max 12000 per page. This does not rerun the original tool.',
      kind: 'read',
      parameters: { type: 'object', additionalProperties: false, properties: {
        reference: { type: 'string', description: 'output_ reference shown in a tool text preview.' },
        offset: { type: 'integer', minimum: 0, description: '0-based character offset (default 0).' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_TOOL_OUTPUT_PAGE_CHARS, description: 'Characters to read (default 4000).' },
      }, required: ['reference'] },
      execute: async (args, tc: ToolContext) => {
        if (Object.keys(args).some(key => !['reference', 'offset', 'limit'].includes(key)) || !isToolOutputReference(args.reference)) {
          return { output: 'error: expected a local tool output reference; paths and session ids are not accepted', isError: true }
        }
        const offset = args.offset ?? 0, limit = args.limit ?? 4000
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_TOOL_OUTPUT_PAGE_CHARS) {
          return { output: 'error: offset must be a non-negative integer and limit must be 1–12000 characters', isError: true }
        }
        tc.signal.throwIfAborted()
        const current = await sessions.open(tc.sessionId)
        let output = recordedOutput(current, args.reference)
        if (output === undefined && tc.sharedContext && isSessionId(tc.sharedContext.sessionId)) {
          const shared = await sessions.open(tc.sharedContext.sessionId)
          output = recordedOutput(shared, args.reference, tc.sharedContext)
        }
        tc.signal.throwIfAborted()
        if (output === undefined) return { output: 'error: this reference is not available in the current session or its associated collaboration', isError: true }
        const start = Math.min(Number(offset), output.length), end = Math.min(output.length, start + Number(limit))
        const next = end < output.length ? `next offset ${end}` : 'end of recorded output'
        return { output: `[recorded tool text ${args.reference}; chars ${start}–${end} of ${output.length}; ${next}]\n\n` + output.slice(start, end) }
      },
    }))
  },
}
