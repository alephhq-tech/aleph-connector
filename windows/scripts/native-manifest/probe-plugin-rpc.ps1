# probe-plugin-rpc.ps1 - reads an ALREADY-OPEN AutoCAD through the CadAI plugin's own JSON-RPC, so
# the plugin's drawing.summary numbers can be compared against the native AutoLISP manifest
# (Epic #413 SS11.1 plugin<->native parity). Opening the drawing is deliberately NOT this script's
# job: real partner DWGs must be opened the normal way, and a drawing that opens empty proves nothing.
#
# The plugin's pipe serves exactly ONE primary client (docs/PROTOCOL.md). On a live workstation the
# always-on CadAI Bridge owns it, so the Bridge task is paused for the probe and ALWAYS resumed in
# finally. After the Bridge is stopped, the plugin needs an unbounded moment to notice the dropped
# stream and free the slot; until then a fresh dial is either refused or torn down mid-write
# (IOException: "Pipe is broken"). So this script RE-DIALS until an answer arrives rather than
# assuming one connect is enough - that single change is what makes the probe reliable.
param(
  [string]$OutDir = (Join-Path $env:TEMP 'aleph-native-audit'),
  [int]$MaxDialAttempts = 40,
  [int]$AttemptTimeoutSeconds = 15,
  [int]$SummaryTimeoutSeconds = 300,
  [switch]$KeepBridgeRunning
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
function Read-Into($c, $mem, $needle, $seconds) {
  $buf = New-Object byte[] 8388608
  $stop = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $stop) {
    if ($c.DataAvailable) { $n = $c.Read($buf,0,$buf.Length); if ($n -gt 0){ $mem.Write($buf,0,$n) } }
    else { Start-Sleep -Milliseconds 250 }
    if ($needle -and ([System.Text.Encoding]::UTF8.GetString($mem.ToArray())).Contains($needle)) { break }
  }
  return [System.Text.Encoding]::UTF8.GetString($mem.ToArray())
}

try {
  if (-not $KeepBridgeRunning) {
    schtasks /Change /TN 'CadAI Bridge' /DISABLE 2>$null | Out-Null
    Get-Process CadAI.Bridge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
  }

  # A cold-started AutoCAD needs 20-60 s before the CadAI bundle loads and publishes its pipe,
  # so wait for the pipe instead of failing on the first empty listing.
  $pipeDeadline = (Get-Date).AddSeconds(180)
  $pipes = @()
  while ($pipes.Count -eq 0 -and (Get-Date) -lt $pipeDeadline) {
    $pipes = @([System.IO.Directory]::GetFiles('\\?\pipe') | Where-Object { $_ -match 'cadai-autocad-' })
    if ($pipes.Count -eq 0) { Start-Sleep -Seconds 3 }
  }
  if ($pipes.Count -eq 0) { throw 'no plugin pipe present - is AutoCAD running with the CadAI bundle loaded?'
  } elseif ($pipes.Count -gt 1) { Write-Warning ($pipes.Count + ' AutoCAD instances expose pipes; dialling the first: ' + ($pipes -join ', ')) }
  $p = $pipes[0]
  $pipeName = 'cadai-autocad-' + $p.Substring($p.LastIndexOf('cadai-autocad-') + 'cadai-autocad-'.Length)
  Write-Host ('target pipe: ' + $pipeName)

  # system.status + drawing.summary both execute on AutoCAD's main thread via its idle pump, so a
  # cold-opened multi-MB drawing answers late; a broken write means the slot was not free yet.
  $statusJson = ''
  $attempt = 0
  $lastErr = ''
  while ($attempt -lt $MaxDialAttempts -and -not $statusJson.Contains('"id":1')) {
    $attempt++
    $client = $null
    try {
      $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
      $client.Connect(5000)
      Send-Rpc $client @{ jsonrpc='2.0'; id=1; method='system.status'; params=@{} }
      $mem = New-Object System.IO.MemoryStream
      $statusJson = Read-Into $client $mem '"id":1' $AttemptTimeoutSeconds
    } catch {
      $lastErr = $_.Exception.Message
    } finally {
      if ($client) { try { $client.Dispose() } catch { } }
    }
    if (-not $statusJson.Contains('"id":1')) { Start-Sleep -Seconds 2 }
  }
  if (-not $statusJson.Contains('"id":1')) {
    throw ('system.status never answered after ' + $attempt + ' dial(s); last error: ' + $lastErr)
  }
  Write-Host ('system.status answered on dial attempt ' + $attempt)
  [System.IO.File]::WriteAllText((Join-Path $OutDir 'plugin-status.txt'), $statusJson, [System.Text.Encoding]::UTF8)
  Write-Host $statusJson.Substring(0, [Math]::Min(300, $statusJson.Length))

  # Same dial that answered - the slot is ours now; ask for the heavier summary on it.
  $client2 = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  try {
    $client2.Connect(5000)
    Send-Rpc $client2 @{ jsonrpc='2.0'; id=2; method='drawing.summary'; params=@{} }
    $mem2 = New-Object System.IO.MemoryStream
    $summary = Read-Into $client2 $mem2 '"id":2' $SummaryTimeoutSeconds
    if ($summary.Contains('"id":2')) {
      [System.IO.File]::WriteAllText((Join-Path $OutDir 'plugin-summary.json'), $summary, [System.Text.Encoding]::UTF8)
      Write-Host ('PLUGIN SUMMARY OK (' + $summary.Length + ' chars) -> plugin-summary.json')
    } else {
      Write-Warning ('drawing.summary did not answer; saw: ' + $summary.Substring(0, [Math]::Min(300, $summary.Length)))
    }
  } finally {
    try { $client2.Dispose() } catch { }
  }
} finally {
  if (-not $KeepBridgeRunning) {
    schtasks /Change /TN 'CadAI Bridge' /ENABLE 2>$null | Out-Null
    schtasks /Run /TN 'CadAI Bridge' 2>$null | Out-Null
    Write-Host 'Bridge task restored'
  }
}
