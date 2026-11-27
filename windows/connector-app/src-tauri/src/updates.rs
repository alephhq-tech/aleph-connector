use serde::{Deserialize, Serialize};

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::install;

const RELEASE_PUBLIC_KEY: &[u8] = include_bytes!("update-public-key.der");

#[cfg(test)]
fn verify_release_signature(bytes: &[u8], signature: &[u8], key: &[u8]) -> Result<(), String> {
    ring::signature::UnparsedPublicKey::new(&ring::signature::RSA_PKCS1_2048_8192_SHA256, key)
        .verify(bytes, signature)
        .map_err(|_| "Release signature verification failed".to_string())
}

const DEFAULT_MANIFEST_URL: &str = "https://github.com/alephhq-tech/aleph-connector/releases/latest/download/manifest.json";

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
    #[allow(dead_code)]
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
    match (semver::Version::parse(candidate), semver::Version::parse(current)) {
        (Ok(candidate), Ok(current)) => candidate > current,
        _ => false,
    }
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

fn validate_package_url(url: &str, version: &str) -> Result<(), String> {
    let parsed = semver::Version::parse(version).map_err(|_| "Invalid release version")?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        return Err("Only stable releases are supported".into());
    }
    let expected = format!("https://github.com/alephhq-tech/aleph-connector/releases/download/v{version}/connector-update.zip");
    if url != expected {
        return Err("Unexpected GitHub release package URL".into());
    }
    Ok(())
}

fn verify_manifest_package(manifest: &ReleaseManifest, bytes: &[u8], key: &[u8], current: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    validate_package_url(&manifest.package_url, &manifest.latest)?;
    let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
    let actual: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    if !actual.eq_ignore_ascii_case(manifest.sha256.trim()) {
        return Err("Release package SHA-256 mismatch".into());
    }
    let signature = base64::engine::general_purpose::STANDARD.decode(&manifest.signature)
        .map_err(|_| "Invalid release signature encoding")?;
    crate::update_package::verify_package(bytes, &signature, key, &manifest.latest, current)
}

fn manifest_url() -> &'static str {
    DEFAULT_MANIFEST_URL
}

fn evaluate_manifest(manifest: &ReleaseManifest, current: &str) -> UpdateCheck {
    let available = is_newer(&manifest.latest, current);
    UpdateCheck {
        update_available: available,
        channel_available: true,
        latest: Some(manifest.latest.clone()),
        current: current.to_string(),
        package_url: Some(manifest.package_url.clone()),
        message: if available {
            format!(
                "Có bản cập nhật Connector {} → {}. Sau khi cập nhật, cài lại Bridge và plugin kèm theo.",
                current, manifest.latest
            )
        } else {
            format!("Đã cập nhật ({}).", manifest.latest)
        },
    }
}

fn empty_check(current: String) -> UpdateCheck {
    UpdateCheck {
        update_available: false,
        channel_available: false,
        latest: None,
        current,
        package_url: None,
        message: "Kênh cập nhật chưa có bản phát hành nào.".into(),
    }
}

pub fn check_updates() -> Result<UpdateCheck, String> {
    let status = integration_status();
    let current = effective_current_version(&status);
    let manifest = match fetch_manifest()? {
        Some(manifest) => manifest,
        None => return Ok(empty_check(current)),
    };
    validate_package_url(&manifest.package_url, &manifest.latest)?;
    Ok(evaluate_manifest(&manifest, &current))
}

fn download_limited(url: &str, max_bytes: u64) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(15))
        .timeout_read(std::time::Duration::from_secs(60))
        .timeout(std::time::Duration::from_secs(15 * 60))
        .build();
    let response = match agent.get(url).set("User-Agent", "Aleph-Connector-Updater").call() {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(error) => return Err(format!("Update download failed: {error}")),
    };
    if !response.get_url().starts_with("https://") {
        return Err("Update redirected away from HTTPS".into());
    }
    let mut bytes = Vec::new();
    response.into_reader().take(max_bytes + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max_bytes {
        return Err("Update download exceeds size limit".into());
    }
    Ok(Some(bytes))
}

fn fetch_manifest() -> Result<Option<ReleaseManifest>, String> {
    let Some(bytes) = download_limited(manifest_url(), 64 * 1024)? else { return Ok(None) };
    let manifest: ReleaseManifest = serde_json::from_slice(&bytes).map_err(|e| format!("Invalid manifest: {e}"))?;
    validate_package_url(&manifest.package_url, &manifest.latest)?;
    Ok(Some(manifest))
}

fn effective_current_version(_status: &IntegrationStatus) -> String {
    connector_version()
}

#[cfg(test)]
mod security_tests {
    #[test]
    fn authenticates_release_bytes_and_rejects_tampering() {
        let key = include_bytes!("../tests/fixtures/test-public.der");
        let payload = include_bytes!("../tests/fixtures/payload.bin");
        let signature = include_bytes!("../tests/fixtures/payload.sig");
        assert!(super::verify_release_signature(payload, signature, key).is_ok());
        assert!(super::verify_release_signature(b"tampered", signature, key).is_err());
        assert!(super::verify_release_signature(payload, b"invalid", key).is_err());
        assert!(
            super::verify_release_signature(payload, signature, super::RELEASE_PUBLIC_KEY).is_err()
        );
    }

