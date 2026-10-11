/** Opt-in real Windows desktop test. npm run desktop; npx tsx scripts/desktop-smoke.ts [absolute-exe-path] */
import assert from 'node:assert/strict'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { BrowserClient } from '../tests/browser-client.js'
import { framesForText, startMockServer } from './mock-openai-server.js'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const exe = process.argv[2] ?? path.join(root, 'build', 'SakuraCode Desktop.exe')
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'sakura-desktop-smoke-'))
const cwd = path.join(scratch, '中文 project')
const dataDir = path.join(scratch, 'desktop data')
const previews = path.join(root, 'tmp', 'desktop-previews')
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const request = (url: string) => fetch(url, { signal: AbortSignal.timeout(2500) })
const post = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(2500),
})
const running = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const mock = await startMockServer({ script: [
  () => framesForText('DESKTOP_GUI_SMOKE_OK'),
  () => framesForText('OTHER_WORKSPACE_SMOKE_OK'),
] })
let launcher: ChildProcess | undefined
let browser: BrowserClient | undefined

interface RuntimeInfo { launcherPid: number; enginePid: number; browserPid: number; url: string; browserProfile: string }

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

function launch(extra: string[] = []): ChildProcess {
  const child = spawn(exe, ['--data-dir', dataDir, ...extra], {
    cwd: scratch, stdio: 'ignore',
    env: { ...process.env, SAKURA_DESKTOP_DEBUG: '1', SAKURA_WEB_TOKEN: 'invalid inherited token', SAKURA_WEB_VIEWER_TOKEN: 'invalid inherited viewer token' },
  })
  child.once('error', error => { console.error(error) })
  return child
}

