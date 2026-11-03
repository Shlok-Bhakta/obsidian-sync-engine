//! Port of `plugin/src/sync/paths.ts` and `excludedPaths.ts`, plus the rule
//! for which paths the filesystem watcher treats as user content.

use crate::protocol::is_canonical_sync_path;
use anyhow::{Result, bail};

pub const PLUGIN_DIR: &str = ".obsidian/plugins/obsidian-sync-engine";
const CONFIG_DIR: &str = ".obsidian";

pub fn state_root() -> String {
    format!("{PLUGIN_DIR}/state")
}

pub fn canonicalize_sync_path(path: &str) -> Result<&str> {
    if !is_canonical_sync_path(path) {
        bail!("Invalid sync path: {path}");
    }
    Ok(path)
}

/// Ancestor directories of `path`, root-most first.
pub fn ancestor_dirs(path: &str) -> Vec<String> {
    let mut segments: Vec<&str> = path.split('/').collect();
    segments.pop();
    let mut dirs = Vec::new();
    let mut current = String::new();
    for segment in segments.into_iter().filter(|s| !s.is_empty()) {
        if !current.is_empty() {
            current.push('/');
        }
        current.push_str(segment);
        dirs.push(current.clone());
    }
    dirs
}

/// Keeps `data.json` and the durable journals local to this client.
pub fn is_sync_excluded_path(path: &str) -> bool {
    let data_path = format!("{PLUGIN_DIR}/data.json");
    let state_dir = state_root();
    path == data_path || path == state_dir || path.starts_with(&format!("{state_dir}/"))
}

/// True when deleting `path` recursively would take this client's own
/// credentials or journals with it (for example a tombstone for `.obsidian`).
pub fn contains_client_state(path: &str) -> bool {
    is_sync_excluded_path(path) || PLUGIN_DIR == path || PLUGIN_DIR.starts_with(&format!("{path}/"))
}

/// What Obsidian would report as a local change: `.obsidian` config and any
/// non-hidden path. Other dot-paths (`.git`, `.trash`) are invisible to its
/// vault index, so the plugin never syncs them from local events either.
pub fn is_watched_path(path: &str) -> bool {
    if !is_canonical_sync_path(path) || is_sync_excluded_path(path) {
        return false;
    }
    let mut segments = path.split('/');
    let first = segments.next().unwrap_or_default();
    if first.starts_with('.') && first != CONFIG_DIR {
        return false;
    }
    segments.all(|segment| !segment.starts_with('.'))
}

pub fn paths_structurally_conflict(left: &str, right: &str) -> bool {
    left == right
        || left.starts_with(&format!("{right}/"))
        || right.starts_with(&format!("{left}/"))
}

/// Byte-exact port of JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ancestor_dirs_match_plugin() {
        assert!(ancestor_dirs("c.md").is_empty());
        assert_eq!(ancestor_dirs("a/c.md"), ["a"]);
        assert_eq!(ancestor_dirs("a/b/c.md"), ["a", "a/b"]);
        assert_eq!(ancestor_dirs("a/b/c/d.md"), ["a", "a/b", "a/b/c"]);
        assert_eq!(ancestor_dirs("/a/b/c.md"), ["a", "a/b"]);
    }

    #[test]
    fn canonicalize_rejects_bad_paths() {
        assert_eq!(canonicalize_sync_path("a/b/c.md").unwrap(), "a/b/c.md");
        assert!(canonicalize_sync_path("a\\b\\c.md").is_err());
        assert!(
            canonicalize_sync_path(".obsidian/plugins/obsidian-sync-engine/data.json").is_err()
        );
    }

    #[test]
    fn exclusions_match_plugin() {
        assert!(is_sync_excluded_path(
            ".obsidian/plugins/obsidian-sync-engine/data.json"
        ));
        assert!(is_sync_excluded_path(
            ".obsidian/plugins/obsidian-sync-engine/state/server-a/outbox.jsonl"
        ));
        for path in [
            ".obsidian/workspace.json",
            ".obsidian/app.json",
            ".obsidian/plugins/another-plugin/data.json",
            ".obsidian/plugins/obsidian-sync-engine/main.js",
        ] {
            assert!(!is_sync_excluded_path(path), "{path}");
        }
    }

    #[test]
    fn watched_paths_follow_obsidian_visibility() {
        for path in [
            "note.md",
            "Crabcake/Hello World.md",
            ".obsidian/app.json",
            ".obsidian/plugins/obsidian-sync-engine/main.js",
        ] {
            assert!(is_watched_path(path), "{path}");
        }
        for path in [
            ".git/config",
            ".trash/old.md",
            "folder/.hidden.md",
            ".note.md.swp",
            ".obsidian/plugins/x/.git/HEAD",
            ".obsidian/plugins/obsidian-sync-engine/data.json",
            ".obsidian/plugins/obsidian-sync-engine/state/x/outbox.jsonl",
            "back\\slash.md",
        ] {
            assert!(!is_watched_path(path), "{path}");
        }
    }

    #[test]
    fn deletes_that_would_take_client_state_are_recognized() {
        for path in [
            ".obsidian",
            ".obsidian/plugins",
            ".obsidian/plugins/obsidian-sync-engine",
            ".obsidian/plugins/obsidian-sync-engine/state",
            ".obsidian/plugins/obsidian-sync-engine/state/x/outbox.jsonl",
        ] {
            assert!(contains_client_state(path), "{path}");
        }
        for path in [
            ".obsidian/app.json",
            ".obsidian/plugins/other",
            ".obsidian/plugins/obsidian-sync-engine/main.js",
            "notes",
        ] {
            assert!(!contains_client_state(path), "{path}");
        }
    }

    #[test]
    fn structural_conflicts() {
        assert!(paths_structurally_conflict("a", "a"));
        assert!(paths_structurally_conflict("a/b", "a"));
        assert!(paths_structurally_conflict("a", "a/b"));
        assert!(!paths_structurally_conflict("a/b", "a/c"));
        assert!(!paths_structurally_conflict("ab", "a"));
    }

    #[test]
    fn encode_uri_component_matches_javascript() {
        assert_eq!(encode_uri_component("notes/a b.md"), "notes%2Fa%20b.md");
        assert_eq!(
            encode_uri_component("http://sync.example:8443"),
            "http%3A%2F%2Fsync.example%3A8443"
        );
        assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_uri_component("é+&=?#%"), "%C3%A9%2B%26%3D%3F%23%25");
        assert_eq!(encode_uri_component("🦀"), "%F0%9F%A6%80");
    }
}
