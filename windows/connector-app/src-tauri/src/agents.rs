use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    pub kind: String,
    pub display_name: String,
    pub config_path: String,
    pub present: bool,
    pub selected: bool,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn local_app_data() -> PathBuf {
    dirs::data_local_dir().unwrap_or_else(|| home().join("AppData").join("Local"))
}

fn app_data() -> PathBuf {
    dirs::data_dir().unwrap_or_else(|| home().join("AppData").join("Roaming"))
}

fn command_exists(name: &str) -> bool {
    Command::new("where.exe")
        .arg(name)
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

fn path_exists(p: &Path) -> bool {
    p.exists()
}

pub fn detect_all() -> Vec<DetectedAgent> {
    let home = home();
    let local = local_app_data();
    let roaming = app_data();

    let cursor_cfg = home.join(".cursor").join("mcp.json");
    let cursor_present = path_exists(&cursor_cfg)
        || path_exists(&local.join("Programs").join("cursor"))
        || path_exists(&local.join("cursor"))
        || command_exists("cursor");

    let claude_cfg = roaming.join("Claude").join("claude_desktop_config.json");
    let claude_present = path_exists(&claude_cfg)
        || path_exists(&roaming.join("Claude"))
        || path_exists(&local.join("AnthropicClaude"));

    let claude_code_hint = home.join(".claude.json");
    let claude_code_present = command_exists("claude");

    let vscode_cfg = home.join(".vscode").join("mcp.json");
    let vscode_present = path_exists(&vscode_cfg)
        || path_exists(&local.join("Programs").join("Microsoft VS Code"))
        || command_exists("code");

    let codex_cfg = home.join(".codex").join("config.toml");
    let codex_present = path_exists(&codex_cfg) || command_exists("codex");

    // Google Antigravity — global MCP at ~/.gemini/config/mcp_config.json (serverUrl).
    let antigravity_cfg = home.join(".gemini").join("config").join("mcp_config.json");
    let antigravity_present = path_exists(&antigravity_cfg)
        || path_exists(&home.join(".gemini").join("antigravity"))
        || path_exists(&local.join("Programs").join("Antigravity"))
        || path_exists(&roaming.join("Antigravity"))
        || command_exists("antigravity");

    vec![
        DetectedAgent {
            kind: "cursor".into(),
            display_name: "Cursor".into(),
            config_path: cursor_cfg.to_string_lossy().into(),
            present: cursor_present,
            selected: cursor_present,
        },
        DetectedAgent {
            kind: "antigravity".into(),
            display_name: "Antigravity".into(),
            config_path: antigravity_cfg.to_string_lossy().into(),
            present: antigravity_present,
            selected: antigravity_present,
        },
        DetectedAgent {
            kind: "claudeDesktop".into(),
            display_name: "Claude Desktop".into(),
            config_path: claude_cfg.to_string_lossy().into(),
            present: claude_present,
            selected: false,
        },
        DetectedAgent {
            kind: "claudeCode".into(),
            display_name: "Claude Code".into(),
            config_path: claude_code_hint.to_string_lossy().into(),
            present: claude_code_present,
            selected: false,
        },
        DetectedAgent {
            kind: "vsCode".into(),
            display_name: "VS Code".into(),
            config_path: vscode_cfg.to_string_lossy().into(),
            present: vscode_present,
            selected: vscode_present,
        },
        DetectedAgent {
            kind: "codexCli".into(),
            display_name: "Codex CLI".into(),
            config_path: codex_cfg.to_string_lossy().into(),
            present: codex_present,
            selected: false,
        },
    ]
}
