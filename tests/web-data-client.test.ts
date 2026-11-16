/** Real UI paths use synthetic files, a temporary Git repo and a loopback connector only. */
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import * as path from 'node:path'
import * as os from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { MockAdapter, text } from './helpers.js'
import { syntheticDocx } from './document-fixtures.js'
import { BackupService } from '../src/backup/service.js'
import type { WorktreeInfo } from '../src/worktrees/index.js'
const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
suite('documents backups connector wizard and isolated task — browser', () => {
  const browser = new BrowserClient()
  let root = '', cwd = '', web: WebServerHandle, adapter: MockAdapter, external: Server | undefined
  const extra: string[] = []
  beforeAll(async () => browser.start()); afterAll(async () => browser.close())
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-data-ui-')); cwd = path.join(root, 'project'); await fs.mkdir(cwd)
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { windowsHide: true, encoding: 'utf8' })
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false')
    await fs.writeFile(path.join(cwd, 'code.txt'), 'baseline'); git('add', 'code.txt'); git('commit', '-m', 'synthetic')
    adapter = new MockAdapter([text('INDEPENDENT_UI_DONE')]); vi.spyOn(adapter, 'stream')
    web = await runWebServer({ cwd, adapter, approvalMode: 'yolo', open: false, quiet: true, updatesAutoCheck: false,
      config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { disabled: true } } } })
    browser.errors.length = 0; await browser.resize(1440, 960); await browser.navigate(web.url)
    await browser.waitFor("document.documentElement.dataset.boot === 'ready'")
  })
  afterEach(async () => { const errors = [...browser.errors]; await browser.navigate('about:blank'); await web.close()
    if (external) { await new Promise<void>(resolve => { external!.closeAllConnections(); external!.close(() => resolve()) }); external = undefined }
    while (extra.length) await fs.rm(extra.pop()!, { recursive: true, force: true, maxRetries: 5 })
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); expect(errors).toEqual([])
  })
  async function pick(selector: string, file: string) { await browser.send('DOM.enable'); const doc = await browser.send('DOM.getDocument'); const node = await browser.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector }); await browser.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [file] }) }
  async function settings(section: string) { await browser.click('#settingsViewBtn'); await browser.click(`[data-settings-section=${section}]`) }
  it('previews real DOCX text, confirms import, and preserves the composer draft', async () => {
    const file = path.join(root, 'reference.docx'); await fs.writeFile(file, syntheticDocx())
    await browser.fill('#input', 'KEEP_DOC_DRAFT'); await settings('workspace')
    await browser.waitFor("!document.getElementById('documentImportBtn').disabled")
    await browser.click('#documentImportBtn'); await browser.waitFor("document.getElementById('documentImportDialog')?.open && !document.querySelector('#documentImportDialog button[type=submit]').disabled")
    await pick('#documentPicker', file); await browser.click('#documentImportDialog button[type=submit]')
    await browser.waitFor("document.getElementById('documentUnits').textContent.includes('DOCX_REFERENCE') && !document.querySelector('#documentImportDialog button[type=submit]').disabled", 30000)
    await browser.click('#documentUnits summary'); await browser.click('[data-document-unit]')
    await browser.click('#documentImportDialog button[type=submit]')
    await browser.waitFor("document.querySelector('#documentImportDialog button[type=submit]').textContent === '确认入库' && !document.querySelector('#documentImportDialog button[type=submit]').disabled")
    await browser.click('#documentImportDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('documentImportDialog') && document.getElementById('knowledgeDocuments').textContent.includes('.txt')")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('KEEP_DOC_DRAFT')
    expect(adapter.stream).not.toHaveBeenCalled()
  }, 60000)
  it('validates and restores a backup to a new directory only after confirmation', async () => {
    const session = await web.harness.ctx.sessions.create({ title: 'BACKUP_UI_SESSION' })
    await session.append({ type: 'user/message', payload: { content: 'KEEP_BACKUP_HISTORY' } })
    const service = new BackupService(cwd, web.harness.ctx.sessions), preview = await service.previewBackup({ sessionIds: [session.id] })
    const file = path.join(root, 'fixture.sakura-backup'); await fs.writeFile(file, await service.download(preview.id, preview.fingerprint))
    await settings('workspace'); await browser.waitFor("!document.getElementById('backupCreate').disabled && !document.getElementById('backupCard').hidden")
    // The workspace card moves while its lazy memory/knowledge lists settle.
    // Activate through the real keyboard path after checking focus, rather than a stale mouse coordinate.
    await browser.evaluate("document.getElementById('backupCreate').focus()")
    await browser.waitFor("document.activeElement === document.getElementById('backupCreate') && !document.activeElement.disabled && !document.activeElement.closest('[inert]')")
    await browser.key('Enter')
    await browser.waitFor("document.querySelector('[data-backup-session]') && !document.querySelector('#backupCreateDialog button[type=submit]').disabled")
    await browser.click('[data-backup-session]'); await browser.click('#backupCreateDialog button[type=submit]')
    await browser.waitFor("document.querySelector('#backupCreateDialog button[type=submit]').textContent === '确认生成并下载' && !document.querySelector('#backupCreateDialog button[type=submit]').disabled")
    await browser.key('Escape'); await browser.waitFor("!document.getElementById('backupCreateDialog')")
    await browser.click('#backupRestore'); await pick('#backupRestoreFile', file)
    await browser.fill('#backupRestoreParent', root); await browser.fill('#backupRestoreName', 'restored')
    await browser.click('#backupRestoreDialog button[type=submit]')
    await browser.waitFor("document.querySelector('#backupRestoreDialog button[type=submit]').textContent === '确认恢复到新目录' && !document.querySelector('#backupRestoreDialog button[type=submit]').disabled")
    await expect(fs.stat(path.join(root, 'restored'))).rejects.toMatchObject({ code: 'ENOENT' })
    await browser.click('#backupRestoreDialog button[type=submit]'); await browser.waitFor("document.getElementById('backupRestoreDialog').textContent.includes('恢复完成')")
    expect(await fs.readFile(path.join(root, 'restored', '.sakura/sessions', session.id, 'session.jsonl'), 'utf8')).toContain('KEEP_BACKUP_HISTORY')
    await browser.resize(320, 760); expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    await browser.key('Escape')
  })
  it('checks a wizard draft without connecting, diagnoses only after confirmation and saves disabled capabilities', async () => {
    const calls: string[] = []
    external = createServer((req, res) => { calls.push(req.url!); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, actions: [{ name: 'query', description: 'synthetic', parameters: { type: 'object' } }] })) })
    await new Promise<void>(resolve => external!.listen(0, '127.0.0.1', resolve))
    const url = 'http://127.0.0.1:' + (external.address() as { port: number }).port
    await settings('integrations'); await browser.click('#connectorWizardBtn'); await browser.waitFor("document.getElementById('wizardTemplate').options.length === 3")
    await browser.evaluate("document.getElementById('wizardTemplate').value='http-json-bridge';document.getElementById('wizardTemplate').dispatchEvent(new Event('change',{bubbles:true}))")
    await browser.fill('#wizardTarget', url); await browser.click('#connectorWizardDialog button[type=submit]')
    await browser.waitFor("!document.querySelector('.wizard-diagnose').disabled && !document.querySelector('#connectorWizardDialog button[type=submit]').disabled")
    expect(calls).toEqual([])
    await browser.click('.wizard-diagnose'); await browser.waitFor("document.getElementById('wizardConfirmDialog')?.open")
    await browser.key('Escape'); expect(calls).toEqual([])
    await browser.click('.wizard-diagnose'); await browser.click('#wizardConfirmDialog button[type=submit]')
    await browser.waitFor("document.getElementById('wizardReport').textContent.includes('capabilities') && !document.querySelector('#connectorWizardDialog button[type=submit]').disabled")
    expect(calls).toEqual(['/capabilities'])
    await browser.click('.wizard-save'); await browser.waitFor("!document.getElementById('connectorWizardDialog') && document.getElementById('connectorsList').textContent.includes('HTTP JSON bridge')")
    expect(calls).toEqual(['/capabilities'])
    expect(web.harness.ctx.tools.get('connector__http_bridge__query')).toBeUndefined()
  })
  it('creates an independent tree and explicitly starts its own model session', async () => {
    const tasks = web.harness.ctx.tasks!, saved = await tasks.store.upsert({ title: 'Independent UI', description: '', priority: 'medium', status: 'pending', steps: [], criteria: [], checkIds: [], archived: false }, await tasks.snapshot())
    await browser.click('#inspectorBtn'); await browser.click('#persistentTasks > summary')
    await browser.waitFor("document.querySelector('.task-isolated')")
    await browser.click('.task-isolated'); await browser.waitFor("document.getElementById('isolatedTaskDialog')?.open")
    await browser.click('.isolated-create'); await browser.waitFor("document.querySelector('.isolated-create').textContent === '确认创建目录（不启动）'", 30000)
    await browser.click('.isolated-create'); await browser.waitFor("document.querySelector('.isolated-create').hidden && document.getElementById('isolatedTaskDialog').textContent.includes('当前未运行')", 30000)
    const state = await (await fetch(web.url + 'api/state')).json() as { workspaceId: string }
    const list = await (await fetch(web.url + 'api/worktrees', { headers: { 'X-Sakura-Workspace': state.workspaceId } })).json() as { worktrees: WorktreeInfo[] }
    const info = list.worktrees.find(row => row.taskId === saved.tasks[0]!.id)!; extra.push(path.dirname(info.path))
    expect(adapter.stream).not.toHaveBeenCalled()
    await browser.click('.isolated-start'); await browser.waitFor("document.getElementById('isolatedStartDialog')?.open")
    await browser.click('#isolatedStartDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('isolatedStartDialog')", 15000)
    await browser.click('.isolated-refresh'); await browser.click('.isolated-history')
    await browser.waitFor("document.getElementById('isolatedHistoryDialog')?.textContent.includes('INDEPENDENT_UI_DONE')", 15000)
    expect(adapter.stream).toHaveBeenCalledTimes(1); expect(await fs.readFile(path.join(cwd, 'code.txt'), 'utf8')).toBe('baseline')
    await browser.key('Escape'); await browser.key('Escape')
  }, 60000)
})
