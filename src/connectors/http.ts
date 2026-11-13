/** HTTP JSON bridge v1; targets are operator-configured, never supplied by tool arguments. */
import { randomUUID } from 'node:crypto'
import { CONNECTOR_LIMITS, ConnectorError, type ConnectorAdapter, type ConnectorConfig } from './types.js'
import { connectorUrl, resolveConnectorHeaders, validateCapabilities, validateConnectorResult,
  validateExternalRead, validateExternalSearch } from './validation.js'

export async function boundedResponse(response: Response, signal: AbortSignal, cap = CONNECTOR_LIMITS.responseBytes): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const parts: Uint8Array[] = []
  let bytes = 0
  const cancel = () => { void reader.cancel().catch(() => {}) }
  if (signal.aborted) cancel()
  else signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > cap) throw new ConnectorError(502, 'connector response exceeds its byte budget')
      parts.push(value)
    }
    signal.throwIfAborted()
    try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)) }
    catch { throw new ConnectorError(502, 'connector response is not valid UTF-8') }
  } finally { signal.removeEventListener('abort', cancel); cancel() }
}

export const httpConnectorAdapter: ConnectorAdapter = {
  id: 'http', version: 1, description: 'HTTP JSON bridge v1 for software actions and bounded knowledge',
  async connect(config: Readonly<ConnectorConfig>, context) {
    const base = connectorUrl(config.url)
    const headers = resolveConnectorHeaders(config)
    const closed = new AbortController()
    async function request(endpoint: string, body?: object, caller?: AbortSignal): Promise<unknown> {
      const signal = AbortSignal.any([context.signal, closed.signal, AbortSignal.timeout(config.timeoutMs ?? 30_000), ...(caller ? [caller] : [])])
      signal.throwIfAborted()
      const raw = body === undefined ? undefined : JSON.stringify({ ...body, version: 1, requestId: randomUUID() })
      if (raw && Buffer.byteLength(raw) > CONNECTOR_LIMITS.requestBytes) throw new ConnectorError(413, 'connector request exceeds its byte budget')
      let response: Response
      try {
        response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal,
          headers: { accept: 'application/json', 'content-type': 'application/json', ...headers }, body: raw })
      } catch {
        if (signal.aborted) throw new ConnectorError(504, 'connector request was cancelled, disconnected or timed out; no automatic retry')
        throw new ConnectorError(502, 'connector network request failed; no automatic retry')
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new ConnectorError(response.status === 409 ? 409 : 502, `connector returned HTTP ${response.status}`) }
      if (!response.headers.get('content-type')?.includes('application/json')) { await response.body?.cancel().catch(() => {}); throw new ConnectorError(502, 'connector must return application/json') }
      const text = await boundedResponse(response, signal)
      try { return JSON.parse(text) } catch { throw new ConnectorError(502, 'connector response is invalid JSON') }
    }
    const capabilities = validateCapabilities(await request('/capabilities'))
    return {
      capabilities,
      call: async (action, args, signal) => validateConnectorResult(await request('/actions/' + encodeURIComponent(action), { args }, signal)),
      ...(capabilities.knowledge?.search ? { search: async (query: string, options: { limit: number; maxChars: number }, signal: AbortSignal) =>
        validateExternalSearch(await request('/knowledge/search', { query, ...options }, signal), options.limit, options.maxChars) } : {}),
      ...(capabilities.knowledge?.read ? { read: async (id: string, options: { cursor?: string; version?: string; maxChars: number }, signal: AbortSignal) => {
        const { version: documentVersion, ...page } = options
        return validateExternalRead(await request('/knowledge/read', { id, ...page, ...(documentVersion !== undefined ? { documentVersion } : {}) }, signal), id, options.maxChars)
      } } : {}),
      close: () => { closed.abort(); },
    }
  },
}
