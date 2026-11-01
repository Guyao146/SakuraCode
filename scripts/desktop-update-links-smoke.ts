/** Isolated Windows update-link acceptance. No live updates, production statistics,
 * normal browser launch, real profiles or physical input.
 * node --import tsx <this-script> <absolute-candidate-exe> <new-evidence-directory>
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { BrowserClient, readCdpJson } from '../tests/browser-client.js'
import { defaultStatisticsSettings } from '../src/desktop/statistics.js'
import { DEFAULT_UPDATES_PAGE_URL, DEFAULT_UPDATES_URL } from '../src/updates.js'

const [exe, output] = process.argv.slice(2)
if (process.platform !== 'win32' || process.argv.length !== 4 || !exe || !output || !path.isAbsolute(exe) || !path.isAbsolute(output)) {
  throw new Error('Usage on Windows: desktop-update-links-smoke.ts <absolute-candidate-exe> <new-evidence-directory>')
}
assert.ok((await fs.stat(exe)).isFile(), 'use an existing isolated candidate EXE')
assert.equal(await fs.stat(output).then(() => true, () => false), false, 'use a fresh evidence directory')
await fs.mkdir(output, { recursive: true })
const startedAt = new Date().toISOString(), data = path.join(output, 'isolated-app-data'), cwd = path.join(output, '中文 project')
await fs.mkdir(data); await fs.mkdir(cwd)
const source = 'https://updates.example.test/sakuracode/latest.json'
const releaseUrl = 'https://updates.example.test/sakuracode/99.0.0/'
const downloadUrl = releaseUrl + 'SakuraCode%20Desktop.exe'
const manifest = { schemaVersion: 1, project: 'SakuraCode', platform: 'windows-x64', version: '99.0.0',
  releaseUrl, downloadUrl, sha256: 'a'.repeat(64), size: 98765432, notes: 'Synthetic offline update; never install.' }
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ Workspace: cwd, RecentWorkspaces: [cwd], Updates: { feedUrl: source, autoCheck: false } }))
const statisticsFile = path.join(data, 'usage-statistics', 'state.json')
await fs.mkdir(path.dirname(statisticsFile))
await fs.writeFile(statisticsFile, JSON.stringify({ schemaVersion: 1, settings: { ...defaultStatisticsSettings(), enabled: false },
  anonymousId: null, events: [], dropped: 0, rejected: 0 }))
const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex')
const settingsHash = await hash(path.join(data, 'settings.json')), statisticsHash = await hash(statisticsFile)
const log = path.join(output, 'preload-proof.jsonl'), control = path.join(output, 'browser-control.json')
await fs.writeFile(control, JSON.stringify({ fail: false }))
const preload = path.join(output, 'offline-preload.cjs')
// Preload before the SEA entry point: workspace plugins mount after fetch is captured.
// Intercept only the system-browser command, proving native dispatch without opening
// a user's browser. No arbitrary browser/OS commands or production requests escape.
await fs.writeFile(preload, `const fs = require('node:fs'), cp = require('node:child_process');
const record = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({pid:process.pid,...value})+'\\n');
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
  if (target.href === ${JSON.stringify(source)}) {
    record({kind:'update',url:target.href,headers:[...new Headers(init && init.headers).keys()]});
    return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(manifest))}));
  }
  if (target.href === ${JSON.stringify(DEFAULT_UPDATES_URL)}) {
    record({kind:'official-update-check',url:target.href,headers:[...new Headers(init && init.headers).keys()]});
    return Promise.reject(new Error('Synthetic offline official update check'));
  }
  if (!['127.0.0.1','localhost','[::1]'].includes(target.hostname)) {
    record({kind:'blocked',url:target.href});
    return Promise.reject(new Error('External network forbidden in update-link smoke'));
  }
  return originalFetch(url, init);
};
cp.spawn = (command, args, options) => {
  if (command !== 'rundll32.exe') throw new Error('Unexpected native child command: '+command);
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== 'url.dll,FileProtocolHandler' ||
    !${JSON.stringify([releaseUrl, downloadUrl, DEFAULT_UPDATES_PAGE_URL])}.includes(args[1])) throw new Error('Unsafe system-browser destination');
  const mode = JSON.parse(fs.readFileSync(${JSON.stringify(control)},'utf8'));
  record({kind:'system-browser',command,args,fail:mode.fail});
  const child = new (require('node:events').EventEmitter)();
  setTimeout(() => child.emit('exit', mode.fail ? 1 : 0), 300);
  return child;
};
require('node:module').syncBuiltinESMExports();
record({kind:'guard',fetch:true,systemBrowser:true});
`)
const nodeOptions = [process.env.NODE_OPTIONS ?? '', '--require ' + JSON.stringify(preload.replace(/\\/g, '/'))].filter(Boolean).join(' ')
type Proof = { pid: number; kind: string; command?: string; args?: string[]; fail?: boolean; url?: string; headers?: string[] }
const proof = async (): Promise<Proof[]> => (await fs.readFile(log, 'utf8').catch(() => '')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Proof)
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function wait(check: () => boolean | Promise<boolean>, label: string, timeout = 8000) {
  const end = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < end, label); await delay(60) }
}
interface RuntimeInfo { launcherPid: number; enginePid: number; browserPid: number; windowOwnerPid: number; url: string; browserProfile: string }
let launcher: ChildProcess | undefined, browser: BrowserClient | undefined, controller: BrowserClient | undefined, info: RuntimeInfo | undefined
const rounds: RuntimeInfo[] = []
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const checks: string[] = [], browserDocuments: string[] = [], popupEvents: unknown[] = [], transportFailures: string[] = []
let passed = false, failure: string | undefined, browserTargets: unknown[] = []
async function launch() {
  info = undefined
  await fs.unlink(path.join(data, 'browser-profile', 'DevToolsActivePort')).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  let launchError: Error | undefined
  launcher = spawn(exe, ['--data-dir', data, '--workspace', cwd], { cwd: output, stdio: 'ignore',
    env: { ...process.env, NODE_OPTIONS: nodeOptions, SAKURA_DESKTOP_DEBUG: '1', SAKURA_UPDATES_AUTO_CHECK: '0' } })
  launcher.once('error', error => { launchError = error })
  await wait(async () => {
    if (launchError) throw launchError
    assert.equal(launcher!.exitCode, null, 'native launcher exited before readiness')
    try { const value = JSON.parse(await fs.readFile(path.join(data, 'runtime.json'), 'utf8')) as RuntimeInfo
      if (value.launcherPid === launcher!.pid) { info = value; return true }
    } catch { /* Wait for the isolated launcher runtime record. */ }
    return false
  }, 'native runtime not ready', 60000)
  rounds.push(info!)
  assert.ok((await proof()).some(row => row.pid === info!.enginePid && row.kind === 'guard'), 'guard must precede the real engine entry point')
  const record = (await fs.readFile(path.join(info!.browserProfile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)
  const version = await readCdpJson<{ webSocketDebuggerUrl: string }>(record[0]!, '/json/version')
  assert.equal(new URL(version.webSocketDebuggerUrl).pathname, record[1])
  const pages = await readCdpJson<Array<{ url: string; webSocketDebuggerUrl: string }>>(record[0]!, '/json/list')
  const page = pages.find(row => row.url.startsWith(info!.url)); assert.ok(page)
  browser = new BrowserClient(); await browser.connect(page.webSocketDebuggerUrl)
  browser.onEvent('Page.windowOpen', event => popupEvents.push(event))
  controller = new BrowserClient(); await controller.connect(version.webSocketDebuggerUrl, 'browser')
  controller.onEvent('Target.attachedToTarget', event => {
    void (async () => {
      if (event.targetInfo.type === 'page') await controller!.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, event.sessionId)
      await controller!.send('Runtime.runIfWaitingForDebugger', {}, event.sessionId)
    })().catch(error => transportFailures.push(String(error)))
  })
  controller.onEvent('Fetch.requestPaused', (event, session) => {
    void (async () => {
      if (event.request.url.startsWith(info!.url)) { await controller!.send('Fetch.continueRequest', { requestId: event.requestId }, session); return }
      browserDocuments.push(event.request.url)
      await controller!.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
        body: Buffer.from('<!doctype html><title>Offline intercepted update link</title>').toString('base64') }, session)
    })().catch(error => transportFailures.push(String(error)))
  })
  await controller.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  await browser.waitFor("document.documentElement.dataset.boot === 'ready' && document.getElementById('appBoot').hidden")
}
async function stop() {
  controller?.disconnect(); browser?.disconnect(); controller = undefined; browser = undefined
  if (info) await fetch(info.url + 'api/desktop/window', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: '{"action":"close"}', signal: AbortSignal.timeout(3000) }).catch(() => {})
  if (launcher?.pid) await wait(() => !running(launcher!.pid!), 'isolated launcher did not exit', 10000)
  if (info) await wait(() => [info!.launcherPid, info!.enginePid, info!.browserPid, info!.windowOwnerPid].every(pid => !running(pid)), 'isolated native processes survived cleanup', 10000)
}
try {
  const engine = path.join(output, 'preflight-engine.exe')
  const build = path.join(path.dirname(exe), 'SakuraCode.exe')
  // The actual packaged engine is extracted by the launcher later. Preflight the
  // matching isolated SEA build first; fail closed if its --require guard is ignored.
  assert.ok((await fs.stat(build)).isFile(), 'candidate must include its matching isolated SEA engine')
  await fs.copyFile(build, engine, constants.COPYFILE_EXCL)
  const version = execFileSync(engine, ['--version'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, NODE_OPTIONS: nodeOptions } }).trim()
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/)
  assert.ok((await proof()).some(row => row.kind === 'guard'), 'SEA preflight must execute the early fetch/browser guard')
  checks.push('matching SEA --version preflight executes the early offline fetch/system-browser guard')
  await launch()
  await browser!.click('#settingsViewBtn'); await browser!.click('#settings-aboutTab'); await browser!.click('#settingsCheckUpdates')
  await browser!.waitFor("!document.getElementById('settingsUpdateLink').hidden && !document.getElementById('settingsCheckUpdates').disabled")
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateLink').href"), releaseUrl)
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateDownload').href"), downloadUrl)
  await browser!.screenshot(path.join(output, 'before-click.png'))
  await browser!.click('#settingsUpdateLink')
  await wait(async () => (await proof()).filter(row => row.kind === 'system-browser').length === 1, 'release-link click never reached the system browser')
  await browser!.waitFor("document.getElementById('settingsUpdateOpenMessage').textContent.includes('系统默认浏览器') && !document.getElementById('settingsUpdateLink').hasAttribute('aria-busy')")
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateOpenUrl').value"), releaseUrl)
  assert.equal(await browser!.evaluate('location.href'), info!.url)
  checks.push('trusted native release-link click dispatches the verified URL to the system browser without navigating the workspace')
  await fs.writeFile(control, JSON.stringify({ fail: true }))
  await browser!.click('#settingsUpdateDownload')
  await browser!.waitFor("document.getElementById('settingsUpdateOpenMessage').classList.contains('error') && !document.getElementById('settingsUpdateDownload').hasAttribute('aria-busy')")
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateOpenUrl').value"), downloadUrl)
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateOpenFallback').hidden"), false)
  checks.push('default-browser failure is visible and retains the verified download address for manual copying')
  await fs.writeFile(control, JSON.stringify({ fail: false }))
  await browser!.click('#settingsUpdateDownload')
  await browser!.waitFor("!document.getElementById('settingsUpdateOpenMessage').classList.contains('error') && !document.getElementById('settingsUpdateDownload').hasAttribute('aria-busy')")
  const dispatches = (await proof()).filter(row => row.kind === 'system-browser')
  assert.deepEqual(dispatches.map(row => ({ url: row.args![1], fail: row.fail })), [
    { url: releaseUrl, fail: false }, { url: downloadUrl, fail: true }, { url: downloadUrl, fail: false },
  ])
  checks.push('explicit retry dispatches once and clears the previous browser error')
  assert.deepEqual(browser!.errors, [])
  assert.equal(await hash(path.join(data, 'settings.json')), settingsHash)
  await browser!.screenshot(path.join(output, 'native-custom-update-links.png'))
  await stop()
  // Modify only this stopped smoke's fixture; never persist over live or real settings.
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ Workspace: cwd, RecentWorkspaces: [cwd], Updates: { feedUrl: '', autoCheck: false } }))
  const officialSettingsHash = await hash(path.join(data, 'settings.json'))
  await launch()
  await browser!.click('#settingsViewBtn'); await browser!.click('#settings-aboutTab')
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateLink').href"), DEFAULT_UPDATES_PAGE_URL)
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateLink').hidden"), false)
  const beforeCheck = (await proof()).filter(row => row.kind === 'official-update-check').length
  await browser!.click('#settingsUpdateLink')
  await browser!.waitFor("document.getElementById('settingsUpdateOpenMessage').textContent.includes('已请求系统默认浏览器') && !document.getElementById('settingsUpdateLink').hasAttribute('aria-busy')")
  assert.equal((await proof()).filter(row => row.kind === 'official-update-check').length, beforeCheck)
  checks.push('native official download site opens without a version check')
  await browser!.click('#settingsCheckUpdates')
  await browser!.waitFor("document.getElementById('settingsUpdateHint').textContent.includes('检查失败') && !document.getElementById('settingsCheckUpdates').disabled")
  await browser!.evaluate("document.getElementById('settingsUpdateLink').focus()")
  await browser!.key('Enter')
  await wait(async () => (await proof()).filter(row => row.kind === 'system-browser').length === 5, 'native keyboard link did not reach the system browser')
  await browser!.waitFor("!document.getElementById('settingsUpdateLink').hasAttribute('aria-busy') && !document.getElementById('settingsUpdateOpenMessage').classList.contains('error')")
  assert.equal(await browser!.evaluate("document.getElementById('settingsUpdateOpenUrl').value"), DEFAULT_UPDATES_PAGE_URL)
  assert.equal(await browser!.evaluate('location.href'), info!.url)
  assert.deepEqual((await proof()).filter(row => row.kind === 'system-browser').slice(3).map(row => row.args![1]), [DEFAULT_UPDATES_PAGE_URL, DEFAULT_UPDATES_PAGE_URL])
  assert.equal(await hash(path.join(data, 'settings.json')), officialSettingsHash)
  checks.push('native official download site remains available after an offline version check; Enter activates it without losing the workspace')
  assert.deepEqual(browserDocuments, [], 'native update links must not create hidden kiosk tabs')
  assert.deepEqual(popupEvents, [], 'native links must bypass the kiosk popup route')
  assert.deepEqual((await proof()).filter(row => row.kind === 'blocked'), [], 'no unexpected production requests')
  assert.equal(await hash(statisticsFile), statisticsHash)
  assert.equal(await fs.stat(path.join(data, 'sakuraapi.json')).then(() => true, () => false), false)
  assert.deepEqual(transportFailures, []); assert.deepEqual(browser!.errors, [])
  await browser!.screenshot(path.join(output, 'native-update-links.png'))
  checks.push('no hidden tabs, production events, account storage or saved-settings changes')
  passed = true
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(failure); process.exitCode = 1
} finally {
  if (controller) browserTargets = (await controller.send('Target.getTargets').catch(() => ({ targetInfos: [] }))).targetInfos
    .map((row: { type: string; url: string }) => ({ type: row.type, url: row.url }))
  if (browser) await browser.screenshot(path.join(output, passed ? 'final.png' : 'failure.png')).catch(() => {})
  await stop().catch(() => { if (launcher?.pid && running(launcher.pid)) launcher.kill() })
  const trackedPids = [...new Set([...rounds.flatMap(round => [round.launcherPid, round.enginePid, round.browserPid, round.windowOwnerPid]), ...(launcher?.pid ? [launcher.pid] : [])])]
  await wait(() => trackedPids.every(pid => !running(pid)), 'isolated native processes survived cleanup', 10000).catch(error => {
    failure = [failure, String(error)].filter(Boolean).join('\n'); passed = false; process.exitCode = 1
  })
  await fs.writeFile(path.join(output, 'native-update-links-verification.json'), JSON.stringify({ passed, startedAt, finishedAt: new Date().toISOString(),
    candidateExe: exe, sha256: await hash(exe), runtime: info, rounds, productionEvents: 0, normalBrowserLaunches: 0, noPhysicalInput: true,
    checks, proof: await proof(), popupEvents, browserDocuments, browserTargets, transportFailures,
    processCleanup: trackedPids.map(pid => ({ pid, running: running(pid) })), failure }, null, 2), { flag: 'wx' })
  if (passed) console.log('Native isolated update release/download links, browser failure/retry and cleanup PASS; production events: 0')
}