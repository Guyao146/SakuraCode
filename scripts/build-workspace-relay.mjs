/** Bundle the sharing relay and its local mobile UI, without changing desktop build outputs. */
import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = path.join(root, 'build-relay')
await mkdir(out, { recursive: true })
const html = await readFile(path.join(root, 'src/web/mobile.html'), 'utf8')
await build({
  absWorkingDir: root, entryPoints: ['scripts/run-workspace-relay.ts'], outfile: path.join(out, 'workspace-relay.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', legalComments: 'none',
  plugins: [{ name: 'share-mobile', setup(b) {
    b.onResolve({ filter: /^sakura-share-mobile-embed$/ }, () => ({ path: 'mobile', namespace: 'share-mobile' }))
    b.onLoad({ filter: /.*/, namespace: 'share-mobile' }, () => ({ contents: 'export default ' + JSON.stringify(html), loader: 'js' }))
  } }],
})
console.log('Sharing relay bundle: ' + path.join(out, 'workspace-relay.mjs'))
