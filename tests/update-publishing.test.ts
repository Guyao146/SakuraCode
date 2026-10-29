/** Real publication/HTTP transport tests using small synthetic bytes and loopback only. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UpdateChecker } from '../src/updates.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
async function temporary() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-update-publish-'))
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }))
  return directory
}
async function execute(script: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts', script), ...args], { windowsHide: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject); child.once('exit', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('self-hosted desktop update publisher and readonly server', () => {
  it('publishes a hashed immutable release, escapes notes, serves only approved files and never overwrites an existing version', async () => {
    const directory = await temporary(), output = path.join(directory, 'published'), exe = path.join(directory, 'synthetic.exe'), notes = path.join(directory, 'notes.txt')
    const bytes = Buffer.from('SYNTHETIC_TEST_BYTES_NOT_AN_EXECUTABLE')
    await fs.writeFile(exe, bytes); await fs.writeFile(notes, '<script>alert(1)</script>\n中文更新说明')
    await fs.mkdir(output)
    await fs.writeFile(path.join(output, 'not-public-secret.txt'), 'PRIVATE_NON_UPDATE_FILE')
    const server = spawn(process.execPath, [path.join(root, 'scripts', 'serve-desktop-updates.mjs'), '--directory', output, '--port', '0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stopped = new Promise<void>(resolve => { server.once('exit', () => resolve()) })
    cleanups.push(async () => { if (server.exitCode === null) server.kill(); await stopped })
    let stdout = '', stderr = ''
    server.stdout.on('data', chunk => { stdout += String(chunk) }); server.stderr.on('data', chunk => { stderr += String(chunk) })
    await vi.waitFor(() => { expect(server.exitCode, stderr).toBeNull(); expect(stdout).toContain('"ready":true') })
    const url = (JSON.parse(stdout.trim().split('\n')[0]!) as { url: string }).url
    const args = ['--output', output, '--base-url', url, '--exe', exe, '--version', '0.7.5', '--notes-file', notes]
    const publication = await execute('publish-desktop-update.mjs', args)
    expect(publication.code, publication.stderr).toBe(0)
    const manifestText = await fs.readFile(path.join(output, 'latest.json'), 'utf8')
    const manifest = JSON.parse(manifestText) as { sha256: string; size: number; downloadUrl: string; notes: string }
    expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(manifest.size).toBe(bytes.length)
    const checker = new UpdateChecker('0.7.4', url + 'latest.json'); cleanups.push(async () => { checker.close() })
    const info = await checker.check()
    expect(info).toMatchObject({ hasUpdate: true, latest: '0.7.5', sourceUrl: url + 'latest.json', sha256: manifest.sha256, size: bytes.length })
    const downloaded = await fetch(manifest.downloadUrl)
    expect(downloaded.headers.get('content-disposition')).toContain('attachment')
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes)
    const latest = await fetch(url + 'latest.json'); expect(latest.headers.get('cache-control')).toBe('no-store')
    const head = await fetch(manifest.downloadUrl, { method: 'HEAD' }); expect(head.headers.get('content-length')).toBe(String(bytes.length)); expect(await head.text()).toBe('')
    const page = await fetch(url + '0.7.5/')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'")
    const pageText = await page.text(); expect(pageText).toContain('&lt;script&gt;'); expect(pageText).not.toContain('<script>')
    const duplicate = await execute('publish-desktop-update.mjs', args)
    expect(duplicate.code).not.toBe(0); expect(duplicate.stderr).toContain('Version already exists')
    expect(await fs.readFile(path.join(output, 'latest.json'), 'utf8')).toBe(manifestText)
    for (const route of ['not-public-secret.txt', '%2e%2e/not-public-secret.txt', '0.7.5/../not-public-secret.txt', 'latest.json?token=secret', '0.7.5/not-public-secret.txt']) {
      expect((await fetch(url + route)).status).toBe(404)
    }
    expect((await fetch(url + 'latest.json', { method: 'POST', body: '{}' })).status).toBe(405)
    const later = await execute('publish-desktop-update.mjs', [...args.slice(0, 6), '--version', '0.7.6', '--notes-file', notes])
    expect(later.code, later.stderr).toBe(0)
    expect((JSON.parse(await fs.readFile(path.join(output, 'latest.json'), 'utf8')) as { version: string }).version).toBe('0.7.6')
    expect(await fs.readFile(path.join(output, '0.7.5', 'SakuraCode Desktop.exe'))).toEqual(bytes)
  })

  it('rejects insecure publishing options before writing release assets', async () => {
    const directory = await temporary(), exe = path.join(directory, 'synthetic.exe'), output = path.join(directory, 'published')
    await fs.writeFile(exe, 'synthetic')
    for (const [base, version] of [['http://external.example/', '0.7.5'], ['https://user:secret@example.test/', '0.7.5'],
      ['https://example.test/?token=secret', '0.7.5'], ['https://example.test/', '0.7.5-rc.1']]) {
      const result = await execute('publish-desktop-update.mjs', ['--output', output, '--base-url', base!, '--exe', exe, '--version', version!])
      expect(result.code).not.toBe(0)
      expect(await fs.stat(output).then(() => true, () => false)).toBe(false)
    }
  })
})