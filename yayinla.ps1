# Yeni sürüm yayınlar: sürümü artırır, kurulum dosyasını üretir, GitHub Release oluşturur.
# Kullanım:  powershell -ExecutionPolicy Bypass -File yayinla.ps1 -Surum 1.0.2 -Notlar "Neler değişti"
# Kurulu Techin Browser'lar bu sürümü 6 saat içinde (veya açılışta) görür ve "Güncelleme var" der.
param(
  [Parameter(Mandatory = $true)][string]$Surum,
  [string]$Notlar = ""
)
$ErrorActionPreference = "Stop"
$env:Path = "T:\Tools\node;T:\Tools\gh\bin;" + $env:Path
$env:npm_config_cache = "T:\Tools\cache\npm"
$env:ELECTRON_BUILDER_CACHE = "T:\Tools\cache\electron-builder"
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Set-Location $PSScriptRoot

if ($Surum -notmatch '^\d+\.\d+\.\d+$') { throw "Sürüm 1.2.3 biçiminde olmalı" }
npm version $Surum --no-git-tag-version --allow-same-version | Out-Null
npm test
if ($LASTEXITCODE -ne 0) { throw "Birim testleri başarısız" }
npx electron-builder --win nsis --publish never
if ($LASTEXITCODE -ne 0) { throw "Paketleme başarısız" }

$exe = "dist\Techin-Browser-Setup-$Surum.exe"
$files = @($exe, "$exe.blockmap", "dist\latest.yml")
foreach ($f in $files) { if (-not (Test-Path $f)) { throw "Eksik dosya: $f" } }
if (-not $Notlar) { $Notlar = "Techin Browser $Surum" }
git add -A
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) { git commit -q -m "Techin Browser $Surum" }
git push -q origin main
gh release create "v$Surum" @files --repo Tekinsv/techin-browser --title "Techin Browser $Surum" --notes $Notlar
Write-Host "Yayınlandı: v$Surum"
