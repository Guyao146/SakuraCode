/**
 * tool-plugin-manager — plugin_manager: inspect the mounted plugin set.
 * The registry service is filled in by the bootstrap as it mounts plugins.
 */

import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'

export interface PluginRegistryEntry {
  name: string
  description?: string
  source: 'builtin' | 'external'
}

export class PluginRegistry {
  readonly entries: PluginRegistryEntry[] = []
  add(entry: PluginRegistryEntry): void {
    this.entries.push(entry)
  }
  list(): PluginRegistryEntry[] {
    return [...this.entries]
  }
}

export const pluginRegistryPlugin: PluginModule = {
  name: 'core-plugin-registry',
  description: 'Tracks mounted plugins for inspection (ctx.plugins)',
  apply(ctx) {
    ctx.provide('plugins')
    ctx.set('plugins', new PluginRegistry())
  },
}

export const pluginManagerToolPlugin: PluginModule = {
  name: 'tool-plugin-manager',
  description: 'plugin_manager — list mounted plugins',
  inject: ['tools', 'plugins'],
  apply(_ctx, _config, toolsLike: unknown, registryLike: unknown) {
    const tools = toolsLike as ToolsService
    const registry = registryLike as PluginRegistry

    tools.register({
      name: 'plugin_manager',
      description: 'Inspect the harness plugin set: every mounted plugin is listed with its source.',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list'], description: 'Only "list" is supported in v0.' },
        },
      },
      execute: async () => {
        const entries = registry.list()
        const out = entries.length
          ? entries.map((e) => `${e.name.padEnd(24)} ${e.source.padEnd(8)} ${e.description ?? ''}`).join('\n')
          : '(no plugins recorded)'
        return { output: `mounted plugins (${entries.length}):\n${out}` }
      },
    })
  },
}
