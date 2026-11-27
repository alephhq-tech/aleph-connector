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
        let entry = d
            .join("apps")
            .join("mcp-server")
            .join("src")
            .join("index.ts");
        if entry.is_file() {
            return Ok(Sidecar::DevSource(d.join("apps").join("mcp-server")));
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Err("no local runtime found: set ALEPH_MCP_SIDECAR, install the sidecar, or run from the repo checkout".into())
}

pub fn resolve_stdio_exe(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(dir) = resource_dir {
        for candidate in [
            dir.join("binaries").join("aleph-mcp-stdio.exe"),
            dir.join("aleph-mcp-stdio.exe"),
        ] {
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join("aleph-mcp-stdio.exe");
    if dev.is_file() {
        return Ok(dev);
    }
    Err("bundled aleph-mcp-stdio.exe not found".into())
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .map(|_| ())
        .map_err(|e| format!("Local MCP port {port} is unavailable: {e}"))
}

/// Whether a process name is the known Aleph runtime sidecar that may be reaped when it
/// outlives the desktop app (e.g. after a hard kill). Anything else on the port is left alone.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_stale_sidecar_name(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    name == "aleph-mcp" || name == "aleph-mcp.exe"
}

/// Parse one "pid|processName" line emitted by the port-owner enumeration.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_port_owner(line: &str) -> Option<(u32, String)> {
    let mut parts = line.trim().splitn(2, '|');
    let pid = parts.next()?.trim().parse::<u32>().ok()?;
    let name = parts.next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some((pid, name))
}

/// Kill stale `aleph-mcp.exe` processes that are still listening on `port`.
///
/// A hard-killed desktop app never runs `runtime::stop()`, so its sidecar keeps holding the
/// port; the next launch would otherwise fail with "port is unavailable". Only processes
/// whose executable is the Aleph runtime are touched — anything else on the port is left alone.
/// Returns the PIDs that were reaped (empty when nothing matched or PowerShell is unavailable).
fn reap_stale_sidecar(port: u16) -> Vec<u32> {
    #[cfg(not(windows))]
    {
        let _ = port;
        return Vec::new();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "Get-NetTCPConnection -LocalPort {port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {{ $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$_\" -ErrorAction SilentlyContinue; if ($p) {{ Write-Output (\"$($p.ProcessId)|$($p.ProcessName)\") }} }}"
        );
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        let Ok(out) = cmd.output() else {
            return Vec::new();
        };
        let mut reaped = Vec::new();
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Some((pid, name)) = parse_port_owner(line) else {
                continue;
            };
            if !is_stale_sidecar_name(&name) {
                continue;
            }
            let mut killer = std::process::Command::new("taskkill");
            killer.args(["/PID", &pid.to_string(), "/F"]);
            killer.creation_flags(CREATE_NO_WINDOW);
            let killed = killer
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            if killed {
                reaped.push(pid);
            }
        }
        reaped
    }
}

/// Guarantee the runtime port is free: if it is occupied, reap any stale Aleph sidecar on it
/// and retry. Returns the original error when the port stays occupied (or nothing can be reaped).
fn ensure_port_available_after_reaping(port: u16) -> Result<(), String> {
    if ensure_port_available(port).is_ok() {
        return Ok(());
    }
    let reaped = reap_stale_sidecar(port);
    if reaped.is_empty() {
        return ensure_port_available(port);
    }
    eprintln!(
        "reaped stale Aleph runtime sidecar(s) on port {port}: {}",
        reaped
            .iter()
            .map(|pid| pid.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    // Give the OS a moment to release the port, then retry a bounded number of times.
    for _ in 0..40 {
        if ensure_port_available(port).is_ok() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
    ensure_port_available(port)
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

#[derive(Default)]
struct SupervisorState {
    desired: bool,
    generation: u64,
}

fn supervisor_state() -> &'static Mutex<SupervisorState> {
    static STATE: OnceLock<Mutex<SupervisorState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(SupervisorState::default()))
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
        guard.as_mut().map(child_running).unwrap_or(false)
    };
    RuntimeStatus {
        running,
        port,
        mcp_url: mcp_url(port),
        device_wss_url: device_wss_url(port),
        healthy: running && healthy(port),
    }
}

fn spawn_supervisor(resource_dir: Option<PathBuf>, port: u16, generation: u64) {
    std::thread::spawn(move || {
        let mut backoff = 1u64;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(backoff));
            let (desired, gen) = {
                let guard = supervisor_state().lock().unwrap_or_else(|e| e.into_inner());
                (guard.desired, guard.generation)
            };
            if !desired || gen != generation {
                return;
            }
            let running = {
                let mut child = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
                child.as_mut().map(child_running).unwrap_or(false)
            };
            if running {
                backoff = 1;
            } else {
                let restarted = start_child(resource_dir.as_deref(), Some(port));
                let (still_desired, still_gen) = {
                    let guard = supervisor_state().lock().unwrap_or_else(|e| e.into_inner());
                    (guard.desired, guard.generation)
                };
                if !still_desired || still_gen != generation {
                    let mut child = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(mut process) = child.take() {
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                    return;
                }
                let healthy = restarted
                    .as_ref()
                    .map(|status| status.healthy)
                    .unwrap_or(false);
                if !healthy {
                    let mut child = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(mut process) = child.take() {
                        let _ = process.kill();
                        let _ = process.wait();
                    }
                }
                backoff = if healthy { 1 } else { (backoff * 2).min(30) };
            }
        }
    });
}

