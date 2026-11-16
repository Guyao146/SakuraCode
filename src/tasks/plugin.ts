/** Optional workspace service; task contents stay out of general UI fan-out. */
import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { TasksService } from './service.js'

export const tasksPlugin: PluginModule<{ cwd?: string; dataCwd?: string }> = {
  name: 'core-tasks', description: 'Durable workspace tasks and validation evidence', inject: ['tools'],
  async apply(ctx, config, toolsLike: unknown) {
    const tasks = new TasksService(config?.cwd ?? process.cwd(), toolsLike as ToolsService, () => ctx.emit('tasks/changed', {}), config?.dataCwd)
    ctx.provide('tasks'); ctx.set('tasks', tasks)
    await tasks.initialize()
    ctx.effect(() => () => { void tasks.close() })
  },
}
