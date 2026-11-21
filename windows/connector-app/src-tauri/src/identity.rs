use serde::de::{self, Deserializer, Visitor};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

fn deserialize_i64_lenient<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    struct I64Lenient;
    impl<'de> Visitor<'de> for I64Lenient {
        type Value = i64;
        fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
            f.write_str("i64 or numeric string")
        }
        fn visit_i64<E: de::Error>(self, v: i64) -> Result<i64, E> {
            Ok(v)
        }
        fn visit_u64<E: de::Error>(self, v: u64) -> Result<i64, E> {
            i64::try_from(v).map_err(E::custom)
        }
        fn visit_f64<E: de::Error>(self, v: f64) -> Result<i64, E> {
            Ok(v as i64)
        }
        fn visit_str<E: de::Error>(self, v: &str) -> Result<i64, E> {
            v.trim().parse().map_err(E::custom)
        }
    }
    deserializer.deserialize_any(I64Lenient)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedIdentity {
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub session_token: String,
    #[serde(deserialize_with = "deserialize_i64_lenient")]
    pub expires_at: i64,
    pub user: AuthUser,
    pub workspace_id: String,
    pub workspace_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub id: String,
    pub email: String,
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

pub fn session_path() -> PathBuf {
    cadai_local().join("connector").join("session.json")
}

pub fn ensure_device_id() -> Result<String, String> {
    let path = identity_path();
    if path.exists() {
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(existing) = serde_json::from_str::<PersistedIdentity>(&text) {
                if !existing.device_id.is_empty() {
                    return Ok(existing.device_id);
                }
            }
        }
    }
    let device_id = format!("device_{}", Uuid::new_v4().simple());
    write_identity(&device_id, None, None)?;
    Ok(device_id)
}

pub fn write_identity(
    device_id: &str,
    token: Option<&str>,
    expires_at: Option<i64>,
) -> Result<(), String> {
    let path = identity_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let payload = PersistedIdentity {
        device_id: device_id.to_string(),
        token: token.map(|s| s.to_string()),
        token_expires_at: expires_at,
    };
    fs::write(
        &path,
        serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn save_session(session: &AuthSession) -> Result<(), String> {
    let path = session_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(session).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn load_session() -> Result<Option<AuthSession>, String> {
    let path = session_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let session: AuthSession = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    if session.expires_at > 0 && session.expires_at < now {
        return Ok(None);
    }
    Ok(Some(session))
}

pub fn clear_session() -> Result<(), String> {
    let path = session_path();
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
