$dir = 'e:\GitHub\lumivaraonline\aetheria'
$c = [IO.File]::ReadAllText("$dir\index-main.js")
$out = "$dir\scan2.txt"
if (Test-Path $out) { Remove-Item $out }
function Emit($title, $pattern, $limit, $ctx) {
  Add-Content $out ("##### " + $title + " #####")
  $ms = [regex]::Matches($c, $pattern)
  $n = 0
  $seen = @{}
  foreach ($m in $ms) {
    $start = [Math]::Max(0, $m.Index - $ctx)
    $len = [Math]::Min(($ctx * 2), $c.Length - $start)
    $snip = $c.Substring($start, $len)
    if ($seen.ContainsKey($snip)) { continue }
    $seen[$snip] = 1
    $n++
    if ($n -gt $limit) { break }
    Add-Content $out ("--- m" + $n + " ---")
    Add-Content $out $snip
  }
  Add-Content $out ""
}
Emit 'joinOrCreate / join' 'joinOrCreate|joinById|\.join\(' 6 220
Emit 'room.send( calls' '\.send\(\s*"[A-Za-z0-9_\-]+"' 25 160
Emit 'room.send single-quote' "\.send\(\s*'[A-Za-z0-9_\-]+'" 25 160
Emit 'onMessage handlers' 'onMessage\(\s*"[A-Za-z0-9_\-]+"|onMessage\(\s*'"[A-Za-z0-9_\-]+'"'' 15 160
Emit 'ws url construction' 'location\.protocol|location\.host|import\.meta\.env|VITE_' 12 200
Emit 'fetch endpoints' 'fetch\(\s*"[^"]{2,80}"' 10 140
Emit 'fetch single quote' "fetch\(\s*'[^']{2,80}'" 10 140
Write-Host ("done, " + (Get-Item $out).Length + " bytes")
