/** Build once for dist/SEA, or lazily for tsx. All PDF resources are embedded; no runtime package/path resolution. */
import { build } from 'esbuild'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
let pending
export function buildDocumentParser() {
  return pending ??= (async () => {
    const pdfRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))
    const assets = {}
    for (const folder of ['cmaps', 'standard_fonts']) {
      for (const file of (await readdir(path.join(pdfRoot, folder))).sort()) {
        if (!/\.(?:bcmap|pfb|ttf)$/.test(file)) continue
        assets[`${folder}/${file}`] = (await readFile(path.join(pdfRoot, folder, file))).toString('base64')
      }
    }
    const output = await build({
      absWorkingDir: root, entryPoints: [path.join(root, 'src/documents/parser-worker.ts')],
      bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20',
      legalComments: 'inline', logLevel: 'silent',
      // The text path never instantiates a Node canvas; do not include the optional native package.
      external: ['@napi-rs/canvas'],
      plugins: [{ name: 'document-parser-assets', setup(b) {
        b.onResolve({ filter: /^sakura-document-parser-assets$/ }, () => ({ path: 'assets', namespace: 'document-assets' }))
        b.onLoad({ filter: /.*/, namespace: 'document-assets' }, () => ({ contents: `export default ${JSON.stringify(assets)}`, loader: 'js' }))
      } }],
    })
    if (output.outputFiles.length !== 1) throw new Error('Document parser must be one self-contained worker')
    return output.outputFiles[0].text
  })().catch(error => { pending = undefined; throw error })
}
export async function writeDocumentParser(destination = path.join(root, 'dist/documents/parser-worker.cjs')) {
  const source = await buildDocumentParser()
  await mkdir(path.dirname(destination), { recursive: true })
  await writeFile(destination, source)
  return destination
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--stdout') process.stdout.write(await buildDocumentParser())
  else await writeDocumentParser(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
}
