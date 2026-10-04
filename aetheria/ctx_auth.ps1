$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$keys = @('world/enter','skipHandshake','joinById','joinOrCreate','new Client','tilemap')
foreach ($k in $keys) {
  Write-Output ("== " + $k)
  $i = 0; $n = 0
  while ($n -lt 3) {
    $i = $c.IndexOf($k, $i)
    if ($i -lt 0) { break }
    $s = [Math]::Max(0, $i - 160)
    $len = [Math]::Min(340, $c.Length - $s)
    $snip = $c.Substring($s, $len) -replace '[^\u0020-\u007E]', '?'
    Write-Output ("@" + $i + " " + $snip)
    $i = $i + $k.Length; $n++
  }
}
