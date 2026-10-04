$p = 'e:\GitHub\lumivaraonline\aetheria\index-main.js'
$c = [IO.File]::ReadAllText($p)
$keys = @('arrived','inv_move','inv_use','respawn','market','shop_buy','storage_zeny','itembar_set','pickup','chat')
foreach ($k in $keys) {
  Write-Output ("== " + $k)
  $i = 0; $n = 0
  while ($n -lt 3) {
    $i = $c.IndexOf($k, $i)
    if ($i -lt 0) { break }
    $s = [Math]::Max(0, $i - 120)
    $len = [Math]::Min(260, $c.Length - $s)
    $snip = $c.Substring($s, $len) -replace '[^\u0020-\u007E]', '?'
    Write-Output ("@" + $i + " " + $snip)
    $i = $i + $k.Length; $n++
  }
}
