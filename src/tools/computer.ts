/**
 * tool-computer — Windows computer-use tools: screenshot, mouse and keyboard.
 * Zero npm dependencies; everything runs through Windows PowerShell
 * (powershell.exe) with P/Invoke (user32) and System.Drawing.
 *
 * Every call spawns a short-lived powershell.exe and passes the script via
 * -EncodedCommand (Base64 UTF-16LE) so no shell quoting is ever needed. The
 * Add-Type P/Invoke recompiles per call (~300-600 ms) — accepted for v0.
 *
 * Coordinate system: PHYSICAL screen pixels. Each call makes its process
 * DPI-aware (SetProcessDPIAware) before reading bounds, so pixels seen in
 * computer_screenshot map 1:1 onto SetCursorPos / mouse_event.
 *
 * Wheel direction: MOUSEEVENTF_WHEEL with a NEGATIVE delta scrolls the
 * document DOWN (verified empirically against this OS), so a positive
 * `amount` (scroll down) is sent as -amount * WHEEL_DELTA (120).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import type { Plugin } from '../kernel/index.js'
import type { ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { params, type ToolsService } from '../core/tools.js'

const TIMEOUT_MS = 15_000
/** Base64 of a full-screen PNG can reach ~10-30 MB; never truncate the image. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024
const MAX_STDERR_CHARS = 4_000
const WHEEL_EVENT = 0x0800 // MOUSEEVENTF_WHEEL
const WHEEL_DELTA = 120

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const SENDKEYS_SPECIAL = new Set(['+', '^', '%', '~', '(', ')', '{', '}'])

/**
 * Escape plain text into a literal SendKeys sequence: the syntax characters
 * + ^ % ~ ( ) { } are wrapped in braces ('{' -> '{{}', '}' -> '{}}'). Square
 * brackets are NOT SendKeys syntax (never mentioned by the grammar) and are
 * sent as-is — brace-wrapping an unknown keyword like "{[}" only works via
 * the single-char fallback, so the literal is safer.
 */
export function escapeSendKeys(text: string): string {
  let out = ''
  for (const ch of text) {
    out += SENDKEYS_SPECIAL.has(ch) ? `{${ch}}` : ch
  }
  return out
}

/** SendKeys sequences for the named special keys (verified via MatchKeyword). */
const KEY_NAMES: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  esc: '{ESC}',
  escape: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pgup: '{PGUP}',
  pgdn: '{PGDN}',
  insert: '{INS}',
  ins: '{INS}',
  space: ' ',
  break: '{BREAK}',
  capslock: '{CAPSLOCK}',
}
for (let i = 1; i <= 24; i++) KEY_NAMES[`f${i}`] = `{F${i}}`

const MODIFIERS: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' }

/**
 * Map a chord like "ctrl+shift+esc" to its SendKeys sequence ("^+{ESC}").
 * Modifiers: ctrl/^ alt/% shift/+ — emitted in the order written. "win" alone
 * becomes "^{ESC}" (Start menu); the Windows key cannot be held, so "win+x"
 * is rejected. Throws on unknown key names.
 */
export function mapKey(key: string): string {
  const trimmed = key.trim()
  if (!trimmed) throw new Error('key must be a non-empty string')
  const parts = trimmed.toLowerCase().split('+')
  let mods = ''
  let main: string | undefined
  for (const part of parts) {
    if (!part) {
      throw new Error(`invalid key "${key}": empty segment (a literal "+" cannot be sent as a key; use computer_type)`)
    }
    const mod = MODIFIERS[part]
    if (mod !== undefined) {
      mods += mod
      continue
    }
    if (part === 'win') {
      if (parts.length === 1) return '^{ESC}'
      throw new Error(`invalid key "${key}": the Windows key cannot be combined with other keys — send "win" alone`)
    }
    if (main !== undefined) {
      throw new Error(`invalid key "${key}": multiple non-modifier keys`)
    }
    const named = KEY_NAMES[part]
    if (named !== undefined) {
      main = named
      continue
    }
    if (part.length === 1) {
      main = escapeSendKeys(part)
      continue
    }
    throw new Error(
      `unknown key "${part}" (supported: a single character, or enter tab esc backspace delete ` +
        'up down left right home end pgup pgdn insert space f1-f12 with ctrl/alt/shift modifiers)',
    )
  }
  if (main === undefined) throw new Error(`invalid key "${key}"`)
  return mods + main
}

