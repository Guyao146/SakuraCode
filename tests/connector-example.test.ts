/** Example bridge is always loopback-only and serves synthetic text, never project or account data. */
import { describe, expect, it } from 'vitest'
import { httpConnectorAdapter } from '../src/connectors/http.js'
import type { ConnectorSession } from '../src/connectors/types.js'
// The example is runtime JavaScript so it also runs without the build toolchain.
const exampleModule = '../scripts/example-connector-bridge.mjs'

describe('synthetic connector v1 example', () => {
  it('runs an actual software action, finds a source and reassembles versioned reference pages', async () => {
    const { startExampleBridge } = await import(exampleModule) as { startExampleBridge(): Promise<{ url: string; close(): Promise<void> }> }
    const bridge = await startExampleBridge(), controller = new AbortController()
    let session: ConnectorSession | undefined
    try {
      session = await httpConnectorAdapter.connect({ id: 'sample', name: 'Sample', adapter: 'http', category: 'knowledge', url: bridge.url }, { cwd: process.cwd(), signal: controller.signal })
      expect((await session.call('status', {}, controller.signal)).output).toContain('Synthetic software')
      const search = await session.search!('示例', { limit: 5, maxChars: 6000 }, controller.signal)
      expect(search.results[0]).toMatchObject({ id: 'guide', source: 'synthetic:guide' })
      const version = search.results[0]!.version!
      let cursor: string | undefined, content = ''
      for (let page = 0; page < 30; page++) {
        const result = await session.read!('guide', { cursor, version, maxChars: 10 }, controller.signal)
        expect(result.version).toBe(version); expect(result.content.length).toBeLessThanOrEqual(10)
        content += result.content; cursor = result.cursor
        if (!cursor) break
      }
      expect(content).toContain('不代表已连接真实第三方服务。')
      await expect(session.read!('guide', { version: 'invalid', maxChars: 100 }, controller.signal)).rejects.toThrow('409')
    } finally { await session?.close(); controller.abort(); await bridge.close() }
  })
})
