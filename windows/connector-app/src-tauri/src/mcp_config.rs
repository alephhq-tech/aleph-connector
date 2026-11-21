use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

pub fn write_mcp_config(kind: &str, config_path: &str, mcp_url: &str) -> Result<String, String> {
    let server_name = "aleph-connector";
    match kind {
        "cursor" => write_cursor_like(config_path, mcp_url, server_name, "mcpServers"),
        "antigravity" => write_antigravity(config_path, mcp_url, server_name),
        "vsCode" => write_vscode(config_path, mcp_url, server_name),
        "claudeDesktop" => write_claude_desktop(config_path, mcp_url, server_name),
        "claudeCode" => write_claude_code(mcp_url, server_name),
        "codexCli" => write_codex_hint(config_path, mcp_url, server_name),
        _ => Err(format!("Unknown agent kind: {kind}")),
    }
}

fn read_object(path: &Path) -> Value {
    if !path.exists() {
        return json!({});
    }
    let text = fs::read_to_string(path).unwrap_or_default();
    if text.trim().is_empty() {
        return json!({});
    }
    serde_json::from_str(&text).unwrap_or_else(|_| json!({}))
}

fn write_cursor_like(
    path: &str,
    mcp_url: &str,
    server_name: &str,
    key: &str,
) -> Result<String, String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = read_object(path);
    let obj = root.as_object_mut().ok_or("Invalid JSON root")?;
    let servers = obj.entry(key).or_insert_with(|| json!({}));
    let map = servers.as_object_mut().ok_or("Invalid servers object")?;
    map.insert(server_name.to_string(), json!({ "url": mcp_url }));
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

/// Antigravity uses `serverUrl` (not Cursor's `url`) under `mcpServers`.
fn write_antigravity(path: &str, mcp_url: &str, server_name: &str) -> Result<String, String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = read_object(path);
    let obj = root.as_object_mut().ok_or("Invalid JSON root")?;
    let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
    let map = servers.as_object_mut().ok_or("Invalid servers object")?;
    map.insert(server_name.to_string(), json!({ "serverUrl": mcp_url }));
    fs::write(
        path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

fn write_vscode(path: &str, mcp_url: &str, server_name: &str) -> Result<String, String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = read_object(path);
    let obj = root.as_object_mut().ok_or("Invalid JSON root")?;
    let servers = obj.entry("servers").or_insert_with(|| json!({}));
    let map = servers.as_object_mut().ok_or("Invalid servers object")?;
    map.insert(
        server_name.to_string(),
        json!({ "type": "http", "url": mcp_url }),
    );
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

fn write_claude_desktop(path: &str, mcp_url: &str, server_name: &str) -> Result<String, String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut root = read_object(path);
    let obj = root.as_object_mut().ok_or("Invalid JSON root")?;
    let servers = obj.entry("mcpServers").or_insert_with(|| json!({}));
    let map = servers.as_object_mut().ok_or("Invalid servers object")?;
    map.insert(
        server_name.to_string(),
        json!({
            "command": "npx",
            "args": ["-y", "mcp-remote", mcp_url]
        }),
    );
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

fn write_claude_code(mcp_url: &str, server_name: &str) -> Result<String, String> {
    let output = Command::new("claude")
        .args(["mcp", "add", "--transport", "http", server_name, mcp_url])
        .output()
        .map_err(|e| format!("Failed to start claude CLI: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("claude mcp add failed: {stderr}\n{stdout}"));
    }
    Ok("claude mcp add (CLI)".into())
}

fn write_codex_hint(path: &str, mcp_url: &str, server_name: &str) -> Result<String, String> {
    let path = Path::new(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let snippet = format!(
        "\n# Aleph MCP (added by Aleph Connector)\n# Configure HTTP MCP `{server_name}` -> {mcp_url}\n# See docs/CLIENTS.md\n"
    );
    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(snippet.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}
