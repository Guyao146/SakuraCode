/** tsc does not copy static assets. Keep the npm/Node build as usable as the SEA client. */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs'

const target = new URL('../dist/web/', import.meta.url)
mkdirSync(target, { recursive: true })
copyFileSync(new URL('../src/web/index.html', import.meta.url), new URL('index.html', target))
cpSync(new URL('../src/web/assets/', import.meta.url), new URL('assets/', target), { recursive: true })