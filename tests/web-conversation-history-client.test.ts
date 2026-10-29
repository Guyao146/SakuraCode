/** Real Chromium message edit/rewind UX, including confirmation, drafts and races. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text, toolCall } from './helpers.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import type { LLMRequest } from '../src/core/types.js'
import { startHistoryBackgroundPreview } from './history-background-fixture.js'

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')
it('keeps valid single-file JavaScript with versioned, keyboard-operable history actions', () => {
  expect(() => new Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!)).not.toThrow()
  expect(html).toContain('historyConfirmed'); expect(html).toContain('historyTargetCurrent')
})
const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
suite('conversation history — real browser', () => {
  const browser = new BrowserClient(), dirs: string[] = [], servers: WebServerHandle[] = []
  beforeAll(() => browser.start())
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.navigate('about:blank')
    while (servers.length) await servers.pop()!.close()
    while (dirs.length) await fs.rm(dirs.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })
  async function boot(extra: Partial<WebServerOptions> = {}, loginToken?: string) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-history-ui-')); dirs.push(cwd)
    const requests: LLMRequest[] = []
    const server = await runWebServer({ cwd, adapter: new MockAdapter([req => { requests.push(req); return text('HISTORY_ANSWER') }]),
      approvalMode: 'yolo', quiet: true, open: false, token: null, viewerToken: null, updatesAutoCheck: false,
      config: { plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } } } }, ...extra })
    servers.push(server)
    await server.harness.run('KEEP_FIRST'); await server.harness.run('EDIT_OR_REWIND_ME')
    browser.errors.length = 0; await browser.resize(1440, 900); await browser.navigate(server.url)
    if (loginToken) {
      await browser.waitFor("document.getElementById('authDialog')?.open")
      await browser.fill('#authToken', loginToken); await browser.click('#authSubmit')
    }
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.waitFor("document.querySelectorAll('.msg-user-row [data-history-action]').length === 4")
    return { cwd, server, requests, sourceId: server.harness.main().sessionId }
  }
  async function lastAction(action: 'edit' | 'rewind') {
    const rows = await browser.evaluate<number>("document.querySelectorAll('.msg-user-row').length")
    const seq = await browser.evaluate<string>(`Array.from(document.querySelectorAll('.msg-user-row'))[${rows - 1}].dataset.userSeq`)
    await browser.click(`[data-user-seq="${seq}"] [data-history-action="${action}"]`)
    await browser.waitFor("document.getElementById('messageHistoryDialog')?.open && !document.getElementById('historyRefresh').disabled && document.getElementById('historyImpact').textContent.includes('原会话')")
  }
  async function choose(value: 'conversation' | 'code' | 'both') {
    await browser.evaluate(`(() => { const select=document.getElementById('historyMode');select.value=${JSON.stringify(value)};select.dispatchEvent(new Event('change',{bubbles:true})); })()`)
  }
  async function draft() {
    await browser.fill('#input', 'DRAFT_MUST_REMAIN')
    await browser.evaluate(`(() => { const data=new DataTransfer();data.items.add(new File(['UNSENT_DRAFT_FILE'],'draft.txt',{type:'text/plain'}));
      document.getElementById('fileInput').files=data.files;document.getElementById('fileInput').dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await browser.waitFor("document.querySelector('#attachRow [data-state=ready]')")
  }
  async function screenshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.join(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }

  it('cancels without sending, returns keyboard focus, and protects the separate composer draft', async () => {
    const f = await boot(); await draft(); await lastAction('edit')
    expect(await browser.evaluate("document.getElementById('historyEditText').value")).toBe('EDIT_OR_REWIND_ME')
    expect(await browser.evaluate("document.getElementById('historyApply').disabled")).toBe(true)
    await browser.typeText('#historyEditText', ' 中文编辑')
    await browser.key('Escape')
    await browser.waitFor("!document.getElementById('messageHistoryDialog')")
    expect(await browser.evaluate("document.activeElement.dataset.historyAction")).toBe('edit')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_MUST_REMAIN')
    expect(await browser.evaluate("document.getElementById('attachRow').textContent")).toContain('draft.txt')
    expect(f.requests).toHaveLength(2); expect(f.server.harness.main().sessionId).toBe(f.sourceId)
  })

  it('edits only the selected message, saves an independent branch and generates once without consuming the composer draft', async () => {
    const f = await boot(); await draft(); await lastAction('edit')
    await browser.fill('#historyEditText', 'REPLACED_USER_TASK'); await browser.click('#historyConfirmed')
    await browser.waitFor("!document.getElementById('historyApply').disabled")
    await browser.click('#historyApply')
    await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.getElementById('chatCol').textContent.includes('REPLACED_USER_TASK') && document.querySelectorAll('.msg-user-row').length === 2")
    await f.server.harness.main().wait()
    expect(f.requests).toHaveLength(3)
    const branch = await f.server.harness.ctx.sessions.open(f.server.harness.main().sessionId)
    expect(branch.id).not.toBe(f.sourceId)
    expect(branch.events.filter(record => record.type === 'user/message')).toHaveLength(2)
    expect(JSON.stringify(branch.events)).not.toContain('EDIT_OR_REWIND_ME')
    expect(JSON.stringify(f.requests.at(-1)!.messages)).not.toContain('UNSENT_DRAFT_FILE')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_MUST_REMAIN')
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('EDIT_OR_REWIND_ME')
    const original = await f.server.harness.ctx.sessions.open(f.sourceId)
    expect(JSON.stringify(original.events)).toContain('EDIT_OR_REWIND_ME')
    await screenshot('edited-branch')
    await browser.reload(); await browser.waitFor("document.getElementById('chatCol').textContent.includes('REPLACED_USER_TASK')")
    expect(f.requests).toHaveLength(3)
  })

  it.each(['edit', 'rewind'] as const)('previews and applies a conversation-only %s without stopping a real background preview or overwriting code', async action => {
    const requests: LLMRequest[] = []
    const f = await boot({ adapter: new MockAdapter([
      req => { requests.push(req); return text('KEPT_ANSWER') },
      req => { requests.push(req); return toolCall('write', JSON.stringify({ file_path: 'background-code.txt', content: 'BACKGROUND_CODE_KEEP' })) },
      req => { requests.push(req); return text('CODE_ANSWER') },
      req => { requests.push(req); return text('EDITED_BACKGROUND_ANSWER') },
    ]) })
    const source = await f.server.harness.ctx.sessions.open(f.sourceId), original = await fs.readFile(source.file)
    const background = await startHistoryBackgroundPreview(f.server.harness.ctx.jobs!, f.cwd)
    try {
      await draft(); await lastAction(action)
      expect(await browser.evaluate("document.getElementById('historyMode').value")).toBe('conversation')
      expect(await browser.evaluate("Array.from(document.getElementById('historyMode').options).filter(option=>option.value!=='conversation').every(option=>option.disabled)")).toBe(true)
      expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).toContain('后台命令')
      expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).toContain('background-code.txt')
      if (action === 'edit') await browser.fill('#historyEditText', 'EDITED_BACKGROUND_TASK')
      await browser.click('#historyConfirmed')
      await browser.waitFor("!document.getElementById('historyApply').disabled")
      await screenshot('background-' + action + '-conversation-preview')
      await browser.click('#historyApply')
      await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === " + (action === 'edit' ? 2 : 1))
      await f.server.harness.main().wait()
      expect(requests).toHaveLength(action === 'edit' ? 4 : 3)
      expect(f.server.harness.main().sessionId).not.toBe(f.sourceId)
      expect(await fs.readFile(source.file)).toEqual(original)
      expect(await fs.readFile(path.join(f.cwd, 'background-code.txt'), 'utf8')).toBe('BACKGROUND_CODE_KEEP')
      expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_MUST_REMAIN')
      expect(background.job.status).toBe('running')
      expect(await (await fetch(background.url)).text()).toBe('HISTORY_BACKGROUND_PREVIEW_ALIVE')
      await browser.reload()
      await browser.waitFor("document.querySelectorAll('.msg-user-row').length === " + (action === 'edit' ? 2 : 1))
      expect(requests).toHaveLength(action === 'edit' ? 4 : 3)
    } finally { await background.stop() }
  })

  it('refreshes code availability after a background preview exits without losing local edits or reusing confirmation', async () => {
    const f = await boot({ adapter: new MockAdapter([text('KEPT'), toolCall('write', JSON.stringify({ file_path: 'background-code.txt', content: 'BACKGROUND_CODE_KEEP' })), text('ANSWER')]) })
    const background = await startHistoryBackgroundPreview(f.server.harness.ctx.jobs!, f.cwd)
    try {
      await lastAction('edit'); await browser.fill('#historyEditText', 'LOCAL_BACKGROUND_EDIT')
      expect(await browser.evaluate("document.getElementById('historyMode').value")).toBe('conversation')
      expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).toContain('后台命令')
      await browser.click('#historyConfirmed'); await background.stop(); await browser.click('#historyRefresh')
      await browser.waitFor("!document.getElementById('historyRefresh').disabled && !document.querySelector('#historyMode option[value=both]').disabled")
      expect(await browser.evaluate("document.getElementById('historyEditText').value")).toBe('LOCAL_BACKGROUND_EDIT')
      expect(await browser.evaluate("document.getElementById('historyConfirmed').checked")).toBe(false)
      expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).not.toContain('后台命令')
      expect(await browser.evaluate("document.getElementById('historyApply').disabled")).toBe(true)
      await choose('both'); await browser.click('#historyConfirmed')
      expect(await browser.evaluate("document.getElementById('historyApply').disabled")).toBe(false)
      await browser.click('#historyCancel')
      expect(await fs.readFile(path.join(f.cwd, 'background-code.txt'), 'utf8')).toBe('BACKGROUND_CODE_KEEP')
      expect(f.server.harness.main().sessionId).toBe(f.sourceId)
    } finally { await background.stop() }
  })

  it('previews files and explicitly restores conversation plus code without a model request or overflow', async () => {
    const calls = [toolCall('write', JSON.stringify({ file_path: 'first.txt', content: 'keep' })), text('FIRST'),
      toolCall('write', JSON.stringify({ file_path: 'second.txt', content: 'remove' })), text('SECOND')]
    const f = await boot({ adapter: new MockAdapter(calls) }); await lastAction('rewind')
    expect(await browser.evaluate("document.getElementById('historyMode').value")).toBe('both')
    expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).toContain('second.txt')
    expect(await browser.evaluate("document.getElementById('historyApply').disabled")).toBe(true)
    await screenshot('rewind-preview-desktop')
    await browser.resize(390, 844)
    expect(await browser.evaluate("document.documentElement.scrollWidth > innerWidth")).toBe(false)
    expect(await browser.evaluate("document.getElementById('messageHistoryDialog').scrollWidth > document.getElementById('messageHistoryDialog').clientWidth")).toBe(false)
    await screenshot('rewind-preview-mobile'); await browser.click('#historyConfirmed'); await browser.click('#historyApply')
    await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 1")
    expect(await fs.readFile(path.join(f.cwd, 'first.txt'), 'utf8')).toBe('keep')
    await expect(fs.access(path.join(f.cwd, 'second.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.stringify((await f.server.harness.ctx.sessions.open(f.sourceId)).events)).toContain('EDIT_OR_REWIND_ME')
  })

  it('shows manual-file conflicts, disables code restore and permits only a confirmed conversation-only rewind', async () => {
    const f = await boot({ adapter: new MockAdapter([text('FIRST'), toolCall('write', JSON.stringify({ file_path: 'file.txt', content: 'agent' })), text('SECOND')]) })
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'MANUAL_WORK')
    await lastAction('rewind')
    expect(await browser.evaluate("document.getElementById('historyImpact').textContent")).toContain('手动修改')
    expect(await browser.evaluate("Array.from(document.getElementById('historyMode').options).filter(o=>o.value!=='conversation').every(o=>o.disabled)")).toBe(true)
    expect(await browser.evaluate("document.getElementById('historyMode').value")).toBe('conversation')
    await screenshot('rewind-conflict'); await browser.click('#historyConfirmed'); await browser.click('#historyApply')
    await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 1")
    expect(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8')).toBe('MANUAL_WORK')
  })

  it('restores code only without changing the current conversation or starting the model', async () => {
    const f = await boot({ adapter: new MockAdapter([text('FIRST'), toolCall('write', JSON.stringify({ file_path: 'code-only.txt', content: 'generated' })), text('SECOND')]) })
    await draft(); await lastAction('rewind'); await choose('code')
    expect(await browser.evaluate("document.getElementById('historyConfirmed').checked")).toBe(false)
    await browser.click('#historyConfirmed'); await browser.click('#historyApply')
    await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 2")
    expect(f.server.harness.main().sessionId).toBe(f.sourceId)
    await expect(fs.access(path.join(f.cwd, 'code-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_MUST_REMAIN')
    expect(await browser.evaluate("document.getElementById('attachRow').textContent")).toContain('draft.txt')
  })

  it('invalidates an open preview after a new persisted user message and requires refreshing/reconfirming', async () => {
    const f = await boot(); await lastAction('edit'); await browser.fill('#historyEditText', 'LOCAL_EDIT_KEEP'); await browser.click('#historyConfirmed')
    expect(await browser.evaluate("document.getElementById('historyApply').disabled")).toBe(false)
    await f.server.harness.run('NEWER_USER_TASK')
    await browser.waitFor("document.getElementById('historyApply').disabled && document.getElementById('historyBlocked').textContent.includes('更新')")
    expect(await browser.evaluate("document.getElementById('historyEditText').value")).toBe('LOCAL_EDIT_KEEP')
    await browser.click('#historyRefresh')
    await browser.waitFor("!document.getElementById('historyRefresh').disabled && document.getElementById('historyBlocked').hidden")
    expect(await browser.evaluate("document.getElementById('historyConfirmed').checked")).toBe(false)
    expect(await browser.evaluate("document.getElementById('historyEditText').value")).toBe('LOCAL_EDIT_KEEP')
    await browser.click('#historyCancel'); expect(f.requests).toHaveLength(3)
  })

  it('keeps edited text after rejection and never retries a failed regeneration automatically', async () => {
    const f = await boot(); await lastAction('edit'); await browser.fill('#historyEditText', 'FAILED_GENERATION_EDIT')
    await browser.evaluate(`window.nativeFetch=window.fetch;window.generateCalls=0;window.fetch=function(url,init){
      if(url==='/api/conversation/generate'){window.generateCalls++;return Promise.resolve(new Response(JSON.stringify({error:'generation unavailable'}),{status:503,headers:{'content-type':'application/json'}}));}
      return window.nativeFetch(url,init);}`)
    await browser.click('#historyConfirmed'); await browser.click('#historyApply')
    await browser.waitFor("document.getElementById('messageHistoryDialog')?.textContent.includes('编辑已保存') && !document.getElementById('historyCancel').disabled")
    expect(await browser.evaluate('window.generateCalls')).toBe(1); expect(f.requests).toHaveLength(2)
    expect(f.server.harness.main().sessionId).not.toBe(f.sourceId)
    await browser.click('#historyCancel'); await browser.waitFor("!document.getElementById('generateEditedMessage').hidden")
    await browser.evaluate('window.fetch=window.nativeFetch')
    await browser.click('#generateEditedMessage'); await browser.waitFor("document.getElementById('generateEditedMessage').hidden && document.getElementById('chatCol').textContent.includes('FAILED_GENERATION_EDIT')")
    await f.server.harness.main().wait(); expect(f.requests).toHaveLength(3)
  })

  it('hides write actions for viewers and rejects their history writes', async () => {
    const token = 'history-ui-operator-' + 'x'.repeat(40), viewer = 'history-ui-viewer-' + 'y'.repeat(40)
    const f = await boot({ token, viewerToken: viewer }, viewer)
    expect(await browser.evaluate("Array.from(document.querySelectorAll('[data-history-action]')).every(button=>button.hidden && button.disabled)")).toBe(true)
    expect(await browser.evaluate(`fetch('/api/sessions/${f.sourceId}/history/preview',{method:'POST',headers:{'content-type':'application/json'},body:'{"turnSeq":2}'}).then(r=>r.status)`)).toBe(403)
  })

  it('ignores a late preview after the session changes and closes the obsolete confirmation', async () => {
    const f = await boot()
    await browser.evaluate(`window.nativeFetch=window.fetch;window.previewResponseReady=false;window.previewReturned=false;
      window.fetch=async function(url,init){const response=await window.nativeFetch(url,init);if(String(url).endsWith('/history/preview')){
        window.previewResponseReady=true;await new Promise(resolve=>window.releasePreview=resolve);window.previewReturned=true;}return response;}`)
    const seq = await browser.evaluate<string>("Array.from(document.querySelectorAll('.msg-user-row')).at(-1).dataset.userSeq")
    await browser.click(`[data-user-seq="${seq}"] [data-history-action="edit"]`)
    await browser.waitFor('window.previewResponseReady')
    const response = await fetch(f.server.url + 'api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(response.status).toBe(200)
    await browser.evaluate('window.releasePreview()')
    await browser.waitFor("window.previewReturned && !document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 0")
    expect(f.requests).toHaveLength(2)
    expect(f.server.harness.main().sessionId).not.toBe(f.sourceId)
  })

  it('synchronizes a rewind to a second authenticated browser without granting viewer write controls', async () => {
    const token = 'history-two-operator-' + 'a'.repeat(40), viewer = 'history-two-viewer-' + 'b'.repeat(40)
    const f = await boot({ token, viewerToken: viewer }, token), observer = new BrowserClient()
    try {
      await observer.start(); await observer.navigate(f.server.url)
      await observer.waitFor("document.getElementById('authDialog')?.open")
      await observer.fill('#authToken', viewer); await observer.click('#authSubmit')
      await observer.waitFor("document.querySelectorAll('.msg-user-row').length === 2")
      await lastAction('rewind'); await browser.click('#historyConfirmed'); await browser.click('#historyApply')
      await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 1")
      await observer.waitFor("document.querySelectorAll('.msg-user-row').length === 1 && document.getElementById('chatCol').textContent.includes('KEEP_FIRST')")
      expect(await observer.evaluate("document.getElementById('chatCol').textContent")).not.toContain('EDIT_OR_REWIND_ME')
      expect(await observer.evaluate("Array.from(document.querySelectorAll('[data-history-action]')).every(button=>button.hidden && button.disabled)")).toBe(true)
      expect(observer.errors).toEqual([]); expect(f.requests).toHaveLength(2)
    } finally { await observer.close() }
  })

  it('does not regenerate or retain an obsolete dialog after a delayed edit response arrives in a newer conversation', async () => {
    const f = await boot(); await draft(); await lastAction('edit'); await browser.fill('#historyEditText', 'STALE_EDIT_RESULT')
    await browser.evaluate(`window.nativeFetch=window.fetch;window.editResponseReady=false;window.editReturned=false;
      window.fetch=async function(url,init){const response=await window.nativeFetch(url,init);if(String(url).endsWith('/history/edit')){
        window.editResponseReady=true;await new Promise(resolve=>window.releaseEdit=resolve);window.editReturned=true;}return response;}`)
    await browser.click('#historyConfirmed'); await browser.click('#historyApply'); await browser.waitFor('window.editResponseReady')
    const nextResponse = await fetch(f.server.url + 'api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(nextResponse.status).toBe(200)
    const next = await nextResponse.json() as { sessionId: string }
    await browser.evaluate('window.releaseEdit()')
    await browser.waitFor("window.editReturned && !document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 0")
    expect(f.server.harness.main().sessionId).toBe(next.sessionId)
    expect(f.requests).toHaveLength(2)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_MUST_REMAIN')
  })
})