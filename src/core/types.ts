/**
 * Shared vocabulary for SakuraCode core: chat messages, tool schemas,
 * stream chunks and session events. Message shapes follow the
 * OpenAI-compatible wire format so adapters stay thin.
 */

// ---------------------------------------------------------------------------
// Chat vocabulary
// ---------------------------------------------------------------------------

export interface ToolCallId {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface SystemMessage {
  role: 'system'
  content: string
}

/** OpenAI-compatible content part; `image_url.url` is usually a data: URL. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }

export interface UserMessage {
  role: 'user'
  content: string | ContentPart[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCallId[]
}

export interface ToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export type JsonSchemaObject = {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

export interface ToolSchema {
  name: string
  description: string
  parameters: JsonSchemaObject
}

/** Capability class used by the approval gate. */
export type ToolKind = 'read' | 'write' | 'execute' | 'agent'

/** The original user turn whose file changes a delegation belongs to. */
export interface CheckpointTarget { sessionId: string; turnSeq: number }

export interface ToolContext {
  /** Session the calling agent is running in. */
  sessionId: string
  /** Agent that invoked the tool. */
  agentId: string
  signal: AbortSignal
  checkpoint?: CheckpointTarget
}

export interface ToolResult {
  output: string
  isError?: boolean
  /** Structured extras carried for UI rendering, never sent to the model. */
  ui?: Record<string, unknown>
  /**
   * Images (data URLs) produced by the tool, e.g. screenshots. Logged on the
   * tool/result event, rendered by UIs, and replayed to multimodal models as
   * a synthetic user message (only the most recent image set is kept).
   */
  images?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaObject
  kind: ToolKind
  execute(args: Record<string, unknown>, tc: ToolContext): Promise<ToolResult | string>
}

// ---------------------------------------------------------------------------
// Model adapter / streaming
// ---------------------------------------------------------------------------

export interface LLMRequest {
  model?: string
  messages: ChatMessage[]
  tools?: ToolSchema[]
  signal?: AbortSignal
  maxTokens?: number
  temperature?: number
  /** Reasoning effort ('off' is normalized away by adapters). */
  thinking?: ThinkingLevel
  /** Local-only retry routing; adapters never send these fields upstream. */
  retryContext?: { agentId?: string; sessionId?: string; main?: boolean; purpose?: string; interactive?: boolean }
}

/**
 * Token usage reported by the model for one streaming step. Every field is
 * optional — providers differ in what they report.
 */
export interface UsageStats {
  inputTokens?: number
  outputTokens?: number
  /** Tokens served from the provider's prompt cache (prefix/kv-cache hits). */
  cachedTokens?: number
  /** Reasoning tokens included in completion_tokens (thinking models). */
  reasoningTokens?: number
}

/** Request accounting, not a billing statement. Missing provider fields use the local heuristic. */
export interface TurnMetrics {
  startedAt: string
  endedAt: string
  elapsedMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  usageSource: 'reported' | 'estimated' | 'mixed'
  requests: number
  retries: number
  status: 'done' | 'error' | 'cancelled' | 'rejected'
  scope: 'agent' | 'team'
  members?: number
  failedMembers?: number
  cancelledMembers?: number
  legacy?: boolean
}

/** A committed expert step. Peer tool calls are evidence, never outstanding calls owed by the reader. */
export interface CollaborationRecord {
  key: string
  agentId: string
  agentName: string
  expert?: string
  sourceSessionId: string
  turnSeq: number
  userSeq?: number
  messages: ChatMessage[]
  metrics?: TurnMetrics
}

export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argsDelta?: string }
  | ({ type: 'usage' } & UsageStats)
  | { type: 'done'; reason: 'stop' | 'tool_calls' | 'length' | 'cancelled' }
  | { type: 'error'; error: string; retryable?: boolean; retryAfterMs?: number }
  | { type: 'reset'; error: string }

/** Reasoning effort requested from the model; 'off' sends nothing. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'

/** A model adapter registers itself on ctx.llm and streams via OpenAI-compatible chunks. */
export interface ModelAdapter {
  id: string
  defaultModel?: string
  models?: string[]
  stream(req: LLMRequest): AsyncIterable<StreamChunk>
}

// ---------------------------------------------------------------------------
// Session events — append-only log; "model-visible means logged"
// ---------------------------------------------------------------------------

/** Compact timed stream summary embedded in each assistant message. */
export interface StreamSummary {
  text: string
  /** Reasoning content streamed by thinking models (not replayed to the API). */
  thinking?: string
  toolCalls: ToolCallId[]
  usage?: UsageStats
  estimatedUsage?: { inputTokens: number; outputTokens: number }
  durationMs: number
}

export type SessionEventPayload =
  | { type: 'agent/meta'; payload: Record<string, unknown> }
  | { type: 'system/message'; payload: { content: string } }
  | { type: 'user/message'; payload: { content: string; originalText?: string; from?: string; source?: 'user' | 'agent' | 'expert-summary'; expertMode?: boolean; images?: string[]; attachments?: import('./attachments.js').ChatAttachment[] } }
  | { type: 'assistant/message'; payload: AssistantMessage & { stream: StreamSummary } }
  | { type: 'assistant/attempt'; payload: { error: string; stream?: StreamSummary; retry?: boolean } }
  | { type: 'tool/call'; payload: { id: string; name: string; arguments: string } }
  | {
      type: 'tool/result'
      payload: { id: string; name: string; output: string; isError?: boolean; durationMs: number; images?: string[] }
    }
  | { type: 'session/note'; payload: Record<string, unknown> }
  | { type: 'collaboration/message'; payload: CollaborationRecord }

export interface SessionEventRecordBase {
  seq: number
  time: string
}

export type SessionEventRecord = SessionEventRecordBase & SessionEventPayload
