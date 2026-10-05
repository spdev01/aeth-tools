# Aetheria Command Center -- updater (run UPDATE-CC.cmd)
# Downloads the latest release zip and replaces the app files in this folder.
# Your data folder (data\) is never touched. Restart the server afterwards.
param(
  [string]$AppDir = $PSScriptRoot,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$ZipUrl     = '__ZIP_URL__'
$VersionUrl = '__VERSION_URL__'
$BuildStamp = '__VERSION__'

Write-Host ''
Write-Host '=== Aetheria Command Center - updater ===' -ForegroundColor Yellow

if ($ZipUrl -like 'TODO*') {
  Write-Host 'ยังไม่ได้ตั้งค่า URL ของไฟล์อัปเดต — กรุณาติดต่อผู้ดูแล' -ForegroundColor Red
  exit 1
}
if (-not (Test-Path (Join-Path $AppDir 'package.json'))) {
  Write-Host "ไม่พบ package.json ใน: $AppDir" -ForegroundColor Red
  Write-Host 'วิธีใช้: วางสคริปต์นี้ไว้ในโฟลเดอร์โปรแกรม แล้วดับเบิลคลิกใหม่'
  exit 1
}

$local = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "โฟลเดอร์:        $AppDir"
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

$tmpZip = Join-Path $env:TEMP ('cc-' + [guid]::NewGuid() + '.zip')
$tmpDir = Join-Path $env:TEMP ('cc-' + [guid]::NewGuid())
try {
  Write-Host 'กำลังดาวน์โหลด...'
  Invoke-WebRequest $ZipUrl -OutFile $tmpZip -UseBasicParsing -TimeoutSec 120
  Expand-Archive -Path $tmpZip -DestinationPath $tmpDir -Force
  if (-not (Test-Path (Join-Path $tmpDir 'package.json'))) { throw 'ไฟล์ zip ไม่ถูกต้อง (ไม่พบ package.json)' }
  Copy-Item (Join-Path $tmpDir '*') $AppDir -Recurse -Force
  $new = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
  Write-Host ("อัปเดตสำเร็จ: {0} -> {1}" -f $local, $new) -ForegroundColor Green
  Write-Host ''
  Write-Host 'ขั้นตอนสุดท้าย:' -ForegroundColor Yellow
  Write-Host '  1) ปิดเซิร์ฟเวอร์เก่า (กด Ctrl+C ในหน้าต่างที่รันอยู่)'
  Write-Host '  2) เปิด terminal ในโฟลเดอร์นี้ แล้วรัน:  npm install'
  Write-Host '  3) แล้วรัน:  npm start   (เปิด http://127.0.0.1:4310 ตามเดิม — ข้อมูลใน data\ ยังอยู่ครบ)'
} finally {
  Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}
