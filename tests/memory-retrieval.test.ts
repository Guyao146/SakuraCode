/** Memory search/persistence and model choices use local fixtures, never real user notes or upstreams. */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { tmpHarness, text } from './helpers.js'
import { retrieveText } from '../src/util/retrieval.js'
import { WorkspaceMemoryStore } from '../src/plugins/workspace-memory.js'
import { estimateTokens } from '../src/util/tokens.js'

const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
describe('local memory retrieval and durable collection',()=>{
  it('ranks Chinese/English matches, keeps stable sources and enforces total snippet budget',()=>{
    const items=[{id:'one',source:'notes-a.md',content:'登录接口需要验证授权和模型。',startLine:1},
      {id:'two',source:'notes-b.md',content:'latest updates are unrelated',startLine:3},
      {id:'three',source:'notes-c.md',content:'auth tests verify 登录 token boundaries',startLine:4}]
    const result=retrieveText('登录 auth',items,{maxChars:256})
    expect(result.results[0]?.id).toBe('three')
    expect(result.results.some(row=>row.id==='two')).toBe(false)
    expect(result.results.reduce((sum,row)=>sum+row.snippet.length,0)).toBeLessThanOrEqual(256)
    expect(result.results[0]?.source).toBe('notes-c.md')
    expect(retrieveText('missing',items).results).toEqual([])
    expect(()=>retrieveText(' ',items)).toThrow()
  })
  it('searches only active durable entries and not pending or disabled data with no model request',async()=>{
    const {ctx,harness}=await tmpHarness()
    const memory=ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({content:'- 已确认登录规则\n- 被停用登录秘密'},0)
    const disabled=memory.snapshot().entries.find(entry=>entry.content.includes('秘密'))!
    await memory.update({entry:{collection:'longTerm',id:disabled.id,action:'toggle',enabled:false}},memory.snapshot().revision)
    await memory.appendPending('待整理登录数据')
    const count=vi.fn();ctx.on('llm/stream',(payload,next)=>{count();return next(payload)})
    const session=await ctx.sessions.create(),tc={sessionId:session.id,agentId:harness.main().id,signal:new AbortController().signal}
    const result=await ctx.tools.execute('search','memory_search',JSON.stringify({query:'登录'}),tc)
    expect(result.isError).toBeFalsy();expect(result.output).toContain('已确认登录规则')
    expect(result.output).not.toContain('秘密');expect(result.output).not.toContain('待整理')
    expect(count).not.toHaveBeenCalled()
    await memory.update({enabled:false},memory.snapshot().revision)
    expect((await ctx.tools.execute('disabled','memory_search',JSON.stringify({query:'登录'}),tc)).isError).toBe(true)
  })
  it('stores the source marker with pending text, and never recollects it after restart or processing',async()=>{
    const {tmpDir}=await tmpHarness(),store=new WorkspaceMemoryStore(tmpDir)
    await store.reload()
    const content='## origin\n用户：保持中文回复',source={sessionId:'session-a',userSeq:2,digest:hash(content)}
    await store.appendPending(content,undefined,source)
    const first=store.snapshot()
    await store.appendPending(content,undefined,source)
    expect(store.snapshot().revision).toBe(first.revision)
    const cold=new WorkspaceMemoryStore(tmpDir);await cold.reload();await cold.appendPending(content,undefined,source)
    expect(cold.snapshot().pendingContent).toBe(content)
    await cold.processed('Confirmed preference',cold.snapshot().revision)
    const restarted=new WorkspaceMemoryStore(tmpDir);await restarted.reload();await restarted.appendPending(content,undefined,source)
    expect(restarted.snapshot().pendingContent).toBe('')
  })
  it('collects completed turns once across a harness restart and preserves notes when disabled',async()=>{
    const first=await tmpHarness({steps:[text('confirmed reusable')]})
    await first.harness.run('stable user direction')
    const memory=first.ctx.get<WorkspaceMemoryStore>('workspaceMemory'),before=await memory.reload(),sessionId=first.harness.main().sessionId
    const second=await tmpHarness({cwd:first.tmpDir,sessionDir:path.join(first.tmpDir,'.sakura','sessions')})
    await second.ctx.get<{collect(id:string):Promise<void>}>('memoryProcessing').collect(sessionId)
    const after=await second.ctx.get<WorkspaceMemoryStore>('workspaceMemory').reload()
    expect(after.pendingContent).toBe(before.pendingContent)
  })
  it('keeps compatible full mode, switches to fixed on-demand navigation, and retains content',async()=>{
    const {ctx}=await tmpHarness(),memory=ctx.get<WorkspaceMemoryStore>('workspaceMemory')
    await memory.update({content:'CONFIRMED_DETAIL '.repeat(500)},0)
    const full=memory.render();expect(full).toContain('CONFIRMED_DETAIL')
    await memory.update({injectionMode:'on-demand'},memory.snapshot().revision)
    expect(memory.render()).not.toContain('CONFIRMED_DETAIL');expect(memory.render()).toContain('memory_search')
    expect(estimateTokens(memory.render())).toBeLessThan(estimateTokens(full)*0.1)
    expect((await new WorkspaceMemoryStore(path.dirname(path.dirname(memory.file))).reload()).injectionMode).toBe('on-demand')
    expect(memory.snapshot().content).toContain('CONFIRMED_DETAIL')
  })
  it('fails closed when legacy pending text or Markdown contains duplicate reserved separators',async()=>{
    const {tmpDir}=await tmpHarness(),memory=new WorkspaceMemoryStore(tmpDir),dir=path.dirname(memory.file)
    await fs.mkdir(dir,{recursive:true})
    const marker='\n\n<!-- sakura-memory-pending -->\n'
    const legacy=JSON.stringify({version:2,enabled:true,content:'DURABLE',revision:1,updatedAt:new Date().toISOString(),pendingContent:'PENDING_NOT_A_FACT'+marker+'TAIL',
      pendingSince:null,lastProcessedAt:null,processing:{auto:false,thresholdChars:8000,intervalMs:1800000},disabledEntries:[]})
    await fs.writeFile(memory.legacyFile,legacy)
    expect((await memory.reload()).enabled).toBe(false)
    await expect(memory.update({enabled:true},1)).rejects.toThrow()
    expect(await fs.readFile(memory.legacyFile,'utf8')).toBe(legacy)
    await fs.unlink(memory.legacyFile)
    const clean=new WorkspaceMemoryStore(tmpDir);await clean.reload();await clean.update({content:'DURABLE'},0)
    const raw=await fs.readFile(clean.file,'utf8'),corrupt=raw+marker+'SHOULD_NEVER_BE_DURABLE'
    await fs.writeFile(clean.file,corrupt)
    expect((await clean.reload()).enabled).toBe(false)
    expect(clean.render()).toBe('')
    await expect(clean.update({content:'must not overwrite'},1)).rejects.toThrow()
    expect(await fs.readFile(clean.file,'utf8')).toBe(corrupt)
  })
  it('retains all replay markers at capacity instead of silently evicting old sources after a clear',async()=>{
    const {tmpDir}=await tmpHarness(),memory=new WorkspaceMemoryStore(tmpDir)
    await memory.reload()
    await memory.update({content:'DURABLE'},0)
    const raw=await fs.readFile(memory.file,'utf8'),split=/^---\n([\s\S]*?)\n---\n/.exec(raw)!
    const meta=JSON.parse(split[1]!)
    meta.collectionSources=Array.from({length:1024},(_,index)=>({sessionHash:hash('source-'+index),userSeq:index,digest:hash('content-'+index)}))
    const seeded='---\n'+JSON.stringify(meta,null,2)+'\n---\n'+raw.slice(split[0].length)
    await fs.writeFile(memory.file,seeded);await memory.reload()
    const oldSource={sessionId:'source-0',userSeq:0,digest:hash('content-0')}
    await memory.update({clearPending:true},memory.snapshot().revision)
    const bytes=await fs.readFile(memory.file,'utf8')
    await expect(memory.appendPending('new source',undefined,{sessionId:'source-new',userSeq:1025,digest:hash('new')})).rejects.toThrow('1024')
    expect(await fs.readFile(memory.file,'utf8')).toBe(bytes)
    const cold=new WorkspaceMemoryStore(tmpDir);await cold.reload();await cold.appendPending('old source text',undefined,oldSource)
    expect(cold.snapshot().pendingContent).toBe('')
  })
  it('failed save does not mark a source as collected or modify the original file',async()=>{
    const {tmpDir}=await tmpHarness(),memory=new WorkspaceMemoryStore(tmpDir);await memory.reload()
    await memory.appendPending('initial');const original=await fs.readFile(memory.file,'utf8')
    const write=vi.spyOn(fs,'rename').mockRejectedValueOnce(new Error('synthetic disk failure'))
    const source={sessionId:'source',userSeq:1,digest:hash('candidate')}
    await expect(memory.appendPending('candidate',undefined,source)).rejects.toThrow()
    write.mockRestore();expect(await fs.readFile(memory.file,'utf8')).toBe(original)
    await memory.appendPending('candidate',undefined,source)
    expect(memory.snapshot().pendingContent).toContain('candidate')
  })
})
