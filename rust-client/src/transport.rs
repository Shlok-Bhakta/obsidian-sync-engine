//! Port of `plugin/src/sync/httpTransport.ts`, `auth.ts` and `checkServerHealth`.

use crate::paths::encode_uri_component;
use crate::protocol::{
    InboxOp, Message, deserialize_inbox_ndjson, deserialize_message, parse_revision_response,
    serialize_message,
};
use crate::settings::Secret;
use anyhow::{Context, Result, anyhow, bail};
use std::fmt;
use std::time::Duration;

const BODY_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const ERROR_BODY_LIMIT: usize = 512;

pub trait Transport {
    fn upload(&self, path: &str, body: &[u8]) -> Result<u64>;
    fn delete_remote(&self, path: &str, base_revision: Option<u64>) -> Result<u64>;
    fn download(&self, path: &str) -> Result<Vec<u8>>;
    fn fetch_inbox(&self, revision: u64) -> Result<Vec<InboxOp>>;
}

/// A rejection that retrying cannot fix (400/413). Dead-lettered by the engine.
#[derive(Debug)]
pub struct PermanentRemoteError {
    pub message: String,
    pub status: u16,
}

impl fmt::Display for PermanentRemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for PermanentRemoteError {}

/// `GET /files` returned 404: the path is missing or soft-deleted.
#[derive(Debug)]
pub struct RemoteFileNotFoundError {
    pub path: String,
}

impl fmt::Display for RemoteFileNotFoundError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Remote file not found: {}", self.path)
    }
}

impl std::error::Error for RemoteFileNotFoundError {}

/// `POST /auth` said the name and secret do not match a client.
#[derive(Debug)]
pub struct AuthRejectedError {
    pub reason: String,
}

impl fmt::Display for AuthRejectedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Auth failed: {}", self.reason)
    }
}

impl std::error::Error for AuthRejectedError {}

pub enum AuthOutcome {
    /// An empty server enrolled this client and issued a secret.
    Enrolled {
        client_name: String,
        client_secret: Secret,
    },
    Verified,
}

pub struct HttpTransport {
    server_url: String,
    secret: Secret,
    agent: ureq::Agent,
}

fn assert_ok(status: u16, text: &str, action: &str) -> Result<()> {
    let trimmed: String = text.chars().take(ERROR_BODY_LIMIT).collect();
    let message = format!("{action} failed with status {status}: {trimmed}");
    if status == 413 || status == 400 {
        return Err(PermanentRemoteError { message, status }.into());
    }
    if status >= 400 {
        bail!(message);
    }
    Ok(())
}

impl HttpTransport {
    pub fn new(server_url: &str, secret: Secret) -> Self {
        let agent: ureq::Agent = ureq::Agent::config_builder()
            // Status handling below mirrors the plugin's `throw: false`.
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(15)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            .timeout_send_body(Some(BODY_TIMEOUT))
            .timeout_recv_body(Some(BODY_TIMEOUT))
            .build()
            .into();
        Self {
            server_url: server_url.to_string(),
            secret,
            agent,
        }
    }

    pub fn set_secret(&mut self, secret: Secret) {
        self.secret = secret;
    }

    fn read_text(response: &mut ureq::http::Response<ureq::Body>) -> Result<String> {
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_string()
            .map_err(|error| anyhow!("reading response failed: {error}"))
    }

