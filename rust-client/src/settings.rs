//! Port of the settings persistence in `main.ts` and `serverIdentity.ts`.
//!
//! `data.json` stays the single source of truth, so the plugin and this client
//! can hand over to each other. It is rewritten atomically and only ever read
//! into [`Secret`], never logged.

use crate::paths::encode_uri_component;
use crate::protocol::{CLIENT_DATA_PATH, is_valid_revision};
use anyhow::{Context, Result, bail};
use serde_json::{Map, Value};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The only way to read the value. Call sites are the HTTP headers and
    /// auth bodies in `transport.rs`.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<masked>")
    }
}

impl fmt::Display for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<masked>")
    }
}

pub fn normalize_server_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

/// A reversible, collision-free directory key for one normalized server URL.
pub fn server_identity_for(value: &str) -> String {
    encode_uri_component(&normalize_server_url(value))
}

/// The 32-bit FNV-1a identity used before URL encoding was introduced.
pub fn legacy_server_identity_for(value: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in normalize_server_url(value).encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub data_path: PathBuf,
    pub server_url: String,
    pub client_name: String,
    pub client_secret: Secret,
    pub revision: u64,
    pub server_identity: String,
}

impl Settings {
    pub fn path_in(vault: &Path) -> PathBuf {
        vault.join(CLIENT_DATA_PATH)
    }

    /// Loads and validates `data.json`, recording `serverIdentity` the way the
    /// plugin's `loadSettings` does. Anything that would make the plugin reset
    /// credentials or migrate state is refused rather than guessed at.
    pub fn load(vault: &Path) -> Result<Self> {
        let data_path = Self::path_in(vault);
        let object = read_object(&data_path)?;
        let server_url = normalize_server_url(required_str(&object, "serverUrl")?);
        if !(server_url.starts_with("http://") || server_url.starts_with("https://")) {
            bail!("serverUrl in data.json must use HTTP or HTTPS");
        }
        let client_name = required_str(&object, "clientName")?.to_string();
        let client_secret = Secret::new(required_str(&object, "clientSecret")?);
        let revision = object
            .get("revision")
            .and_then(Value::as_u64)
            .filter(|revision| is_valid_revision(*revision))
            .context("revision in data.json must be a nonnegative integer")?;

        let identity = server_identity_for(&server_url);
        match object.get("serverIdentity").and_then(Value::as_str) {
            Some(previous) if previous != identity => {
                if previous == legacy_server_identity_for(&server_url) {
                    bail!(
                        "data.json has a legacy serverIdentity; open the vault in Obsidian once so the plugin can migrate its journals"
                    );
                }
                bail!(
                    "data.json serverIdentity does not match serverUrl; the plugin would reset this client, so refusing to start"
                );
            }
            Some(_) => {}
            None => {
                let mut updated = object;
                updated.insert("serverIdentity".into(), Value::String(identity.clone()));
                write_object(&data_path, &updated)?;
            }
        }

        Ok(Self {
            data_path,
            server_url,
            client_name,
            client_secret,
            revision,
            server_identity: identity,
        })
    }

    /// Re-reads before patching so a field changed elsewhere is not clobbered.
    fn patch(&self, key: &str, value: Value) -> Result<()> {
        let mut object = read_object(&self.data_path)?;
        object.insert(key.to_string(), value);
        write_object(&self.data_path, &object)
    }

    pub fn save_revision(&mut self, revision: u64) -> Result<()> {
        self.patch("revision", Value::from(revision))?;
        self.revision = revision;
        Ok(())
    }

    pub fn save_credentials(&mut self, client_name: &str, client_secret: Secret) -> Result<()> {
        let mut object = read_object(&self.data_path)?;
        object.insert("clientName".into(), Value::String(client_name.into()));
        object.insert(
            "clientSecret".into(),
            Value::String(client_secret.expose().into()),
        );
        write_object(&self.data_path, &object)?;
        self.client_name = client_name.to_string();
        self.client_secret = client_secret;
        Ok(())
    }

    pub fn save_client_name(&mut self, client_name: &str) -> Result<()> {
        self.patch("clientName", Value::String(client_name.into()))?;
        self.client_name = client_name.to_string();
        Ok(())
    }

    /// Picks up what the plugin wrote while it owned the vault.
    pub fn reload(&mut self, vault: &Path) -> Result<()> {
        *self = Self::load(vault)?;
        Ok(())
    }
}

fn read_object(path: &Path) -> Result<Map<String, Value>> {
    // Parse errors from serde_json can quote file content, so they are not
    // propagated: this file holds the secret.
    let raw = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    match serde_json::from_str::<Value>(&raw) {
        Ok(Value::Object(object)) => Ok(object),
        _ => bail!("{} is not a JSON object", path.display()),
    }
}

fn required_str<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("{key} missing from data.json"))
}

