/** Deferred browser replies must not restore a mobile session after logout. */
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const html=readFileSync(new URL('../src/web/mobile.html',import.meta.url),'utf8')
const source=html.match(/<script>([\s\S]*?)<\/script>/)![1]!
function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done}); return {promise,resolve} }
function page() {
  const elements=new Map<string,any>(),streams:any[]=[],calls:Array<{route:string;body?:any;reply:ReturnType<typeof deferred<Response>>}>=[]
  const element=(id:string)=>{
    if(elements.has(id))return elements.get(id)
    const value:any={id,hidden:false,disabled:false,value:id==='deviceName'?'Phone':'',textContent:'',children:[],listeners:new Map(),
      addEventListener(name:string,callback:unknown){this.listeners.set(name,callback)},appendChild(child:unknown){this.children.push(child)},append(...children:unknown[]){this.children.push(...children)},replaceChildren(...children:unknown[]){this.children=children}}
    elements.set(id,value);return value
  }
  const document={getElementById:element,createElement:()=>element('made-'+elements.size)}
  class Events { onmessage:any;onerror:any;closed=false;constructor(public url:string){streams.push(this)}close(){this.closed=true} }
  const scope={document,URLSearchParams,location:{pathname:'/connect/'+'a'.repeat(32),hash:''},history:{replaceState(){}},
    fetch:(url:string,init?:RequestInit)=>{const reply=deferred<Response>();calls.push({route:url,body:init?.body?JSON.parse(String(init.body)):undefined,reply});return reply.promise},
    EventSource:Events,crypto:{randomUUID:()=> 'a'.repeat(32)},AbortController,setTimeout:()=>1,clearTimeout:()=>{},console}
  new Script(source).runInNewContext(scope)
  const reply=(call:number,value:unknown)=>calls[call]!.reply.resolve(new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}}))
  const dispatch=(id:string,type='click')=>elements.get(id).listeners.get(type)({preventDefault(){}})
  return {elements,streams,calls,reply,dispatch}
}
const authenticated={authenticated:true,online:true,device:{name:'Phone',role:'viewer'},expiresAt:Date.now()+100000}
const snapshot={workspaceId:'workspace-a',name:'safe',revision:1,sessionId:null,busy:false,expertMode:false,sessions:[],agents:[],todos:[]}
async function settle(){for(let i=0;i<50;i++)await Promise.resolve()}

describe('mobile sharing connection generation',()=>{
  it('ignores an old reconnect response after logout and does not start another event stream',async()=>{
    const view=page();view.reply(0,authenticated);await settle()
    expect(view.streams).toHaveLength(1)
    view.reply(1,snapshot);await settle()
    const reconnect=view.dispatch('reconnect');await settle()
    const old=view.calls.findIndex((call,index)=>index>0&&call.route.endsWith('/session'))
    const logout=view.dispatch('logout');await settle()
    view.reply(old,authenticated);await settle();await reconnect
    const out=view.calls.findIndex(call=>call.route.endsWith('/logout'));view.reply(out,{ok:true});await logout
    expect(view.elements.get('workspace').hidden).toBe(true)
    expect(view.streams).toHaveLength(1)
    expect(view.streams[0].closed).toBe(true)
    expect(view.calls.filter(call=>call.body?.kind==='state')).toHaveLength(1)
  })
  it('ignores delayed state data and old stream frames after logout',async()=>{
    const view=page();view.reply(0,authenticated);await settle()
    const oldStream=view.streams[0],callCount=view.calls.length
    const logout=view.dispatch('logout');await settle()
    view.reply(1,snapshot);await settle()
    oldStream.onmessage({data:JSON.stringify({type:'status',...authenticated})})
    oldStream.onmessage({data:JSON.stringify({type:'snapshot',snapshot})})
    await settle()
    const out=view.calls.findIndex(call=>call.route.endsWith('/logout'));view.reply(out,{ok:true});await logout
    expect(view.elements.get('workspace').hidden).toBe(true)
    expect(view.elements.get('messages').children).toHaveLength(0)
    expect(view.streams).toHaveLength(1)
    expect(view.calls).toHaveLength(callCount+1)
  })
})
