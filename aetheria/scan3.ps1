$dir = 'e:\GitHub\lumivaraonline\aetheria'
$c = [IO.File]::ReadAllText("$dir\index-main.js")
$out = "$dir\scan3.txt"
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
Emit 'joinOrCreate call context' 'joinOrCreate\(' 4 320
Emit 'dynamic import chunks' 'import\(`?\.?/?[A-Za-z0-9_@/\-\.\$]*assets[A-Za-z0-9_\-/\.]*`?\)' 25 80
Emit 'assets path strings' '"[/A-Za-z0-9_\-]*assets/[A-Za-z0-9_\-]+-[A-Za-z0-9_]{6,12}\.(js|css)"' 25 60
Emit 'game Scene classes' 'extends .{1,30}Scene' 8 140
Emit 'new Game(' 'new .{1,4}\.Game\(|\.Game\(\{' 6 200
Emit 'quoted endpoints' "'/[a-z][A-Za-z0-9_\-/]{2,50}'" 30 60
Emit 'send contexts' '\.send\(' 20 130
Emit 'fetch/XHR usage' 'fetch\(|XMLHttpRequest|sendBeacon' 12 130
Write-Host ("done, " + (Get-Item $out).Length + " bytes")
