# Read-only diagnosis of the failed live-lane bridge dial.
$ErrorActionPreference = 'SilentlyContinue'

Write-Output '--- processes ---'
Get-Process CadAI.Bridge | ForEach-Object { "CadAI.Bridge PID $($_.Id) start $($_.StartTime) path $($_.Path)" }
if (-not (Get-Process CadAI.Bridge)) { Write-Output 'CadAI.Bridge: NOT RUNNING' }
Get-Process acad | ForEach-Object { "acad PID $($_.Id) start $($_.StartTime)" }
if (-not (Get-Process acad)) { Write-Output 'acad: NOT RUNNING' }

Write-Output ''
Write-Output '--- scheduled task detail ---'
schtasks /query /tn 'CadAI Bridge' /v /fo LIST | Select-String -Pattern 'Status|Last Run Time|Last Result|Next Run Time|Run As User|Task To Run|Comment'

Write-Output ''
Write-Output '--- bridge config files ---'
foreach ($f in 'C:\ProgramData\CadAI\Bridge\config.json','C:\ProgramData\CadAI\Bridge\component-version.json','C:\ProgramData\CadAI\Bridge\pending-activation.json','C:\ProgramData\CadAI\Bridge\pending-selfupdate.json') {
  if (Test-Path $f) { Write-Output "$f EXISTS: $((Get-Content $f -Raw).Trim())" } else { Write-Output "$f absent" }
}

Write-Output ''
Write-Output '--- identity.json (deviceId only, token masked) ---'
$idPath = Join-Path $env:LOCALAPPDATA 'CadAI\bridge\identity.json'
if (Test-Path $idPath) {
  $id = Get-Content $idPath -Raw | ConvertFrom-Json
  $tok = if ($id.token) { $id.token.Substring(0,8) + '...(' + $id.token.Length + ' chars)' } else { '(none)' }
  Write-Output "deviceId=$($id.deviceId) token=$tok tokenExpiresAt=$($id.tokenExpiresAt) mtime=$((Get-Item $idPath).LastWriteTime)"
}

Write-Output ''
Write-Output '--- last 60 lines of today/yesterday bridge log ---'
$logDir = 'C:\ProgramData\CadAI\Bridge\logs'
$latest = Get-ChildItem $logDir -Filter '*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Output "file: $($latest.FullName) ($($latest.Length) bytes, $($latest.LastWriteTime))"
Get-Content $latest.FullName -Tail 60
