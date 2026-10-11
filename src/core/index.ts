/** Barrel of core services. */

export { Session, SessionService, sessionPlugin, type SessionMeta } from './session.js'
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
} from './agent.js'
export { HarnessContext } from './context.js'
export type {
  ChatMessage,
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
