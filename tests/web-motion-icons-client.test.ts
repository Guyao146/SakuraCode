/** Startup paint gates, no-welcome-frame navigation and local tool icons in real Chromium. */
import { promises as fs, readFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Script } from 'node:vm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { runWebServer, type WebServerHandle, type WebServerOptions } from '../src/web/server.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { BrowserClient } from './browser-client.js'
import { MockAdapter, text } from './helpers.js'

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8')
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!

describe('startup and tool icon contracts', () => {
  it('has one valid local script and declares the loading gate before any app markup', () => {
    expect(() => new Script(script)).not.toThrow()
    expect(html).toContain('data-boot="loading"')
    expect(html.indexOf('id="appBoot"')).toBeLessThan(html.indexOf('id="mainWorkspace"'))
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)="https?:/)
  })

  it('assigns fixed SVG symbols to every built-in tool and safe fallbacks to third-party names', () => {
    const scope = {} as { toolIconName: (name: string, kind?: string, source?: string) => string }
    const start = script.indexOf('/* Tool icon identities are fixed local symbols,')
    const end = script.indexOf('/* End pure tool icon identities. */', start)
    new Script(script.slice(start, end)).runInNewContext(scope)
    const tools = ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'web_search', 'web_fetch', 'skill', 'ask_user',
      'memory_read', 'memory_write', 'todo_write', 'exit_plan', 'job_list', 'job_output', 'job_kill', 'plugin_manager',
      'subagent', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent', 'browser_navigate',
      'browser_screenshot', 'browser_click', 'browser_type', 'browser_key', 'browser_evaluate', 'browser_close',
      'computer_screenshot', 'computer_click', 'computer_move', 'computer_scroll', 'computer_type', 'computer_key']
    for (const name of tools) {
      const icon = scope.toolIconName(name)
      expect(html).toContain(`<symbol id="${icon}"`)
      if (name !== 'plugin_manager') expect(icon, name).not.toBe('i-plugin')
    }
    expect(scope.toolIconName('plugin_manager')).toBe('i-plugin')
    expect(scope.toolIconName('mcp__synthetic__read', 'read')).toBe('i-plugin')
    expect(scope.toolIconName('custom_read', 'read')).toBe('i-file-read')
    for (const unsafe of ['<img src=x onerror=alert(1)>', '__proto__', 'constructor', 'https://example.test/icon.svg']) {
      expect(scope.toolIconName(unsafe)).toBe('i-plugin')
    }
  })
})

