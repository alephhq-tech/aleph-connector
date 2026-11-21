//! Deploy AGENTS.md + skills from packages/agent-pack (or bundled agent-pack/) into agent clients.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstallResult {
    pub kind: String,
    pub paths: Vec<String>,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {e}", dst.display()))?;
    for entry in fs::read_dir(src).map_err(|e| format!("read {}: {e}", src.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dest)?;
        } else {
            // Overwrite in place — never require deleting a locked destination tree first
            // (Antigravity often holds ~/.gemini/config/plugins/aleph-connector open).
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
            }
            fs::copy(entry.path(), &dest)
                .map_err(|e| format!("copy {} → {}: {e}", entry.path().display(), dest.display()))?;
        }
    }
    Ok(())
}

/// Best-effort remove; ignore lock errors (os error 32) so install can overwrite instead.
fn try_remove_dir_all(path: &Path) {
    if !path.exists() {
        return;
    }
    let _ = fs::remove_dir_all(path);
}

fn write_text(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Resolve the agent-pack directory (plugin.json + AGENTS.md + skills/).
pub fn resolve_pack_root() -> Result<PathBuf, String> {
    if let Ok(raw) = std::env::var("ALEPH_AGENT_PACK_DIR") {
        let p = PathBuf::from(raw.trim());
        if p.join("plugin.json").is_file() {
            return Ok(p);
        }
    }

    let mut starts: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            starts.push(parent.to_path_buf());
            starts.push(parent.join("agent-pack"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        starts.push(cwd.clone());
        starts.push(cwd.join("agent-pack"));
        starts.push(cwd.join("packages").join("agent-pack"));
    }
    starts.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")));

    for start in &starts {
        // Walk up looking for packages/agent-pack or sibling agent-pack next to install.ps1.
        let mut dir = Some(start.as_path());
        for _ in 0..16 {
            let d = match dir {
                Some(d) => d,
                None => break,
            };
            for candidate in [
                d.join("agent-pack"),
                d.join("packages").join("agent-pack"),
                d.to_path_buf(),
            ] {
                if candidate.join("plugin.json").is_file()
                    && candidate.join("skills").is_dir()
                {
                    return Ok(candidate);
                }
            }
            // Packaged client: dist/client/agent-pack
            let packaged = d.join("dist").join("client").join("agent-pack");
            if packaged.join("plugin.json").is_file() {
                return Ok(packaged);
            }
            let packaged_win = d.join("windows").join("dist").join("client").join("agent-pack");
            if packaged_win.join("plugin.json").is_file() {
                return Ok(packaged_win);
            }
            dir = d.parent();
        }
    }

    Err(
        "agent-pack not found (expected packages/agent-pack with plugin.json + skills/, or agent-pack/ next to AlephConnector.exe)"
            .into(),
    )
}

fn list_skill_dirs(pack: &Path) -> Result<Vec<PathBuf>, String> {
    let skills = pack.join("skills");
    if !skills.is_dir() {
        return Err(format!("missing skills dir: {}", skills.display()));
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&skills).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            out.push(entry.path());
        }
    }
    out.sort();
    Ok(out)
}