    /// Any 2xx from `GET /health`. Failures are just "not healthy".
    pub fn health(&self) -> bool {
        match self.agent.get(format!("{}/health", self.server_url)).call() {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    pub fn authenticate(&self, client_name: &str) -> Result<AuthOutcome> {
        let body = serialize_message(&Message::AuthAck {
            client_name: client_name.to_string(),
            token: self.secret.expose().to_string(),
        });
        let mut response = self
            .agent
            .post(format!("{}/auth", self.server_url))
            .header("Content-Type", "application/json")
            .send(body.as_bytes())
            .map_err(|error| anyhow!("auth request failed: {error}"))?;
        let status = response.status().as_u16();
        let text = Self::read_text(&mut response)?;
        match deserialize_message(&text)
            .map_err(|_| anyhow!("Auth failed ({status}): could not parse response"))?
        {
            Message::AuthInit { client_name, token } => Ok(AuthOutcome::Enrolled {
                client_name,
                client_secret: Secret::new(token),
            }),
            Message::AuthSuccess => Ok(AuthOutcome::Verified),
            Message::AuthFailed { reason } => Err(AuthRejectedError { reason }.into()),
            other => bail!("Auth failed ({status}): unexpected response {other:?}"),
        }
    }

    /// `POST /reset-client-name`, what the plugin's settings field calls. The
    /// name is half of the `/auth` credential, so this is the only safe rename.
    pub fn rename_client(&self, new_client_name: &str) -> Result<String> {
        let body = serialize_message(&Message::ResetClientName {
            new_client_name: new_client_name.to_string(),
            token: self.secret.expose().to_string(),
        });
        let mut response = self
            .agent
            .post(format!("{}/reset-client-name", self.server_url))
            .header("Content-Type", "application/json")
            .send(body.as_bytes())
            .map_err(|error| anyhow!("rename request failed: {error}"))?;
        let status = response.status().as_u16();
        let text = Self::read_text(&mut response)?;
        match deserialize_message(&text).context("invalid rename response")? {
            Message::AuthInit { client_name, .. } => Ok(client_name),
            Message::Error { reason } => bail!("Rename failed ({status}): {reason}"),
            other => bail!("Rename failed ({status}): unexpected response {other:?}"),
        }
    }
}

impl Transport for HttpTransport {
    fn upload(&self, path: &str, body: &[u8]) -> Result<u64> {
        let mut response = self
            .agent
            .post(format!("{}/files", self.server_url))
            .header("Content-Type", "application/octet-stream")
            .header("Authorization", self.secret.expose())
            .header("X-Obsidian-Path", encode_uri_component(path))
            .send(body)
            .map_err(|error| anyhow!("upload of {path:?} failed: {error}"))?;
        let status = response.status().as_u16();
        let text = Self::read_text(&mut response)?;
        assert_ok(status, &text, &format!("Upload of {path:?}"))?;
        parse_revision_response(&text).with_context(|| format!("Upload of {path:?}"))
    }

    fn delete_remote(&self, path: &str, base_revision: Option<u64>) -> Result<u64> {
        let mut request = self
            .agent
            .delete(format!(
                "{}/files?path={}",
                self.server_url,
                encode_uri_component(path)
            ))
            .header("Authorization", self.secret.expose());
        if let Some(base) = base_revision {
            request = request.header("X-Obsidian-Base-Revision", base.to_string());
        }
        let mut response = request
            .call()
            .map_err(|error| anyhow!("delete of {path:?} failed: {error}"))?;
        let status = response.status().as_u16();
        let text = Self::read_text(&mut response)?;
        assert_ok(status, &text, &format!("Delete of {path:?}"))?;
        parse_revision_response(&text).with_context(|| format!("Delete of {path:?}"))
    }

    fn download(&self, path: &str) -> Result<Vec<u8>> {
        let mut response = self
            .agent
            .get(format!(
                "{}/files?path={}",
                self.server_url,
                encode_uri_component(path)
            ))
            .header("Authorization", self.secret.expose())
            .call()
            .map_err(|error| anyhow!("download of {path:?} failed: {error}"))?;
        let status = response.status().as_u16();
        if status == 404 {
            return Err(RemoteFileNotFoundError {
                path: path.to_string(),
            }
            .into());
        }
        if status >= 400 {
            let text = Self::read_text(&mut response).unwrap_or_default();
            assert_ok(status, &text, &format!("Download of {path:?}"))?;
        }
        response
            .body_mut()
            .with_config()
            .limit(u64::MAX)
            .read_to_vec()
            .map_err(|error| anyhow!("download of {path:?} failed: {error}"))
    }

    fn fetch_inbox(&self, revision: u64) -> Result<Vec<InboxOp>> {
        let mut response = self
            .agent
            .get(format!("{}/inbox?rev={revision}", self.server_url))
            .header("Authorization", self.secret.expose())
            .call()
            .map_err(|error| anyhow!("fetching inbox failed: {error}"))?;
        let status = response.status().as_u16();
        let text = Self::read_text(&mut response)?;
        assert_ok(status, &text, "Fetching inbox")?;
        deserialize_inbox_ndjson(&text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::OpKind;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    #[derive(Debug)]
    struct Captured {
        head: String,
        body: Vec<u8>,
    }

    /// One-shot server that records the raw request bytes, so these tests pin
    /// the wire format rather than a client library's view of it.
    fn serve_once(status: &'static str, body: &'static [u8]) -> (String, mpsc::Receiver<Captured>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut raw = Vec::new();
            let mut buffer = [0u8; 4096];
            let (head, mut request_body, length) = loop {
                let read = stream.read(&mut buffer).unwrap();
                raw.extend_from_slice(&buffer[..read]);
                if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8(raw[..end].to_vec()).unwrap();
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length: ")
                                .map(|v| v.parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    break (head, raw[end + 4..].to_vec(), length);
                }
            };
            while request_body.len() < length {
                let read = stream.read(&mut buffer).unwrap();
                request_body.extend_from_slice(&buffer[..read]);
            }
            sender
                .send(Captured {
                    head,
                    body: request_body,
                })
                .unwrap();
            let header = format!(
                "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        });
        (url, receiver)
    }

    fn header_value(head: &str, name: &str) -> Option<String> {
        head.lines().find_map(|line| {
            let (key, value) = line.split_once(": ")?;
            key.eq_ignore_ascii_case(name).then(|| value.to_string())
        })
    }

    fn transport(url: &str) -> HttpTransport {
        HttpTransport::new(url, Secret::new("obs_sync_test+secret/=="))
    }

    #[test]
    fn upload_posts_raw_bytes_with_exact_headers() {
        let (url, captured) = serve_once(
            "200 OK",
            br#"{"path":"notes/a b.md","bytesWritten":5,"revision":3}"#,
        );
        let revision = transport(&url).upload("notes/a b.md", b"he\0lo").unwrap();
        assert_eq!(revision, 3);
        let request = captured.recv().unwrap();
        assert!(
            request.head.starts_with("POST /files HTTP/1.1\r\n"),
            "{}",
            request.head
        );
        assert_eq!(request.body, b"he\0lo");
        assert_eq!(
            header_value(&request.head, "authorization").unwrap(),
            "obs_sync_test+secret/=="
        );
        assert_eq!(
            header_value(&request.head, "x-obsidian-path").unwrap(),
            "notes%2Fa%20b.md"
        );
        assert_eq!(
            header_value(&request.head, "content-type").unwrap(),
            "application/octet-stream"
        );
    }

    #[test]
    fn delete_sends_encoded_query_and_causal_base_revision() {
        let (url, captured) = serve_once("200 OK", br#"{"path":"a","revision":4}"#);
        let revision = transport(&url)
            .delete_remote("notes/a b.md", Some(3))
            .unwrap();
        assert_eq!(revision, 4);
        let request = captured.recv().unwrap();
        assert!(
            request
                .head
                .starts_with("DELETE /files?path=notes%2Fa%20b.md HTTP/1.1\r\n"),
            "{}",
            request.head
        );
        assert_eq!(
            header_value(&request.head, "x-obsidian-base-revision").unwrap(),
            "3"
        );
    }

    #[test]
    fn delete_without_base_revision_omits_the_header() {
        let (url, captured) = serve_once("200 OK", br#"{"revision":4}"#);
        transport(&url).delete_remote("a.md", None).unwrap();
        let request = captured.recv().unwrap();
        assert!(header_value(&request.head, "x-obsidian-base-revision").is_none());
    }

    #[test]
    fn download_returns_raw_bytes_and_encodes_the_query() {
        let (url, captured) = serve_once("200 OK", b"\x00\xffbinary");
        let bytes = transport(&url).download("Crabcake/Hello World.md").unwrap();
        assert_eq!(bytes, b"\x00\xffbinary");
        let request = captured.recv().unwrap();
        assert!(
            request
                .head
                .starts_with("GET /files?path=Crabcake%2FHello%20World.md HTTP/1.1\r\n"),
            "{}",
            request.head
        );
    }

    #[test]
    fn download_maps_404_to_not_found() {
        let (url, _captured) = serve_once("404 Not Found", br#"{"error":"Not found"}"#);
        let error = transport(&url).download("gone.md").unwrap_err();
        assert!(error.downcast_ref::<RemoteFileNotFoundError>().is_some());
    }

    #[test]
    fn inbox_requests_the_cursor_and_parses_ndjson() {
        let (url, captured) = serve_once(
            "200 OK",
            b"{\"rev\":1,\"op\":\"put\",\"path\":\"a.md\"}\n{\"rev\":2,\"op\":\"delete\",\"path\":\"b.md\"}\n",
        );
        let ops = transport(&url).fetch_inbox(0).unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].op, OpKind::Delete);
        let request = captured.recv().unwrap();
        assert!(request.head.starts_with("GET /inbox?rev=0 HTTP/1.1\r\n"));
    }

    #[test]
    fn empty_inbox_body_is_empty() {
        let (url, _captured) = serve_once("200 OK", b"");
        assert!(transport(&url).fetch_inbox(5).unwrap().is_empty());
    }

    #[test]
    fn server_errors_are_transient_and_carry_status_and_body() {
        let (url, _captured) = serve_once("401 Unauthorized", b"Unauthorized");
        let error = transport(&url).upload("a.md", b"x").unwrap_err();
        assert!(error.downcast_ref::<PermanentRemoteError>().is_none());
        let message = error.to_string();
        assert!(
            message.contains("401") && message.contains("Unauthorized"),
            "{message}"
        );
    }

    #[test]
    fn status_400_and_413_are_permanent() {
        let (url, _c) = serve_once("413 Payload Too Large", b"too large");
        let error = transport(&url).upload("a.md", b"x").unwrap_err();
        assert_eq!(
            error.downcast_ref::<PermanentRemoteError>().unwrap().status,
            413
        );

        let (url, _c) = serve_once("400 Bad Request", b"Invalid path");
        let error = transport(&url).delete_remote("a.md", None).unwrap_err();
        assert_eq!(
            error.downcast_ref::<PermanentRemoteError>().unwrap().status,
            400
        );
    }

    #[test]
    fn malformed_success_never_acknowledges_work() {
        for body in [&b"{}"[..], br#"{"revision":"4"}"#, br#"{"revision":-1}"#] {
            let leaked: &'static [u8] = Box::leak(body.to_vec().into_boxed_slice());
            let (url, _c) = serve_once("200 OK", leaked);
            assert!(transport(&url).upload("a.md", b"x").is_err());
        }
    }

    #[test]
    fn auth_sends_plugin_bytes_and_recognizes_replies() {
        let (url, captured) = serve_once("200 OK", br#"{"type":"auth_success"}"#);
        assert!(matches!(
            transport(&url).authenticate("laptop").unwrap(),
            AuthOutcome::Verified
        ));
        let request = captured.recv().unwrap();
        assert!(request.head.starts_with("POST /auth HTTP/1.1\r\n"));
        assert_eq!(
            String::from_utf8(request.body).unwrap(),
            r#"{"type":"auth_ack","client_name":"laptop","token":"obs_sync_test+secret/=="}"#
        );

        let (url, _c) = serve_once(
            "401 Unauthorized",
            br#"{"type":"auth_failed","reason":"Invalid credentials"}"#,
        );
        let error = transport(&url).authenticate("laptop").err().unwrap();
        assert_eq!(
            error.downcast_ref::<AuthRejectedError>().unwrap().reason,
            "Invalid credentials"
        );

        let (url, _c) = serve_once(
            "200 OK",
            br#"{"type":"auth_init","client_name":"first","token":"issued"}"#,
        );
        match transport(&url).authenticate("first").unwrap() {
            AuthOutcome::Enrolled {
                client_name,
                client_secret,
            } => {
                assert_eq!(client_name, "first");
                assert_eq!(client_secret.expose(), "issued");
            }
            AuthOutcome::Verified => panic!("expected enrollment"),
        }
    }

    #[test]
    fn errors_never_contain_the_secret() {
        let (url, _c) = serve_once("500 Internal Server Error", b"boom");
        let error = transport(&url).fetch_inbox(1).unwrap_err();
        assert!(!format!("{error:#}").contains("obs_sync_test"));
        let unreachable = transport("http://127.0.0.1:1").fetch_inbox(1).unwrap_err();
        assert!(!format!("{unreachable:#}").contains("obs_sync_test"));
    }

    #[test]
    fn rename_uses_the_reset_endpoint() {
        let (url, captured) = serve_once(
            "200 OK",
            br#"{"type":"auth_init","client_name":"crabcake","token":"t"}"#,
        );
        assert_eq!(
            transport(&url).rename_client("crabcake").unwrap(),
            "crabcake"
        );
        let request = captured.recv().unwrap();
        assert!(
            request
                .head
                .starts_with("POST /reset-client-name HTTP/1.1\r\n")
        );
        assert!(
            String::from_utf8(request.body)
                .unwrap()
                .contains(r#""new_client_name":"crabcake""#)
        );
    }

    #[test]
    fn health_is_true_only_for_2xx() {
        let (url, _c) = serve_once("200 OK", b"ok");
        assert!(transport(&url).health());
        let (url, _c) = serve_once("503 Service Unavailable", b"down");
        assert!(!transport(&url).health());
        assert!(!transport("http://127.0.0.1:1").health());
    }
}