const suite = resolveChromePath() && typeof globalThis.WebSocket === 'function' ? describe : describe.skip
suite('startup, transitions and icons — real browser', () => {
  const browser = new BrowserClient(), directories: string[] = [], servers: WebServerHandle[] = []
  let initScriptId = ''
  beforeAll(async () => {
    await browser.start()
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  })
  afterAll(() => browser.close())
  afterEach(async () => {
    const errors = [...browser.errors]
    await browser.evaluate('window.releaseHeldReads?.()').catch(() => {})
    if (initScriptId) { await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: initScriptId }); initScriptId = '' }
    await browser.navigate('about:blank')
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    while (servers.length) await servers.pop()!.close()
    while (directories.length) await fs.rm(directories.pop()!, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 })
    expect(errors).toEqual([])
  })
  async function directory() {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-motion-icons-')); directories.push(cwd)
    await fs.writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
    return cwd
  }
  async function server(extra: Partial<WebServerOptions> = {}) {
    const handle = await runWebServer({ cwd: await directory(), adapter: new MockAdapter([text('READY_HISTORY')]), open: false,
      quiet: true, token: null, viewerToken: null, updatesAutoCheck: false, ...extra })
    servers.push(handle); browser.errors.length = 0; await browser.resize(1440, 900)
    return handle
  }
  async function ready() {
    await browser.waitFor("document.documentElement.dataset.boot === 'ready' && document.getElementById('appBoot').hidden && !document.getElementById('chatCol').hasAttribute('aria-busy')")
  }
  async function snapshot(name: string) {
    if (process.env.SAKURA_UI_SCREENSHOTS) await browser.screenshot(path.resolve(process.env.SAKURA_UI_SCREENSHOTS, name + '.png'))
  }
  async function init(source: string) {
    new Script(source)
    const result = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source }); initScriptId = result.identifier
  }

  it('keeps startup opaque until current history and commands are loaded, then reveals exactly the prepared page', async () => {
    const handle = await server(); await handle.harness.run('PREEXISTING_HISTORY')
    await init(String.raw`
      window.heldReads = []; window.sawWelcomeBeforeHistory = false;
      const original = window.fetch;
      window.fetch = async function(resource, options) {
        const route = String(resource);
        if (route === '/api/commands' || /\/records$/.test(route)) await new Promise(resolve => window.heldReads.push({route, resolve}));
        return original.call(this, resource, options);
      };
      window.releaseHeldReads = () => { window.heldReads.splice(0).forEach(row => row.resolve()); };
      const check = () => {
        const welcome = document.getElementById('welcome');
        if (welcome?.checkVisibility({visibilityProperty:true, opacityProperty:true}) && !document.getElementById('chatCol').textContent.includes('PREEXISTING_HISTORY')) window.sawWelcomeBeforeHistory = true;
        requestAnimationFrame(check);
      }; requestAnimationFrame(check);
    `)
    await browser.navigate(handle.url)
    await browser.waitFor('window.heldReads.length >= 2')
    expect(await browser.evaluate("document.documentElement.dataset.boot")).toBe('loading')
    expect(await browser.evaluate("getComputedStyle(document.getElementById('mainWorkspace')).visibility")).toBe('hidden')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-orbit')).animationName")).toBe('boot-orbit')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-mark svg')).animationName")).toBe('boot-flower')
    expect(await browser.evaluate("document.querySelectorAll('.boot-petal').length")).toBe(4)
    const motion = await browser.evaluate<{ first: string[]; later: string[] }>(`(() => {
      const nodes = [document.querySelector('.boot-orbit'), document.querySelector('.boot-mark svg')];
      const animations = nodes.map(node => node.getAnimations()[0]);
      animations.forEach(animation => { animation.pause(); animation.currentTime = 0; });
      const first = nodes.map(node => getComputedStyle(node).transform);
      animations.forEach(animation => { animation.currentTime = 700; });
      const later = nodes.map(node => getComputedStyle(node).transform);
      animations.forEach(animation => animation.play());
      return {first, later};
    })()`)
    expect(motion.first.every((transform, index) => transform !== motion.later[index])).toBe(true)
    await browser.evaluate(`document.addEventListener('animationstart', event => {
      if (event.target.id === 'appBoot' && event.animationName === 'boot-exit') window.startupExit = {
        name:event.animationName, duration:getComputedStyle(event.target).animationDuration,
        ready:document.documentElement.dataset.boot, history:document.getElementById('chatCol').textContent.includes('PREEXISTING_HISTORY')
      };
    });`)
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(true)
    await snapshot('startup-loading')
    await browser.evaluate("window.heldReads.find(row => /records$/.test(row.route)).resolve()")
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('PREEXISTING_HISTORY')")
    expect(await browser.evaluate("document.documentElement.dataset.boot")).toBe('loading')
    await browser.evaluate('window.releaseHeldReads()'); await ready()
    expect(await browser.evaluate('window.sawWelcomeBeforeHistory')).toBe(false)
    expect(await browser.evaluate("document.getElementById('welcome').hidden")).toBe(true)
    expect(await browser.evaluate("document.getElementById('mainWorkspace').inert")).toBe(false)
    expect(await browser.evaluate('window.startupExit')).toEqual({ name: 'boot-exit', duration: '0.24s', ready: 'ready', history: true })
    await snapshot('startup-restored-history')
  })

  it('crossfades only prepared sessions, keeps the composer still and cancels old motion on a rapid switch', async () => {
    const handle = await server(); await handle.harness.run('ANIMATION_A')
    const b = await handle.harness.ctx.sessions.create({ title: 'ANIMATION_B' })
    await b.append({ type: 'user/message', payload: { content: 'ANIMATION_B' } })
    const c = await handle.harness.ctx.sessions.create({ title: 'ANIMATION_C' })
    await c.append({ type: 'user/message', payload: { content: 'ANIMATION_C' } })
    await browser.navigate(handle.url); await ready(); await browser.fill('#input', 'ANIMATION_DRAFT')
    const composer = () => browser.evaluate<{ x: number; y: number; width: number; height: number }>("(() => { const r=document.querySelector('.composer').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()")
    const composerBefore = await composer()
    await browser.evaluate(`(() => {
      const original = window.fetch; window.heldReads = []; window.conversationMotions = []; window.pauseConversationMotion = true;
      window.fetch = async function(resource, options) {
        if (['/api/sessions/${b.id}/records', '/api/sessions/${c.id}/records'].includes(String(resource))) await new Promise(resolve => window.heldReads.push(resolve));
        return original.call(this, resource, options);
      };
      window.releaseHeldReads = () => window.heldReads.splice(0).forEach(resolve => resolve());
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(keyframes, timing) {
        const animation = animate.call(this, keyframes, timing);
        if (this.id === 'chatCol' || this.classList.contains('conversation-outgoing')) {
          window.conversationMotions.push({animation, target:this, keyframes, timing});
          if (window.pauseConversationMotion) animation.pause();
        }
        return animation;
      };
      window.sawEmptyTransition = false;
      const check = () => {
        const chat = document.getElementById('chatCol'), cover = document.querySelector('.conversation-snapshot, .conversation-outgoing');
        if (!cover && (chat.inert || !chat.textContent.includes('ANIMATION_'))) window.sawEmptyTransition = true;
        requestAnimationFrame(check);
      }; requestAnimationFrame(check);
    })()`)
    await browser.click(`[data-session-id="${b.id}"] .session-open`)
    await browser.waitFor('window.heldReads.length > 0')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('#conversationLoading .icon')).animationName")).toBe('conversation-spin')
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot').textContent")).toContain('ANIMATION_A')
    expect(await composer()).toEqual(composerBefore)
    await browser.evaluate('window.releaseHeldReads()')
    await browser.waitFor("window.conversationMotions.length === 2 && !document.getElementById('chatCol').hasAttribute('aria-busy')")
    expect(await browser.evaluate("document.querySelector('.conversation-outgoing').textContent")).toContain('ANIMATION_A')
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('ANIMATION_B')
    expect(await browser.evaluate("document.querySelector('.conversation-outgoing').inert && document.querySelector('.conversation-outgoing').getAttribute('aria-hidden') === 'true' && !document.getElementById('chatCol').inert && !document.getElementById('input').disabled")).toBe(true)
    expect(await browser.evaluate('window.conversationMotions.map(row => row.animation.effect.getTiming().duration)')).toEqual([240, 240])
    const midpoint = await browser.evaluate<{ oldOpacity: number; newOpacity: number; y: number }>(`(() => {
      window.conversationMotions.forEach(row => { row.animation.currentTime = 120; });
      return {oldOpacity:Number(getComputedStyle(document.querySelector('.conversation-outgoing')).opacity),
        newOpacity:Number(getComputedStyle(document.getElementById('chatCol')).opacity),
        y:new DOMMatrix(getComputedStyle(document.getElementById('chatCol')).transform).m42};
    })()`)
    expect(midpoint.oldOpacity).toBeGreaterThan(0); expect(midpoint.oldOpacity).toBeLessThan(1)
    expect(midpoint.newOpacity).toBeGreaterThan(.24); expect(midpoint.newOpacity).toBeLessThan(1)
    expect(midpoint.y).toBeGreaterThan(-8); expect(midpoint.y).toBeLessThan(0)
    expect(await composer()).toEqual(composerBefore)
    await snapshot('session-crossfade-midpoint')
    const canonical = await browser.evaluate<{ x: number; y: number; scrollTop: number; geometry: unknown }>(`(() => {
      const r=document.querySelector('#chatCol .msg-user').getBoundingClientRect(), t=new DOMMatrix(getComputedStyle(document.getElementById('chatCol')).transform);
      return {x:r.x-t.m41,y:r.y-t.m42,scrollTop:document.getElementById('chatScroll').scrollTop,
        geometry:['chatScroll','chatCol'].map(id=>{const node=document.getElementById(id), rect=node.getBoundingClientRect(), style=getComputedStyle(node);return {id,y:rect.y,height:rect.height,scrollTop:node.scrollTop,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,padding:style.padding};})};
    })()`)
    await browser.click(`[data-session-id="${c.id}"] .session-open`)
    await browser.waitFor('window.heldReads.length > 0')
    expect(await browser.evaluate('window.conversationMotions.slice(0, 2).map(row => row.animation.playState)')).toEqual(['idle', 'idle'])
    expect(await browser.evaluate("document.querySelectorAll('.conversation-outgoing').length")).toBe(0)
    expect(await browser.evaluate("document.querySelectorAll('.conversation-snapshot').length")).toBe(1)
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot').textContent")).toContain('ANIMATION_B')
    const nextSnapshot = await browser.evaluate<{ x: number; y: number; scrollTop: number; geometry: unknown }>("(() => { const r=document.querySelector('.conversation-snapshot .msg-user').getBoundingClientRect(); return {x:r.x,y:r.y,scrollTop:document.querySelector('.conversation-snapshot .chat-scroll').scrollTop,geometry:[document.querySelector('.conversation-snapshot .chat-scroll'),document.querySelector('.conversation-snapshot .chat-col')].map(node=>{const rect=node.getBoundingClientRect(),style=getComputedStyle(node);return {y:rect.y,height:rect.height,scrollTop:node.scrollTop,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,padding:style.padding};})}; })()")
    const geometryDiagnostic = JSON.stringify({ canonical, nextSnapshot })
    expect(nextSnapshot.x, geometryDiagnostic).toBeCloseTo(canonical.x, 4); expect(nextSnapshot.y, geometryDiagnostic).toBeCloseTo(canonical.y, 4)
    await browser.typeText('#input', ' MORE')
    await browser.evaluate('window.releaseHeldReads()')
    await browser.waitFor("window.conversationMotions.length === 4 && !document.getElementById('chatCol').hasAttribute('aria-busy')")
    await browser.evaluate('window.conversationMotions.slice(2).forEach(row => row.animation.finish())')
    await browser.waitFor("!document.querySelector('.conversation-outgoing, .conversation-snapshot')")
    expect(await browser.evaluate('window.sawEmptyTransition')).toBe(false)
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('ANIMATION_C')
    expect(await browser.evaluate("getComputedStyle(document.getElementById('chatCol')).opacity")).toBe('1')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('ANIMATION_DRAFT MORE')
    expect(await composer()).toEqual(composerBefore)
  })

  it('cleans up an active crossfade immediately when reduced motion is enabled or another main view opens', async () => {
    const handle = await server(); await handle.harness.run('CANCEL_MOTION_A')
    const a = handle.harness.main().sessionId
    const b = await handle.harness.ctx.sessions.create({ title: 'CANCEL_MOTION_B' })
    await b.append({ type: 'user/message', payload: { content: 'CANCEL_MOTION_B' } })
    await browser.navigate(handle.url); await ready(); await browser.fill('#input', 'CANCEL_MOTION_DRAFT')
    await browser.evaluate(`(() => {
      const animate = Element.prototype.animate; window.conversationMotions = [];
      Element.prototype.animate = function(keyframes, timing) {
        const animation = animate.call(this, keyframes, timing);
        if (this.id === 'chatCol' || this.classList.contains('conversation-outgoing')) { animation.pause(); window.conversationMotions.push(animation); }
        return animation;
      };
    })()`)
    await browser.click(`[data-session-id="${b.id}"] .session-open`)
    await browser.waitFor("window.conversationMotions.length === 2 && document.querySelector('.conversation-outgoing')")
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await browser.waitFor("!document.querySelector('.conversation-outgoing')")
    expect(await browser.evaluate('window.conversationMotions.map(animation => animation.playState)')).toEqual(['idle', 'idle'])
    expect(await browser.evaluate("getComputedStyle(document.getElementById('chatCol')).opacity")).toBe('1')
    expect(await browser.evaluate("getComputedStyle(document.getElementById('chatCol')).transform")).toBe('none')
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    await browser.click(`[data-session-id="${a}"] .session-open`)
    await browser.waitFor("window.conversationMotions.length === 4 && document.querySelector('.conversation-outgoing')")
    await browser.click('#settingsViewBtn')
    expect(await browser.evaluate("document.querySelector('.conversation-outgoing, .conversation-snapshot') === null")).toBe(true)
    expect(await browser.evaluate('window.conversationMotions.map(animation => animation.playState)')).toEqual(['idle', 'idle', 'idle', 'idle'])
    await browser.click('#settingsBack')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('CANCEL_MOTION_DRAFT')
  })

  it('keeps a persistent missing-model explanation and composer geometry while a session is read', async () => {
    const handle = await server({ adapter: undefined, sakuraApiOnly: true })
    const a = await handle.harness.ctx.sessions.create({ title: 'UNCONFIGURED_A' }), b = await handle.harness.ctx.sessions.create({ title: 'UNCONFIGURED_B' })
    await a.append({ type: 'user/message', payload: { content: 'UNCONFIGURED_A' } })
    await b.append({ type: 'user/message', payload: { content: 'UNCONFIGURED_B' } })
    const response = await fetch(handle.url + 'api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }) })
    expect(response.status).toBe(200)
    await browser.navigate(handle.url); await ready(); await browser.fill('#input', 'UNCONFIGURED_DRAFT')
    const composer = () => browser.evaluate("(() => { const r=document.querySelector('.composer').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()")
    const before = await composer()
    expect(await browser.evaluate("document.getElementById('composerStatus').textContent")).toContain('模型尚未配置')
    await browser.evaluate(`(() => {
      const original=window.fetch;window.heldReads=[];
      window.fetch=async function(resource,options){if(String(resource)==='/api/sessions/${b.id}/records')await new Promise(resolve=>window.heldReads.push(resolve));return original.call(this,resource,options)};
      window.releaseHeldReads=()=>window.heldReads.splice(0).forEach(resolve=>resolve());
    })()`)
    await browser.click(`[data-session-id="${b.id}"] .session-open`); await browser.waitFor('window.heldReads.length > 0')
    expect(await browser.evaluate("document.getElementById('composerStatus').checkVisibility() && document.getElementById('composerStatus').textContent.includes('模型尚未配置')")).toBe(true)
    expect(await browser.evaluate("document.getElementById('conversationLoadingText').textContent")).toContain('草稿可继续编辑')
    expect(await composer()).toEqual(before)
    await browser.typeText('#input', ' MORE'); await browser.evaluate('window.releaseHeldReads()'); await ready()
    await browser.waitFor("!document.querySelector('.conversation-outgoing')")
    expect(await composer()).toEqual(before)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('UNCONFIGURED_DRAFT MORE')
    expect(await browser.evaluate("document.getElementById('sendBtn').disabled")).toBe(true)
  })

  it('keeps the old transcript covered/inert while a delayed session loads and ignores its stale response after a rapid switch', async () => {
    const handle = await server(); await handle.harness.run('SESSION_A')
    const a = handle.harness.main().sessionId
    const b = await handle.harness.ctx.sessions.create({ title: 'SESSION_B' })
    await b.append({ type: 'user/message', payload: { content: 'SESSION_B' } })
    const c = await handle.harness.ctx.sessions.create({ title: 'SESSION_C' })
    await c.append({ type: 'user/message', payload: { content: 'SESSION_C' } })
    await browser.navigate(handle.url); await ready(); await browser.fill('#input', 'DRAFT_TO_KEEP')
    const outgoing = await browser.evaluate<{ x: number; y: number }>("(() => { const r = document.querySelector('#chatCol .msg-user').getBoundingClientRect(); return {x:r.x,y:r.y}; })()")
    await browser.evaluate(`(() => {
      const original = window.fetch; window.heldReads = [];
      window.fetch = async function(resource, options) {
        if (String(resource) === '/api/sessions/${b.id}/records') await new Promise(resolve => window.heldReads.push(resolve));
        return original.call(this, resource, options);
      };
      window.releaseHeldReads = () => window.heldReads.splice(0).forEach(resolve => resolve());
    })()`)
    await browser.click(
      `[data-session-id="${b.id}"] .session-open`)
    await browser.waitFor('window.heldReads.length > 0')
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot').textContent")).toContain('SESSION_A')
    expect(await browser.evaluate("(() => { const r = document.querySelector('.conversation-snapshot .msg-user').getBoundingClientRect(); return {x:r.x,y:r.y}; })()")).toEqual(outgoing)
    expect(await browser.evaluate("document.getElementById('chatCol').inert && getComputedStyle(document.getElementById('chatCol')).visibility === 'hidden'")).toBe(true)
    expect(await browser.evaluate("document.getElementById('sendBtn').disabled")).toBe(true)
    expect(await browser.evaluate("document.getElementById('welcome').hidden")).toBe(true)
    await browser.typeText('#input', ' MORE')
    await snapshot('session-loading-keeps-previous-page')
    await browser.click(`[data-session-id="${c.id}"] .session-open`)
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('SESSION_C') && !document.getElementById('chatCol').hasAttribute('aria-busy')")
    await browser.evaluate('window.releaseHeldReads()')
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot') === null")).toBe(true)
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).not.toContain('SESSION_B')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('DRAFT_TO_KEEP MORE')
    const state = await (await fetch(handle.url + 'api/state')).json() as { sessionId: string }
    expect(state.sessionId).toBe(c.id); expect(state.sessionId).not.toBe(a)
  })

  it.each([false, true])('ignores a delayed session mutation response after a newer selection (create=%s)', async creating => {
    const handle = await server(); await handle.harness.run('MUTATION_ORIGINAL')
    const second = await handle.harness.ctx.sessions.create({ title: 'MUTATION_SECOND' })
    await second.append({ type: 'user/message', payload: { content: 'MUTATION_SECOND' } })
    const last = await handle.harness.ctx.sessions.create({ title: 'MUTATION_LAST' })
    await last.append({ type: 'user/message', payload: { content: 'MUTATION_LAST' } })
    await browser.navigate(handle.url); await ready()
    await browser.evaluate(`(() => {
      const original = window.fetch; window.heldReads = []; let held = false;
      window.fetch = async function(resource, options) {
        const response = await original.call(this, resource, options);
        if (!held && resource === '/api/sessions' && options?.method === 'POST') {
          held = true; await new Promise(resolve => window.heldReads.push(resolve));
        }
        return response;
      };
      window.releaseHeldReads = () => window.heldReads.splice(0).forEach(resolve => resolve());
    })()`)
    if (creating) {
      await browser.click('#newSessionBtn'); await browser.fill('#newSessionTitle', 'MUTATION_CREATED'); await browser.click('#newSessionConfirm')
    } else await browser.click(`[data-session-id="${second.id}"] .session-open`)
    await browser.waitFor('window.heldReads.length === 1')
    if (creating) await browser.click('#newSessionCancel')
    await browser.click(`[data-session-id="${last.id}"] .session-open`)
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('MUTATION_LAST') && !document.getElementById('chatCol').hasAttribute('aria-busy')")
    await browser.fill('#input', 'MUTATION_LAST_DRAFT'); await browser.evaluate('window.releaseHeldReads()')
    await browser.waitFor("!document.getElementById('newSessionConfirm').disabled")
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 100))')
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('MUTATION_LAST')
    expect(await browser.evaluate("document.getElementById('sessionHeading').textContent")).toBe('MUTATION_LAST')
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('MUTATION_LAST_DRAFT')
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot') === null")).toBe(true)
  })

  it('preserves a copy button and its honest result through committed-history reconciliation', async () => {
    const handle = await server(); await handle.harness.run('COPY_RECONCILIATION')
    await browser.navigate(handle.url); await ready()
    await browser.evaluate(`(() => {
      const button = document.querySelector('#chatCol .msg-assist .message-action');
      window.copyButton = button;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
        writeText: async text => { window.copyValue = text; await new Promise((_, reject) => { window.failCopy = reject; }); }
      } });
      document.execCommand = () => false;
    })()`)
    await browser.click('#chatCol .msg-assist .message-action')
    await browser.waitFor('!!window.failCopy')
    handle.harness.ctx.emit('context/cleared', { sessionId: handle.harness.main().sessionId })
    await browser.waitFor("document.querySelector('#chatCol .msg-user-row [data-history-action]')")
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    expect(await browser.evaluate("document.querySelector('#chatCol .msg-assist .message-action') === window.copyButton")).toBe(true)
    expect(await browser.evaluate('window.copyValue')).toBe('READY_HISTORY')
    await browser.evaluate("window.failCopy(new Error('SYNTHETIC_DENIED'))")
    await browser.waitFor("document.querySelector('#chatCol .msg-assist .message-action').textContent === '复制失败'")
    handle.harness.ctx.emit('context/cleared', { sessionId: handle.harness.main().sessionId })
    await browser.evaluate('new Promise(resolve => setTimeout(resolve, 150))')
    expect(await browser.evaluate("document.querySelector('#chatCol .msg-assist .message-action').textContent")).toBe('复制失败')
  })

  it('shows a recoverable startup error rather than revealing an empty welcome page', async () => {
    const handle = await server(); await handle.harness.run('HISTORY_SURVIVES_FAILURE')
    await init(String.raw`
      window.failHistory = true;
      const original = window.fetch;
      window.fetch = function(resource, options) {
        if (window.failHistory && /\/records$/.test(String(resource))) return Promise.resolve(new Response(JSON.stringify({error:'SYNTHETIC_HISTORY_FAILURE'}), {status:500}));
        return original.call(this, resource, options);
      };
    `)
    await browser.navigate(handle.url)
    await browser.waitFor("!document.getElementById('bootActions').hidden")
    expect(await browser.evaluate("document.documentElement.dataset.boot")).toBe('loading')
    expect(await browser.evaluate("document.getElementById('bootStatus').textContent")).toContain('SYNTHETIC_HISTORY_FAILURE')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-orbit')).animationName")).toBe('none')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-mark svg')).animationName")).toBe('none')
    await browser.evaluate('window.failHistory = false'); await browser.click('#bootRetry'); await ready()
    expect(await browser.evaluate("document.getElementById('chatCol').textContent")).toContain('HISTORY_SURVIVES_FAILURE')
  })

  it('covers a workspace remount until the target transcript is read, without exposing the welcome page', async () => {
    const handle = await server({ onPersistSettings() {} }); await handle.harness.run('WORKSPACE_A')
    const other = await directory()
    await browser.navigate(handle.url); await ready()
    await browser.evaluate(`(() => {
      const original = window.fetch; window.heldReads = [];
      window.fetch = async function(resource, options) {
        if (/\\/records$/.test(String(resource))) await new Promise(resolve => window.heldReads.push(resolve));
        return original.call(this, resource, options);
      };
      window.releaseHeldReads = () => window.heldReads.splice(0).forEach(resolve => resolve());
    })()`)
    const response = await fetch(handle.url + 'api/desktop/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workspace: other }) })
    expect(response.status).toBe(200)
    await browser.waitFor("document.getElementById('chatCol').hasAttribute('aria-busy')")
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot').textContent")).toContain('WORKSPACE_A')
    expect(await browser.evaluate("document.getElementById('welcome').hidden")).toBe(true)
    await browser.evaluate('window.releaseHeldReads()'); await ready()
    expect(await browser.evaluate("document.getElementById('cwdEl').title")).toBe(other)
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot') === null")).toBe(true)
    expect(await browser.evaluate("document.getElementById('welcome').hidden")).toBe(false)
  })

  it('lets a delayed session read fail and retry without enabling old transcript actions or losing the draft', async () => {
    const handle = await server(); await handle.harness.run('BEFORE_READ_FAILURE')
    const target = await handle.harness.ctx.sessions.create({ title: 'TARGET_AFTER_RETRY' })
    await target.append({ type: 'user/message', payload: { content: 'TARGET_AFTER_RETRY' } })
    await browser.navigate(handle.url); await ready(); await browser.fill('#input', 'RETRY_DRAFT')
    await browser.evaluate(`(() => {
      const original = window.fetch; window.failNextHistory = true;
      window.fetch = function(resource, options) {
        if (window.failNextHistory && String(resource) === '/api/sessions/${target.id}/records') {
          window.failNextHistory = false;
          return Promise.resolve(new Response(JSON.stringify({error:'READ_FAILED'}), {status:500}));
        }
        return original.call(this, resource, options);
      };
    })()`)
    await browser.click(`[data-session-id="${target.id}"] .session-open`)
    await browser.waitFor("!document.getElementById('conversationReload').hidden")
    expect(await browser.evaluate("document.getElementById('sendBtn').disabled && document.getElementById('chatCol').inert")).toBe(true)
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot').textContent")).toContain('BEFORE_READ_FAILURE')
    await browser.click('#conversationReload')
    await browser.waitFor("!document.getElementById('chatCol').hasAttribute('aria-busy') && document.getElementById('chatCol').textContent.includes('TARGET_AFTER_RETRY')")
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('RETRY_DRAFT')
    expect(await browser.evaluate("document.querySelector('.conversation-snapshot') === null")).toBe(true)
  })

  it('uses identical logo bounds/style when the sidebar is hidden and shown and keeps expert header geometry stable', async () => {
    const handle = await server(); await handle.harness.run('EXPERT_GEOMETRY')
    await browser.navigate(handle.url); await ready()
    const logo = (selector: string) => browser.evaluate(`(() => {
      const mark = document.querySelector(${JSON.stringify(selector)}), r = mark.getBoundingClientRect(), s = getComputedStyle(mark);
      return {x:r.x,y:r.y,w:r.width,h:r.height,border:s.border,background:s.backgroundColor,radius:s.borderRadius};
    })()`)
    const expanded = await logo('#sidebarBrandBtn .brand-mark')
    await browser.click('#sidebarBrandBtn')
    expect(await logo('#menuBtn .brand-mark')).toEqual(expanded)
    await snapshot('unified-collapsed-sidebar-logo')
    await browser.click('#menuBtn')
    expect(await logo('#sidebarBrandBtn .brand-mark')).toEqual(expanded)
    const main = handle.harness.main()
    for (const [index, name] of ['架构师', '实现者', '审查者'].entries()) {
      const child = handle.harness.ctx.agents.spawn({ name, autoStart: false, seed: '', persistentSession: true, meta: { role: 'sub' } })
      handle.harness.ctx.emit('ui/text', { agentId: child.id, sessionId: child.sessionId, main: false, delta: 'EXPERT_' + index + '\n' + '稳定标题行，展开后显示内容。'.repeat(60) })
    }
    await browser.waitFor("document.querySelectorAll('#chatCol .sub-card').length === 3")
    const geometry = () => browser.evaluate<Array<{ height: number; x: number; y: number }>>(`Array.from(document.querySelectorAll('#chatCol .sub-card')).map(card => {
      const head=card.querySelector('.message-fold-head'), a=card.getBoundingClientRect(), b=head.getBoundingClientRect(); return {height:b.height,x:b.x-a.x,y:b.y-a.y};
    })`)
    const before = await geometry()
    await browser.evaluate("document.querySelectorAll('#chatCol .sub-card .message-fold-head').forEach(head => head.click())")
    expect(await geometry()).toEqual(before)
    await browser.evaluate("document.querySelectorAll('#chatCol .sub-card .message-fold-head').forEach(head => head.click())")
    expect(await geometry()).toEqual(before)
    expect(main.sessionId).toBe(handle.harness.main().sessionId)
    await snapshot('stable-expert-headings')
  })

  it('renders tool glyphs in history, live main/expert calls, approvals, catalogs and independent records', async () => {
    const handle = await server({ onWindowAction() {}, onPersistSettings() {} })
    await handle.harness.run('ICON_HISTORY')
    const main = handle.harness.main(), session = await handle.harness.ctx.sessions.open(main.sessionId)
    await session.append({ type: 'tool/call', payload: { id: 'history-read', name: 'read', arguments: '{"file_path":"fixture.txt"}' } })
    await session.append({ type: 'tool/result', payload: { id: 'history-read', name: 'read', output: 'HISTORICAL_READ', durationMs: 1 } })
    const child = handle.harness.ctx.agents.spawn({ name: '图标专家', autoStart: false, seed: '', persistentSession: true, meta: { role: 'sub' } })
    await child.turn('ICON_CHILD_HISTORY')
    const childSession = await handle.harness.ctx.sessions.open(child.sessionId)
    await childSession.append({ type: 'tool/call', payload: { id: 'child-call', name: 'browser_click', arguments: '{}' } })
    await browser.navigate(handle.url); await ready()
    expect(await browser.evaluate("document.querySelector('#chatCol .tool-head .tool-icon use').getAttribute('href')")).toBe('#i-file-read')
    expect(await browser.evaluate("document.querySelector('#chatCol .tool-head .tool-icon').getAttribute('aria-hidden')")).toBe('true')
    const emit = (name: string, mainCall = true, agentId = main.id, sessionId = main.sessionId) => {
      const callId = 'icon-' + name
      handle.harness.ctx.emit('ui/tool/call', { name, callId, agentId, sessionId, main: mainCall, argsRaw: '{}' })
      handle.harness.ctx.emit('ui/tool/result', { name, callId, agentId, sessionId, main: mainCall, output: 'ICON_RESULT', durationMs: 1 })
    }
    emit('pwsh'); emit('web_fetch'); emit('mcp__fixture__tool')
    emit('edit', false, child.id, child.sessionId)
    await browser.waitFor("document.querySelectorAll('#chatCol .tool-head .tool-icon').length === 5")
    expect(await browser.evaluate("[...document.querySelectorAll('#chatCol .tool-icon use')].map(use => use.getAttribute('href'))")).toEqual([
      '#i-file-read', '#i-terminal', '#i-web', '#i-plugin', '#i-edit'
    ])
    handle.harness.ctx.emit('ui/thinking', { main: true, agentId: main.id, delta: '合成思考内容' })
    await browser.waitFor("document.querySelector('#chatCol .think-head .think-icon')")
    await snapshot('tools-and-thinking-icons')
    await browser.click('#settingsViewBtn'); await browser.click('#marketBtn')
    expect(await browser.evaluate("document.querySelectorAll('#toolList .extension-card').length > 0 && [...document.querySelectorAll('#toolList .extension-card')].every(card => card.querySelector('.tool-icon'))")).toBe(true)
    await browser.click('#settingsBack'); await browser.click('#inspectorBtn')
    // Loading workspace history inserts cards above the agent list. Match the
    // other reader regressions: wait for that real read before taking pointer
    // coordinates, rather than clicking a button while its position changes.
    await browser.waitFor("document.getElementById('inspectorBtn').getAttribute('aria-expanded') === 'true' && document.querySelector('#collaborationWorkspaces .collaboration-workspace') && !document.getElementById('collaborationRefresh').disabled")
    await browser.waitFor(`document.querySelector('#agentList [data-agent-id="${child.id}"] .agent-view')`)
    await browser.click(`#agentList [data-agent-id="${child.id}"] .agent-view`)
    await browser.waitFor("document.querySelector('#agentReaderBody .thread-tool .tool-icon') && !document.getElementById('agentReader').hasAttribute('aria-busy')")
    expect(await browser.evaluate("document.querySelector('#agentReaderBody .thread-tool .tool-icon use').getAttribute('href')")).toBe('#i-pointer')
    handle.harness.ctx.tools.register({ name: 'icon_write_fixture', kind: 'write', description: 'SYNTHETIC_APPROVAL',
      parameters: { type: 'object', properties: {} }, async execute() { return 'SYNTHETIC_WRITE' } })
    const approval = handle.harness.ctx.tools.execute('icon-approval', 'icon_write_fixture', '{}', { agentId: main.id, sessionId: main.sessionId, signal: new AbortController().signal })
    await browser.waitFor("document.querySelector('.approval-card .tool-icon')")
    expect(await browser.evaluate("document.querySelector('.approval-card .tool-icon use').getAttribute('href')")).toBe('#i-file-write')
    await browser.click('.approval-card .ap-actions .btn-soft'); await approval
  })

  it('does not use startup or navigation animation under reduced motion and keeps one main view during rapid toggles', async () => {
    await browser.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    const handle = await server(); await handle.harness.run('REDUCED_MOTION_HISTORY')
    const target = await handle.harness.ctx.sessions.create({ title: 'REDUCED_MOTION_TARGET' })
    await target.append({ type: 'user/message', payload: { content: 'REDUCED_MOTION_TARGET' } })
    await browser.navigate(handle.url); await ready()
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-mark'), '::before').animationName")).toBe('none')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-mark svg')).animationName")).toBe('none')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('.boot-orbit')).animationName")).toBe('none')
    expect(await browser.evaluate("getComputedStyle(document.querySelector('#conversationLoading .icon')).animationName")).toBe('none')
    await browser.evaluate(`(() => {
      const animate = Element.prototype.animate; window.conversationAnimationCount = 0;
      Element.prototype.animate = function(keyframes, timing) {
        if (this.id === 'chatCol' || this.classList.contains('conversation-outgoing')) window.conversationAnimationCount++;
        return animate.call(this, keyframes, timing);
      };
    })()`)
    await browser.waitFor(`document.querySelector('[data-session-id="${target.id}"] .session-open')`)
    await browser.click(`[data-session-id="${target.id}"] .session-open`)
    await browser.waitFor("document.getElementById('chatCol').textContent.includes('REDUCED_MOTION_TARGET') && !document.getElementById('chatCol').hasAttribute('aria-busy')")
    expect(await browser.evaluate('window.conversationAnimationCount')).toBe(0)
    expect(await browser.evaluate("document.querySelector('.conversation-outgoing, .conversation-snapshot') === null")).toBe(true)
    await browser.fill('#input', 'REDUCED_DRAFT')
    const states = await browser.evaluate<Array<{ visible: number; opacity: string }>>(`(() => {
      const states=[];
      for(let i=0;i<8;i++) {
        document.getElementById('settingsViewBtn').click(); document.getElementById('settings-modelsTab').click();
        document.getElementById('settingsBack').click(); document.getElementById('dashboardBtn').click(); document.getElementById('chatViewBtn').click();
        states.push({visible:['chatScroll','dashboard','settingsView'].filter(id => document.getElementById(id).checkVisibility()).length,
          opacity:getComputedStyle(document.getElementById('chatCol')).opacity});
      }
      return states;
    })()`)
    expect(states).toHaveLength(8)
    expect(states.every(state => state.visible === 1 && state.opacity === '1')).toBe(true)
    expect(await browser.evaluate("document.getElementById('input').value")).toBe('REDUCED_DRAFT')
    expect(await browser.evaluate("document.querySelectorAll('.app-boot').length")).toBe(1)
  })
})