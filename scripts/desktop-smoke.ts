/** Opt-in real Windows desktop test. npm run desktop; npx tsx scripts/desktop-smoke.ts [absolute-exe-path] [--no-physical-input] */
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserClient, readCdpJson } from '../tests/browser-client.js'
import { sessionAction } from '../tests/client-session-actions.js'
import { resolveChromePath } from '../src/tools/browser.js'
import { framesForText, startMockServer } from './mock-openai-server.js'
import { SAKURA_API_ORIGIN, SAKURA_MODEL_BASE_URL } from '../src/integrations/sakuraapi.js'
import { authorizedKey, metadata, modelIds, usage } from '../tests/sakuraapi-fixture.js'
import { clientAccessToken, clientKey, clientRefreshToken, clientStatistics, clientSubscriptions, clientTokens, clientUser, clientVip,
  noClientSecrets, rotatedAccessToken, rotatedRefreshToken } from '../tests/sakuraapi-client-fixture.js'
import type { ChatAttachment } from '../src/core/attachments.js'
import type { TurnMetrics } from '../src/core/types.js'
import type { DesktopViewport } from '../src/util/viewport.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const exe = process.argv[2] ?? path.join(root, 'build', 'SakuraCode Desktop.exe')
const physicalInputDisabled = process.argv[3] === '--no-physical-input'
if (process.argv.length > 4 || process.argv[3] && !physicalInputDisabled) throw new Error('Usage: desktop-smoke.ts [absolute-exe-path] [--no-physical-input]')
const startedAt = new Date().toISOString()
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-smoke-'))
const cwd = path.join(scratch, '中文 project')
const dataDir = path.join(scratch, 'desktop data')
const previews = process.env.SAKURA_DESKTOP_SMOKE_OUTPUT || path.join(root, 'tmp', 'desktop-previews')
const verificationFile = path.join(previews, 'desktop-smoke-verification.json')
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const request = async (url: string) => {
  try { return await fetch(url, { signal: AbortSignal.timeout(10000) }) }
  catch (error) { throw new Error(`GET ${url} failed: ${String(error)}`, { cause: error }) }
}
const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(10000),
})
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const mock = await startMockServer({ script: [
  () => framesForText('DESKTOP_GUI_SMOKE_OK'),
  () => framesForText('DESKTOP_CONTEXT_COMPACT_SUMMARY'),
  () => framesForText('OTHER_WORKSPACE_SMOKE_OK'),
  () => framesForText('MEMORY_DISABLED_SMOKE_OK'),
  () => framesForText('PRODUCTIVITY_NATIVE_RESULT'),
  () => framesForText('# PRODUCTIVITY_NATIVE_MEMORY\n- Native memory consolidation succeeded.'),
  ...Array.from({ length: 4 }, () => () => framesForText('NATIVE_CHAT_FILES_EXPERT_OK')),
  () => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'native-history-write', type: 'function',
    function: { name: 'write', arguments: JSON.stringify({ file_path: 'native-history.txt', content: 'NATIVE_HISTORY_GENERATED_CODE' }) } }] }, finish_reason: 'tool_calls' }] }],
  () => framesForText('NATIVE_HISTORY_ORIGINAL_ANSWER'),
  () => framesForText('NATIVE_HISTORY_EDITED_ANSWER'),
  () => framesForText('NATIVE_HISTORY_EDITED_ANSWER'),
] })
const transportLog = path.join(scratch, 'synthetic-sakuraapi-requests.jsonl')
const activityHold = path.join(scratch, 'hold-activity'), activityStarted = path.join(scratch, 'activity-started')
const fixturePlugin = path.join(scratch, 'synthetic-sakuraapi.cjs')
const historyBackgroundControl = path.join(scratch, 'history-background-control.json')
const historyBackgroundStatus = path.join(scratch, 'history-background-status.json')
// This opt-in fixture exists only in the isolated temporary project. It uses
// the existing plugin system, not a product-side upstream override/test flag.
async function prepareWorkspace(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'sakura.yml'), JSON.stringify({ profile: 'desktop-smoke-offline', profiles: {},
    pluginsDir: 'no-plugins', bundles: [fixturePlugin], mcpServers: {},
    plugins: { 'core-compaction': { config: { auto: 0, autoTokens: 0 } }, 'core-hooks': { disabled: true }, 'mcp-manager': { disabled: true } },
    models: { ignored: { baseURL: 'https://ignored.example/v1', apiKey: 'SYNTHETIC_IGNORED_PROJECT_KEY', model: 'ignored-model' } },
    web: { host: '0.0.0.0', publicOrigin: 'https://invalid.example' } }))
}
let launcher: ChildProcess | undefined
let browser: BrowserClient | undefined

interface RuntimeInfo { launcherPid: number; enginePid: number; browserPid: number; windowOwnerPid?: number;
  windowHandle: number; browserWindowHandle: number; frameless: boolean; url: string; browserProfile: string }
interface FramePixels { foregroundRoot: number; dwmBorderColor: number | null; dwmNcRendering: number | null;
  checkedPixels: number; brightPixels: number }
interface FocusCycle { active: FramePixels; inactive: FramePixels; reactivated: FramePixels }
interface WindowInfo { parent: number; style: number; browserStyle: number; visible: boolean; minimized: boolean; maximized: boolean;
  x: number; y: number; width: number; height: number; clientWidth: number; clientHeight: number; browserWidth: number; browserHeight: number;
  browserX: number; browserY: number; leftHit: number; rightHit: number; topLeftHit: number; bottomRightHit: number; interactive: boolean;
  dwmBorderColor: number | null; dwmNcRendering: number | null; focusCycles: FocusCycle[]; keyboardFocus: number; keyboardFocusInBrowser: boolean;
  injectedBrowserBounds: { width: number; height: number } | null }
const skippedChecks: string[] = []
const verifiedFeatures: string[] = []

async function nativeWindow(info: RuntimeInfo, action = 'inspect', screenshot = '', point?: { x: number; y: number }, size?: { width: number; height: number }): Promise<WindowInfo> {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'scripts', 'desktop', 'window-smoke.ps1'), '-WindowHandle', String(info.windowHandle),
    '-BrowserWindowHandle', String(info.browserWindowHandle), '-Action', action, ...(screenshot ? ['-Screenshot', screenshot] : []),
    ...(point ? ['-PointerX', String(point.x), '-PointerY', String(point.y)] : []),
    ...(size ? ['-Width', String(size.width), '-Height', String(size.height)] : []),
  ], { windowsHide: true, timeout: 15000 })
  return result.stdout.trim() ? JSON.parse(result.stdout) as WindowInfo : {} as WindowInfo
}

/** Real HWND bounds are the oracle. Emulation can make a clipped 1440px page
 * look correct in a CDP screenshot while the native surface is only 1090px. */
