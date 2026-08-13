# Turn the raw dashboard screenshots in ref/ into the ones the app ships.
#
#   powershell -ExecutionPolicy Bypass -File scripts/redact-setup-shots.ps1
#
# Two jobs, in this order and not the other:
#
#   1. Destroy the secrets. The project ID and the anon key are averaged away
#      block by block, at full resolution, in the pixel data itself. Not a black
#      rectangle drawn on top and not a CSS blur — both of those ship the
#      original underneath for anyone who opens the file. After this runs the
#      characters are gone and no amount of extraction brings them back.
#
#   2. Downscale. The originals are up to 1812px wide and the app draws them at
#      roughly a third of that, so the rest is bytes in the PWA precache buying
#      nothing.
#
# ref/ is gitignored; public/setup/ is committed. That split is deliberate — the
# originals with the real ID never enter git, and only the redacted copies do.
#
# Re-run this whenever Supabase redesigns and the screenshots are retaken. Check
# the REDACTIONS below still cover the right boxes if the layout moved.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'ref'
$dest = Join-Path $root 'public\setup'

if (-not (Test-Path $dest)) { New-Item -ItemType Directory -Force -Path $dest | Out-Null }

# Rectangles are in the ORIGINAL pixel space of each file. x, y, width, height.
$REDACTIONS = @{
  # Nothing sensitive: an empty new-project form.
  '1.png' = @()
  # Nothing sensitive: toggles only.
  '2.png' = @()
  # Project ID — "Reference used in APIs and URLs", i.e. the subdomain of their
  # database. The one string on this page that identifies the project.
  '3.png' = @(, @(1064, 354, 306, 36))
  # The anon key. Only its first ~80 characters are on screen, but the JWT
  # payload segment starts inside them and carries the same project ref.
  '4.png' = @(, @(856, 240, 790, 32))
}

# Wider than the app ever draws these, so a high-DPI phone still gets a sharp
# image, and far below the original.
$MAX_WIDTH = 900
# Comfortably larger than the ~14px glyphs being destroyed.
$BLOCK = 16

function Invoke-Pixelate {
  param([System.Drawing.Bitmap]$Bitmap, [int[]]$Rect)

  $x0 = $Rect[0]; $y0 = $Rect[1]; $w = $Rect[2]; $h = $Rect[3]
  $x1 = [Math]::Min($x0 + $w, $Bitmap.Width)
  $y1 = [Math]::Min($y0 + $h, $Bitmap.Height)

  for ($by = $y0; $by -lt $y1; $by += $BLOCK) {
    for ($bx = $x0; $bx -lt $x1; $bx += $BLOCK) {
      $ex = [Math]::Min($bx + $BLOCK, $x1)
      $ey = [Math]::Min($by + $BLOCK, $y1)

      $r = 0; $g = 0; $b = 0; $n = 0
      for ($y = $by; $y -lt $ey; $y++) {
        for ($x = $bx; $x -lt $ex; $x++) {
          $p = $Bitmap.GetPixel($x, $y)
          $r += $p.R; $g += $p.G; $b += $p.B; $n++
        }
      }
      if ($n -eq 0) { continue }

      # One flat colour per block. Every glyph inside it is now the same
      # average as its background — there is no residue to sharpen back.
      $avg = [System.Drawing.Color]::FromArgb([int]($r / $n), [int]($g / $n), [int]($b / $n))
      for ($y = $by; $y -lt $ey; $y++) {
        for ($x = $bx; $x -lt $ex; $x++) { $Bitmap.SetPixel($x, $y, $avg) }
      }
    }
  }
}

foreach ($name in ($REDACTIONS.Keys | Sort-Object)) {
  $inPath = Join-Path $src $name
  if (-not (Test-Path $inPath)) {
    Write-Output "skip $name (not in ref/)"
    continue
  }

  # Loaded through a copy so the file handle is released immediately and the
  # bitmap is a plain 32bpp surface GetPixel/SetPixel can work on.
  $loaded = [System.Drawing.Image]::FromFile($inPath)
  $bmp = New-Object System.Drawing.Bitmap $loaded.Width, $loaded.Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.DrawImage($loaded, 0, 0, $loaded.Width, $loaded.Height)
  $g.Dispose()
  $loaded.Dispose()

  foreach ($rect in $REDACTIONS[$name]) { Invoke-Pixelate -Bitmap $bmp -Rect $rect }

  # Scale after redacting, never before: destroying the characters at full
  # resolution is what makes them unrecoverable.
  $scale = [Math]::Min(1.0, $MAX_WIDTH / $bmp.Width)
  $outW = [int][Math]::Round($bmp.Width * $scale)
  $outH = [int][Math]::Round($bmp.Height * $scale)

  $out = New-Object System.Drawing.Bitmap $outW, $outH
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $outW, $outH)
  $g2.Dispose()

  $outPath = Join-Path $dest $name
  $out.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  $bmp.Dispose()

  $kb = [int]((Get-Item $outPath).Length / 1KB)
  Write-Output ("{0} -> public/setup/{0}  {1}x{2}  {3} KB  ({4} redacted)" -f $name, $outW, $outH, $kb, $REDACTIONS[$name].Count)
}
