/**
 * tool-todo — todo_write: full-replacement task list the model uses to plan
 * and track multi-step work. State lives with the plugin; the CLI renders it
 * via the ui/todos event.
 */

import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface Todo {
  content: string
  status: TodoStatus
  priority: 'high' | 'medium' | 'low'
}

export class TodoStore {
  todos: Todo[] = []
}

export function renderTodos(todos: Todo[]): string {
  if (!todos.length) return '(empty todo list)'
  const marks: Record<TodoStatus, string> = { pending: '□', in_progress: '◐', completed: '☑' }
  return todos.map((t) => `${marks[t.status]} ${t.content} [${t.priority}]`).join('\n')
}

export const todoToolsPlugin: PluginModule = {
  name: 'tool-todo',
  description: 'todo_write — full-replacement task list',
  inject: ['tools'],
  apply(ctx, _config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const store = new TodoStore()
    ctx.provide('todos')
    ctx.set('todos', store)

    tools.register({
      name: 'todo_write',
      description:
        'Replace the task list with a new one. Use it to plan multi-step work and keep at most ' +
        'one task in_progress at a time. Items: { content, status: pending|in_progress|completed, priority: high|medium|low }.',
      kind: 'read', // planning aid, not a mutation of the user's filesystem
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete new task list (previous list is discarded).',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
      execute: async (args) => {
        const items = Array.isArray(args.todos) ? args.todos : []
        const todos: Todo[] = items.map((raw) => {
          const item = raw as Record<string, unknown>
          return {
            content: String(item.content ?? ''),
            status: (['pending', 'in_progress', 'completed'].includes(String(item.status))
              ? String(item.status)
              : 'pending') as TodoStatus,
            priority: (['high', 'medium', 'low'].includes(String(item.priority)) ? String(item.priority) : 'medium') as Todo['priority'],
          }
        })
        store.todos = todos
        ctx.emit('ui/todos', { todos })
        return { output: `todo list updated (${todos.length} item(s)):\n${renderTodos(todos)}` }
      },
    })
  },
}
