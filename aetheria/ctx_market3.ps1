$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$out = 'e:\GitHub\lumivaraonline\aetheria\out-grep'
if (-not (Test-Path $out)) { New-Item -ItemType Directory -Path $out | Out-Null }

# Dump a region around the market search filter construction
function DumpRegion($key, $before, $len, $name, $occurrence) {
  $i = -1; $n = 0
  $keyLen = $key.Length
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

# market search call site (filters builder) - occurrence 1
DumpRegion 'op:`search`,filters:A' 3500 4500 'market-search-site' 1
# marketAction definition
DumpRegion 'marketAction' 200 1500 'market-action-def' 1
# find the filter state UI (minRefine control)
DumpRegion 'minRefine' 2500 4000 'minrefine-ui' 1
# setMarket definition
DumpRegion 'setMarket(' 100 900 'set-market-def' 1

# search for item option/ability terms - just report offsets
$terms = @('extraOptions','options:','abilities','innate','potential','substat','affix','bonusStats','extra_stats','enchant')
foreach ($t in $terms) {
  $i = $c.IndexOf($t)
  Write-Output ("term " + $t + " first @" + $i)
}
