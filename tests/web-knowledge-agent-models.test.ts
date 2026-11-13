import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHandle, LLMRequest, ModelAdapter } from '../src/core/index.js'
import { runWebServer, type WebServerOptions } from '../src/web/server.js'
import { text } from './helpers.js'

const DEFAULT_ADAPTER = 'offline-default'
const OTHER_ADAPTER = 'offline-reasoner'
const DEFAULT_MODEL = 'default-offline'
const SHARED_MODEL = 'shared-offline'
const OPERATOR_TOKEN = 'offline-test-operator-token-not-a-real-credential-0001'
const VIEWER_TOKEN = 'offline-test-viewer-token-not-a-real-credential-0002'
const nativeFetch = globalThis.fetch
const cleanups: Array<() => Promise<void>> = []
let blockedFetches: string[] = []

interface CatalogRow {
  adapter: string
  model: string
  default: boolean
  reasoning?: boolean
}

interface AgentView {
  id: string
  name: string
  role: string
  status: string
  model: string
  modelAdapter?: string
  modelBusy?: boolean
  expert?: string
}

interface ModelReply {
  agent: AgentView
  catalog: CatalogRow[]
  catalogFingerprint: string
  recommendation: { adapter?: string; model?: string; [key: string]: unknown }
}

interface KnowledgeDocument {
  id: string
  name: string
  source: string
  version: string
  lines: number
}

interface KnowledgeListing {
  documents: KnowledgeDocument[]
  revision: number
  errors: unknown[]
}

interface KnowledgePage {
  id: string
  source: string
  version: string
  startLine: number
  endLine: number
  totalLines: number
  content: string
  truncated: boolean
  nextOffset?: number
  nextCharOffset?: number
}

interface MemorySnapshot {
  enabled: boolean
  injectionMode: 'full' | 'on-demand'
  content: string
  revision: number
  fingerprint: string
  processing: { auto: boolean }
}

interface ExpertModels {
  catalog: CatalogRow[]
  catalogFingerprint: string
  experts: Array<{
    key: string
    name: string
    existingId?: string
    recommendation: ModelReply['recommendation']
  }>
}

interface CapturedRequest {
  provider: string
  model: LLMRequest['model']
  prompt: string
  request: LLMRequest
}

/** Every provider declares its own registered catalog, including an ambiguous model name. */
function multiMockModelAdapter() {
  const specs = [
    { id: DEFAULT_ADAPTER, defaultModel: DEFAULT_MODEL, models: [DEFAULT_MODEL, SHARED_MODEL, 'fast-offline'], reasoning: false },
    { id: OTHER_ADAPTER, defaultModel: 'reasoner-offline', models: ['reasoner-offline', SHARED_MODEL], reasoning: true },
  ]
  const requests: CapturedRequest[] = []
  const pending: Array<{ promise: Promise<void>; release: () => void }> = []
  const held = new Set<{ promise: Promise<void>; release: () => void }>()
  const adapters: ModelAdapter[] = specs.map(spec => ({
    id: spec.id,
    defaultModel: spec.defaultModel,
    models: spec.models,
    modelInfo: () => ({ reasoning: spec.reasoning }),
    async *stream(request: LLMRequest) {
      requests.push({ provider: spec.id, model: request.model, prompt: JSON.stringify(request.messages), request })
      const gate = pending.shift()
      if (gate) {
        try { await gate.promise } finally { held.delete(gate) }
      }
      yield* text('offline REST reply')
    },
  }))
  return {
    adapters,
    specs,
    requests,
    holdNext() {
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      const gate = { promise, release }
      pending.push(gate)
      held.add(gate)
      return release
    },
    releaseAll() {
      for (const gate of held) gate.release()
      held.clear()
    },
  }
}

