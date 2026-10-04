$dir = 'e:\GitHub\lumivaraonline\aetheria'
$c = [IO.File]::ReadAllText("$dir\index-main.js")
$out = "$dir\scan1.txt"
if (Test-Path $out) { Remove-Item $out }
Add-Content $out "=== ws/wss URLs ==="
[regex]::Matches($c, 'wss?://[A-Za-z0-9\.\-_/:\?=&%#@]+') | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 30 | ForEach-Object { Add-Content $out $_ }
Add-Content $out ""
Add-Content $out "=== /api|/ws|/socket paths ==="
$paths = @()
$paths += [regex]::Matches($c, '"/api/[A-Za-z0-9_\-/\.{}\$\+]+"') | ForEach-Object { $_.Value }
$paths += [regex]::Matches($c, '"/[a-z]+/ws[A-Za-z0-9_\-/\.]*"') | ForEach-Object { $_.Value }
$paths += [regex]::Matches($c, 'new WebSocket\([^\)]{0,200}') | ForEach-Object { $_.Value }
$paths | Sort-Object -Unique | Select-Object -First 60 | ForEach-Object { Add-Content $out $_ }
Add-Content $out ""
Add-Content $out "=== framework markers ==="
foreach ($f in @('react', 'react-dom', 'preact', 'vue', 'svelte', 'solid-js', 'phaser', 'pixi', 'three', 'babylon', 'kaboom', 'bitECS', 'colyseus', 'socket.io', 'supabase', 'firebase', 'trpc')) {
  $n = ([regex]::Matches($c, [regex]::Escape($f), 'IgnoreCase')).Count
  Add-Content $out ("{0}: {1}" -f $f, $n)
}
Add-Content $out ""
Add-Content $out "=== version strings ==="
[regex]::Matches($c, '(react-dom@|react@|phaser@|pixi@)?[Vv]ersion[":= ]{1,4}"?[0-9]+\.[0-9]+\.[0-9]+') | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 20 | ForEach-Object { Add-Content $out $_ }
[regex]::Matches($c, '"3\.[0-9]{2}\.[0-9]{1,2}"') | ForEach-Object { $_.Value } | Sort-Object -Unique | Select-Object -First 10 | ForEach-Object { Add-Content $out $_ }
Add-Content $out ""
Add-Content $out "=== message type candidates ==="
$types = [regex]::Matches($c, 'type:"([A-Za-z0-9_]+)"') | ForEach-Object { $_.Groups[1].Value }
$types | Sort-Object -Unique | Select-Object -First 120 | ForEach-Object { Add-Content $out ("  " + $_) }
Write-Host ("done, " + (Get-Item $out).Length + " bytes")
