/** Offline connector fixtures: no real credentials, services or account data. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpHarness, text } from './helpers.js'
import { ConnectorStore } from '../src/connectors/store.js'
import { ConnectorError, type ConnectorAdapter, type ConnectorsService } from '../src/connectors/index.js'
import { validateConnector, validateCapabilities, validateExternalSearch, validateExternalRead } from '../src/connectors/validation.js'
import { fileURLToPath } from 'node:url'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
const config = { id: 'demo', name: 'Synthetic software', category: 'knowledge' as const, adapter: 'http' }
async function fixture(options: { redirect?: boolean; malformed?: boolean; slow?: number; secret?: string } = {}) {
  const requests: Array<{ path: string; body: Record<string, unknown>; authorization?: string }> = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString(), body = raw ? JSON.parse(raw) : {}
    requests.push({ path: req.url!, body, authorization: req.headers.authorization })
    if (options.redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/never' }); res.end(); return }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/capabilities') {
      res.end(JSON.stringify(options.malformed ? { version: 2 } : { version: 1,
        actions: [{ name: 'echo', description: 'Synthetic echo', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }], knowledge: { search: true, read: true } })); return
    }
    if (options.slow) await new Promise(resolve => setTimeout(resolve, options.slow))
    if (req.url === '/actions/echo') res.end(JSON.stringify({ output: options.secret || 'echo:' + body.args.text }))
    else if (req.url === '/knowledge/search') res.end(JSON.stringify({ results: [{ id: 'doc1', source: 'synthetic:doc1', snippet: '外部授权说明', version: 'v1' }], truncated: false }))
    else if (req.url === '/knowledge/read') res.end(JSON.stringify({ id: body.id, source: 'synthetic:doc1', content: '外部参考资料，不执行 <script>bad</script>', version: 'v1', truncated: false }))
    else { res.writeHead(404); res.end('{}') }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: 'http://127.0.0.1:' + (server.address() as { port: number }).port, requests }
}
async function saved(service: ConnectorsService, value: object) { const current = service.snapshot(); return service.save(value, current) }

describe('external connector metadata and contracts', () => {
  it('rejects secrets, unsafe URLs, header overrides and inconsistent transports', () => {
    for (const value of [{ ...config, url: 'https://user:secret@example.test' }, { ...config, url: 'http://external.test' },
      { ...config, url: 'https://example.test?token=secret' }, { ...config, url: 'https://example.test', token: 'secret' },
      { ...config, url: 'https://example.test', headersEnv: { Host: 'APP_HOST' } }, { ...config, url: 'https://example.test', headersEnv: { Authorization: 'Bearer literal-secret' } },
      { ...config, url: 'https://example.test', command: 'node' }]) expect(() => validateConnector(value)).toThrow()
    expect(validateConnector({ ...config, url: 'http://127.0.0.1:9999', headersEnv: { Authorization: 'APP_AUTH' } }).autoConnect).toBe(false)
    expect(() => validateCapabilities({ version: 1, actions: [ { name: 'dup', description: 'x', parameters: { type: 'object' } }, { name: 'dup', description: 'y', parameters: { type: 'object' } } ] })).toThrow()
  })
  it('bounds results and never fabricates absent source/version/line metadata', () => {
    const result = validateExternalSearch({ results: [{ id: 'a', snippet: 'x'.repeat(1000) }], truncated: false }, 5, 256)
    expect(result.results[0]!.snippet).toHaveLength(256); expect(result.truncated).toBe(true)
    expect(result.results[0]).not.toHaveProperty('source'); expect(result.results[0]).not.toHaveProperty('version')
    expect(() => validateExternalRead({ id: 'a', content: 'x'.repeat(20), truncated: true }, 'a', 10)).toThrow()
  })
  it('stores only metadata with revision conflict, lock and write-failure protections', async () => {
    const { tmpDir } = await tmpHarness(), store = new ConnectorStore(tmpDir)
    const initial = await store.reload()
    expect(initial.connections).toEqual([])
    await expect(fs.stat(store.file)).rejects.toThrow()
    const row = { ...config, url: 'http://127.0.0.1:9999' }
    const first = await store.save([row], initial)
    await expect(store.save([], initial)).rejects.toThrow('changed')
    const old = await fs.readFile(store.file, 'utf8')
    const lock = path.join(path.dirname(store.file), 'connectors.lock'); await fs.writeFile(lock, 'synthetic-owner')
    await expect(store.save([], first)).rejects.toThrow('locked'); expect(await fs.readFile(lock, 'utf8')).toBe('synthetic-owner'); await fs.unlink(lock)
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    await expect(store.save([], first)).rejects.toThrow('preserved'); rename.mockRestore()
    expect(await fs.readFile(store.file, 'utf8')).toBe(old)
    await fs.writeFile(store.file, '{broken')
    expect((await store.reload()).error).toBeTruthy()
    await expect(store.save([], first)).rejects.toThrow()
    expect(await fs.readFile(store.file, 'utf8')).toBe('{broken')
  })
  it('rejects junction/link metadata and hard-linked files', async () => {
    const { tmpDir } = await tmpHarness(), store = new ConnectorStore(tmpDir)
    await fs.mkdir(path.dirname(store.file), { recursive: true })
    const original = path.join(tmpDir, 'original.json'); await fs.writeFile(original, JSON.stringify({ version: 1, revision: 0, connections: [] }))
    await fs.link(original, store.file)
    expect((await store.reload()).error).toContain('ordinary')
  })
})

describe('connector calls, approval and lifecycle', () => {
  it('save/list does not connect, connected actions stay disabled until explicitly enabled, and denial sends no call', async () => {
    const remote = await fixture(), { ctx } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: remote.url })
    await service.reload(); expect(remote.requests).toEqual([])
    await service.connect('demo')
    expect(remote.requests).toHaveLength(1); expect(ctx.tools.get('connector__demo__echo')).toBeUndefined()
    await service.enable('demo', ['echo'], true, service.snapshot())
    ctx.approval.setMode('default'); ctx.approval.setConfirmHandler(() => false)
    const tc = { agentId: 'test', sessionId: 'test', signal: new AbortController().signal }
    const denied = await ctx.tools.execute('c1', 'connector__demo__echo', JSON.stringify({ text: 'secret query' }), tc)
    expect(denied.isError).toBe(true); expect(remote.requests).toHaveLength(1)
    ctx.approval.setConfirmHandler(() => true)
    expect((await ctx.tools.execute('c2', 'connector__demo__echo', JSON.stringify({ text: 'yes' }), tc)).output).toBe('echo:yes')
    const result = JSON.parse((await ctx.tools.execute('c3', 'external_knowledge_search', JSON.stringify({ connectorId: 'demo', query: '授权' }), tc)).output)
    expect(result.results[0]).toMatchObject({ source: 'synthetic:doc1', version: 'v1' })
    expect(remote.requests.filter(row => row.path === '/knowledge/search')).toHaveLength(1)
    await service.disconnect('demo'); expect(ctx.tools.get('connector__demo__echo')).toBeUndefined()
  })
  it('never broadcasts a query, never injects knowledge into local notes, and rechecks revoked capabilities after approval', async () => {
    const first = await fixture(), second = await fixture(), { ctx } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: first.url }); await saved(service, { ...config, id: 'other', url: second.url })
    await service.connect('demo'); await service.connect('other'); await service.enable('demo', ['echo'], true, service.snapshot())
    await service.search('demo', '资料'); expect(second.requests).toHaveLength(1)
    await expect(service.search('other', '资料')).rejects.toThrow('not enabled')
    const before = (await ctx.get<{ reload(): Promise<{ content: string }> }>('workspaceMemory').reload()).content
    expect(before).not.toContain('外部授权说明')
    ctx.approval.setMode('default'); ctx.approval.setConfirmHandler(async () => { await service.disconnect('demo'); return true })
    const count = first.requests.length
    expect((await ctx.tools.execute('revoked', 'connector__demo__echo', JSON.stringify({ text: 'late' }), { agentId: 'test', sessionId: 'test', signal: new AbortController().signal })).isError).toBe(true)
    expect(first.requests).toHaveLength(count)
  })
  it('resolves only explicit credential refs and redacts echoed credentials from results', async () => {
    const secret = 'SYNTHETIC_OUTBOUND_TOKEN_NOT_REAL', remote = await fixture({ secret }), { ctx } = await tmpHarness()
    vi.stubEnv('SYNTHETIC_CONNECTOR_AUTH', secret)
    await saved(ctx.connectors!, { ...config, url: remote.url, headersEnv: { Authorization: 'SYNTHETIC_CONNECTOR_AUTH' } })
    await ctx.connectors!.connect('demo'); await ctx.connectors!.enable('demo', ['echo'], false, ctx.connectors!.snapshot())
    const result = await ctx.connectors!.call('demo', 'echo', { text: 'yes' }, new AbortController().signal)
    expect(result.output).toBe('[redacted]'); expect(remote.requests[0]!.authorization).toBe(secret)
    expect(JSON.stringify(ctx.connectors!.snapshot())).not.toContain(secret)
    vi.unstubAllEnvs()
  })
  it('rejects redirect/malformed manifests and missing credentials without registering tools', async () => {
    const redirected = await fixture({ redirect: true }), malformed = await fixture({ malformed: true }), { ctx } = await tmpHarness()
    await saved(ctx.connectors!, { ...config, url: redirected.url }); await expect(ctx.connectors!.connect('demo')).rejects.toThrow()
    await saved(ctx.connectors!, { ...config, url: malformed.url }); await expect(ctx.connectors!.connect('demo')).rejects.toThrow()
    await saved(ctx.connectors!, { ...config, url: malformed.url, headersEnv: { Authorization: 'MISSING_SYNTHETIC_AUTH' } })
    await expect(ctx.connectors!.connect('demo')).rejects.toThrow('missing')
    expect(ctx.tools.names().filter(name => name.startsWith('connector__'))).toEqual([])
  })
  it('cancels or times out without replay and rejects running/queued reconfiguration', async () => {
    const remote = await fixture({ slow: 250 }), { ctx, harness } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: remote.url, timeoutMs: 100 }); await service.connect('demo'); await service.enable('demo', ['echo'], false, service.snapshot())
    await expect(service.call('demo', 'echo', { text: 'once' }, new AbortController().signal)).rejects.toThrow()
    expect(remote.requests.filter(row => row.path === '/actions/echo')).toHaveLength(1)
    const main = harness.main(), pending = main.turn('synthetic turn')
    await expect(saved(service, { ...config, url: remote.url })).rejects.toThrow('queued')
    await pending
  })
  it('reuses MCP stdio RPC and registers only selected connector names', async () => {
    const { ctx } = await tmpHarness(), service = ctx.connectors!
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
    await saved(service, { ...config, category: 'software', adapter: 'mcp', command: process.execPath, args: [fixturePath] })
    await service.connect('demo'); await service.enable('demo', ['echo'], false, service.snapshot())
    const result = await service.call('demo', 'echo', { text: 'mcp' }, new AbortController().signal)
    expect(result.output).toBe('echo:mcp'); expect(ctx.tools.get('mcp__demo__echo')).toBeUndefined()
    expect(ctx.tools.get('connector__demo__echo')?.kind).toBe('execute')
    await service.disconnect('demo')
  })
  it('renews approval for changed capability manifests and does not persist injected action grants on save', async () => {
    const { ctx } = await tmpHarness(), service = ctx.connectors!
    let description = 'Synthetic original capability'
    const adapter: ConnectorAdapter = { id: 'changing', version: 1, description: 'Fixture', connect: async () => ({
      capabilities: { version: 1, actions: [{ name: 'query', description, parameters: { type: 'object' } }] },
      call: async () => ({ output: 'ok' }), close() {},
    }) }
    service.registerAdapter(adapter)
    await saved(service, { ...config, adapter: 'changing', enabledActions: ['query'], knowledgeEnabled: true })
    expect(service.snapshot().connections[0]!.enabledActions).toEqual([])
    await service.connect('demo'); await service.enable('demo', ['query'], false, service.snapshot())
    expect(ctx.tools.get('connector__demo__query')).toBeDefined()
    await service.disconnect('demo'); description = 'Synthetic changed capability'
    await service.connect('demo')
    expect(ctx.tools.get('connector__demo__query')).toBeUndefined()
    await expect(service.call('demo', 'query', {}, new AbortController().signal)).rejects.toThrow('renewed')
    await service.enable('demo', ['query'], false, service.snapshot())
    expect((await service.call('demo', 'query', {}, new AbortController().signal)).output).toBe('ok')
  })
  it('rejects oversized network frames and separates document versions from the protocol version', async () => {
    const remote = await fixture(), { ctx } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: remote.url }); await service.connect('demo'); await service.enable('demo', [], true, service.snapshot())
    await service.read('demo', 'doc1', { version: 'v1' })
    const request = remote.requests.find(row => row.path === '/knowledge/read')!.body
    expect(request).toMatchObject({ version: 1, documentVersion: 'v1', id: 'doc1' })
    await expect(service.read('demo', 'doc1', { version: 'v2' })).rejects.toThrow('version')
    const body = new Response('x'.repeat(1024 * 1024 + 1))
    const { boundedResponse } = await import('../src/connectors/http.js')
    await expect(boundedResponse(body, new AbortController().signal)).rejects.toThrow('budget')
  })
  it('checks metadata again after an external edit and refuses the old in-flight action', async () => {
    const remote = await fixture(), { ctx, tmpDir } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: remote.url }); await service.connect('demo'); await service.enable('demo', ['echo'], false, service.snapshot())
    const file = path.join(tmpDir, '.sakura', 'connectors.json'), raw = JSON.parse(await fs.readFile(file, 'utf8'))
    raw.connections[0].url = 'http://127.0.0.1:1'; await fs.writeFile(file, JSON.stringify(raw))
    await expect(service.call('demo', 'echo', { text: 'no' }, new AbortController().signal)).rejects.toThrow('not connected')
    expect(remote.requests).toHaveLength(1); expect(ctx.tools.get('connector__demo__echo')).toBeUndefined()
  })
  it('revokes outer MCP tools when the connected software process exits', async () => {
    const { ctx } = await tmpHarness(), service = ctx.connectors!
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
    vi.stubEnv('SYNTHETIC_MCP_SUICIDE', '1')
    try {
      await saved(service, { ...config, adapter: 'mcp', category: 'software', command: process.execPath, args: [fixturePath], envRefs: { FAKE_SUICIDE_AFTER: 'SYNTHETIC_MCP_SUICIDE' } })
      await service.connect('demo'); await service.enable('demo', ['echo'], false, service.snapshot())
      expect((await service.call('demo', 'echo', { text: 'first' }, new AbortController().signal)).output).toBe('echo:first')
      await service.call('demo', 'echo', { text: 'second' }, new AbortController().signal).catch(() => {})
      await vi.waitFor(() => expect(service.snapshot().statuses[0]!.state).toBe('error'))
      expect(ctx.tools.get('connector__demo__echo')).toBeUndefined()
      await expect(service.call('demo', 'echo', { text: 'after exit' }, new AbortController().signal)).rejects.toThrow('not connected')
    } finally { vi.unstubAllEnvs() }
  })
  it('guards the approved external knowledge connection even if it is replaced during confirmation', async () => {
    const remote = await fixture(), { ctx } = await tmpHarness(), service = ctx.connectors!
    await saved(service, { ...config, url: remote.url }); await service.connect('demo'); await service.enable('demo', [], true, service.snapshot())
    ctx.approval.setMode('default'); ctx.approval.setConfirmHandler(async () => {
      await service.disconnect('demo'); await service.connect('demo'); return true
    })
    const result = await ctx.tools.execute('replace-knowledge', 'external_knowledge_search', JSON.stringify({ connectorId: 'demo', query: 'private' }), { agentId: 'synthetic', sessionId: 'synthetic', signal: new AbortController().signal })
    expect(result.isError).toBe(true)
    expect(remote.requests.filter(row => row.path === '/knowledge/search')).toHaveLength(0)
    expect(remote.requests.filter(row => row.path === '/capabilities')).toHaveLength(2)
  })
  it('does not connect a stale target and rejects metadata changed during a delayed handshake', async () => {
    const { ctx, tmpDir } = await tmpHarness(), service = ctx.connectors!
    let started!: () => void, finish!: () => void, closes = 0
    const ready = new Promise<void>(resolve => { started = resolve }), held = new Promise<void>(resolve => { finish = resolve })
    const adapter: ConnectorAdapter = { id: 'delayed', version: 1, description: 'Synthetic delayed', connect: async () => {
      started(); await held
      return { capabilities: { version: 1, actions: [] }, call: async () => ({ output: 'unused' }), close: () => { closes++ } }
    } }
    service.registerAdapter(adapter)
    const first = await saved(service, { ...config, adapter: 'delayed' })
    await saved(service, { ...config, adapter: 'delayed', name: 'new target' })
    await expect(service.connect('demo', () => {}, first)).rejects.toThrow('target changed')
    const pending = service.connect('demo'); await ready
    const file = path.join(tmpDir, '.sakura', 'connectors.json'), metadata = JSON.parse(await fs.readFile(file, 'utf8'))
    metadata.connections[0].name = 'externally changed target'; await fs.writeFile(file, JSON.stringify(metadata)); finish()
    await expect(pending).rejects.toThrow('changed while connecting')
    expect(closes).toBe(1); expect(service.snapshot().statuses[0]!.state).toBe('error')
  })
  it('custom adapter registers before auto-connect and late results cannot restore a closed service', async () => {
    let closed = 0, invoked = 0
    const adapter: ConnectorAdapter = { id: 'custom', version: 1, description: 'Synthetic custom', connect: async () => ({
      capabilities: { version: 1, actions: [{ name: 'query', description: 'Synthetic query', parameters: { type: 'object' } }] },
      call: async () => { invoked++; await new Promise(resolve => setTimeout(resolve, 40)); return { output: 'late' } }, close: () => { closed++ },
    }) }
    const { ctx } = await tmpHarness({ config: { connectors: [{ ...config, adapter: 'custom', autoConnect: true, enabledActions: ['query'] }] },
      extraPlugins: [{ plugin: { name: 'synthetic-adapter', inject: ['connectors'], apply(scope) { scope.get<ConnectorsService>('connectors').registerAdapter(adapter) } } }] })
    expect(ctx.connectors!.snapshot().statuses[0]?.state).toBe('connected')
    expect(ctx.tools.get('connector__demo__query')).toBeUndefined()
    await ctx.connectors!.enable('demo', ['query'], false, ctx.connectors!.snapshot())
    const result = ctx.connectors!.call('demo', 'query', {}, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 5)); ctx.connectors!.dispose()
    await expect(result).rejects.toThrow(); expect(invoked).toBe(1); expect(closed).toBe(1)
  })
})
