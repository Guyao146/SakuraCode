/**
 * tool-web-search — web_search: POST a query to a DuckDuckGo HTML endpoint
 * (default https://html.duckduckgo.com/html/) and extract results with
 * hand-rolled regexes — zero dependencies. parseResults() / decodeEntities()
 * are exported pure functions so the parsing is unit-testable.
 */

import type { PluginModule } from '../kernel/index.js'
import { params, type ToolsService } from '../core/tools.js'

export interface WebSearchConfig {
  /** Search endpoint accepting `q=<urlencoded>` form posts. */
  endpoint?: string
  /** Default result cap when the call omits max_results. Default 6. */
  maxResults?: number
}

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DEFAULT_MAX_RESULTS = 6
const REQUEST_TIMEOUT_MS = 15_000
const SNIPPET_MAX = 300
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

// ---------------------------------------------------------------------------
// Pure HTML helpers
// ---------------------------------------------------------------------------

/**
 * Decode the common HTML entities (numeric &#xHH; / &#DD; plus the named
 * set). `&amp;` is decoded last so already-decoded text is not re-parsed.
 */
export function decodeEntities(input: string): string {
  return input
    .replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+));/g, (all, hex: string | undefined, dec: string | undefined) => {
      const code = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? '', 10)
      if (!Number.isInteger(code)) return all
      try {
        return String.fromCodePoint(code)
      } catch {
        return all
      }
    })
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/g, '&')
}

/** Strip tags, decode entities and fold whitespace down to single spaces. */
function cleanText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function extractHref(attrs: string): string {
  const m = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs)
  if (!m) return ''
  return (m[1] ?? m[2] ?? '').trim()
}

/**
 * Resolve an anchor href to a real target URL. DuckDuckGo wraps results in
 * `//duckduckgo.com/l/?uddg=<urlencoded>&rut=...` redirects — the uddg
 * parameter carries the actual URL. Direct http(s) links pass through.
 */
function unwrapUrl(rawHref: string): string {
  const href = decodeEntities(rawHref.trim())
  const uddg = /[?&]uddg=([^&]+)/.exec(href)
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1] ?? '')
    } catch {
      return uddg[1] ?? ''
    }
  }
  if (/^https?:\/\//i.test(href)) return href
  if (href.startsWith('//')) return 'https:' + href
  return ''
}

interface AnchorMatch {
  pos: number
  attrs: string
  text: string
  href: string
}

/** All anchors whose class attribute contains the given class name. */
function matchAnchors(html: string, className: string): AnchorMatch[] {
  const re = new RegExp(
    `<a\\b([^>]*\\bclass\\s*=\\s*["'][^"']*\\b${className}\\b[^"']*["'][^>]*)>([\\s\\S]*?)</a>`,
    'gi',
  )
  const out: AnchorMatch[] = []
  for (;;) {
    const m = re.exec(html)
    if (!m) break
    const attrs = m[1] ?? ''
    out.push({ pos: m.index, attrs, text: m[2] ?? '', href: extractHref(attrs) })
  }
  return out
}

/** Clip a single-line snippet to `max` characters. */
function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * Parse a DuckDuckGo HTML results page into {title, url, snippet} rows.
 * Primary pass pairs each `.result__a` anchor (title + href) with the
 * `.result__snippet` anchor that follows it before the next result; when
 * nothing matches, a looser whole-document pass keeps any anchor carrying an
 * external http(s) href. Returns [] when the page has no results at all.
 */
export function parseResults(html: string): SearchResult[] {
  const links = matchAnchors(html, 'result__a')
  const snippets = matchAnchors(html, 'result__snippet')
  const results: SearchResult[] = []
  let snipIdx = 0
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!
    const url = unwrapUrl(link.href)
    if (!url || !/^https?:\/\//i.test(url)) continue
    const title = cleanText(link.text)
    if (!title) continue
    const nextPos = i + 1 < links.length ? links[i + 1]!.pos : Number.POSITIVE_INFINITY
    while (snipIdx < snippets.length && snippets[snipIdx]!.pos < link.pos) snipIdx++
    let snippet = ''
    if (snipIdx < snippets.length && snippets[snipIdx]!.pos < nextPos) {
      snippet = cleanText(snippets[snipIdx]!.text)
      snipIdx++
    }
    results.push({ title, url, snippet })
  }
  if (results.length > 0) return results

  // Loose fallback: any anchor with an external http(s) href and visible text.
  const seen = new Set<string>()
  const loose: SearchResult[] = []
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  for (;;) {
    const m = re.exec(html)
    if (!m) break
    const url = unwrapUrl(extractHref(m[1] ?? ''))
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue
    const title = cleanText(m[2] ?? '')
    if (!title) continue
    seen.add(url)
    loose.push({ title, url, snippet: '' })
    if (loose.length >= DEFAULT_MAX_RESULTS) break
  }
  return loose
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function clampMaxResults(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(10, Math.max(1, Math.floor(n)))
}

export const webSearchToolsPlugin: PluginModule<WebSearchConfig> = {
  name: 'tool-web-search',
  description: 'web_search — search the web (DuckDuckGo HTML) and return titles/URLs/snippets',
  inject: ['tools'],
  config: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', description: 'form-post search endpoint (default DuckDuckGo HTML)' },
      maxResults: { type: 'number', description: 'default result cap when the call omits max_results (default 6)' },
    },
  },
  apply(_ctx, config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService
    const endpoint = config?.endpoint ?? DEFAULT_ENDPOINT
    const defaultMaxResults = clampMaxResults(config?.maxResults, DEFAULT_MAX_RESULTS)

    tools.register({
      name: 'web_search',
      description:
        'Search the web and return a numbered list of results (title, URL, snippet). ' +
        'Use when you need up-to-date information, library documentation, or the cause of an error message.',
      kind: 'read',
      parameters: params(
        {
          query: { type: 'string', description: 'The search query.' },
          max_results: {
            type: 'number',
            description: 'Maximum results to return, 1-10 (defaults to the configured cap).',
            minimum: 1,
            maximum: 10,
          },
        },
        ['query'],
      ),
      execute: async (args, tc) => {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        if (!query) {
          return { output: 'error: web_search requires a non-empty "query" argument', isError: true }
        }
        const maxResults = clampMaxResults(args.max_results, defaultMaxResults)

        let response: Response
        try {
          response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'user-agent': USER_AGENT,
              'accept-language': 'en-US,en;q=0.9',
            },
            body: `q=${encodeURIComponent(query)}`,
            redirect: 'follow',
            signal: AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), tc.signal]),
          })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: `error: web_search request failed: ${message}`, isError: true }
        }
        if (!response.ok) {
          return {
            output: `error: web_search HTTP ${response.status} ${response.statusText} for ${endpoint}`,
            isError: true,
          }
        }
        let html: string
        try {
          html = await response.text()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: `error: web_search failed reading response: ${message}`, isError: true }
        }

        const results = parseResults(html)
        if (results.length === 0) return { output: '(no results)' }
        const output = results
          .slice(0, maxResults)
          .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${clip(r.snippet, SNIPPET_MAX)}`)
          .join('\n')
        return { output, ui: { query, endpoint, total: results.length } }
      },
    })
  },
}
