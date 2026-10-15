# export.ps1 — freeze the Aetheria stack and build a transfer archive for the Debian server.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File <repo>\aetheria\migrate\export.ps1
#     -OutFile <path>   custom archive path (default: <repo>\aetheria\migrate\out\aetheria-transfer.tar.gz)
#     -WithLogs         also pack bot run logs (run-*.jsonl — GBs; default excluded, the server starts fresh)
#     -SkipStop         do not stop the local stack first (dry runs only)
#
# What it does: stops CC + all runners + tor (bot run-intent wantRun=true stays persisted in store.json,
# so the fleet auto-starts on the server), then packs the whole aetheria/ folder minus node_modules,
# old release builds, *.log and run logs into aetheria-transfer.tar.gz for `scp` + migrate/deploy.sh.
param(
  [string]$OutFile = '',
  [switch]$WithLogs,
  [switch]$SkipStop
)
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path $here -Parent
if (-not $OutFile) {
  $outDir = Join-Path $here 'out'
  New-Item -ItemType Directory -Force $outDir | Out-Null
  $OutFile = Join-Path $outDir 'aetheria-transfer.tar.gz'
}
Write-Host '== Aetheria export ======================================' -ForegroundColor Cyan
Write-Host ('root:  ' + $root)
Write-Host ('out:   ' + $OutFile)

if (-not $SkipStop) {
  Write-Host '-- stopping command center, runners, tor (run intent stays in store.json)'
  try {
    $listener = Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue; Write-Host ('   CC stopped (pid ' + $listener.OwningProcess + ')') }
  } catch {}
  Start-Sleep -Seconds 1
  $runners = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'runner' })
  foreach ($p in $runners) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ('   runners stopped: ' + $runners.Count)
  $tors = @(Get-CimInstance Win32_Process -Filter "Name='tor.exe'")
  foreach ($p in $tors) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host ('   tor stopped: ' + $tors.Count)
  Start-Sleep -Seconds 2
}

$stage = Join-Path $env:TEMP ('aetheria-stage-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
$xd = @('node_modules', 'release', '.git', (Join-Path $here 'out'))
$xf = @('*.log')
if (-not $WithLogs) { $xf += 'run-*.jsonl' }
Write-Host ('-- staging to ' + $stage)
Write-Host ('   excluding: node_modules, release, *.log' + $(if (-not $WithLogs) { ', run-*.jsonl' }))
& robocopy $root $stage /E /NFL /NDL /NJH /NJS /NP /XD @xd /XF @xf | Out-Null
if ($LASTEXITCODE -ge 8) { throw ('robocopy failed (exit ' + $LASTEXITCODE + ')') }

if (Test-Path $OutFile) { Remove-Item $OutFile -Force }
Write-Host '-- packing (bsdtar)'
& tar -czf $OutFile -C $stage .
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Remove-Item $stage -Recurse -Force
$mb = [Math]::Round((Get-Item $OutFile).Length / 1MB, 1)
Write-Host ('== done: ' + $OutFile + ' (' + $mb + ' MB) ==') -ForegroundColor Green
Write-Host ''
Write-Host 'NEXT — copy to the server and deploy:'
Write-Host ('  scp "' + $OutFile + '" aetheria@<SERVER-IP>:~/')
Write-Host '  ssh aetheria@<SERVER-IP>'
Write-Host '  mkdir -p /tmp/aetheria-init && tar -xzf ~/aetheria-transfer.tar.gz -C /tmp/aetheria-init'
Write-Host '  sudo bash /tmp/aetheria-init/migrate/deploy.sh ~/aetheria-transfer.tar.gz --bootstrap'
