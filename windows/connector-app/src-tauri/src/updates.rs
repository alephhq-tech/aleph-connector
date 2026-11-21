use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::install;

const DEFAULT_MANIFEST_URL: &str = "https://updates.alephhq.tech/aleph-connector/manifest.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationStatus {
    pub installed: bool,
    pub bridge_installed: bool,
    pub plugin_installed: bool,
    pub bridge_version: Option<String>,
    pub plugin_version: Option<String>,
    pub connector_version: String,
    pub bridge_path: String,
    pub plugin_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub update_available: bool,
    pub channel_available: bool,
    pub latest: Option<String>,
    pub current: String,
    pub package_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseManifest {
    latest: String,
    #[serde(default)]
    #[allow(dead_code)]
    minimum_bridge_version: String,
    package_url: String,
    sha256: String,
    #[allow(dead_code)]
    signature: String,
}

fn program_data() -> PathBuf {
    std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
}

fn bridge_dir() -> PathBuf {
    program_data().join("CadAI").join("Bridge")
}

fn plugin_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Autodesk")
        .join("ApplicationPlugins")
        .join("CadAI.bundle")
}

fn read_json_version(path: &Path, field: &str) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get(field)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn is_newer(candidate: &str, current: &str) -> bool {
    match (parse_version(candidate), parse_version(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => !candidate.eq_ignore_ascii_case(current),
    }
}

fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let parts: Vec<_> = raw.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    let major = parts[0].parse().ok()?;
    let minor = parts[1].parse().ok()?;
    let patch = parts.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

pub fn connector_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

pub fn integration_status() -> IntegrationStatus {
    let bridge = bridge_dir();
    let plugin = plugin_dir();
    let bridge_exe = bridge.join("CadAI.Bridge.exe");
    let bridge_ver = read_json_version(&bridge.join("component-version.json"), "version");
    let plugin_ver = read_json_version(&plugin.join("current.json"), "current");
    let bridge_installed = bridge_exe.is_file();
    let plugin_installed = plugin.join("PackageContents.xml").is_file() || plugin_ver.is_some();
    IntegrationStatus {
        installed: bridge_installed && plugin_installed,
        bridge_installed,
        plugin_installed,
        bridge_version: bridge_ver,
        plugin_version: plugin_ver,
        connector_version: connector_version(),
        bridge_path: bridge.to_string_lossy().into(),
        plugin_path: plugin.to_string_lossy().into(),
    }
}

fn manifest_url() -> String {
    // Connector uses the aleph-connector channel only. Do NOT fall back to
    // CADAI_UPDATE_MANIFEST_URL — that may still point at the old Platform
    // `autocad-bridge` prefix (e.g. 0.3.0) and is for the Bridge daemon.
    std::env::var("ALEPH_UPDATE_MANIFEST_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_MANIFEST_URL.to_string())
}

fn effective_current_version(status: &IntegrationStatus) -> String {
    status
        .bridge_version
        .clone()
        .or_else(|| status.plugin_version.clone())
        .unwrap_or_else(|| status.connector_version.clone())
}

pub fn check_updates() -> Result<UpdateCheck, String> {
    let status = integration_status();
    let current = effective_current_version(&status);
    let url = manifest_url();
    let response = ureq::get(&url).call().map_err(|e| format!("Update channel: {e}"))?;
    let status_code = response.status();
    if status_code == 404 || status_code == 403 {
        return Ok(UpdateCheck {
            update_available: false,
            channel_available: false,
            latest: None,
            current,
            package_url: None,
            message: "Update channel has no published release yet.".into(),
        });
    }
    if !(200..300).contains(&status_code) {
        return Err(format!("Update channel HTTP {status_code}"));
    }
    let body = response.into_string().map_err(|e| e.to_string())?;
    let manifest: ReleaseManifest =
        serde_json::from_str(&body).map_err(|e| format!("Invalid manifest: {e}"))?;
    let available = is_newer(&manifest.latest, &current);
    Ok(UpdateCheck {
        update_available: available,
        channel_available: true,
        latest: Some(manifest.latest.clone()),
        current,
        package_url: Some(manifest.package_url),
        message: if available {
            format!(
                "Update available: {} → {} (Bridge + plugin + Connector package).",
                effective_current_version(&status),
                manifest.latest
            )
        } else {
            format!("Up to date ({}).", manifest.latest)
        },
    })
}

fn download_bytes(url: &str) -> Result<Vec<u8>, String> {
    let response = ureq::get(url).call().map_err(|e| e.to_string())?;
    if !(200..300).contains(&response.status()) {
        return Err(format!("Download HTTP {}", response.status()));
    }
    let mut reader = response.into_reader();
    let mut buf = Vec::new();
    reader
        .read_to_end(&mut buf)
        .map_err(|e| format!("Download read failed: {e}"))?;
    Ok(buf)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn extract_zip(bytes: &[u8], dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file
            .enclosed_name()
            .ok_or_else(|| format!("Unsafe zip path: {}", file.name()))?
            .to_path_buf();
        let out = dest.join(&name);
        if file.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut file, &mut outfile).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn find_install_script(extracted: &Path) -> Result<PathBuf, String> {
    let direct = extracted.join("install.ps1");
    if direct.is_file() {
        return Ok(direct);
    }
    // Some ZIPs nest a single top-level folder.
    for entry in fs::read_dir(extracted).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let candidate = entry.path().join("install.ps1");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("Downloaded package has no install.ps1".into())
}

pub fn apply_update(device_gateway_url: &str) -> Result<(bool, String), String> {
    let url = manifest_url();
    let response = ureq::get(&url).call().map_err(|e| e.to_string())?;
    if !(200..300).contains(&response.status()) {
        return Err(format!(
            "Cannot apply update — channel HTTP {}",
            response.status()
        ));
    }
    let body = response.into_string().map_err(|e| e.to_string())?;
    let manifest: ReleaseManifest =
        serde_json::from_str(&body).map_err(|e| format!("Invalid manifest: {e}"))?;

    let package = download_bytes(&manifest.package_url)?;
    let actual = sha256_hex(&package);
    if !actual.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err(format!(
            "Package hash mismatch (expected {}, got {actual})",
            manifest.sha256
        ));
    }

    let staging = std::env::temp_dir().join(format!(
        "aleph-connector-update-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    extract_zip(&package, &staging)?;
    let script = find_install_script(&staging)?;
    let root = script
        .parent()
        .ok_or_else(|| "install.ps1 has no parent".to_string())?
        .to_path_buf();

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &script.to_string_lossy(),
        "-GatewayUrl",
        device_gateway_url,
    ])
    .current_dir(&root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut log = format!("{stdout}\n{stderr}").trim().to_string();

    // Stage a newer Connector binary next to the running exe when present in the package.
    if let Ok(exe) = std::env::current_exe() {
        let packaged = root.join("AlephConnector.exe");
        if packaged.is_file() {
            let pending = exe.with_extension("exe.pending");
            match fs::copy(&packaged, &pending) {
                Ok(_) => {
                    let note = format!(
                        "\nStaged Connector binary at {} — restart Aleph Connector to finish self-update.",
                        pending.display()
                    );
                    log.push_str(&note);
                    let _ = write_restart_hint(&exe, &pending);
                }
                Err(e) => log.push_str(&format!("\nCould not stage Connector exe: {e}")),
            }
        }
    }

    let _ = fs::remove_dir_all(&staging);
    Ok((output.status.success(), log))
}

fn write_restart_hint(current_exe: &Path, pending: &Path) -> Result<(), String> {
    let hint = current_exe.with_extension("update.json");
    let payload = serde_json::json!({
        "pendingPath": pending.to_string_lossy(),
        "targetPath": current_exe.to_string_lossy(),
    });
    let mut f = fs::File::create(hint).map_err(|e| e.to_string())?;
    f.write_all(payload.to_string().as_bytes())
        .map_err(|e| e.to_string())
}

pub fn uninstall_autocad() -> Result<(bool, String), String> {
    let root = install::package_root();
    let script = root.join("uninstall.ps1");
    if !script.exists() {
        return Ok((
            false,
            format!(
                "uninstall.ps1 not found under {}. Package the client or install from a release ZIP first.",
                root.display()
            ),
        ));
    }
    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        &script.to_string_lossy(),
    ])
    .current_dir(&root);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let log = format!("{stdout}\n{stderr}").trim().to_string();
    Ok((output.status.success(), log))
}
