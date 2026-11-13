/** Per-agent model changes resolve a real catalog choice without mutating shared selection. */
import { describe, expect, it } from 'vitest'
import { tmpHarness, text } from './helpers.js'
import type { LLMRequest, ModelAdapter, StreamChunk } from '../src/core/types.js'
import { recommendModel, modelCatalogFingerprint } from '../src/core/model-recommendations.js'
import { spawnExperts } from '../src/experts.js'

function adapter(id:string,models:string[],requests:LLMRequest[]):ModelAdapter {
  return {id,defaultModel:models[0],models,async *stream(req){requests.push(req);yield* text('ANSWER_'+id)}}
}
const config={plugins:{'core-compaction':{config:{auto:0,autoTokens:0}},'core-skills':{disabled:true},'core-agent-defs':{disabled:true}}}
describe('per-agent model selection',()=>{
  it('routes two agents independently and leaves the global selection and session history intact',async()=>{
    const first:LLMRequest[]=[],second:LLMRequest[]=[]
    const {ctx}=await tmpHarness({config,adapter:adapter('first',['fast','think'],first)})
    ctx.llm.register(adapter('second',['writer'],second))
    const before=ctx.llm.selectedModel(),a=ctx.agents.spawn({seed:'',persistentSession:true}),b=ctx.agents.spawn({seed:'',persistentSession:true})
    ctx.agents.setModel(a.id,'think','first');ctx.agents.setModel(b.id,'writer','second')
    await Promise.all([a.turn('review'),b.turn('write')])
    expect(first[0]).toMatchObject({model:'think',modelAdapter:'first'})
    expect(second[0]).toMatchObject({model:'writer',modelAdapter:'second'})
    expect(ctx.llm.selectedModel()).toBe(before)
    const id=a.sessionId,log=await ctx.sessions.open(id),length=log.events.length
    ctx.agents.setModel(a.id,'fast','first')
    expect(a.sessionId).toBe(id);expect(log.events).toHaveLength(length)
  })
  it('rejects changing an accepted queued turn but permits an unrelated idle member',async()=>{
    let finish!:()=>void
    const hold=new Promise<void>(resolve=>{finish=resolve})
    const slow:ModelAdapter={id:'slow',defaultModel:'slow-model',models:['slow-model'],async *stream(req):AsyncIterable<StreamChunk>{await hold;yield* text('DONE')}}
    const {ctx}=await tmpHarness({config,adapter:slow})
    const busy=ctx.agents.spawn({seed:'',persistentSession:true}),idle=ctx.agents.spawn({seed:'',persistentSession:true})
    const turn=busy.turn('accepted')
    expect(()=>ctx.agents.setModel(busy.id,'slow-model','slow')).toThrow(/running or queued/)
    ctx.agents.setModel(idle.id,'slow-model','slow')
    finish();await turn
    expect(ctx.agents.isBusy(busy.id)).toBe(false)
    ctx.agents.setModel(busy.id,'slow-model','slow')
  })
  it('rejects unknown or ambiguous choices and never falls back for an invalid explicit pin',async()=>{
    const requests:LLMRequest[]=[]
    const {ctx}=await tmpHarness({config,adapter:adapter('one',['same'],requests)})
    const remove=ctx.llm.register(adapter('two',['same'],requests)),a=ctx.agents.spawn({seed:''})
    expect(()=>ctx.agents.setModel(a.id,'missing')).toThrow()
    expect(()=>ctx.agents.setModel(a.id,'same')).toThrow(/multiple/)
    ctx.agents.setModel(a.id,'same','two');remove()
    expect((await a.turn('not routed')).error).toContain('catalog')
    expect(requests).toHaveLength(0)
  })
  it('returns explainable recommendations without applying them, and honors declared capability/role preferences',()=>{
    const agent={model:'fast',modelAdapter:'one',meta:{expert:'reviewer'}},catalog=[{adapter:'one',model:'fast',default:true,reasoning:false},{adapter:'one',model:'thinking',default:false,reasoning:true}]
    const recommendation=recommendModel(agent,catalog)!
    expect(recommendation.model).toBe('thinking');expect(agent.model).toBe('fast')
    expect(recommendation.catalogFingerprint).toBe(modelCatalogFingerprint(catalog))
    expect(recommendModel(agent,catalog,{roleModels:{reviewer:{model:'fast',adapter:'one'}}})?.model).toBe('fast')
    expect(recommendModel({model:'fast',modelAdapter:'one',meta:{expert:'implementer'}},catalog)?.model).toBe('fast')
  })
  it('rejects ambiguous or malformed new expert choices before spawning any member',async()=>{
    const {ctx,harness}=await tmpHarness({config,adapter:adapter('one',['unique','same'],[])})
    ctx.llm.register(adapter('two',['same'],[]));harness.main()
    const before=ctx.agents.list()
    expect(()=>spawnExperts(ctx.agents,['architect','implementer'],undefined,{
      architect:{model:'unique'},implementer:{model:'same'},
    })).toThrow(/multiple providers/)
    expect(ctx.agents.list()).toEqual(before)
    for(const choice of [null,7,['same'],{model:7},{model:'same',adapter:7},{model:'same',adapter:''},{model:'same',adapter:'missing'}]){
      expect(()=>spawnExperts(ctx.agents,['architect','implementer'],undefined,{
        architect:{model:'unique'},implementer:choice,
      } as Parameters<typeof spawnExperts>[3])).toThrow()
      expect(ctx.agents.list()).toEqual(before)
    }
  })
  it('pins the unique provider for adapter-less choices and ignores overrides on reused experts',async()=>{
    const first:LLMRequest[]=[],team:LLMRequest[]=[]
    const {ctx,harness}=await tmpHarness({config,adapter:adapter('first',['fast'],first)})
    ctx.llm.register(adapter('team',['writer'],team));harness.main()
    const selected=ctx.llm.selectedModel()
    const member=spawnExperts(ctx.agents,['implementer'],undefined,{implementer:{model:'writer'}}).spawned[0]!
    expect(member).toMatchObject({model:'writer',modelAdapter:'team'})
    ctx.llm.register(adapter('later',['writer'],[]))
    for(const choice of [{model:'fast',adapter:'first'},{model:'writer'},null,7,{model:'writer',adapter:7}]){
      const reused=spawnExperts(ctx.agents,['implementer'],undefined,{implementer:choice} as Parameters<typeof spawnExperts>[3])
      expect(reused.spawned).toHaveLength(0);expect(reused.reused[0]).toBe(member)
      expect(member).toMatchObject({model:'writer',modelAdapter:'team'})
    }
    await member.turn('write')
    expect(team[0]).toMatchObject({model:'writer',modelAdapter:'team'})
    expect(first).toHaveLength(0);expect(ctx.llm.selectedModel()).toBe(selected)
  })
  it('drops malformed preferences without applying them or guessing capabilities',()=>{
    const agent={model:'fast',modelAdapter:'one',meta:{expert:'implementer'}},before={...agent,meta:{...agent.meta}}
    const catalog=[{adapter:'one',model:'fast',default:true},{adapter:'two',model:'coding-model',default:false},{adapter:'three',model:'coding-model',default:false}]
    const catalogFingerprint=modelCatalogFingerprint(catalog)
    const malformed:unknown[]=[null,7,'coding',[],{roleModels:null,tags:null},{roleModels:[],tags:[]},
      {roleModels:{implementer:null}},{roleModels:{implementer:7}},{roleModels:{implementer:[]}},
      {roleModels:{implementer:{model:7}}},{roleModels:{implementer:{model:'coding-model',adapter:7}}},
      {roleModels:{implementer:{model:'coding-model',adapter:null}}},{roleModels:{implementer:{model:'coding-model'}}},
      ...['coding',7,{coding:true},['coding',7],['not-coding'],Array(65).fill('coding')].map(tags=>({tags:{'two/coding-model':tags}}))]
    for(const preferences of malformed){
      expect(recommendModel(agent,catalog,preferences)).toMatchObject({adapter:'one',model:'fast',catalogFingerprint})
      expect(agent).toEqual(before)
    }
    expect(recommendModel(agent,catalog,{roleModels:{implementer:{model:'coding-model',adapter:'two'}}})).toMatchObject({adapter:'two',model:'coding-model',catalogFingerprint})
    expect(recommendModel(agent,catalog,{tags:{'two/coding-model':['coding']}})).toMatchObject({adapter:'two',model:'coding-model',catalogFingerprint})
    expect(agent).toEqual(before)
  })
  it('uses explicitly configured models for new experts but never overwrites reused experts',async()=>{
    const {ctx,harness}=await tmpHarness({config,adapter:adapter('team',['fast','writer'],[])})
    harness.main()
    const first=spawnExperts(ctx.agents,['implementer'],undefined,{implementer:{model:'writer',adapter:'team'}})
    expect(first.spawned[0]?.model).toBe('writer')
    const second=spawnExperts(ctx.agents,['implementer'],undefined,{implementer:{model:'fast',adapter:'team'}})
    expect(second.reused[0]?.id).toBe(first.spawned[0]?.id)
    expect(second.reused[0]?.model).toBe('writer')
  })
})
