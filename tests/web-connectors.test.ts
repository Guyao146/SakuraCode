/** Offline REST acceptance for explicit external connectors; never real services or credentials. */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { runWebServer } from '../src/web/server.js'
import { MockAdapter, text } from './helpers.js'
import type { ConnectorSnapshot, ExternalKnowledgeSearch } from '../src/connectors/types.js'

interface ConnectorReply extends ConnectorSnapshot { adapters: Array<{ id: string }>; workspaceId: string }
const reply = async (response: Response): Promise<ConnectorReply> => await response.json() as ConnectorReply
const searchReply = async (response: Response): Promise<ExternalKnowledgeSearch> => await response.json() as ExternalKnowledgeSearch

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
async function fixture() {
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    requests.push(req.url!)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/capabilities' ? { version: 1, actions: [{ name: 'echo', description: 'Synthetic echo', parameters: { type: 'object' } }], knowledge: { search: true, read: true } } :
      req.url === '/knowledge/search' ? { results: [{ id: 'doc1', snippet: 'Synthetic outside knowledge', source: 'external:doc1' }], truncated: false } :
      req.url === '/knowledge/read' ? { id: body.id, content: 'Synthetic outside document', source: 'external:doc1', truncated: false } : { output: 'synthetic result' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return { requests, url: 'http://127.0.0.1:' + (server.address() as { port: number }).port }
}
async function web(options: { remote?: boolean; token?: string; viewerToken?: string } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-connectors-web-'))
  const server = await runWebServer({ cwd, adapter: new MockAdapter([text('offline')]), open: false, quiet: true,
    approvalMode: 'yolo', updatesAutoCheck: false, ...(options.remote ? { host: '0.0.0.0' } : {}), token: options.token ?? null, viewerToken: options.viewerToken ?? null,
    config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
  cleanups.push(async () => { await server.close(); await fs.rm(cwd, { recursive: true, force: true }).catch(() => {}) })
  const headers: Record<string, string> = options.token ? { authorization: 'Bearer ' + options.token } : {}
  const get = (route: string) => fetch(server.url + route, { headers })
  const post = (route: string, body: unknown, authorization = options.token) => fetch(server.url + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization: 'Bearer ' + authorization } : {}) }, body: JSON.stringify(body) })
  return { server, cwd, get, post }
}

describe('local connector REST management', () => {
  it('saves without network, confirms connection/enable, searches only on explicit consent, then disconnects/removes', async () => {
    const remote = await fixture(), app = await web()
    const initial = await reply(await app.get('api/connectors'))
    expect(initial.connections).toEqual([]); expect(initial.adapters.map((row: { id: string }) => row.id)).toEqual(['http', 'mcp'])
    const connection = { id: 'demo', name: 'Synthetic outside', category: 'knowledge', adapter: 'http', url: remote.url }
    expect((await app.post('api/connectors', { connection, revision: initial.revision, fingerprint: initial.fingerprint })).status).toBe(400)
    const saved = await reply(await app.post('api/connectors', { connection, revision: initial.revision, fingerprint: initial.fingerprint, confirmed: true }))
    expect(remote.requests).toEqual([])
    expect((await app.post('api/connectors/demo/connect', {})).status).toBe(400)
    const connected = await reply(await app.post('api/connectors/demo/connect', { confirmed: true, revision: saved.revision, fingerprint: saved.fingerprint }))
    expect(connected.statuses[0].state).toBe('connected'); expect(remote.requests).toEqual(['/capabilities'])
    const enabled = await reply(await app.post('api/connectors/demo/capabilities', { confirmed: true, enabledActions: ['echo'], knowledgeEnabled: true,
      revision: connected.revision, fingerprint: connected.fingerprint, capabilitiesFingerprint: connected.statuses[0]!.capabilitiesFingerprint }))
    expect(enabled.connections[0].enabledActions).toEqual(['echo'])
    expect((await app.post('api/connectors/knowledge/search', { connectorId: 'demo', query: 'outside' })).status).toBe(400)
    const result = await searchReply(await app.post('api/connectors/knowledge/search', { confirmed: true, connectorId: 'demo', query: 'outside' }))
    expect(result.results[0]).toMatchObject({ id: 'doc1', source: 'external:doc1' })
    expect(result.results[0]).not.toHaveProperty('version')
    expect((await app.post('api/connectors/demo/disconnect', { confirmed: true })).status).toBe(200)
    expect(app.server.harness.ctx.tools.get('connector__demo__echo')).toBeUndefined()
    expect((await app.post('api/connectors/demo/remove', { confirmed: true, revision: enabled.revision, fingerprint: enabled.fingerprint })).status).toBe(200)
    expect((await reply(await app.get('api/connectors'))).connections).toEqual([])
  })
  it('refuses stale saves and old workspace markers without changing connector metadata or models', async () => {
    const remote = await fixture(), app = await web(), initial = await reply(await app.get('api/connectors'))
    const main = app.server.harness.main(), original = main.model
    const body = { connection: { id: 'demo', name: 'outside', category: 'software', adapter: 'http', url: remote.url }, confirmed: true, revision: initial.revision, fingerprint: initial.fingerprint }
    expect((await app.post('api/connectors', body)).status).toBe(200)
    expect((await app.post('api/connectors', body)).status).toBe(409)
    const response = await fetch(app.server.url + 'api/connectors/demo/connect', { method: 'POST', headers: { 'content-type': 'application/json', 'x-sakura-workspace': 'stale-workspace' }, body: JSON.stringify({ confirmed: true }) })
    expect(response.status).toBe(409); expect(remote.requests).toEqual([]); expect(main.model).toBe(original)
  })
  it('denies remote operators and viewers without exposing endpoint metadata', async () => {
    const token = 'SYNTHETIC_CONNECTOR_OPERATOR_012345678901', viewerToken = 'SYNTHETIC_CONNECTOR_VIEWER_012345678901'
    const remote = await web({ remote: true, token, viewerToken })
    expect((await remote.get('api/connectors')).status).toBe(404)
    expect((await remote.post('api/connectors', { confirmed: true })).status).toBe(404)
    const local = await web({ token, viewerToken })
    const response = await fetch(local.server.url + 'api/connectors', { headers: { authorization: 'Bearer ' + viewerToken } })
    expect(response.status).toBe(404)
    expect((await local.post('api/connectors/demo/connect', { confirmed: true }, viewerToken)).status).toBe(403)
  })
})
