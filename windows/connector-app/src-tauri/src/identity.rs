use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedIdentity {
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<i64>,
}

fn cadai_local() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CadAI")
}

pub fn identity_path() -> PathBuf {
    cadai_local().join("bridge").join("identity.json")
}

pub fn read_identity_file() -> Result<Option<PersistedIdentity>, String> {
    let path = identity_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let identity: PersistedIdentity = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(identity))
}
