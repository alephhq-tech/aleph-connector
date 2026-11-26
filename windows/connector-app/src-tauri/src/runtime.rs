//! Local MCP runtime sidecar management.
//!
//! The desktop app owns exactly one local runtime process: it spawns the compiled
//! sidecar (`aleph-mcp.exe`) when packaged, or `bun run src/index.ts` in a dev checkout,
//! on a loopback port. The runtime mints its own Bridge device credential and writes the
//! connector identity.json — the app never handles credentials.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Mutex, OnceLock};

pub const DEFAULT_PORT: u16 = 8080;

pub fn mcp_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/mcp")
}

pub fn device_wss_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}/device")
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub running: bool,
    pub port: u16,
    pub mcp_url: String,
    pub device_wss_url: String,
    pub healthy: bool,
}

/// Where the runtime comes from: a compiled sidecar exe, or a dev checkout's TS entry.
#[derive(Debug, Clone, PartialEq)]
pub enum Sidecar {
    Exe(PathBuf),
    DevSource(PathBuf),
}

/// Resolution order: `ALEPH_MCP_SIDECAR` env → `<resource_dir>/[binaries/]aleph-mcp.exe`
/// → walk-up for `apps/mcp-server/src/index.ts` (dev tree, spawn `bun run src/index.ts`).
pub fn resolve_sidecar(resource_dir: Option<&Path>) -> Result<Sidecar, String> {
    if let Ok(raw) = std::env::var("ALEPH_MCP_SIDECAR") {
        let path = PathBuf::from(raw.trim());
        if path.is_file() {
            return Ok(Sidecar::Exe(path));
        }
    }
    if let Some(dir) = resource_dir {
        for rel in [
            PathBuf::from("aleph-mcp.exe"),
            PathBuf::from("binaries").join("aleph-mcp.exe"),
        ] {
            let candidate = dir.join(&rel);
            if candidate.is_file() {
                return Ok(Sidecar::Exe(candidate));
            }
        }
    }
    let start = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let mut dir = start.parent().map(Path::to_path_buf);
    for _ in 0..14 {
        let d = match dir {
            Some(d) => d,
            None => break,
        };
        let entry = d.join("apps").join("mcp-server").join("src").join("index.ts");
        if entry.is_file() {
            return Ok(Sidecar::DevSource(
                d.join("apps").join("mcp-server"),
            ));
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Err("no local runtime found: set ALEPH_MCP_SIDECAR, install the sidecar, or run from the repo checkout".into())
}

fn default_port() -> u16 {
    std::env::var("MCP_AUTOCAD_PORT")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn state_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("ALEPH_LOCAL_STATE_DIR") {
        if !raw.trim().is_empty() {
            return PathBuf::from(raw.trim());
        }
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CadAI")
        .join("connector")
}

fn runtime_slot() -> &'static Mutex<Option<Child>> {
    static SLOT: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

fn port_slot() -> &'static Mutex<u16> {
    static PORT: OnceLock<Mutex<u16>> = OnceLock::new();
    PORT.get_or_init(|| Mutex::new(default_port()))
}

fn child_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(_) => false,
    }
}

fn healthy(port: u16) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_millis(1_000))
        .timeout_read(std::time::Duration::from_millis(1_000))
        .build();
    matches!(
        agent.get(&format!("http://127.0.0.1:{port}/health")).call(),
        Ok(response) if response.status() == 200
    )
}

fn current_status() -> RuntimeStatus {
    let port = *port_slot().lock().unwrap_or_else(|e| e.into_inner());
    let running = {
        let mut guard = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
        guard.as_mut().map(|c| child_running(c)).unwrap_or(false)
    };
    RuntimeStatus {
        running,
        port,
        mcp_url: mcp_url(port),
        device_wss_url: device_wss_url(port),
        healthy: running && healthy(port),
    }
}

