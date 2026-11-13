/** Keep the independently embedded version strings aligned with the release manifest. */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { DesktopStatistics, type StatisticsStored } from '../src/desktop/statistics.js'
import { WEB_VERSION } from '../src/web/server.js'

const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

it('ships one stable version across package manifests, CLI, Web, integration identity and release notes', () => {
  const manifest = JSON.parse(read('package.json')) as { version: string }
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> }
  expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  expect(lock.version).toBe(manifest.version)
  expect(lock.packages['']!.version).toBe(manifest.version)
  for (const file of ['src/cli.ts', 'src/web/server.ts']) expect(read(file)).toContain(`const VERSION = '${manifest.version}'`)
  expect(read('src/integrations/weixin-client.ts')).toContain(`const VERSION = '${manifest.version}'`)
  expect(read('src/integrations/weixin-client.ts')).toContain('bot_agent: `SakuraCode/${VERSION}`')
  const notes = read(`docs/releases/v${manifest.version}.md`)
  expect(notes).toContain(`# SakuraCode v${manifest.version}`)
  expect(notes).toContain(`SakuraCode-${manifest.version}-win-x64.zip`)
  expect(read('README.md')).toContain(`docs/releases/v${manifest.version}.md`)
})

it('reports the release version from the running CLI, Web and desktop statistics metadata', async () => {
  const manifest = JSON.parse(read('package.json')) as { version: string }
  const cliVersion = execFileSync(process.execPath, [
    fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)),
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--version',
  ], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, SAKURA_UPDATES_AUTO_CHECK: '0' } }).trim()
  expect(cliVersion).toBe(manifest.version)
  expect(WEB_VERSION).toBe(manifest.version)

  const saved: StatisticsStored[] = []
  const statistics = new DesktopStatistics({ appVersion: WEB_VERSION, autoFlush: false,
    store: { read: async () => null, write: async value => { saved.push(structuredClone(value)) } },
    fetch: async () => { throw new Error('Release version regression must remain offline') },
  })
  try {
    await statistics.start()
    await statistics.configure({ enabled: true, endpoint: 'https://statistics.invalid/api/collect', appId: 'release_version_fixture' })
    expect(saved.at(-1)?.events[0]?.app_version).toBe(manifest.version)
  } finally { statistics.close() }
})