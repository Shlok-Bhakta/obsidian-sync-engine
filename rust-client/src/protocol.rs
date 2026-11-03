//! Port of `shared/protocol/index.ts`: the wire messages and path policy.

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use std::fmt;

pub const CLIENT_DATA_PATH: &str = ".obsidian/plugins/obsidian-sync-engine/data.json";

/// JavaScript's `Number.MAX_SAFE_INTEGER`, the top of `revisionSchema`.
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;

/// The auth message union. Variant and field order match `messageSchema`, so
/// serialized bytes equal what `JSON.stringify` produces in the plugin.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // Names mirror MessageType in shared/protocol.
pub enum Message {
    AuthRequired,
    AuthInit {
        client_name: String,
        token: String,
    },
    AuthAck {
        client_name: String,
        token: String,
    },
    AuthSuccess,
    AuthFailed {
        reason: String,
    },
    ResetClientName {
        new_client_name: String,
        token: String,
    },
    Message {
        payload: String,
    },
    Error {
        reason: String,
    },
}

/// Hand-written so a stray `{:?}` can never print a token.
impl fmt::Debug for Message {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Message::AuthRequired => write!(f, "AuthRequired"),
            Message::AuthInit { client_name, .. } => {
                write!(f, "AuthInit({client_name}, <masked>)")
            }
            Message::AuthAck { client_name, .. } => {
                write!(f, "AuthAck({client_name}, <masked>)")
            }
            Message::AuthSuccess => write!(f, "AuthSuccess"),
            Message::AuthFailed { reason } => write!(f, "AuthFailed({reason})"),
            Message::ResetClientName {
                new_client_name, ..
            } => write!(f, "ResetClientName({new_client_name}, <masked>)"),
            Message::Message { .. } => write!(f, "Message(<payload>)"),
            Message::Error { reason } => write!(f, "Error({reason})"),
        }
    }
}

pub fn serialize_message(message: &Message) -> String {
    serde_json::to_string(message).expect("messages always serialize")
}

pub fn deserialize_message(raw: &str) -> Result<Message> {
    serde_json::from_str(raw).map_err(|error| anyhow!("invalid message: {error}"))
}

/// Product-wide path policy: sync the vault except this client's credentials.
pub fn is_canonical_sync_path(path: &str) -> bool {
    if path.is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.ends_with('/')
        || has_windows_drive(path)
    {
        return false;
    }
    path.split('/')
        .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && path != CLIENT_DATA_PATH
}

fn has_windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub fn is_valid_revision(revision: u64) -> bool {
    revision <= MAX_REVISION
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OpKind {
    Put,
    Delete,
}

impl OpKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OpKind::Put => "put",
            OpKind::Delete => "delete",
        }
    }
}

/// One line of the `GET /inbox` NDJSON transport.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct InboxOp {
    pub rev: u64,
    pub op: OpKind,
    pub path: String,
}

#[cfg(test)]
pub fn serialize_inbox_ndjson(ops: &[InboxOp]) -> String {
    ops.iter()
        .map(|op| serde_json::to_string(op).expect("inbox lines always serialize") + "\n")
        .collect()
}

pub fn deserialize_inbox_ndjson(body: &str) -> Result<Vec<InboxOp>> {
    body.split('\n')
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let op: InboxOp = serde_json::from_str(line).context("invalid inbox line")?;
            if !is_valid_revision(op.rev) {
                bail!("inbox revision out of range: {}", op.rev);
            }
            if !is_canonical_sync_path(&op.path) {
                bail!("inbox path is not canonical: {:?}", op.path);
            }
            Ok(op)
        })
        .collect()
}

