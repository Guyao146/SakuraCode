/** Agents edit work descriptions and progress, never process evidence or human acceptance. */
import type { PluginModule } from '../kernel/index.js'
import { params, type ToolsService } from '../core/tools.js'
import type { TasksService } from '../tasks/service.js'

export const taskToolsPlugin: PluginModule = {
  name: 'tool-tasks', description: 'Read and maintain persistent workspace task cards', inject: ['tools', 'tasks'],
  apply(ctx, _config, toolsLike: unknown, tasksLike: unknown) {
    const tools = toolsLike as ToolsService, tasks = tasksLike as TasksService
    const disposers = [tools.register({
      name: 'task_read', kind: 'read',
      description: 'Read durable workspace task cards and their revision. Progress, command validation, and human acceptance are different states. Use task_write only after reading; saved commands are never executed by reading or writing a task.',
      parameters: params({ id: { type: 'string', description: 'Optional task ID; omit to list cards and saved check IDs.' } }),
      execute: async (args, tc) => {
        const saved = await tasks.snapshot(); tc.signal.throwIfAborted()
        if (args.id) {
          const task = saved.tasks.find(task => task.id === args.id)
          if (!task) return { output: 'error: task not found', isError: true }
          return { output: JSON.stringify({ task, revision: saved.revision, fingerprint: saved.fingerprint,
            reports: saved.runs.filter(run => run.taskId === task.id), warning: 'Historical verification is not proof that current source is unchanged.' }) }
        }
        return { output: JSON.stringify({ revision: saved.revision, fingerprint: saved.fingerprint,
          tasks: saved.tasks.map(({ id, title, status, priority, archived, checkIds, sessionId }) => ({ id, title, status, priority, archived, checkIds, sessionId })),
          checks: saved.checks.map(({ id, name, required }) => ({ id, name, required })) }) }
      },
    }), tools.register({
      name: 'task_write', kind: 'write',
      description: 'Create or replace a durable workspace task description/progress after task_read. Pass the latest revision/fingerprint and preserve existing fields. Card: {id? (omit for new),title,description,priority,status,steps:[{id,content,status}],criteria:string[],checkIds:string[],archived,sessionId?,userSeq?}. Status values are pending/in_progress/completed. Cannot edit verification evidence, commands or human acceptance, and never executes a command.',
      parameters: params({ task: { type: 'object' }, revision: { type: 'integer' }, fingerprint: { type: 'string' } }, ['task', 'revision', 'fingerprint']),
      execute: async (args, tc) => {
        const saved = await tasks.store.upsert(args.task, { revision: Number(args.revision), fingerprint: String(args.fingerprint) }, () => tc.signal.throwIfAborted())
        ctx.emit('tasks/changed', {})
        return { output: JSON.stringify({ revision: saved.revision, fingerprint: saved.fingerprint, tasks: saved.tasks.map(({ id, title, status }) => ({ id, title, status })) }) }
      },
    })]
    ctx.effect(() => () => disposers.forEach(dispose => dispose()))
  },
}
