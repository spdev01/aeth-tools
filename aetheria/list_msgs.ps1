$c = [IO.File]::ReadAllText('e:\GitHub\lumivaraonline\aetheria\index-main.js')
$sends = [regex]::Matches($c, 'send\(`([^`]{2,40})`') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$recvs = [regex]::Matches($c, 'onMessage\(`([^`]{2,40})`') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
Write-Output ("SENDS (" + @($sends).Count + "): " + (@($sends) -join ', '))
Write-Output ("RECVS (" + @($recvs).Count + "): " + (@($recvs) -join ', '))
