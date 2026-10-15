$ErrorActionPreference = 'Stop'
$dir = 'E:\GitHub\lumivaraonline\aetheria\command-center\data\bots\213'
$cut = '2026-10-10T03:30'   # UTC; local = UTC+7 -> local 10:30 (last ~4h)

$files = @(
  (Join-Path $dir 'run-2026-10-10T03-28-16-641Z.jsonl'),
  (Join-Path $dir 'run-2026-10-10T04-58-28-912Z.jsonl')
)

$evtCount = @{}
$heartbeats = New-Object System.Collections.Generic.List[object]
$miscZeny = New-Object System.Collections.Generic.List[string]
$killHour = @{}

foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Host ('missing: ' + $f); continue }
  Write-Host ('reading ' + (Split-Path $f -Leaf) + ' ...')
  foreach ($line in [IO.File]::ReadLines($f)) {
    if ($line.Length -eq 0) { continue }
    if ($line.Contains('}{')) { $pieces = [regex]::Split($line, '\}\{') } else { $pieces = @($line) }
    foreach ($p in $pieces) {
      $mt = [regex]::Match($p, '"t":"([^"]+)"')
      if (-not $mt.Success) { continue }
      $ts = $mt.Groups[1].Value
      if ([string]::CompareOrdinal($ts, $cut) -lt 0) { continue }
      $me = [regex]::Match($p, '"evt":"([^"]+)"')
      if (-not $me.Success) { continue }
      $evt = $me.Groups[1].Value
      if ($evtCount.ContainsKey($evt)) { $evtCount[$evt] = $evtCount[$evt] + 1 } else { $evtCount[$evt] = 1 }
      if ($evt -eq 'HEARTBEAT') {
        $mz = [regex]::Match($p, '"zeny":(\d+)')
        if ($mz.Success) {
          $dt = [datetime]::Parse($ts, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AdjustToUniversal -bor [System.Globalization.DateTimeStyles]::AssumeUniversal)
          $heartbeats.Add([pscustomobject]@{ t = $ts; dt = $dt; zeny = [int64]$mz.Groups[1].Value }) | Out-Null
        }
      } else {
        if ($p.Contains('"zeny"')) { $miscZeny.Add($ts + '  ' + $p) | Out-Null }
        if ($evt -eq 'kill') {
          $h = $ts.Substring(11,2)
          if ($killHour.ContainsKey($h)) { $killHour[$h] = $killHour[$h] + 1 } else { $killHour[$h] = 1 }
        }
      }
    }
  }
}

Write-Host ''
Write-Host '=== event counts in window ==='
$evtCount.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 40 | ForEach-Object { Write-Host ('{0,8}  {1}' -f $_.Value, $_.Name) }

$killsTotal = 0
foreach ($k in $killHour.Values) { $killsTotal = $killsTotal + $k }

Write-Host ''
Write-Host ('=== heartbeats: ' + $heartbeats.Count + '   kills in window: ' + $killsTotal + ' ===')
if ($heartbeats.Count -gt 1) {
  $first = $heartbeats[0]; $last = $heartbeats[$heartbeats.Count-1]
  $spanMin = ($last.dt - $first.dt).TotalMinutes
  $delta = $last.zeny - $first.zeny
  Write-Host ('window start: ' + $first.t + '  zeny = ' + $first.zeny.ToString('N0'))
  Write-Host ('window end  : ' + $last.t + '  zeny = ' + $last.zeny.ToString('N0'))
  Write-Host ('NET DELTA   : ' + $delta.ToString('N0') + '   over ' + [Math]::Round($spanMin,1) + ' min')
  if ($spanMin -ge 1) {
    $rate = [int64](($delta / $spanMin) * 60)
    Write-Host ('AVG RATE    : ' + $rate.ToString('N0') + ' zeny/hour (avg heartbeat interval ' + [Math]::Round(($spanMin*60)/($heartbeats.Count-1),1) + 's)')
  }
}

Write-Host ''
Write-Host '=== per-hour delta (UTC hour; local = +7) ==='
$hours = @('03','04','05','06','07')
foreach ($h in $hours) {
  $list = @($heartbeats | Where-Object { $_.t.Substring(11,2) -eq $h })
  $kc = 0; if ($killHour.ContainsKey($h)) { $kc = $killHour[$h] }
  if ($list.Count -ge 2) {
    $hf = $list[0]; $hl = $list[$list.Count-1]
    $d = $hl.zeny - $hf.zeny
    $sm = ($hl.dt - $hf.dt).TotalMinutes
    $rate = 0; if ($sm -ge 1) { $rate = [int64](($d / $sm) * 60) }
    $lbl = ([int]$h + 7).ToString('00')
    Write-Host ('  ' + $h + ':00Z (local ' + $lbl + ':00)  delta=' + $d.ToString('N0') + '  rate=' + $rate.ToString('N0') + '/h  kills=' + $kc + '  (' + $list.Count + ' hb, ' + [Math]::Round($sm,0) + ' min)')
  } else {
    Write-Host ('  ' + $h + ':00Z  heartbeats=' + $list.Count + '  kills=' + $kc)
  }
}

Write-Host ''
Write-Host '=== biggest per-heartbeat jumps (top 8) and drops (top 8) ==='
$steps = New-Object System.Collections.Generic.List[object]
for ($i = 1; $i -lt $heartbeats.Count; $i++) {
  $d = $heartbeats[$i].zeny - $heartbeats[$i-1].zeny
  if ($d -ne 0) { $steps.Add([pscustomobject]@{ t = $heartbeats[$i].t; d = $d }) | Out-Null }
}
Write-Host '-- increases --'
$steps | Sort-Object d -Descending | Select-Object -First 8 | ForEach-Object { Write-Host ('  ' + $_.t + '  +' + $_.d.ToString('N0')) }
Write-Host '-- decreases --'
$steps | Sort-Object d | Select-Object -First 8 | ForEach-Object { Write-Host ('  ' + $_.t + '  ' + $_.d.ToString('N0')) }

Write-Host ''
Write-Host ('=== non-heartbeat lines containing zeny: ' + $miscZeny.Count + ' ===')
$n = 0
foreach ($l in $miscZeny) { if ($n -ge 12) { break }; Write-Host $l; $n++ }

Write-Host ''
Write-Host '=== status.json ==='
Get-Content (Join-Path $dir 'status.json') -Raw
Write-Host '=== session.json ==='
Get-Content (Join-Path $dir 'session.json') -Raw
