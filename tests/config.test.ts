import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deepMerge,
  flagsToPatch,
  loadConfig,
  resolveProfile,
  type PluginRow,
  type SakuraConfig,
} from '../src/config.js'

let tmp: string
const extraDirs: string[] = []

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-cfg-'))
})

afterEach(async () => {
  const dirs = [tmp, ...extraDirs]
  extraDirs.length = 0
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })))
})

const write = async (dir: string, name: string, content: string): Promise<string> => {
  const file = path.join(dir, name)
  await fs.writeFile(file, content, 'utf8')
  return file
}

const tempDir = async (prefix: string): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  extraDirs.push(dir)
  return dir
}

// ---------------------------------------------------------------------------
// deepMerge
// ---------------------------------------------------------------------------

describe('deepMerge', () => {
  it('merges nested objects recursively', () => {
    const a = { outer: { x: 1, y: 2 }, keep: true }
    const merged = deepMerge(a, { outer: { y: 3, z: 4 } })
    expect(merged).toEqual({ outer: { x: 1, y: 3, z: 4 }, keep: true })
  })

  it('overwrites scalars (b wins) and returns the mutated a', () => {
    const a: Record<string, unknown> = { n: 1, s: 'old', b: false }
    const merged = deepMerge(a, { n: 2, s: 'new', b: true })
    expect(merged).toBe(a)
    expect(a).toEqual({ n: 2, s: 'new', b: true })
  })

  it('replaces arrays instead of merging them', () => {
    const a = { list: [1, 2, 3] }
    expect(deepMerge(a, { list: [9] })).toEqual({ list: [9] })
    expect(deepMerge({ list: [1, 2, 3] }, { list: [] })).toEqual({ list: [] })
  })

  it('adds keys that only exist in b', () => {
    const a = { a: 1 }
    expect(deepMerge(a, { b: { c: 2 } })).toEqual({ a: 1, b: { c: 2 } })
  })
})

// ---------------------------------------------------------------------------
// loadConfig — layering: defaults → home file → configPath/cwd file → --patch
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('applies defaults when no config files exist anywhere (missing home/cwd files are skipped)', async () => {
    const emptyCwd = await tempDir('sakura-empty-')
    const config = await loadConfig({ cwd: emptyCwd })
    expect(config.profile).toBe('default')
    expect(config.pluginsDir).toBe('plugins')
    expect(config.plugins).toEqual({})
  })

  it('loads a config file given via configPath', async () => {
    const file = await write(
      tmp,
      'sakura.yml',
      [
        'profile: test-profile',
        'systemPrompt: be terse',
        'plugins:',
        '  core-llm:',
        '    config:',
        '      model: gpt-test',
        '      baseURL: http://file-endpoint',
        '',
      ].join('\n'),
    )
    const config = await loadConfig({ configPath: file })
    expect(config.profile).toBe('test-profile')
    expect(config.systemPrompt).toBe('be terse')
    expect(config.plugins?.['core-llm']?.config).toMatchObject({
      model: 'gpt-test',
      baseURL: 'http://file-endpoint',
    })
    expect(config.pluginsDir).toBe('plugins')
  })

  it('the --patch YAML overrides the config file, merging nested plugin config', async () => {
    const file = await write(
      tmp,
      'sakura.yml',
      [
        'profile: from-file',
        'systemPrompt: from-file',
        'plugins:',
        '  core-llm:',
        '    config:',
        '      model: file-model',
        '      baseURL: http://file-endpoint',
        '',
      ].join('\n'),
    )
    const patch = ['profile: patched', 'plugins:', '  core-llm:', '    config:', '      model: patched-model', ''].join(
      '\n',
    )

    const config = await loadConfig({ configPath: file, patch })
    expect(config.profile).toBe('patched')
    expect(config.systemPrompt).toBe('from-file') // untouched by the patch
    expect(config.plugins?.['core-llm']?.config).toEqual({
      model: 'patched-model', // overridden by the patch
      baseURL: 'http://file-endpoint', // kept from the file
    })
  })

  it('a missing configPath throws', async () => {
    await expect(loadConfig({ configPath: path.join(tmp, 'absent.yml') })).rejects.toThrow(/config file not found/)
  })

  it('invalid YAML in a config file throws a wrapped error', async () => {
    const bad = await write(tmp, 'bad.yml', 'plugins: [unclosed')
    await expect(loadConfig({ configPath: bad })).rejects.toThrow(/failed to read config/)
  })

  it('invalid --patch YAML throws', async () => {
    const file = await write(tmp, 'ok.yml', 'profile: ok\n')
    await expect(loadConfig({ configPath: file, patch: 'foo: [unclosed' })).rejects.toThrow()
    await expect(loadConfig({ configPath: file, patch: '- just\n- a list' })).rejects.toThrow(
      /--patch must be a YAML mapping/,
    )
  })

  it('configPath takes precedence over the cwd config files', async () => {
    const cwd = await tempDir('sakura-cwd-')
    await write(cwd, 'sakura.yml', 'profile: from-cwd\n')
    const file = await write(tmp, 'other.yml', 'profile: from-path\n')

    const config = await loadConfig({ cwd, configPath: file })
    expect(config.profile).toBe('from-path')
  })

  it('scans the cwd CONFIG_FILES in order and stops at the first match', async () => {
    const cwdBoth = await tempDir('sakura-both-')
    await write(cwdBoth, 'sakura.yaml', 'profile: yaml-file\n')
    await write(cwdBoth, 'sakura.config.yml', 'profile: config-yml-file\n')
    expect((await loadConfig({ cwd: cwdBoth })).profile).toBe('yaml-file')

    const cwdOnlyThird = await tempDir('sakura-third-')
    await write(cwdOnlyThird, 'sakura.config.yml', 'profile: config-yml-file\n')
    expect((await loadConfig({ cwd: cwdOnlyThird })).profile).toBe('config-yml-file')
  })
})

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

