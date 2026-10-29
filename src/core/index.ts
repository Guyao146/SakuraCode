/** Barrel of core services. */

export { Session, SessionService, sessionPlugin, type SessionMeta } from './session.js'
export { CheckpointService, CheckpointError, checkpointsPlugin, type CheckpointPlan } from './checkpoints.js'
export { ConversationHistoryService, messageText, type HistoryMode, type HistoryPreview } from './conversation-history.js'
export { LLMService, OpenAICompatAdapter, llmPlugin, type OpenAICompatOptions } from './llm.js'
export { ToolsService, toolsPlugin, params, type ToolsExecutePayload } from './tools.js'
export { SystemPromptService, systemPromptPlugin, type PromptSection } from './system-prompt.js'
export {
  ApprovalService,
  approvalPlugin,
  APPROVAL_MODES,
  type ApprovalMode,
  type ApprovalRequest,
  type ConfirmHandler,
} from './approval.js'
export { JobsService, jobsPlugin, type JobRecord, type JobSummary } from './jobs.js'
export {
  resolveShell,
  resetShellCache,
  describeShell,
  missingShellMessage,
  killProcessTree,
  shellSpawnDetached,
  SHELL_ENV,
  type ResolvedShell,
  type ShellKind,
  type ShellSource,
} from './shell.js'
export {
  AgentsService,
  DefaultAgentLoop,
  agentPlugin,
  toolPolicyFilter,
  CancellationError,
  type AgentCreateOptions,
  type AgentHandle,
  type AgentLoop,
  type AgentMeta,
  type AgentRuntime,
  type AgentStatus,
  type ToolPolicy,
  type TurnResult,
  type TurnOptions,
} from './agent.js'
export { CHAT_FILE_LIMITS, parseChatFiles, storeChatFiles, ChatAttachmentError, type ChatAttachment, type ChatUploadFile } from './attachments.js'
export { HarnessContext } from './context.js'
export { RetryService, RetryLimitError, retryPlugin, type RetryRequest, type RetryStatus, type RetryConfirmHandler } from './retry.js'
export { DEFAULT_RETRY_POLICY, validateRetryPolicy, LLMRequestError, type RetryPolicy } from '../util/retry.js'
export type {
  ChatMessage,
  CheckpointTarget,
  JsonSchemaObject,
  LLMRequest,
  ModelAdapter,
  StreamChunk,
  StreamSummary,
  SessionEventPayload,
  SessionEventRecord,
  SystemMessage,
  ToolCallId,
  ToolContext,
  ToolDefinition,
  ToolKind,
  ToolMessage,
  ToolSchema,
  UserMessage,
  AssistantMessage,
} from './types.js'
