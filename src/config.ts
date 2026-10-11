/**
 * Config — profiles & patches. A config is a composition: plugin
 * rows with `config` and `disabled`, out-of-tree `bundles` (module
 * specifiers to import), and a `pluginsDir` for auto-discovered plugin
 * files. Layers: defaults → home file → project file → --patch YAML → flags.
 */

import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ApprovalMode } from './core/approval.js'

export interface PluginRow {
  disabled?: boolean
  config?: Record<string, unknown>
}

/** One MCP server entry: stdio (command) or streamable HTTP (url). */
export interface McpServerConfig {
  /** stdio transport: the executable. Optional when `url` is set. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** Streamable HTTP transport: connect to this URL instead of spawning. */
  url?: string
  headers?: Record<string, string>
  /** Per-call timeout for tools/call (default 120000). */
  timeoutMs?: number
}

export interface SakuraConfig {
  /** Web transport only. Secrets are read from environment variables, never sent to the GUI. */
  web?: {
    host?: string
    port?: number
    publicOrigin?: string
    tokenEnv?: string
    viewerTokenEnv?: string
  }
  profile?: string
  profiles?: Record<string, { bundles?: string[]; plugins?: Record<string, PluginRow> }>
  /** Out-of-tree plugin module specifiers (file paths or package names). */
  bundles?: string[]
  /** Directory scanned for plugin modules (default "plugins" if it exists). */
  pluginsDir?: string
  systemPrompt?: string
  plugins?: Record<string, PluginRow>
  /** MCP servers bridged as `mcp__<server>__<tool>` tools (mcp-manager plugin). */
  mcpServers?: Record<string, McpServerConfig>
  /** Named model profiles (provider baseURL/key/model) — switchable via /model. */
  models?: Record<string, import('./plugins/model-profiles.js').ModelProfileConfig>
}

export const CONFIG_FILES = ['sakura.yml', 'sakura.yaml', 'sakura.config.yml']

export function defaultConfig(): SakuraConfig {
  return {
    profile: 'default',
    pluginsDir: 'plugins',
    plugins: {},
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge b into a (mutating a); b wins for scalars, objects merge recursively. */
export function deepMerge<T extends Record<string, unknown>>(a: T, b: Record<string, unknown>): T {
  for (const [key, value] of Object.entries(b)) {
    const current = (a as Record<string, unknown>)[key]
    if (isPlainObject(current) && isPlainObject(value)) {
      deepMerge(current as Record<string, unknown>, value)
    } else {
      ;(a as Record<string, unknown>)[key] = value
    }
  }
  return a
}

async function readYamlIfExists(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = parseYaml(raw)
    return isPlainObject(parsed) ? parsed : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`failed to read config ${file}: ${(error as Error).message}`)
  }
}

export interface LoadConfigOptions {
  cwd?: string
  configPath?: string
  patch?: string // inline YAML from --patch
}

/** Load and layer the configuration; missing files are skipped. */
export async function loadConfig(opts: LoadConfigOptions = {}): Promise<SakuraConfig> {
  const cwd = opts.cwd ?? process.cwd()
  const config = defaultConfig()

  const home = path.join(os.homedir(), '.sakura', 'config.yml')
  const homeLayer = await readYamlIfExists(home)
  if (homeLayer) deepMerge(config as unknown as Record<string, unknown>, homeLayer)

  if (opts.configPath) {
    const layer = await readYamlIfExists(opts.configPath)
    if (!layer) throw new Error(`config file not found: ${opts.configPath}`)
    deepMerge(config as unknown as Record<string, unknown>, layer)
  } else {
    for (const name of CONFIG_FILES) {
      const layer = await readYamlIfExists(path.join(cwd, name))
      if (layer) {
        deepMerge(config as unknown as Record<string, unknown>, layer)
        break
      }
    }
  }

  if (opts.patch) {
    const parsed = parseYaml(opts.patch)
    if (!isPlainObject(parsed)) throw new Error('--patch must be a YAML mapping')
    deepMerge(config as unknown as Record<string, unknown>, parsed)
  }

  return config
}

/** Resolve the effective plugin rows for the active profile. */
export function resolveProfile(config: SakuraConfig): { bundles: string[]; plugins: Record<string, PluginRow> } {
  const profileName = config.profile ?? 'default'
  const profile = config.profiles?.[profileName]
  const bundles = [...(config.bundles ?? []), ...(profile?.bundles ?? [])]
  const plugins: Record<string, PluginRow> = {}
  for (const [name, row] of Object.entries(config.plugins ?? {})) {
    plugins[name] = row
  }
  for (const [name, row] of Object.entries(profile?.plugins ?? {})) {
    const existing = plugins[name] ?? {}
    plugins[name] = {
      disabled: row.disabled ?? existing.disabled,
      config: { ...(existing.config ?? {}), ...(row.config ?? {}) },
    }
  }
  return { bundles, plugins }
}

/** Flag overrides expressed as a patch, merged last. */
export function flagsToPatch(flags: {
  model?: string
  baseURL?: string
  approvalMode?: ApprovalMode
  maxSteps?: number
  allowNested?: boolean
  systemPrompt?: string
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  const plugins: Record<string, PluginRow> = {}
  if (flags.model || flags.baseURL) {
    plugins['core-llm'] = { config: { ...(flags.model ? { model: flags.model } : {}), ...(flags.baseURL ? { baseURL: flags.baseURL } : {}) } }
  }
  if (flags.approvalMode) plugins['core-approval'] = { config: { mode: flags.approvalMode } }
  if (flags.maxSteps !== undefined || flags.allowNested !== undefined) {
    plugins['core-agent'] = {
      config: {
        ...(flags.maxSteps !== undefined ? { maxSteps: flags.maxSteps } : {}),
        ...(flags.allowNested !== undefined ? { allowNestedSubagents: flags.allowNested } : {}),
      },
    }
  }
  if (flags.systemPrompt) patch.systemPrompt = flags.systemPrompt
  patch.plugins = plugins
  return patch
}
