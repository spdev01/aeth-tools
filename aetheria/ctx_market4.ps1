$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$out = 'e:\GitHub\lumivaraonline\aetheria\out-grep'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

function DumpRegion($key, $before, $len, $name, $occurrence) {
  $i = -1; $n = 0
  while ($true) {
    $i = $c.IndexOf($key, $i + 1)
    if ($i -lt 0) { break }
    $n++
    if ($n -eq $occurrence) { break }
  }
  if ($i -lt 0) { Write-Output ("NOT FOUND: " + $key); return }
  $s = [Math]::Max(0, $i - $before)
  $l = [Math]::Min($len, $c.Length - $s)
  [IO.File]::WriteAllText((Join-Path $out ($name + '.txt')), $c.Substring($s, $l), (New-Object Text.UTF8Encoding($false)))
  Write-Output ("WROTE " + $name + " at @" + $i + " start=" + $s + " len=" + $l)
}

function DumpAll($key, $limit, $before, $len, $prefix) {
  $i = -1; $n = 0
  while ($n -lt $limit) {
    $i = $c.IndexOf($key, $i + 1)
    if ($i -lt 0) { break }
    $n++
    $s = [Math]::Max(0, $i - $before)
    $l = [Math]::Min($len, $c.Length - $s)
    [IO.File]::WriteAllText((Join-Path $out ($prefix + "-" + $n + '.txt')), $c.Substring($s, $l), (New-Object Text.UTF8Encoding($false)))
    Write-Output ($prefix + "-" + $n + " @" + $i)
  }
}

# find the market filter builder region (search call)
DumpRegion 'op:`search`,filters:A' 4000 5000 'market-search-site' 1
# marketAction definition
DumpRegion 'marketAction' 200 1600 'market-action-def' 1
# item option keys in item shape
DumpAll 'minRefine:' 6 300 800 'minrefine-key'
# item name helper fn
DumpRegion 'function tu(' 100 1200 'item-name-fn' 1
