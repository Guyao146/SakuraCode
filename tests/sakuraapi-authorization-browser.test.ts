/** Real Chromium opener/popup/navigation/postMessage, with CDP intercepting
 * only the official popup document. No live account, CAPTCHA or Key creation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserClient } from './browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { openSakuraApiAuthorization, SAKURA_AUTHORIZATION_URL } from '../src/integrations/sakuraapi-authorization.js'
import { clientAuthorization } from './sakuraapi-client-fixture.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.() })
const suite = resolveChromePath() && typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function' ? describe : describe.skip

suite('official consent popup (real browser, synthetic page)', () => {
  it.each(['ordinary-tab', 'script-opened'])('closes only acknowledged authorization pages (%s), preserving unrelated tabs', async kind => {
    const browser = new BrowserClient()
    cleanups.push(() => browser.close())
    await browser.start()
    const controller = new BrowserClient()
    await controller.connect(browser.browserDebuggerUrl, 'browser')
    const failures: unknown[] = []
    const documents = new Set<string>()
    controller.onEvent('Target.attachedToTarget', (event) => {
      void (async () => {
        const session = event.sessionId
        if (event.targetInfo.type === 'page') await controller.send('Fetch.enable', { patterns: [{ urlPattern: 'https://sakuraapi.top/*', requestStage: 'Request' }] }, session)
        await controller.send('Runtime.runIfWaitingForDebugger', {}, session)
      })().catch(error => failures.push(error))
    })
    controller.onEvent('Fetch.requestPaused', (event, session) => {
      void (async () => {
        if (event.resourceType !== 'Document') { await controller.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, session); return }
        documents.add(event.request.url)
        const official = new URL(event.request.url)
        const html = official.pathname === new URL(SAKURA_AUTHORIZATION_URL).pathname
          ? '<!doctype html><title>Synthetic consent</title><script>location.href=' + JSON.stringify('/login?state=' + official.searchParams.get('state')) + '</script>'
          : event.request.url.includes('/login?')
            ? '<!doctype html><title>Synthetic login</title><button id="complete">模拟完成登录并同意授权</button><script>document.getElementById("complete").onclick=()=>{window.opener.postMessage(' + JSON.stringify({ source:'sakura-client-authorization', ...clientAuthorization(official.searchParams.get('state')!) }) + ',"*")}</script>'
            : '<!doctype html><title>Unrelated official tab</title>'
        await controller.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }], body: Buffer.from(html).toString('base64') }, session)
      })().catch(error => failures.push(error))
    })
    await controller.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    let url = ''
    const authorization = await openSakuraApiAuthorization({ openBrowser: async target => { url = target } })
    const authorized = clientAuthorization(authorization.draft!.state)
    cleanups.push(() => authorization.close())
    await browser.navigate('data:text/html,<title>Synthetic browser owner</title>')
    let receiver = browser
    if (kind === 'script-opened') {
      await browser.send('Runtime.evaluate', { expression: 'window.open(' + JSON.stringify(url) + ', "_blank")', userGesture: true })
    } else {
      // More than one document in a normal tab exercises Chromium's refusal
      // to close tabs not opened by script, without changing production code.
      await browser.navigate(url)
    }
    let receiverTarget: { targetId: string } | undefined
    await vi.waitFor(async () => {
      const { targetInfos } = await controller.send('Target.getTargets')
      receiverTarget = targetInfos.find((row: any) => row.url === url)
      expect(receiverTarget).toBeDefined()
    }, { timeout: 8000 })
    if (kind === 'script-opened') {
      receiver = new BrowserClient()
      await receiver.connect(new URL(browser.browserDebuggerUrl).origin + '/devtools/page/' + receiverTarget!.targetId)
    }
    await receiver.waitFor("!!document.getElementById('authorize')")
    await receiver.click('#authorize')
    let popup: { targetId: string; url: string } | undefined
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 8000
      const poll = async () => {
        try {
          const { targetInfos } = await controller.send('Target.getTargets')
          popup = targetInfos.find((row: any) => row.url.includes('sakuraapi.top/login?'))
          if (popup) resolve()
          else if (Date.now() > deadline) reject(new Error('synthetic official consent did not navigate: ' + JSON.stringify({ targets: targetInfos.map((row: any) => ({ url: row.url, type: row.type })), documents: [...documents], failures: failures.map(String), status: await receiver.evaluate("document.getElementById('status').textContent"), errors: receiver.errors })))
          else setTimeout(poll, 50)
        } catch (error) { reject(error) }
      }
      void poll()
    })
    expect(await authorization.readAuthorization()).toBeNull()
    // A second official-origin popup must not be confused with the one opened
    // by the user's consent button, even when it sends a valid authorization code.
    await receiver.send('Runtime.evaluate', { expression: "window.open('https://sakuraapi.top/unrelated', 'unrelated-official-tab')", userGesture: true })
    let unrelated: { targetId: string } | undefined
    const deadline = Date.now() + 8000
    while (!unrelated) {
      const { targetInfos } = await controller.send('Target.getTargets')
      unrelated = targetInfos.find((row: any) => row.url === 'https://sakuraapi.top/unrelated')
      if (!unrelated && Date.now() > deadline) throw new Error('unrelated official popup did not open: ' + JSON.stringify(targetInfos.map((row: any) => row.url)))
      if (!unrelated) await new Promise(resolve => setTimeout(resolve, 50))
    }
    const other = await controller.send('Target.attachToTarget', { targetId: unrelated.targetId, flatten: true })
    await controller.send('Runtime.evaluate', { expression: 'window.opener.postMessage(' + JSON.stringify({ source: 'sakura-client-authorization', ...authorized }) + ', "*")', awaitPromise: true }, other.sessionId)
    await receiver.evaluate('new Promise(resolve => setTimeout(resolve, 100))')
    expect(await authorization.readAuthorization()).toBeNull()
    const { sessionId } = await controller.send('Target.attachToTarget', { targetId: popup!.targetId, flatten: true })
    await controller.send('Runtime.evaluate', { expression: 'document.getElementById("complete").click()', awaitPromise: true }, sessionId)
    await vi.waitFor(async () => expect(await authorization.readAuthorization()).toEqual(authorized), { timeout: 8000 })
    await vi.waitFor(async () => {
      const { targetInfos } = await controller.send('Target.getTargets')
      expect(targetInfos.some((row: any) => row.targetId === popup!.targetId)).toBe(false)
      expect(targetInfos.some((row: any) => row.targetId === unrelated!.targetId)).toBe(true)
      expect(targetInfos.some((row: any) => row.targetId === receiverTarget!.targetId)).toBe(kind === 'ordinary-tab')
    }, { timeout: 8000 })
    if (kind === 'ordinary-tab') {
      await receiver.waitFor("document.getElementById('status').textContent.includes('手动关闭此页')")
      expect(await receiver.evaluate('window.closed')).toBe(false)
    } else expect(await browser.evaluate('document.title')).toBe('Synthetic browser owner')
    expect([...documents].some(url => url.startsWith(SAKURA_AUTHORIZATION_URL + '?'))).toBe(true)
    expect(failures).toEqual([])
    expect(browser.errors).toEqual([])
    expect(receiver.errors).toEqual([])
  })
})