async function attach(info: RuntimeInfo): Promise<BrowserClient> {
  const port = (await fs.readFile(path.join(info.browserProfile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
  const pages = await (await request(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ url: string; webSocketDebuggerUrl: string }>
  const page = pages.find(entry => entry.url.startsWith(info.url))
  assert.ok(page, 'must open the workspace in the app window')
  const client = new BrowserClient()
  await client.connect(page.webSocketDebuggerUrl)
  await client.waitFor("document.getElementById('connectionLabel')?.textContent === '本地服务已连接'")
  return client
}

try {
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(previews, { recursive: true })
  await fs.writeFile(path.join(cwd, 'sakura.yml'), JSON.stringify({ pluginsDir: 'no-plugins', bundles: [], web: { host: '0.0.0.0', publicOrigin: 'https://invalid.example' } }))
  const binary = await fs.readFile(exe)
  // The launcher no longer shows a native setup window: it launches the
  // workspace directly and the settings view applies changes over HTTP.
  // 'cwd' is the variable (the absolute temp workspace), not a literal string:
  // a relative --workspace is rejected by the launcher's argument parser.
  launcher = launch(['--workspace', cwd])
  const first = await readRuntime()
  assert.ok(first.url.startsWith('http://127.0.0.1:') && first.url.endsWith('/'))
  const applied = await (await post(first.url + 'api/desktop/settings', {
    baseURL: mock.url,
    model: 'desktop-mock-chat',
    apiKey: 'desktop-smoke-not-a-real-key',
    rememberKey: true,
  })).json() as { workspace: string; recentWorkspaces: string[]; rememberKey: boolean; hasApiKey: boolean }
  assert.equal(applied.workspace, cwd)
  assert.deepEqual(applied.recentWorkspaces, [cwd])
  assert.equal(applied.rememberKey, true)
  assert.equal(applied.hasApiKey, true)
  // Per-workspace prefs (session dir / agents) and the global default for new
  // workspaces ride the same persist frame; the C# launcher must store them.
  const sessionDir = path.join(scratch, 'sessions-store')
  const defaultParent = path.join(scratch, 'new-workspaces')
  const prefApplied = await (await post(first.url + 'api/desktop/settings', {
    sessionDir,
    newWorkspaceDir: defaultParent,
    agents: [],
  })).json() as { sessionDir: string; newWorkspaceDir: string; agents: string[] }
  assert.equal(prefApplied.sessionDir, sessionDir)
  assert.equal(prefApplied.newWorkspaceDir, defaultParent)
  assert.deepEqual(prefApplied.agents, [])
  const state = await (await request(first.url + 'api/state')).json() as { cwd: string; approvalMode: string }
  assert.equal(state.cwd, cwd)
  assert.equal(state.approvalMode, 'default')
  // The launcher also writes settings.json at startup (resolved launch config,
  // ProtectedApiKey null on a fresh data dir). Wait for the latest persist
  // frame — the one carrying the prefs — to land before reading the file.
  let settingsText = ''
  const persistDeadline = Date.now() + 10000
  while (Date.now() < persistDeadline) {
    settingsText = await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8').catch(() => '')
    if (settingsText.includes('"ProtectedApiKey":"') && settingsText.includes(sessionDir)) break
    await delay(100)
  }
  assert.ok(settingsText.includes('"ProtectedApiKey":"'), 'launcher did not persist desktop settings')
  const saved = JSON.parse(settingsText)
  assert.equal(saved.RememberKey, true)
  assert.ok(saved.ProtectedApiKey)
  assert.ok(!settingsText.includes('desktop-smoke-not-a-real-key'))
  // The prefs survived the C# merge: session dir for this workspace, and the
  // global new-workspace default.
  assert.equal(saved.NewWorkspaceDir, defaultParent)
  const prefsForWs = (saved.WorkspacePrefs ?? {})[cwd]
  assert.ok(prefsForWs, 'launcher did not persist per-workspace prefs')
  assert.equal(prefsForWs.sessionDir, sessionDir)

  const decrypted = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.Security; $s=Get-Content -Raw -LiteralPath '${path.join(dataDir, 'settings.json').replaceAll("'", "''")}' | ConvertFrom-Json; $value=[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s.ProtectedApiKey),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)); if ($value -ne 'desktop-smoke-not-a-real-key') { exit 1 }; Write-Output 'DPAPI round-trip PASS'`,
  ], { windowsHide: true, timeout: 10000 })
  console.log(decrypted.stdout.trim())
  // Edge/Chrome pass the window to a child process; runtime.json's windowOwnerPid
  // names the process that actually owns the app window after that handoff.
  const ownerPid = (first as RuntimeInfo & { windowOwnerPid?: number }).windowOwnerPid ?? first.browserPid
  const processInfo = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${first.enginePid} OR ProcessId = ${first.browserPid} OR ProcessId = ${ownerPid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
  ], { windowsHide: true, timeout: 10000 })
  assert.ok(!processInfo.stdout.includes('desktop-smoke-not-a-real-key'), 'credentials must not enter child argv')
  assert.ok(processInfo.stdout.includes('--app='), 'not an ordinary browser tab')
  browser = await attach(first)
  await browser.screenshot(path.join(previews, 'desktop-welcome.png'))
  await browser.fill('#input', '验证桌面打包和中文项目路径')
  // Do not depend on the user's foreground window while a headed app is under test.
  await browser.evaluate("document.getElementById('sendBtn').click()")
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('DESKTOP_GUI_SMOKE_OK')")
  assert.equal(mock.requests.length, 1)
  assert.equal(mock.requests[0]?.model, 'desktop-mock-chat')
  await browser.screenshot(path.join(previews, 'desktop-chat.png'))
  await browser.reload()
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('DESKTOP_GUI_SMOKE_OK')")
  await browser.evaluate("document.getElementById('dashboardBtn').click()")
  await browser.waitFor("!document.getElementById('dashboard').hidden")
  await browser.screenshot(path.join(previews, 'desktop-dashboard.png'))
  assert.deepEqual(browser.errors, [])
  // Workspace switch (desktop mode): the harness remounts on a new workspace
  // while the window, its model overrides and the approval mode survive.
  const other = path.join(scratch, 'other project')
  await fs.mkdir(other, { recursive: true })
  await fs.writeFile(path.join(other, 'sakura.yml'), JSON.stringify({ pluginsDir: 'no-plugins', bundles: [] }))
  const switched = await (await post(first.url + 'api/desktop/settings', { workspace: other })).json() as { workspace: string; recentWorkspaces: string[] }
  assert.equal(switched.workspace, other)
  assert.deepEqual(switched.recentWorkspaces, [other, cwd])
  await browser.waitFor("document.querySelectorAll('#workspaceList .workspace-item').length === 2")
  await browser.waitFor("document.querySelector('#workspaceList .workspace-item.active .workspace-name')?.textContent === 'other project'")
  await browser.waitFor("!document.querySelector('#chatCol .msg-user-row')")
  await browser.evaluate("document.getElementById('settingsViewBtn').click()")
  await browser.waitFor("!document.getElementById('settingsView').hidden")
  await browser.screenshot(path.join(previews, 'desktop-settings.png'))
  await browser.fill('#input', '验证切换后的工作区')
  await browser.evaluate("document.getElementById('sendBtn').click()")
  await browser.waitFor("document.getElementById('chatCol').textContent.includes('OTHER_WORKSPACE_SMOKE_OK')")
  assert.equal(mock.requests.length, 2)
  assert.equal(mock.requests[1]?.model, 'desktop-mock-chat')
  assert.deepEqual(browser.errors, [])
  const secondLaunch = launch()
  await waitGone(secondLaunch.pid!)
  assert.ok(running(first.launcherPid), 'repeat launch must not replace the active process')
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
  await browser.waitFor("document.querySelectorAll('#sessionList .session-item').length > 0")
  launcher.kill()
  await Promise.all([waitGone(resumed.launcherPid), waitGone(resumed.enginePid), waitGone(resumed.browserPid)])
  await assert.rejects(request(resumed.url + 'api/state'))
  console.log('Saved settings auto-launch, session persistence and launcher-crash child cleanup PASS')
} finally {
  if (launcher?.pid && running(launcher.pid)) {
    await exec('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
  }
  await browser?.close().catch(() => {})
  await mock.close()
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }).catch(error => console.error('Scratch cleanup:', error.message))
}