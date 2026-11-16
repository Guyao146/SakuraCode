/** Offline diagnostics: only synthetic stdio children and loopback HTTP endpoints. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '../src/kernel/index.js'
import { ToolsService } from '../src/core/tools.js'
import { ConnectorsService, type ConnectorAdapter, type ConnectorConfig, type ConnectorSession } from '../src/connectors/index.js'
import { mcpConnectorAdapter } from '../src/connectors/mcp.js'
import { validateConnector } from '../src/connectors/validation.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const fixturePath = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url))
const base = { id: 'demo', name: 'Synthetic connector', category: 'software' as const, adapter: 'http', url: 'http://127.0.0.1:3000' }
const manifest = { version: 1, actions: [{ name: 'echo', description: 'Synthetic echo', parameters: { type: 'object' } }], knowledge: { search: true, read: true } }
const signal = () => new AbortController().signal
async function service() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-diagnostic-'))
  const ctx = new Context(), tools = new ToolsService(ctx), connectors = new ConnectorsService(ctx, tools, { cwd })
  connectors.registerAdapter(mcpConnectorAdapter)
  await connectors.reload()
  cleanups.push(async () => { connectors.dispose(); ctx.dispose(); await fs.rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) })
  return { connectors, tools, ctx, cwd }
}
async function remote(options: { mcp?: boolean; status?: number; malformed?: boolean; stall?: boolean; injected?: unknown } = {}) {
  const requests: string[] = [], auth: Array<string | undefined> = [], open = new Set<import('node:http').ServerResponse>()
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString(), body = text ? JSON.parse(text) : undefined
    const method = options.mcp ? body?.method : req.url
    requests.push(method); auth.push(req.headers.authorization)
    if (options.status) { res.writeHead(options.status, { location: 'http://127.0.0.1:1/never', 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'SECRET_ERROR_BODY_NOT_FOR_REPORT' })); return }
    res.setHeader('content-type', 'application/json')
    if (options.stall) { res.writeHead(200); res.write(' '); open.add(res); res.on('close', () => open.delete(res)); return }
    if (!options.mcp) { res.end(JSON.stringify(options.injected ?? (options.malformed ? { version: 9 } : manifest))); return }
    if (method === 'notifications/initialized') { res.writeHead(202); res.end(); return }
    const result = method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : options.malformed ? { tools: [{ name: 'bad', description: 'bad', inputSchema: { type: 'string' } }] }
        : { tools: [{ name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object' } }, { name: 'read', description: 'Synthetic read', inputSchema: { type: 'object' } }] }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body?.id, result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, auth, open }
}
function syntheticSession(close: () => void | Promise<unknown> = vi.fn()): ConnectorSession {
  return { capabilities: { version: 1, actions: [] }, call: vi.fn(async () => ({ output: 'unused' })), close: async () => { await close() } }
}

describe('connector templates and static preflight', () => {
  it('returns three disabled templates and never connects or fetches during preflight', async () => {
    const { connectors } = await service(), fetch = vi.spyOn(globalThis, 'fetch'), connect = vi.spyOn(mcpConnectorAdapter, 'connect')
    const templates = connectors.templates()
    expect(templates.map(row => row.id)).toEqual(['local-mcp', 'https-mcp', 'http-json-bridge'])
    for (const row of templates) {
      expect(row.config).toMatchObject({ autoConnect: false, enabledActions: [], knowledgeEnabled: false })
      connectors.preflight(row.config)
    }
    templates[0]!.config.command = 'changed'
    expect(connectors.templates()[0]!.config.command).toBe('')
    expect(connectors.preflight(connectors.templates()[0]!.config).issues[0]!.field).toBe('command')
    expect(fetch).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
  })
  it('reports missing credentials only as booleans and never returns reference names or values', async () => {
    const { connectors } = await service()
    vi.stubEnv('SYNTHETIC_PRESENT_REF', 'LONG_SYNTHETIC_CREDENTIAL')
    vi.stubEnv('SYNTHETIC_EMPTY_REF', '')
    const report = connectors.preflight({ ...base, headersEnv: { Authorization: 'SYNTHETIC_PRESENT_REF', 'X-Api-Key': 'SYNTHETIC_EMPTY_REF' } })
    expect(report.ok).toBe(false)
    expect(report.credentials).toEqual([{ field: 'headersEnv[0]', present: true }, { field: 'headersEnv[1]', present: false }])
    expect(report.issues).toContainEqual(expect.objectContaining({ field: 'headersEnv[1]', code: 'MISSING_CREDENTIAL' }))
    for (const forbidden of ['LONG_SYNTHETIC_CREDENTIAL', 'SYNTHETIC_PRESENT_REF', 'SYNTHETIC_EMPTY_REF', 'Authorization']) expect(JSON.stringify(report)).not.toContain(forbidden)
  })
  it('uses the shared validation for unsafe targets, installers, shell args and literal credentials', async () => {
    const { connectors } = await service()
    const local = { ...base, adapter: 'mcp', url: undefined, command: process.execPath, args: [fixturePath] }
    for (const [field, value] of [
      ['url', { ...base, url: 'http://external.invalid' }],
      ['url', { ...base, url: 'https://user:secret@example.invalid?token=secret' }],
      ['command', { ...local, command: 'cmd.exe' }],
      ['command', { ...local, command: 'npx' }],
      ['command', { ...local, command: 'mcp-server.cmd' }],
      ['args', { ...local, args: ['--token=literal-secret'] }],
      ['args', { ...local, args: ['-e', 'process.exit()'] }],
      ['args', { ...local, args: ['--eval=process.exit()'] }],
      ['args', { ...local, args: ['safe', 'x & execute'] }],
      ['timeoutMs', { ...base, timeoutMs: 1 }],
    ] as const) {
      expect(() => validateConnector(value)).toThrow()
      const report = connectors.preflight(value)
      expect(report.ok).toBe(false); expect(report.issues.some(row => row.field === field)).toBe(true)
      expect(JSON.stringify(report)).not.toContain('literal-secret')
    }
  })
  it('does not resolve missing credentials or invalid drafts by contacting the endpoint', async () => {
    const { connectors } = await service(), target = await remote(), fetch = vi.spyOn(globalThis, 'fetch')
    vi.stubEnv('SYNTHETIC_ABSENT', '')
    const report = await connectors.diagnose({ ...base, url: target.url, headersEnv: { Authorization: 'SYNTHETIC_ABSENT' } }, { signal: signal() })
    expect(report.ok).toBe(false); expect(target.requests).toEqual([]); expect(fetch).not.toHaveBeenCalled()
  })
})

describe('isolated connector diagnostic sessions', () => {
  it('reads bridge capabilities only and leaves the existing live instance and tools unchanged', async () => {
    const { connectors, tools } = await service(), target = await remote()
    const config = { ...base, url: target.url }
    await connectors.save(config, connectors.snapshot()); await connectors.connect('demo'); await connectors.enable('demo', ['echo'], true, connectors.snapshot())
    const before = connectors.snapshot(), tool = tools.get('connector__demo__echo'), register = vi.spyOn(tools, 'register')
    const report = await connectors.diagnose({ ...config, enabledActions: ['echo'], knowledgeEnabled: true }, { signal: signal() })
    expect(report.ok).toBe(true)
    expect(report.capabilities).toMatchObject({ actionCount: 1, knowledge: { search: true, read: true, queryTested: false } })
    expect(report.stages.find(row => row.stage === 'handshake')?.status).toBe('unknown')
    expect(target.requests).toEqual(['/capabilities', '/capabilities'])
    expect(connectors.snapshot()).toEqual(before); expect(tools.get('connector__demo__echo')).toBe(tool); expect(register).not.toHaveBeenCalled()
    expect(report.warnings.join(' ')).toContain('不曾测试知识查询结果')
  })
  it('runs a synthetic local MCP handshake without any tool registration or action calls', async () => {
    const { connectors, tools } = await service(), register = vi.spyOn(ToolsService.prototype, 'register')
    const report = await connectors.diagnose({ ...base, url: undefined, adapter: 'mcp', command: process.execPath, args: [fixturePath], knowledgeTools: { search: 'echo', read: 'fail' } }, { signal: signal() })
    expect(report.ok).toBe(true)
    expect(report.stages.every(row => row.status === 'success')).toBe(true)
    expect(report.capabilities).toMatchObject({ actionCount: 2, knowledge: { search: true, read: true, queryTested: false } })
    expect(register).not.toHaveBeenCalled(); expect(tools.names()).toEqual([])
  })
  it('does MCP initialize/tools-list only over loopback HTTP and uses explicit credentials', async () => {
    const { connectors } = await service(), target = await remote({ mcp: true })
    vi.stubEnv('SYNTHETIC_HEADER_REF', 'Bearer SYNTHETIC_TOKEN_ONLY')
    const report = await connectors.diagnose({ ...base, adapter: 'mcp', url: target.url, headersEnv: { Authorization: 'SYNTHETIC_HEADER_REF' } }, { signal: signal() })
    expect(report.ok).toBe(true)
    expect(target.requests).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
    expect(target.auth.every(value => value === 'Bearer SYNTHETIC_TOKEN_ONLY')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_TOKEN_ONLY')
  })
  it.each([false, true])('maps authentication, redirects and malformed manifests without raw data (MCP=%s)', async mcp => {
    const { connectors } = await service()
    for (const [options, expected] of [[{ status: 401 }, 'AUTH_REJECTED'], [{ status: 403 }, 'AUTH_REJECTED'], [{ status: 302 }, 'REDIRECT_BLOCKED'], [{ malformed: true }, 'INVALID_MANIFEST']] as const) {
      const target = await remote({ ...options, mcp }), report = await connectors.diagnose({ ...base, adapter: mcp ? 'mcp' : 'http', url: target.url }, { signal: signal() })
      expect(report.ok).toBe(false); expect(report.stages.some(row => row.code === expected)).toBe(true)
      expect(report.capabilities).toBeUndefined(); expect(JSON.stringify(report)).not.toContain('SECRET_ERROR_BODY_NOT_FOR_REPORT')
      expect(target.requests.filter(name => name?.includes('call') || name?.includes('search') || name?.includes('read'))).toEqual([])
    }
  })
  it('maps an actual missing executable without exposing executable paths or stderr', async () => {
    const { connectors, cwd } = await service()
    const report = await connectors.diagnose({ ...base, adapter: 'mcp', url: undefined, command: path.join(cwd, 'SENSITIVE_missing_program.exe') }, { signal: signal() })
    expect(report.ok).toBe(false); expect(report.stages.some(row => row.code === 'NO_EXECUTABLE')).toBe(true)
    expect(JSON.stringify(report)).not.toContain('SENSITIVE_missing_program'); expect(JSON.stringify(report)).not.toContain(cwd)
  })
  it('times out and aborts stalled response bodies, leaving no active fixture response', async () => {
    const { connectors } = await service()
    for (const abort of [false, true]) {
      const target = await remote({ stall: true }), controller = new AbortController()
      const pending = connectors.diagnose({ ...base, url: target.url, timeoutMs: abort ? 1000 : 100 }, { signal: controller.signal })
      if (abort) { await vi.waitFor(() => expect(target.open.size).toBe(1)); controller.abort('SENSITIVE_ABORT_REASON') }
      const report = await pending
      expect(report.ok).toBe(false); expect(report.stages.some(row => row.code === (abort ? 'CANCELLED' : 'TIMEOUT'))).toBe(true)
      await vi.waitFor(() => expect(target.open.size).toBe(0))
      expect(JSON.stringify(report)).not.toContain('SENSITIVE_ABORT_REASON')
    }
  })
  it('closes late sessions on timeout, cancel, epoch changes and disposal without invoking capabilities', async () => {
    for (const mode of ['timeout', 'abort', 'epoch', 'dispose'] as const) {
      const { connectors } = await service(), controller = new AbortController(), close = vi.fn(), late = syntheticSession(close)
      let finish!: (session: ConnectorSession) => void, started!: () => void, current = true
      const ready = new Promise<void>(resolve => { started = resolve })
      const adapter: ConnectorAdapter = { id: 'held', version: 1, description: 'fixture', connect: async () => { started(); return new Promise(resolve => { finish = resolve }) } }
      connectors.registerAdapter(adapter)
      const pending = connectors.diagnose({ ...base, adapter: 'held', timeoutMs: mode === 'timeout' ? 100 : 2000 }, { signal: controller.signal, assertCurrent: () => { if (!current) throw new Error('SECRET_EPOCH') } })
      await ready
      if (mode === 'abort') controller.abort(); if (mode === 'epoch') current = false; if (mode === 'dispose') connectors.dispose()
      const report = await pending
      expect(report.ok).toBe(false); expect(report.capabilities).toBeUndefined(); expect(JSON.stringify(report)).not.toContain('SECRET_EPOCH')
      finish(late); await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1)); expect(late.call).not.toHaveBeenCalled()
    }
  })
  it('does not guess a typed code from arbitrary errors, and bounds failed cleanup', async () => {
    const { connectors } = await service()
    connectors.registerAdapter({ id: 'unknown', version: 1, description: 'fixture', connect: async () => { throw new Error('ENOENT HTTP 401 timeout SECRET_RAW_ERROR') } })
    const failed = await connectors.diagnose({ ...base, adapter: 'unknown' }, { signal: signal() })
    const failedStage = failed.stages.find(row => row.status === 'failed')!
    expect(failedStage.code).toBeUndefined(); expect(JSON.stringify(failed)).not.toContain('SECRET_RAW_ERROR')
    connectors.registerAdapter({ id: 'badclose', version: 1, description: 'fixture', connect: async () => syntheticSession(() => new Promise(() => {})) })
    const started = Date.now(), report = await connectors.diagnose({ ...base, adapter: 'badclose' }, { signal: signal() })
    expect(Date.now() - started).toBeLessThan(1500); expect(report.warnings.some(row => row.includes('未在限定时间'))).toBe(true)
  })
  it('bounds exported reports and excludes arbitrary config and capability data, descriptions and schema keys', async () => {
    const { connectors } = await service()
    const injected = { ...manifest, actions: Array.from({ length: 128 }, (_, i) => ({ name: `PRIVATE_ACTION_${i}`, description: 'PRIVATE_DESCRIPTION'.repeat(100), parameters: { type: 'object', properties: { PRIVATE_SCHEMA_KEY: { type: 'string', default: 'PRIVATE_DATA' } } } })) }
    const target = await remote({ injected })
    const report = await connectors.diagnose({ ...base, url: target.url + '/PRIVATE_TARGET', name: 'PRIVATE_CONFIG_NAME' }, { signal: signal() })
    expect(report.ok).toBe(true); expect(report.capabilities?.actions).toHaveLength(20); expect(report.capabilities?.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThan(16_384)
    for (const value of ['PRIVATE_ACTION', 'PRIVATE_DESCRIPTION', 'PRIVATE_SCHEMA_KEY', 'PRIVATE_DATA', 'PRIVATE_CONFIG_NAME', 'PRIVATE_TARGET']) expect(JSON.stringify(report)).not.toContain(value)
  })
  it('rejects credential-echoing manifests and cleans up malformed adapter capabilities', async () => {
    const { connectors } = await service(), close = vi.fn()
    vi.stubEnv('SYNTHETIC_MANIFEST_REF', 'SYNTHETIC_ECHO_CREDENTIAL')
    const target = await remote({ injected: { ...manifest, actions: [{ ...manifest.actions[0], description: 'SYNTHETIC_ECHO_CREDENTIAL' }] } })
    const report = await connectors.diagnose({ ...base, url: target.url, headersEnv: { Authorization: 'SYNTHETIC_MANIFEST_REF' } }, { signal: signal() })
    expect(report.ok).toBe(false); expect(JSON.stringify(report)).not.toContain('SYNTHETIC_ECHO_CREDENTIAL')
    connectors.registerAdapter({ id: 'badmanifest', version: 1, description: 'fixture', connect: async () => ({ ...syntheticSession(close), capabilities: { version: 9 } as never }) })
    const invalid = await connectors.diagnose({ ...base, adapter: 'badmanifest' }, { signal: signal() })
    expect(invalid.ok).toBe(false); expect(close).toHaveBeenCalledTimes(1)
  })
  it('does not start a pre-cancelled or stale diagnostic, and rejects cancellation during cleanup', async () => {
    const { connectors } = await service(), controller = new AbortController(), connect = vi.fn(async () => syntheticSession())
    connectors.registerAdapter({ id: 'notstarted', version: 1, description: 'fixture', connect })
    controller.abort()
    expect((await connectors.diagnose({ ...base, adapter: 'notstarted' }, { signal: controller.signal })).ok).toBe(false)
    expect((await connectors.diagnose({ ...base, adapter: 'notstarted' }, { signal: signal(), assertCurrent: () => { throw new Error('stale') } })).ok).toBe(false)
    expect(connect).not.toHaveBeenCalled()
    const during = new AbortController()
    connectors.registerAdapter({ id: 'cancelclose', version: 1, description: 'fixture', connect: async () => syntheticSession(() => { during.abort(); }) })
    const report = await connectors.diagnose({ ...base, adapter: 'cancelclose' }, { signal: during.signal })
    expect(report.ok).toBe(false); expect(report.capabilities).toBeUndefined()
  })
  it('strictly rejects local MCP schema normalization and terminates a timed-out local handshake', async () => {
    const { connectors, cwd } = await service(), script = path.join(cwd, 'bad-schema.mjs')
    await fs.writeFile(script, `import readline from 'node:readline'; const rl=readline.createInterface({input:process.stdin}); rl.on('line',l=>{const m=JSON.parse(l); if(m.id===undefined)return; const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'bad',description:'PRIVATE_DESCRIPTION',inputSchema:{type:'string'}}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')}); rl.on('close',()=>process.exit(0));`)
    const local = { ...base, adapter: 'mcp', url: undefined, command: process.execPath, args: [script] }
    const bad = await connectors.diagnose(local, { signal: signal() })
    expect(bad.ok).toBe(false); expect(bad.stages.some(row => row.code === 'INVALID_MANIFEST')).toBe(true)
    const stall = path.join(cwd, 'stall.mjs'); await fs.writeFile(stall, 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));')
    const timed = await connectors.diagnose({ ...local, args: [stall], timeoutMs: 100 }, { signal: signal() })
    expect(timed.ok).toBe(false); expect(timed.stages.some(row => row.code === 'TIMEOUT')).toBe(true)
  })
  it('passes only explicit environment credentials to a child, and never passes model or extra environment', async () => {
    const { connectors, cwd } = await service()
    vi.stubEnv('SYNTHETIC_EXPLICIT_SECRET', 'SYNTHETIC_CHILD_SECRET')
    vi.stubEnv('SAKURA_API_KEY', 'MODEL_SECRET_NOT_ALLOWED')
    vi.stubEnv('SYNTHETIC_UNREFERENCED', 'UNREFERENCED_NOT_ALLOWED')
    const script = path.join(cwd, 'env-fixture.mjs')
    await fs.writeFile(script, `import readline from 'node:readline';
const good = process.env.APP_CREDENTIAL === 'SYNTHETIC_CHILD_SECRET' && !process.env.SAKURA_API_KEY && !process.env.SYNTHETIC_UNREFERENCED && !process.env.HOME && !process.env.USERPROFILE;
const rl = readline.createInterface({input: process.stdin});
rl.on('line', line => { const m=JSON.parse(line); if(m.id === undefined) return; const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:good?[]:[{name:'bad',inputSchema:{type:'string'}}]}; process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });
rl.on('close',()=>process.exit(0));`)
    const report = await connectors.diagnose({ ...base, adapter: 'mcp', url: undefined, command: process.execPath, args: [script], envRefs: { APP_CREDENTIAL: 'SYNTHETIC_EXPLICIT_SECRET' } }, { signal: signal() })
    expect(report.ok, JSON.stringify(report)).toBe(true); expect(report.capabilities?.actionCount).toBe(0)
    for (const secret of ['SYNTHETIC_CHILD_SECRET', 'MODEL_SECRET_NOT_ALLOWED', 'UNREFERENCED_NOT_ALLOWED']) expect(JSON.stringify(report)).not.toContain(secret)
  })
})
