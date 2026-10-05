$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')

function Show($key, $hits, $before, $len) {
  Write-Output ("===== " + $key + " =====")
  $i = 0; $n = 0
  while ($n -lt $hits) {
    $i = $c.IndexOf($key, $i)
    if ($i -lt 0) { break }
    $s = [Math]::Max(0, $i - $before)
    $l = [Math]::Min($len, $c.Length - $s)
    $snip = $c.Substring($s, $l) -replace '[^\u0020-\u007E]', '?'
    Write-Output ("@" + $i + " " + $snip)
    Write-Output ""
    $i = $i + $key.Length; $n++
  }
}

Show 'market_results' 2 300 700
Show 'minRefine' 3 250 600
Show 'op:"search"' 2 200 500
Show 'maxListings' 2 200 400
Show 'listingId' 3 250 600
