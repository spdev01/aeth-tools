$ErrorActionPreference = 'Stop'
$dir = 'E:\GitHub\lumivaraonline\aetheria\command-center\data\bots\213'

$recent = @('run-2026-10-10T03-28-16-641Z.jsonl','run-2026-10-10T04-58-28-912Z.jsonl')
$skim = @('skill_fx_self','kill','drop','mob_hit_seen')

Write-Host '######## A) sale-trip context (06:23-06:29Z and 07:04-07:10Z, non-spam events) ########'
foreach ($fn in $recent) {
  $f = Join-Path $dir $fn
  foreach ($line in [IO.File]::ReadLines($f)) {
    $mt = [regex]::Match($line, '"t":"([^"]+)"')
    if (-not $mt.Success) { continue }
    $ts = $mt.Groups[1].Value
    $inA = ([string]::CompareOrdinal($ts,'2026-10-10T06:23:00') -ge 0 -and [string]::CompareOrdinal($ts,'2026-10-10T06:29:00') -lt 0)
    $inB = ([string]::CompareOrdinal($ts,'2026-10-10T07:04:00') -ge 0 -and [string]::CompareOrdinal($ts,'2026-10-10T07:10:00') -lt 0)
    if (-not ($inA -or $inB)) { continue }
    $me = [regex]::Match($line, '"evt":"([^"]+)"')
    if (-not $me.Success) { continue }
    $evt = $me.Groups[1].Value
    if ($evt -eq 'HEARTBEAT') {
      $mz = [regex]::Match($line,'"zeny":(\d+)'); $mb = [regex]::Match($line,'"used":(\d+)'); $ms = [regex]::Match($line,'"step":"([^"]+)"')
      Write-Host ('  ' + $ts + '  HB  zeny=' + $mz.Groups[1].Value + ' bagUsed=' + $mb.Groups[1].Value + ' step=' + $ms.Groups[1].Value)
      continue
    }
    if ($skim -contains $evt) { continue }
    $sh = $line
    if ($sh.Length -gt 700) { $sh = $sh.Substring(0,700) + ' ...TRUNC' }
    Write-Host ('  ' + $ts + '  ' + $sh)
  }
}

Write-Host ''
Write-Host '######## B) window: per-15min bucket first/last heartbeat (zeny + bag used) ########'
$buckets = @{}
foreach ($fn in $recent) {
  $f = Join-Path $dir $fn
  foreach ($line in [IO.File]::ReadLines($f)) {
    if (-not $line.Contains('"HEARTBEAT"')) { continue }
    $mt = [regex]::Match($line, '"t":"([^"]+)"')
    if (-not $mt.Success) { continue }
    $ts = $mt.Groups[1].Value
    if ([string]::CompareOrdinal($ts,'2026-10-10T03:30') -lt 0) { continue }
    $mz = [regex]::Match($line,'"zeny":(\d+)'); $mb = [regex]::Match($line,'"used":(\d+)')
    if (-not ($mz.Success -and $mb.Success)) { continue }
    $min = [int]$ts.Substring(14,2)
    $bkt = $ts.Substring(11,2) + ':' + (([Math]::Floor($min/15))*15).ToString('00')
    if (-not $buckets.ContainsKey($bkt)) { $buckets[$bkt] = New-Object System.Collections.Generic.List[object] }
    $buckets[$bkt].Add([pscustomobject]@{ ts=$ts; zeny=[int64]$mz.Groups[1].Value; used=[int]$mb.Groups[1].Value }) | Out-Null
  }
}
foreach ($k in ($buckets.Keys | Sort-Object)) {
  $l = $buckets[$k]; $f0 = $l[0]; $f1 = $l[$l.Count-1]
  Write-Host ('  [' + $k + 'Z]  n=' + $l.Count + '  first ' + $f0.ts + ' zeny=' + $f0.zeny.ToString('N0') + ' used=' + $f0.used + '   last ' + $f1.ts + ' zeny=' + $f1.zeny.ToString('N0') + ' used=' + $f1.used + '   delta=' + ($f1.zeny-$f0.zeny).ToString('N0'))
}

Write-Host ''
Write-Host '######## C) overnight + morning files: hour summary + money-related events ########'
$more = @('run-2026-10-09T16-37-59-055Z.jsonl','run-2026-10-10T03-09-14-339Z.jsonl','run-2026-10-10T03-09-45-203Z.jsonl','run-2026-10-10T03-19-18-864Z.jsonl','run-2026-10-10T03-23-31-726Z.jsonl')
$watch = @('shop','CHARACTER','DEATH','death_verified_world','death_recover','farm_disconnected','travel_via','npc_dialog','death_recovered')
foreach ($fn in $more) {
  $f = Join-Path $dir $fn
  if (-not (Test-Path $f)) { continue }
  Write-Host ('--- ' + $fn + ' ---')
  $hours = @{}
  foreach ($line in [IO.File]::ReadLines($f)) {
    $mt = [regex]::Match($line, '"t":"([^"]+)"')
    if (-not $mt.Success) { continue }
    $ts = $mt.Groups[1].Value
    $me = [regex]::Match($line, '"evt":"([^"]+)"')
    if (-not $me.Success) { continue }
    $evt = $me.Groups[1].Value
    if ($evt -eq 'HEARTBEAT') {
      if (-not $line.Contains('"zeny"')) { continue }
      $mz = [regex]::Match($line,'"zeny":(\d+)'); $mb = [regex]::Match($line,'"used":(\d+)')
      $hh = $ts.Substring(0,13)
      if (-not $hours.ContainsKey($hh)) { $hours[$hh] = New-Object System.Collections.Generic.List[object] }
      $hours[$hh].Add([pscustomobject]@{ ts=$ts; zeny=[int64]$mz.Groups[1].Value; used=[int]$mb.Groups[1].Value }) | Out-Null
      continue
    }
    if ($watch -contains $evt) {
      $sh = $line
      if ($sh.Length -gt 600) { $sh = $sh.Substring(0,600) + ' ...TRUNC' }
      Write-Host ('  ' + $sh)
    }
  }
  foreach ($k in ($hours.Keys | Sort-Object)) {
    $l = $hours[$k]; $f0 = $l[0]; $f1 = $l[$l.Count-1]
    Write-Host ('  [' + $k + '] hb=' + $l.Count + '  first ' + $f0.ts + ' zeny=' + $f0.zeny.ToString('N0') + ' used=' + $f0.used + '   last ' + $f1.ts + ' zeny=' + $f1.zeny.ToString('N0') + ' used=' + $f1.used + '   delta=' + ($f1.zeny-$f0.zeny).ToString('N0'))
  }
}