describe('resolveProfile', () => {
  it('merges profile bundles and plugin rows over the top level; plugin row config merges with profile winning', () => {
    const config: SakuraConfig = {
      profile: 'work',
      bundles: ['base.js'],
      plugins: {
        'core-llm': { config: { model: 'm1', temperature: 0 } },
      },
      profiles: {
        work: {
          bundles: ['extra.js'],
          plugins: {
            'core-llm': { config: { model: 'm2' } },
            'tool-x': { disabled: false, config: { k: 1 } },
          },
        },
      },
    }

    const { bundles, plugins } = resolveProfile(config)
    expect(bundles).toEqual(['base.js', 'extra.js'])
    expect(plugins['core-llm']!.config).toEqual({ model: 'm2', temperature: 0 })
    expect(plugins['tool-x']!.config).toEqual({ k: 1 })
    expect(plugins['tool-x']!.disabled).toBe(false)
  })

  it('the default profile is used when config.profile is unset', () => {
    const config: SakuraConfig = {
      bundles: ['base.js'],
      profiles: { default: { bundles: ['d.js'] } },
    }
    expect(resolveProfile(config).bundles).toEqual(['base.js', 'd.js'])
  })

  it('an existing row stays disabled when the profile row does not specify disabled', () => {
    const config: SakuraConfig = {
      plugins: { a: { disabled: true, config: { x: 1 } } },
      profiles: { default: { plugins: { a: { config: { y: 2 } } } } },
    }
    const { plugins } = resolveProfile(config)
    expect(plugins['a']!.disabled).toBe(true)
    expect(plugins['a']!.config).toEqual({ x: 1, y: 2 })
  })

  it('a profile row can re-enable a disabled row (row.disabled ?? existing.disabled)', () => {
    const config: SakuraConfig = {
      plugins: { a: { disabled: true } },
      profiles: { default: { plugins: { a: { disabled: false } } } },
    }
    expect(resolveProfile(config).plugins['a']!.disabled).toBe(false)
  })

  it('an unknown profile falls back to the top-level rows only', () => {
    const config: SakuraConfig = {
      profile: 'missing',
      bundles: ['b.js'],
      plugins: { a: { disabled: true } },
      profiles: { other: { bundles: ['never.js'] } },
    }
    const { bundles, plugins } = resolveProfile(config)
    expect(bundles).toEqual(['b.js'])
    expect(plugins['a']!.disabled).toBe(true)
    expect(plugins['never']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// flagsToPatch
// ---------------------------------------------------------------------------

describe('flagsToPatch', () => {
  it('maps model/baseURL onto plugins["core-llm"].config', () => {
    const patch = flagsToPatch({ model: 'm', baseURL: 'http://x' })
    expect(patch.plugins).toMatchObject({
      'core-llm': { config: { model: 'm', baseURL: 'http://x' } },
    })
  })

  it('omits core-llm keys for absent flags', () => {
    const patch = flagsToPatch({ model: 'm' })
    const rows = patch.plugins as Record<string, PluginRow>
    expect(rows['core-llm']!.config).toEqual({ model: 'm' })
    expect(rows['core-approval']).toBeUndefined()
  })

  it('maps approvalMode onto plugins["core-approval"].config.mode', () => {
    const patch = flagsToPatch({ approvalMode: 'yolo' })
    expect(patch.plugins).toMatchObject({
      'core-approval': { config: { mode: 'yolo' } },
    })
  })

  it('maps maxSteps/allowNested onto plugins["core-agent"].config', () => {
    const patch = flagsToPatch({ maxSteps: 25, allowNested: true })
    expect(patch.plugins).toMatchObject({
      'core-agent': { config: { maxSteps: 25, allowNestedSubagents: true } },
    })

    // Only the flags that are present appear.
    const onlyNested = flagsToPatch({ allowNested: false })
    expect((onlyNested.plugins as Record<string, PluginRow>)['core-agent']!.config).toEqual({
      allowNestedSubagents: false,
    })
  })

  it('puts systemPrompt at the top level, outside the plugin rows', () => {
    const patch = flagsToPatch({ systemPrompt: 'be nice' })
    expect(patch.systemPrompt).toBe('be nice')
    expect(patch.plugins).toEqual({})
  })

  it('with no flags, the patch carries an empty plugins mapping', () => {
    expect(flagsToPatch({})).toEqual({ plugins: {} })
  })

  it('combines all flags into one patch', () => {
    const patch = flagsToPatch({
      model: 'm',
      baseURL: 'http://x',
      approvalMode: 'acceptEdits',
      maxSteps: 10,
      allowNested: false,
      systemPrompt: 'sp',
    })
    const rows = patch.plugins as Record<string, PluginRow>
    expect(rows['core-llm']!.config).toEqual({ model: 'm', baseURL: 'http://x' })
    expect(rows['core-approval']!.config).toEqual({ mode: 'acceptEdits' })
    expect(rows['core-agent']!.config).toEqual({ maxSteps: 10, allowNestedSubagents: false })
    expect(patch.systemPrompt).toBe('sp')
  })
})