/// Spawn the local runtime. Idempotent: a live child is reported, not doubled.
pub fn start(resource_dir: Option<&Path>, port: Option<u16>) -> Result<RuntimeStatus, String> {
    let mut guard = supervisor_state().lock().unwrap_or_else(|e| e.into_inner());
    let started = start_child(resource_dir, port)?;
    if !started.healthy {
        let mut child = runtime_slot().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut process) = child.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        return Err(format!(
            "Runtime did not become healthy on port {}",
            started.port
        ));
    }
    if !guard.desired {
        guard.desired = true;
        guard.generation = guard.generation.wrapping_add(1);
        spawn_supervisor(
            resource_dir.map(Path::to_path_buf),
            started.port,
            guard.generation,
        );
    }
    Ok(started)
}

fn start_child(resource_dir: Option<&Path>, port: Option<u16>) -> Result<RuntimeStatus, String> {
    let slot = runtime_slot();
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.as_mut() {
        if child_running(child) {
            drop(guard);
            return Ok(current_status());
        }
    }

    let port = port.unwrap_or_else(default_port);
    // Reap a stale aleph-mcp.exe left behind by a hard-killed app, then proceed.
    ensure_port_available_after_reaping(port)?;
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
            command.env(
                "ALEPH_DRAFTING_SKILL_DIR",
                dir.join("skills").join("autocad-drafting"),
            );
            command.env(
                "ALEPH_PCCC_SKILLS_DIR",
                dir.join("skills").join("engineering"),
            );
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
    let mut supervisor = supervisor_state().lock().unwrap_or_else(|e| e.into_inner());
    supervisor.desired = false;
    supervisor.generation = supervisor.generation.wrapping_add(1);
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

    static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn desired_runtime_restarts_after_unexpected_exit() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ALEPH_MCP_SIDECAR");
        let root =
            std::env::temp_dir().join(format!("aleph-runtime-restart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var("ALEPH_LOCAL_STATE_DIR", &root);
        std::env::set_var("ALEPH_LOCAL_IDENTITY_PATH", root.join("identity.json"));
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let started = start(Some(&bin), Some(port)).unwrap();
        assert!(started.healthy);
        let old_pid = runtime_slot().lock().unwrap().as_mut().unwrap().id();
        runtime_slot()
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .kill()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            let next_pid = runtime_slot().lock().unwrap().as_mut().map(|c| c.id());
            if next_pid.is_some_and(|pid| pid != old_pid) && status().healthy {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "runtime was not restarted"
            );
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        stop().unwrap();
        std::thread::sleep(std::time::Duration::from_secs(2));
        assert!(!status().running, "explicit Stop must prevent recovery");
        std::env::remove_var("ALEPH_LOCAL_STATE_DIR");
        std::env::remove_var("ALEPH_LOCAL_IDENTITY_PATH");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn occupied_port_is_rejected_before_start() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(ensure_port_available(port).is_err());
    }

    #[test]
    fn stale_sidecar_name_matches_only_aleph_runtime() {
        assert!(is_stale_sidecar_name("aleph-mcp"));
        assert!(is_stale_sidecar_name("aleph-mcp.exe"));
        assert!(is_stale_sidecar_name("  ALEPH-MCP.EXE  "));
        assert!(!is_stale_sidecar_name("notepad"));
        assert!(!is_stale_sidecar_name("aleph-mcp-something"));
        assert!(!is_stale_sidecar_name("bun"));
        assert!(!is_stale_sidecar_name(""));
    }

    #[test]
    fn port_owner_lines_parse_valid_pid_and_name() {
        assert_eq!(
            parse_port_owner("1234|aleph-mcp"),
            Some((1234, "aleph-mcp".to_string()))
        );
        assert_eq!(
            parse_port_owner("  18402|aleph-mcp.exe  "),
            Some((18402, "aleph-mcp.exe".to_string()))
        );
        assert_eq!(parse_port_owner("not-a-pid|aleph-mcp"), None);
        assert_eq!(parse_port_owner("1234"), None);
        assert_eq!(parse_port_owner("1234|"), None);
        assert_eq!(parse_port_owner(""), None);
    }

    #[test]
    fn occupied_port_is_not_freed_by_reaping_unrelated_processes() {
        // A listener owned by this test process (not an Aleph sidecar) must not be reaped and
        // must keep the port unavailable.
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(ensure_port_available_after_reaping(port).is_err());
    }

    // Hard-kill simulation: the stale sidecar keeps holding the port after the app dies. The
    // next start() must reap it and bring up a healthy runtime instead of failing.
    #[cfg(windows)]
    #[test]
    fn start_reaps_stale_sidecar_left_by_hard_killed_app() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ALEPH_MCP_SIDECAR");
        let root = std::env::temp_dir().join(format!("aleph-reap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::env::set_var("ALEPH_LOCAL_STATE_DIR", &root);
        std::env::set_var("ALEPH_LOCAL_IDENTITY_PATH", root.join("identity.json"));
        let src_tauri = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let binaries = src_tauri.join("binaries");
        let sidecar = binaries.join("aleph-mcp.exe");
        assert!(sidecar.is_file(), "sidecar not built");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut cmd = std::process::Command::new(&sidecar);
        cmd.creation_flags(CREATE_NO_WINDOW)
            .env("MCP_AUTOCAD_PORT", port.to_string())
            .env("ALEPH_LOCAL_STATE_DIR", &root)
            .env(
                "ALEPH_DRAFTING_SKILL_DIR",
                binaries.join("skills").join("autocad-drafting"),
            )
            .env(
                "ALEPH_PCCC_SKILLS_DIR",
                binaries.join("skills").join("engineering"),
            );
        let mut stale = cmd.spawn().unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
            assert!(
                std::time::Instant::now() < deadline,
                "stale sidecar did not bind port {port}"
            );
            assert!(stale.try_wait().unwrap().is_none(), "stale sidecar exited early");
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        // Do NOT touch the stale child — emulate the hard-killed app. Next start() must reap it.
        let result = start(Some(&src_tauri), Some(port));
        let status = result.unwrap();
        assert!(status.healthy);
        assert!(
            stale.try_wait().unwrap().is_some(),
            "stale sidecar was not reaped"
        );
        stop().unwrap();
        std::env::remove_var("ALEPH_LOCAL_STATE_DIR");
        std::env::remove_var("ALEPH_LOCAL_IDENTITY_PATH");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn finds_stdio_in_packaged_binaries() {
        let dir = std::env::temp_dir().join(format!("aleph-stdio-path-{}", uuid::Uuid::new_v4()));
        let bin = dir.join("binaries");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("aleph-mcp-stdio.exe");
        std::fs::write(&exe, b"test").unwrap();
        assert_eq!(resolve_stdio_exe(Some(&dir)).unwrap(), exe);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn urls_are_loopback() {
        assert_eq!(mcp_url(8080), "http://127.0.0.1:8080/mcp");
        assert_eq!(device_wss_url(39271), "ws://127.0.0.1:39271/device");
    }

    #[test]
    fn resolve_sidecar_prefers_env_override() {
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _lock = TEST_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("ALEPH_MCP_SIDECAR");
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