fn write_object(path: &Path, object: &Map<String, Value>) -> Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".rust-tmp");
    let tmp = PathBuf::from(tmp);
    let body = serde_json::to_string_pretty(object)?;
    let mode = fs::metadata(path)
        .map(|m| m.permissions().mode() & 0o777)
        .unwrap_or(0o600);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)
            .with_context(|| format!("writing {}", tmp.display()))?;
        file.write_all(body.as_bytes())?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("replacing {}", path.display()))?;
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn vault(data: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        let path = Settings::path_in(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, data).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        dir
    }

    const DATA: &str = r#"{
  "clientName": "laptop",
  "clientSecret": "obs_sync_abc",
  "revision": 2517,
  "serverUrl": "http://sync.example:8443/"
}"#;

    fn read_json(dir: &TempDir) -> Value {
        serde_json::from_str(&fs::read_to_string(Settings::path_in(dir.path())).unwrap()).unwrap()
    }

    #[test]
    fn normalizes_whitespace_and_trailing_slashes() {
        assert_eq!(
            normalize_server_url(" https://sync.example/v1/// "),
            "https://sync.example/v1"
        );
    }

    #[test]
    fn identities_match_the_plugin() {
        assert_eq!(
            server_identity_for("http://sync.example:8443/"),
            "http%3A%2F%2Fsync.example%3A8443"
        );
        let first = "https://m0g00hi01d.example";
        let second = "https://ae7qetyymf.example";
        assert_eq!(
            legacy_server_identity_for(first),
            legacy_server_identity_for(second)
        );
        assert_ne!(server_identity_for(first), server_identity_for(second));
        assert!(!server_identity_for("https://sync.example:8443/team/vault").contains('/'));
    }

    #[test]
    fn load_records_server_identity_and_keeps_the_rest() {
        let dir = vault(DATA);
        let settings = Settings::load(dir.path()).unwrap();
        assert_eq!(settings.server_url, "http://sync.example:8443");
        assert_eq!(settings.client_name, "laptop");
        assert_eq!(settings.revision, 2517);
        let json = read_json(&dir);
        assert_eq!(json["serverIdentity"], "http%3A%2F%2Fsync.example%3A8443");
        assert_eq!(json["clientSecret"], "obs_sync_abc");
    }

    #[test]
    fn save_revision_preserves_unknown_fields_mode_and_key_order() {
        let dir = vault(
            r#"{"extra":{"keep":true},"clientName":"laptop","clientSecret":"s","revision":1,"serverUrl":"http://x"}"#,
        );
        let mut settings = Settings::load(dir.path()).unwrap();
        settings.save_revision(9).unwrap();
        let json = read_json(&dir);
        assert_eq!(json["revision"], 9);
        assert_eq!(json["extra"]["keep"], true);
        let raw = fs::read_to_string(Settings::path_in(dir.path())).unwrap();
        assert!(
            raw.starts_with("{\n  \"extra\""),
            "JSON.stringify(x, null, 2) layout"
        );
        let mode = fs::metadata(Settings::path_in(dir.path()))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn save_revision_does_not_clobber_a_concurrent_field_change() {
        let dir = vault(DATA);
        let mut settings = Settings::load(dir.path()).unwrap();
        let mut json = read_json(&dir);
        json["clientName"] = Value::String("renamed-elsewhere".into());
        fs::write(Settings::path_in(dir.path()), json.to_string()).unwrap();
        settings.save_revision(3000).unwrap();
        let json = read_json(&dir);
        assert_eq!(json["clientName"], "renamed-elsewhere");
        assert_eq!(json["revision"], 3000);
    }

    #[test]
    fn reload_picks_up_a_revision_written_by_the_plugin() {
        let dir = vault(DATA);
        let mut settings = Settings::load(dir.path()).unwrap();
        let mut json = read_json(&dir);
        json["revision"] = Value::from(4000);
        fs::write(Settings::path_in(dir.path()), json.to_string()).unwrap();
        settings.reload(dir.path()).unwrap();
        assert_eq!(settings.revision, 4000);
    }

    #[test]
    fn refuses_identities_it_would_have_to_migrate_or_reset() {
        let legacy = legacy_server_identity_for("http://sync.example:8443");
        let dir = vault(&format!(
            r#"{{"clientName":"a","clientSecret":"s","revision":1,"serverUrl":"http://sync.example:8443","serverIdentity":"{legacy}"}}"#
        ));
        let error = Settings::load(dir.path()).unwrap_err();
        assert!(error.to_string().contains("legacy"));

        let dir = vault(
            r#"{"clientName":"a","clientSecret":"s","revision":1,"serverUrl":"http://sync.example:8443","serverIdentity":"other"}"#,
        );
        assert!(Settings::load(dir.path()).is_err());
        assert!(read_json(&dir)["revision"] == 1);
    }

    #[test]
    fn rejects_invalid_files_without_echoing_their_content() {
        let dir = vault(r#"{"clientSecret":"topsecret" not json"#);
        let error = format!("{:#}", Settings::load(dir.path()).unwrap_err());
        assert!(!error.contains("topsecret"), "{error}");

        let dir = vault(
            r#"{"clientName":"a","clientSecret":"topsecret","revision":-1,"serverUrl":"http://x"}"#,
        );
        let error = format!("{:#}", Settings::load(dir.path()).unwrap_err());
        assert!(!error.contains("topsecret"), "{error}");

        let dir =
            vault(r#"{"clientName":"a","clientSecret":"s","revision":1,"serverUrl":"ftp://x"}"#);
        assert!(Settings::load(dir.path()).is_err());
    }

    #[test]
    fn debug_output_masks_the_secret() {
        let dir = vault(DATA);
        let settings = Settings::load(dir.path()).unwrap();
        let debug = format!("{settings:?}");
        assert!(debug.contains("<masked>"));
        assert!(!debug.contains("obs_sync_abc"));
        assert_eq!(format!("{}", settings.client_secret), "<masked>");
    }
}
