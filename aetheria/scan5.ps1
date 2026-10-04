$dir = 'e:\GitHub\lumivaraonline\aetheria'
$c = [IO.File]::ReadAllText("$dir\index-main.js")
$out = "$dir\scan5.txt"
if (Test-Path $out) { Remove-Item $out }
$bt = [char]96
function Ctx($title, $pattern, $limit, $ctx) {
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
Ctx 'gacha_roll payload' ('gacha_roll' + $bt + ',') 3 260
Ctx 'shop_buy / shop_buy_many payload' '(shop_buy_many|shop_buy)' + $bt + ',[^\)]{0,160}' 6 200
Ctx 'storage_zeny payload' ('storage_zeny' + $bt + '[^\)]{0,160}') 4 220
Ctx 'storage_put / storage_take payload' ('storage_(put|take)' + $bt + '[^\)]{0,140}') 6 200
Ctx 'market ops payloads' ('market' + $bt + ',\{op:[^}]{0,200}\}') 10 200
Ctx 'trade payloads' ('trade' + $bt + ',\{[^}]{0,200}\}') 8 220
Ctx 'enchant payload' ('enchant' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'refine payload' ('refine' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'socket_drill payload' ('socket_drill' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'move / move_to payloads' ('\.send\(' + $bt + '(move|move_to)' + $bt + '[^\)]{0,120}') 6 200
Ctx 'channel_switch payload' ('channel_switch' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'pickup payload' ('pickup' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'inv_use payload' ('inv_use' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'arena payload' ('arena' + $bt + ',[^\)]{0,160}') 4 200
Ctx 'party payloads' ('party' + $bt + ',\{[^}]{0,160}\}') 8 200
Ctx 'chat payload' ('chat' + $bt + ',[^\)]{0,140}') 4 200
Ctx 'skill_up / stat_up' ('(skill_up|stat_up)' + $bt + ',[^\)]{0,140}') 6 200
Write-Host ("done, " + (Get-Item $out).Length + " bytes")