/// Spawn the local runtime. Idempotent: a live child is reported, not doubled.
pub fn start(resource_dir: Option<&Path>, port: Option<u16>) -> Result<RuntimeStatus, String> {
    let slot = runtime_slot();
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        if child_running(child) {
            drop(guard);
            return Ok(current_status());
        }
    }

    let port = port.unwrap_or_else(default_port);
    let sidecar = resolve_sidecar(resource_dir)?;
    let state = state_dir();
    std::fs::create_dir_all(&state).map_err(|e| format!("state dir: {e}"))?;

    let mut command = match &sidecar {
        Sidecar::Exe(path) => std::process::Command::new(path),
        Sidecar::DevSource(app_dir) => {
            let mut cmd = std::process::Command::new("bun");
            cmd.args(["run", "src/index.ts"]).current_dir(app_dir);
            cmd
        }
    };
    command.env("MCP_AUTOCAD_PORT", port.to_string());
    command.env("ALEPH_LOCAL_STATE_DIR", &state);
    if let Sidecar::Exe(path) = &sidecar {
        // The build stages guide skills next to the exe (binaries/skills/...); the runtime
        // reads them at startup and fails closed without them.
        if let Some(dir) = path.parent() {
            command.env("ALEPH_DRAFTING_SKILL_DIR", dir.join("skills").join("autocad-drafting"));
            command.env("ALEPH_PCCC_SKILLS_DIR", dir.join("skills").join("engineering"));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command
        .spawn()
        .map_err(|e| format!("spawn {}: {e}", sidecar_label(&sidecar)))?;
    *guard = Some(child);
    drop(guard);
    *port_slot().lock().unwrap_or_else(|e| e.into_inner()) = port;

    // Give the runtime a moment to bind before the first health probe.
    for _ in 0..20 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let status = current_status();
        if status.healthy {
            return Ok(status);
        }
        if !status.running {
            return Err("runtime exited immediately; check the runtime log".into());
        }
    }
    Ok(current_status())
}

pub fn stop() -> Result<RuntimeStatus, String> {
    let mut guard = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    drop(guard);
    Ok(current_status())
}

pub fn status() -> RuntimeStatus {
    current_status()
}

fn sidecar_label(sidecar: &Sidecar) -> String {
    match sidecar {
        Sidecar::Exe(path) => path.display().to_string(),
        Sidecar::DevSource(dir) => format!("bun run (dev) in {}", dir.display()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_loopback() {
        assert_eq!(mcp_url(8080), "http://127.0.0.1:8080/mcp");
        assert_eq!(device_wss_url(39271), "ws://127.0.0.1:39271/device");
    }

    #[test]
    fn resolve_sidecar_prefers_env_override() {
        let dir = std::env::temp_dir().join(format!("aleph-sidecar-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("aleph-mcp.exe");
        std::fs::write(&exe, b"stub").unwrap();
        std::env::set_var("ALEPH_MCP_SIDECAR", &exe);
        let resolved = resolve_sidecar(None).unwrap();
        std::env::remove_var("ALEPH_MCP_SIDECAR");
        assert_eq!(resolved, Sidecar::Exe(exe));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolve_sidecar_finds_dev_checkout_from_cwd() {
        // Tests run with CWD = src-tauri; the walk-up must find apps/mcp-server/src/index.ts.
        // (current_exe lives in target/debug, which walks up to the repo root too.)
        let resolved = resolve_sidecar(None);
        assert!(
            matches!(resolved, Ok(Sidecar::DevSource(_))),
            "expected dev checkout, got {resolved:?}"
        );
    }

    #[test]
    fn status_shape_is_loopback_for_port() {
        let status = RuntimeStatus {
            running: false,
            port: 8080,
            mcp_url: mcp_url(8080),
            device_wss_url: device_wss_url(8080),
            healthy: false,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"mcpUrl\":\"http://127.0.0.1:8080/mcp\""));
        assert!(json.contains("\"deviceWssUrl\":\"ws://127.0.0.1:8080/device\""));
    }
}
