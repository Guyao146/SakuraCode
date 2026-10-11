/**
 * tool-web — web_fetch: fetch a URL and return readable text (HTML tags
 * stripped). web_search lives in its own plugin (tool-web-search).
 */

import type { PluginModule } from '../kernel/index.js'
import type { ToolsService } from '../core/tools.js'
import { truncate } from './util.js'

const MAX_BYTES = 400_000

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

export const webToolsPlugin: PluginModule = {
  name: 'tool-web',
  description: 'web_fetch — fetch a URL and return readable text',
  inject: ['tools'],
  apply(_ctx, _config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService

    tools.register({
      name: 'web_fetch',
      description: 'Fetch a URL (HTTP/HTTPS) and return its content as readable text.',
      kind: 'read',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch.' },
        },
        required: ['url'],
      },
      execute: async (args) => {
        const url = String(args.url ?? '')
        if (!/^https?:\/\//i.test(url)) {
          return { output: `error: only http(s) URLs are supported, got "${url.slice(0, 100)}"`, isError: true }
        }
        const response = await fetch(url, {
          redirect: 'follow',
          headers: { 'user-agent': 'SakuraCode/0.1 (+web_fetch)' },
          signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok || !response.body) {
          return { output: `error: HTTP ${response.status} ${response.statusText} for ${url}`, isError: true }
        }
        // Stream with a byte cap — never buffer a whole large response.
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let received = 0
        let truncated = false
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          received += value.length
          if (received >= MAX_BYTES) {
            truncated = true
            void reader.cancel().catch(() => {})
            break
          }
        }
        const parts: Uint8Array[] = []
        let taken = 0
        for (const chunk of chunks) {
          if (taken + chunk.length > MAX_BYTES) {
            parts.push(chunk.slice(0, MAX_BYTES - taken))
            taken = MAX_BYTES
            break
          }
          parts.push(chunk)
          taken += chunk.length
        }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(parts.map((p) => Buffer.from(p))))
        const contentType = response.headers.get('content-type') ?? ''
        const body = contentType.includes('html') ? htmlToText(text) : text
        const note = truncated ? `\n… [content truncated at ${MAX_BYTES} bytes]` : ''
        return { output: truncate(body || '(empty response)') + note, ui: { url, status: response.status } }
      },
    })
  },
}
