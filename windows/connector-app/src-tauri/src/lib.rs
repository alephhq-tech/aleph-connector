mod agent_pack;
mod agents;
mod identity;
mod install;
mod mcp_config;
mod updates;

use agents::DetectedAgent;
use identity::AuthSession;
use tauri::Manager;
use updates::{IntegrationStatus, UpdateCheck};

#[tauri::command]
fn detect_agents() -> Vec<DetectedAgent> {
    agents::detect_all()
}

#[tauri::command]
fn write_mcp_config(kind: String, config_path: String, mcp_url: String) -> Result<String, String> {
    mcp_config::write_mcp_config(&kind, &config_path, &mcp_url)
}

/// Deploy AGENTS.md + skills into agent client directories (after MCP config is written).
#[tauri::command]
fn install_agent_pack(kinds: Vec<String>) -> Result<Vec<agent_pack::PackInstallResult>, String> {
    agent_pack::install_pack_for_kinds(&kinds)
}

#[tauri::command]
async fn install_autocad(
    device_gateway_url: String,
    device_id: Option<String>,
    device_token: Option<String>,
    token_expires_at: Option<i64>,
) -> Result<(bool, String), String> {
    let credentials = match (device_id, device_token) {
        (Some(device_id), Some(device_token))
            if !device_id.trim().is_empty() && !device_token.trim().is_empty() =>
        {
            Some(install::InstallCredentials {
                device_id,
                device_token,
                token_expires_at,
            })
        }
        _ => None,
    };
    // PowerShell install can take minutes — never block the UI/IPC thread.
    tauri::async_runtime::spawn_blocking(move || {
        install::install_autocad(&device_gateway_url, credentials)
    })
    .await
    .map_err(|e| format!("install task join failed: {e}"))?
}

#[tauri::command]
async fn uninstall_autocad() -> Result<(bool, String), String> {
    tauri::async_runtime::spawn_blocking(updates::uninstall_autocad)
        .await
        .map_err(|e| format!("uninstall task join failed: {e}"))?
}

#[tauri::command]
fn integration_status() -> IntegrationStatus {
    updates::integration_status()
}

#[tauri::command]
async fn check_updates() -> Result<UpdateCheck, String> {
    tauri::async_runtime::spawn_blocking(updates::check_updates)
        .await
        .map_err(|e| format!("update check join failed: {e}"))?
}

#[tauri::command]
async fn apply_update(device_gateway_url: String) -> Result<(bool, String), String> {
    tauri::async_runtime::spawn_blocking(move || updates::apply_update(&device_gateway_url))
        .await
        .map_err(|e| format!("update task join failed: {e}"))?
}

#[tauri::command]
fn package_root() -> String {
    install::resource_dir_hint()
}

#[tauri::command]
fn ensure_device_id() -> Result<String, String> {
    identity::ensure_device_id()
}

#[tauri::command]
fn write_identity(
    device_id: String,
    token: String,
    expires_at: i64,
) -> Result<(), String> {
    identity::write_identity(&device_id, Some(&token), Some(expires_at))
}

#[tauri::command]
fn save_session(session: AuthSession) -> Result<(), String> {
    identity::save_session(&session)
}

#[tauri::command]
fn load_session() -> Result<Option<AuthSession>, String> {
    identity::load_session()
}

#[tauri::command]
fn clear_session() -> Result<(), String> {
    identity::clear_session()
}

#[tauri::command]
fn default_urls() -> (String, String) {
    let gateway = std::env::var("ALEPH_GATEWAY_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8090".into());
    let mcp = std::env::var("ALEPH_MCP_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:8080/mcp".into());
    (gateway, mcp)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Must be first so deep-link argv from a second process is forwarded here.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
                let _ = win.unminimize();
                let _ = win.show();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                // Dev builds: register scheme so browser "Open Aleph Connector" hits this process.
                #[cfg(any(windows, target_os = "linux"))]
                {
                    let _ = app.deep_link().register_all();
                }
                // Frontend listens via @tauri-apps/plugin-deep-link (onOpenUrl / getCurrent).
                // Focus when a deep link arrives while already running.
                app.deep_link().on_open_url(move |_event| {
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.set_focus();
                        let _ = win.unminimize();
                        let _ = win.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            detect_agents,
            write_mcp_config,
            install_agent_pack,
            install_autocad,
            uninstall_autocad,
            integration_status,
            check_updates,
            apply_update,
            package_root,
            ensure_device_id,
            write_identity,
            save_session,
            load_session,
            clear_session,
            default_urls
        ])
        .run(tauri::generate_context!())
        .expect("error while running Aleph Connector");
}
