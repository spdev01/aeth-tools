$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$keys = @('npc_talk','npc_option','npc_dialog','storage_put','storage_take','storage_move','onMessage(`storage`','onMessage(`inventory`','Alice')
foreach ($k in $keys) {
  Write-Output ("== " + $k)
  $i = 0; $n = 0
  while ($n -lt 3) {
    $i = $c.IndexOf($k, $i)
    if ($i -lt 0) { break }
    $s = [Math]::Max(0, $i - 150)
    $len = [Math]::Min(300, $c.Length - $s)
    $snip = $c.Substring($s, $len) -replace '[^\u0020-\u007E]', '?'
    Write-Output ("@" + $i + " " + $snip)
    $i = $i + $k.Length; $n++
  }
}
$a = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\world_atlas.json')
$j = $a.IndexOf('Alice')
Write-Output ("== atlas Alice @" + $j)
if ($j -ge 0) { Write-Output ($a.Substring([Math]::Max(0,$j-200), 480) -replace '[^\u0020-\u007E]', '?') }
