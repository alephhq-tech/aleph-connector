# run-native-audit.ps1 - Epic #413 SS11.1/SS11.8 native DWG audit + plugin-parity probe.
# Opens a DWG in real AutoCAD, dumps a privacy-safe native manifest via aleph-manifest.lsp, then
# (optionally, -WithPluginRpc) takes the plugin's single primary pipe slot and calls
# system.status + drawing.summary over the real RPC to prove plugin<->native parity.
# The always-on CadAI Bridge holds that slot on a live workstation, so the task is paused for the
# probe and ALWAYS resumed in the finally block. No drawing content is written - counts/units only.
#
# Two portability traps this script exists to dodge, both learned the hard way on real drawings:
#   * Non-ASCII (Vietnamese) DWG paths survive only when read from a UTF-8 file (-DwgFile). Windows
#     re-encodes a non-Unicode process's argv through the ANSI codepage, turning each diacritic into
#     '?', and AutoCAD then "opens" a path that does not exist while everything downstream just
#     silently produces nothing.
#   * acad.exe must be handed a plain command line ("<dwg>" /b "<scr>"). Start-Process re-quotes its
#     -ArgumentList array elements and the /b switch never reaches AutoCAD, so the startup script is
#     simply not executed.
param(
  [string]$Dwg,
  [string]$DwgFile,
  [string]$AcadExe = 'C:\Program Files\Autodesk\AutoCAD 2022\acad.exe',
  [string]$OutDir  = (Join-Path $env:TEMP 'aleph-native-audit'),
  [switch]$WithPluginRpc,
  [int]$LoadDwellSeconds = 40,
  [int]$RpcTimeoutSeconds = 150
)
$ErrorActionPreference = 'Stop'
$Q = [char]34
if (-not $Dwg -and -not $DwgFile) { throw 'pass -DwgFile <utf-8 file holding the drawing path> (preferred) or -Dwg <path>' }
if ($DwgFile) {
  if (-not (Test-Path -LiteralPath $DwgFile)) { throw "-DwgFile not found: $DwgFile" }
  $Dwg = ([System.IO.File]::ReadAllText($DwgFile, [System.Text.Encoding]::UTF8)).Trim()
}
if (-not (Test-Path -LiteralPath $Dwg)) {
  # An '?' where a diacritic should be means the path lost its encoding crossing a process
  # boundary - read it from a UTF-8 file with -DwgFile instead.
  throw "DWG not found: $Dwg"
}

$scriptsDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$lsp = Join-Path $scriptsDir 'aleph-manifest.lsp'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$manifest = Join-Path $OutDir 'native-manifest.txt'
$sentinel = Join-Path $OutDir 'script-ran.txt'
foreach ($f in @($manifest, $sentinel)) { if (Test-Path $f) { Remove-Item $f } }

