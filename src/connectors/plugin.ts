/** Connector service is optional and does not auto-connect until composition finishes. */
import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { ConnectorsService } from './index.js'
import { mcpConnectorAdapter } from './mcp.js'
import type { ConnectorConfig } from './types.js'

export const connectorsPlugin: PluginModule<{ cwd?: string; connections?: ConnectorConfig[] }> = {
  name: 'core-connectors', description: 'Explicit external software / knowledge connectors with scoped capability controls', inject: ['tools'],
  async apply(ctx, config, toolsLike: unknown) {
    const service = new ConnectorsService(ctx, toolsLike as ToolsService, { cwd: config?.cwd ?? process.cwd(), connections: config?.connections })
    service.registerAdapter(mcpConnectorAdapter)
    ctx.provide('connectors'); ctx.set('connectors', service)
    ctx.effect(() => () => service.dispose())
    await service.reload()
    ctx.on('agent/pre-step', async (payload, next) => { if (payload.step === 0) await service.reload(); return next(payload) })
  },
}
