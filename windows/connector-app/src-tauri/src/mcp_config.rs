use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::process::Command;

const SERVER_NAME: &str = "aleph-connector";

/// `stdio_exe` is the bundled stdio bridge exe, required by hosts that can only spawn
/// a stdio server (Claude Desktop). The local runtime itself needs no credential.
pub fn write_mcp_config(
    kind: &str,
    config_path: &str,
    mcp_url: &str,
    stdio_exe: Option<&str>,
) -> Result<String, String> {
    match kind {
        "cursor" => write_cursor_like(config_path, mcp_url, "mcpServers"),
        "antigravity" => write_antigravity(config_path, mcp_url),
        "vsCode" => write_vscode(config_path, mcp_url),
        "claudeDesktop" => write_claude_desktop(config_path, mcp_url, stdio_exe),
        "claudeCode" => write_claude_code(mcp_url),
        "codexCli" => write_codex(config_path, mcp_url),
        _ => Err(format!("Unknown agent kind: {kind}")),
    }
}

/// Parses the config as a JSON object. A file that exists, is non-empty, and fails to
/// parse is refused — never silently clobbered.
fn read_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(&text).map_err(|_| format!("{} is not valid JSON; refusing to overwrite it", path.display()))
}

/// Copies the current file to `<path>.bak` before the first write of this run.
/// Re-runs overwrite the backup (the pre-this-run state is what matters).
fn back_up(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() == 0 {
        return Ok(());
    }
    let bak = path.with_extension(format!(
        "{}.bak",
        path.extension().and_then(|e| e.to_str()).unwrap_or("bak")
    ));
    fs::copy(path, &bak).map_err(|e| e.to_string())?;
    Ok(())
}

/// Removes and returns the object at `key`, creating it when absent. A non-object
/// value there is refused rather than overwritten.
fn take_object(
    obj: &mut serde_json::Map<String, Value>,
    key: &str,
) -> Result<serde_json::Map<String, Value>, String> {
    match obj.remove(key) {
        None => Ok(serde_json::Map::new()),
        Some(Value::Object(map)) => Ok(map),
        Some(_) => Err(format!("`{key}` is not an object; refusing to overwrite it")),
    }
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn write_json_root(
    path_str: &str,
    insert: impl FnOnce(&mut serde_json::Map<String, Value>) -> Result<(), String>,
) -> Result<String, String> {
    let path = Path::new(path_str);
    ensure_parent(path)?;
    let mut root = read_object(path)?;
    let obj = root.as_object_mut().ok_or("Invalid JSON root")?;
    insert(obj)?;
    back_up(path)?;
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?),
    )
    .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}

fn write_cursor_like(path: &str, mcp_url: &str, key: &str) -> Result<String, String> {
    write_json_root(path, move |obj| {
        let mut servers = take_object(obj, key)?;
        servers.insert(SERVER_NAME.to_string(), json!({ "url": mcp_url }));
        obj.insert(key.to_string(), Value::Object(servers));
        Ok(())
    })
}

/// Antigravity uses `serverUrl` (not Cursor's `url`) under `mcpServers`.
fn write_antigravity(path: &str, mcp_url: &str) -> Result<String, String> {
    write_json_root(path, move |obj| {
        let mut servers = take_object(obj, "mcpServers")?;
        servers.insert(SERVER_NAME.to_string(), json!({ "serverUrl": mcp_url }));
        obj.insert("mcpServers".to_string(), Value::Object(servers));
        Ok(())
    })
}

fn write_vscode(path: &str, mcp_url: &str) -> Result<String, String> {
    write_json_root(path, move |obj| {
        let mut servers = take_object(obj, "servers")?;
        servers.insert(
            SERVER_NAME.to_string(),
            json!({ "type": "http", "url": mcp_url }),
        );
        obj.insert("servers".to_string(), Value::Object(servers));
        Ok(())
    })
}

/// Claude Desktop gets the bundled stdio bridge exe — no npx, no network fetch.
fn write_claude_desktop(path: &str, mcp_url: &str, stdio_exe: Option<&str>) -> Result<String, String> {
    let exe = stdio_exe
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("Claude Desktop needs the bundled stdio bridge (aleph-mcp-stdio.exe); it is missing from this install")?;
    write_json_root(path, move |obj| {
        let mut servers = take_object(obj, "mcpServers")?;
        servers.insert(SERVER_NAME.to_string(), json!({ "command": exe, "env": { "AUTOCAD_MCP_URL": mcp_url } }));
        obj.insert("mcpServers".to_string(), Value::Object(servers));
        Ok(())
    })
}

fn write_claude_code(mcp_url: &str) -> Result<String, String> {
    let output = Command::new("claude")
        .args(["mcp", "add", "--transport", "http", SERVER_NAME, mcp_url])
        .output()
        .map_err(|e| format!("Failed to start claude CLI: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!("claude mcp add failed: {stderr}\n{stdout}"));
    }
    Ok("claude mcp add (CLI)".into())
}

/// True for our own block header: `[mcp_servers."aleph-connector"]` (whitespace-tolerant).
fn is_own_codex_header(line: &str) -> bool {
    let trimmed = line.trim();
    let inner = match trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        Some(inner) => inner.trim(),
        None => return false,
    };
    let rest = match inner.strip_prefix("mcp_servers") {
        Some(rest) => rest.trim_start(),
        None => return false,
    };
    let rest = match rest.strip_prefix('.') {
        Some(rest) => rest.trim_start(),
        None => return false,
    };
    matches!(rest, "\"aleph-connector\"" | "'aleph-connector'" | "aleph-connector")
}

