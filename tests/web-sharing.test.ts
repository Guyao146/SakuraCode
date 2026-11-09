/** Workspace-sharing integration against an isolated loopback relay and scripted model. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runWebServer, type WebServerHandle } from '../src/web/server.js'
import { runWorkspaceRelay, type WorkspaceRelay } from '../src/sharing/relay.js'
import { shareId, type ShareStatus, type SharedHistory, type SharedWorkspace } from '../src/sharing/protocol.js'
import { MockAdapter, text } from './helpers.js'

const registration = 'test-sharing-registration-' + 'a'.repeat(40)
const cleanups: Array<() => Promise<void>> = []
const nativeFetch = globalThis.fetch
beforeEach(() => {
  vi.stubEnv('SAKURA_UPDATES_AUTO_CHECK', '0')
  vi.stubGlobal('fetch', (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('External network forbidden in sharing integration')
    return nativeFetch(input, init)
  })
})
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.()
  vi.unstubAllGlobals(); vi.unstubAllEnvs()
})

const post = (base: string, route: string, body: object, cookie?: string) => fetch(base.replace(/\/$/, '') + route, {
  method:'POST', headers:{'content-type':'application/json', ...(cookie ? {cookie} : {})}, body:JSON.stringify(body),
})
interface ReadySharing extends ShareStatus { qrDataUrl?: string; available: boolean }
async function fixture(options: Partial<Parameters<typeof runWebServer>[0]> = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-sharing-api-'))
  cleanups.push(async () => { await fs.rm(cwd, {recursive:true,force:true,maxRetries:4}).catch(() => {}) })
  const relay = await runWorkspaceRelay({ registrationToken:registration, port:0 })
  cleanups.push(() => relay.close())
  const handle = await runWebServer({cwd,adapter:new MockAdapter([text('WORKSPACE_ANSWER')]),quiet:true,open:false,approvalMode:'yolo',updatesAutoCheck:false,
    config:{plugins:{'core-compaction':{config:{auto:0,autoTokens:0}},'core-skills':{disabled:true},'core-agent-defs':{disabled:true}}},...options})
  cleanups.push(() => handle.close())
  return {cwd,relay,handle}
}
async function ready(handle: WebServerHandle, relay: WorkspaceRelay): Promise<ReadySharing> {
  const response = await post(handle.url, '/api/workspace-sharing/start', {relayOrigin:relay.url,registrationToken:registration,confirmed:true})
  expect(response.status).toBe(200)
  let status = await response.json() as ReadySharing
  await vi.waitFor(async () => {
    status = await (await fetch(handle.url + 'api/workspace-sharing')).json() as ReadySharing
    expect(status.phase).toBe('online')
  }, {timeout:5000})
  return status
}
async function join(relay: WorkspaceRelay, status: ReadySharing) {
  const link = new URL(status.inviteUrl!), token = new URLSearchParams(link.hash.slice(1)).get('invite')!
  const joined = await post(relay.url, `/api/rooms/${status.roomId}/join`, {token,name:'phone fixture'})
  expect(joined.status).toBe(200)
  const cookie = joined.headers.get('set-cookie')!.split(';')[0]!
  const {device} = await joined.json() as {device:{id:string}}
  return {cookie,device,route:`/api/rooms/${status.roomId}`}
}

function sse(url: string, cookie?: string) {
  const controller = new AbortController(), frames: unknown[] = []
  const task = (async () => {
    const response = await fetch(url,{signal:controller.signal,headers:cookie?{cookie}:{}})
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer=''
    for (;;) {
      const row=await reader.read(); if (row.done) break; buffer+=decoder.decode(row.value,{stream:true});
      let at:number; while ((at=buffer.indexOf('\n\n'))>=0) { const frame=buffer.slice(0,at); buffer=buffer.slice(at+2);
        const data=frame.split('\n').find(line=>line.startsWith('data:')); if(data)frames.push(JSON.parse(data.slice(5))) }
    }
  })().catch(()=>{})
  cleanups.push(async()=>{controller.abort();await task})
  return frames
}

describe('workspace sharing — real relay integration', () => {
  it('requires explicit consent, generates matching link/QR without exposing registration, and stops independently of the main engine', async () => {
    const {handle,relay}=await fixture()
    const unconfirmed=await post(handle.url,'/api/workspace-sharing/start',{relayOrigin:relay.url,registrationToken:registration})
    expect(unconfirmed.status).toBe(400)
    const status=await ready(handle,relay)
    expect(status.inviteUrl).toContain(relay.url+'/connect/'+status.roomId+'#invite=')
    expect(status.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/)
    expect(JSON.stringify(status)).not.toContain(registration)
    const stopped=await post(handle.url,'/api/workspace-sharing/stop',{})
    expect(stopped.status).toBe(200)
    expect((await stopped.json() as ReadySharing).phase).toBe('idle')
    const link=new URL(status.inviteUrl!),token=new URLSearchParams(link.hash.slice(1)).get('invite')!
    expect((await post(relay.url,`/api/rooms/${status.roomId}/join`,{token,name:'late'})).status).not.toBe(200)
    expect(await handle.harness.run('desktop still works')).toMatchObject({output:'WORKSPACE_ANSWER'})
  })

  it('keeps viewers read-only, projects only current-workspace records, and permits explicit controller commands exactly once', async () => {
    const {handle,relay,cwd}=await fixture()
    await handle.harness.run('VISIBLE_USER_TASK')
    const log=await handle.harness.ctx.sessions.open(handle.harness.main().sessionId)
    await log.append({type:'system/message',payload:{content:'PRIVATE_SYSTEM_SECRET'}})
    await log.append({type:'tool/result',payload:{id:'fake-private-tool',name:'read',output:'PRIVATE_TOOL_OUTPUT',durationMs:1}})
    const status=await ready(handle,relay),phone=await join(relay,status)
    sse(relay.url+phone.route+'/events',phone.cookie)
    await vi.waitFor(async()=>{const state=await(await fetch(handle.url+'api/workspace-sharing')).json() as ReadySharing;expect(state.devices.some(device=>device.id===phone.device.id&&device.online)).toBe(true)},{timeout:5000})
    const call=(kind:string,extra:object={})=>post(relay.url,phone.route+'/request',{operationId:shareId(),kind,...extra},phone.cookie)
    expect((await call('message',{text:'forbidden',sessionId:log.id})).status).toBe(403)
    const state=await(await call('state')).json() as SharedWorkspace
    expect(state.workspaceId).toBe(status.workspaceId)
    expect(JSON.stringify(state)).not.toContain(cwd)
    expect(state).not.toHaveProperty('desktop')
    expect(state).not.toHaveProperty('weixin')
    const history=await(await call('history',{sessionId:log.id})).json() as SharedHistory
    expect(JSON.stringify(history)).toContain('VISIBLE_USER_TASK')
    expect(JSON.stringify(history)).not.toContain('PRIVATE_SYSTEM_SECRET')
    expect(JSON.stringify(history)).not.toContain('PRIVATE_TOOL_OUTPUT')
    expect((await post(handle.url,'/api/workspace-sharing/device',{id:phone.device.id,role:'controller'})).status).toBe(200)
    const operationId=shareId(),body={kind:'message',operationId,text:'ONE_PHONE_TASK',sessionId:log.id}
    const [a,b]=await Promise.all([post(relay.url,phone.route+'/request',body,phone.cookie),post(relay.url,phone.route+'/request',body,phone.cookie)])
    expect(a.status).toBe(202);expect(b.status).toBe(202)
    await handle.harness.main().wait()
    expect(log.events.filter(event=>event.type==='user/message'&&event.payload.content==='ONE_PHONE_TASK')).toHaveLength(1)
    expect((await call('message',{text:'@private.txt',sessionId:log.id})).status).toBe(400)
    expect((await post(handle.url,'/api/workspace-sharing/device',{id:phone.device.id,role:'viewer'})).status).toBe(200)
    expect((await call('stop',{sessionId:log.id})).status).toBe(403)
  })

  it('redacts configured credentials before clipping shared messages and labels', async () => {
    const secret = 'BOUNDARY_CREDENTIAL_SENTINEL_1234567890'
    const { handle, relay } = await fixture()
    handle.harness.ctx.llm.prepareConfiguration({ provider: 'default', apiKey: secret }).commit()
    const session = await handle.harness.ctx.sessions.create()
    handle.harness.main({ resumeSessionId: session.id })
    const raw = 'a'.repeat(7990) + secret + ' suffix'
    await session.append({ type: 'user/message', payload: { content: raw } })
    const status = await ready(handle, relay), phone = await join(relay, status)
    sse(relay.url + phone.route + '/events', phone.cookie)
    await vi.waitFor(async () => { const current = await (await fetch(handle.url + 'api/workspace-sharing')).json() as ReadySharing
      expect(current.devices.some(device => device.id === phone.device.id && device.online)).toBe(true) })
    const response = await post(relay.url, phone.route + '/request', { kind: 'history', operationId: shareId(), sessionId: session.id }, phone.cookie)
    expect(response.status).toBe(200)
    const history = await response.json() as SharedHistory
    expect(history.entries[0]?.text).toContain('[redacted]')
    expect(JSON.stringify(history)).not.toContain('BOUNDARY_CR')
    expect(session.events.some(event => event.type === 'user/message' && event.payload.content === raw)).toBe(true)
  })

  it('does not stop a newly started share when an older stop reply completes after a workspace switch', async () => {
    let heldRoom = '', release!: () => void, started!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve }), seen = new Promise<void>(resolve => { started = resolve })
    const { handle, relay } = await fixture({ onPersistSettings: async () => {}, sharingFetch: async (input, init) => {
      if (init?.method === 'DELETE' && String(input).endsWith(heldRoom) && heldRoom) { started(); await blocked }
      return globalThis.fetch(input, init)
    } })
    const first = await ready(handle, relay); heldRoom = first.roomId!
    const stop = post(handle.url, '/api/workspace-sharing/stop', {})
    await seen
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-sharing-race-'))
    cleanups.push(async () => { await fs.rm(other, { recursive: true, force: true }).catch(() => {}) })
    try {
      expect((await post(handle.url, '/api/desktop/settings', { workspace: other })).status).toBe(200)
      const second = await ready(handle, relay)
      expect(second.roomId).not.toBe(first.roomId)
      release()
      expect((await stop).status).toBe(409)
      const current = await (await fetch(handle.url + 'api/workspace-sharing')).json() as ReadySharing
      expect(current.roomId).toBe(second.roomId); expect(current.phase).toBe('online')
    } finally { release(); await stop.catch(() => {}) }
  })

  it('denies remote management and revokes a share when the workspace is remounted', async () => {
    const remote=await fixture({host:'0.0.0.0',token:'operator-'+ 'r'.repeat(40),viewerToken:'viewer-'+ 'v'.repeat(40)})
    const denied=await fetch(remote.handle.url+'api/workspace-sharing',{headers:{authorization:'Bearer '+'operator-'+ 'r'.repeat(40)}})
    expect(denied.status).toBe(404)
    const {handle,relay,cwd}=await fixture({onPersistSettings:async()=>{}})
    const status=await ready(handle,relay),other=await fs.mkdtemp(path.join(os.tmpdir(),'sakura-sharing-next-'))
    cleanups.push(async()=>{await fs.rm(other,{recursive:true,force:true,maxRetries:4}).catch(()=>{})})
    expect((await post(handle.url,'/api/desktop/settings',{workspace:other})).status).toBe(200)
    await vi.waitFor(async()=>{const current=await(await fetch(handle.url+'api/workspace-sharing')).json() as ReadySharing;expect(current.phase).toBe('idle')},{timeout:5000})
    const snapshot=await(await fetch(handle.url+'api/state')).json() as {cwd:string}
    expect(snapshot.cwd).toBe(other);expect(snapshot.cwd).not.toBe(cwd)
    const oldLink=new URL(status.inviteUrl!),token=new URLSearchParams(oldLink.hash.slice(1)).get('invite')!
    expect((await post(relay.url,`/api/rooms/${status.roomId}/join`,{token,name:'old workspace'})).status).not.toBe(200)
  })
})
