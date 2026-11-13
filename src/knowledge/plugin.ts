/** Mount the workspace-local reference store without placing its contents in the system prompt. */
import type { PluginModule } from '../kernel/index.js'
import { KnowledgeStore } from './index.js'

export const knowledgePlugin: PluginModule<{ cwd?: string }> = {
  name: 'core-knowledge',
  description: 'Offline workspace text reference library and lexical retrieval',
  apply(ctx, config) {
    ctx.provide('knowledge')
    ctx.set('knowledge', new KnowledgeStore(config?.cwd ?? process.cwd()))
  },
}