async function actualViewport(client: BrowserClient, info: RuntimeInfo): Promise<{ native: WindowInfo; viewport: { width: number; height: number; scale: number } }> {
  const deadline = Date.now() + 8000
  let native: WindowInfo
  let viewport: { width: number; height: number; scale: number }
  do {
    native = await nativeWindow(info)
    viewport = await client.evaluate('({width:innerWidth,height:innerHeight,scale:devicePixelRatio})')
    if (Math.abs(viewport.width * viewport.scale - native.browserWidth) <= 2 &&
      Math.abs(viewport.height * viewport.scale - native.browserHeight) <= 2) return { native, viewport }
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error('Native browser surface and page viewport differ: ' + JSON.stringify({ native, viewport }))
}

async function layoutBounds(client: BrowserClient, selector: string): Promise<{ main: number[]; content: number[]; viewport: number[] }> {
  const bounds = await client.evaluate<{ main: number[]; content: number[]; viewport: number[]; overflow: boolean; scrolls: number[] }>(`(() => {
    const content = document.querySelector(${JSON.stringify(selector)});
    const main = document.getElementById('mainWorkspace').getBoundingClientRect(), r = content.getBoundingClientRect();
    return {main:[main.x,main.y,main.width,main.height],content:[r.x,r.y,r.width],viewport:[innerWidth,innerHeight],
      overflow:document.documentElement.scrollWidth > innerWidth || content.scrollWidth > content.clientWidth,
      scrolls:[document.documentElement.scrollLeft,document.body.scrollLeft,document.getElementById('mainWorkspace').scrollLeft]};
  })()`)
  assert.equal(bounds.overflow, false, selector + ' must not overflow horizontally')
  assert.ok(bounds.content[0]! >= bounds.main[0]! - 1 && bounds.content[0]! + bounds.content[2]! <= bounds.viewport[0]! + 1,
    selector + ' must be inside the actual visible viewport: ' + JSON.stringify(bounds))
  assert.deepEqual(bounds.scrolls, [0, 0, 0], 'no hidden outer horizontal scroll after fast operations')
  return {main:bounds.main,content:bounds.content,viewport:bounds.viewport}
}

async function accountLayoutBounds(client: BrowserClient): Promise<void> {
  await layoutBounds(client, '.settings-inner')
  const overflow = await client.evaluate<string[]>(`(() => {
    const view=document.getElementById('settingsView'), panel=document.getElementById('settings-accountPanel');
    const nodes=[view,panel,...panel.querySelectorAll('.settings-card, button, a, #sakuraBalance')].filter(e=>e.checkVisibility());
    return nodes.filter(e=>{const r=e.getBoundingClientRect();return r.left<document.getElementById('mainWorkspace').getBoundingClientRect().left-1 || r.right>innerWidth+1 || e.scrollWidth>e.clientWidth+1;}).map(e=>e.id || e.className);
  })()`)
  assert.deepEqual(overflow, [], 'authorized account cards, values and actions must be visible inside the real desktop surface')
}

async function dragPoint(client: BrowserClient, native: WindowInfo): Promise<{ x: number; y: number }> {
  const point = await client.evaluate<{ x: number; y: number; scale: number }>(`(() => {
    const r = document.querySelector('.topbar').getBoundingClientRect();
    for (let x = r.left + 20; x < r.right - 140; x += 20) {
      const y = r.top + r.height / 2;
      const element = document.elementFromPoint(x, y);
      if (element?.closest('.topbar') && !element.closest('button, input, select, textarea, a, [role="button"]')) {
        return {x, y, scale: devicePixelRatio};
      }
    }
    throw new Error('no draggable topbar space');
  })()`)
  return { x: Math.round(native.browserX + point.x * point.scale), y: Math.round(native.browserY + point.y * point.scale) }
}

async function runtimeProcesses(info: RuntimeInfo): Promise<number[]> {
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$rows=@(Get-CimInstance Win32_Process); $ids=@(${info.launcherPid},${info.enginePid},${info.browserPid},${info.windowOwnerPid ?? info.browserPid}); ` +
    'do { $added=@($rows | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object { $_.ProcessId }); $ids+= $added } while ($added.Count); ConvertTo-Json -Compress -InputObject @($ids | Select-Object -Unique)',
  ], { windowsHide: true, timeout: 15000 })
  return JSON.parse(result.stdout) as number[]
}

async function readRuntime(): Promise<RuntimeInfo> {
  const deadline = Date.now() + 60000
  for (;;) {
    assert.equal(launcher?.exitCode, null, 'launcher exited before GUI readiness')
    const info = await fs.readFile(path.join(dataDir, 'runtime.json'), 'utf8').catch(() => '')
    if (info) {
      const result = JSON.parse(info) as RuntimeInfo
      if (result.launcherPid === launcher?.pid) return result
    }
    assert.ok(Date.now() < deadline, 'GUI did not start: ' + await fs.readFile(path.join(dataDir, 'desktop.log'), 'utf8').catch(() => ''))
    await delay(100)
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + 15000
  while (running(pid)) {
    assert.ok(Date.now() < deadline, `process ${pid} survived desktop shutdown`)
    await delay(100)
  }
}

/** Hold only the isolated smoke settings file; the real Windows profile stays intact. */
async function withLockedSettings<T>(action: () => Promise<T>): Promise<T> {
  const lock = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; $held=New-Object IO.FileStream($env:SAKURA_SMOKE_SETTINGS_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); ' +
    'try { [Console]::WriteLine("SETTINGS_LOCKED"); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $held.Dispose() }',
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SAKURA_SMOKE_SETTINGS_FILE: path.join(dataDir, 'settings.json') } })
  let output = '', errors = '', launchError: Error | undefined
  lock.stdout?.on('data', chunk => { output += String(chunk) })
  lock.stderr?.on('data', chunk => { errors += String(chunk) })
  lock.once('error', error => { launchError = error })
  try {
    const deadline = Date.now() + 8000
    while (!output.includes('SETTINGS_LOCKED')) {
      if (launchError) throw launchError
      assert.equal(lock.exitCode, null, 'settings lock exited before readiness: ' + errors)
      assert.ok(Date.now() < deadline, 'isolated settings lock was not ready: ' + errors)
      await delay(40)
    }
    return await action()
  } finally {
    lock.stdin?.end('\n')
    if (lock.pid && running(lock.pid)) {
      try { await waitGone(lock.pid) }
      catch (error) { lock.kill(); throw error }
    }
  }
}

function launch(extra: string[] = []): ChildProcess {
  const child = spawn(exe, ['--data-dir', dataDir, ...extra], {
    cwd: scratch, stdio: 'ignore',
    env: { ...process.env, SAKURA_DESKTOP_DEBUG: '1', SAKURA_UPDATES_AUTO_CHECK: '0', SAKURA_CHROME: resolveChromePath() ?? '',
      // Keep the actual Windows profile: overriding USERPROFILE makes Chromium
      // reject CDP as a default-profile launch even with --user-data-dir.
      // Projects, browser profiles, DPAPI data and all model replies are isolated.
      SAKURA_BASE_URL: 'https://ignored.example/v1', SAKURA_API_KEY: 'SYNTHETIC_IGNORED_ENV_KEY', SAKURA_MODEL: 'ignored-env-model',
      SAKURA_WEB_TOKEN: 'invalid inherited token', SAKURA_WEB_VIEWER_TOKEN: 'invalid inherited viewer token' },
  })
  child.once('error', error => { console.error(error) })
  return child
}

async function attach(info: RuntimeInfo): Promise<BrowserClient> {
  let port = ''
  const deadline = Date.now() + 15000
  while (!port) {
    port = (await fs.readFile(path.join(info.browserProfile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0] ?? ''
    if (!port && Date.now() > deadline) {
      const diagnostics = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${info.browserPid} OR ProcessId = ${info.windowOwnerPid ?? info.browserPid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
      ], { windowsHide: true, timeout: 10000 })
      throw new Error('desktop debug port not ready: ' + diagnostics.stdout)
    }
    if (!port) await delay(100)
  }
  const pages = await readCdpJson<Array<{ url: string; webSocketDebuggerUrl: string }>>(port, '/json/list')
  const page = pages.find(entry => entry.url.startsWith(info.url))
  assert.ok(page, 'must open the workspace in the app window')
  const client = new BrowserClient()
  await client.connect(page.webSocketDebuggerUrl)
  await client.waitFor("document.readyState === 'complete' && document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
  await client.resetViewport()
  await client.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
  await client.waitFor("document.getElementById('accountUsername')?.textContent === " + JSON.stringify(clientUser.username))
  await client.waitFor("!document.getElementById('sakuraRefresh').disabled")
  return client
}

try {
  await fs.writeFile(fixturePlugin, `const fs = require('node:fs');
const original = globalThis.fetch;
const key = ${JSON.stringify(authorizedKey)}, base = ${JSON.stringify(SAKURA_MODEL_BASE_URL)}, site = ${JSON.stringify(SAKURA_API_ORIGIN)};
const access = ${JSON.stringify(rotatedAccessToken)}, refresh = ${JSON.stringify(clientRefreshToken)}, rotatedRefresh = ${JSON.stringify(rotatedRefreshToken)};
const log = ${JSON.stringify(transportLog)}, mock = ${JSON.stringify(mock.url)};
let retryAttempts = 0;
module.exports = { name: 'synthetic-sakuraapi-transport', inject: ['jobs'], apply(ctx, _config, jobs) {
  // A file-controlled fixture in the isolated project starts a real job in
  // the packaged registry without a model request or a product test endpoint.
  let previewJob, previewStatus = '';
  const previewTimer = setInterval(() => {
    if (!previewJob && fs.existsSync(${JSON.stringify(historyBackgroundControl)})) {
      const control = JSON.parse(fs.readFileSync(${JSON.stringify(historyBackgroundControl)}, 'utf8'));
      previewJob = jobs.start(control.command, 'pwsh', control.cwd);
    }
    if (!previewJob) return;
    const status = JSON.stringify({ id: previewJob.id, pid: previewJob.proc?.pid, status: previewJob.status, output: jobs.output(previewJob.id) });
    if (status !== previewStatus) { previewStatus = status; fs.writeFileSync(${JSON.stringify(historyBackgroundStatus)}, status); }
  }, 25);
  ctx.effect(() => () => clearInterval(previewTimer));
  if (globalThis.__syntheticSakuraApiTransport) return;
  globalThis.__syntheticSakuraApiTransport = true;
  globalThis.fetch = async (url, init) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (target === base + '/models' || target === base + '/usage' || target === base + '/chat/completions' || target === site + '/api/v1/models/available') {
      const authorized = new Headers(init?.headers).get('authorization');
      if (authorized !== (target.startsWith(base) ? 'Bearer ' + key : null) || init?.redirect !== 'error' || init?.credentials !== 'omit') throw new Error('unsafe synthetic SakuraAPI request');
      fs.appendFileSync(log, JSON.stringify({ url: target, method: init.method, redirect: init.redirect, credentials: init.credentials }) + '\\n');
      if (target === base + '/models') return new Response(JSON.stringify({ data: ${JSON.stringify(modelIds.map(id => ({ id })))} }));
      if (target === base + '/usage') return new Response(${JSON.stringify(JSON.stringify(usage))});
      if (target === site + '/api/v1/models/available') return new Response(${JSON.stringify(JSON.stringify({ code: 0, data: metadata }))});
      if (String(init.body).includes('NATIVE_RETRY_TASK') && retryAttempts++ < 3) return new Response('{"error":{"code":"server_error","message":"synthetic temporary failure"}}', {status: 503});
      return original(mock + '/chat/completions', init);
    }
    const parsed = new URL(target);
    if (parsed.origin === 'https://registry.npmjs.org' && parsed.pathname === '/-/v1/search') {
      const headers = new Headers(init?.headers);
      if (init?.method !== 'GET' || init?.credentials !== 'omit' || init?.redirect !== 'error' || headers.has('authorization') || headers.has('cookie') || init?.body ||
          !parsed.searchParams.get('text')?.startsWith('keywords:sakuracode-plugin')) throw new Error('unsafe public plugin metadata request');
      fs.appendFileSync(log, JSON.stringify({url:target,method:init.method,redirect:init.redirect,credentials:init.credentials,publicPluginMetadata:true}) + '\\n');
      return new Response(JSON.stringify({total:1,objects:[{package:{name:'sakuracode-plugin-native-fixture',version:'1.0.0',description:'SYNTHETIC_PUBLIC_PLUGIN_METADATA',keywords:['sakuracode-plugin'],links:{npm:'javascript:alert(1)'}}}]}));
    }
    if (parsed.origin === site && parsed.pathname.startsWith('/api/v1/')) {
      const route = parsed.pathname.slice('/api/v1'.length), headers = new Headers(init?.headers);
      if (init?.redirect !== 'error' || init?.credentials !== 'omit' || headers.get('user-agent') !== 'SakuraCode Desktop') throw new Error('unsafe synthetic client identity');
      fs.appendFileSync(log, JSON.stringify({url:target,method:init.method,redirect:init.redirect,credentials:init.credentials}) + '\\n');
      const reply = data => new Response(JSON.stringify({code:0,data}));
      if (route === '/auth/client/token') {
        const body = JSON.parse(String(init.body));
        if (body.grant_type !== 'refresh_token' || body.client_id !== 'sakuracode' || body.refresh_token !== refresh || headers.has('authorization')) throw new Error('unsafe synthetic client rotation');
        return reply(${JSON.stringify(clientTokens(true))});
      }
      if (route === '/auth/client/revoke') {
        const body = JSON.parse(String(init.body));
        if (body.client_id !== 'sakuracode' || body.refresh_token !== rotatedRefresh || headers.has('authorization')) throw new Error('unsafe synthetic client revocation');
        return reply({revoked:true});
      }
      if (headers.get('authorization') !== 'Bearer ' + access) throw new Error('account queries must use only the rotated client token');
      if (route === '/user/profile') return reply({...${JSON.stringify(clientUser)},balance:5.09});
      if (route === '/usage/dashboard/snapshot-v2') return reply({vip:${JSON.stringify(clientVip)}});
      if (route === '/usage/dashboard/stats') return reply(${JSON.stringify(clientStatistics)});
      if (route === '/subscriptions/active') return reply(${JSON.stringify(clientSubscriptions)});
      if (route === '/subscriptions/progress') return reply([]);
      if (route === '/groups/available') return reply([
        {id:7,name:'Synthetic client group',platform:'openai',status:'active',subscription_type:'standard',rate_multiplier:1},
        {id:8,name:'Synthetic backup group',platform:'openai',status:'active',subscription_type:'standard',rate_multiplier:0.7200000000000001},
        {id:9,name:'Synthetic third group',platform:'gemini',status:'active',subscription_type:'standard',rate_multiplier:0.045000000000000005},
        {id:10,name:'Synthetic subscription group',platform:'composite',status:'active',subscription_type:'subscription',rate_multiplier:0.9}
      ]);
      if (route === '/groups/rates') return reply({7:0.95});
      if (route === '/keys' && init.method === 'GET') return reply({items:[${JSON.stringify(clientKey)}],total:1,page:1,page_size:20,pages:1});
      if (route === '/keys/101') return reply(${JSON.stringify(clientKey)});
      if (route === '/auth/client/activity' && init.method === 'POST') {
        if (fs.existsSync(${JSON.stringify(activityHold)})) {
          fs.writeFileSync(${JSON.stringify(activityStarted)}, 'started');
          const deadline = Date.now() + 10000;
          while (fs.existsSync(${JSON.stringify(activityHold)})) {
            if (init.signal?.aborted || Date.now() > deadline) throw new Error('isolated activity hold timed out');
            await new Promise(resolve => setTimeout(resolve, 20));
          }
        }
        return reply({active:true,idle_timeout_seconds:432000});
      }
      throw new Error('unexpected account operation: account connection must not create a Key');
    }
    if (target === 'https://updates.example.test/sakuracode/latest.json') {
      const headers = new Headers(init?.headers);
      if (init?.credentials !== 'omit' || init?.redirect !== 'error' || headers.has('authorization') || headers.has('cookie') || init?.body) throw new Error('unsafe desktop update metadata request');
      fs.appendFileSync(log, JSON.stringify({url:target,method:'GET',redirect:init.redirect,credentials:init.credentials,publicUpdateMetadata:true}) + '\\n');
      return new Response(JSON.stringify({schemaVersion:1,project:'SakuraCode',platform:'windows-x64',version:'99.0.0',
        releaseUrl:'https://updates.example.test/sakuracode/99.0.0/', downloadUrl:'https://updates.example.test/sakuracode/99.0.0/SakuraCode%20Desktop.exe',
        sha256:'a'.repeat(64),size:98765432,notes:'<img src=x> SYNTHETIC_UPDATE_NOTES; manual download only'}));
    }
    if (['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return original(url, init);
    throw new Error('unexpected external request blocked by offline desktop smoke');
  };
} };
`)
  await prepareWorkspace(cwd)
  await fs.mkdir(dataDir, { recursive: true })
  const legacy = { Workspace: cwd, RecentWorkspaces: [cwd], BaseUrl: 'https://ignored.example/v1',
    Model: 'ignored-legacy-model', ProtectedApiKey: 'SYNTHETIC_INVALID_LEGACY_DPAPI', RememberKey: true }
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify(legacy))
  const storage = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'scripts', 'desktop', 'account-storage-smoke.ps1'), '-Exe', exe, '-SeedDirectory', dataDir, '-SeedClientAccount'], { windowsHide: true, timeout: 30000 })
  console.log(storage.stdout.trim())
  await fs.mkdir(previews, { recursive: true })
  assert.equal(await fs.stat(verificationFile).then(() => true, () => false), false, 'completed desktop acceptance evidence must not be overwritten; choose a fresh output directory')
  const binary = await fs.readFile(exe)
  const peOffset = binary.readUInt32LE(0x3c)
  assert.equal(binary.readUInt16LE(peOffset + 24 + 68), 2, 'launcher must use the GUI subsystem')
  // The launcher no longer shows a native setup window: it launches the
  // workspace directly and the settings view applies changes over HTTP.
  // 'cwd' is the variable (the absolute temp workspace), not a literal string:
  // a relative --workspace is rejected by the launcher's argument parser.
  launcher = launch(['--workspace', cwd])
  let first = await readRuntime()
  console.log('Desktop host and local engine ready')
  assert.ok(first.url.startsWith('http://127.0.0.1:') && first.url.endsWith('/'))
  // The app performs one initial account sync. Wait for it before issuing
  // settings writes; a real 409 must not be parsed as a settings projection.
  browser = await attach(first)
  const applied = await (await request(first.url + 'api/desktop/settings')).json() as { workspace: string; recentWorkspaces: string[]; rememberKey: boolean }
  assert.equal(applied.workspace, cwd)
  assert.deepEqual(applied.recentWorkspaces, [cwd])
  assert.equal(applied.rememberKey, false, 'legacy model credentials must not be imported')
  for (const patch of [{ baseURL: mock.url }, { apiKey: 'SYNTHETIC_MANUAL_KEY' }, { model: 'gpt-test' }, { rememberKey: true }]) {
    assert.equal((await post(first.url + 'api/desktop/settings', patch)).status, 400, 'manual desktop upstream edits must be rejected')
  }
  assert.equal((await post(first.url + 'api/models/upstream', { baseURL: mock.url })).status, 400)
  // Per-workspace prefs (session dir / agents) and the global default for new
  // workspaces ride the same persist frame; the C# launcher must store them.
  const sessionDir = path.join(scratch, 'sessions-store')
  const defaultParent = path.join(scratch, 'new-workspaces')
  const prefResponse = await post(first.url + 'api/desktop/settings', {
    sessionDir,
    newWorkspaceDir: defaultParent,
    agents: [],
  })
  assert.equal(prefResponse.status, 200, 'desktop workspace preferences: ' + await prefResponse.clone().text())
  const prefApplied = await prefResponse.json() as { sessionDir: string; newWorkspaceDir: string; agents: string[] }
  assert.equal(prefApplied.sessionDir, sessionDir)
  assert.equal(prefApplied.newWorkspaceDir, defaultParent)
  assert.deepEqual(prefApplied.agents, [])
  const state = await (await request(first.url + 'api/state')).json() as { cwd: string; approvalMode: string; sakuraApiOnly: boolean }
  assert.equal(state.cwd, cwd)
  assert.equal(state.approvalMode, 'default')
  assert.equal(state.sakuraApiOnly, true)
  // Workspace saves must preserve, but never import, legacy model settings.
  // Wait for the prefs frame to reach the compiled launcher.
  let settingsText = ''
  const persistDeadline = Date.now() + 10000
  while (Date.now() < persistDeadline) {
    settingsText = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => '')
    if (settingsText && JSON.parse(settingsText).WorkspacePrefs?.[cwd]?.sessionDir === sessionDir) break
    await delay(100)
  }
  const saved = JSON.parse(settingsText)
  assert.equal(saved.WorkspacePrefs?.[cwd]?.sessionDir, sessionDir, 'launcher did not persist desktop workspace settings')
  assert.equal(saved.RememberKey, legacy.RememberKey)
  assert.equal(saved.ProtectedApiKey, legacy.ProtectedApiKey)
  assert.equal(saved.BaseUrl, legacy.BaseUrl)
  assert.equal(saved.Model, legacy.Model)
  assert.ok(!settingsText.includes(authorizedKey))
  // The prefs survived the C# merge: session dir for this workspace, and the
  // global new-workspace default.
  assert.equal(saved.NewWorkspaceDir, defaultParent)
  const prefsForWs = (saved.WorkspacePrefs ?? {})[cwd]
  assert.ok(prefsForWs, 'launcher did not persist per-workspace prefs')
  assert.equal(prefsForWs.sessionDir, sessionDir)

  verifiedFeatures.push('compiled authorized-Key DPAPI save/load/delete/failure acknowledgements and legacy-setting preservation')
  // Edge/Chrome pass the window to a child process; runtime.json's windowOwnerPid
  // names the process that actually owns the app window after that handoff.
  const ownerPid = first.windowOwnerPid ?? first.browserPid
  const processInfo = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${first.enginePid} OR ProcessId = ${first.browserPid} OR ProcessId = ${ownerPid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
  ], { windowsHide: true, timeout: 10000 })
  assert.ok(!processInfo.stdout.includes(authorizedKey), 'credentials must not enter child argv')
  assert.ok(!processInfo.stdout.includes(clientAccessToken) && !processInfo.stdout.includes(clientRefreshToken), 'client tokens must not enter child argv')
  assert.ok(processInfo.stdout.includes('--app='), 'not an ordinary browser tab')
  const connected = await (await request(first.url + 'api/state')).json() as { providers: Array<{ id: string }>; modelStatus: { baseURL: string; model: string; configured: boolean } }
  assert.deepEqual(connected.providers.map(row => row.id), ['sakuraapi'])
  assert.equal(connected.modelStatus.baseURL, SAKURA_MODEL_BASE_URL)
  assert.equal(connected.modelStatus.model, 'gpt-test')
  assert.equal(connected.modelStatus.configured, true)
  const account = await (await request(first.url + 'api/account/sakura')).json() as { remember: boolean; balance: number; models: string[]; authorization: string; user: {username:string;email:string}; vip: {level:number} }
  assert.equal(account.remember, true)
  assert.equal(account.balance, 5.09)
  assert.deepEqual(account.models, modelIds)
  assert.equal(account.authorization, 'client-account-pkce'); assert.equal(account.user.username, clientUser.username)
  assert.equal(account.user.email, clientUser.email); assert.equal(account.vip.level, 7); assert.ok(noClientSecrets(account))
  assert.ok((await browser.evaluate<string>("document.getElementById('sakuraAccountStripText').textContent")).includes('5.09'))
  assert.ok(!(await browser.evaluate<string>("document.body.innerHTML + JSON.stringify(localStorage)")).includes(authorizedKey))
  verifiedFeatures.push('fixed SakuraAPI upstream/catalog, synthetic saved authorization, composer quotas and no Key in UI/argv')
  await browser.waitFor("document.querySelector('#sakuraVipBadge img')?.naturalWidth > 0")
  assert.equal(await browser.evaluate("document.querySelector('#sakuraVipBadge img').getAttribute('src')"), '/assets/vip/vip-7.png')
  assert.equal(await browser.evaluate("document.querySelectorAll('.vip-badge').length"), 1)
  assert.equal(await browser.evaluate("document.querySelectorAll('#sakuraAccountBtn .vip-badge, .settings-account-summary .vip-badge').length"), 0)
  const embeddedVipAssets: Record<string, string> = {}
  for (let level = 1; level <= 10; level++) {
    const name = 'vip-' + level + '.png', response = await request(first.url + 'assets/vip/' + name)
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png')
    const image = Buffer.from(await response.arrayBuffer()), sourceImage = await fs.readFile(path.join(root,'src','web','assets','vip',name))
    assert.deepEqual(image, sourceImage, 'SEA must embed the exact VIP PNG independently of cwd/Desktop')
    embeddedVipAssets[name] = createHash('sha256').update(image).digest('hex')
  }
  const initialClientCalls = (await fs.readFile(transportLog,'utf8')).trim().split('\n').map(line => JSON.parse(line) as {url:string;method:string})
  assert.equal(initialClientCalls.filter(row => row.url.endsWith('/auth/client/token')).length, 1, 'expired access rotates once on startup')
  assert.ok(!initialClientCalls.some(row => row.url.endsWith('/api/v1/keys') && row.method === 'POST'), 'connection never creates Key')
  assert.ok(noClientSecrets(await browser.evaluate("document.body.innerHTML + JSON.stringify(localStorage)")))
  verifiedFeatures.push('compiled client-account token rotation with native acknowledgement, real profile/VIP and ten SHA-256-matched embedded badges')
  const ui = await (await request(first.url)).text()
  const sourceHtml = await fs.readFile(path.join(root, 'src', 'web', 'index.html'), 'utf8')
  const sourceHash = createHash('sha256').update(sourceHtml).digest('hex')
  assert.equal(createHash('sha256').update(ui).digest('hex'), sourceHash, 'served UI must match the latest sources')
  console.log(`Embedded UI SHA-256 matches source: ${sourceHash}`)
  await browser.waitFor("document.body.classList.contains('desktop-shell') && !document.getElementById('desktopWindowControls').hidden")
  assert.equal(first.frameless, true)
  let native = await nativeWindow(first)
  const interactive = native.interactive && !physicalInputDisabled
  if (interactive) native = await nativeWindow(first, 'focus', path.join(previews, 'desktop-native-frameless.png'))
  else {
    const reason = physicalInputDisabled ? 'explicit --no-physical-input mode; foreground-dependent checks are not validated' : 'Windows desktop is locked or inaccessible'
    skippedChecks.push('Interactive native screenshot/focus-cycle pixels, physical drag/double-click, and physical Alt+F4: ' + reason)
    console.log('SKIP physical input and screen capture: ' + reason + '; native/API/CDP checks still run')
  }
  skippedChecks.push('Physical keyboard and OS Chinese IME candidate confirmation are not exercised by CDP typing/composition events.')
  await fs.writeFile(path.join(previews, 'desktop-keyboard-focus.json'), JSON.stringify({ nativeFocus: native.keyboardFocus,
    nativeFocusInBrowser: native.keyboardFocusInBrowser, physicalKeyboardVerified: false, interactiveForegroundChecksEnabled: interactive }, null, 2))
  // DWMWA_BORDER_COLOR is set-only on some Windows builds. A failed getter
  // cannot prove a failed setter; real edge pixels below are the regression oracle.
  if (native.dwmBorderColor !== null) assert.equal(native.dwmBorderColor, 0xfffffffe)
  if (interactive) {
    assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'night', 'edge pixel test uses the dark shell')
    let focus: WindowInfo | undefined
    const focusAttempts: WindowInfo[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const checked = await nativeWindow(first, 'focus-cycle', path.join(previews, 'desktop-native-focus'))
      focusAttempts.push(checked)
      // Foreground-lock races invalidate the snapshot, not the border test.
      // Require three genuine cycles in the final attempt; never count a stolen focus.
      if (checked.focusCycles?.length === 3 && checked.focusCycles.every(cycle =>
        cycle.active.foregroundRoot === first.windowHandle && cycle.reactivated.foregroundRoot === first.windowHandle &&
        cycle.inactive.foregroundRoot !== first.windowHandle)) { focus = checked; break }
      await delay(300)
    }
    await fs.writeFile(path.join(previews, 'desktop-focus-attempts.json'), JSON.stringify(focusAttempts, null, 2))
    assert.ok(focus, 'three complete physical focus cycles required; foreground window was repeatedly stolen')
    await fs.writeFile(path.join(previews, 'desktop-focus-diagnostics.json'), JSON.stringify(focus.focusCycles, null, 2))
    assert.equal(focus.focusCycles.length, 3)
    for (const [index, cycle] of focus.focusCycles.entries()) {
      assert.equal(cycle.active.foregroundRoot, first.windowHandle)
      assert.notEqual(cycle.inactive.foregroundRoot, first.windowHandle, 'real foreground focus must leave the app')
      assert.notEqual(cycle.inactive.foregroundRoot, 0)
      assert.equal(cycle.reactivated.foregroundRoot, first.windowHandle)
      for (const [phase, pixels] of Object.entries(cycle)) {
        assert.ok(pixels.checkedPixels > 1000, 'sample all four native resize edges')
        assert.equal(pixels.brightPixels, 0, `focus cycle ${index + 1} ${phase} must not draw a white native border`)
        if (pixels.dwmBorderColor !== null) assert.equal(pixels.dwmBorderColor, 0xfffffffe)
      }
    }
    console.log('Three real focus/deactivation/reactivation cycles and white-edge pixel scan PASS')
  }
  assert.equal(native.parent, first.windowHandle, 'browser must belong to the native host')
  assert.equal(native.style & 0x00c00000, 0, 'native WS_CAPTION must be removed')
  assert.equal(native.style & 0x00040000, 0x00040000, 'native resize/snap style must remain enabled')
  assert.equal(native.browserStyle & 0x40000000, 0x40000000, 'browser is an embedded child, not a second top-level window')
  assert.equal(native.height, native.clientHeight, 'native frame must not reserve a caption')
  assert.equal(native.width, native.clientWidth)
  assert.deepEqual([native.leftHit, native.rightHit, native.topLeftHit, native.bottomRightHit], [10, 11, 13, 17], 'all resize edges/corners remain active')
  let viewport = await browser.evaluate<{ width: number; height: number; scale: number }>('({width: innerWidth, height: innerHeight, scale: devicePixelRatio})')
  const viewportDeadline = Date.now() + 8000
  while ((Math.abs(viewport.height * viewport.scale - native.browserHeight) > 2 ||
    Math.abs(viewport.width * viewport.scale - native.browserWidth) > 2) && Date.now() < viewportDeadline) {
    await delay(100)
    native = await nativeWindow(first)
    viewport = await browser.evaluate('({width: innerWidth, height: innerHeight, scale: devicePixelRatio})')
  }
  await fs.writeFile(path.join(previews, 'desktop-viewport-diagnostics.json'), JSON.stringify({ native, viewport }, null, 2))
  assert.ok(Math.abs(viewport.height * viewport.scale - native.browserHeight) <= 2, 'Chromium must not reserve its own titlebar')
  assert.ok(Math.abs(viewport.width * viewport.scale - native.browserWidth) <= 2)
  await browser.evaluate("document.getElementById('desktopMaximize').click()")
  await delay(250)
  assert.equal((await nativeWindow(first)).maximized, true)
  await browser.evaluate("document.getElementById('desktopMaximize').click()")
  await delay(250)
  assert.equal((await nativeWindow(first)).maximized, false)
  await browser.evaluate("document.getElementById('desktopMinimize').click()")
  await delay(250)
  const trayHidden = await nativeWindow(first)
  assert.equal(trayHidden.visible, false, 'minimize must hide the native host and its taskbar button')
  assert.equal(trayHidden.parent, first.windowHandle, 'tray hide must not rebuild the host HWND')
  const trayReturn = launch()
  await waitGone(trayReturn.pid!)
  assert.equal((await nativeWindow(first)).visible, true, 'single-instance/tray return must show the same host')
  await browser.fill('#input', 'TRAY_DRAFT_KEEP')
  await browser.evaluate("document.getElementById('desktopMaximize').click()")
  await delay(250)
  assert.equal((await nativeWindow(first)).maximized, true)
  assert.equal((await nativeWindow(first, 'minimize-command')).visible, false, 'SC_MINIMIZE also hides to tray')
  const maximizedReturn = launch()
  await waitGone(maximizedReturn.pid!)
  const restoredTray = await nativeWindow(first)
  assert.equal(restoredTray.visible, true)
  assert.equal(restoredTray.maximized, true, 'tray restore preserves maximized state')
  assert.equal(restoredTray.parent, first.windowHandle)
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'TRAY_DRAFT_KEEP')
  assert.ok(running(first.enginePid), 'tray does not shut down the engine')
  await browser.fill('#input', '')
  await browser.evaluate("document.getElementById('desktopMaximize').click()")
  await delay(250)
  verifiedFeatures.push('tray hide via page and SC_MINIMIZE removes taskbar window without HWND recreation; single-instance return preserves maximized state, draft and engine')
  native = await nativeWindow(first, 'resize')
  assert.equal(native.width, 1100)
  assert.equal(native.height, 820)
  const resizedViewport = await actualViewport(browser, first)
  viewport = resizedViewport.viewport
  await browser.evaluate(`(() => {
    const original = window.fetch.bind(window); window.windowSmokeActions = [];
    window.fetch = async function (url, options) {
      const response = await original(url, options);
      if (url === '/api/desktop/window') window.windowSmokeActions.push({body: JSON.parse(options.body), status: response.status});
      return response;
    };
  })()`)
  if (interactive) {
    const pointer = await dragPoint(browser, native)
    const moved = await nativeWindow(first, 'drag', '', pointer)
    await fs.writeFile(path.join(previews, 'desktop-drag-diagnostics.json'), JSON.stringify({ before: native, after: moved, pointer,
      actions: await browser.evaluate('window.windowSmokeActions') }, null, 2))
    assert.ok(Math.abs(moved.x - native.x) >= 40 && Math.abs(moved.y - native.y) >= 20,
      `actual topbar mouse drag must move the host (${native.x},${native.y} -> ${moved.x},${moved.y})`)
    native = await nativeWindow(first, 'double-click', '', await dragPoint(browser, moved))
    assert.equal(native.maximized, true, 'double-clicking the topbar must maximize')
    native = await nativeWindow(first, 'double-click', '', await dragPoint(browser, native))
    assert.equal(native.maximized, false, 'double-clicking the topbar must restore')
    console.log('Actual mouse topbar drag and double-click maximize/restore PASS')
  }
  const currentViewport = await actualViewport(browser, first)
  await fs.writeFile(path.join(previews, 'desktop-native-window.json'), JSON.stringify({ ...currentViewport, interactive }, null, 2))
  console.log('Native borderless parent/child, no Chromium caption, maximize/restore/tray hide and edge resize PASS')
  assert.equal(await browser.evaluate("document.getElementById('settingsViewBtn').parentElement.className"), 'account-row')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-generalTab').click()")
  assert.equal(await browser.evaluate("document.getElementById('themeBtn').closest('#settings-generalPanel') !== null"), true)
  await browser.evaluate("document.getElementById('themeBtn').click()")
  assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'day')
  await browser.evaluate("document.getElementById('themeBtn').click(); document.getElementById('marketBtn').click()")
  assert.equal(await browser.evaluate("!document.getElementById('settings-marketPanel').hidden && !!document.querySelector('#pluginList .extension-card')"), true)
  await browser.click('#pluginsMarketTab')
  assert.equal(await browser.evaluate("document.querySelector('.plugin-market-card')"), null, 'opening market must not silently search/install')
  const marketAcceptance = { explicitSearchOnly: false, fixtureTransportIntercepted: false, metadataInert: false }
  const beforeMarketCalls = (await fs.readFile(transportLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { publicPluginMetadata?: boolean })
  assert.ok(!beforeMarketCalls.some(row => row.publicPluginMetadata), 'opening marketplace must not issue a network request')
  marketAcceptance.explicitSearchOnly = true
  await browser.typeText('#marketSearch', 'native-fixture'); await browser.key('Enter')
  await browser.waitFor("document.querySelector('.plugin-market-card') && !document.getElementById('pluginMarketSearch').disabled")
  assert.equal(await browser.evaluate("document.querySelector('.plugin-market-card').textContent.includes('SYNTHETIC_PUBLIC_PLUGIN_METADATA')"), true, 'the packaged marketplace must use the mounted offline fixture, not live npm')
  const marketCalls = (await fs.readFile(transportLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { url: string; publicPluginMetadata?: boolean })
  const publicRequests = marketCalls.filter(row => row.publicPluginMetadata)
  assert.equal(publicRequests.length, 1, 'one explicit synthetic search must be intercepted after plugins mount')
  assert.equal(new URL(publicRequests[0]!.url).origin, 'https://registry.npmjs.org')
  marketAcceptance.fixtureTransportIntercepted = true
  assert.equal(await browser.evaluate("document.querySelector('.plugin-market-card a').href"), 'https://www.npmjs.com/package/sakuracode-plugin-native-fixture')
  assert.equal(await browser.evaluate("document.querySelector('.plugin-market-card').textContent.includes('未安装')"), true)
  assert.equal(await browser.evaluate("document.querySelectorAll('.plugin-market-card button, .plugin-market-card script, .plugin-market-card img').length"), 0)
  marketAcceptance.metadataInert = true
  verifiedFeatures.push('separate Skill/MCP/local plugins and explicit offline-intercepted npm metadata search, inert canonical links and no automatic installation')
  await browser.screenshot(path.join(previews, 'desktop-plugin-market.png'))
  await browser.click('#pluginsLocalTab')
  await browser.screenshot(path.join(previews, 'desktop-local-plugins.png'))
  assert.equal(await browser.evaluate("document.querySelector('#settings-marketPanel #mcpList, #settings-marketPanel #skillsBody, #settingsView #settingsClose')"), null)
  await browser.evaluate("document.getElementById('settings-mcpTab').click()")
  assert.equal(await browser.evaluate("!document.getElementById('settings-mcpPanel').hidden && document.getElementById('settingsView').contains(document.getElementById('mcpList'))"), true)
  await browser.evaluate("document.getElementById('settings-skillsTab').click()")
  assert.equal(await browser.evaluate("!document.getElementById('settings-skillsPanel').hidden && document.getElementById('settings-skillsPanel').contains(document.getElementById('skillImportCard'))"), true)
  await browser.evaluate("document.getElementById('settingsBack').click()")
  await browser.click('#approvalSelBottomTrigger')
  await browser.key('Escape')
  assert.equal(await browser.evaluate('document.activeElement.id'), 'approvalSelBottomTrigger')
  assert.ok(!(await (await request(first.url + 'api/account/sakura')).text()).includes('accessToken'), 'account endpoint must be sanitized')
  const quotaSettingsFile = path.join(dataDir, 'settings.json')
  const accountCiphertext = await fs.readFile(path.join(dataDir, 'sakuraapi.json'), 'utf8')
  const quotaAcceptance = { modes: ['always', 'hover', 'settings'], failedSaveRollback: false, hoverWithoutReflow: false,
    restoredAcrossRestartAndPort: false, preservedDuringWorkspaceSwitch: false, credentialsAndContextPreserved: false }
  assert.equal(await browser.evaluate("!document.querySelector('.statusbar') && ['connectionLabel','versionLabel','toolCount','usageChip','ctxChip'].every(id => document.getElementById('workspaceStatusCard').contains(document.getElementById(id)))"), true)
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-aboutTab').click()")
  assert.equal(await browser.evaluate("document.getElementById('workspaceStatusCard').checkVisibility()"), true)
  await browser.screenshot(path.join(previews, 'desktop-settings-status.png'))
  const updatesAcceptance = { saved: false, failedSaveRollback: false, sourceAndManifestSafe: false, restoredAfterRestart: false,
    preservedDuringWorkspaceSwitch: false, nativeSettingsMergeVerified: true, onlyMetadataRequested: false }
  const updateSource = 'https://updates.example.test/sakuracode/latest.json'
  await browser.fill('#settingsUpdateSource', updateSource)
  const failedUpdatesBaseline = await fs.readFile(quotaSettingsFile, 'utf8')
  await withLockedSettings(async () => {
    await browser!.click('#settingsUpdateSourceSave')
    await browser!.waitFor("document.getElementById('settingsUpdateSourceMessage').classList.contains('error') && !document.getElementById('settingsUpdateSourceSave').disabled")
    assert.equal(await fs.readFile(quotaSettingsFile, 'utf8'), failedUpdatesBaseline)
    assert.deepEqual(await (await request(first.url + 'api/updates/settings')).json(), { feedUrl: '', autoCheck: true })
  })
  updatesAcceptance.failedSaveRollback = true
  await browser.click('#settingsUpdateSourceSave')
  await browser.waitFor("document.getElementById('settingsUpdateSourceMessage').textContent.includes('已保存') && !document.getElementById('settingsUpdateSourceSave').disabled")
  assert.deepEqual(JSON.parse(await fs.readFile(quotaSettingsFile, 'utf8')).Updates, { feedUrl: updateSource, autoCheck: true })
  updatesAcceptance.saved = true
  await browser.click('#settingsCheckUpdates')
  await browser.waitFor("document.getElementById('settingsUpdateStatus').textContent.includes('最新 v99.0.0') && !document.getElementById('settingsCheckUpdates').disabled")
  assert.equal(await browser.evaluate("document.getElementById('settingsUpdateDownload').href"), 'https://updates.example.test/sakuracode/99.0.0/SakuraCode%20Desktop.exe')
  assert.equal(await browser.evaluate("document.querySelectorAll('#settingsUpdateNotes img').length"), 0)
  assert.equal(await browser.evaluate("document.getElementById('settingsUpdateIntegrity').textContent.includes('a'.repeat(64))"), true)
  const updateCalls = (await fs.readFile(transportLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { url: string; publicUpdateMetadata?: boolean }).filter(row => row.publicUpdateMetadata)
  assert.deepEqual(updateCalls.map(row => row.url), [updateSource])
  assert.equal(await fs.readFile(path.join(dataDir, 'sakuraapi.json'), 'utf8'), accountCiphertext)
  updatesAcceptance.sourceAndManifestSafe = true; updatesAcceptance.onlyMetadataRequested = true
  await browser.screenshot(path.join(previews, 'desktop-self-hosted-update.png'))
  verifiedFeatures.push('compiled custom update-source acknowledgement and locked-save rollback; same-origin manifest/download/hash/plain-text notes; only metadata is fetched')
  await browser.evaluate("document.getElementById('settings-generalTab').click()")
  await browser.click('#quotaDisplaySelectTrigger')
  await browser.key('Home'); await browser.key('ArrowDown'); await browser.key('Enter')
  await browser.waitFor("document.getElementById('sakuraAccountStrip').dataset.display === 'hover' && !document.getElementById('quotaDisplaySelect').disabled")
  assert.equal(JSON.parse(await fs.readFile(quotaSettingsFile, 'utf8')).Appearance.quotaDisplay, 'hover')
  assert.equal(await browser.evaluate("localStorage.getItem('sakura-appearance')"), null, 'desktop appearance must not be stored by HTTP origin')
  await browser.click('#settingsBack')
  await browser.hover('#sessionHeading')
  await browser.evaluate('document.activeElement.blur()')
  const composerBounds = await browser.evaluate<number[]>("(() => { const r=document.querySelector('.composer').getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })()")
  await browser.hover('#input')
  await browser.waitFor("document.getElementById('sakuraAccountStrip').matches(':popover-open')")
  await delay(200)
  assert.deepEqual(await browser.evaluate("(() => { const r=document.querySelector('.composer').getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; })()"), composerBounds)
  assert.equal(await browser.evaluate("document.getElementById('sakuraAccountStrip').getBoundingClientRect().bottom < document.querySelector('.composer').getBoundingClientRect().top"), true)
  quotaAcceptance.hoverWithoutReflow = true
  await browser.screenshot(path.join(previews, 'desktop-quota-hover.png'))
  await browser.key('Escape')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-generalTab').click()")
  const beforeFailedQuota = await fs.readFile(quotaSettingsFile, 'utf8')
  const quotaBrowser = browser
  await withLockedSettings(async () => {
    await quotaBrowser.click('#quotaDisplaySelectTrigger')
    await quotaBrowser.key('End'); await quotaBrowser.key('Enter')
    await quotaBrowser.waitFor("document.getElementById('quotaDisplayMessage').classList.contains('error') && !document.getElementById('quotaDisplaySelect').disabled")
    assert.equal(await quotaBrowser.evaluate("document.getElementById('quotaDisplaySelect').value"), 'hover')
    assert.deepEqual(await (await request(first.url + 'api/desktop/appearance')).json(), { quotaDisplay: 'hover' })
    assert.equal(await fs.readFile(quotaSettingsFile, 'utf8'), beforeFailedQuota)
  })
  quotaAcceptance.failedSaveRollback = true
  await browser.click('#quotaDisplaySelectTrigger'); await browser.key('End'); await browser.key('Enter')
  await browser.waitFor("document.getElementById('sakuraAccountStrip').dataset.display === 'settings' && !document.getElementById('quotaDisplaySelect').disabled")
  await browser.click('#settingsBack')
  assert.equal(await browser.evaluate("document.getElementById('sakuraAccountStrip').checkVisibility() || document.getElementById('sakuraQuotaBtn').checkVisibility()"), false)
  await browser.evaluate("document.getElementById('sakuraAccountBtn').click()")
  await browser.waitFor("!document.getElementById('sakuraRefresh').disabled && !document.getElementById('sakuraPurchase').disabled")
  assert.equal(await browser.evaluate("document.getElementById('sakuraBalance').textContent"), '5.09')
  assert.equal(await browser.evaluate("!document.getElementById('sakuraRefresh').disabled && !document.getElementById('sakuraPurchase').disabled"), true)
  assert.equal(await browser.evaluate("document.querySelectorAll('#settings-accountPanel .vip-badge').length"), 1)
  assert.equal(await browser.evaluate("document.querySelector('#settings-accountPanel #sakuraKeyCard')"), null)
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#sakuraSubscriptions .subscription-window')].map(row=>({period:row.dataset.period,value:row.querySelector('progress')?.value ?? null}))"), [
    { period: 'daily', value: 80 }, { period: 'weekly', value: 87.5 }, { period: 'monthly', value: null },
  ])
  assert.ok((await browser.evaluate<string>("document.querySelector('#sakuraSubscriptions [data-period=monthly]').textContent")).includes('不限额'))
  await browser.evaluate("document.getElementById('sakuraSubscriptionCard').scrollIntoView({block:'center'})")
  await browser.screenshot(path.join(previews, 'desktop-account-quota-periods.png'))
  assert.equal(await browser.evaluate("document.getElementById('sakuraOpenModels')"), null)
  await browser.click('#settings-modelsTab')
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#sakuraKeyGroups input')].map(node=>node.value)"), ['7', '8', '9'])
  assert.deepEqual(await browser.evaluate("[...document.querySelectorAll('#sakuraKeyGroups .account-key-group-rate')].map(node=>node.textContent)"), ['×0.95', '×0.72', '×0.05'])
  assert.equal(await browser.evaluate("getComputedStyle(document.getElementById('sakuraKeyGroups')).gridTemplateColumns.split(' ').length"), 3)
  await browser.screenshot(path.join(previews, 'desktop-new-key-three-columns.png'))
  assert.equal(await browser.evaluate("document.getElementById('sakuraKeyCard').checkVisibility() && document.getElementById('settings-modelsPanel').contains(document.getElementById('sakuraKeyGroups'))"), true)
  assert.equal(await browser.evaluate("document.getElementById('settings-modelsPanel').contains(document.getElementById('sakuraSelectedKey')) && document.getElementById('settings-modelsPanel').contains(document.getElementById('sakuraKeysPage'))"), true)
  await browser.click('#sakuraKeySelectTrigger')
  await browser.waitFor("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement)")
  await fs.writeFile(activityHold, 'hold', { flag: 'wx' })
  try {
    await browser.evaluate("window.dispatchEvent(new Event('focus'))")
    const deadline = Date.now() + 5000
    while (!(await fs.stat(activityStarted).catch(() => null))) {
      assert.ok(Date.now() < deadline, 'compiled foreground activity must reach the isolated fixture')
      await delay(20)
    }
    await browser.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    assert.equal(await browser.evaluate("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement) === true && !document.getElementById('sakuraKeySelectTrigger').disabled"), true, 'foreground activity must preserve local Key menu focus')
    assert.equal(await browser.evaluate("document.getElementById('sakuraKeyUse').disabled && document.getElementById('sakuraKeyPrepare').disabled"), true, 'account network actions remain locked during foreground activity')
    await browser.key('Home'); await browser.key('End')
    await browser.waitFor("document.activeElement?.matches('#sakuraKeySelectTriggerMenu .select-option') && document.activeElement.firstElementChild?.textContent === 'Synthetic chosen Key'")
  } finally { await fs.rm(activityHold, { force: true }) }
  await browser.waitFor("!document.getElementById('sakuraKeyUse').disabled")
  assert.equal(await browser.evaluate("document.querySelector('#sakuraKeySelectTriggerMenu')?.contains(document.activeElement) === true"), true, 'completed activity must not steal Key focus')
  await browser.key('Escape')
  assert.equal(await browser.evaluate('document.activeElement.id'), 'sakuraKeySelectTrigger')
  verifiedFeatures.push('compiled delayed foreground account activity preserves local Key menu/keyboard focus while network mutations stay locked')
  await browser.screenshot(path.join(previews, 'desktop-model-key-settings.png'))
  verifiedFeatures.push('membership-only VIP badge, model-page Key/group management and independent daily/weekly/monthly quota bars with unlimited fallback')
  await browser.evaluate("document.getElementById('settings-generalTab').click()")
  await browser.click('#quotaDisplaySelectTrigger'); await browser.key('Home'); await browser.key('ArrowDown'); await browser.key('Enter')
  await browser.waitFor("document.getElementById('sakuraAccountStrip').dataset.display === 'hover' && !document.getElementById('quotaDisplaySelect').disabled")
  await browser.click('#settingsBack')
  assert.equal(await fs.readFile(path.join(dataDir, 'sakuraapi.json'), 'utf8'), accountCiphertext)
  verifiedFeatures.push('status relocated into About; all three quota modes, hover without reflow, compiled-save failure rollback and settings-only account access')
  console.log('Embedded quota appearance selector, hover overlay and compiled failure rollback PASS')
  verifiedFeatures.push('separate Skill/MCP settings, combined local plugins/market, no settings close icon and keyboard selects')
  console.log('Embedded categorized settings, account footer and accessible select controls PASS')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  assert.equal(await browser.evaluate("document.getElementById('workspaceMemoryEditor').hidden"), true)
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled")
  await browser.click('#memoryDocumentEditor > summary')
  await browser.fill('#workspaceMemoryContent', 'DESKTOP_WORKSPACE_MEMORY_ONLY')
  assert.equal(await browser.evaluate("document.getElementById('workspaceMemoryEnabled').checked"), true)
  await browser.evaluate("document.getElementById('workspaceMemorySave').click()")
  await browser.waitFor("document.getElementById('workspaceMemoryBadge').textContent === '已启用' && !document.getElementById('workspaceMemorySave').disabled")
  assert.equal((await fs.readFile(path.join(cwd, '.sakura', 'workspace-memory.md'), 'utf8')).includes('DESKTOP_WORKSPACE_MEMORY_ONLY'), true)
  await browser.screenshot(path.join(previews, 'desktop-memory-settings.png'))
  await browser.reload()
  await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'DESKTOP_WORKSPACE_MEMORY_ONLY' && document.getElementById('workspaceMemoryEnabled').checked")
  const retryAcceptance = { saved: false, failureRollback: false, restoredAfterRestart: false, manualLimitConfirmed: false }
  await browser.evaluate("document.getElementById('settings-generalTab').click()")
  await browser.fill('#retryWindow', '30'); await browser.fill('#retryCount', '2'); await browser.fill('#retryDelay', '0')
  await browser.click('#retrySave')
  await browser.waitFor("document.getElementById('retryMessage').textContent.includes('已保存') && !document.getElementById('retrySave').disabled")
  assert.deepEqual(await (await request(first.url + 'api/retry/settings')).json(), { enabled: true, windowMs: 30000, maxRetries: 2, delayMs: 0 })
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).Retry.maxRetries, 2)
  retryAcceptance.saved = true
  await withLockedSettings(async () => {
    await browser!.fill('#retryCount', '5'); await browser!.click('#retrySave')
    await browser!.waitFor("document.getElementById('retryMessage').classList.contains('error') && !document.getElementById('retrySave').disabled")
    assert.equal(await browser!.evaluate("document.getElementById('retryCount').value"), '5')
    assert.equal((await (await request(first.url + 'api/retry/settings')).json() as { maxRetries: number }).maxRetries, 2)
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).Retry.maxRetries, 2)
  })
  retryAcceptance.failureRollback = true
  await browser.fill('#retryCount', '2'); await browser.click('#retrySave')
  await browser.waitFor("document.getElementById('retryMessage').textContent.includes('已保存') && !document.getElementById('retrySave').disabled")
  verifiedFeatures.push('compiled retry timing/count persistence, locked-file failure rollback and retained form draft')
  await browser.evaluate("document.getElementById('settings-workspaceTab').click()")
  const nativeLayoutChecks: Array<{ native: WindowInfo; viewport: { width: number; height: number; scale: number } }> = []
  const viewSelectors = [['chatViewBtn', '#chatCol'], ['dashboardBtn', '.dashboard-inner'], ['settingsViewBtn', '.settings-inner']]
  await browser.resetViewport()
  await browser.evaluate("document.getElementById('sakuraAccountBtn').click()")
  await browser.waitFor("!document.getElementById('sakuraRefresh').disabled")
  const hostBeforeDrift = await actualViewport(browser, first)
  const nativeViewport = (await (await request(first.url + 'api/state')).json() as { desktopViewport: DesktopViewport }).desktopViewport
  assert.deepEqual([nativeViewport.width,nativeViewport.height], [hostBeforeDrift.native.browserWidth,hostBeforeDrift.native.browserHeight], 'private native viewport must report the actual child-visible client, not the monitor')
  await accountLayoutBounds(browser)
  const drift = await nativeWindow(first, 'browser-size-drift', '', undefined, {width:2560,height:974})
  assert.deepEqual(drift.injectedBrowserBounds,
    {width:2560,height:974}, 'must inject a real browser HWND drift, not an emulated viewport')
  await browser.waitFor(`Math.abs(innerWidth * devicePixelRatio - ${hostBeforeDrift.native.browserWidth}) <= 2 && Math.abs(innerHeight * devicePixelRatio - ${hostBeforeDrift.native.browserHeight}) <= 2`)
  const repaired = await actualViewport(browser, first)
  assert.equal(repaired.native.width, hostBeforeDrift.native.width, 'recovery must not resize the host')
  assert.equal(repaired.native.height, hostBeforeDrift.native.height, 'recovery must not resize the host')
  assert.ok(Math.abs(await browser.evaluate<number>('document.body.getBoundingClientRect().width') * repaired.viewport.scale - repaired.native.browserWidth) <= 2)
  await accountLayoutBounds(browser)
  await browser.screenshot(path.join(previews, 'desktop-authorized-account-drift-recovered.png'))
  verifiedFeatures.push('authorized account remains inside the real native viewport; unexpected monitor-sized browser bounds recover without host resize or CDP emulation')
  verifiedFeatures.push('private native client/DPI viewport evidence bounds the existing page and requests a non-remounting reflow')
  // Own only an isolated about:blank browser, never the user's browser tabs.
  const externalBrowser = new BrowserClient()
  const externalChecks: Array<{ native: WindowInfo; viewport: { width: number; height: number; scale: number } }> = []
  const draftBeforeExternal = await browser.evaluate<string>("document.getElementById('input').value")
  await browser.evaluate("document.getElementById('chatViewBtn').click()")
  await browser.fill('#input', 'EXTERNAL_BROWSER_RETURN_DRAFT')
  await browser.evaluate("window.externalReturnInput=document.getElementById('input');window.externalReturnDocument=document;window.externalReturnInput.focus();window.externalReturnInput.setSelectionRange(3,7)")
  try {
    await externalBrowser.start({ headless: false })
    await externalBrowser.evaluate("document.body.textContent='ISOLATED_EXTERNAL_BROWSER_FIXTURE'")
    const ownWindow = await externalBrowser.send('Browser.getWindowForTarget')
    for (const state of ['maximized', 'normal']) {
      await externalBrowser.send('Browser.setWindowBounds', { windowId: ownWindow.windowId, bounds: { windowState: state } })
      externalChecks.push(await actualViewport(browser, first))
      await layoutBounds(browser, '.composer')
    }
    await nativeWindow(first, 'browser-size-drift', '', undefined, { width: 2560, height: 974 })
    await browser.send('Page.bringToFront')
    externalChecks.push(await actualViewport(browser, first))
    assert.ok(await browser.evaluate("document===window.externalReturnDocument && document.getElementById('input')===window.externalReturnInput && window.externalReturnInput.value==='EXTERNAL_BROWSER_RETURN_DRAFT' && window.externalReturnInput.selectionStart===3 && window.externalReturnInput.selectionEnd===7"), 'external return must not navigate, remount or lose the draft/caret')
    for (const check of externalChecks) {
      assert.equal(check.native.parent, first.windowHandle)
      assert.equal(check.native.width, hostBeforeDrift.native.width)
      assert.equal(check.native.height, hostBeforeDrift.native.height)
    }
    assert.deepEqual(externalBrowser.errors, [])
    await browser.screenshot(path.join(previews, 'desktop-external-browser-return.png'))
    await fs.writeFile(path.join(previews, 'desktop-external-browser-verification.json'), JSON.stringify({ isolatedBlankBrowser: true,
      noUserProfileAccess: true, noPhysicalInput: true, sameDocumentAndComposer: true, draftAndCaretPreserved: true, externalChecks }, null, 2), { flag: 'wx' })
    verifiedFeatures.push('isolated headed external browser open/maximize/restore/return preserves native host, renderer, draft/caret and real visible viewport')
  } finally { await externalBrowser.close(); await browser.fill('#input', draftBeforeExternal) }
  try {
    for (const width of [1450, 1930, 1010, 480]) {
      await nativeWindow(first, 'resize', '', undefined, { width, height: 910 })
      nativeLayoutChecks.push(await actualViewport(browser, first))
      const bounds: Array<{ main: number[]; content: number[]; viewport: number[] }> = []
      let bannerOffset = 0
      for (const [button, selector] of viewSelectors) {
        await browser.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`)
        if (button === 'chatViewBtn') bannerOffset = await browser.evaluate<number>(`(() => {
          document.getElementById('chatScroll').scrollTop = 0;
          const banner = document.getElementById('updateNotification');
          if (banner.hidden) return 0;
          const style = getComputedStyle(banner);
          return banner.getBoundingClientRect().height + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
        })()`)
        if (button === 'settingsViewBtn') {
          await browser.evaluate("document.getElementById('settings-accountTab').click()")
          await accountLayoutBounds(browser)
        }
        bounds.push(await layoutBounds(browser, selector!))
      }
      assert.deepEqual(bounds[1]!.main, bounds[0]!.main, 'real native chat/dashboard main layout must match')
      assert.deepEqual([bounds[1]!.content[0], bounds[1]!.content[2]], [bounds[0]!.content[0], bounds[0]!.content[2]], 'real native chat/dashboard content horizontal alignment must match')
      assert.ok(Math.abs(bounds[0]!.content[1]! - bounds[1]!.content[1]! - bannerOffset) <= 1, 'chat vertical offset must be exactly the visible update banner, not resize drift')
      assert.ok(bounds[2]!.main[2]! >= bounds[0]!.main[2]!, 'settings should use the full native workspace')
    }
  } finally {
    await browser.resetViewport()
    await nativeWindow(first, 'restore')
    await nativeWindow(first, 'resize')
    await actualViewport(browser, first)
    await browser.evaluate("document.getElementById('chatViewBtn').click()")
  }
  // Phone-sized layouts belong to a separate headless browser, never to the
  // embedded native app. Always clear emulation even when an assertion fails.
  const responsiveBrowser = new BrowserClient()
  try {
    await responsiveBrowser.start()
    await responsiveBrowser.navigate(first.url)
    await responsiveBrowser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
    await responsiveBrowser.resize(390, 760)
    for (const [button, selector] of viewSelectors) {
      await responsiveBrowser.evaluate(`document.getElementById(${JSON.stringify(button)}).click()`)
      await layoutBounds(responsiveBrowser, selector!)
    }
    await responsiveBrowser.screenshot(path.join(previews, 'desktop-responsive-390.png'))
  } finally {
    await responsiveBrowser.resetViewport().catch(() => {})
    await responsiveBrowser.close()
  }
  await browser.evaluate(`(async () => {
    for (let index = 0; index < 12; index++) {
      document.getElementById('settingsViewBtn').click(); document.getElementById('settings-modelsTab').click();
      document.getElementById('dashboardBtn').click(); document.getElementById('chatViewBtn').click();
      if (index % 3 === 0) await fetch('/api/desktop/window', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'maximize'})});
    }
  })()`)
  await nativeWindow(first, 'restore')
  await nativeWindow(first, 'resize-burst')
  const rapidViewport = await actualViewport(browser, first)
  await layoutBounds(browser, '#chatCol')
  await layoutBounds(browser, '.composer')
  await browser.screenshot(path.join(previews, 'desktop-rapid-layout.png'))
  const afterScreenshot = await actualViewport(browser, first)
  assert.deepEqual(afterScreenshot.viewport, rapidViewport.viewport, 'screenshot must not change the native viewport')
  const layoutAcceptance = { realNativeResize: true, responsiveEmulationIsolated: true, rapidViewsAndMaximize: true,
    nativeResizeBurst: true, nativeViewportRestored: true, screenshotKeptViewport: true, nativeLayoutChecks, rapidViewport }
  await fs.writeFile(path.join(previews, 'desktop-layout-verification.json'), JSON.stringify(layoutAcceptance, null, 2))
  verifiedFeatures.push('real native resizes and rapid view/maximize/resize bursts keep viewport and composer inside the native surface; phone emulation is isolated and cleared')
  console.log('Real native resize, rapid view/maximize/resize bursts, isolated phone layout and viewport restoration PASS')
  // Exercise the packaged HTML at real HWND dimensions, not a virtual viewport.
  const panelLayoutBefore = await browser.evaluate<string | null>("localStorage.getItem('sakura-layout')")
  const panelViewport = await actualViewport(browser, first)
  await browser.fill('#input', '面板调宽保留中文草稿')
  const panelSnapshot = () => browser!.evaluate<{ side: number; right: number; main: number; overflow: boolean }>(`(() => {
    const w = id => document.getElementById(id).getBoundingClientRect().width;
    return {side:w('sidebar'),right:w('inspector'),main:w('mainWorkspace'),overflow:document.documentElement.scrollWidth>innerWidth};
  })()`)
  const resizePanel = async (name: string, delta: number) => {
    const point = await browser!.evaluate<{ x: number; y: number }>(`(() => {
      const h=document.getElementById('${name}Resizer'),r=h.getBoundingClientRect(),x=r.x+r.width/2,y=180;
      if(!h.checkVisibility() || !h.contains(document.elementFromPoint(x,y)))throw Error('packaged resizer is hidden or covered');return {x,y};
    })()`)
    await browser!.send('Input.dispatchMouseEvent', {type:'mouseMoved',...point})
    await browser!.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,...point})
    await browser!.waitFor("document.body.classList.contains('panel-resizing')")
    await browser!.send('Input.dispatchMouseEvent', {type:'mouseMoved',button:'left',buttons:1,x:point.x+delta,y:point.y})
    await browser!.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:point.x+delta,y:point.y})
    await browser!.waitFor("!document.body.classList.contains('panel-resizing')")
  }
  await resizePanel('sidebar', 60)
  assert.equal((await panelSnapshot()).side, 308)
  if (await browser.evaluate("document.getElementById('inspectorBtn').getAttribute('aria-expanded')") !== 'true') await browser.click('#inspectorBtn')
  await resizePanel('inspector', -48)
  const resizedPanels = await panelSnapshot()
  assert.equal(resizedPanels.right, 360); assert.equal(resizedPanels.overflow, false)
  assert.equal(await browser.evaluate("document.getElementById('input').value"), '面板调宽保留中文草稿')
  const afterPanelViewport = await actualViewport(browser, first)
  assert.deepEqual([afterPanelViewport.native.x,afterPanelViewport.native.y,afterPanelViewport.native.width,afterPanelViewport.native.height],
    [panelViewport.native.x,panelViewport.native.y,panelViewport.native.width,panelViewport.native.height], 'panel drag must not move or resize the native host')
  if (await browser.evaluate('innerWidth <= 1200')) await browser.key('Escape')
  await browser.reload(); await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  assert.equal((await panelSnapshot()).side, 308)
  const storedPanels = await browser.evaluate<{ sidebarWidth: number; inspectorWidth: number }>("JSON.parse(localStorage.getItem('sakura-layout'))")
  assert.equal(storedPanels.sidebarWidth, 308); assert.equal(storedPanels.inspectorWidth, 360)
  await browser.screenshot(path.join(previews, 'desktop-resizable-panels.png'))
  const panelResizeAcceptance = {realNativeViewport:true,resizedPanels,storedPanels,draftPreserved:true,nativeHostUnchanged:true,reloadRestored:true}
  await fs.writeFile(path.join(previews, 'desktop-panel-resize-verification.json'), JSON.stringify(panelResizeAcceptance, null, 2))
  await browser.evaluate(panelLayoutBefore === null ? "localStorage.removeItem('sakura-layout')" : `localStorage.setItem('sakura-layout', ${JSON.stringify(panelLayoutBefore)})`)
  await browser.reload(); await browser.waitFor("document.getElementById('connectionLabel').textContent === '本地服务已连接'")
  verifiedFeatures.push('packaged sidebar and workbench drag resize at real native bounds; widths survive reload, draft stays intact, native window does not move')
  console.log('Packaged sidebar/workbench resize, remembered widths, draft preservation and independent native window bounds PASS')
  await browser.screenshot(path.join(previews, 'desktop-welcome.png'))
  await browser.typeText('#input', '验证桌面打包和中文项目路径')
  assert.equal(await browser.evaluate("document.getElementById('input').value"), '验证桌面打包和中文项目路径', 'actual browser text input must work, not a DOM assignment')
  verifiedFeatures.push('actual browser text input and focus in the embedded native window')
  // Do not depend on the user's foreground window while a headed app is under test.
  await browser.evaluate("document.getElementById('sendBtn').click()")
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('DESKTOP_GUI_SMOKE_OK')")
  await browser.waitFor("document.querySelector('#chatCol > .turn-summary')?.textContent.includes('总耗时') && document.querySelector('.session-item.active .session-status')?.dataset.status === 'done'")
  assert.ok(await browser.evaluate("document.querySelector('#chatCol > .turn-summary').textContent.includes('tokens')"))
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0]?.model, 'gpt-test')
  assert.ok(JSON.stringify(mock.requests[0]?.messages?.[0]).includes('DESKTOP_WORKSPACE_MEMORY_ONLY'), 'saved memory reaches the selected model')
  await browser.screenshot(path.join(previews, 'desktop-chat.png'))
  await browser.waitFor("!document.getElementById('contextViewerBtn').disabled && document.getElementById('stopBtn').hidden")
  await browser.click('#contextViewerBtn')
  await browser.waitFor("document.getElementById('contextViewer').matches(':popover-open') && document.querySelectorAll('.context-category').length === 7")
  assert.equal(await browser.evaluate("(() => { const composer = document.querySelector('.composer'), entry = document.getElementById('contextViewerBtn'); return composer.contains(entry) && document.getElementById('contextViewer').getBoundingClientRect().bottom < composer.getBoundingClientRect().top; })()"), true)
  assert.ok((await browser.evaluate<string>("document.getElementById('contextViewerNote').textContent")).includes('不代表模型窗口上限'))
  await browser.screenshot(path.join(previews, 'desktop-context-viewer.png'))
  await browser.click('#contextSequenceTab')
  assert.equal(await browser.evaluate("document.getElementById('contextSequenceTab').getAttribute('aria-pressed')"), 'true')
  await browser.click('#contextSettings')
  await browser.fill('#contextWindowInput', '128000')
  await browser.fill('#contextPercentInput', '70')
  await browser.fill('#contextEventsInput', '0')
  await browser.click('#contextSettingsSave')
  await browser.waitFor("!document.getElementById('contextSettingsDialog')")
  const contextSettingsFile = path.join(dataDir, 'settings.json')
  const savedContextSettings = await fs.readFile(contextSettingsFile, 'utf8')
  const savedContextBudget = JSON.parse(savedContextSettings).WorkspacePrefs[cwd].contextBudget
  assert.equal(JSON.parse(savedContextSettings).Appearance.quotaDisplay, 'hover', 'context saves preserve appearance')
  assert.equal(await fs.readFile(path.join(dataDir, 'sakuraapi.json'), 'utf8'), accountCiphertext)
  quotaAcceptance.credentialsAndContextPreserved = true
  assert.deepEqual(savedContextBudget, { contextWindowTokens: 128000, thresholdPercent: 70, autoThreshold: 0 })
  await withLockedSettings(async () => {
    const failed = await post(first.url + 'api/context/settings', { contextWindowTokens: 128000, thresholdPercent: 60, autoThreshold: 0 })
    assert.equal(failed.status, 500, 'the compiled launcher must report a failed disk save')
    assert.ok((await failed.text()).includes('原设置未改变'))
    const unchanged = await (await request(first.url + 'api/state')).json() as { contextBudget: { thresholdPercent: number; autoTokensThreshold: number } }
    assert.equal(unchanged.contextBudget.thresholdPercent, 70, 'a failed save must not apply live thresholds')
    assert.equal(unchanged.contextBudget.autoTokensThreshold, 89600)
    assert.equal(await fs.readFile(contextSettingsFile, 'utf8'), savedContextSettings, 'a failed save must not modify saved settings')
  })
  verifiedFeatures.push('compiled context settings disk-save acknowledgements; failed saves keep persisted and live thresholds unchanged')
  console.log('Embedded context thresholds save to disk; locked-file failure is acknowledged and leaves live/disk settings unchanged PASS')
  await browser.click('#contextViewerBtn')
  await browser.click('#contextCompact')
  await browser.waitFor("document.getElementById('contextStatus').textContent.includes('压缩完成') && !document.getElementById('contextCompact').disabled")
  assert.equal(mock.requests.length, 2)
  assert.ok(JSON.stringify(mock.requests[1]?.messages?.[0]).includes('summarize the conversation'))
  const contextState = await (await request(first.url + 'api/state')).json() as { sessionId: string; contextBudget: { autoTokensThreshold: number } }
  assert.equal(contextState.contextBudget.autoTokensThreshold, 89600)
  const contextFile = path.join(sessionDir, contextState.sessionId, 'session.jsonl')
  const contextLog = await fs.readFile(contextFile, 'utf8')
  assert.ok(contextLog.includes('DESKTOP_CONTEXT_COMPACT_SUMMARY'))
  const contextMemoryFile = path.join(cwd, '.sakura', 'workspace-memory.md')
  const contextMemoryLog = await fs.readFile(contextMemoryFile, 'utf8')
  const contextSentinel = path.join(cwd, 'project-sentinel.txt')
  await fs.writeFile(contextSentinel, 'PROJECT_FILES_SURVIVE_DELETION')
  await browser.click('#contextClear')
  await browser.waitFor("document.getElementById('contextClearDialog')?.open")
  assert.equal(await browser.evaluate('document.activeElement.id'), 'contextClearCancel')
  await browser.click('#contextClearCancel')
  assert.equal(await fs.readFile(contextFile, 'utf8'), contextLog)
  await browser.click('#contextViewerBtn')
  await browser.click('#contextClear')
  await browser.click('#contextClearConfirm')
  await browser.waitFor("!document.getElementById('contextClearDialog') && document.getElementById('chatCol').textContent.includes('上下文已清空')")
  assert.ok((await fs.readFile(contextFile, 'utf8')).startsWith(contextLog))
  assert.ok((await fs.readFile(contextFile, 'utf8')).includes('context-clear'))
  assert.equal(mock.requests.length, 2, 'clearing context never makes a model request')
  assert.equal(await fs.readFile(contextMemoryFile, 'utf8'), contextMemoryLog)
  assert.equal(await fs.readFile(contextSentinel, 'utf8'), 'PROJECT_FILES_SURVIVE_DELETION')
  const clearedContextLog = await fs.readFile(contextFile, 'utf8')
  verifiedFeatures.push('composer context viewer, categories/sequence, local thresholds, real summary, confirmed history-preserving context reset')
  await browser.reload()
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('DESKTOP_GUI_SMOKE_OK')")
  const contextRestartPids = await runtimeProcesses(first)
  const previousQuotaUrl = first.url
  await browser.evaluate("document.getElementById('desktopClose').click()")
  await Promise.all(contextRestartPids.map(waitGone))
  await browser.close()
  browser = undefined
  launcher = launch()
  first = await readRuntime()
  browser = await attach(first)
  assert.notEqual(first.url, previousQuotaUrl, 'restart must validate appearance on another random port')
  assert.deepEqual(await (await request(first.url + 'api/desktop/appearance')).json(), { quotaDisplay: 'hover' })
  assert.equal(await browser.evaluate("document.getElementById('quotaDisplaySelect').value"), 'hover')
  quotaAcceptance.restoredAcrossRestartAndPort = true
  assert.deepEqual(await (await request(first.url + 'api/updates/settings')).json(), { feedUrl: updateSource, autoCheck: true })
  assert.equal(JSON.parse(await fs.readFile(quotaSettingsFile, 'utf8')).Updates.feedUrl, updateSource)
  updatesAcceptance.restoredAfterRestart = true
  const resumedContext = await post(first.url + 'api/sessions', { id: contextState.sessionId })
  assert.equal(resumedContext.status, 200)
  assert.equal((await resumedContext.json() as { sessionId: string }).sessionId, contextState.sessionId)
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('DESKTOP_GUI_SMOKE_OK') && document.getElementById('chatCol').textContent.includes('上下文已压缩为摘要') && document.getElementById('chatCol').textContent.includes('上下文已清空')")
  const restartedContext = await (await request(first.url + 'api/state')).json() as {
    contextBudget: { contextWindowTokens: number; thresholdPercent: number; autoThreshold: number; autoTokensThreshold: number }
    contextBreakdown: { categories: Array<{ category: string; tokens: number }> }
  }
  assert.deepEqual({ contextWindowTokens: restartedContext.contextBudget.contextWindowTokens,
    thresholdPercent: restartedContext.contextBudget.thresholdPercent, autoThreshold: restartedContext.contextBudget.autoThreshold }, savedContextBudget)
  assert.equal(restartedContext.contextBudget.autoTokensThreshold, 89600)
  const restartedCategories = restartedContext.contextBreakdown.categories.filter(row => row.tokens > 0).map(row => row.category)
  assert.deepEqual(restartedCategories, ['system', 'tools'], 'a reopened cleared session must not restore old conversation or summaries to model context')
  assert.equal(await fs.readFile(contextFile, 'utf8'), clearedContextLog, 'restart and session resume keep the complete log unchanged')
  assert.equal(await fs.readFile(contextMemoryFile, 'utf8'), contextMemoryLog)
  assert.equal(await fs.readFile(contextSentinel, 'utf8'), 'PROJECT_FILES_SURVIVE_DELETION')
  assert.equal(mock.requests.length, 2, 'restart and session resume never make a model request')
  const contextAcceptance = { settingsSaved: true, failedDiskSaveKeptLiveAndPersistedThresholds: true,
    restoredBudget: savedContextBudget, autoTokensThreshold: restartedContext.contextBudget.autoTokensThreshold,
    manualCompactionRequests: 1, clearRequiredConfirmation: true, clearCancelKeptHistory: true,
    clearPreservedHistoryMemoryAndFiles: true, clearDurableAfterRestart: true, categoriesAfterRestart: restartedCategories,
    noModelRequestsForClearOrRestart: true }
  verifiedFeatures.push('cleared context and thresholds survive a full desktop restart; complete conversation/summary history, memory and project files stay intact')
  console.log('Full desktop restart restores thresholds and cleared-context boundary while retaining complete history/memory/project files PASS')
  await browser.screenshot(path.join(previews, 'desktop-context-restarted.png'))
  await browser.evaluate("document.getElementById('dashboardBtn').click()")
  await browser.waitFor("!document.getElementById('dashboard').hidden")
  await browser.screenshot(path.join(previews, 'desktop-dashboard.png'))
  assert.deepEqual(browser.errors, [])
  // Delete only this scratch session through the embedded GUI; cancel first,
  // then confirm. The other workspace below still verifies session persistence.
  const deleting = await (await request(first.url + 'api/state')).json() as { sessionId: string }
  const sessionFile = path.join(sessionDir, deleting.sessionId, 'session.jsonl')
  await fs.writeFile(path.join(cwd, 'project-sentinel.txt'), 'PROJECT_FILES_SURVIVE_DELETION')
  await sessionAction(browser, 'delete', deleting.sessionId)
  await browser.waitFor("document.getElementById('deleteSessionDialog')?.open")
  assert.ok((await browser.evaluate<string>("document.getElementById('deleteSessionDialog').textContent")).includes('不可撤销'))
  await browser.evaluate("document.getElementById('deleteSessionCancel').click()")
  await browser.waitFor("!document.getElementById('deleteSessionDialog')")
  assert.ok((await fs.stat(sessionFile)).isFile(), 'cancel must preserve the session log')
  await sessionAction(browser, 'delete', deleting.sessionId)
  await browser.waitFor("document.getElementById('deleteSessionDialog')?.open && !document.getElementById('deleteSessionConfirm').disabled")
  await browser.screenshot(path.join(previews, 'desktop-delete-confirm.png'))
  await browser.evaluate("document.getElementById('deleteSessionConfirm').click()")
  await browser.waitFor("!document.getElementById('deleteSessionDialog') && !document.querySelector('.session-item') && !document.getElementById('welcome').hidden && !document.getElementById('input').disabled")
  assert.equal((await (await request(first.url + 'api/state')).json() as { sessionId: string | null }).sessionId, null)
  await assert.rejects(fs.stat(path.dirname(sessionFile)), { code: 'ENOENT' })
  assert.equal(await fs.readFile(path.join(cwd, 'project-sentinel.txt'), 'utf8'), 'PROJECT_FILES_SURVIVE_DELETION')
  assert.equal(mock.requests.length, 2, 'deletion must not send a model request')
  assert.ok((await fs.readFile(path.join(cwd, '.sakura', 'workspace-memory.md'), 'utf8')).includes('DESKTOP_WORKSPACE_MEMORY_ONLY'), 'session deletion must keep workspace memory')
  assert.deepEqual(browser.errors, [])
  console.log('Embedded deletion confirmation/cancel, complete session removal, blank conversation and project-file preservation PASS')
  const batchIds: string[] = []
  for (const title of ['批量记录一', '批量记录二']) {
    const created = await (await post(first.url + 'api/sessions', { new: true, title })).json() as { sessionId: string }
    batchIds.push(created.sessionId)
  }
  await browser.waitFor("document.querySelectorAll('#sessionList .session-item').length === 2")
  await browser.evaluate("document.getElementById('sessionBatchBtn').click(); document.getElementById('sessionSelectAll').click(); document.getElementById('sessionBatchDelete').click()")
  assert.equal(await browser.evaluate('document.activeElement.id'), 'deleteSessionsCancel')
  await browser.evaluate("document.getElementById('deleteSessionsCancel').click()")
  assert.equal((await (await request(first.url + 'api/state')).json() as { sessions: unknown[] }).sessions.length, 2)
  await browser.evaluate("document.getElementById('sessionBatchDelete').click(); document.getElementById('deleteSessionsConfirm').click()")
  await browser.waitFor("!document.getElementById('deleteSessionsDialog') && document.querySelectorAll('#sessionList .session-item').length === 0")
  for (const id of batchIds) assert.equal(await fs.stat(path.join(sessionDir, id)).then(() => true, () => false), false)
  assert.equal(await fs.readFile(path.join(cwd, 'project-sentinel.txt'), 'utf8'), 'PROJECT_FILES_SURVIVE_DELETION')
  verifiedFeatures.push('batch selection, select-all, cancellation and confirmed deletion of current/history sessions without project removal')
  console.log('Embedded batch-delete selection, safe cancel, current-session reset and storage removal PASS')
  // Workspace switch (desktop mode): the harness remounts on a new workspace
  // while the window, authorized model and approval mode survive.
  const other = path.join(scratch, 'other project')
  await prepareWorkspace(other)
  const beforeWorkspaceSave = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')
  await withLockedSettings(async () => {
    const rejected = await post(first.url + 'api/desktop/settings', { workspace: other,
      sessionDir: path.join(scratch, 'rejected-sessions'), newWorkspaceDir: other })
    assert.equal(rejected.status, 500, 'a locked workspace save must be acknowledged as failed, not switch only in memory')
    const unchanged = await (await request(first.url + 'api/state')).json() as { cwd: string; desktop: { sessionDir: string; newWorkspaceDir: string } }
    assert.equal(unchanged.cwd, cwd)
    assert.equal(unchanged.desktop.sessionDir, sessionDir)
    assert.equal(unchanged.desktop.newWorkspaceDir, defaultParent)
    assert.equal(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'), beforeWorkspaceSave)
  })
  const switchResponse = await post(first.url + 'api/desktop/settings', { workspace: other })
  assert.equal(switchResponse.status, 200, 'workspace switch must complete its native disk acknowledgement')
  const switched = await switchResponse.json() as { workspace: string; recentWorkspaces: string[]; sessionDir: string; newWorkspaceDir: string }
  assert.deepEqual(await (await request(first.url + 'api/desktop/appearance')).json(), { quotaDisplay: 'hover' })
  quotaAcceptance.preservedDuringWorkspaceSwitch = true
  assert.equal(switched.workspace, other)
  assert.deepEqual(switched.recentWorkspaces, [other, cwd])
  assert.equal(switched.sessionDir, '', 'failed save must not leak the rejected session directory')
  assert.equal(switched.newWorkspaceDir, defaultParent)
  const persistedSwitch = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'))
  assert.equal(persistedSwitch.Workspace, other, 'a 200 response means the selected workspace is on disk')
  assert.deepEqual(persistedSwitch.RecentWorkspaces, [other, cwd], 'native JSON arrays must preserve recent workspace order')
  assert.equal(persistedSwitch.WorkspacePrefs[cwd].sessionDir, sessionDir)
  assert.ok(!persistedSwitch.WorkspacePrefs[other].sessionDir, 'failed target prefs must not survive a later switch')
  await browser.waitFor("document.querySelectorAll('#workspaceList .workspace-item').length === 2")
  await browser.waitFor("document.querySelector('#workspaceList .workspace-item.active .workspace-name')?.textContent === 'other project'")
  await browser.waitFor("!document.querySelector('#chatCol .msg-user-row')")
  const collaboration = await (await request(first.url + 'api/collaboration')).json() as { workspaces: Array<{ active: boolean; live: boolean; path: string }> }
  assert.equal(collaboration.workspaces.length, 2)
  assert.deepEqual(collaboration.workspaces.map(row => row.live), [true, false])
  assert.equal(collaboration.workspaces.find(row => row.active)?.path, other)
  verifiedFeatures.push('real multi-workspace collaboration snapshot with explicit inactive history')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("!document.getElementById('settingsView').hidden")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("!document.getElementById('workspaceMemorySave').disabled && document.getElementById('workspaceMemoryContent').value === '' && document.getElementById('workspaceMemoryEnabled').checked")
  await browser.fill('#workspaceMemoryContent', 'OTHER_WORKSPACE_DURABLE_NOTE')
  await browser.evaluate("document.getElementById('workspaceMemorySave').click()")
  await browser.waitFor("document.getElementById('workspaceMemoryBadge').textContent === '已启用' && !document.getElementById('workspaceMemorySave').disabled")
  await browser.screenshot(path.join(previews, 'desktop-settings.png'))
  await browser.evaluate("document.getElementById('chatViewBtn').click()")
  await browser.typeText('#input', '验证切换后的工作区')
  await browser.evaluate("document.getElementById('sendBtn').click()")
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('OTHER_WORKSPACE_SMOKE_OK')")
  await browser.waitFor("document.getElementById('stopBtn').hidden && document.querySelector('.session-item.active .session-status')?.dataset.status === 'done'")
  const otherSession = await (await request(first.url + 'api/state')).json() as { cwd: string; sessionId: string; sessions: Array<{ id: string }> }
  assert.equal(otherSession.cwd, other)
  assert.ok(otherSession.sessions.some(session => session.id === otherSession.sessionId))
  const otherSessionFile = path.join(other, '.sakura', 'sessions', otherSession.sessionId, 'session.jsonl')
  const otherSessionLog = await fs.readFile(otherSessionFile, 'utf8')
  assert.ok(otherSessionLog.includes('OTHER_WORKSPACE_SMOKE_OK'))
  assert.equal(mock.requests.length, 3)
  assert.equal(mock.requests[2]?.model, 'gpt-test')
  assert.ok(!JSON.stringify(mock.requests[2]?.messages?.[0]).includes('DESKTOP_WORKSPACE_MEMORY_ONLY'), 'another workspace never inherits the previous notes')
  assert.ok(JSON.stringify(mock.requests[2]?.messages?.[0]).includes('OTHER_WORKSPACE_DURABLE_NOTE'))
  assert.deepEqual(browser.errors, [])
  await browser.evaluate("document.getElementById('desktopMinimize').click()")
  assert.equal((await nativeWindow(first)).visible, false)
  const secondLaunch = launch()
  await waitGone(secondLaunch.pid!)
  assert.ok(running(first.launcherPid), 'repeat launch must not replace the active process')
  assert.equal((await nativeWindow(first)).visible, true, 'tray/single-instance focus must restore the hidden host')
  const closingPids = await runtimeProcesses(first)
  await browser.evaluate("document.getElementById('desktopClose').click()")
  await Promise.all(closingPids.map(waitGone))
  await browser.close()
  browser = undefined
  await Promise.all([waitGone(first.launcherPid), waitGone(first.enginePid), waitGone(first.browserPid)])
  await assert.rejects(request(first.url + 'api/state'))
  assert.equal(await fs.stat(path.join(dataDir, 'runtime.json')).then(() => true, () => false), false)
  console.log('GUI subsystem, Unicode workspace, settings API + DPAPI persistence, embedded UI, model/SSE, reload, dashboard, workspace switch, single-instance and normal close PASS')

  // Saved settings auto-launch with the last workspace. Killing only the launcher
  // must also close the engine/browser via its Windows Job Object.
  launcher = launch()
  const resumed = await readRuntime()
  browser = await attach(resumed)
  assert.deepEqual(await (await request(resumed.url + 'api/updates/settings')).json(), { feedUrl: updateSource, autoCheck: true })
  updatesAcceptance.preservedDuringWorkspaceSwitch = true
  assert.equal((await (await request(resumed.url + 'api/retry/settings')).json() as { maxRetries: number }).maxRetries, 2)
  retryAcceptance.restoredAfterRestart = true
  const resumedWorkspace = await (await request(resumed.url + 'api/state')).json() as {
    cwd: string; desktop: { recentWorkspaces: string[] }; sessions: Array<{ id: string; status: string }>
  }
  assert.equal(resumedWorkspace.cwd, other, 'restart must load the last disk-acknowledged workspace')
  assert.deepEqual(resumedWorkspace.desktop.recentWorkspaces, [other, cwd])
  assert.ok(resumedWorkspace.sessions.some(session => session.id === otherSession.sessionId && session.status === 'done'), 'the exact completed session must survive restart')
  assert.equal(await fs.readFile(otherSessionFile, 'utf8'), otherSessionLog, 'restart only reads the original session log')
  await browser.waitFor(`document.querySelector('#sessionList [data-session-id=${JSON.stringify(otherSession.sessionId)}] .session-status')?.dataset.status === 'done'`)
  const workspaceAcceptance = { lockedSaveRejected: true, nativeAndLivePrefsUnchangedOnFailure: true,
    recentWorkspaceOrderPreserved: true, savedWorkspace: other, resumedWorkspace: resumedWorkspace.cwd,
    sessionId: otherSession.sessionId, sessionPath: otherSessionFile, sessionLogUnchanged: true, exactSessionRenderedAfterRestart: true }
  await fs.writeFile(path.join(previews, 'desktop-workspace-restart-verification.json'), JSON.stringify(workspaceAcceptance, null, 2), { flag: 'wx' })
  verifiedFeatures.push('compiled workspace disk acknowledgements, locked-save rollback, native JSON recent ordering and exact completed session restart persistence')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'OTHER_WORKSPACE_DURABLE_NOTE' && document.getElementById('workspaceMemoryEnabled').checked")
  await browser.evaluate("document.getElementById('workspaceMemoryEnabled').click(); document.getElementById('workspaceMemorySave').click()")
  await browser.waitFor("document.getElementById('workspaceMemoryBadge').textContent === '已关闭' && !document.getElementById('workspaceMemorySave').disabled")
  assert.equal(await browser.evaluate("document.getElementById('workspaceMemoryContent').value"), 'OTHER_WORKSPACE_DURABLE_NOTE')
  await browser.evaluate("document.getElementById('chatViewBtn').click()")
  await browser.fill('#input', '关闭记忆后不再使用长期笔记')
  await browser.evaluate("document.getElementById('sendBtn').click()")
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('MEMORY_DISABLED_SMOKE_OK')")
  assert.equal(mock.requests.length, 4)
  assert.ok(!JSON.stringify(mock.requests[3]?.messages?.[0]).includes('OTHER_WORKSPACE_DURABLE_NOTE'), 'disabled memory is not injected into the next system prompt')
  const tools = mock.requests[3]?.tools as Array<{ function: { name: string } }> | undefined
  assert.ok(!tools?.some(tool => ['memory_read', 'memory_write'].includes(tool.function.name)), 'disabled memory tools are hidden from the model')
  const altF4Pids = await runtimeProcesses(resumed)
  const physicalClose = interactive && (await nativeWindow(resumed)).interactive
  await nativeWindow(resumed, physicalClose ? 'alt-f4' : 'close-command')
  await Promise.all(altF4Pids.map(waitGone))
  await assert.rejects(request(resumed.url + 'api/state'))
  await browser.close()
  browser = undefined
  console.log(`Saved settings auto-launch, memory restart/off/content preservation, disabled prompt/tools, session persistence and ${physicalClose ? 'actual Alt+F4' : 'SC_CLOSE window command'} child cleanup PASS`)

  launcher = launch()
  const disabled = await readRuntime()
  browser = await attach(disabled)
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'OTHER_WORKSPACE_DURABLE_NOTE' && !document.getElementById('workspaceMemoryEnabled').checked && !document.getElementById('workspaceMemorySave').disabled")
  const sentinel = path.join(other, 'project-sentinel.txt')
  await fs.writeFile(sentinel, 'CLEAR_MEMORY_PRESERVES_PROJECT_FILES')
  const history = await (await request(disabled.url + 'api/state')).json() as { sessions: Array<{ id: string }> }
  assert.ok(history.sessions.length)
  const cancelMessage = await browser.confirm(() => browser!.evaluate("document.getElementById('workspaceMemoryClear').click()"), false)
  assert.ok(cancelMessage.includes('不影响会话历史和项目文件'))
  assert.equal(await browser.evaluate("document.getElementById('workspaceMemoryContent').value"), 'OTHER_WORKSPACE_DURABLE_NOTE')
  await browser.confirm(() => browser!.evaluate("document.getElementById('workspaceMemoryClear').click()"), true)
  await browser.waitFor("document.getElementById('workspaceMemoryContent').value === '' && !document.getElementById('workspaceMemorySave').disabled")
  assert.ok(!(await fs.readFile(path.join(other, '.sakura', 'workspace-memory.md'), 'utf8')).includes('OTHER_WORKSPACE_DURABLE_NOTE'))
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'CLEAR_MEMORY_PRESERVES_PROJECT_FILES')
  const afterClear = await (await request(disabled.url + 'api/state')).json() as { sessions: Array<{ id: string }> }
  assert.deepEqual(afterClear.sessions.map(session => session.id), history.sessions.map(session => session.id))
  assert.equal(mock.requests.length, 4, 'clearing must not make a model request')
  const crashPids = await runtimeProcesses(disabled)
  launcher.kill()
  await Promise.all(crashPids.map(waitGone))
  await assert.rejects(request(disabled.url + 'api/state'))
  await browser.close()
  browser = undefined
  console.log('Disabled memory persists after restart, real clear confirmation/cancel, project/history preservation and launcher-crash descendant cleanup PASS')

  launcher = launch(['--workspace', cwd])
  const original = await readRuntime()
  browser = await attach(original)
  const restoredBudget = await (await request(original.url + 'api/state')).json() as { contextBudget: { contextWindowTokens: number; autoTokensThreshold: number; autoThreshold: number } }
  assert.deepEqual({ contextWindowTokens: restoredBudget.contextBudget.contextWindowTokens, autoTokensThreshold: restoredBudget.contextBudget.autoTokensThreshold, autoThreshold: restoredBudget.contextBudget.autoThreshold },
    { contextWindowTokens: 128000, autoTokensThreshold: 89600, autoThreshold: 0 }, 'context budget is persisted by the launcher and restored on restart')
  await browser.evaluate("document.getElementById('settingsViewBtn').click(); document.getElementById('settings-workspaceTab').click()")
  await browser.waitFor("document.querySelector('#workspaceMemoryList [data-memory-workspace]')")
  await browser.click('#workspaceMemoryList [data-memory-workspace]')
  await browser.waitFor("document.getElementById('workspaceMemoryContent').value === 'DESKTOP_WORKSPACE_MEMORY_ONLY' && document.getElementById('workspaceMemoryEnabled').checked && !document.getElementById('workspaceMemorySave').disabled")
  const otherMarkdown = await fs.readFile(path.join(other, '.sakura', 'workspace-memory.md'), 'utf8')
  assert.ok(!otherMarkdown.includes('OTHER_WORKSPACE_DURABLE_NOTE'), 'clearing one workspace never changes another')
  // Exercise the new facilities through the compiled desktop, after the older
  // context/clear request-count assertions have completed.
  const memoryResponse = await (await request(original.url + 'api/workspace/memory?workspace=' + encodeURIComponent(other))).json() as { revision: number; fingerprint: string }
  assert.equal((await post(original.url + 'api/workspace/memory?workspace=' + encodeURIComponent(other), {
    enabled: true, content: 'CROSS_WORKSPACE_NATIVE_NOTE', revision: memoryResponse.revision, fingerprint: memoryResponse.fingerprint,
  })).status, 200)
  const importedSource = path.join(cwd, 'native-skill', 'SKILL.md')
  await fs.mkdir(path.dirname(importedSource), { recursive: true })
  await fs.writeFile(importedSource, '---\nname: native-imported\ndescription: Native desktop import\n---\nSYNTHETIC_IMPORTED_BODY')
  await browser.evaluate("document.getElementById('settings-skillsTab').click()")
  const skillDoc = await browser.send('DOM.getDocument')
  const skillInput = await browser.send('DOM.querySelector', { nodeId: skillDoc.root.nodeId, selector: '#skillImportFile' })
  await browser.send('DOM.setFileInputFiles', { nodeId: skillInput.nodeId, files: [importedSource] })
  await browser.waitFor("document.getElementById('skillImportMessage').textContent.includes('已导入 native-imported')")
  assert.ok((await fs.readFile(path.join(cwd, '.sakura', 'skills', 'native-imported', 'SKILL.md'), 'utf8')).includes('SYNTHETIC_IMPORTED_BODY'))
  await browser.evaluate("document.getElementById('settingsBack').click()")
  await browser.fill('#input', '@native-imported')
  await browser.waitFor("document.querySelector('#mentionMenu [data-reference-kind=skill]')")
  await browser.key('Enter')
  const nativeSkillToken = await browser.evaluate<string>("document.getElementById('input').value")
  assert.ok(nativeSkillToken.includes('@[skill:native-imported]'))
  const referenceSession = await (await post(original.url + 'api/sessions', { title: 'Native referenced session' })).json() as { sessionId: string }
  const member = await (await post(original.url + 'api/agents', { name: 'Native helper', description: 'Synthetic reference target' })).json() as { agent: { id: string } }
  const nativeTask = `NATIVE_RETRY_TASK ${nativeSkillToken} @[memory:${encodeURIComponent(other)}] @[session:${referenceSession.sessionId}] @[agent:${member.agent.id}]`
  await browser.fill('#input', nativeTask)
  await browser.click('#sendBtn')
  await browser.waitFor("document.querySelector('.retry-card:not(.resolved)') && !document.getElementById('stopBtn').hidden")
  assert.equal(mock.requests.length, 4, 'failed requests never execute tools or reach the success fixture')
  await browser.reload()
  await browser.waitFor("document.querySelector('.retry-card:not(.resolved) .btn-accent:not(:disabled)')")
  await browser.click('.retry-card:not(.resolved) .btn-accent')
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('PRODUCTIVITY_NATIVE_RESULT') && document.getElementById('stopBtn').hidden")
  assert.equal(mock.requests.length, 5)
  const nativeMessages = JSON.stringify(mock.requests[4]?.messages)
  assert.ok(nativeMessages.includes('SYNTHETIC_IMPORTED_BODY'))
  assert.ok(nativeMessages.includes('CROSS_WORKSPACE_NATIVE_NOTE'))
  assert.ok(nativeMessages.includes(member.agent.id))
  assert.equal(await browser.evaluate("document.getElementById('chatCol').textContent.includes('CROSS_WORKSPACE_NATIVE_NOTE')"), false, 'referenced memory body is not dumped into normal chat')
  retryAcceptance.manualLimitConfirmed = true
  const memoryBeforeProcessing = await (await request(original.url + 'api/workspace/memory')).json() as { revision: number; pendingContent: string }
  assert.ok(memoryBeforeProcessing.pendingContent.includes('PRODUCTIVITY_NATIVE_RESULT'))
  const processedMemory = await post(original.url + 'api/workspace/memory/process', { confirmed: true, workspace: cwd })
  assert.equal(processedMemory.status, 200)
  const nativeMemory = await processedMemory.json() as { content: string; pendingContent: string; lastProcessedAt: string }
  assert.ok(nativeMemory.content.includes('PRODUCTIVITY_NATIVE_MEMORY'))
  assert.equal(nativeMemory.pendingContent, '')
  assert.ok(nativeMemory.lastProcessedAt)
  const productivityAcceptance = { markdownStorage: true, defaultOn: true, managementOnDemand: true,
    importedSkill: true, keyboardMentions: true, explicitSessionAndAgentReferences: true, crossWorkspaceMemory: true,
    hiddenMemoryBody: true, pendingCollection: true, manualConsolidation: true }
  verifiedFeatures.push('compiled Skill upload and keyboard @, explicit session/agent/cross-workspace memory, bounded native model retry with reload confirmation, and Markdown consolidation')
  await browser.screenshot(path.join(previews, 'desktop-productivity-result.png'))
  assert.equal(await browser.evaluate("document.querySelector('.topbar').contains(document.getElementById('expertChip'))"), true)
  await browser.fill('#input', 'NATIVE_CHAT_FILES_TASK')
  const fileDrop = await browser.evaluate<{ prevented: boolean; overlay: boolean }>(`(() => {
    const data=new DataTransfer(), target=document.getElementById('input');
    data.items.add(new File(['NATIVE_FILE_TEXT_CONTEXT'],'native-notes.txt',{type:'text/plain'}));
    data.items.add(new File([new Uint8Array([80,75,3,4,0,255])],'native-archive.zip',{type:'application/zip'}));
    target.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:data}));
    const overlay=!document.getElementById('chatDropOverlay').hidden;
    const event=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data});target.dispatchEvent(event);
    return {prevented:event.defaultPrevented,overlay};
  })()`)
  assert.deepEqual(fileDrop, { prevented: true, overlay: true })
  await browser.waitFor("document.querySelectorAll('#attachRow .file-chip').length===2 && !document.querySelector('#attachRow [data-state=reading]')")
  assert.equal(mock.requests.length, 6, 'dragging files never starts a model request')
  await browser.click('#expertChip')
  await browser.waitFor("document.getElementById('expertChip').getAttribute('aria-pressed')==='true' && !document.getElementById('expertChip').disabled")
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_CHAT_FILES_TASK')
  assert.equal(mock.requests.length, 6, 'enabling experts never submits the file draft')
  await browser.screenshot(path.join(previews, 'desktop-chat-files-expert-draft.png'))
  await browser.click('#sendBtn')
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('NATIVE_CHAT_FILES_EXPERT_OK') && document.querySelectorAll('.agent-row[data-status=done]').length>=4 && document.getElementById('attachRow').hidden")
  assert.equal(mock.requests.length, 10)
  const fileRequests = mock.requests.slice(6)
  assert.ok(fileRequests.every(row => JSON.stringify(row.messages).includes('NATIVE_FILE_TEXT_CONTEXT')))
  assert.ok(fileRequests.every(row => (row.messages ?? []).filter(message => message.role === 'user' && JSON.stringify(message.content).includes('NATIVE_CHAT_FILES_TASK')).length === 1), 'one canonical user message per shared expert request')
  assert.ok(fileRequests.every(row => JSON.stringify(row.messages).includes('PRODUCTIVITY_NATIVE_RESULT')), 'experts must see the main session prior context')
  const fileState = await (await request(original.url + 'api/state')).json() as { sessionId: string; sessions: Array<{ id: string }>;
    expertSessions: Array<{ id: string }>; agents: Array<{ id: string; sessionId: string; expert?: string }> }
  assert.equal(fileState.expertSessions.length, 3)
  assert.ok(fileState.agents.filter(agent => agent.expert).every(agent => !fileState.sessions.some(row => row.id === agent.sessionId)))
  const summaries = (await (await request(original.url + 'api/sessions/' + fileState.sessionId + '/records')).json() as { turnSummaries: Array<{ metrics: TurnMetrics }> }).turnSummaries
  assert.equal(summaries.at(-1)!.metrics.scope, 'team'); assert.equal(summaries.at(-1)!.metrics.members, 4)
  await browser.waitFor("[...document.querySelectorAll('#chatCol > .turn-summary')].some(node => node.dataset.scope === 'team' && node.textContent.includes('总耗时'))")
  const userMemory = await (await request(original.url + 'api/workspace/memory')).json() as { pendingContent: string }
  assert.ok(userMemory.pendingContent.includes('NATIVE_CHAT_FILES_TASK'))
  assert.ok(!userMemory.pendingContent.includes('NATIVE_CHAT_FILES_EXPERT_OK'), 'expert utterances must not become durable user directions')
  verifiedFeatures.push('compiled session-leading status, nonstacking expert notice, shared canonical context and user-only memory, persisted token/time team summary')
  await browser.waitFor("document.querySelectorAll('#chatCol .sub-card[data-agent-id]').length === 3 && document.getElementById('expertSessionCount').textContent === '3'")
  assert.equal(await browser.evaluate("document.querySelectorAll('#chatCol .sub-card.message-folded').length"), 3)
  assert.ok((await browser.evaluate<number[]>("[...document.querySelectorAll('#chatCol .sub-card')].map(card => card.getBoundingClientRect().height)")).every(height => height <= 36))
  assert.ok(await browser.evaluate("[...document.querySelectorAll('#chatCol .sub-card .message-fold-preview')].every(preview => preview.textContent === 'NATIVE_CHAT_FILES_EXPERT_OK')"))
  await browser.evaluate("document.querySelector('#chatCol .sub-card .message-fold-head').click()")
  assert.equal(await browser.evaluate("document.querySelector('#chatCol .sub-card .md').checkVisibility()"), true)
  await browser.evaluate("document.getElementById('foldLongMessages').click()")
  assert.equal(await browser.evaluate("document.getElementById('todoSection').parentElement.id"), 'inspector')
  await browser.screenshot(path.join(previews, 'desktop-expert-folded.png'))
  verifiedFeatures.push('compiled one-line expert output with latest preview, disclosure and normal-session exclusion; full records/files remain independently readable')
  const storedPaths: string[] = []
  for (const sid of [fileState.sessionId, ...fileState.agents.filter(agent => agent.expert).map(agent => agent.sessionId)]) {
    const history = await (await request(original.url + 'api/sessions/' + sid + '/records')).json() as { records: Array<{ type: string; payload: { attachments?: ChatAttachment[] } }> }
    const files = history.records.filter(record => record.type === 'user/message' && record.payload.attachments).at(-1)?.payload.attachments
    assert.equal(files?.length, 2)
    assert.deepEqual(files!.map(file => file.kind), ['text', 'binary'])
    assert.equal(await fs.readFile(files![0]!.path, 'utf8'), 'NATIVE_FILE_TEXT_CONTEXT')
    assert.deepEqual(await fs.readFile(files![1]!.path), Buffer.from([80,75,3,4,0,255]))
    storedPaths.push(...files!.map(file => file.path))
  }
  assert.equal(new Set(storedPaths).size, 8, 'main and experts own separate file copies')
  await browser.reload()
  await browser.waitFor("document.getElementById('expertChip').textContent==='专家 · 协同中' && document.querySelectorAll('.user-msg-files .file-chip').length===2")
  assert.equal(await browser.evaluate("document.getElementById('chatCol').textContent.includes('NATIVE_FILE_TEXT_CONTEXT')"), false)
  await browser.click('#expertChip')
  await browser.waitFor("document.getElementById('expertChip').textContent==='专家 · 关闭'")
  assert.equal(await browser.evaluate("document.querySelectorAll('#expertModeNotice').length"), 1)
  assert.ok(await browser.evaluate("document.getElementById('expertModeNoticeText').textContent.includes('已关闭')"))
  assert.equal(await browser.evaluate("[...document.querySelectorAll('#chatCol .sys-line')].filter(node => node.textContent.includes('专家协同模式')).length"), 0)
  const chatFilesAcceptance = { nativeDropEvents: true, mixedTextAndBinary: true, explicitSendOnly: true,
    expertHeader: true, draftPreserved: true, independentExpertCopies: true, exactStoredBytes: true, replayedCards: true, physicalExplorerDropVerified: false }
  verifiedFeatures.push('compiled arbitrary chat files through drag events, inert binary storage, exact bytes, independent expert fan-out, topbar mode and reload')
  skippedChecks.push('Physical Windows Explorer-to-window drag-and-drop is not exercised; native Chromium DataTransfer drop/picker paths are covered.')
  await browser.screenshot(path.join(previews, 'desktop-chat-files-replay.png'))
  const transportCalls = (await fs.readFile(transportLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { url: string; redirect: string; credentials: string })
  assert.equal(transportCalls.filter(row => row.url === SAKURA_MODEL_BASE_URL + '/chat/completions').length, 13)
  assert.ok(transportCalls.every(row => row.redirect === 'error' && row.credentials === 'omit'))
  assert.ok(!(await fs.readFile(path.join(dataDir, 'sakuraapi.json'), 'utf8')).includes(authorizedKey))
  // Reliability checks use the compiled UI and real session APIs, but no new
  // model requests. Only the late-send acknowledgement is a synthetic response.
  await browser.waitFor("!document.getElementById('expertChip').disabled")
  await browser.evaluate(`(() => { window.originalFileRead=FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL=function(){const reader=this;setTimeout(()=>reader.dispatchEvent(new ProgressEvent('abort')),0)};
    const data=new DataTransfer();data.items.add(new File(['aborted'],'native-aborted.txt'));
    document.getElementById('input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()`)
  try {
    await browser.waitFor("document.querySelector('#attachRow [data-state=error]')")
    await browser.click('#attachRow .attach-remove')
    assert.equal(await browser.evaluate("document.getElementById('sendBtn').disabled"), false)
  } finally { await browser.evaluate('FileReader.prototype.readAsDataURL=window.originalFileRead') }
  async function holdNativeResponse(route: string, syntheticSend = false): Promise<void> {
    await browser!.evaluate(`window.originalReliabilityFetch=window.fetch;window.nativeResponseReady=false;window.nativeResponseReleased=false;
      window.fetch=async function(url,init){
        if(url!==${JSON.stringify(route)})return window.originalReliabilityFetch(url,init);
        const response=${syntheticSend ? "new Response(JSON.stringify({ok:true}),{status:202,headers:{'content-type':'application/json'}})" : 'await window.originalReliabilityFetch(url,init)'};
        window.nativeResponseReady=true;await new Promise(resolve=>{window.releaseNativeResponse=resolve});
        window.nativeResponseReleased=true;return response;
      };`)
  }
  async function switchNativeSession(): Promise<string> {
    const response = await post(original.url + 'api/sessions', {})
    assert.equal(response.status, 200)
    const { sessionId } = await response.json() as { sessionId: string }
    await browser!.waitFor("document.querySelector('.session-item.active')?.dataset.sessionId===" + JSON.stringify(sessionId))
    return sessionId
  }
  async function dropNativeDraftFile(): Promise<void> {
    await browser!.evaluate(`(() => { const data=new DataTransfer();data.items.add(new File(['NATIVE_UNSENT_BYTES'],'native-unsent.txt'));
      document.getElementById('input').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data})); })()`)
    await browser!.waitFor("document.querySelectorAll('#attachRow .file-chip').length===1 && document.querySelector('#attachRow [data-state=ready]')")
  }
  await browser.fill('#input', 'NATIVE_NEW_DRAFT_TO_KEEP')
  await holdNativeResponse('/api/experts/start')
  try {
    await browser.click('#expertChip'); await browser.waitFor('window.nativeResponseReady')
    assert.equal(await browser.evaluate("document.getElementById('sendBtn').disabled && !document.getElementById('input').disabled"), true)
    await browser.click('#input'); await browser.key('Enter')
    assert.equal(mock.requests.length, 10)
    await switchNativeSession()
  } finally { await browser.evaluate('window.fetch=window.originalReliabilityFetch;if(window.releaseNativeResponse)window.releaseNativeResponse()') }
  await browser.waitFor('window.nativeResponseReleased && !document.getElementById("expertChip").disabled')
  assert.equal(await browser.evaluate("document.getElementById('expertChip').getAttribute('aria-pressed')"), 'false')
  await browser.fill('#input', 'NATIVE_NEW_DRAFT_TO_KEEP'); await dropNativeDraftFile()
  await holdNativeResponse('/api/message', true)
  let reliabilitySession = ''
  try {
    await browser.click('#sendBtn'); await browser.waitFor('window.nativeResponseReady')
    assert.equal(await browser.evaluate("document.getElementById('expertChip').disabled"), true)
    reliabilitySession = await switchNativeSession()
    await browser.fill('#input', 'NATIVE_NEW_DRAFT_TO_KEEP'); await dropNativeDraftFile()
  } finally { await browser.evaluate('window.fetch=window.originalReliabilityFetch;if(window.releaseNativeResponse)window.releaseNativeResponse()') }
  await browser.waitFor('window.nativeResponseReleased && !document.getElementById("sendBtn").disabled')
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_NEW_DRAFT_TO_KEEP')
  assert.equal(await browser.evaluate("document.querySelectorAll('#attachRow .file-chip').length"), 1)
  const deletedDraftSession = await fetch(original.url + 'api/sessions/' + reliabilitySession, { method: 'DELETE', signal: AbortSignal.timeout(10000) })
  assert.equal(deletedDraftSession.status, 200)
  await browser.waitFor("document.getElementById('attachRow').hidden && !document.querySelector('.session-item.active')")
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_NEW_DRAFT_TO_KEEP')
  assert.equal((await post(original.url + 'api/message', { text: 'invalid legacy image', images: ['data:image/png;base64,***'] })).status, 400)
  assert.equal(mock.requests.length, 10, 'all reliability checks preserve explicit-send model request counts')
  const bugfixAcceptance = { abortedReadRecoverable: true, sendingPausedDuringExpertToggle: true, staleExpertResponseIgnored: true,
    expertToggleBlockedDuringSend: true, staleSendResponseKeepsNewDraft: true, deletedSessionClearsFilesAndKeepsText: true,
    invalidLegacyImageRejected: true, noAdditionalModelRequests: true }
  verifiedFeatures.push('compiled 1.0.0 reliability: abort recovery, send/toggle exclusion, late-response isolation, draft attachment deletion and legacy image validation')
  await browser.screenshot(path.join(previews, 'desktop-bugfix-draft-preserved.png'))
  // Verify this feature in the packaged engine, not only the source Web server.
  assert.equal((await post(original.url + 'api/settings', { approvalMode: 'yolo' })).status, 200)
  assert.equal((await post(original.url + 'api/message', { text: 'NATIVE_HISTORY_ORIGINAL_TASK' })).status, 202)
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('NATIVE_HISTORY_ORIGINAL_ANSWER') && document.querySelector('.msg-user-row [data-history-action=edit]:not(:disabled)')")
  const historySource = await (await request(original.url + 'api/state')).json() as { sessionId: string }
  const historyFile = path.join(cwd, 'native-history.txt')
  assert.equal(await fs.readFile(historyFile, 'utf8'), 'NATIVE_HISTORY_GENERATED_CODE')
  assert.equal(mock.requests.length, 12)
  await browser.fill('#input', 'NATIVE_HISTORY_DRAFT_KEEP')
  await browser.click('[data-history-action=edit]')
  await browser.waitFor("document.getElementById('messageHistoryDialog')?.open && document.getElementById('historyImpact').textContent.includes('native-history.txt')")
  await browser.fill('#historyEditText', 'NATIVE_HISTORY_EDITED_TASK')
  await browser.key('Escape'); await browser.waitFor("!document.getElementById('messageHistoryDialog')")
  assert.equal(mock.requests.length, 12)
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_HISTORY_DRAFT_KEEP')
  const backgroundScript = path.join(scratch, 'native-history-background.cjs')
  await fs.writeFile(backgroundScript, `const http = require('node:http');
const server = http.createServer((_req, res) => res.end('NATIVE_HISTORY_BACKGROUND_ALIVE'));
server.listen(0, '127.0.0.1', () => console.log('NATIVE_HISTORY_BACKGROUND_URL=http://127.0.0.1:' + server.address().port));
`)
  const pwshQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  await fs.writeFile(historyBackgroundControl, JSON.stringify({ cwd, command: '& ' + pwshQuote(process.execPath) + ' ' + pwshQuote(backgroundScript) }), { flag: 'wx' })
  let background: { id: string; pid?: number; status: string; output?: string } | undefined
  const backgroundDeadline = Date.now() + 15000
  while (!background?.output?.includes('NATIVE_HISTORY_BACKGROUND_URL=')) {
    background = await fs.readFile(historyBackgroundStatus, 'utf8').then(text => JSON.parse(text)).catch(() => undefined)
    assert.ok(Date.now() < backgroundDeadline, 'packaged background preview must start')
    await delay(50)
  }
  assert.equal(background.status, 'running')
  const backgroundUrl = background.output.match(/NATIVE_HISTORY_BACKGROUND_URL=(http:\/\/127\.0\.0\.1:\d+)/)![1]!
  const sourceLogPath = path.join(sessionDir, historySource.sessionId, 'session.jsonl')
  const historySourceLog = await fs.readFile(sourceLogPath)
  const savedHistory = await (await request(original.url + 'api/sessions/' + historySource.sessionId + '/records')).json() as { records: Array<{ seq: number; type: string }> }
  const historyUserSeq = savedHistory.records.find(record => record.type === 'user/message')!.seq
  const backgroundPreviewResponse = await post(original.url + 'api/sessions/' + historySource.sessionId + '/history/preview', { turnSeq: historyUserSeq })
  assert.equal(backgroundPreviewResponse.status, 200)
  const backgroundPreview = await backgroundPreviewResponse.json() as { fingerprint: string; contextRevision: number; codeRestoreBlockedReason: string }
  assert.ok(backgroundPreview.codeRestoreBlockedReason.includes('后台命令'))
  assert.equal((await post(original.url + 'api/sessions/' + historySource.sessionId + '/history/rewind', {
    ...backgroundPreview, turnSeq: historyUserSeq, mode: 'both', confirmed: true,
  })).status, 409, 'live background jobs still block code restoration in the packaged engine')
  await browser.click('[data-history-action=edit]')
  await browser.waitFor("document.getElementById('historyMode')?.value === 'conversation' && !document.getElementById('historyRefresh').disabled && document.querySelector('#historyMode option[value=both]').disabled")
  assert.ok((await browser.evaluate<string>("document.getElementById('historyImpact').textContent")).includes('后台命令'))
  await browser.fill('#historyEditText', 'NATIVE_HISTORY_EDITED_TASK')
  await browser.screenshot(path.join(previews, 'desktop-history-background-preview.png'))
  await browser.click('#historyConfirmed'); await browser.click('#historyApply')
  await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.getElementById('chatCol').textContent.includes('NATIVE_HISTORY_EDITED_ANSWER') && document.querySelector('[data-history-action=rewind]:not(:disabled)')")
  assert.equal(mock.requests.length, 13)
  assert.equal(await fs.readFile(historyFile, 'utf8'), 'NATIVE_HISTORY_GENERATED_CODE')
  assert.deepEqual(await fs.readFile(sourceLogPath), historySourceLog)
  assert.equal(await (await request(backgroundUrl)).text(), 'NATIVE_HISTORY_BACKGROUND_ALIVE')
  const backgroundEdited = await (await request(original.url + 'api/state')).json() as { sessionId: string }
  assert.notEqual(backgroundEdited.sessionId, historySource.sessionId)
  await browser.click('[data-history-action=rewind]')
  await browser.waitFor("document.getElementById('historyMode')?.value === 'conversation' && !document.getElementById('historyRefresh').disabled")
  await browser.click('#historyConfirmed'); await browser.click('#historyApply')
  await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 0")
  assert.equal(mock.requests.length, 13, 'conversation rewind with a running preview does not send the model')
  assert.equal(await fs.readFile(historyFile, 'utf8'), 'NATIVE_HISTORY_GENERATED_CODE')
  assert.equal(await (await request(backgroundUrl)).text(), 'NATIVE_HISTORY_BACKGROUND_ALIVE')
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_HISTORY_DRAFT_KEEP')
  assert.ok(background.pid)
  await exec('taskkill.exe', ['/PID', String(background.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 })
  await waitGone(background.pid)
  await fs.unlink(historyBackgroundControl)
  const stoppedDeadline = Date.now() + 8000
  while ((JSON.parse(await fs.readFile(historyBackgroundStatus, 'utf8')) as { status: string }).status === 'running') {
    assert.ok(Date.now() < stoppedDeadline, 'packaged job registry must acknowledge the stopped preview')
    await delay(50)
  }
  assert.equal((await post(original.url + 'api/sessions', { id: historySource.sessionId })).status, 200)
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('NATIVE_HISTORY_ORIGINAL_ANSWER') && document.querySelector('[data-history-action=edit]:not(:disabled)')")
  // The already-verified code restore/edit path remains separate from the
  // conversation-only edit above; one more explicitly requested generation.
  await browser.click('[data-history-action=edit]')
  await browser.waitFor("document.getElementById('historyMode')?.value === 'both' && !document.getElementById('historyRefresh').disabled")
  await browser.fill('#historyEditText', 'NATIVE_HISTORY_EDITED_TASK')
  await browser.screenshot(path.join(previews, 'desktop-history-edit-preview.png'))
  await browser.click('#historyConfirmed'); await browser.click('#historyApply')
  await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.getElementById('chatCol').textContent.includes('NATIVE_HISTORY_EDITED_ANSWER') && document.querySelector('.msg-user-row [data-history-action=rewind]:not(:disabled)')")
  assert.equal(mock.requests.length, 14)
  await assert.rejects(fs.access(historyFile), { code: 'ENOENT' })
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_HISTORY_DRAFT_KEEP')
  const historyEdited = await (await request(original.url + 'api/state')).json() as { sessionId: string }
  assert.notEqual(historyEdited.sessionId, historySource.sessionId)
  const originalRecords = await (await request(original.url + 'api/sessions/' + historySource.sessionId + '/records')).json() as { records: Array<{ type: string; payload: { content?: string } }> }
  assert.ok(originalRecords.records.some(record => record.payload.content === 'NATIVE_HISTORY_ORIGINAL_TASK'))
  const editedRecords = await (await request(original.url + 'api/sessions/' + historyEdited.sessionId + '/records')).json() as { records: Array<{ type: string; payload: { content?: string } }> }
  assert.equal(editedRecords.records.filter(record => record.type === 'user/message').length, 1)
  assert.ok(editedRecords.records.some(record => record.payload.content === 'NATIVE_HISTORY_EDITED_TASK'))
  await browser.reload()
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('NATIVE_HISTORY_EDITED_ANSWER') && document.querySelector('[data-history-action=rewind]:not(:disabled)')")
  await browser.fill('#input', 'NATIVE_HISTORY_DRAFT_KEEP')
  await browser.click('[data-history-action=rewind]')
  await browser.waitFor("document.getElementById('historyMode')?.value === 'conversation' && !document.getElementById('historyRefresh').disabled")
  await browser.click('#historyConfirmed'); await browser.click('#historyApply')
  await browser.waitFor("!document.getElementById('messageHistoryDialog') && document.querySelectorAll('.msg-user-row').length === 0")
  assert.equal(mock.requests.length, 14, 'rollback does not send a model request')
  assert.equal(await browser.evaluate("document.getElementById('input').value"), 'NATIVE_HISTORY_DRAFT_KEEP')
  const historyAcceptance = { originalConversationPreserved: true, editSavedIndependentBranch: true, codeRestored: true,
    generationExactlyOnce: true, cancelNoMutation: true, draftPreserved: true, reloadRestored: true, conversationRewind: true,
    backgroundConversationPreview: true, backgroundConversationEdit: true, backgroundConversationRewind: true,
    backgroundPreviewKeptRunning: true, backgroundCodeRestoreBlocked: true, backgroundStoppedCodeRestore: true, noPhysicalInput: physicalInputDisabled }
  verifiedFeatures.push('compiled message edit, independent branch, persisted native write preimage, confirmed code restore, single regeneration and conversation rewind')
  verifiedFeatures.push('running background preview permits conversation-only edit/rewind without file restoration; code restore stays blocked until the job exits')
  await browser.screenshot(path.join(previews, 'desktop-history-rewound.png'))
  assert.equal((await post(original.url + 'api/account/sakura/logout', {})).status, 200)
  assert.equal(await fs.stat(path.join(dataDir, 'sakuraapi.json')).then(() => true, () => false), false)
  const signedOut = await (await request(original.url + 'api/state')).json() as { modelStatus: { configured: boolean } }
  assert.equal(signedOut.modelStatus.configured, false, 'logout disables the fixed model adapter')
  const finalCalls = (await fs.readFile(transportLog,'utf8')).trim().split('\n').map(line => JSON.parse(line) as {url:string;method:string})
  assert.equal(finalCalls.filter(row => row.url.endsWith('/auth/client/revoke')).length,1,'only this client session is revoked')
  assert.ok(!finalCalls.some(row => row.url.endsWith('/auth/logout') || row.url.endsWith('/api/v1/keys') && row.method === 'POST'))
  assert.equal(mock.requests.length, 14, 'logout never sends a model or payment request')
  verifiedFeatures.push('fixed-origin model wire traffic, remembered authorization after restart and acknowledged logout removes encrypted Key')
  const originalPids = await runtimeProcesses(original)
  await browser.evaluate("document.getElementById('desktopClose').click()")
  await Promise.all(originalPids.map(waitGone))
  console.log('Original workspace memory remains enabled and intact after independent workspace clear/restart PASS')
  await fs.writeFile(verificationFile, JSON.stringify({ exe, startedAt, sourceHash,
    exeSha256: createHash('sha256').update(binary).digest('hex'),
    launcherSha256: createHash('sha256').update(await fs.readFile(path.join(root, 'scripts', 'desktop', 'Launcher.cs'))).digest('hex'),
    physicalInteractionMode: physicalInputDisabled ? 'disabled' : 'automatic',
    focusPixelChecksPassed: interactive, physicalKeyboardVerified: false, physicalImeVerified: false,
    verifiedFeatures, marketAcceptance, layoutAcceptance, contextAcceptance, quotaAcceptance, retryAcceptance, productivityAcceptance, updatesAcceptance, chatFilesAcceptance, bugfixAcceptance, historyAcceptance, workspaceAcceptance,
    clientAccountAcceptance: { rotationAcknowledged:true, separateInferenceKey:true, noAutomaticKeyCreation:true, realProfile:true, vipLevel:7, embeddedVipAssets, clientOnlyRevocation:true },
    isolation: { windowsUserProfile: process.env.USERPROFILE, temporaryRoot: os.tmpdir(), dataDir, workspace: cwd },
    syntheticCredentialsOnly: true, fixedUpstream: SAKURA_MODEL_BASE_URL,
    transportCalls: transportCalls.map(row => row.url),
    finishedAt: new Date().toISOString(), passed: true, skippedChecks }, null, 2), { flag: 'wx' })
  console.log(skippedChecks.length ? 'Desktop smoke PASS with explicitly skipped interactive checks' : 'Desktop smoke PASS including physical interaction checks')
} catch (error) {
  const log = await fs.readFile(path.join(dataDir, 'desktop.log'), 'utf8').catch(() => '')
  await fs.writeFile(path.join(previews, 'desktop-last-failure.log'), log)
  // Preserve only synthetic workspace settings and append-only session logs
  // before cleaning runtime/browser profiles; never copy account envelopes.
  const evidence = path.join(previews, 'failure-workspace-evidence')
  await fs.mkdir(evidence, { recursive: true })
  const settingsText = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => '')
  if (settingsText) await fs.writeFile(path.join(evidence, 'settings.json'), settingsText, { flag: 'wx' })
  const files: Array<{ source: string; preserved: string; sha256: string }> = []
  async function preserveSessionLogs(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const source = path.join(directory, entry.name)
      if (entry.isDirectory() && !['desktop data', 'external-profile'].includes(entry.name)) await preserveSessionLogs(source)
      else if (entry.isFile() && entry.name === 'session.jsonl') {
        const bytes = await fs.readFile(source), preserved = path.join(evidence, path.relative(scratch, source))
        await fs.mkdir(path.dirname(preserved), { recursive: true })
        await fs.writeFile(preserved, bytes, { flag: 'wx' })
        files.push({ source, preserved, sha256: createHash('sha256').update(bytes).digest('hex') })
      }
    }
  }
  await preserveSessionLogs(scratch)
  await fs.writeFile(path.join(evidence, 'manifest.json'), JSON.stringify({ syntheticOnly: true,
    failure: error instanceof Error ? error.stack : String(error), originalScratch: scratch, files }, null, 2), { flag: 'wx' })
  console.error('Desktop smoke diagnostics:', log)
  throw error
} finally {
  await browser?.resetViewport().catch(() => {})
  if (launcher?.pid && running(launcher.pid)) {
    await exec('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  }
  await browser?.close().catch(() => {})
  await mock.close()
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }).catch(error => console.error('Scratch cleanup:', error.message))
}