/// Mirrors `revisionResponseSchema.parse`. A malformed response must never
/// acknowledge durable work, so anything but a safe integer is an error.
pub fn parse_revision_response(body: &str) -> Result<u64> {
    let value: serde_json::Value = serde_json::from_str(body).context("invalid JSON response")?;
    let revision = value
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| anyhow!("response has no valid revision"))?;
    if !is_valid_revision(revision) {
        bail!("revision out of range: {revision}");
    }
    Ok(revision)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_canonical_paths() {
        for path in [
            "notes/foo.md",
            "foo.md",
            ".obsidian/workspace.json",
            "Crabcake/Hello World.md",
            "ünï/çødé.md",
        ] {
            assert!(is_canonical_sync_path(path), "{path}");
        }
    }

    #[test]
    fn rejects_non_canonical_paths() {
        for path in [
            "",
            "/etc/passwd",
            "C:/Windows/system32",
            "c:foo",
            "../x",
            "a/../../etc/passwd",
            "a/./b",
            "a\\b",
            "a\0b",
            "a/b/",
            "a//b",
            CLIENT_DATA_PATH,
        ] {
            assert!(!is_canonical_sync_path(path), "{path:?}");
        }
    }

    #[test]
    fn auth_messages_match_plugin_bytes() {
        let message = Message::AuthAck {
            client_name: "laptop".into(),
            token: "t".into(),
        };
        assert_eq!(
            serialize_message(&message),
            r#"{"type":"auth_ack","client_name":"laptop","token":"t"}"#
        );
        let rename = Message::ResetClientName {
            new_client_name: "crabcake".into(),
            token: "t".into(),
        };
        assert_eq!(
            serialize_message(&rename),
            r#"{"type":"reset_client_name","new_client_name":"crabcake","token":"t"}"#
        );
    }

    #[test]
    fn parses_every_server_auth_reply() {
        assert_eq!(
            deserialize_message(r#"{"type":"auth_success"}"#).unwrap(),
            Message::AuthSuccess
        );
        assert_eq!(
            deserialize_message(r#"{"type":"auth_failed","reason":"Invalid credentials"}"#)
                .unwrap(),
            Message::AuthFailed {
                reason: "Invalid credentials".into()
            }
        );
        assert_eq!(
            deserialize_message(r#"{"type":"auth_init","client_name":"a","token":"b"}"#).unwrap(),
            Message::AuthInit {
                client_name: "a".into(),
                token: "b".into()
            }
        );
        assert!(deserialize_message(r#"{"type":"nope"}"#).is_err());
        assert!(deserialize_message("not json").is_err());
    }

    #[test]
    fn debug_output_never_contains_a_token() {
        let message = Message::AuthInit {
            client_name: "a".into(),
            token: "obs_sync_super_secret".into(),
        };
        assert!(!format!("{message:?}").contains("super_secret"));
    }

    #[test]
    fn inbox_round_trips_as_newline_terminated_ndjson() {
        let ops = vec![
            InboxOp {
                rev: 1,
                op: OpKind::Put,
                path: "a.md".into(),
            },
            InboxOp {
                rev: 2,
                op: OpKind::Delete,
                path: "b.md".into(),
            },
        ];
        let body = serialize_inbox_ndjson(&ops);
        assert_eq!(
            body,
            "{\"rev\":1,\"op\":\"put\",\"path\":\"a.md\"}\n{\"rev\":2,\"op\":\"delete\",\"path\":\"b.md\"}\n"
        );
        assert_eq!(deserialize_inbox_ndjson(&body).unwrap(), ops);
        assert_eq!(serialize_inbox_ndjson(&[]), "");
        assert!(deserialize_inbox_ndjson("").unwrap().is_empty());
    }

    #[test]
    fn rejects_malformed_inbox_operations() {
        assert!(
            deserialize_inbox_ndjson("{\"rev\":-1,\"op\":\"put\",\"path\":\"a.md\"}\n").is_err()
        );
        assert!(
            deserialize_inbox_ndjson("{\"rev\":1,\"op\":\"move\",\"path\":\"a.md\"}\n").is_err()
        );
        assert!(
            deserialize_inbox_ndjson(&format!(
                "{{\"rev\":1,\"op\":\"put\",\"path\":{CLIENT_DATA_PATH:?}}}\n"
            ))
            .is_err()
        );
        assert!(
            deserialize_inbox_ndjson("{\"rev\":1,\"op\":\"put\",\"path\":\"../x\"}\n").is_err()
        );
    }

    #[test]
    fn malformed_revisions_are_rejected() {
        for body in [
            "{}",
            r#"{"revision":"4"}"#,
            r#"{"revision":-1}"#,
            r#"{"revision":1.5}"#,
            r#"{"revision":9007199254740992}"#,
            "nope",
        ] {
            assert!(parse_revision_response(body).is_err(), "{body}");
        }
        assert_eq!(
            parse_revision_response(r#"{"path":"a.md","bytesWritten":5,"revision":3}"#).unwrap(),
            3
        );
    }
}
