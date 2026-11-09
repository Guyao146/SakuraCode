/** Two real browser sessions connect to an isolated workspace via the self-hosted relay. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { runWorkspaceRelay, type WorkspaceRelay } from '../src/sharing/relay.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { BrowserClient } from './browser-client.js'

const registration='browser-sharing-fixture-'+ 'a'.repeat(40)
const mobileHtml=readFileSync(new URL('../src/web/mobile.html',import.meta.url),'utf8')
describe('mobile sharing page contract',()=>{
  it('has one valid inline script, local assets and safe invitation/record rendering',()=>{
    const script=mobileHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy();expect(()=>new Script(script!)).not.toThrow()
    expect(mobileHtml).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:/)
    expect(mobileHtml).toContain("history.replaceState(null, '', location.pathname)")
    expect(mobileHtml).toContain('body.textContent = entry.text')
    expect(mobileHtml).not.toContain('innerHTML')
  })
})
class SharingAdapter implements ModelAdapter {
  id='sharing-browser'; defaultModel='sharing-model'; requests:LLMRequest[]=[]
  async *stream(req:LLMRequest):AsyncIterable<StreamChunk> {
    this.requests.push(req)
    const message=String([...req.messages].reverse().find(row=>row.role==='user')?.content||'')
    yield {type:'text',delta:'COMPLETED_'+message};yield {type:'done',reason:'stop'}
  }
}
const suite=resolveChromePath()&&typeof(globalThis as {WebSocket?:unknown}).WebSocket==='function'?describe:describe.skip
suite('workspace sharing — real browser',()=>{
  const desktop=new BrowserClient(),phone=new BrowserClient()
  let handle:WebServerHandle,relay:WorkspaceRelay,cwd='',adapter:SharingAdapter
  beforeAll(async()=>{await desktop.start();await phone.start()})
  afterAll(async()=>{await desktop.close();await phone.close()})
  beforeEach(async()=>{
    cwd=await fs.mkdtemp(path.join(os.tmpdir(),'sakura-sharing-ui-'));adapter=new SharingAdapter()
    relay=await runWorkspaceRelay({registrationToken:registration,port:0,mobileHtml})
    handle=await runWebServer({cwd,adapter,quiet:true,open:false,approvalMode:'yolo',updatesAutoCheck:false,
      config:{plugins:{'core-compaction':{config:{auto:0,autoTokens:0}},'core-skills':{disabled:true},'core-agent-defs':{disabled:true}}}})
    desktop.errors.length=0;phone.errors.length=0
    await desktop.resize(1440,960);await phone.resize(390,844)
    await desktop.navigate(handle.url)
    await desktop.waitFor("document.documentElement.dataset.boot==='ready' && !document.getElementById('workspaceShareBtn').hidden")
  })
  afterEach(async()=>{
    const errors=[...desktop.errors,...phone.errors]
    await desktop.navigate('about:blank');await phone.navigate('about:blank');await handle.close();await relay.close()
    await fs.rm(cwd,{recursive:true,force:true,maxRetries:4}).catch(()=>{})
    expect(errors).toEqual([])
  })
  async function connect() {
    await desktop.click('#workspaceShareBtn')
    await desktop.waitFor("document.getElementById('workspaceShareDialog').open")
    await desktop.fill('#workspaceShareOrigin',relay.url)
    await desktop.fill('#workspaceShareToken',registration)
    await desktop.click('#workspaceShareConsent')
    await desktop.click('#workspaceShareStart')
    await desktop.waitFor("!document.getElementById('workspaceShareQr').hidden && document.getElementById('workspaceShareStatus').textContent.includes('中转已就绪')")
    const link=await desktop.evaluate<string>("document.getElementById('workspaceShareLink').value")
    expect(link).toContain('#invite=')
    expect(await desktop.evaluate<string>("document.getElementById('workspaceShareQr').src")).toMatch(/^data:image\/svg\+xml;base64,/)
    await phone.navigate(link)
    await phone.waitFor("!document.getElementById('join').disabled")
    expect(await phone.evaluate('location.hash')).toBe('')
    await phone.fill('#deviceName','测试手机')
    await phone.click('#join')
    await phone.waitFor("!document.getElementById('workspace').hidden && document.getElementById('connectionStatus').textContent.includes('电脑已连接')")
    await desktop.waitFor("document.getElementById('workspaceShareDeviceCount').textContent.includes('1 台在线')")
    return link
  }

  it('starts only with consent, connects a read-only phone, grants control explicitly and stops the old link',async()=>{
    await handle.harness.run('INITIAL_SHARED_HISTORY')
    await desktop.reload();await desktop.waitFor("document.documentElement.dataset.boot==='ready'")
    const link=await connect()
    expect(await desktop.evaluate("document.getElementById('workspaceShareToken').value")).toBe('')
    await phone.waitFor("document.getElementById('messages').textContent.includes('INITIAL_SHARED_HISTORY')")
    expect(await phone.evaluate("document.getElementById('task').disabled")).toBe(true)
    expect(await phone.evaluate('document.cookie')).not.toContain('sakura')
    expect(await phone.evaluate("JSON.stringify({...localStorage,...sessionStorage})")).not.toContain(new URL(link).hash.slice(8))
    await desktop.click('#workspaceShareDevices .share-device-actions button')
    await phone.waitFor("document.getElementById('permission').textContent==='允许控制' && !document.getElementById('task').disabled")
    await phone.fill('#task','MOBILE_ONE_TASK')
    await phone.click('#send')
    await phone.waitFor("document.getElementById('messages').textContent.includes('COMPLETED_MOBILE_ONE_TASK')")
    expect(adapter.requests.filter(req=>JSON.stringify(req.messages.at(-1)).includes('MOBILE_ONE_TASK'))).toHaveLength(1)
    await desktop.click('#workspaceShareDevices .share-device-actions button')
    await phone.waitFor("document.getElementById('permission').textContent==='只读' && document.getElementById('task').disabled")
    await desktop.click('#workspaceShareStop')
    await desktop.waitFor("document.getElementById('workspaceShareLink').value==='' && document.getElementById('workspaceShareQr').hidden")
    await phone.waitFor("document.getElementById('workspace').hidden || document.getElementById('connectionStatus').textContent.includes('中断') || document.getElementById('connectionStatus').textContent.includes('离线')")
    expect((await fetch(handle.url+'api/state')).status).toBe(200)
  })

  it('keeps QR/link controls inside narrow layouts, gives honest copy failures and restores focus on Escape',async()=>{
    await connect()
    await desktop.click('#workspaceShareRenew')
    await desktop.waitFor("!document.getElementById('workspaceShareCopy').disabled && document.getElementById('workspaceShareLink').value.includes('#invite=')")
    await desktop.evaluate("Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new Error('denied')}},configurable:true});document.execCommand=()=>false")
    await desktop.click('#workspaceShareCopy')
    await desktop.waitFor("document.getElementById('workspaceShareCopy').textContent.includes('失败')")
    for (const width of [390,320]) {
      await desktop.resize(width,844)
      expect(await desktop.evaluate("document.getElementById('workspaceShareDialog').getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth")).toBe(true)
      await phone.resize(width,844)
      expect(await phone.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true)
    }
    await desktop.key('Escape')
    await desktop.waitFor("!document.getElementById('workspaceShareDialog').open")
    await desktop.waitFor("document.activeElement.id==='menuBtn'")
  })
})
