use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn has_install_script(dir: &Path) -> bool {
    dir.join("install.ps1").is_file()
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_packaged_client_inside_resource_directory() {
        let root = std::env::temp_dir().join(format!("aleph-client-path-{}", uuid::Uuid::new_v4()));
        let client = root.join("binaries").join("client");
        std::fs::create_dir_all(&client).unwrap();
        std::fs::write(client.join("install.ps1"), "test").unwrap();
        assert_eq!(super::walk_for_package(&root), Some(client));
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn walk_for_package(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    for _ in 0..14 {
        let d = dir?;
        let client = d.join("binaries").join("client");
        if has_install_script(&client) {
            return Some(client);
        }
        if has_install_script(d) {
            return Some(d.to_path_buf());
        }
        // Packaged client layout: <repo>/dist/client or <repo>/windows/dist/client
        for rel in [
            Path::new("dist").join("client"),
            Path::new("windows").join("dist").join("client"),
        ] {
            let candidate = d.join(&rel);
            if has_install_script(&candidate) {
                return Some(candidate);
            }
        }
        dir = d.parent();
    }
    None
}

/// Folder that contains `install.ps1` (+ bridge / CadAI.bundle) for AutoCAD install.
///
/// Release ZIP: next to `AlephConnector.exe`.
/// `tauri dev`: `windows/scripts/package-client.ps1` → `windows/dist/client` (or env override).
pub fn package_root() -> PathBuf {
    if let Ok(raw) = std::env::var("ALEPH_CLIENT_PACKAGE_DIR") {
        let override_dir = PathBuf::from(raw.trim());
        if has_install_script(&override_dir) {
            return override_dir;
        }
    }

    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd);
    }
    // Compile-time path into the monorepo (works under `tauri dev` / cargo run).
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for start in &starts {
        if let Some(found) = walk_for_package(start) {
            return found;
        }
    }

    starts
        .into_iter()
        .next()
        .unwrap_or_else(|| PathBuf::from("."))
}

pub struct InstallCredentials {
    pub device_id: String,
    pub device_token: String,
    pub token_expires_at: Option<i64>,
}

pub fn install_autocad(
    device_gateway_url: &str,
    credentials: Option<InstallCredentials>,
) -> Result<(bool, String), String> {
    let root = package_root();
    let script = root.join("install.ps1");
    if !script.exists() {
        return Ok((
            false,
            format!(
                "install.ps1 not found (looked under {}).\n\
                 In production it sits beside AlephConnector.exe in the release ZIP.\n\
                 For local `tauri dev`, run once:\n\
                   pwsh ./windows/scripts/package-client.ps1\n\
                 then retry Install (or set ALEPH_CLIENT_PACKAGE_DIR to that package folder).",
                root.display()
            ),
        ));
    }

    let mut args: Vec<String> = vec![
        "-NoProfile".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        script.to_string_lossy().into(),
        "-GatewayUrl".into(),
        device_gateway_url.into(),
    ];
    // Prefer credentials from Connector pair; fall back to on-disk identity.json.
    let creds = credentials.or_else(|| {
        crate::identity::read_identity_file()
            .ok()
            .flatten()
            .and_then(|identity| {
                let token = identity.token.filter(|t| !t.is_empty())?;
                Some(InstallCredentials {
                    device_id: identity.device_id,
                    device_token: token,
                    token_expires_at: identity.token_expires_at,
                })
            })
    });
    if let Some(c) = creds {
        args.push("-DeviceId".into());
        args.push(c.device_id);
        args.push("-DeviceToken".into());
        args.push(c.device_token);
        if let Some(exp) = c.token_expires_at {
            args.push("-TokenExpiresAt".into());
            args.push(exp.to_string());
        }
    } else {
        return Ok((
            false,
            "No device token — start the local runtime (it writes the Bridge credential), then install.".into(),
        ));
    }

    let mut cmd = Command::new("powershell.exe");
    cmd.args(&args).current_dir(&root);
    // Avoid flashing a console window that steals focus while install runs.
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

pub fn resource_dir_hint() -> String {
    package_root().to_string_lossy().into()
}

#[allow(dead_code)]
pub fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())
}
