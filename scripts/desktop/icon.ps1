param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$images = @()
foreach ($size in @(16, 32, 48, 256)) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $stream = New-Object System.IO.MemoryStream
  $background = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 24, 22, 31))
  $petal = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 239, 154, 171))
  $center = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 125, 88, 210))
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform(($size / 256.0), ($size / 256.0))
    $graphics.FillEllipse($background, 0, 0, 256, 256)
    foreach ($angle in @(0, 72, 144, 216, 288)) {
      $state = $graphics.Save()
      $graphics.TranslateTransform(128, 128)
      $graphics.RotateTransform($angle)
      $graphics.FillEllipse($petal, -32, -91, 64, 103)
      $graphics.Restore($state)
    }
    $graphics.FillEllipse($center, 110, 110, 36, 36)
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += ,@{Size=$size; Bytes=$stream.ToArray()}
  } finally {
    $graphics.Dispose(); $bitmap.Dispose(); $stream.Dispose()
    $background.Dispose(); $petal.Dispose(); $center.Dispose()
  }
}
$file = [System.IO.File]::Create($OutputPath)
$writer = New-Object System.IO.BinaryWriter($file)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($image in $images) {
    $dimension = if ($image.Size -eq 256) { 0 } else { $image.Size }
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
    $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32)
    $writer.Write([uint32]$image.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $image.Bytes.Length
  }
  foreach ($image in $images) { $writer.Write([byte[]]$image.Bytes) }
} finally { $writer.Dispose(); $file.Dispose() }