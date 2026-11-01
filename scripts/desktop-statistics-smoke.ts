/** Explicit, isolated Windows acceptance. No production events, administrator credentials or physical input.
 * node --import tsx scripts/desktop-statistics-smoke.ts <absolute-candidate-exe> <new-evidence-directory>
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import { BrowserClient, readCdpJson } from '../tests/browser-client.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { defaultStatisticsSettings, parseStatisticsStored, type StatisticsEvent, type StatisticsStatus } from '../src/desktop/statistics.js'

const [exe, output] = process.argv.slice(2)
if (process.platform !== 'win32' || process.argv.length !== 4 || !exe || !output || !path.isAbsolute(exe) || !path.isAbsolute(output)) {
  throw new Error('Usage on Windows: desktop-statistics-smoke.ts <absolute-candidate-exe> <new-evidence-directory>')
}
assert.ok((await fs.stat(exe)).isFile(), 'use an existing isolated candidate EXE')
assert.equal(await fs.stat(output).then(() => true, () => false), false, 'use a fresh evidence directory')
await fs.mkdir(output, { recursive: true })
const startedAt = new Date().toISOString(), data = path.join(output, 'isolated-app-data'), cwd = path.join(output, '中文 project')
await fs.mkdir(data); await fs.mkdir(cwd); await fs.mkdir(path.join(cwd, 'plugins'))
await fs.writeFile(path.join(cwd, 'package.json'), '{"type":"module"}')
await fs.writeFile(path.join(cwd, 'sakura.yml'), 'pluginsDir: plugins\n')
await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ Workspace: cwd, RecentWorkspaces: [cwd], Updates: { feedUrl: '', autoCheck: false } }))
const settingsHash = createHash('sha256').update(await fs.readFile(path.join(data, 'settings.json'))).digest('hex')
const appId = defaultStatisticsSettings().appId, rows: Array<{ app_id: string; events: StatisticsEvent[] }> = [], failures: string[] = []
let hold = false, held: http.ServerResponse | undefined
const seen = new Set<string>()
const collector = http.createServer((req, res) => {
  void (async () => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/collect')
    for (const key of ['authorization', 'cookie', 'origin', 'x-sakura-workspace']) assert.equal(req.headers[key], undefined, 'private header must not be forwarded')
    let body = ''
    for await (const bytes of req) { body += String(bytes); assert.ok(Buffer.byteLength(body) <= 64 * 1024) }
    const value = JSON.parse(body) as { app_id: string; events: StatisticsEvent[] }
    assert.deepEqual(Object.keys(value).sort(), ['app_id', 'events']); assert.equal(value.app_id, appId)
    assert.ok(value.events.length >= 1 && value.events.length <= 50)
    for (const event of value.events) {
      assert.deepEqual(Object.keys(event).sort(), ['anonymous_id', 'app_version', 'event_id', 'event_type', 'occurred_at', 'platform', 'schema_version', 'sdk_version', 'session_id'].sort())
      assert.ok(event.event_type === 'active' || event.event_type === 'app_start'); assert.equal(event.platform, 'windows')
      assert.equal(event.sdk_version, 'sakuracode-desktop/1')
    }
    rows.push(value)
    if (hold) { held = res; return }
    let accepted = 0, duplicates = 0
    for (const event of value.events) { if (seen.has(event.event_id)) duplicates++; else { accepted++; seen.add(event.event_id) } }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted, duplicates, rejected: [] }))
  })().catch(error => { failures.push(error instanceof Error ? error.message : String(error)); res.writeHead(500); res.end() })
})
await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve))
const address = collector.address()
assert.ok(address && typeof address !== 'string')
const endpoint = `http://127.0.0.1:${address.port}/api/collect`, statisticsFile = path.join(data, 'usage-statistics', 'state.json')
// Keep the real default preferences untouched. Only this isolated fixture
// rewrites the destination before fetch, so no production events are delivered.
const fixture = `const original = globalThis.fetch;
module.exports = {name:'offline-statistics-smoke-guard',apply() {
  if (globalThis.__statisticsSmokeGuard) return;
  globalThis.__statisticsSmokeGuard = true;
  globalThis.fetch = (url, init) => {
    const target = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    if (target.href === ${JSON.stringify(defaultStatisticsSettings().endpoint)}) return original(${JSON.stringify(endpoint)}, init);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error('External network forbidden in isolated statistics smoke');
    return original(url, init);
  };
}};
`
await fs.writeFile(path.join(cwd, 'plugins', 'offline.cjs'), fixture)
// The host captures fetch before it mounts workspace plugins. Preload the same
// isolated guard before the SEA entry point so default-on requests are guarded too.
const preload = path.join(output, 'offline-preload.cjs'), preloadProof = path.join(output, 'preload-proof.jsonl')
await fs.writeFile(preload, `require(${JSON.stringify(path.join(cwd, 'plugins', 'offline.cjs'))}).apply();
require('node:fs').appendFileSync(${JSON.stringify(preloadProof)}, JSON.stringify({pid:process.pid,guard:globalThis.__statisticsSmokeGuard===true})+'\\n');\n`)
const nodeOptions = [process.env.NODE_OPTIONS ?? '', '--require ' + JSON.stringify(preload.replace(/\\/g, '/'))].filter(Boolean).join(' ')
const proof = async () => (await fs.readFile(preloadProof, 'utf8')).trim().split(/\r?\n/)
  .filter(Boolean).map(line => JSON.parse(line) as { pid: number; guard: boolean })
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
async function wait(check: () => boolean | Promise<boolean>, label: string, timeout = 60_000) {
  const end = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < end, label); await delay(80) }
}
interface RuntimeInfo {
  launcherPid: number; enginePid: number; browserPid: number; windowOwnerPid: number
  windowHandle: number; browserWindowHandle: number; url: string; browserProfile: string
}
let launcher: ChildProcess | undefined, browser: BrowserClient | undefined, info: RuntimeInfo | undefined
const rounds: Array<{ launcherPid: number; enginePid: number; port: number }> = []
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const read = async () => await (await fetch(info!.url + 'api/desktop/statistics', { signal: AbortSignal.timeout(3000) })).json() as StatisticsStatus
const post = (route: string, body: unknown) => fetch(info!.url + route, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
const stored = async () => parseStatisticsStored(JSON.parse(await fs.readFile(statisticsFile, 'utf8')) as unknown)
async function launch() {
  // Chromium leaves this single debug record behind after exit. Only remove
  // the file in this smoke's new data directory, after the previous app stops.
  await fs.unlink(path.join(data, 'browser-profile', 'DevToolsActivePort')).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  let error: Error | undefined
  launcher = spawn(exe!, ['--data-dir', data, '--workspace', cwd], { cwd: output!, windowsHide: false, stdio: 'ignore',
    env: { ...process.env, NODE_OPTIONS: nodeOptions, SAKURA_DESKTOP_DEBUG: '1', SAKURA_UPDATES_AUTO_CHECK: '0', SAKURA_WEB_HOST: '0.0.0.0',
      SAKURA_WEB_TOKEN: 'ignored inherited token', SAKURA_WEB_VIEWER_TOKEN: 'ignored inherited viewer token' } })
  launcher.once('error', failure => { error = failure })
  await wait(async () => {
    if (error) throw error
    assert.equal(launcher!.exitCode, null, 'isolated launcher exited before readiness')
    try { const value = JSON.parse(await fs.readFile(path.join(data, 'runtime.json'), 'utf8')) as RuntimeInfo
      if (value.launcherPid === launcher!.pid) { info = value; return true }
    } catch { /* Wait for one atomic runtime record, not an old launch. */ }
    return false
  }, 'native runtime not ready')
  assert.ok((await proof()).some(row => row.pid === info!.enginePid && row.guard), 'engine transport must be guarded before entry point')
  await wait(async () => {
    const record = (await fs.readFile(path.join(info!.browserProfile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split(/\r?\n/)
    if (!/^\d+$/.test(record[0] ?? '') || !record[1]) return false
    try {
      const version = await readCdpJson<{ webSocketDebuggerUrl: string }>(record[0]!, '/json/version')
      if (new URL(version.webSocketDebuggerUrl).pathname !== record[1]) return false
      const pages = await readCdpJson<Array<{ url: string; webSocketDebuggerUrl: string }>>(record[0]!, '/json/list')
      const page = pages.find(row => row.url.startsWith(info!.url))
      if (!page) return false
      const connection = new BrowserClient()
      await connection.connect(page.webSocketDebuggerUrl)
      browser = connection
      return true
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || failure instanceof Error && /^CDP connection (failed|timed out)$/.test(failure.message)) return false
      throw failure
    }
  }, 'fresh isolated CDP target not ready', 15_000)
  assert.ok(browser, 'fresh CDP connection must be established')
  await browser.waitFor("document.documentElement.dataset.boot === 'ready' && document.getElementById('appBoot').hidden && document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  await wait(async () => (await read()).ready, 'statistics settings not ready')
  rounds.push({ launcherPid: info!.launcherPid, enginePid: info!.enginePid, port: Number(new URL(info!.url).port) })
}
async function stop() {
  if (!info || !launcher) return
  const previous = info
  // Native close tears down Chromium. Detach first instead of sending a late
  // Browser.close to a retired endpoint (or a newly reused debug port).
  browser?.disconnect(); browser = undefined
  assert.equal((await post('api/desktop/window', { action: 'close' })).status, 200)
  await wait(() => !running(previous.launcherPid) && !running(previous.enginePid) && !running(previous.windowOwnerPid), 'isolated runtime survived shutdown', 15_000)
  launcher = undefined; info = undefined
}
const checks: string[] = []
let passed = false, failure = ''
try {
  // --version exits before starting the desktop host or creating any events.
  // Prove the packaged SEA engine honours the preload before launching the GUI.
  const engine = path.join(path.dirname(exe!), 'SakuraCode.exe')
  assert.ok((await fs.stat(engine)).isFile(), 'keep the standalone engine next to the candidate for safe preload verification')
  const version = execFileSync(engine, ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: nodeOptions } }).trim()
  assert.match(version, /^\d+\.\d+\.\d+$/)
  assert.ok((await proof()).some(row => row.guard), 'SEA preload must install the loopback guard')
  checks.push('packaged SEA --version proves the offline preload works before any host or event is created')
  await launch()
  assert.deepEqual((await read()).settings, defaultStatisticsSettings())
  assert.equal(await fs.stat(statisticsFile).then(() => true, () => false), true)
  await browser!.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-generalTab').click()")
  await browser!.waitFor("document.getElementById('statisticsSettingsCard').checkVisibility()")
  assert.equal(await browser!.evaluate("document.getElementById('statisticsEnabled') === null && document.querySelector('#statisticsSettingsCard input[type=checkbox]') === null"), true)
  await browser!.screenshot(path.join(output, 'native-statistics-default-on.png'))
  checks.push('native startup defaults enabled and persists app_start without configuration; no checkbox')
  await wait(async () => (await stored()).events.length === 1, 'local startup event not committed')
  const initial = await stored(), installation = initial.anonymousId!
  assert.equal(initial.events[0]!.event_type, 'app_start')
  await wait(() => rows.length === 1, 'local collector did not receive startup', 15_000)
  await wait(async () => (await read()).pending === 0, 'complete acknowledgement not saved')
  checks.push('default sender routed only to loopback by the isolated fixture and acknowledged with no auth/private headers')
  await browser!.evaluate("document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.dispatchEvent(new KeyboardEvent('keydown',{key:'x',bubbles:true}))")
  await delay(300); assert.equal((await read()).pending, 0)
  checks.push('untrusted DOM input does not create active events')
  await stop(); await launch()
  await wait(async () => (await stored()).events.length === 1, 'restart startup event missing')
  const second = await stored()
  assert.equal(second.anonymousId, installation); assert.notEqual(second.events[0]!.session_id, initial.events[0]!.session_id)
  checks.push('persistent installation identity and fresh per-launch session/start')
  await wait(() => rows.length === 2, 'restarted startup not sent', 15_000)
  await wait(async () => (await read()).pending === 0, 'restart acknowledgement missing')
  hold = true
  assert.equal((await post('api/desktop/statistics/activity', {})).status, 200)
  await wait(async () => (await read()).pending === 1, 'interaction signal not queued')
  await wait(() => !!held, 'local in-flight active batch not observed', 15_000)
  // The real-browser test covers trusted mouse/keyboard. This explicit local
  // route exercises the same app-scoped interaction bridge without moving the user's pointer.
  assert.equal((await post('api/desktop/statistics', { ...defaultStatisticsSettings(), enabled: false })).status, 200)
  assert.deepEqual((await stored()).events, []); assert.equal((await stored()).anonymousId, null)
  hold = false; held!.end(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] })); held = undefined
  await delay(150); assert.equal((await read()).settings.enabled, false); assert.equal((await read()).pending, 0)
  checks.push('disable aborts an in-flight request and clears local identity/queue; late reply is ignored')
  await stop(); await launch()
  assert.equal((await read()).settings.enabled, false); assert.equal((await stored()).anonymousId, null)
  assert.equal((await post('api/desktop/statistics/activity', {})).status, 200)
  await delay(150); assert.equal((await read()).pending, 0)
  assert.equal(createHash('sha256').update(await fs.readFile(path.join(data, 'settings.json'))).digest('hex'), settingsHash)
  assert.equal(await fs.stat(path.join(data, 'sakuraapi.json')).then(() => true, () => false), false)
  assert.deepEqual(failures, []); assert.deepEqual(browser!.errors, [])
  checks.push('disabled restart remains silent; legacy settings/account files are untouched')
  await browser!.screenshot(path.join(output, 'native-statistics-restarted.png')); await stop()
  passed = true
} catch (error) {
  failure = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(failure); process.exitCode = 1
} finally {
  if (info && launcher) await stop().catch(() => {})
  if (launcher?.pid && running(launcher.pid)) {
    // Only the process created by this smoke, with its dedicated Job Object.
    launcher.kill(); await delay(500)
  }
  browser?.disconnect()
  held?.destroy(); collector.closeAllConnections(); await new Promise<void>(resolve => collector.close(() => resolve()))
  const report = { passed, startedAt, finishedAt: new Date().toISOString(), candidateExe: exe,
    sha256: createHash('sha256').update(await fs.readFile(exe)).digest('hex'), dataDirectory: data, rounds,
    productionEvents: 0, noPhysicalInput: true, checks, localBatches: rows.map(row => ({ events: row.events.map(event => event.event_type) })), failure }
  await fs.writeFile(path.join(output, 'native-statistics-verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
  if (passed) console.log('Native isolated default-on statistics startup/persistence/acknowledgement/restart/disable PASS; production events: 0')
}