// ---------------------------------------------------------------------------
// PowerShell script assembly
// ---------------------------------------------------------------------------

type MouseButton = 'left' | 'right' | 'middle'
const BUTTON_FLAGS: Record<MouseButton, { down: number; up: number }> = {
  left: { down: 0x0002, up: 0x0004 },
  right: { down: 0x0008, up: 0x0010 },
  middle: { down: 0x0020, up: 0x0040 },
}

/** Shared user32 P/Invoke. Each call is a fresh powershell.exe, so Add-Type never collides. */
const PS_USER32 = `Add-Type -Namespace Sakura -Name Native -MemberDefinition '
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' | Out-Null`

/** Wrap a script body: UTF-8 console, errors to stderr with exit code 1. */
function psScript(body: string): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }',
    'try {',
    body,
    '} catch {',
    "  [Console]::Error.WriteLine('computer tool error: ' + $_.Exception.Message)",
    '  exit 1',
    '}',
  ].join('\n')
}

function psSingleQuoted(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

function screenshotScript(monitor: 'primary' | 'all'): string {
  return psScript(
    [
      'Add-Type -AssemblyName System.Drawing | Out-Null',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      PS_USER32,
      '[void][Sakura.Native]::SetProcessDPIAware()',
      '$screen = [System.Windows.Forms.Screen]::PrimaryScreen',
      '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      monitor === 'all'
        ? '# all monitors: capture the whole virtual screen'
        : [
            'if ($null -eq $screen) { throw "no display detected (no interactive desktop session)" }',
            '$bounds = $screen.Bounds',
          ].join('\n'),
      'if ([int]$bounds.Width -le 0 -or [int]$bounds.Height -le 0) { throw "no display detected: screen bounds are 0x0 (headless session?)" }',
      "$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('sakura-shot-' + [Guid]::NewGuid().ToString('N') + '.png')",
      '$bmp = [System.Drawing.Bitmap]::new([int]$bounds.Width, [int]$bounds.Height)',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      'try {',
      '  $g.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bmp.Size)',
      '  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)',
      '} finally {',
      '  $g.Dispose()',
      '  $bmp.Dispose()',
      '}',
      'try { $bytes = [System.IO.File]::ReadAllBytes($tmp) } finally { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }',
      "[Console]::Out.WriteLine(('{0}x{1}' -f [int]$bounds.Width, [int]$bounds.Height))",
      '[Console]::Out.WriteLine([Convert]::ToBase64String($bytes))',
    ].join('\n'),
  )
}

function clickScript(x: number, y: number, button: MouseButton, double: boolean): string {
  const flags = BUTTON_FLAGS[button]
  const press = [
    `[Sakura.Native]::mouse_event(${flags.down}, 0, 0, 0, [UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 25',
    `[Sakura.Native]::mouse_event(${flags.up}, 0, 0, 0, [UIntPtr]::Zero)`,
  ]
  return psScript(
    [
      PS_USER32,
      `[void][Sakura.Native]::SetCursorPos(${x}, ${y})`,
      'Start-Sleep -Milliseconds 40',
      ...press,
      ...(double ? ['Start-Sleep -Milliseconds 60', ...press] : []),
      "[Console]::Out.WriteLine('ok')",
    ].join('\n'),
  )
}

function moveScript(x: number, y: number): string {
  return psScript(
    [
      PS_USER32,
      `[void][Sakura.Native]::SetCursorPos(${x}, ${y})`,
      "[Console]::Out.WriteLine('ok')",
    ].join('\n'),
  )
}

function scrollScript(amount: number, x: number | undefined, y: number | undefined): string {
  const lines = [PS_USER32]
  if (x !== undefined && y !== undefined) {
    lines.push(`[void][Sakura.Native]::SetCursorPos(${x}, ${y})`, 'Start-Sleep -Milliseconds 40')
  }
  lines.push(
    `[Sakura.Native]::mouse_event(${WHEEL_EVENT}, 0, 0, ${-amount * WHEEL_DELTA}, [UIntPtr]::Zero)`,
    "[Console]::Out.WriteLine('ok')",
  )
  return psScript(lines.join('\n'))
}

function sendKeysScript(sequence: string): string {
  return psScript(
    [
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      `[System.Windows.Forms.SendKeys]::SendWait(${psSingleQuoted(sequence)})`,
      "[Console]::Out.WriteLine('ok')",
    ].join('\n'),
  )
}

// ---------------------------------------------------------------------------
// powershell.exe runner
// ---------------------------------------------------------------------------

interface PsOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

/** Kill the spawned shell and its process tree (grandchildren survive a bare kill on Windows). */
function killTree(child: ChildProcess): void {
  if (!child.pid) {
    child.kill()
    return
  }
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
}

function runPowerShell(script: string, tc: ToolContext): Promise<PsOutcome> {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const chunks: Buffer[] = []
    let outBytes = 0
    let stderr = ''
    let timedOut = false
    let done = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, TIMEOUT_MS)
    const onAbort = () => killTree(child)
    const finish = (result: PsOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      tc.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    if (tc.signal.aborted) onAbort()
    else tc.signal.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outBytes >= MAX_STDOUT_BYTES) return
      outBytes += chunk.length
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({ code: null, stdout: '', stderr, timedOut, spawnError: error.message })
    })
    child.on('close', (code) => {
      finish({ code, stdout: Buffer.concat(chunks).toString('utf8'), stderr, timedOut })
    })
  })
}

// ---------------------------------------------------------------------------
// Tool plumbing
// ---------------------------------------------------------------------------

function errorResult(message: string): ToolResult {
  return { output: `error: ${message}`, isError: true }
}

function stderrTail(outcome: PsOutcome): string {
  const tail = outcome.stderr
    .replace(/\r/g, '')
    .trim()
    .split('\n')
    .slice(-4)
    .join('\n')
    .trim()
  return tail ? ` — ${tail.slice(-MAX_STDERR_CHARS)}` : ''
}

/** Run one computer script and route failures (spawn / abort / timeout / exit) to isError results. */
async function runAndParse(
  tc: ToolContext,
  script: string,
  parse: (stdout: string) => ToolResult,
): Promise<ToolResult> {
  const outcome = await runPowerShell(script, tc)
  if (outcome.spawnError) {
    return errorResult(`failed to start powershell.exe: ${outcome.spawnError}`)
  }
  if (tc.signal.aborted) return errorResult('cancelled')
  if (outcome.timedOut) return errorResult(`timed out after ${TIMEOUT_MS} ms${stderrTail(outcome)}`)
  if (outcome.code !== 0) return errorResult(`powershell exited with code ${outcome.code}${stderrTail(outcome)}`)
  return parse(outcome.stdout)
}

/** Strict integer argument; returns Error (render as isError) instead of throwing. */
function getInt(args: Record<string, unknown>, name: string, min = Number.NEGATIVE_INFINITY): number | Error {
  const raw = args[name]
  if (raw === undefined || raw === null) return new Error(`${name} is required`)
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n)) return new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`)
  if (n < min) return new Error(`${name} must be >= ${min}, got ${n}`)
  return n
}

function parseScreenshot(stdout: string, monitor: 'primary' | 'all'): ToolResult {
  // Strip BOM / CR artifacts from PowerShell stdout, then read line 1 = "WxH", line 2 = base64.
  const text = stdout.replace(/^\uFEFF/, '').replace(/\r/g, '')
  const nl = text.indexOf('\n')
  const dimsLine = (nl >= 0 ? text.slice(0, nl) : text).trim()
  const b64 = (nl >= 0 ? text.slice(nl + 1) : '').split('\n')[0]?.replace(/\s+/g, '') ?? ''
  const match = /^(\d+)x(\d+)$/.exec(dimsLine)
  if (!match || !match[1] || !match[2]) {
    return errorResult('screenshot failed: could not parse dimensions from powershell output')
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length < 100) {
    return errorResult('screenshot failed: no image data on stdout')
  }
  return {
    output: `screenshot ${match[1]}x${match[2]} (${monitor})`,
    images: [`data:image/png;base64,${b64}`],
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const computerToolsPlugin: Plugin = {
  name: 'tool-computer',
  description: 'Computer use tools (screenshot, mouse, keyboard)',
  inject: ['tools'],
  apply(_ctx, _config, toolsLike: unknown) {
    const tools = toolsLike as ToolsService

    tools.register({
      name: 'computer_screenshot',
      description:
        'Capture the screen and return it as a PNG image (data URL). ' +
        'Coordinates for all computer_* tools are PHYSICAL screen pixels (DPI-aware) and match ' +
        'this screenshot exactly — always take click/scroll coordinates from a fresh screenshot, ' +
        'never guess them. monitor: "primary" (default) or "all" (entire virtual desktop).',
      kind: 'execute',
      parameters: params({
        monitor: { type: 'string', enum: ['primary', 'all'], description: '"primary" (default) or "all" monitors' },
      }),
      execute: async (args, tc) => {
        const monitor = args.monitor === 'all' ? 'all' : 'primary'
        if (tc.signal.aborted) return errorResult('cancelled')
        return runAndParse(tc, screenshotScript(monitor), (stdout) => parseScreenshot(stdout, monitor))
      },
    })

    tools.register({
      name: 'computer_click',
      description:
        'Click the mouse at screen pixel coordinates (x, y) — physical pixels, DPI-aware, as seen in ' +
        'computer_screenshot. Workflow: computer_screenshot first, then click at coordinates measured ' +
        'from what you saw. button: "left" (default) | "right" | "middle"; double: true for a double-click.',
      kind: 'execute',
      parameters: params(
        {
          x: { type: 'integer', description: 'X in physical screen pixels (>= 0)' },
          y: { type: 'integer', description: 'Y in physical screen pixels (>= 0)' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'default "left"' },
          double: { type: 'boolean', description: 'true for a double-click (default false)' },
        },
        ['x', 'y'],
      ),
      execute: async (args, tc) => {
        const x = getInt(args, 'x', 0)
        if (x instanceof Error) return errorResult(x.message)
        const y = getInt(args, 'y', 0)
        if (y instanceof Error) return errorResult(y.message)
        const button: MouseButton = args.button === 'right' || args.button === 'middle' ? args.button : 'left'
        const double = args.double === true || args.double === 'true'
        if (tc.signal.aborted) return errorResult('cancelled')
        return runAndParse(tc, clickScript(x, y, button, double), () => ({
          output: `clicked ${double ? 'double ' : ''}${button} (${x}, ${y})`,
        }))
      },
    })

    tools.register({
      name: 'computer_move',
      description:
        'Move the mouse cursor to screen pixel coordinates (x, y) without clicking. ' +
        'Physical pixels (DPI-aware), same coordinate system as computer_screenshot.',
      kind: 'execute',
      parameters: params(
        {
          x: { type: 'integer', description: 'X in physical screen pixels (>= 0)' },
          y: { type: 'integer', description: 'Y in physical screen pixels (>= 0)' },
        },
        ['x', 'y'],
      ),
      execute: async (args, tc) => {
        const x = getInt(args, 'x', 0)
        if (x instanceof Error) return errorResult(x.message)
        const y = getInt(args, 'y', 0)
        if (y instanceof Error) return errorResult(y.message)
        if (tc.signal.aborted) return errorResult('cancelled')
        return runAndParse(tc, moveScript(x, y), () => ({ output: `moved cursor to (${x}, ${y})` }))
      },
    })

    tools.register({
      name: 'computer_scroll',
      description:
        'Scroll the mouse wheel. amount: wheel notches — POSITIVE scrolls DOWN (toward later content), ' +
        'negative scrolls up. If x/y are given, the cursor is moved there first (many apps scroll the ' +
        'window under the cursor). Coordinates are physical pixels from computer_screenshot.',
      kind: 'execute',
      parameters: params({
        amount: { type: 'integer', description: 'notches to scroll; positive = down, negative = up' },
        x: { type: 'integer', description: 'optional cursor X before scrolling (requires y)' },
        y: { type: 'integer', description: 'optional cursor Y before scrolling (requires x)' },
      }),
      execute: async (args, tc) => {
        const amount = getInt(args, 'amount')
        if (amount instanceof Error) return errorResult(amount.message)
        let x: number | undefined
        let y: number | undefined
        if (args.x !== undefined || args.y !== undefined) {
          const vx = getInt(args, 'x', 0)
          if (vx instanceof Error) return errorResult(vx.message)
          const vy = getInt(args, 'y', 0)
          if (vy instanceof Error) return errorResult(vy.message)
          x = vx
          y = vy
        }
        if (tc.signal.aborted) return errorResult('cancelled')
        const at = x !== undefined && y !== undefined ? ` (${x}, ${y})` : ''
        return runAndParse(tc, scrollScript(amount, x, y), () => ({
          output: `scrolled ${amount >= 0 ? 'down' : 'up'} ${Math.abs(amount)} notches${at}`,
        }))
      },
    })

    tools.register({
      name: 'computer_type',
      description:
        'Type text into the currently focused window via SendKeys. Plain text is typed literally — ' +
        'SendKeys syntax characters (+ ^ % ~ ( ) { }) are escaped automatically. Set raw=true to send ' +
        'SendKeys syntax itself, e.g. "{ENTER}", "^s", "%{F4}", "+{TAB}". The target window must have focus.',
      kind: 'execute',
      parameters: params(
        {
          text: { type: 'string', description: 'Text to type (escaped unless raw=true)' },
          raw: { type: 'boolean', description: 'true: send the text as raw SendKeys syntax (default false)' },
        },
        ['text'],
      ),
      execute: async (args, tc) => {
        const text = String(args.text ?? '')
        if (!text) return errorResult('text must be a non-empty string')
        const raw = args.raw === true || args.raw === 'true'
        const sequence = raw ? text : escapeSendKeys(text)
        if (tc.signal.aborted) return errorResult('cancelled')
        return runAndParse(tc, sendKeysScript(sequence), () => ({ output: `typed ${text.length} characters` }))
      },
    })

    tools.register({
      name: 'computer_key',
      description:
        'Press a key or key chord in the focused window. Grammar: [ctrl|alt|shift +]* key, where key is ' +
        'a single character or one of: enter tab esc backspace delete up down left right home end pgup ' +
        'pgdn insert space f1-f12. "win" alone opens the Start menu (the Windows key cannot be combined ' +
        'with other keys). Examples: "ctrl+s", "alt+tab", "ctrl+shift+esc", "enter", "win".',
      kind: 'execute',
      parameters: params(
        {
          key: { type: 'string', description: 'Key or chord, e.g. "ctrl+s", "alt+tab", "enter", "f5"' },
        },
        ['key'],
      ),
      execute: async (args, tc) => {
        const key = String(args.key ?? '').trim()
        if (!key) return errorResult('key must be a non-empty string')
        let sequence: string
        try {
          sequence = mapKey(key)
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error))
        }
        if (tc.signal.aborted) return errorResult('cancelled')
        return runAndParse(tc, sendKeysScript(sequence), () => ({ output: `pressed ${key}` }))
      },
    })
  },
}
