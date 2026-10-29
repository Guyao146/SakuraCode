/** Keep the independently embedded version strings aligned with the release manifest. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (file: string) => readFileSync(new URL('../' + file, import.meta.url), 'utf8')

it('ships one stable version across package manifests, CLI, Web, integration identity and release notes', () => {
  const manifest = JSON.parse(read('package.json')) as { version: string }
  const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> }
  expect(manifest.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  expect(lock.version).toBe(manifest.version)
  expect(lock.packages['']!.version).toBe(manifest.version)
  for (const file of ['src/cli.ts', 'src/web/server.ts']) expect(read(file)).toContain(`const VERSION = '${manifest.version}'`)
  expect(read('src/integrations/weixin-client.ts')).toContain(`bot_agent: 'SakuraCode/${manifest.version}'`)
  const notes = read(`docs/releases/v${manifest.version}.md`)
  expect(notes).toContain(`# SakuraCode v${manifest.version}`)
  expect(notes).toContain(`SakuraCode-${manifest.version}-win-x64.zip`)
  expect(read('README.md')).toContain(`docs/releases/v${manifest.version}.md`)
})