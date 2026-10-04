$dir = 'e:\GitHub\lumivaraonline\aetheria'
$c = [IO.File]::ReadAllText("$dir\index-main.js")
$out = "$dir\scan4.txt"
if (Test-Path $out) { Remove-Item $out }
$bt = [char]96
Add-Content $out "=== all backtick-quoted send() message names ==="
$sends = [regex]::Matches($c, ('\.send\(\s*' + $bt + '([A-Za-z0-9_]+)' + $bt)) | ForEach-Object { $_.Groups[1].Value }
$sends | Sort-Object -Unique | ForEach-Object { Add-Content $out ("  send: " + $_) }
Add-Content $out ""
Add-Content $out "=== all backtick-quoted onMessage names ==="
$recvs = [regex]::Matches($c, ('onMessage\(\s*' + $bt + '([A-Za-z0-9_]+)' + $bt)) | ForEach-Object { $_.Groups[1].Value }
$recvs | Sort-Object -Unique | ForEach-Object { Add-Content $out ("  onMessage: " + $_) }
Add-Content $out ""
Add-Content $out "=== send contexts (all) ==="
$ms = [regex]::Matches($c, ('\.send\(' + $bt + '[A-Za-z0-9_]+' + $bt + '[^\)]{0,150}'))
$seen = @{}
$n = 0
foreach ($m in $ms) {
  $v = $m.Value
  if ($seen.ContainsKey($v)) { continue }
  $seen[$v] = 1
  $n++
  Add-Content $out ("  " + $v)
  if ($n -gt 70) { break }
}
Write-Host ("done, " + (Get-Item $out).Length + " bytes")
