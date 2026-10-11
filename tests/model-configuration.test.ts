import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type DesktopSettingsState, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { Context } from '../src/kernel/index.js'
import { LLMService, OpenAICompatAdapter } from '../src/core/llm.js'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllEnvs()
})

async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-config-transaction-'))
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }))
  return dir
}

async function provider() {
  const requests: Array<{ authorization?: string; model: string; path: string; body: Record<string, unknown> }> = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      requests.push({ authorization: req.headers.authorization, model: String(body.model), path: req.url ?? '', body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'verified locally' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}/v1`, requests }
}

async function workspace(url: string, key?: string) {
  const dir = await directory()
  await fs.writeFile(path.join(dir, 'sakura.yml'), JSON.stringify({
    pluginsDir: 'no-plugins',
    plugins: {
      'core-llm': { config: { baseURL: url, model: 'baseline-model', ...(key !== undefined ? { apiKey: key } : {}) } },
      'core-compaction': { config: { auto: 0, autoTokens: 0 } },
    },
  }))
  return dir
}

async function desktop(cwd: string, extra: Partial<WebServerOptions> = {}) {
  const config = JSON.parse(await fs.readFile(path.join(cwd, 'sakura.yml'), 'utf8'))
  const persisted: DesktopSettingsState[] = []
  const handle = await runWebServer({ cwd, config, quiet: true, open: false, token: null, viewerToken: null,
    onPersistSettings: state => { persisted.push(state) }, ...extra })
  cleanups.push(() => handle.close())
  const patch = (body: unknown) => fetch(handle.url + 'api/desktop/settings', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
  })
  return { handle, patch, persisted }
}

async function state(handle: WebServerHandle) {
  return await (await fetch(handle.url + 'api/state')).json() as {
    cwd: string; desktop: DesktopSettingsState; modelStatus: { configured: boolean; adapter: string; model: string; baseURL: string }
  }
}

async function turn(handle: WebServerHandle) {
  const result = await handle.harness.run('verify the active provider')
  expect(result.error).toBeUndefined()
  expect(result.output).toContain('verified locally')
}

describe('desktop model configuration transactions', () => {
  it('keeps the old workspace, routing and saved fields after a combined invalid workspace patch', async () => {
    const old = await provider()
    const next = await provider()
    const cwd = await workspace(old.url, 'old-test-key')
    const { handle, patch, persisted } = await desktop(cwd)
    const before = await state(handle)
    const original = handle.harness
    const response = await patch({ workspace: path.join(cwd, 'missing'), model: 'bad-new-model', baseURL: next.url, apiKey: 'new-test-key', rememberKey: true })
    expect(response.status).toBe(400)
    expect(await state(handle)).toEqual(before)
    expect(handle.harness).toBe(original)
    expect(persisted).toEqual([])
    await turn(handle)
    expect(old.requests.at(-1)?.authorization).toBe('Bearer old-test-key')
    expect(next.requests).toHaveLength(0)
  })

  it('keeps credentials when omitted, replaces them on the wire, and clears them through a remount', async () => {
    vi.stubEnv('SAKURA_API_KEY', 'environment-test-key')
    const old = await provider()
    const next = await provider()
    const cwd = await workspace(old.url)
    const other = await workspace(next.url)
    const { handle, patch } = await desktop(cwd)
    expect((await patch({ baseURL: next.url })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)?.authorization).toBe('Bearer environment-test-key')
    expect((await patch({ model: 'baseline-model', apiKey: 'replacement-test-key', rememberKey: true })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)?.authorization).toBe('Bearer replacement-test-key')
    expect((await patch({ rememberKey: false })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)?.authorization).toBe('Bearer replacement-test-key')
    expect((await patch({ apiKey: '' })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)?.authorization).toBeUndefined()
    expect((await patch({ workspace: other })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)?.authorization).toBeUndefined()
    const after = await state(handle)
    expect(after.desktop.hasApiKey).toBe(false)
    expect(JSON.stringify(after)).not.toContain('replacement-test-key')
  })

  it('restores the workspace model and URL rather than reusing the last desktop override', async () => {
    const old = await provider()
    const next = await provider()
    const cwd = await workspace(old.url, 'baseline-key')
    const { handle, patch } = await desktop(cwd, { model: 'launch-model', baseURL: next.url })
    await turn(handle)
    expect(next.requests.at(-1)?.model).toBe('launch-model')
    expect((await patch({ model: '', baseURL: '' })).status).toBe(200)
    await turn(handle)
    expect(old.requests.at(-1)?.model).toBe('baseline-model')
    expect(old.requests.at(-1)?.authorization).toBe('Bearer baseline-key')
    expect((await state(handle)).desktop).toMatchObject({ model: '', baseURL: '' })
  })

  it('rolls back both live routing and desktop fields when persistence rejects', async () => {
    const old = await provider()
    const next = await provider()
    const cwd = await workspace(old.url, 'old-test-key')
    const { handle, patch } = await desktop(cwd, { onPersistSettings: () => { throw new Error('disk denied new-test-key') } })
    const before = await state(handle)
    const response = await patch({ baseURL: next.url, apiKey: 'new-test-key', rememberKey: true })
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('new-test-key')
    expect(await state(handle)).toEqual(before)
    await turn(handle)
    expect(old.requests.at(-1)?.authorization).toBe('Bearer old-test-key')
    expect(next.requests).toHaveLength(0)
  })

  it('rejects a workspace remount and settings edits while any task is running without aborting it', async () => {
    const old = await provider()
    const cwd = await workspace(old.url)
    const other = await workspace(old.url)
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const barrier = new Promise<void>(resolve => { release = resolve })
    let signal: AbortSignal | undefined
    const { handle, patch, persisted } = await desktop(cwd, { adapter: {
      id: 'held', defaultModel: 'held-model', async *stream(req) {
        signal = req.signal
        entered()
        await barrier
        yield { type: 'text', delta: 'done' }
        yield { type: 'done', reason: 'stop' }
      },
    } })
    const running = handle.harness.run('held task')
    try {
      await started
      expect((await patch({ apiKey: 'never-applied' })).status).toBe(409)
      expect((await patch({ workspace: other, model: 'never-applied' })).status).toBe(409)
      expect(signal?.aborted).toBe(false)
      expect((await state(handle)).cwd).toBe(cwd)
      expect(persisted).toEqual([])
    } finally { release(); await running }
  })

  it('updates a registered profile and keeps its replacement credentials on workspace changes', async () => {
    const old = await provider()
    const next = await provider()
    const cwd = await workspace(old.url)
    const other = await workspace(old.url)
    for (const dir of [cwd, other]) {
      const file = path.join(dir, 'sakura.yml')
      const config = JSON.parse(await fs.readFile(file, 'utf8'))
      config.models = { review: { baseURL: old.url, model: 'profile-model', apiKey: 'profile-old-key' } }
      await fs.writeFile(file, JSON.stringify(config))
    }
    const { handle, patch } = await desktop(cwd)
    expect((await patch({ model: 'profile-model', baseURL: next.url, apiKey: 'profile-new-key' })).status).toBe(200)
    await turn(handle)
    expect(next.requests.at(-1)).toMatchObject({ authorization: 'Bearer profile-new-key', model: 'profile-model' })
    expect((await patch({ workspace: other })).status).toBe(200)
    await turn(handle)
    expect(next.requests).toHaveLength(2)
    expect(next.requests.at(-1)?.authorization).toBe('Bearer profile-new-key')
    expect(old.requests).toHaveLength(0)
  })
})

describe('LLM configuration preparation', () => {
  it('resetting a model preserves an explicit credential clear and endpoint override', () => {
    const ctx = new Context()
    cleanups.push(() => ctx.dispose())
    const llm = new LLMService(ctx)
    llm.register(new OpenAICompatAdapter({ id: 'default', baseURL: 'https://original.invalid/v1', model: 'baseline', apiKey: 'original-key' }))
    llm.prepareConfiguration({ model: 'override', baseURL: 'https://replacement.invalid/v1', apiKey: '' }).commit()
    llm.prepareConfiguration({ model: null }).commit()
    expect(llm.modelStatus()).toMatchObject({ model: 'baseline', baseURL: 'https://replacement.invalid/v1', configured: false })
    const adapter = llm.pick() as OpenAICompatAdapter
    expect(adapter.opts.apiKey).toBeUndefined()
  })
})

describe('OpenAICompatAdapter — responses format', () => {
  it('posts to /responses with input items and parses the response.* SSE vocabulary', async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
        requests.push({ path: req.url ?? '', body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: ' + JSON.stringify({ type: 'response.output_text.delta', delta: '汇总:' }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_fc_1', name: 'list_files', arguments: '{"dir":"."}' } }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{}' }) + '\n\n')
        res.write('data: ' + JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address() as { port: number }
    const adapter = new OpenAICompatAdapter({
      id: 'responses-provider', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'resp-model', format: 'responses',
    })
    const chunks: Array<{ type: string; [key: string]: unknown }> = []
    for await (const chunk of adapter.stream({
      model: 'resp-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'done' },
      ],
      tools: [{ name: 'list_files', description: 'ls', parameters: { type: 'object', properties: {} } }],
    })) {
      chunks.push(chunk as { type: string; [key: string]: unknown })
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]!.path).toBe('/v1/responses')
    const body = requests[0]!.body
    // Chat Completions messages map onto Responses input items. An assistant
    // turn with no textual content is represented by its function_call items.
    expect(body.input).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
    ])
    // The Responses API tool schema is flat ({type:'function', name, ...}), not nested.
    expect(body.tools).toEqual([{ type: 'function', name: 'list_files', description: 'ls', parameters: { type: 'object', properties: {} } }])
    expect(body.tool_choice).toBe('auto')
    const texts = chunks.filter((c) => c.type === 'text').map((c) => c.delta).join('')
    expect(texts).toBe('汇总:')
    const calls = chunks.filter((c) => c.type === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.name).toBe('list_files')
    expect(calls[0]!.argsDelta).toBe('{"dir":"."}')
    expect(chunks.find((c) => c.type === 'usage')).toMatchObject({ inputTokens: 10, outputTokens: 5 })
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'tool_calls' })
  })

  it('falls back to output_text when the provider never streams deltas', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { output_text: 'completed text', usage: { input_tokens: 3 } } }) + '\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address() as { port: number }
    const adapter = new OpenAICompatAdapter({ baseURL: `http://127.0.0.1:${address.port}`, model: 'm', format: 'responses' })
    const chunks: Array<{ type: string; [key: string]: unknown }> = []
    for await (const chunk of adapter.stream({ messages: [{ role: 'user', content: 'hi' }] })) {
      chunks.push(chunk as { type: string; [key: string]: unknown })
    }
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.delta).join('')).toBe('completed text')
    expect(chunks.at(-1)).toMatchObject({ type: 'done', reason: 'stop' })
  })

  it('surfaces upstream responses errors', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ type: 'error', error: { message: 'quota exhausted' } }) + '\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address() as { port: number }
    const adapter = new OpenAICompatAdapter({ baseURL: `http://127.0.0.1:${address.port}`, model: 'm', format: 'responses' })
    await expect(adapter.stream({ messages: [{ role: 'user', content: 'hi' }] }).next())
      .rejects.toThrow(/quota exhausted/)
  })
})
