$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$keys = @('bag-window','storage-window','npc-dialog','talkTo(','inv_sort','alice','npcKey')
foreach ($k in $keys) {
  Write-Output ("== " + $k)
  $i = 0; $n = 0
  while ($n -lt 3) {
    $i = $c.IndexOf($k, $i)
    if ($i -lt 0) { break }
    $s = [Math]::Max(0, $i - 140)
    $len = [Math]::Min(280, $c.Length - $s)
    $snip = $c.Substring($s, $len) -replace '[^\u0020-\u007E]', '?'
    Write-Output ("@" + $i + " " + $snip)
    $i = $i + $k.Length; $n++
  }
}