/// True for any `[mcp_servers.…]` header line (ours or foreign).
fn is_mcp_servers_header(line: &str) -> bool {
    let trimmed = line.trim();
    let inner = match trimmed.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        Some(inner) => inner.trim(),
        None => return false,
    };
    inner.starts_with("mcp_servers")
}

/// Real Codex TOML entry: replace our own `[mcp_servers."aleph-connector"]` block
/// (header through the next `[` header or EOF), keep everything else, append fresh.
/// Refuses when an `[mcp_servers.` line cannot be delimited — never writes on parse doubt.
fn write_codex(path: &str, mcp_url: &str) -> Result<String, String> {
    let path = Path::new(path);
    ensure_parent(path)?;
    let original = if path.exists() {
        fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    // Parse doubt: an `[mcp_servers.` line that is neither a closed header we can delimit
    // nor inside a string we can reason about. Quote parity per line decides.
    for line in original.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[mcp_servers") && !is_mcp_servers_header(trimmed) {
            return Err(format!(
                "{} has an mcp_servers header this writer cannot delimit; edit it by hand",
                path.display()
            ));
        }
    }

    let mut kept: Vec<&str> = Vec::new();
    let lines: Vec<&str> = original.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if is_own_codex_header(line) {
            // Skip the whole own block: header through the next header line or EOF.
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with('[') {
                i += 1;
            }
            continue;
        }
        kept.push(line);
        i += 1;
    }

    while kept.last().is_some_and(|l| l.trim().is_empty()) {
        kept.pop();
    }
    let mut out = kept.join("\n");
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&format!(
        "[mcp_servers.\"{SERVER_NAME}\"]\nurl = \"{mcp_url}\"\n"
    ));

    back_up(path)?;
    fs::write(path, out).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}
#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("aleph-mcpcfg-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn codex_writer_appends_block_to_fresh_file() {
        let dir = temp_dir("codex-fresh");
        let path = dir.join("config.toml");
        write_mcp_config("codexCli", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("[mcp_servers.\"aleph-connector\"]"));
        assert!(text.contains("url = \"http://127.0.0.1:8080/mcp\""));
    }

    #[test]
    fn codex_writer_replaces_only_own_block() {
        let dir = temp_dir("codex-replace");
        let path = dir.join("config.toml");
        let original = "model = \"gpt\"\n[mcp_servers.other]\nurl = \"http://keep.me\"\n[mcp_servers.\"aleph-connector\"]\nurl = \"http://old\"\nenabled = true\n[features]\nx = 1\n";
        fs::write(&path, original).unwrap();
        write_mcp_config("codexCli", path.to_str().unwrap(), "http://127.0.0.1:9090/mcp", None).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("url = \"http://127.0.0.1:9090/mcp\""));
        assert!(!text.contains("http://old"));
        assert!(!text.contains("enabled = true"));
        assert!(text.contains("[mcp_servers.other]"));
        assert!(text.contains("http://keep.me"));
        assert!(text.contains("[features]"));
        assert!(text.contains("model = \"gpt\""));
    }

    #[test]
    fn codex_writer_is_idempotent() {
        let dir = temp_dir("codex-idem");
        let path = dir.join("config.toml");
        write_mcp_config("codexCli", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None).unwrap();
        write_mcp_config("codexCli", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("[mcp_servers.\"aleph-connector\"]").count(), 1);
    }

    #[test]
    fn writers_back_up_existing_file() {
        let dir = temp_dir("backup");
        let path = dir.join("mcp.json");
        fs::write(&path, "{\"keep\": 1}").unwrap();
        write_mcp_config("cursor", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None).unwrap();
        let bak = fs::read_to_string(dir.join("mcp.json.bak")).unwrap();
        assert_eq!(bak, "{\"keep\": 1}");
    }

    #[test]
    fn claude_desktop_uses_configured_runtime_url() {
        let dir = temp_dir("claude-port");
        let path = dir.join("claude_desktop_config.json");
        write_mcp_config("claudeDesktop", path.to_str().unwrap(), "http://127.0.0.1:39447/mcp", Some("C:\\CadAI\\aleph-mcp-stdio.exe")).unwrap();
        let doc: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["aleph-connector"]["env"]["AUTOCAD_MCP_URL"], "http://127.0.0.1:39447/mcp");
    }

    #[test]
    fn claude_desktop_uses_bundled_stdio_exe() {
        let dir = temp_dir("claude");
        let path = dir.join("claude_desktop_config.json");
        let err = write_mcp_config("claudeDesktop", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None);
        assert!(err.is_err());
        write_mcp_config(
            "claudeDesktop",
            path.to_str().unwrap(),
            "http://127.0.0.1:8080/mcp",
            Some("C:\\CadAI\\aleph-mcp-stdio.exe"),
        )
        .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("aleph-mcp-stdio.exe"));
        assert!(!text.contains("npx"));
    }

    #[test]
    fn malformed_json_config_is_refused_unchanged() {
        let dir = temp_dir("malformed");
        let path = dir.join("mcp.json");
        fs::write(&path, "{ this is not json").unwrap();
        let result = write_mcp_config("cursor", path.to_str().unwrap(), "http://127.0.0.1:8080/mcp", None);
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ this is not json");
    }
}
