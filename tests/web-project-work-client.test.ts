/** UI acceptance for local tasks, raw Git review and explicitly updated knowledge. */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import type { TasksService } from '../src/tasks/service.js'
import { MockAdapter, text } from './helpers.js'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'

const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
suite('persistent tasks, Git review and knowledge versions — real browser', () => {
  const browser = new BrowserClient()
  let cwd = '', web: WebServerHandle, adapter: MockAdapter
  const extraRoots: string[] = []
  beforeAll(async () => { await browser.start() })
  afterAll(async () => { await browser.close() })
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  async function launch() {
    adapter = new MockAdapter([text('must-not-run-model')])
    web = await runWebServer({ cwd, adapter, open: false, quiet: true, approvalMode: 'yolo', updatesAutoCheck: false,
      onPersistSettings: () => {},
      config: { plugins: { 'core-memory-processing': { disabled: true }, 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } } })
    browser.errors.length = 0; await browser.resize(1440, 960); await browser.navigate(web.url)
    await browser.waitFor("document.documentElement.dataset.boot === 'ready' && document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  }
  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-workflow-ui-'))
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid'); git('config', 'core.autocrlf', 'false')
    await fs.writeFile(path.join(cwd, 'guide.txt'), 'before\n'); git('add', 'guide.txt'); git('commit', '-m', 'fixture')
    await launch()
  })
  afterEach(async () => {
    const errors = [...browser.errors]; await browser.navigate('about:blank'); await web.close()
    await fs.rm(cwd, { recursive: true, force: true, maxRetries: 4 });
    while (extraRoots.length) await fs.rm(extraRoots.pop()!, { recursive: true, force: true, maxRetries: 4 })
    expect(errors).toEqual([])
  })
  async function tasksPanel() {
    if (!await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded') === 'true'")) await browser.click('#inspectorBtn')
    if (!await browser.evaluate("document.getElementById('persistentTasks').open")) await browser.click('#persistentTasks > summary')
    await browser.waitFor("!document.getElementById('taskRefresh').disabled && document.getElementById('tasksStatus').textContent.length > 0")
  }
  async function setSelect(selector: string, value: string) {
    await browser.evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); select.value = ${JSON.stringify(value)}; select.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  }
  async function fileInput(selector: string, files: string[]) {
    await browser.send('DOM.enable'); const document = await browser.send('DOM.getDocument')
    const input = await browser.send('DOM.querySelector', { nodeId: document.root.nodeId, selector })
    await browser.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files })
  }
  async function seedTask(command: string) {
    const tasks = web.harness.ctx.tasks as TasksService
    const checks = await tasks.store.saveChecks([{ id: 'verify', name: 'Synthetic check', shell: 'bash', command, workdir: '.', timeoutMs: 3000, required: true }], await tasks.store.snapshot())
    await tasks.store.upsert({ title: 'UI validation task', description: '', status: 'completed', priority: 'medium', steps: [], criteria: ['Must pass'], checkIds: ['verify'], archived: false }, checks)
    return tasks
  }

  it('saves real task and check forms, cancels execution, validates once and restores cards after server restart', async () => {
    await browser.fill('#input', 'KEEP_TASK_DRAFT')
    await tasksPanel(); await browser.click('#taskChecks')
    await browser.waitFor("document.getElementById('taskChecksDialog')?.open")
    await browser.click('.task-check-add')
    await browser.fill('[data-check-field=name]', '真实退出检查')
    await browser.fill('[data-check-field=command]', 'printf "TASK_SUCCESS"; exit 0')
    await browser.click('#taskChecksDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('taskChecksDialog')")
    await browser.click('#taskNew'); await browser.waitFor("document.getElementById('taskDialog')?.open")
    await browser.fill('#taskTitle', '持久任务 <script>bad()</script>'); await browser.fill('#taskCriteria', '测试通过\n保留草稿')
    await browser.fill('#taskSteps', '[x] 实现\n[x] 检查'); await setSelect('#taskStatus', 'completed')
    await browser.click('#taskCheckChoices input[type=checkbox]'); await browser.click('#taskDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('taskDialog') && document.querySelectorAll('#taskCards .task-card').length === 1")
    expect(await browser.evaluate("document.getElementById('taskCards').textContent")).toContain('<script>bad()</script>')
    await browser.click('.task-verify'); await browser.waitFor("document.getElementById('taskVerifyDialog')?.open")
    await browser.key('Escape'); await browser.waitFor("!document.getElementById('taskVerifyDialog')")
    expect((await web.harness.ctx.tasks!.snapshot()).runs).toHaveLength(0)
    await browser.click('.task-verify'); await browser.click('#taskVerifyDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('taskVerifyDialog') && document.getElementById('taskCards').textContent.includes('验证通过')", 20000)
    expect((await web.harness.ctx.tasks!.snapshot()).runs).toHaveLength(1)
    await browser.click('.task-report'); await browser.waitFor("document.getElementById('taskReportDialog')?.textContent.includes('TASK_SUCCESS')")
    expect(await browser.evaluate("document.getElementById('taskReportDialog').textContent")).toContain('退出码 0')
    await browser.key('Escape'); await browser.waitFor("!document.getElementById('taskReportDialog')")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('KEEP_TASK_DRAFT')
    await browser.click('.task-accept'); await browser.click('#taskAcceptDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('taskAcceptDialog') && document.getElementById('taskCards').textContent.includes('已人工验收')")
    await browser.resize(320, 760)
    expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    await browser.navigate('about:blank'); await web.close(); await launch(); await tasksPanel()
    expect(await browser.evaluate("document.getElementById('taskCards').textContent")).toContain('持久任务')
    expect((await web.harness.ctx.tasks!.snapshot()).runs).toHaveLength(1)
  })

  it('keeps the real approval usable during validation and starts no command after denial', async () => {
    await seedTask('touch DENIED_MUST_NOT_EXIST')
    await fetch(web.url + 'api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalMode: 'default' }) })
    await tasksPanel(); await browser.click('.task-verify'); await browser.click('#taskVerifyDialog button[type=submit]')
    await browser.waitFor("!document.getElementById('taskVerifyDialog') && document.querySelector('.approval-card:not(.resolved) .ap-actions .btn-soft:not(:disabled)')", 20000)
    expect(await browser.evaluate("document.getElementById('sendBtn').disabled && !document.getElementById('input').disabled")).toBe(true)
    await browser.click('.approval-card:not(.resolved) .ap-actions .btn-soft')
    await browser.waitFor("document.getElementById('taskCards').textContent.includes('未获批准')", 20000)
    await expect(fs.stat(path.join(cwd, 'DENIED_MUST_NOT_EXIST'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains the task editor draft on a real revision conflict', async () => {
    const tasks = await seedTask('exit 0'); await tasksPanel(); await browser.click('.task-edit')
    await browser.fill('#taskTitle', 'DRAFT_CONFLICT_KEEP')
    const snapshot = await tasks.snapshot(), existing = snapshot.tasks[0]!
    const { createdAt, updatedAt, acceptance, definitionHash, ...editable } = existing
    await tasks.store.upsert({ ...editable, title: 'Changed elsewhere' }, snapshot)
    await browser.click('#taskDialog button[type=submit]'); await browser.waitFor("!document.querySelector('#taskDialog .form-error').hidden")
    expect(await browser.evaluate("document.getElementById('taskTitle').value")).toBe('DRAFT_CONFLICT_KEEP')
    expect((await tasks.snapshot()).tasks[0]!.title).toBe('Changed elsewhere')
    await browser.key('Escape')
  })

  it('shows command-written Git changes, persists reviewed marks and invalidates them after content changes', async () => {
    await fs.writeFile(path.join(cwd, 'guide.txt'), 'after by command\n')
    await fs.writeFile(path.join(cwd, 'untracked.txt'), 'UNTRACKED_SECRET_NOT_AUTO_READ')
    await browser.click('#inspectorBtn'); await browser.click('#changesTab'); await browser.click('#changesGitTab')
    await browser.waitFor("document.getElementById('gitFiles').textContent.includes('guide.txt') && !document.getElementById('gitRefresh').disabled", 20000)
    await browser.click('#gitFiles details summary')
    expect(await browser.evaluate("document.getElementById('gitFiles').textContent")).toContain('after by command')
    await browser.click('.git-mark-file')
    await browser.waitFor("document.getElementById('gitFiles').textContent.includes('已审阅') && !document.getElementById('gitRefresh').disabled", 20000)
    await browser.click('#gitRefresh'); await browser.waitFor("!document.getElementById('gitRefresh').disabled && document.getElementById('gitFiles').textContent.includes('已审阅')", 20000)
    await fs.writeFile(path.join(cwd, 'guide.txt'), 'different\n')
    await browser.click('#gitRefresh'); await browser.waitFor("!document.getElementById('gitRefresh').disabled && document.getElementById('gitFiles').textContent.includes('different')", 20000)
    expect(await browser.evaluate("document.querySelector('#gitFiles summary').textContent")).not.toContain('已审阅')
    await setSelect('#gitRange', 'untracked')
    expect(await browser.evaluate("document.getElementById('gitFiles').textContent")).not.toContain('UNTRACKED_SECRET_NOT_AUTO_READ')
    await browser.evaluate("Array.from(document.querySelectorAll('#gitFiles details')).find(row => row.textContent.includes('untracked.txt')).open = true")
    const readSelector = await browser.evaluate<string>("(() => { const row = Array.from(document.querySelectorAll('#gitFiles details')).find(row => row.textContent.includes('untracked.txt')); return '[data-git-file=\"' + row.dataset.gitFile + '\"] .git-read-file'; })()")
    await browser.click(readSelector); await browser.waitFor("document.getElementById('gitFiles').textContent.includes('UNTRACKED_SECRET_NOT_AUTO_READ')", 20000)
    await browser.resize(320, 760); expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    expect(git('diff', '--', 'guide.txt')).toContain('different')
  })

  it.each(['/api/tasks', '/api/git-review'])('discards delayed %s results and closes old dialogs on a real workspace remount', async route => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-other-ui-')); extraRoots.push(other)
    if (route === '/api/tasks') await seedTask('exit 0')
    else await fs.writeFile(path.join(cwd, 'guide.txt'), 'OLD_WORKSPACE_DIFF')
    await browser.evaluate(`window.heldLocalReady = false; window.heldLocalReleased = false; window.originalLocalFetch = window.fetch;
      window.fetch = async function(url, init) { const response = await window.originalLocalFetch(url, init);
        if (String(url).split('?')[0] === ${JSON.stringify(route)} && !window.heldLocalReady) { window.heldLocalReady = true; await new Promise(resolve => { window.releaseLocalFetch = resolve; }); window.heldLocalReleased = true; } return response; };`)
    try {
      await browser.click('#inspectorBtn')
      if (route === '/api/tasks') await browser.click('#persistentTasks > summary')
      else { await browser.click('#changesTab'); await browser.click('#changesGitTab') }
      await browser.waitFor('window.heldLocalReady', 20000)
      const response = await fetch(web.url + 'api/desktop/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: other }) })
      expect(response.status).toBe(200)
      await browser.waitFor(`document.getElementById('projectName').textContent.includes(${JSON.stringify(path.basename(other))})`)
      await browser.evaluate('window.fetch = window.originalLocalFetch; window.releaseLocalFetch()')
      await browser.waitFor('window.heldLocalReleased')
      expect(await browser.evaluate("document.getElementById('taskCards').textContent")).not.toContain('UI validation task')
      expect(await browser.evaluate("document.getElementById('gitFiles').textContent")).not.toContain('OLD_WORKSPACE_DIFF')
      expect(await browser.evaluate("document.querySelectorAll('.local-detail-modal').length")).toBe(0)
    } finally { await browser.evaluate('window.fetch = window.originalLocalFetch; if (window.releaseLocalFetch) window.releaseLocalFetch()') }
  })

  it('adopts, previews, cancels, publishes and restores knowledge without replacing old references', async () => {
    const old = await web.harness.ctx.get<import('../src/knowledge/index.js').KnowledgeStore>('knowledge').importFiles({ files: [{ path: 'manual.md', content: 'OLD_KNOWLEDGE_ONLY' }] })
    await browser.click('#settingsViewBtn'); await browser.click('[data-settings-section=workspace]');
    await browser.waitFor("!document.getElementById('knowledgeCard').hidden && !document.getElementById('knowledgeVersionsBtn').disabled && !document.getElementById('knowledgeRefresh').disabled")
    await browser.click('#knowledgeVersionsBtn')
    await browser.waitFor("document.querySelector('#knowledgeVersionsDialog .knowledge-adopt')")
    await browser.click('.knowledge-adopt'); await browser.waitFor("document.getElementById('knowledgeAdoptDialog')?.open"); await browser.click('#knowledgeAdoptDialog button[type=submit]')
    await browser.waitFor("document.querySelector('#knowledgeVersionsDialog .knowledge-update')")
    await browser.click('.knowledge-update'); await browser.waitFor("document.getElementById('knowledgeUpdateDialog')?.open")
    const update = path.join(cwd, 'manual.md'); await fs.writeFile(update, 'NEW_KNOWLEDGE_ONLY')
    await fileInput('#knowledgeUpdateFiles', [update]); await browser.click('#knowledgeUpdateDialog button[type=submit]')
    await browser.waitFor("document.getElementById('knowledgeUpdatePreview').textContent.includes('修改 1') && !document.querySelector('#knowledgeUpdateDialog button[type=submit]').disabled")
    await browser.evaluate(`window.cancelledKnowledgePreview = false; window.knowledgeCancelFetch = window.fetch; window.fetch = async function(url, init) {
      const result = await window.knowledgeCancelFetch(url, init); if (String(url).endsWith('/api/knowledge/versions/cancel') && result.ok) window.cancelledKnowledgePreview = true; return result; };`)
    await browser.key('Escape'); await browser.waitFor("!document.getElementById('knowledgeUpdateDialog') && window.cancelledKnowledgePreview")
    await browser.evaluate('window.fetch = window.knowledgeCancelFetch')
    const knowledge = web.harness.ctx.get<import('../src/knowledge/index.js').KnowledgeStore>('knowledge')
    expect((await knowledge.getVersionState()).collections[0]!.versions).toHaveLength(1)
    await browser.click('#knowledgeVersionsBtn'); await browser.waitFor("document.querySelector('.knowledge-update')")
    await browser.click('.knowledge-update'); await fileInput('#knowledgeUpdateFiles', [update]); await browser.click('#knowledgeUpdateDialog button[type=submit]')
    await browser.waitFor("document.querySelector('#knowledgeUpdateDialog button[type=submit]').textContent === '确认发布新版本' && !document.querySelector('#knowledgeUpdateDialog button[type=submit]').disabled")
    await browser.click('#knowledgeUpdateDialog button[type=submit]')
    await browser.waitFor("document.getElementById('knowledgeVersionCollections')?.textContent.includes('版本 2 · 当前')")
    expect((await knowledge.search('NEW_KNOWLEDGE_ONLY')).results).toHaveLength(1)
    expect((await knowledge.search('OLD_KNOWLEDGE_ONLY')).results).toHaveLength(0)
    expect((await knowledge.read(old.documents[0]!.id)).content).toBe('OLD_KNOWLEDGE_ONLY')
    await browser.evaluate("Array.from(document.querySelectorAll('#knowledgeVersionCollections details')).forEach(row => row.open = true)")
    await browser.click('.knowledge-activate'); await browser.waitFor("document.getElementById('knowledgeActivateDialog')?.open")
    await browser.click('#knowledgeActivateDialog button[type=submit]'); await browser.waitFor("document.getElementById('knowledgeVersionCollections')?.textContent.includes('版本 1 · 当前')")
    expect((await knowledge.search('OLD_KNOWLEDGE_ONLY')).results).toHaveLength(1)
    await browser.resize(320, 760); expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    await browser.key('Escape')
  })
})