# Startup script: sentinel first, so "nothing at all appeared" distinguishes "script never ran"
# from "drawing failed to open".
$scr = Join-Path $OutDir 'dump.scr'
$senFwd = $sentinel.Replace('\','/')
$lspFwd = $lsp.Replace('\','/')
$manFwd = $manifest.Replace('\','/')
$lines = @(
  '_SECURELOAD', '0',
  '(setq _alephf (open ' + $Q + $senFwd + $Q + ' "w"))',
  '(write-line "startup script executed" _alephf)',
  '(close _alephf)',
  '(load ' + $Q + $lspFwd + $Q + ')',
  '(aleph:dump ' + $Q + $manFwd + $Q + ')'
)
[System.IO.File]::WriteAllText($scr, (($lines -join "`r`n") + "`r`n"), [System.Text.Encoding]::ASCII)

Get-Process acad -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 3
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $AcadExe
$psi.Arguments = $Q + $Dwg + $Q + ' /b ' + $Q + $scr + $Q
$psi.WorkingDirectory = (Split-Path -Parent $AcadExe)
$acad = [System.Diagnostics.Process]::Start($psi)
Write-Host ('acad pid ' + $acad.Id + ' started')

# Lists EVERY visible top-level window of a process, not just MainWindowTitle. Observed on a real
# workstation: with the main thread held by "Product License - Out of Time" or "Drawing Recovery",
# MainWindowTitle still reported the healthy "AutoCAD 2022 - [SUNLAND.dwg]", so a diagnosis built on
# it names the wrong cause. Those dialogs are separate top-level windows that only EnumWindows sees.
if (-not ('Win32.Win' -as [type])) {
  Add-Type -Namespace Win32 -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
'@
}

function script:Get-AllWindowTitles {
  param([string]$ProcessName)
  $wanted = @(Get-Process $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($wanted.Count -eq 0) { return @() }
  $found = New-Object System.Collections.ArrayList
  $callback = [Win32.Win+EnumWindowsProc] {
    param([IntPtr]$h, [IntPtr]$l)
    $procId = 0
    [void][Win32.Win]::GetWindowThreadProcessId($h, [ref]$procId)
    if ($wanted -contains [int]$procId -and [Win32.Win]::IsWindowVisible($h)) {
      $len = [Win32.Win]::GetWindowTextLength($h)
      if ($len -gt 0) {
        $sb = New-Object System.Text.StringBuilder ($len + 2)
        [void][Win32.Win]::GetWindowText($h, $sb, $sb.Capacity)
        [void]$found.Add($sb.ToString())
      }
    }
    return $true
  }
  [void][Win32.Win]::EnumWindows($callback, [IntPtr]::Zero)
  return @($found)
}

# Preflight: a healthy AutoCAD with a trusted bundle publishes the named pipe
# cadai-autocad-<pid> within ~60 s.
# within ~60 s. If no pipe ever appears the usual cause is a MODAL dialog holding AutoCAD's main
# thread - an expired/trial license ("Product License - Out of Time") or the "drawing was in progress"
# recovery prompt - which also stops the startup script and blocks every RPC. Say so instead of
# letting the audit die as three unrelated empty warnings.
$pipeDeadline = (Get-Date).AddSeconds(90)
$pipeName = ''
while ((Get-Date) -lt $pipeDeadline) {
  $found = @([System.IO.Directory]::GetFiles('\\?\pipe') | Where-Object { $_ -match 'cadai-autocad-' })
  if ($found.Count -gt 0) { $pipeName = $found[0]; break }
  Start-Sleep -Seconds 3
}
if (-not $pipeName) {
  $titles = @(Get-AllWindowTitles -ProcessName 'acad')
  Write-Warning ('the CadAI plugin published no pipe within 90 s. AutoCAD is alive (window: ' +
    ($titles -join '; ') + ') but its main thread is almost certainly blocked by a MODAL dialog - a ' +
    'license/trial expiry prompt or the "was in progress" recovery box. Extension load, the /b startup ' +
    'script and every RPC stall behind that dialog. Clear it on screen and re-run.')
} else {
  Write-Host ('plugin pipe up: ' + $pipeName)
}

# Wait for the manifest; its arrival also proves the drawing opened and fully loaded.
$deadline = (Get-Date).AddSeconds($LoadDwellSeconds + 120)
while (-not (Test-Path $manifest) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
if (-not (Test-Path $sentinel)) { Write-Warning 'startup script did not run at all (sentinel absent) - acad did not accept the /b script'
} elseif (-not (Test-Path $manifest)) { Write-Warning 'script ran but no manifest - the drawing failed to open'
} else { Write-Host ('NATIVE MANIFEST:' + [char]10 + (Get-Content $manifest -Raw)) }

try {
  if ($WithPluginRpc) {
    # Free the plugin's single primary pipe slot: pause the always-on Bridge task and stop its
    # process so the next dial is ours. Restored in finally, unconditionally.
    schtasks /Change /TN 'CadAI Bridge' /DISABLE 2>$null | Out-Null
    Get-Process CadAI.Bridge -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 3
    $pipes = @([System.IO.Directory]::GetFiles('\\?\pipe') | Where-Object { $_ -match 'cadai-autocad-' })
    if ($pipes.Count -eq 0) { throw 'no plugin pipe present (did the CadAI bundle load in this AutoCAD?)' }
    $p = $pipes[0]
    $pipeName = 'cadai-autocad-' + $p.Substring($p.LastIndexOf('cadai-autocad-') + 'cadai-autocad-'.Length)
    Write-Host ('plugin pipe: ' + $pipeName)
    $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(5000)
    function Send-Rpc($c, $o) {
      $json = $o | ConvertTo-Json -Compress -Depth 12
      $b = [System.Text.Encoding]::UTF8.GetBytes($json)
      $hdr = 'Content-Length: ' + $b.Length + "`r`n" + 'Content-Type: application/vscode-jsonrpc; charset=utf-8' + "`r`n`r`n"
      $hb = [System.Text.Encoding]::ASCII.GetBytes($hdr)
      $c.Write($hb,0,$hb.Length); $c.Write($b,0,$b.Length); $c.Flush()
    }
    function Read-Until($c, $mem, $needle, $seconds) {
      $buf = New-Object byte[] 4194304
      $stop = (Get-Date).AddSeconds($seconds)
      while ((Get-Date) -lt $stop) {
        if ($c.DataAvailable) { $n = $c.Read($buf,0,$buf.Length); if ($n -gt 0){ $mem.Write($buf,0,$n) } }
        else { Start-Sleep -Milliseconds 250 }
        $txt = [System.Text.Encoding]::UTF8.GetString($mem.ToArray())
        if ($txt.Contains($needle)) { return $txt }
      }
      return [System.Text.Encoding]::UTF8.GetString($mem.ToArray())
    }
    $mem = New-Object System.IO.MemoryStream
    # system.status and drawing.summary both run on AutoCAD's main thread via the idle pump, so a
    # cold-opened multi-MB drawing answers late: re-ask until it does instead of sleeping blindly.
    $asked = 0
    $txt = ''
    $stop = (Get-Date).AddSeconds($RpcTimeoutSeconds)
    while ((Get-Date) -lt $stop -and -not $txt.Contains('"id":1')) {
      Send-Rpc $client @{ jsonrpc='2.0'; id=1; method='system.status'; params=@{} }
      $asked++
      $txt = Read-Until $client $mem '"id":1' 8
    }
    Write-Host ('status answered after ' + $asked + ' attempt(s)')
    if ($txt.Contains('-32025')) { Write-Warning 'plugin refused the connection: another client holds the single primary slot' }
    Send-Rpc $client @{ jsonrpc='2.0'; id=2; method='drawing.summary'; params=@{} }
    $full = Read-Until $client $mem '"id":2' $RpcTimeoutSeconds
    $client.Dispose()
    if ($full) {
      [System.IO.File]::WriteAllText((Join-Path $OutDir 'plugin-rpc.txt'), $full, [System.Text.Encoding]::UTF8)
      Write-Host ('PLUGIN RPC OK (' + $full.Length + ' chars)')
    } else { Write-Warning 'plugin RPC returned no bytes' }
  }
} finally {
  Get-Process acad -ErrorAction SilentlyContinue | Stop-Process -Force
  schtasks /Change /TN 'CadAI Bridge' /ENABLE 2>$null | Out-Null
  schtasks /Run /TN 'CadAI Bridge' 2>$null | Out-Null
  Write-Host 'Bridge task restored'
}
