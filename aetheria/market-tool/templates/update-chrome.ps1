# Aetheria Market+ -- Chrome extension updater (run UPDATE-CHROME.cmd)
# Downloads the latest extension zip and replaces the files in the extension folder.
# Place this script (and UPDATE-CHROME.cmd) next to the extension folder, then
# double-click UPDATE-CHROME.cmd. After updating, click the reload button on
# chrome://extensions (or restart Chrome).
param(
  [string]$ExtensionDir = '',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ZipUrl     = '__ZIP_URL__'
$VersionUrl = '__VERSION_URL__'
$BuildStamp = '__VERSION__'

Write-Host ''
Write-Host '=== Aetheria Market+ - Chrome updater ===' -ForegroundColor Yellow

if (-not $ExtensionDir) {
  $cands = @(
    (Join-Path $PSScriptRoot 'chrome'),
    (Join-Path $PSScriptRoot 'aetheria-market-plus-chrome')
  )
  foreach ($d in $cands) { if (Test-Path (Join-Path $d 'manifest.json')) { $ExtensionDir = $d; break } }
}
if (-not $ExtensionDir) {
  Get-ChildItem $PSScriptRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if (-not $ExtensionDir -and (Test-Path (Join-Path $_.FullName 'manifest.json'))) { $ExtensionDir = $_.FullName }
  }
}
if (-not $ExtensionDir -or -not (Test-Path (Join-Path $ExtensionDir 'manifest.json'))) {
  Write-Host 'ไม่พบโฟลเดอร์ส่วนขยาย (ต้องมี manifest.json อยู่ข้างใน)' -ForegroundColor Red
  Write-Host 'วิธีใช้: วางสคริปต์นี้ไว้ข้างๆ โฟลเดอร์ส่วนขยาย แล้วดับเบิลคลิกใหม่'
  Write-Host 'หรือระบุเอง: powershell -File UPDATE-CHROME.ps1 -ExtensionDir "C:\path\to\chrome"'
  exit 1
}
if ($ZipUrl -like 'TODO*') {
  Write-Host 'ยังไม่ได้ตั้งค่า URL ของไฟล์อัปเดต — กรุณาติดต่อผู้ดูแล (deploy.config.json)' -ForegroundColor Red
  exit 1
}

$local = (Get-Content (Join-Path $ExtensionDir 'manifest.json') -Raw | ConvertFrom-Json).version
Write-Host "โฟลเดอร์:        $ExtensionDir"
Write-Host "เวอร์ชันติดตั้ง: $local"

$remote = ''
if ($VersionUrl -and $VersionUrl -notlike 'TODO*') {
  try { $remote = (Invoke-WebRequest $VersionUrl -UseBasicParsing -TimeoutSec 15).Content.Trim() } catch { Write-Host 'ตรวจเวอร์ชันล่าสุดไม่ได้ - จะลองอัปเดตให้อยู่ดี' -ForegroundColor DarkYellow }
}
if ($remote) { Write-Host "เวอร์ชันล่าสุด:   $remote" }
if ($remote -and $remote -eq $local -and -not $Force) {
  Write-Host 'เป็นเวอร์ชันล่าสุดอยู่แล้ว ไม่ต้องอัปเดต' -ForegroundColor Green
  exit 0
}

$tmpZip = Join-Path $env:TEMP ('amkt-' + [guid]::NewGuid() + '.zip')
$tmpDir = Join-Path $env:TEMP ('amkt-' + [guid]::NewGuid())
try {
  Write-Host 'กำลังดาวน์โหลด...'
  Invoke-WebRequest $ZipUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
  if (-not (Test-Path (Join-Path $tmpDir 'manifest.json'))) { throw 'ไฟล์ zip ไม่ถูกต้อง (ไม่พบ manifest.json)' }
  Copy-Item (Join-Path $tmpDir '*') $ExtensionDir -Recurse -Force
  $new = (Get-Content (Join-Path $ExtensionDir 'manifest.json') -Raw | ConvertFrom-Json).version
  Write-Host ("อัปเดตสำเร็จ: {0} -> {1}" -f $local, $new) -ForegroundColor Green
  Write-Host ''
  Write-Host 'ขั้นตอนสุดท้าย: เปิด chrome://extensions แล้วกดปุ่มรีโหลด (วงกลมลูกศร) ที่ Aetheria Market+ จากนั้นรีเฟรชหน้าเกม' -ForegroundColor Yellow
} finally {
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
