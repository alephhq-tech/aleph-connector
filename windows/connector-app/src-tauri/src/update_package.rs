//! Authentication and bounded parsing for the signed desktop update archive.
use std::io::{Cursor, Read};

pub const MAX_RELEASE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_INSTALLER_BYTES: u64 = MAX_RELEASE_BYTES;

pub fn verify_package(
    bytes: &[u8],
    signature: &[u8],
    public_key: &[u8],
    latest: &str,
    current: &str,
) -> Result<Vec<u8>, String> {
    let new = semver::Version::parse(latest).map_err(|_| "Invalid release version")?;
    let old = semver::Version::parse(current).map_err(|_| "Invalid installed version")?;
    if !new.pre.is_empty() || !new.build.is_empty() {
        return Err("Prerelease and build metadata are not supported by the stable update channel".into());
    }
    if new <= old {
        return Err("Release is not newer than the installed application".into());
    }
    ring::signature::UnparsedPublicKey::new(
        &ring::signature::RSA_PKCS1_2048_8192_SHA256,
        public_key,
    )
    .verify(bytes, signature)
    .map_err(|_| "Release signature verification failed")?;
    extract_verified_package(bytes, latest)
}

pub fn extract_verified_package(bytes: &[u8], latest: &str) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("Invalid release archive: {e}"))?;
    if archive.len() != 2 {
        return Err("Release archive must contain exactly two files".into());
    }
    let mut installer = None;
    let mut version = None;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_owned();
        if entry.is_dir() || entry.enclosed_name().is_none() {
            return Err("Unsafe release archive entry".into());
        }
        let limit = match name.as_str() {
            "version.txt" if version.is_none() => 128,
            "installer.exe" if installer.is_none() => MAX_INSTALLER_BYTES,
            _ => return Err("Unexpected or duplicate release archive entry".into()),
        };
        if entry.size() > limit {
            return Err("Release archive entry is too large".into());
        }
        let mut contents = Vec::new();
        entry.by_ref().take(limit + 1).read_to_end(&mut contents).map_err(|e| e.to_string())?;
        if contents.len() as u64 > limit {
            return Err("Release archive entry is too large".into());
        }
        if name == "version.txt" {
            version = Some(String::from_utf8(contents).map_err(|_| "Invalid version marker")?);
        } else {
            installer = Some(contents);
        }
    }
    if version.as_deref().map(str::trim) != Some(latest) {
        return Err("Signed release version does not match manifest".into());
    }
    installer.filter(|data| !data.is_empty()).ok_or_else(|| "Release installer is missing".into())
}
