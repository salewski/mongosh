$version = "12.4.0"
$url = "https://nodejs.org/download/release/v$version/node-v$version-x86.msi"
$filename = "node.msi"
$node_msi = "$PSScriptRoot\$filename"

write-host "[NODE] downloading nodejs install"
write-host "url : $url"
$start_time = Get-Date
$wc = New-Object System.Net.WebClient
$wc.DownloadFile($url, $node_msi)
write-Output "$filename downloaded"
write-Output "Time taken: $((Get-Date).Subtract($start_time).Seconds) second(s)"

msiexec /i $node_msi /quiet
npm i -g npm@latest
