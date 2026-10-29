/** Publish immutable desktop assets and atomically advance latest.json. Node built-ins only. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const options = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index], value = process.argv[index + 1]
  assert.ok(['--output', '--base-url', '--exe', '--version', '--notes-file', '--guide'].includes(name) && value && !options.has(name),
    'Usage: node scripts/publish-desktop-update.mjs --output <absolute-directory> --base-url <HTTPS-directory-URL> [--exe <absolute-exe>] [--version <stable-version>] [--notes-file <absolute-text-file>] [--guide <absolute-guide>]')
  options.set(name, value)
}
const output = options.get('--output'), baseText = options.get('--base-url')
assert.ok(output && path.isAbsolute(output), '--output must be an absolute directory')
assert.ok(baseText && !/[\x00-\x1f\x7f\\]/.test(baseText), '--base-url must be an HTTPS directory URL')
const base = new URL(baseText)
assert.ok(!base.username && !base.password && !base.search && !base.hash &&
  (base.protocol === 'https:' || base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)),
  'Use HTTPS without credentials/query/fragment; HTTP is allowed only on loopback for testing')
if (!base.pathname.endsWith('/')) base.pathname += '/'
const version = options.get('--version') ?? JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Only a stable major.minor.patch version can be published')
const exe = options.get('--exe') ?? path.join(root, 'build', 'SakuraCode Desktop.exe')
assert.ok(path.isAbsolute(exe) && (await lstat(exe)).isFile(), '--exe must name an absolute regular file')
const size = (await stat(exe)).size
assert.ok(size > 0 && size <= 512 * 1024 * 1024, 'Desktop binary must be 1 byte–512 MiB')
if (!options.has('--exe')) {
  const metadata = JSON.parse(await readFile(path.join(root, 'build', 'desktop-build.json'), 'utf8'))
  assert.equal(metadata.version, version, 'Build version must match the published version')
}
const notesFile = options.get('--notes-file')
if (notesFile) assert.ok(path.isAbsolute(notesFile), '--notes-file must be absolute')
const notes = notesFile ? (await readFile(notesFile, 'utf8')).replace(/^\ufeff/, '')
  : `SakuraCode Desktop ${version}\n下载后先退出旧程序，核对 SHA-256 并备份旧 EXE，再替换程序文件。已有设置、账号、会话与工作区数据保留。`
assert.ok(notes.length <= 16000 && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(notes), 'Release notes must be safe UTF-8 plain text, at most 16000 characters')
async function hash(file) {
  const result = createHash('sha256')
  for await (const chunk of createReadStream(file)) result.update(chunk)
  return result.digest('hex')
}
const digest = await hash(exe), downloadName = 'SakuraCode Desktop.exe'
const relativeDirectory = encodeURIComponent(version) + '/'
const releaseUrl = new URL(relativeDirectory, base).href, downloadUrl = new URL(relativeDirectory + encodeURIComponent(downloadName), base).href
const manifest = { schemaVersion: 1, project: 'SakuraCode', platform: 'windows-x64', version, releaseUrl, downloadUrl,
  sha256: digest, size, notes, publishedAt: new Date().toISOString() }
const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
const page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>SakuraCode Desktop ' + escape(version) + '</title><style>body{max-width:800px;margin:48px auto;padding:0 20px;font:16px/1.8 system-ui;background:#1a1c22;color:#e5e7ee}a{color:#ef9aab}pre{white-space:pre-wrap;overflow-wrap:anywhere}code{overflow-wrap:anywhere}</style>' +
  '<h1>SakuraCode Desktop ' + escape(version) + '</h1><pre>' + escape(notes) + '</pre><p><a href="' + escape(downloadUrl) + '">下载 Windows x64 桌面版</a></p>' +
  '<p>大小：' + (size / 1048576).toFixed(2) + ' MiB</p><p>SHA-256：<code>' + digest + '</code></p>' +
  '<p>先退出程序并备份旧 EXE，再核对哈希并替换。不要删除用户数据目录；此页面不会自动安装。</p></html>\n'
await mkdir(output, { recursive: true })
const target = path.join(output, version)
await lstat(target).then(() => { throw new Error('Version already exists; publish a new version, never overwrite immutable assets: ' + target) }, error => {
  if (error.code !== 'ENOENT') throw error
})
const staging = path.join(output, '.publish-' + randomUUID()), latestStage = path.join(output, '.latest-' + randomUUID() + '.json')
await mkdir(staging)
try {
  await copyFile(exe, path.join(staging, downloadName), constants.COPYFILE_EXCL)
  assert.equal((await stat(path.join(staging, downloadName))).size, size, 'EXE changed while publishing')
  assert.equal(await hash(path.join(staging, downloadName)), digest, 'EXE changed while publishing')
  await writeFile(path.join(staging, 'SakuraCode Desktop.sha256'), digest + '  ' + downloadName + '\n', { flag: 'wx' })
  await writeFile(path.join(staging, 'index.html'), page, { flag: 'wx' })
  const guide = options.get('--guide') ?? (!options.has('--exe') ? path.join(root, 'build', 'SakuraCode Desktop-使用说明.txt') : undefined)
  if (guide) {
    assert.ok(path.isAbsolute(guide) && (await lstat(guide)).isFile(), '--guide must name an absolute regular file')
    await copyFile(guide, path.join(staging, 'SakuraCode Desktop-使用说明.txt'), constants.COPYFILE_EXCL)
  }
  await writeFile(latestStage, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  await rename(staging, target)
  await rename(latestStage, path.join(output, 'latest.json'))
  console.log(JSON.stringify({ published: true, directory: output, manifestUrl: new URL('latest.json', base).href, ...manifest }, null, 2))
} finally {
  await rm(staging, { recursive: true, force: true })
  await rm(latestStage, { force: true })
}