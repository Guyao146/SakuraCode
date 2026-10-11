/**
 * Build the standalone Windows client: bundle → SEA blob → inject node.exe.
 * Output: build/SakuraCode.exe (~90MB, no Node installation required to run).
 * The web GUI (src/web/index.html) is embedded into the bundle as a virtual
 * module so the SEA exe serves it without touching the filesystem.
 */

import { execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)

const sh = (cmd) => {
  console.log(`> ${cmd}`)
  execSync(cmd, { stdio: 'inherit' })
}

if (!existsSync('src/web/index.html')) {
  console.error('error: src/web/index.html is missing — the web GUI is part of the client build.')
  process.exit(1)
}
const webHtml = readFileSync('src/web/index.html', 'utf8')

rmSync('build', { recursive: true, force: true })
mkdirSync('build', { recursive: true })

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  legalComments: 'none',
  outfile: 'build/sakura.cjs',
  plugins: [
    {
      name: 'sakura-embed-web',
      setup(b) {
        b.onResolve({ filter: /^sakura-web-index-embed$/ }, () => ({
          path: 'sakura-web-index-embed',
          namespace: 'sakura-embed',
        }))
        b.onLoad({ filter: /.*/, namespace: 'sakura-embed' }, () => ({
          contents: `export default ${JSON.stringify(webHtml)}`,
          loader: 'js',
        }))
      },
    },
  ],
})

writeFileSync(
  'build/sea-config.json',
  JSON.stringify(
    {
      main: 'build/sakura.cjs',
      output: 'build/sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: true,
    },
    null,
    2,
  ),
)
sh('node --experimental-sea-config build/sea-config.json')
copyFileSync(process.execPath, 'build/SakuraCode.exe')
sh(`node ${JSON.stringify(path.join(root, 'node_modules', 'postject', 'dist', 'cli.js'))} build/SakuraCode.exe NODE_SEA_BLOB build/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`)
console.log('\nDone: build/SakuraCode.exe')