fn agents_md(pack: &Path) -> Result<String, String> {
    let p = pack.join("AGENTS.md");
    fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

fn plugin_json(pack: &Path) -> Result<String, String> {
    let p = pack.join("plugin.json");
    fs::read_to_string(&p).map_err(|e| format!("read {}: {e}", p.display()))
}

fn copy_skills_into(dest_skills_root: &Path, skill_dirs: &[PathBuf]) -> Result<Vec<String>, String> {
    let mut written = Vec::new();
    fs::create_dir_all(dest_skills_root)
        .map_err(|e| format!("mkdir {}: {e}", dest_skills_root.display()))?;
    for src in skill_dirs {
        let name = src
            .file_name()
            .ok_or_else(|| "skill dir has no name".to_string())?;
        let dest = dest_skills_root.join(name);
        // Prefer merge/overwrite; try_remove only when nothing has the folder open.
        try_remove_dir_all(&dest);
        copy_dir_all(src, &dest)?;
        written.push(dest.to_string_lossy().into());
    }
    Ok(written)
}

/// Install pack into one agent kind. Returns paths written.
pub fn install_for_kind(kind: &str, pack: &Path) -> Result<PackInstallResult, String> {
    let skill_dirs = list_skill_dirs(pack)?;
    let agents = agents_md(pack)?;
    let plugin = plugin_json(pack)?;
    let home = home();
    let mut paths: Vec<String> = Vec::new();

    match kind {
        "cursor" => {
            let skills_root = home.join(".cursor").join("skills");
            paths.extend(copy_skills_into(&skills_root, &skill_dirs)?);
            let rule = home.join(".cursor").join("rules").join("aleph-connector.mdc");
            let body = format!(
                "---\ndescription: Aleph Connector AutoCAD + PCCC\nglobs:\nalwaysApply: true\n---\n\n{agents}\n"
            );
            write_text(&rule, &body)?;
            paths.push(rule.to_string_lossy().into());
            let agents_path = home.join(".cursor").join("AGENTS.aleph-connector.md");
            write_text(&agents_path, &agents)?;
            paths.push(agents_path.to_string_lossy().into());
        }
        "antigravity" => {
            let plugin_root = home
                .join(".gemini")
                .join("config")
                .join("plugins")
                .join("aleph-connector");
            // Antigravity often locks this folder while running — overwrite in place, do not
            // fail the whole install on remove_dir_all (os error 32).
            try_remove_dir_all(&plugin_root);
            fs::create_dir_all(&plugin_root)
                .map_err(|e| format!("mkdir {}: {e}", plugin_root.display()))?;
            write_text(&plugin_root.join("plugin.json"), &plugin)?;
            paths.push(plugin_root.join("plugin.json").to_string_lossy().into());
            write_text(&plugin_root.join("AGENTS.md"), &agents)?;
            paths.push(plugin_root.join("AGENTS.md").to_string_lossy().into());
            let skills_dest = plugin_root.join("skills");
            paths.extend(copy_skills_into(&skills_dest, &skill_dirs)?);
            // Keep a global skills mirror so agents that only scan ~/.gemini/config/skills find them.
            let global_skills = home.join(".gemini").join("config").join("skills");
            paths.extend(copy_skills_into(&global_skills, &skill_dirs)?);
        }
        "claudeDesktop" | "claudeCode" => {
            let skills_root = home.join(".claude").join("skills");
            paths.extend(copy_skills_into(&skills_root, &skill_dirs)?);
            let agents_path = home.join(".claude").join("AGENTS.aleph-connector.md");
            write_text(&agents_path, &agents)?;
            paths.push(agents_path.to_string_lossy().into());
        }
        "vsCode" => {
            let skills_root = home.join(".vscode").join("skills").join("aleph-connector");
            paths.extend(copy_skills_into(&skills_root, &skill_dirs)?);
            let agents_path = home.join(".vscode").join("AGENTS.aleph-connector.md");
            write_text(&agents_path, &agents)?;
            paths.push(agents_path.to_string_lossy().into());
        }
        "codexCli" => {
            let skills_root = home.join(".codex").join("skills");
            paths.extend(copy_skills_into(&skills_root, &skill_dirs)?);
            let agents_path = home.join(".codex").join("AGENTS.aleph-connector.md");
            write_text(&agents_path, &agents)?;
            paths.push(agents_path.to_string_lossy().into());
            // Codex often reads AGENTS.md from the project; also drop a home-level copy.
            let home_agents = home.join(".codex").join("AGENTS.md");
            if !home_agents.exists() {
                write_text(&home_agents, &agents)?;
                paths.push(home_agents.to_string_lossy().into());
            }
        }
        other => {
            return Err(format!("unknown agent kind for pack install: {other}"));
        }
    }

    Ok(PackInstallResult {
        kind: kind.to_string(),
        paths,
    })
}

/// Install MCP config (caller) then agent pack for each selected agent.
pub fn install_pack_for_kinds(kinds: &[String]) -> Result<Vec<PackInstallResult>, String> {
    let pack = resolve_pack_root()?;
    let mut results = Vec::new();
    for kind in kinds {
        results.push(install_for_kind(kind, &pack)?);
    }
    Ok(results)
}
