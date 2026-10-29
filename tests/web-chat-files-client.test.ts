/** Native Chromium drag/file-picker/paste, bounded drafts, expert header and replay. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { resolveChromePath } from '../src/tools/browser.js'
import type { LLMRequest } from '../src/core/types.js'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text } from './helpers.js'

const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg=='
suite('chat files and expert header — real browser', () => {
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
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-chat-files-ui-')); dirs.push(cwd)
    const requests: LLMRequest[] = []
    const server = await runWebServer({ cwd, adapter: new MockAdapter([request => { requests.push(request); return text('FILES_UI_ACCEPTED') }]),
      quiet: true, open: false, token: null, viewerToken: null, updatesAutoCheck: false, onPersistSettings() {}, ...extra })
    servers.push(server); browser.errors.length = 0
    await browser.resize(1440, 900); await browser.navigate(server.url)
    if (loginToken) {
      await browser.evaluate(`(async () => { const response=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:${JSON.stringify(loginToken)}})}); if(!response.ok) throw new Error('fixture login failed'); })()`)
      await browser.reload()
    }
    await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    return { cwd, server, requests }
  }
  function fileScript(name: string, contents: string | Buffer, type = '') {
    const base64 = Buffer.from(contents).toString('base64')
    return `new File([Uint8Array.from(atob(${JSON.stringify(base64)}), c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:${JSON.stringify(type)}})`
  }
  async function drop(files: string[], selector = '#input') {
    return browser.evaluate<{ prevented: boolean; overlay: boolean }>(`(() => {
      const target=document.querySelector(${JSON.stringify(selector)}), data=new DataTransfer();
      [${files.join(',')}].forEach(file=>data.items.add(file));
      target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));
      const overlay=!document.getElementById('chatDropOverlay').hidden;
      target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data}));
      const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}); target.dispatchEvent(event);
      return {prevented:event.defaultPrevented,overlay};
    })()`)
  }
  async function ready(count: number) {
    await browser.waitFor(`document.querySelectorAll('#attachRow .file-chip').length===${count} && !document.querySelector('#attachRow [data-state="reading"]')`)
  }
  async function screenshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }

  async function holdResponse(route: string, status?: number) {
    await browser.evaluate(`window.originalFetch=window.fetch;window.heldRequestReady=false;window.heldRequestReleased=false;
      window.fetch=async function(url,init){
        if(url!==${JSON.stringify(route)})return window.originalFetch(url,init);
        const response=${status ? `new Response(JSON.stringify({error:'OLD_SESSION_ERROR'}),{status:${status},headers:{'content-type':'application/json'}})` : 'await window.originalFetch(url,init)'};
        window.heldRequestReady=true;
        await new Promise(resolve=>{window.releaseHeldRequest=resolve});
        window.heldRequestReleased=true;return response;
      };`)
  }

  async function createSession() {
    await browser.evaluate("(async()=>{const response=await fetch('/api/sessions',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});if(!response.ok)throw new Error('fixture switch failed');window.fixtureSession=(await response.json()).sessionId;})()")
    await browser.waitFor("document.querySelector('.session-item.active')?.dataset.sessionId===window.fixtureSession")
  }

  it('clears pending files when the current session is deleted, without changing the text draft', async () => {
    const { requests } = await boot()
    await createSession()
    await browser.fill('#input', '保留文字草稿')
    await drop([fileScript('old-session.txt', 'PRIVATE_OLD_SESSION_FILE')]); await ready(1)
    await browser.evaluate("(async()=>{const response=await fetch('/api/sessions/'+window.fixtureSession,{method:'DELETE'});if(!response.ok)throw new Error('fixture deletion failed');})()")
    await browser.waitFor("!document.querySelector('.session-item.active') && document.getElementById('sessionHeading').textContent==='新会话'")
    expect(await browser.evaluate("document.getElementById('attachRow').hidden")).toBe(true)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留文字草稿')
    expect(requests).toHaveLength(0)
  })

  it.each([202, 409])('ignores a late %i send response after switching sessions, even when the new draft has identical text', async status => {
    const { requests, server } = await boot()
    await createSession()
    await browser.fill('#input', '相同文字的新草稿')
    await drop([fileScript('old.txt', 'OLD_RESPONSE_FILE')]); await ready(1)
    await holdResponse('/api/message', status === 409 ? status : undefined)
    try {
      await browser.click('#sendBtn'); await browser.waitFor('window.heldRequestReady')
      await server.harness.main().wait()
      await createSession()
      await browser.fill('#input', '相同文字的新草稿')
      await drop([fileScript('new.txt', 'NEW_SESSION_DRAFT')]); await ready(1)
    } finally { await browser.evaluate('window.fetch=window.originalFetch;if(window.releaseHeldRequest)window.releaseHeldRequest()') }
    await browser.waitFor('window.heldRequestReleased && !document.getElementById("sendBtn").disabled')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('相同文字的新草稿')
    await ready(1)
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('OLD_SESSION_ERROR')
    expect(requests).toHaveLength(status === 202 ? 1 : 0)
  })

  it('does not restore old expert-mode state after a delayed response and a real session switch', async () => {
    const { requests } = await boot()
    await createSession(); await holdResponse('/api/experts/start')
    try {
      await browser.click('#expertChip'); await browser.waitFor('window.heldRequestReady')
      await createSession()
      await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed')==='false'")
    } finally { await browser.evaluate('window.fetch=window.originalFetch;if(window.releaseHeldRequest)window.releaseHeldRequest()') }
    await browser.waitFor('window.heldRequestReleased && !document.getElementById("expertChip").disabled')
    expect(await browser.evaluate("document.getElementById('expertChip').getAttribute('aria-pressed')")).toBe('false')
    expect(requests).toHaveLength(0)
  })

  it('keeps drafts editable but blocks sending while the expert toggle is awaiting confirmation', async () => {
    const { requests } = await boot()
    await browser.fill('#input', '不要在专家开关未确认时发送')
    await holdResponse('/api/experts/start')
    try {
      await browser.click('#expertChip'); await browser.waitFor('window.heldRequestReady')
      expect(await browser.evaluate("document.getElementById('sendBtn').disabled")).toBe(true)
      expect(await browser.evaluate("document.getElementById('input').disabled")).toBe(false)
      await browser.click('#input'); await browser.key('Enter')
      await browser.evaluate('new Promise(resolve=>setTimeout(resolve,150))')
      expect(requests).toHaveLength(0)
    } finally { await browser.evaluate('window.fetch=window.originalFetch;if(window.releaseHeldRequest)window.releaseHeldRequest()') }
  })

  it('marks aborted file reads as failed instead of leaving the send button disabled forever', async () => {
    await boot()
    await browser.evaluate("window.originalRead=FileReader.prototype.readAsDataURL;FileReader.prototype.readAsDataURL=function(){const reader=this;setTimeout(()=>reader.dispatchEvent(new ProgressEvent('abort')),0)}")
    try {
      await drop([fileScript('aborted.txt', 'ABORTED_READER')])
      await browser.evaluate('new Promise(resolve=>setTimeout(resolve,100))')
      expect(await browser.evaluate("document.querySelector('#attachRow .file-chip').dataset.state")).toBe('error')
      await browser.click('#attachRow .attach-remove')
      expect(await browser.evaluate("document.getElementById('sendBtn').disabled")).toBe(false)
    } finally { await browser.evaluate('FileReader.prototype.readAsDataURL=window.originalRead') }
  })

  it('drops text, binary and an image anywhere in chat, previews safely, sends explicitly and replays cards', async () => {
    const { server, requests } = await boot()
    const hostileName = '<img src=x onerror=alert(1)>.txt'
    expect(await drop([fileScript(hostileName, 'RAW_FILE_CONTEXT'), fileScript('report.pdf', '%PDF-1.7\nBINARY_PDF_DATA'),
      fileScript('图片.png', Buffer.from(png, 'base64'), 'image/png')], '#chatScroll')).toEqual({ prevented: true, overlay: true })
    await ready(3)
    expect(await browser.evaluate("document.getElementById('chatDropOverlay').hidden")).toBe(true)
    expect(await browser.evaluate("document.querySelectorAll('#attachRow .file-copy strong').length")).toBe(3)
    expect(await browser.evaluate("document.querySelectorAll('#attachRow .file-copy img').length")).toBe(0)
    expect(await browser.evaluate("document.querySelector('#attachRow .file-copy strong').textContent")).toBe(hostileName)
    expect(await browser.evaluate("document.getElementById('fileInput').accept")).toBe('')
    expect(await browser.evaluate("document.getElementById('attachmentStatus').textContent")).toContain('点击发送才上传')
    expect(requests).toHaveLength(0)
    await screenshot('chat-files-draft-desktop')
    await browser.fill('#input', '请检查附件'); await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('FILES_UI_ACCEPTED') && document.getElementById('attachRow').hidden")
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.messages)).toContain('RAW_FILE_CONTEXT')
    expect(JSON.stringify(requests[0]!.messages)).not.toContain('BINARY_PDF_DATA')
    expect(JSON.stringify(requests[0]!.messages)).toContain(png)
    await server.harness.main().wait()
    await browser.reload()
    await browser.waitFor("document.querySelectorAll('.user-msg-files .file-chip').length === 3")
    expect(await browser.evaluate("document.querySelector('.msg-user').textContent")).toBe('请检查附件')
    expect(await browser.evaluate("document.querySelector('.user-msg-files').textContent")).toContain('未解析正文')
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('RAW_FILE_CONTEXT')
    for (const width of [1440, 1024, 390, 320]) {
      await browser.resize(width, 900)
      expect(await browser.evaluate<boolean>(`(() => {
        const row=document.querySelector('.msg-user-row'), bubble=row.querySelector('.msg-user'), files=row.querySelector('.user-msg-files');
        const r=row.getBoundingClientRect(), b=bubble.getBoundingClientRect(), f=files.getBoundingClientRect();
        const images=row.querySelector('.user-msg-imgs')?.getBoundingClientRect();
        return f.top>=b.bottom && (!images || images.top>=b.bottom && f.top>=images.bottom) &&
          b.left>=r.left-1 && b.right<=r.right+1 && f.left>=r.left-1 && f.right<=r.right+1 &&
          document.documentElement.scrollWidth<=innerWidth+1;
      })()`), `sent message and attachments stack at width ${width}`).toBe(true)
    }
    await browser.resize(1440, 900)
    await screenshot('chat-files-sent-replay')
  })

  it('uses real file-picker bytes, removable cards, clipboard images and attachment-only sends', async () => {
    const { cwd, requests } = await boot()
    const selected = [path.join(cwd, 'picked.txt'), path.join(cwd, 'picked.bin')]
    await fs.writeFile(selected[0]!, 'PICKER_REAL_BYTES'); await fs.writeFile(selected[1]!, Buffer.from([0, 255, 1]))
    const { root } = await browser.send('DOM.getDocument'), node = await browser.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' })
    await browser.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: selected })
    await ready(2)
    await browser.click('#attachRow .file-chip:last-child .attach-remove')
    await ready(1)
    expect(await browser.evaluate('document.activeElement.id')).toBe('input')
    const pasted = await browser.evaluate<boolean>(`(() => { const data=new DataTransfer();data.items.add(${fileScript('clipboard.png', Buffer.from(png, 'base64'), 'image/png')});const event=new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data});document.getElementById('input').dispatchEvent(event);return event.defaultPrevented; })()`)
    expect(pasted).toBe(true); await ready(2)
    expect(requests).toHaveLength(0)
    await browser.click('#sendBtn'); await browser.waitFor("document.getElementById('chatCol').textContent.includes('FILES_UI_ACCEPTED')")
    expect(JSON.stringify(requests[0]!.messages)).toContain('PICKER_REAL_BYTES')
    expect(await fs.readFile(selected[0]!, 'utf8')).toBe('PICKER_REAL_BYTES')
    expect(await fs.readFile(selected[1]!)).toEqual(Buffer.from([0, 255, 1]))
  })

  it('shows expert mode only at the top, preserves drafts, sends every expert its files and survives reload', async () => {
    const { requests, server } = await boot()
    expect(await browser.evaluate("document.querySelector('.topbar').contains(document.getElementById('expertChip')) && !document.querySelector('.composer').contains(document.getElementById('expertChip'))")).toBe(true)
    await browser.fill('#input', '专家处理这份文件'); await drop([fileScript('专家任务.md', 'EXPERT_SHARED_FILE')]); await ready(1)
    await browser.click('#expertChip')
    await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed') === 'true' && !document.getElementById('expertChip').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('专家处理这份文件')
    await ready(1); expect(requests).toHaveLength(0)
    await screenshot('expert-mode-top-draft')
    await browser.click('#sendBtn')
    await vi.waitFor(() => expect(requests).toHaveLength(4), { timeout: 8000 })
    await Promise.all(server.harness.ctx.agents.list().map(agent => agent.wait()))
    expect(requests.every(request => JSON.stringify(request.messages).includes('EXPERT_SHARED_FILE'))).toBe(true)
    await browser.reload(); await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 协同中'")
    await browser.click('#expertChip'); await browser.waitFor("document.getElementById('expertChip').textContent === '专家 · 关闭'")
    expect(requests).toHaveLength(4)
  })

  it('keeps the header/file cards inside narrow Web and native-shell surfaces without horizontal overflow', async () => {
    for (const desktop of [false, true]) {
      await boot(desktop ? { onWindowAction() {} } : {})
      await drop([fileScript('很长的文件名'.repeat(15) + '.txt', 'preview')]); await ready(1)
      for (const width of [1440, 1024, 780, 390, 320]) {
        await browser.resize(width, 900)
        expect(await browser.evaluate<boolean>(`(() => {
          const expert=document.getElementById('expertChip'), r=expert.getBoundingClientRect(), header=expert.closest('header').getBoundingClientRect();
          return expert.checkVisibility() && r.left>=header.left && r.right<=innerWidth && document.documentElement.scrollWidth<=innerWidth+1 &&
            document.getElementById('attachRow').scrollWidth<=document.getElementById('attachRow').clientWidth+1;
        })()`), `width ${width}, desktop ${desktop}`).toBe(true)
      }
      await screenshot(desktop ? 'expert-top-desktop-narrow' : 'expert-top-web-narrow')
    }
  })

  it('reports caps and file read errors without discarding valid drafts, and retains files after rejected sends', async () => {
    const { requests } = await boot()
    await browser.fill('#input', '保留这份草稿')
    await drop([fileScript('keep.txt', 'KEEP_FILE')]); await ready(1)
    await drop(["new File([new Uint8Array(8*1024*1024+1)],'too-large.bin')"])
    expect(await browser.evaluate("document.getElementById('attachmentStatus').textContent")).toContain('8 MiB'); await ready(1)
    await browser.evaluate("window.originalRead=FileReader.prototype.readAsDataURL; FileReader.prototype.readAsDataURL=function(){const reader=this;setTimeout(()=>reader.dispatchEvent(new ProgressEvent('error')),0)};")
    await drop([fileScript('broken.txt', 'read error')])
    await browser.waitFor("document.querySelector('#attachRow [data-state=error]') && document.getElementById('sendBtn').disabled")
    await browser.evaluate('FileReader.prototype.readAsDataURL=window.originalRead')
    await browser.click('#attachRow [data-state=error] .attach-remove'); await ready(1)
    await browser.evaluate("window.originalFetch=window.fetch;window.fetch=function(url,init){if(url==='/api/message')return Promise.resolve(new Response(JSON.stringify({error:'synthetic rejected upload'}),{status:400,headers:{'content-type':'application/json'}}));return window.originalFetch(url,init)}")
    await browser.click('#sendBtn'); await browser.waitFor("document.querySelector('.err-bar')?.textContent.includes('synthetic rejected upload') && !document.getElementById('sendBtn').disabled")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('保留这份草稿'); await ready(1)
    expect(requests).toHaveLength(0)
    await browser.evaluate('window.fetch=window.originalFetch'); await browser.click('#sendBtn')
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('FILES_UI_ACCEPTED') && document.getElementById('attachRow').hidden")
    expect(requests).toHaveLength(1)
  })

  it('retains the actual browser draft/files when server storage fails, then requires an explicit retry', async () => {
    const { requests, server } = await boot()
    await browser.fill('#input', '磁盘故障时保留草稿'); await drop([fileScript('persist.txt', 'PERSIST_ONCE')]); await ready(1)
    const prepare = vi.spyOn(server.harness.ctx.agents, 'prepareFiles').mockRejectedValueOnce(new Error('synthetic unavailable disk'))
    try {
      await browser.click('#sendBtn')
      await browser.waitFor("document.querySelector('.err-bar')?.textContent.includes('附件保存失败') && !document.getElementById('sendBtn').disabled")
      expect(await browser.evaluate("document.getElementById('input').value")).toBe('磁盘故障时保留草稿')
      await ready(1); expect(requests).toHaveLength(0)
    } finally { prepare.mockRestore() }
    await browser.click('#sendBtn'); await browser.waitFor("document.getElementById('attachRow').hidden && document.getElementById('chatCol').textContent.includes('FILES_UI_ACCEPTED')")
    expect(requests).toHaveLength(1)
    expect(JSON.stringify(requests[0]!.messages)).toContain('PERSIST_ONCE')
  })

  it('cancels pending readers on real session/workspace switches and ignores late file callbacks', async () => {
    const { server, requests } = await boot()
    await browser.evaluate("(async()=>{const response=await fetch('/api/sessions',{method:'POST',body:'{}'});if(!response.ok)throw new Error('fixture session failed');})()")
    await browser.waitFor("(async()=> (await (await fetch('/api/state')).json()).sessionId !== null)()")
    await browser.evaluate("window.originalRead=FileReader.prototype.readAsDataURL;window.delayedReaders=[];FileReader.prototype.readAsDataURL=function(){window.delayedReaders.push(this)}")
    await drop([fileScript('stale.txt', 'NOT_FOR_NEXT_SESSION')])
    await browser.waitFor("document.querySelector('#attachRow [data-state=reading]')")
    await browser.click('#newSessionBtn'); await browser.click('#newSessionConfirm')
    await browser.waitFor("document.getElementById('attachRow').hidden && !document.getElementById('newSessionDialog').open")
    await browser.evaluate("window.delayedReaders.forEach(reader=>{Object.defineProperty(reader,'result',{value:'data:text/plain;base64,eA=='});reader.dispatchEvent(new ProgressEvent('load'))});FileReader.prototype.readAsDataURL=window.originalRead")
    expect(await browser.evaluate("document.getElementById('attachRow').hidden")).toBe(true)
    await drop([fileScript('workspace.txt', 'OLD_WORKSPACE')]); await ready(1)
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-files-other-')); dirs.push(other)
    expect((await fetch(server.url + 'api/desktop/settings', { method: 'POST', body: JSON.stringify({ workspace: other }) })).status).toBe(200)
    await browser.waitFor('(async()=> (await (await fetch("/api/state")).json()).cwd === ' + JSON.stringify(other) + ' && document.getElementById("attachRow").hidden)()')
    expect(requests).toHaveLength(0)
  })

  it('blocks viewer drops/paste/picker/expert actions and prevents local-file navigation outside chat', async () => {
    const token = 'ui-files-operator-' + 'a'.repeat(40), viewer = 'ui-files-viewer-' + 'b'.repeat(40)
    const { requests } = await boot({ token, viewerToken: viewer }, viewer)
    const originalUrl = await browser.evaluate<string>('location.href')
    expect(await browser.evaluate("document.getElementById('fileInput').disabled && document.getElementById('expertChip').disabled")).toBe(true)
    expect(await drop([fileScript('private.txt', 'DO_NOT_ACCEPT')])).toEqual({ prevented: true, overlay: false })
    expect(await browser.evaluate("document.getElementById('attachRow').hidden")).toBe(true)
    expect(await drop([fileScript('outside.txt', 'outside')], '#sidebar')).toEqual({ prevented: true, overlay: false })
    expect(await browser.evaluate('location.href')).toBe(originalUrl)
    expect(requests).toHaveLength(0)
  })
})