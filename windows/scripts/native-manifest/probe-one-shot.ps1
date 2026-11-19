# probe-one-shot.ps1 - a SINGLE dial of the plugin pipe, then a long patient read.
# Multiple dials are counter-productive against this plugin: maxNumberOfServerInstances is 4 and the
# accept loop promotes the first arriving connection as the one primary client, so abandoned timed-out
# dials occupy instances and later attempts fail with a bare Connect timeout rather than -32025.
param(
  [string]$OutDir = (Join-Path $env:TEMP 'aleph-native-audit'),
  [int]$WaitSeconds = 420
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
function Send-Rpc($c, $o) {
  $json = $o | ConvertTo-Json -Compress -Depth 12
  $b = [System.Text.Encoding]::UTF8.GetBytes($json)
  $hdr = 'Content-Length: ' + $b.Length + "`r`n" + 'Content-Type: application/vscode-jsonrpc; charset=utf-8' + "`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
  $c.Write($hb,0,$hb.Length); $c.Write($b,0,$b.Length); $c.Flush()
}
try {
  schtasks /Change /TN 'CadAI Bridge' /DISABLE 2>$null | Out-Null
  Get-Process CadAI.Bridge -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 4
  $pipes = @([System.IO.Directory]::GetFiles('\\?\pipe') | Where-Object { $_ -match 'cadai-autocad-' })
  if ($pipes.Count -eq 0) { throw 'no plugin pipe present' }
  $p = $pipes[0]
  $pipeName = 'cadai-autocad-' + $p.Substring($p.LastIndexOf('cadai-autocad-') + 'cadai-autocad-'.Length)
  Write-Host ('single dial: ' + $pipeName)
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  $client.Connect(20000)
  Write-Host 'connected; asking status then summary'
  Send-Rpc $client @{ jsonrpc='2.0'; id=1; method='system.status'; params=@{} }
  Send-Rpc $client @{ jsonrpc='2.0'; id=2; method='drawing.summary'; params=@{} }
  $buf = New-Object byte[] 8388608
  $mem = New-Object System.IO.MemoryStream
  $stop = (Get-Date).AddSeconds($WaitSeconds)
  while ((Get-Date) -lt $stop) {
    if ($client.DataAvailable) { $n = $client.Read($buf,0,$buf.Length); if ($n -gt 0){ $mem.Write($buf,0,$n) } }
    else { Start-Sleep -Milliseconds 300 }
    $txt = [System.Text.Encoding]::UTF8.GetString($mem.ToArray())
    if ($txt.Contains('"id":2')) { break }
  }
  $txt = [System.Text.Encoding]::UTF8.GetString($mem.ToArray())
  if ($txt) {
    [System.IO.File]::WriteAllText((Join-Path $OutDir 'plugin-rpc-once.txt'), $txt, [System.Text.Encoding]::UTF8)
    Write-Host ('GOT ' + $txt.Length + ' chars')
    Write-Host $txt.Substring(0,[Math]::Min(600,$txt.Length))
  } else { Write-Warning 'no bytes' }
  $client.Dispose()
} finally {
  schtasks /Change /TN 'CadAI Bridge' /ENABLE 2>$null | Out-Null
  schtasks /Run /TN 'CadAI Bridge' 2>$null | Out-Null
  Write-Host 'Bridge restored'
}
