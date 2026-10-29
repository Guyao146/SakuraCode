param([Parameter(Mandatory = $true)][long]$WindowHandle, [Parameter(Mandatory = $true)][long]$BrowserWindowHandle,
  [ValidateSet('inspect', 'focus', 'focus-cycle', 'restore', 'resize', 'resize-burst', 'browser-size-drift', 'minimize-command', 'drag', 'double-click', 'alt-f4', 'close-command')][string]$Action = 'inspect',
  [string]$Screenshot = '', [int]$PointerX = 0, [int]$PointerY = 0,
  [ValidateRange(480, 4096)][int]$Width = 1100, [ValidateRange(400, 2160)][int]$Height = 820)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Diagnostics;
public static class DesktopWindowProbe {
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    public sealed class FramePixels {
        public long foregroundRoot;
        public uint? dwmBorderColor, dwmNcRendering;
        public int checkedPixels, brightPixels;
    }
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out uint value, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr window);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [StructLayout(LayoutKind.Sequential)] public struct GuiThreadInfo {
        public uint Size, Flags;
        public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        public Rect CaretRect;
    }
    [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    public static long KeyboardFocus(IntPtr window) {
        uint process;
        uint thread = GetWindowThreadProcessId(window, out process);
        var info = new GuiThreadInfo { Size = (uint)Marshal.SizeOf(typeof(GuiThreadInfo)) };
        return thread != 0 && GetGUIThreadInfo(thread, ref info) ? info.Focus.ToInt64() : 0;
    }
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder text, uint length, out uint needed);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    public static string InputDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, 1);
        if (desktop == IntPtr.Zero) return "unavailable";
        try {
            uint needed;
            var name = new StringBuilder(256);
            return GetUserObjectInformation(desktop, 2, name, 512, out needed) ? name.ToString() : "unavailable";
        } finally { CloseDesktop(desktop); }
    }
    public static bool InteractiveAvailable() {
        if (InputDesktop() != "Default") return false;
        uint owner;
        GetWindowThreadProcessId(GetForegroundWindow(), out owner);
        try {
            using (var process = Process.GetProcessById((int)owner)) {
                return process.ProcessName != "LockApp" && process.ProcessName != "LogonUI";
            }
        } catch { return false; }
    }
    public static bool Activate(IntPtr window) {
        uint process;
        uint current = GetCurrentThreadId();
        uint foreground = GetWindowThreadProcessId(GetForegroundWindow(), out process);
        uint target = GetWindowThreadProcessId(window, out process);
        bool foregroundAttached = foreground != 0 && foreground != current && AttachThreadInput(current, foreground, true);
        bool targetAttached = target != 0 && target != current && target != foreground && AttachThreadInput(current, target, true);
        try {
            BringWindowToTop(window);
            SetWindowPos(window, IntPtr.Zero, 0, 0, 0, 0, 0x0003);
            SetForegroundWindow(window);
            return GetAncestor(GetForegroundWindow(), 2) == window;
        } finally {
            if (targetAttached) AttachThreadInput(current, target, false);
            if (foregroundAttached) AttachThreadInput(current, foreground, false);
        }
    }
    public static long Hit(IntPtr window, int x, int y) {
        IntPtr result;
        SendMessageTimeout(window, 0x0084, IntPtr.Zero, new IntPtr((y << 16) | (x & 0xffff)), 2, 2000, out result);
        return result.ToInt64();
    }
    public static uint? DwmAttribute(IntPtr window, int attribute) {
        try {
            uint value;
            return DwmGetWindowAttribute(window, attribute, out value, 4) >= 0 ? (uint?)value : null;
        } catch (DllNotFoundException) { return null; }
        catch (EntryPointNotFoundException) { return null; }
    }
    public static FramePixels CaptureFrame(IntPtr host, IntPtr browser, string screenshot) {
        Rect outer, content;
        if (!GetWindowRect(host, out outer) || !GetWindowRect(browser, out content)) throw new InvalidOperationException("Window disappeared during frame capture.");
        int width = outer.Right - outer.Left, height = outer.Bottom - outer.Top;
        var result = new FramePixels { foregroundRoot = GetAncestor(GetForegroundWindow(), 2).ToInt64(),
            dwmBorderColor = DwmAttribute(host, 34), dwmNcRendering = DwmAttribute(host, 1) };
        using (var bitmap = new System.Drawing.Bitmap(width, height)) {
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(outer.Left, outer.Top, 0, 0, bitmap.Size);
            }
            // Only inspect the exposed native resize ring, not light text in
            // the page. Skip rounded corners which can contain desktop pixels.
            int trim = Math.Min(24, Math.Min(width, height) / 4);
            int left = Math.Max(1, Math.Min(32, content.Left - outer.Left));
            int right = Math.Max(1, Math.Min(32, outer.Right - content.Right));
            int top = Math.Max(1, Math.Min(32, content.Top - outer.Top));
            int bottom = Math.Max(1, Math.Min(32, outer.Bottom - content.Bottom));
            for (int x = trim; x < width - trim; x++) {
                for (int y = 0; y < top; y++) CheckPixel(bitmap, x, y, result);
                for (int y = height - bottom; y < height; y++) CheckPixel(bitmap, x, y, result);
            }
            for (int y = trim; y < height - trim; y++) {
                for (int x = 0; x < left; x++) CheckPixel(bitmap, x, y, result);
                for (int x = width - right; x < width; x++) CheckPixel(bitmap, x, y, result);
            }
            if (!String.IsNullOrEmpty(screenshot)) bitmap.Save(screenshot, System.Drawing.Imaging.ImageFormat.Png);
        }
        return result;
    }
    public static Rect InjectBrowserSize(IntPtr host, IntPtr browser, int width, int height) {
        if (GetParent(browser) != host) throw new InvalidOperationException("Browser does not belong to the isolated host; no size was changed.");
        // Observe on the same native call stack, before PowerShell allocates or
        // resumes its pipeline. The product's asynchronous repair stays active.
        // A bounded retry handles a repair already in flight; only a genuinely
        // observed injected client size is accepted as drift evidence.
        Rect observed = new Rect();
        for (int attempt = 0; attempt < 8; attempt++) {
            if (!SetWindowPos(browser, IntPtr.Zero, 0, 0, width, height, 0x0014)) throw new InvalidOperationException("Browser size drift injection failed.");
            if (!GetClientRect(browser, out observed)) throw new InvalidOperationException("Could not inspect the injected native size.");
            if (observed.Right - observed.Left == width && observed.Bottom - observed.Top == height) return observed;
        }
        throw new InvalidOperationException("Injected native size was not observed: " + (observed.Right - observed.Left) + "x" + (observed.Bottom - observed.Top));
    }
    private static void CheckPixel(System.Drawing.Bitmap bitmap, int x, int y, FramePixels result) {
        var color = bitmap.GetPixel(x, y);
        result.checkedPixels++;
        if (color.R >= 210 && color.G >= 210 && color.B >= 210) result.brightPixels++;
    }
}
'@ -ReferencedAssemblies System.dll, System.Drawing.dll
$h = [IntPtr]::new($WindowHandle)
$b = [IntPtr]::new($BrowserWindowHandle)
$activated = $false
$pointerRoot = 0
$sentInput = $false
$focusCycles = @()
$injectedBrowserBounds = $null
$inputDesktop = [DesktopWindowProbe]::InputDesktop()
$interactive = [DesktopWindowProbe]::InteractiveAvailable()
if ($Action -eq 'restore') { [void][DesktopWindowProbe]::ShowWindow($h, 9) }
if ($Action -eq 'minimize-command') { [void][DesktopWindowProbe]::PostMessage($h, 0x0112, [IntPtr]::new(0xf020), [IntPtr]::Zero) }
if ($Action -in @('resize', 'resize-burst')) {
  if ($Action -eq 'resize-burst') {
    # No cursor/focus changes or emulated viewport: stress the actual HWND and
    # finish at the requested dimensions without sleeps between resize messages.
    $sizes = @(@(1600, 980), @(600, 600), @(1200, 840), @(480, 520), @(1450, 900))
    for ($cycle = 0; $cycle -lt 8; $cycle++) {
      foreach ($size in $sizes) {
        if (-not [DesktopWindowProbe]::SetWindowPos($h, [IntPtr]::Zero, 100, 80, $size[0], $size[1], 0x0014)) { throw 'Native resize burst failed.' }
      }
    }
  }
  if (-not [DesktopWindowProbe]::SetWindowPos($h, [IntPtr]::Zero, 100, 80, $Width, $Height, 0x0014)) { throw 'Native resize failed.' }
}
if ($Action -eq 'browser-size-drift') {
  # Simulate the embedded browser returning to monitor/fullscreen dimensions
  # without resizing its host. Do not inject a CDP viewport override: the host
  # must recover the real native child, not merely produce a wider screenshot.
  $injected = [DesktopWindowProbe]::InjectBrowserSize($h, $b, $Width, $Height)
  $injectedBrowserBounds = @{ width = $injected.Right - $injected.Left; height = $injected.Bottom - $injected.Top }
}
if ($Action -eq 'close-command') { [void][DesktopWindowProbe]::PostMessage($h, 0x0112, [IntPtr]::new(0xf060), [IntPtr]::Zero); return }
if ($Action -eq 'focus-cycle') {
  if (-not $interactive) { throw 'Interactive desktop is locked or inaccessible; no focus was changed.' }
  $foreground = [DesktopWindowProbe]::GetForegroundWindow()
  $target = New-Object Windows.Forms.Form
  try {
    $rect = New-Object DesktopWindowProbe+Rect
    [void][DesktopWindowProbe]::GetWindowRect($h, [ref]$rect)
    $target.ShowInTaskbar = $false
    $target.FormBorderStyle = [Windows.Forms.FormBorderStyle]::None
    $target.BackColor = [Drawing.Color]::FromArgb(26, 28, 34)
    $target.StartPosition = [Windows.Forms.FormStartPosition]::Manual
    $target.Size = New-Object Drawing.Size(160, 80)
    $target.Location = New-Object Drawing.Point(($rect.Left + 40), ($rect.Top + 100))
    for ($cycle = 0; $cycle -lt 3; $cycle++) {
      if (-not [DesktopWindowProbe]::Activate($h)) { throw 'SakuraCode could not become the foreground window.' }
      Start-Sleep -Milliseconds 200
      $active = [DesktopWindowProbe]::CaptureFrame($h, $b, $(if ($Screenshot) { $Screenshot + '-active.png' } else { '' }))
      if (-not $target.Visible) { $target.Show() }
      [Windows.Forms.Application]::DoEvents()
      if (-not [DesktopWindowProbe]::Activate($target.Handle)) { throw 'Focus target could not become the foreground window.' }
      Start-Sleep -Milliseconds 200
      $inactive = [DesktopWindowProbe]::CaptureFrame($h, $b, $(if ($Screenshot) { $Screenshot + '-inactive.png' } else { '' }))
      if (-not [DesktopWindowProbe]::Activate($h)) { throw 'SakuraCode could not regain foreground focus.' }
      Start-Sleep -Milliseconds 200
      $reactivated = [DesktopWindowProbe]::CaptureFrame($h, $b, $(if ($Screenshot) { $Screenshot + '-reactivated.png' } else { '' }))
      $focusCycles += @{ active = $active; inactive = $inactive; reactivated = $reactivated }
    }
  } finally {
    $target.Close()
    $target.Dispose()
    if ($foreground -ne $h -and $foreground -ne [IntPtr]::Zero) { [void][DesktopWindowProbe]::Activate($foreground) }
  }
}
if ($Action -in @('focus', 'drag', 'double-click', 'alt-f4')) {
  if (-not $interactive) { throw 'Interactive desktop is locked or inaccessible; no input was sent.' }
  $cursor = New-Object DesktopWindowProbe+Point
  [void][DesktopWindowProbe]::GetCursorPos([ref]$cursor)
  $foreground = [DesktopWindowProbe]::GetForegroundWindow()
  try {
    # A newly launched Chromium child can briefly reclaim the foreground.
    # Wait for a stable, real host focus before sending any physical input.
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      if (-not [DesktopWindowProbe]::InteractiveAvailable()) { throw 'Interactive desktop became inaccessible; no input was sent.' }
      $activated = [DesktopWindowProbe]::Activate($h)
      Start-Sleep -Milliseconds 150
      if ($activated -and [DesktopWindowProbe]::GetAncestor([DesktopWindowProbe]::GetForegroundWindow(), 2) -eq $h) { break }
      $activated = $false
    }
    if (-not $activated -or [DesktopWindowProbe]::GetAncestor([DesktopWindowProbe]::GetForegroundWindow(), 2) -ne $h) {
      throw 'SakuraCode could not become the foreground window; no input was sent.'
    }
    if ($Action -eq 'focus') {
      Start-Sleep -Milliseconds 200
    } elseif ($Action -eq 'alt-f4') {
      $sentInput = $true
      [DesktopWindowProbe]::keybd_event(0x12,0,0,[UIntPtr]::Zero)
      [DesktopWindowProbe]::keybd_event(0x73,0,0,[UIntPtr]::Zero)
      [DesktopWindowProbe]::keybd_event(0x73,0,2,[UIntPtr]::Zero)
      [DesktopWindowProbe]::keybd_event(0x12,0,2,[UIntPtr]::Zero)
    } else {
      [void][DesktopWindowProbe]::SetCursorPos($PointerX, $PointerY)
      $targetPoint = New-Object DesktopWindowProbe+Point
      $targetPoint.X = $PointerX
      $targetPoint.Y = $PointerY
      $pointerRoot = [DesktopWindowProbe]::GetAncestor([DesktopWindowProbe]::WindowFromPoint($targetPoint), 2).ToInt64()
      if ($pointerRoot -ne $WindowHandle) { throw 'Pointer target is not SakuraCode; no input was sent.' }
      $sentInput = $true
      if ($Action -eq 'drag') {
        [DesktopWindowProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        Start-Sleep -Milliseconds 300
        for ($step = 1; $step -le 6; $step++) {
          [void][DesktopWindowProbe]::SetCursorPos(($PointerX + 20 * $step), ($PointerY + 12 * $step))
          Start-Sleep -Milliseconds 40
        }
        [DesktopWindowProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
      } else {
        for ($click = 0; $click -lt 2; $click++) {
          [DesktopWindowProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
          Start-Sleep -Milliseconds 40
          [DesktopWindowProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
          Start-Sleep -Milliseconds 100
        }
      }
    }
    Start-Sleep -Milliseconds 250
  } finally {
    if ($sentInput) { [DesktopWindowProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
    [void][DesktopWindowProbe]::SetCursorPos($cursor.X, $cursor.Y)
    if ($Action -ne 'focus' -and $foreground -ne $h) { [void][DesktopWindowProbe]::SetForegroundWindow($foreground) }
  }
  if ($Action -eq 'alt-f4') { return }
}
Start-Sleep -Milliseconds 150
$outer = New-Object DesktopWindowProbe+Rect
$client = New-Object DesktopWindowProbe+Rect
$browser = New-Object DesktopWindowProbe+Rect
$browserClient = New-Object DesktopWindowProbe+Rect
$keyboardFocus = [DesktopWindowProbe]::KeyboardFocus($h)
[void][DesktopWindowProbe]::GetWindowRect($h, [ref]$outer)
[void][DesktopWindowProbe]::GetClientRect($h, [ref]$client)
[void][DesktopWindowProbe]::GetWindowRect($b, [ref]$browser)
[void][DesktopWindowProbe]::GetClientRect($b, [ref]$browserClient)
if ($Screenshot -and $Action -ne 'focus-cycle') {
  $bitmap = New-Object Drawing.Bitmap(($outer.Right - $outer.Left), ($outer.Bottom - $outer.Top))
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($outer.Left, $outer.Top, 0, 0, $bitmap.Size); $bitmap.Save($Screenshot) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
}
@{ parent = [DesktopWindowProbe]::GetParent($b).ToInt64(); style = [DesktopWindowProbe]::GetWindowLongPtr($h,-16).ToInt64();
  browserStyle = [DesktopWindowProbe]::GetWindowLongPtr($b,-16).ToInt64(); visible = [DesktopWindowProbe]::IsWindowVisible($h);
  activated = $activated; pointerRoot = $pointerRoot; foreground = [DesktopWindowProbe]::GetForegroundWindow().ToInt64();
  dwmBorderColor = [DesktopWindowProbe]::DwmAttribute($h, 34); dwmNcRendering = [DesktopWindowProbe]::DwmAttribute($h, 1);
  focusCycles = $focusCycles;
  injectedBrowserBounds = $injectedBrowserBounds;
  inputDesktop = $inputDesktop;
  keyboardFocus = $keyboardFocus;
  keyboardFocusInBrowser = $keyboardFocus -eq $BrowserWindowHandle -or [DesktopWindowProbe]::IsChild($b, [IntPtr]::new($keyboardFocus));
  interactive = $interactive;
  minimized = [DesktopWindowProbe]::IsIconic($h); maximized = [DesktopWindowProbe]::IsZoomed($h);
  x = $outer.Left; y = $outer.Top; width = $outer.Right - $outer.Left; height = $outer.Bottom - $outer.Top;
  browserX = $browser.Left; browserY = $browser.Top;
  clientWidth = $client.Right; clientHeight = $client.Bottom; browserWidth = $browserClient.Right; browserHeight = $browserClient.Bottom;
  leftHit = [DesktopWindowProbe]::Hit($h, $outer.Left + 1, $outer.Top + 200);
  rightHit = [DesktopWindowProbe]::Hit($h, $outer.Right - 1, $outer.Top + 200);
  topLeftHit = [DesktopWindowProbe]::Hit($h, $outer.Left + 1, $outer.Top + 1);
  bottomRightHit = [DesktopWindowProbe]::Hit($h, $outer.Right - 1, $outer.Bottom - 1)
} | ConvertTo-Json -Depth 5 -Compress