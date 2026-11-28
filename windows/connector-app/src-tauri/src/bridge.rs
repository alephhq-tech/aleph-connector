//! Bridge lifecycle: ensure the installed CadAI Bridge is running when the app launches.
//!
//! The desktop app does not own the Bridge's install — install.ps1 does that, via the
//! Install button. What the app owns is the launch path: on every run the app makes sure
//! the Bridge is up, so opening Aleph Connector is enough to have the integration live.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

const BRIDGE_EXE: &str = "CadAI.Bridge.exe";
const TASK_NAME: &str = "CadAI Bridge";
const PROCESS_NAME: &str = "CadAI.Bridge";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeLaunchStatus {
    /// "not-installed" | "already-running" | "started" | "failed"
    pub status: String,
    pub detail: String,
}

/// Where the install puts the Bridge (ProgramData is where install.ps1 installs it).
fn bridge_exe_path() -> Option<PathBuf> {
    let program_data = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let exe = program_data.join("CadAI").join("Bridge").join(BRIDGE_EXE);
    if exe.is_file() {
        Some(exe)
    } else {
        None
    }
}

fn powershell(script: &str) -> Result<String, String> {
    #[cfg(windows)]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = Command::new("powershell.exe");
        c.creation_flags(CREATE_NO_WINDOW);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = Command::new("powershell.exe");
    let out = cmd
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
        .map_err(|e| format!("cannot run powershell: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

/// Pure parser so the logic is unit-testable without a live scheduled task.
pub fn parse_process_state(output: &str) -> bool {
    output.trim() == "running"
}

pub fn parse_task_state(output: &str) -> bool {
    let trimmed = output.trim();
    !trimmed.is_empty() && trimmed != "missing"
}

/// Whether the Bridge process is currently running. Errors mean "unknown", which is
/// safer treated as "not running" than as "already fine".
fn is_bridge_running() -> bool {
    powershell(&format!(
        "if (Get-Process -Name '{PROCESS_NAME}' -ErrorAction SilentlyContinue) {{ 'running' }} else {{ 'stopped' }}"
    ))
    .map(|s| parse_process_state(&s))
    .unwrap_or(false)
}

fn task_exists() -> bool {
    powershell(&format!(
        "try {{ (Get-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction Stop).State.ToString() }} catch {{ 'missing' }}"
    ))
    .map(|s| parse_task_state(&s))
    .unwrap_or(false)
}

fn start_bridge_task() -> Result<(), String> {
    powershell(&format!(
        "Start-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction Stop; 'started'"
    ))?;
    Ok(())
}

fn start_exe_direct(exe: &std::path::Path) -> Result<(), String> {
    let mut cmd = Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot start {}: {e}", exe.display()))
}

/// Ensure the installed Bridge is running.
///
/// Returns a status describing what happened. Never fails hard: the caller shows the
/// status to the user rather than crashing the app or wedging startup.
pub fn ensure_bridge_running() -> BridgeLaunchStatus {
    let Some(exe) = bridge_exe_path() else {
        return BridgeLaunchStatus {
            status: "not-installed".into(),
            detail: "Bridge is not installed yet.".into(),
        };
    };
    if is_bridge_running() {
        return BridgeLaunchStatus {
            status: "already-running".into(),
            detail: "Bridge is already running.".into(),
        };
    }
    // Prefer the installed scheduled task — the same path install.ps1 wired up (at logon).
    // Fall back to launching the exe directly so an install without a task still works.
    let launch = if task_exists() {
        start_bridge_task()
            .map(|_| ())
            .or_else(|task_err| {
                start_exe_direct(&exe)
                    .map_err(|exe_err| format!("scheduled task failed ({task_err}); direct start failed ({exe_err})"))
            })
    } else {
        start_exe_direct(&exe)
    };
    if let Err(detail) = launch {
        return BridgeLaunchStatus {
            status: "failed".into(),
            detail,
        };
    }
    // Give the process a moment to come up.
    for _ in 0..20 {
        if is_bridge_running() {
            return BridgeLaunchStatus {
                status: "started".into(),
                detail: "Bridge started.".into(),
            };
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    BridgeLaunchStatus {
        status: "failed".into(),
        detail: "Bridge did not come up after start attempt.".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_process_state_recognizes_only_running() {
        assert!(parse_process_state("running"));
        assert!(parse_process_state("  running  "));
        assert!(!parse_process_state("stopped"));
        assert!(!parse_process_state(""));
        assert!(!parse_process_state("Running"));
    }

    #[test]
    fn parse_task_state_rejects_missing_and_empty() {
        assert!(parse_task_state("Ready"));
        assert!(parse_task_state("Running"));
        assert!(!parse_task_state("missing"));
        assert!(!parse_task_state(""));
        assert!(!parse_task_state("   "));
    }
}