beforeEach(() => {
  blockedFetches = []
  // No inherited real credentials or provider URLs are used by these servers.
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SAKURA_API_KEY']) vi.stubEnv(name, 'offline-test-key-not-a-credential')
  vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'http://127.0.0.1:1')
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  const loopbackFetch: typeof fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(raw)
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      blockedFetches.push(raw)
      throw new Error(`Non-loopback network request prohibited in offline REST tests: ${raw}`)
    }
    // Prevent even an allowed loopback URL from redirecting to a real network.
    return nativeFetch(input, { ...init, redirect: 'error' })
  }
  vi.stubGlobal('fetch', loopbackFetch)
})

afterEach(async () => {
  try {
    while (cleanups.length) await cleanups.pop()!()
    expect(blockedFetches, 'no background task may attempt a real network request').toEqual([])
  } finally {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  }
})

async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const until = Date.now() + 8_000
  while (!predicate()) {
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`)
    await delay(10)
  }
}

async function tmpWorkspace(options: Partial<WebServerOptions> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-web-knowledge-models-'))
  cleanups.push(() => fs.rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))
  const mock = multiMockModelAdapter()
  const config: NonNullable<WebServerOptions['config']> = {
    ...options.config,
    plugins: {
      ...options.config?.plugins,
      'core-compaction': { config: { auto: 0, autoTokens: 0 } },
      'core-skills': { disabled: true },
      'core-agent-defs': { disabled: true },
    },
  }
  const web = await runWebServer({
    ...options,
    cwd,
    config,
    adapter: mock.adapters[0]!,
    host: options.host ?? '127.0.0.1',
    token: options.token ?? OPERATOR_TOKEN,
    viewerToken: options.viewerToken ?? null,
    port: 0,
    model: DEFAULT_MODEL,
    approvalMode: 'yolo',
    maxSteps: 1,
    open: false,
    quiet: true,
    updatesAutoCheck: false,
  })
  cleanups.push(async () => { mock.releaseAll(); await web.close() })
  web.harness.ctx.llm.replaceAdapters(mock.adapters[0]!)
  web.harness.ctx.llm.register(mock.adapters[1]!)
  web.harness.ctx.llm.prepareConfiguration({ model: DEFAULT_MODEL }).commit()
  const base = `http://127.0.0.1:${web.port}`
  async function rest<T = { error: string }>(route: string, body?: unknown, token = options.token ?? OPERATOR_TOKEN) {
    const response = await fetch(base + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    return { status: response.status, body: await response.json() as T }
  }
  // Keep memory mounted, but disable its automatic model-based processing before any turn.
  const memory = web.harness.ctx.get<{
    reload(): Promise<MemorySnapshot>
    update(patch: unknown, revision: number): Promise<unknown>
  }>('workspaceMemory')
  const saved = await memory.reload()
  await memory.update({ processing: { auto: false, thresholdChars: 8_000, intervalMs: 1_800_000 } }, saved.revision)
  expect(mock.requests).toHaveLength(0)
  async function main(): Promise<AgentHandle> {
    const state = await rest<{ agents: AgentView[] }>('/api/state')
    expect(state.status, JSON.stringify(state.body)).toBe(200)
    const main = state.body.agents.find(agent => agent.role === 'main')!
    return web.harness.ctx.agents.get(main.id)!
  }
  async function turns(count: number) {
    await eventually(() => mock.requests.length >= count && web.harness.ctx.agents.list().every(agent => !web.harness.ctx.agents.isBusy(agent.id)), `${count} offline turns to settle`)
    expect(mock.requests).toHaveLength(count)
  }
  return { cwd, web, mock, rest, main, turns }
}

function choice(catalogFingerprint: string, model = SHARED_MODEL, adapter = OTHER_ADAPTER) {
  return { adapter, model, catalogFingerprint, confirmed: true }
}

function query(route: string, params: Record<string, string | number>) {
  return route + '?' + new URLSearchParams(Object.entries(params).map(([key, value]): [string, string] => [key, String(value)]))
}

async function knowledgeReference(fixture: Awaited<ReturnType<typeof tmpWorkspace>>, id: string) {
  const mentions = await fixture.rest<{ candidates: Array<{ kind: string; id: string; token: string }> }>('/api/mentions')
  expect(mentions.status).toBe(200)
  const candidate = mentions.body.candidates.find(row => row.kind === 'knowledge' && row.id === id)
  expect(candidate, 'imported document is an explicit knowledge mention candidate').toBeDefined()
  return candidate!.token
}

describe('offline web knowledge, memory and per-agent model REST integration', () => {
  it('reads registered recommendations without model calls or handle changes and requires a complete confirmed selection', async () => {
    const f = await tmpWorkspace()
    const main = await f.main()
    const before = { model: main.model, adapter: main.modelAdapter, selected: f.web.harness.ctx.llm.selectedModel() }
    const route = `/api/agents/${main.id}/model`
    const result = await f.rest<ModelReply>(route)
    expect(result.status).toBe(200)
    expect(result.body.catalog.map(row => `${row.adapter}:${row.model}`).sort()).toEqual(
      f.mock.specs.flatMap(spec => spec.models.map(model => `${spec.id}:${model}`)).sort(),
    )
    expect(result.body.catalogFingerprint).toMatch(/^[a-f0-9]{64}$/)
    const valid = choice(result.body.catalogFingerprint)
    for (const invalid of [
      { ...valid, confirmed: undefined },
      { ...valid, confirmed: false },
      { ...valid, adapter: undefined },
      { ...valid, model: undefined },
      { ...valid, adapter: 'unregistered-provider' },
      { ...valid, model: 'unregistered-model' },
      { ...valid, adapter: DEFAULT_ADAPTER, model: 'reasoner-offline' },
    ]) {
      const rejected = await f.rest(route, invalid)
      expect(rejected.status, JSON.stringify({ invalid, result: rejected.body })).toBe(400)
    }
    const missingVersion = await f.rest(route, { ...valid, catalogFingerprint: undefined })
    expect(missingVersion.status).toBe(409)
    expect({ model: main.model, adapter: main.modelAdapter, selected: f.web.harness.ctx.llm.selectedModel() }).toEqual(before)
    expect(f.mock.requests).toHaveLength(0)
  })

  it('rejects a changed catalog and preserves the main pin across state refreshes without changing global selection or provider routing', async () => {
    const f = await tmpWorkspace()
    const main = await f.main()
    const route = `/api/agents/${main.id}/model`
    const before = { model: main.model, adapter: main.modelAdapter, selected: f.web.harness.ctx.llm.selectedModel(), provider: f.web.harness.ctx.llm.modelStatus().adapter }
    const original = await f.rest<ModelReply>(route)
    f.mock.specs[1]!.models.push('registered-after-recommendation')
    const stale = await f.rest(route, choice(original.body.catalogFingerprint))
    expect(stale.status, JSON.stringify(stale.body)).toBe(409)
    expect(main.model).toBe(before.model)
    expect(main.modelAdapter).toBe(before.adapter)
    const refreshed = await f.rest<ModelReply>(route)
    expect(refreshed.body.catalogFingerprint).not.toBe(original.body.catalogFingerprint)
    expect(refreshed.body.catalog).toContainEqual(expect.objectContaining({ adapter: OTHER_ADAPTER, model: 'registered-after-recommendation' }))
    const pinned = await f.rest<{ agent: AgentView }>(route, choice(refreshed.body.catalogFingerprint))
    expect(pinned.status, JSON.stringify(pinned.body)).toBe(200)
    for (let refresh = 0; refresh < 4; refresh++) {
      const state = await f.rest<{ agents: AgentView[] }>('/api/state')
      expect(state.status).toBe(200)
      expect(state.body.agents.find(agent => agent.id === main.id)).toMatchObject({ model: SHARED_MODEL, modelAdapter: OTHER_ADAPTER, modelBusy: false })
    }
    expect(f.web.harness.ctx.llm.selectedModel()).toBe(before.selected)
    expect(f.web.harness.ctx.llm.modelStatus().adapter).toBe(before.provider)
    expect(f.mock.requests).toHaveLength(0)
    expect((await f.rest('/api/message', { text: 'Verify the explicitly pinned offline provider.' })).status).toBe(202)
    await f.turns(1)
    expect(f.mock.requests[0]).toMatchObject({ provider: OTHER_ADAPTER, model: SHARED_MODEL })
    expect(main.modelAdapter).toBe(OTHER_ADAPTER)
    expect(f.web.harness.ctx.llm.selectedModel()).toBe(before.selected)
  })

  it('rejects model changes for running and queued work but allows an idle agent while another agent is busy', async () => {
    const f = await tmpWorkspace()
    const main = await f.main()
    const globalSelection = f.web.harness.ctx.llm.selectedModel()
    const mainRoute = `/api/agents/${main.id}/model`
    const recommended = await f.rest<ModelReply>(mainRoute)
    const release = f.mock.holdNext()
    try {
      expect((await f.rest('/api/message', { text: 'Hold the first offline turn.' })).status).toBe(202)
      await eventually(() => f.mock.requests.length === 1, 'the held main request')
      expect((await f.rest(mainRoute, choice(recommended.body.catalogFingerprint))).status).toBe(409)
      const queued = await f.rest<{ queued: boolean }>('/api/message', { text: 'Queue a second offline turn.' })
      expect(queued.status).toBe(202)
      expect(queued.body.queued).toBe(true)
      expect((await f.rest(mainRoute, choice(recommended.body.catalogFingerprint))).status).toBe(409)
      const created = await f.rest<{ agent: AgentView }>('/api/agents', { name: 'idle-offline-peer' })
      expect(created.status).toBe(200)
      const idle = created.body.agent
      const idleRoute = `/api/agents/${idle.id}/model`
      const idleModels = await f.rest<ModelReply>(idleRoute)
      const changed = await f.rest<{ agent: AgentView }>(idleRoute, choice(idleModels.body.catalogFingerprint))
      expect(changed.status, JSON.stringify(changed.body)).toBe(200)
      expect(changed.body.agent).toMatchObject({ model: SHARED_MODEL, modelAdapter: OTHER_ADAPTER, modelBusy: false })
      expect(f.web.harness.ctx.agents.isBusy(main.id)).toBe(true)
      expect((await f.rest(`/api/agents/${idle.id}/message`, { text: 'Use the idle peer pin.' })).status).toBe(202)
      await eventually(() => f.mock.requests.length === 2 && !f.web.harness.ctx.agents.isBusy(idle.id), 'the independently pinned peer turn')
      expect(f.mock.requests[1]).toMatchObject({ provider: OTHER_ADAPTER, model: SHARED_MODEL })
      expect(f.web.harness.ctx.llm.selectedModel()).toBe(globalSelection)
    } finally { release() }
    await f.turns(3)
    expect(f.mock.requests.filter(request => request.provider === DEFAULT_ADAPTER).map(request => request.model)).toEqual([DEFAULT_MODEL, DEFAULT_MODEL])
    expect(main.model).toBe(DEFAULT_MODEL)
    expect(f.web.harness.ctx.llm.selectedModel()).toBe(globalSelection)
  })

  it('imports, lists, searches and reads bounded knowledge pages with character offsets, stale versions and invalid-path guards', async () => {
    const f = await tmpWorkspace()
    const firstLine = '0123456789 orchidneedle 离线知识第一页'
    const imported = await f.rest<KnowledgeListing>('/api/knowledge/import', { files: [
      { path: 'guides/offline.md', content: firstLine + '\nSecond bounded line.\nThird line.' },
      { path: 'other.txt', content: 'An unrelated offline document.' },
    ] })
    expect(imported.status, JSON.stringify(imported.body)).toBe(200)
    const listed = await f.rest<KnowledgeListing>('/api/knowledge')
    expect(listed.status).toBe(200)
    expect(listed.body.errors).toEqual([])
    expect(listed.body.documents).toHaveLength(2)
    const document = listed.body.documents.find(row => row.lines === 3)!
    expect(document).toBeDefined()
    const searched = await f.rest<{ results: Array<{ documentId: string; snippet: string; version: string }> }>(query('/api/knowledge/search', { q: 'orchidneedle', limit: 2, maxChars: 1_000 }))
    expect(searched.status, JSON.stringify(searched.body)).toBe(200)
    expect(searched.body.results).toContainEqual(expect.objectContaining({ documentId: document.id, version: document.version, snippet: expect.stringContaining('orchidneedle') }))
    const page = await f.rest<KnowledgePage>(query('/api/knowledge/read', { id: document.id, version: document.version, offset: 1, charOffset: 6, limit: 1 }))
    expect(page.status, JSON.stringify(page.body)).toBe(200)
    expect(page.body).toMatchObject({ id: document.id, version: document.version, startLine: 1, endLine: 1, totalLines: 3 })
    expect(page.body.content).toContain(firstLine.slice(6))
    expect(page.body.content).not.toContain('012345')
    expect(page.body.content).not.toContain('Second bounded line.')
    await fs.writeFile(path.join(f.cwd, document.source), 'Changed orchidneedle version outside the knowledge cache.', 'utf8')
    const staleRead = await f.rest(query('/api/knowledge/read', { id: document.id, version: document.version }))
    expect(staleRead.status, JSON.stringify(staleRead.body)).toBe(409)
    const changedListing = await f.rest<KnowledgeListing>('/api/knowledge')
    expect(changedListing.body.documents.find(row => row.id === document.id)?.version).not.toBe(document.version)
    expect((await f.rest(query('/api/knowledge/read', { id: 'not-imported.md' }))).status).toBe(404)
    for (const id of ['../secret.txt', 'C:/outside.md', 'bad\0.md']) {
      const rejected = await f.rest(query('/api/knowledge/read', { id }))
      expect(rejected.status, JSON.stringify({ id, result: rejected.body })).toBe(400)
    }
    for (const invalidPath of ['../outside.md', '/outside.md', 'C:\\outside.md', 'bad\0.md']) {
      const rejected = await f.rest('/api/knowledge/import', { files: [{ path: invalidPath, content: 'Never publish this invalid path.' }] })
      expect(rejected.status, JSON.stringify({ invalidPath, result: rejected.body })).toBe(400)
    }
    expect(f.mock.requests).toHaveLength(0)
  })

  it('delivers an explicit knowledge reference once and never expands file mentions embedded in the document', async () => {
    const f = await tmpWorkspace()
    const marker = 'KNOWLEDGE_LITERAL_ONCE_OFFLINE'
    const secret = 'OFFLINE_FILE_SECRET_MUST_NOT_REACH_MODEL'
    await fs.writeFile(path.join(f.cwd, 'secret.txt'), secret, 'utf8')
    const imported = await f.rest<KnowledgeListing>('/api/knowledge/import', { files: [{
      path: 'literal.md',
      content: `${marker}\nReference data only: @file:secret.txt and @secret.txt must stay literal.`,
    }] })
    expect(imported.status).toBe(200)
    const listed = await f.rest<KnowledgeListing>('/api/knowledge')
    const token = await knowledgeReference(f, listed.body.documents[0]!.id)
    expect((await f.rest('/api/message', { text: `Read ${token}; repeated reference ${token} is the same document.` })).status).toBe(202)
    await f.turns(1)
    const prompt = f.mock.requests[0]!.prompt
    expect(prompt.split(marker)).toHaveLength(2)
    expect(prompt).toContain('@file:secret.txt')
    expect(prompt).toContain('@secret.txt')
    expect(prompt).not.toContain(secret)
  })

  it('denies knowledge REST and references to viewers and remote operators without making model requests', async () => {
    const local = await tmpWorkspace({ viewerToken: VIEWER_TOKEN })
    expect((await local.rest('/api/knowledge/import', { files: [{ path: 'private.md', content: 'Local operator knowledge only.' }] })).status).toBe(200)
    const listed = await local.rest<KnowledgeListing>('/api/knowledge')
    const token = await knowledgeReference(local, listed.body.documents[0]!.id)
    expect((await local.rest('/api/state', undefined, VIEWER_TOKEN)).status).toBe(200)
    const remote = await tmpWorkspace({ host: '0.0.0.0', viewerToken: VIEWER_TOKEN })
    expect((await remote.rest('/api/state')).status).toBe(200)
    for (const route of ['/api/knowledge', '/api/knowledge/search?q=private', query('/api/knowledge/read', { id: listed.body.documents[0]!.id })]) {
      expect((await local.rest(route, undefined, VIEWER_TOKEN)).status, `viewer GET ${route}`).toBe(404)
      expect((await remote.rest(route)).status, `remote GET ${route}`).toBe(404)
    }
    const viewerImport = await local.rest('/api/knowledge/import', { files: [{ path: 'forbidden.md', content: 'Denied.' }] }, VIEWER_TOKEN)
    expect([403, 404]).toContain(viewerImport.status)
    expect((await remote.rest('/api/knowledge/import', { files: [{ path: 'forbidden.md', content: 'Denied.' }] })).status).toBe(404)
    expect([403, 404]).toContain((await local.rest('/api/message', { text: token }, VIEWER_TOKEN)).status)
    expect((await remote.rest('/api/message', { text: token })).status).toBe(404)
    expect(local.mock.requests).toHaveLength(0)
    expect(remote.mock.requests).toHaveLength(0)
  })

  it('persists on-demand memory without automatic injection and refuses search when memory is disabled', async () => {
    const f = await tmpWorkspace()
    const marker = 'ON_DEMAND_MEMORY_CONTENT_OFFLINE'
    const original = await f.rest<MemorySnapshot>('/api/workspace/memory')
    expect(original.status).toBe(200)
    const changed = await f.rest<MemorySnapshot>('/api/workspace/memory', {
      revision: original.body.revision,
      fingerprint: original.body.fingerprint,
      enabled: true,
      injectionMode: 'on-demand',
      content: marker + '\nRemember the memoryorchidneedle preference.',
    })
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
    const read = await f.rest<MemorySnapshot>('/api/workspace/memory')
    expect(read.body).toMatchObject({ enabled: true, injectionMode: 'on-demand', processing: { auto: false } })
    expect(read.body.content).toContain(marker)
    const searched = await f.rest<{ results: Array<{ snippet: string }> }>('/api/workspace/memory/search?q=memoryorchidneedle')
    expect(searched.status, JSON.stringify(searched.body)).toBe(200)
    expect(searched.body.results.length).toBeGreaterThan(0)
    expect((await f.rest('/api/message', { text: 'A plain offline turn without a memory reference.' })).status).toBe(202)
    await f.turns(1)
    expect(f.mock.requests[0]!.prompt).not.toContain(marker)
    const current = await f.rest<MemorySnapshot>('/api/workspace/memory')
    const disabled = await f.rest<MemorySnapshot>('/api/workspace/memory', { revision: current.body.revision, fingerprint: current.body.fingerprint, enabled: false })
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200)
    const reread = await f.rest<MemorySnapshot>('/api/workspace/memory')
    expect(reread.body).toMatchObject({ enabled: false, injectionMode: 'on-demand' })
    expect(reread.body.content).toContain(marker)
    expect((await f.rest('/api/workspace/memory/search?q=memoryorchidneedle')).status).toBe(409)
    expect(f.mock.requests).toHaveLength(1)
  })

  it('safely falls back from invalid expert preferences, explicitly confirms models and reuses experts without overwriting their pin', async () => {
    const f = await tmpWorkspace({ config: { agentModels: { roleModels: {
      architect: { adapter: 'unregistered-provider', model: 'unregistered-preferred-model' },
      implementer: { adapter: 'unregistered-provider', model: 'unregistered-preferred-model' },
      reviewer: { adapter: 'unregistered-provider', model: 'unregistered-preferred-model' },
    } } } })
    await f.main()
    const globalSelection = f.web.harness.ctx.llm.selectedModel()
    const models = await f.rest<ExpertModels>('/api/experts/models')
    expect(models.status, JSON.stringify(models.body)).toBe(200)
    expect(models.body.experts.length).toBeGreaterThan(0)
    expect(f.mock.requests).toHaveLength(0)
    const preset = models.body.experts[0]!
    const start = {
      experts: [preset.key],
      models: { [preset.key]: { adapter: OTHER_ADAPTER, model: SHARED_MODEL } },
      catalogFingerprint: models.body.catalogFingerprint,
      confirmedModels: true,
    }
    expect((await f.rest('/api/experts/start', { ...start, confirmedModels: false })).status).toBe(409)
    expect((await f.rest('/api/experts/start', { ...start, catalogFingerprint: 'stale-catalog' })).status).toBe(409)
    expect(f.web.harness.ctx.agents.list().filter(agent => agent.meta.expert)).toHaveLength(0)
    const fallbackPreset = models.body.experts[1]!
    const fallback = await f.rest('/api/experts/start', { experts: [fallbackPreset.key] })
    expect(fallback.status, JSON.stringify(fallback.body)).toBe(200)
    const fallbackExpert = f.web.harness.ctx.agents.list().find(agent => agent.meta.expert === fallbackPreset.key)!
    // Recommendations are advisory: an unconfirmed start may keep the legacy default-following handle.
    expect(fallbackExpert.model).not.toBe('unregistered-preferred-model')
    expect(fallbackExpert.modelAdapter).not.toBe('unregistered-provider')
    expect(f.mock.requests).toHaveLength(0)
    expect((await f.rest('/api/experts/stop', {})).status).toBe(200)
    const started = await f.rest<{ started: string[]; reused: string[] }>('/api/experts/start', { ...start, task: 'Confirm offline expert provider routing.' })
    expect(started.status, JSON.stringify(started.body)).toBe(200)
    expect(started.body.started).toEqual([preset.name])
    await f.turns(2)
    expect(f.mock.requests.map(request => `${request.provider}:${request.model}`).sort()).toEqual([
      `${DEFAULT_ADAPTER}:${DEFAULT_MODEL}`, `${OTHER_ADAPTER}:${SHARED_MODEL}`,
    ].sort())
    const expert = f.web.harness.ctx.agents.list().find(agent => agent.meta.expert === preset.key)!
    const expertModels = await f.rest<ModelReply>(`/api/agents/${expert.id}/model`)
    expect((await f.rest(`/api/agents/${expert.id}/model`, choice(expertModels.body.catalogFingerprint, 'fast-offline', DEFAULT_ADAPTER))).status).toBe(200)
    expect((await f.rest('/api/experts/stop', {})).status).toBe(200)
    const reused = await f.rest<{ started: string[]; reused: string[] }>('/api/experts/start', start)
    expect(reused.status, JSON.stringify(reused.body)).toBe(200)
    expect(reused.body.started).toEqual([])
    expect(reused.body.reused).toEqual([preset.name])
    expect(expert).toMatchObject({ model: 'fast-offline', modelAdapter: DEFAULT_ADAPTER })
    const refreshed = await f.rest<ExpertModels>('/api/experts/models')
    expect(refreshed.body.experts.find(row => row.key === preset.key)?.existingId).toBe(expert.id)
    expect(f.web.harness.ctx.llm.selectedModel()).toBe(globalSelection)
    expect(f.mock.requests).toHaveLength(2)
  })
})
