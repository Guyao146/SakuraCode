/** Durable work progress is separate from command evidence and human acceptance. */
import type { ShellKind } from '../core/shell.js'
import type { CommandExecution } from '../core/types.js'

export const TASK_LIMITS = Object.freeze({ tasks: 128, checks: 32, taskChecks: 12, runs: 128,
  bytes: 8 * 1024 * 1024, logChars: 32_000, steps: 64, criteria: 32 })
export type TaskStatus = 'pending' | 'in_progress' | 'completed'
export interface TaskRevision { revision: number; fingerprint: string }
export interface TaskStep { id: string; content: string; status: TaskStatus }
export interface TaskCheck {
  id: string
  name: string
  shell: ShellKind
  command: string
  workdir: string
  timeoutMs: number
  required: boolean
}
export interface TaskCard {
  id: string
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
  status: TaskStatus
  steps: TaskStep[]
  criteria: string[]
  checkIds: string[]
  archived: boolean
  sessionId?: string
  userSeq?: number
  createdAt: string
  updatedAt: string
  definitionHash: string
  acceptance?: { at: string; definitionHash: string; runId?: string; note: string }
}
export interface TaskCodeState {
  repository: string
  head: string | null
  fingerprint: string
  scope: string
}
export type CheckStatus = 'not_run' | 'awaiting_approval' | 'running' | 'passed' | 'failed' | 'interrupted' | 'denied' | 'skipped'
export type RunStatus = 'awaiting_approval' | 'running' | 'passed' | 'failed' | 'interrupted' | 'denied'
export interface TaskCheckResult extends TaskCheck {
  callId: string
  status: CheckStatus
  exitCode: number | null
  execution?: CommandExecution
  output: string
  truncated: boolean
  note?: string
}
export interface TaskRun {
  id: string
  taskId: string
  sessionId?: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  definitionHash: string
  checksHash: string
  code?: TaskCodeState
  codeNote?: string
  results: TaskCheckResult[]
  error?: string
}
export type TaskRunSummary = Omit<TaskRun, 'results'> & { checks: Array<Pick<TaskCheckResult, 'id' | 'name' | 'required' | 'status' | 'exitCode'>> }
export interface TaskState { version: 1; revision: number; tasks: TaskCard[]; checks: TaskCheck[]; runs: TaskRun[];
  active?: { owner: string; pid: number; runId: string } }
export interface TaskSnapshot extends TaskRevision {
  tasks: TaskCard[]
  checks: TaskCheck[]
  runs: TaskRunSummary[]
}
export class TaskError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'TaskError' }
}
