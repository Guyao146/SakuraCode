param([Parameter(Mandatory=$true)][string]$Exe, [Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing, System.Windows.Forms
$target = [IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($target) | Out-Null
$report = Join-Path $target 'native-startup-paint.json'
if (Test-Path -LiteralPath $report) { throw 'Native startup paint evidence already exists; use a fresh directory.' }
$assembly = [Reflection.Assembly]::LoadFile([IO.Path]::GetFullPath($Exe))
$flags = [Reflection.BindingFlags]'Instance,Public,NonPublic'
$optionsType = $assembly.GetType('SakuraCode.Desktop.Options', $true)
$windowType = $assembly.GetType('SakuraCode.Desktop.DesktopWindow', $true)
$options = [Activator]::CreateInstance($optionsType, $true)
# A real compiled Form, never Shown: no engine/browser, consent page, taskbar
# activation or physical input. Only this isolated directory is read for settings.
$optionsType.GetField('DataDir', $flags).SetValue($options, $target)
$optionsType.GetField('Workspace', $flags).SetValue($options, $target)
$window = [Activator]::CreateInstance($windowType, [object[]]@($options, [uint32]0))
$window.ClientSize = New-Object Drawing.Size(1200, 900)
$clock = $windowType.GetField('startupClock', $flags).GetValue($window)
$paint = $windowType.GetMethod('OnPaint', $flags)
$motion = $windowType.GetField('startupMotion', $flags)
$showing = $windowType.GetField('showingStartup', $flags)
function Paint-Frame([string]$Name) {
    $file = Join-Path $target ($Name + '.png')
    if (Test-Path -LiteralPath $file) { throw 'Native paint frame exists: ' + $file }
    $bitmap = New-Object Drawing.Bitmap(1200, 900)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $background = [Drawing.Color]::FromArgb(26, 28, 34)
    try {
        $graphics.Clear($background)
        $event = New-Object Windows.Forms.PaintEventArgs($graphics, (New-Object Drawing.Rectangle(0, 0, 1200, 900)))
        try { $paint.Invoke($window, [object[]]@($event.PSObject.BaseObject)) | Out-Null }
        finally { $event.Dispose() }
        # Sample at the same DPI-independent petal/mark coordinates as the code.
        $scale = $window.DeviceDpi / 96.0
        $petal = $bitmap.GetPixel(600, [int](450 - 26 * $scale - 50 * $scale))
        # Hash the brand region separately so progress-bar motion alone cannot
        # satisfy the animated flower/petals check.
        $brandBounds = New-Object Drawing.Rectangle([int](600 - 72 * $scale), [int](450 - 138 * $scale), [int](144 * $scale), [int](144 * $scale))
        $brand = $bitmap.Clone($brandBounds, $bitmap.PixelFormat)
        $stream = New-Object IO.MemoryStream
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $brand.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
            $brandHash = [BitConverter]::ToString($sha.ComputeHash($stream.ToArray())).Replace('-', '').ToLowerInvariant()
        } finally { $sha.Dispose(); $stream.Dispose(); $brand.Dispose() }
        $bitmap.Save($file, [Drawing.Imaging.ImageFormat]::Png)
        return @{ name = $Name; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();
            brandSha256 = $brandHash; petalPainted = $petal.ToArgb() -ne $background.ToArgb(); dpi = $window.DeviceDpi }
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
    $showing.SetValue($window, $true)
    $motion.SetValue($window, $false)
    $clock.Restart()
    $staticFirst = Paint-Frame 'native-startup-static-first'
    Start-Sleep -Milliseconds 180
    $staticSecond = Paint-Frame 'native-startup-static-second'
    if (-not $staticFirst.petalPainted -or $staticFirst.sha256 -ne $staticSecond.sha256) { throw 'Reduced-motion startup must paint the brand without animating.' }
    $motion.SetValue($window, $true)
    $clock.Restart()
    $movingFirst = Paint-Frame 'native-startup-moving-first'
    Start-Sleep -Milliseconds 240
    $movingSecond = Paint-Frame 'native-startup-moving-second'
    if ($movingFirst.sha256 -eq $movingSecond.sha256 -or $movingFirst.brandSha256 -eq $movingSecond.brandSha256) { throw 'Enabled startup animation must animate the flower/petals as well as progress, not the readiness state.' }
    $showing.SetValue($window, $false)
    $finished = Paint-Frame 'native-startup-handed-over'
    if ($finished.petalPainted) { throw 'Native startup paint must stop after handover to the Web loading surface.' }
    $native = $assembly.GetType('SakuraCode.Desktop.Native', $true)
    $enabled = $native.GetMethod('ClientAnimationsEnabled', [Reflection.BindingFlags]'Static,Public,NonPublic').Invoke($null, [object[]]@())
    @{ passed = $true; compiledLauncher = [IO.Path]::GetFullPath($Exe); renderOnly = $true; noPhysicalInput = $true;
        noEngineOrBrowserStarted = $true; systemAnimationSettingReadOnly = $true; currentSystemMotion = [bool]$enabled;
        staticFirst = $staticFirst; staticSecond = $staticSecond; movingFirst = $movingFirst; movingSecond = $movingSecond; finished = $finished
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $report -Encoding UTF8
    Write-Output 'Compiled native startup flower/petals, static reduced motion, animated progress and handover paint PASS (render-only; no engine/browser/input)'
} finally { $window.Dispose() }