    #[test]
    fn forged_hash_and_signature_are_rejected_before_install() {
        use base64::Engine as _;
        let bytes = include_bytes!("../tests/fixtures/release-fixture.zip");
        let signature = include_bytes!("../tests/fixtures/release-fixture.sig");
        let key = include_bytes!("../tests/fixtures/test-public.der");
        let manifest = super::ReleaseManifest {
            latest: "1.2.3".into(),
            minimum_bridge_version: "1.0.0".into(),
            package_url: "https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip".into(),
            sha256: "garbage".into(),
            signature: base64::engine::general_purpose::STANDARD.encode(signature),
        };
        assert!(super::verify_manifest_package(&manifest, bytes, key, "1.2.2").is_err());
        let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
        let hash: String = digest.as_ref().iter().map(|b| format!("{b:02x}")).collect();
        let mut valid = manifest;
        valid.sha256 = hash;
        assert_eq!(super::verify_manifest_package(&valid, bytes, key, "1.2.2").unwrap(), b"test installer bytes");
        valid.signature = base64::engine::general_purpose::STANDARD.encode(b"attacker");
        assert!(super::verify_manifest_package(&valid, bytes, key, "1.2.2").is_err());
    }

    #[test]
    fn only_accepts_expected_github_release_assets() {
        assert!(super::validate_package_url("https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip", "1.2.3").is_ok());
        assert!(super::validate_package_url("https://github.com/evil/aleph-connector/releases/download/v1.2.3/connector-update.zip", "1.2.3").is_err());
        assert!(super::validate_package_url("http://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip", "1.2.3").is_err());
        assert!(super::validate_package_url("https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.2/connector-update.zip", "1.2.3").is_err());
    }

}

#[cfg(test)]
mod check_tests {
    use super::*;

    fn manifest(latest: &str) -> ReleaseManifest {
        ReleaseManifest {
            latest: latest.into(),
            minimum_bridge_version: "1.0.0".into(),
            package_url: format!(
                "https://github.com/alephhq-tech/aleph-connector/releases/download/v{latest}/connector-update.zip"
            ),
            sha256: "0".repeat(64),
            signature: "AAAA".into(),
        }
    }

    #[test]
    fn reports_update_when_release_is_newer() {
        let check = evaluate_manifest(&manifest("1.2.3"), "1.2.2");
        assert!(check.update_available);
        assert!(check.channel_available);
        assert_eq!(check.latest.as_deref(), Some("1.2.3"));
        assert_eq!(check.current, "1.2.2");
        assert_eq!(
            check.package_url.as_deref(),
            Some("https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip")
        );
        assert!(check.message.contains("1.2.2"));
        assert!(check.message.contains("1.2.3"));
    }

    #[test]
    fn reports_up_to_date_when_release_matches_or_is_older() {
        let same = evaluate_manifest(&manifest("1.2.3"), "1.2.3");
        assert!(!same.update_available);
        assert!(same.channel_available);
        assert!(same.message.contains("Đã cập nhật"));
        let older = evaluate_manifest(&manifest("1.2.2"), "1.2.3");
        assert!(!older.update_available);
        assert!(older.channel_available);
    }

    #[test]
    fn empty_channel_has_no_latest_or_url() {
        let check = empty_check("1.2.2".to_string());
        assert!(!check.update_available);
        assert!(!check.channel_available);
        assert_eq!(check.latest, None);
        assert_eq!(check.current, "1.2.2");
        assert_eq!(check.package_url, None);
        assert!(check.message.contains("Kênh cập nhật"));
    }

    #[test]
    fn is_newer_ignores_invalid_manifests() {
        assert!(!is_newer("not-a-version", "1.2.2"));
        assert!(!is_newer("1.2.3", "not-a-version"));
        assert!(!is_newer("1.2.2", "1.2.3"));
        assert!(is_newer("1.2.3", "1.2.2"));
    }

    #[test]
    fn manifest_from_json_round_trips_and_validates_url() {
        let json = r#"{"latest":"1.2.3","minimumBridgeVersion":"1.0.0","packageUrl":"https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip","sha256":"0","signature":"AAAA"}"#;
        let parsed: ReleaseManifest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.latest, "1.2.3");
        assert_eq!(parsed.package_url, "https://github.com/alephhq-tech/aleph-connector/releases/download/v1.2.3/connector-update.zip");
        validate_package_url(&parsed.package_url, &parsed.latest).unwrap();
        let bad = r#"{"latest":"1.2.3","minimumBridgeVersion":"1.0.0","packageUrl":"https://example.com/connector-update.zip","sha256":"0","signature":"AAAA"}"#;
        let bad: ReleaseManifest = serde_json::from_str(bad).unwrap();
        assert!(validate_package_url(&bad.package_url, &bad.latest).is_err());
    }

}

pub fn prepare_update() -> Result<PathBuf, String> {
    let manifest = fetch_manifest()?.ok_or("Hiện chưa có bản phát hành nào.")?;
    if !is_newer(&manifest.latest, &connector_version()) {
        return Err("Không có bản phát hành Connector mới hơn.".into());
    }
    let bytes = download_limited(&manifest.package_url, crate::update_package::MAX_RELEASE_BYTES)?
        .ok_or("Release archive not found")?;
    let installer = verify_manifest_package(&manifest, &bytes, RELEASE_PUBLIC_KEY, &connector_version())?;
    let dir = std::env::temp_dir().join(format!("aleph-connector-update-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).map_err(|e| format!("Cannot create update directory: {e}"))?;
    let path = dir.join("connector-setup.exe");
    if let Err(error) = fs::write(&path, installer) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("Cannot stage update installer: {error}"));
    }
    Ok(path)
}

pub fn launch_installer(path: &Path) -> Result<(), String> {
    Command::new(path).spawn().map(|_| ()).map_err(|e| format!("Cannot launch update installer: {e}"))
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
