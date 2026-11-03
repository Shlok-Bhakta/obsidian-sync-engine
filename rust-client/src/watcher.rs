//! Filesystem events, standing in for Obsidian's `vault.on(...)`. Events only
//! name paths that might have changed. The tracker decides what really did.

use crate::paths::is_sync_excluded_path;
use anyhow::{Context, Result};
use notify::event::{AccessKind, AccessMode, EventKind};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;

#[derive(Debug, PartialEq, Eq)]
pub enum FsEvent {
    Changed(String),
    /// The kernel dropped events, so the only safe response is a full rescan.
    Rescan,
}

pub struct VaultWatcher {
    _watcher: RecommendedWatcher,
}

/// Vault-relative form of an absolute event path, or `None` when it should not
/// be looked at: outside the vault, non-UTF-8, or this client's own state.
pub fn relative_event_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?.to_str()?;
    if relative.is_empty() || is_sync_excluded_path(relative) {
        return None;
    }
    Some(relative.to_string())
}

/// Reads and opens are not changes. Hashing a file must not trigger itself.
pub fn is_relevant(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

impl VaultWatcher {
    pub fn start(root: &Path, sender: Sender<FsEvent>) -> Result<Self> {
        let root: PathBuf = root.to_path_buf();
        let handler_root = root.clone();
        let mut watcher =
            notify::recommended_watcher(move |result: notify::Result<Event>| match result {
                Ok(event) => {
                    if event.need_rescan() {
                        let _ = sender.send(FsEvent::Rescan);
                    }
                    if !is_relevant(&event.kind) {
                        return;
                    }
                    for path in &event.paths {
                        if let Some(relative) = relative_event_path(&handler_root, path) {
                            let _ = sender.send(FsEvent::Changed(relative));
                        }
                    }
                }
                Err(error) => {
                    crate::warning!("watcher.error", error = error);
                    let _ = sender.send(FsEvent::Rescan);
                }
            })
            .context("creating filesystem watcher")?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .with_context(|| format!("watching {}", root.display()))?;
        Ok(Self { _watcher: watcher })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::mpsc::{Receiver, channel};
    use std::time::{Duration, Instant};
    use tempfile::TempDir;

    fn wait_for(receiver: &Receiver<FsEvent>, path: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            match receiver.recv_timeout(left) {
                Ok(FsEvent::Changed(seen)) if seen == path => return true,
                Ok(_) => {}
                Err(_) => return false,
            }
        }
        false
    }

    fn drain(receiver: &Receiver<FsEvent>) -> Vec<FsEvent> {
        std::thread::sleep(Duration::from_millis(300));
        receiver.try_iter().collect()
    }

    #[test]
    fn relative_paths_drop_client_state() {
        let root = Path::new("/vault");
        assert_eq!(
            relative_event_path(root, Path::new("/vault/Crabcake/Hello World.md")).unwrap(),
            "Crabcake/Hello World.md"
        );
        assert_eq!(relative_event_path(root, Path::new("/vault")), None);
        assert_eq!(
            relative_event_path(root, Path::new("/elsewhere/a.md")),
            None
        );
        assert_eq!(
            relative_event_path(
                root,
                Path::new("/vault/.obsidian/plugins/obsidian-sync-engine/state/x/outbox.jsonl")
            ),
            None
        );
    }

    #[test]
    fn reports_create_modify_delete_and_nested_new_folders() {
        let dir = TempDir::new().unwrap();
        let (sender, receiver) = channel();
        let _watcher = VaultWatcher::start(dir.path(), sender).unwrap();

        fs::write(dir.path().join("a.md"), "1").unwrap();
        assert!(wait_for(&receiver, "a.md"));
        drain(&receiver);
        fs::write(dir.path().join("a.md"), "2").unwrap();
        assert!(wait_for(&receiver, "a.md"));
        drain(&receiver);
        fs::remove_file(dir.path().join("a.md")).unwrap();
        assert!(wait_for(&receiver, "a.md"));

        fs::create_dir(dir.path().join("new")).unwrap();
        assert!(wait_for(&receiver, "new"));
        std::thread::sleep(Duration::from_millis(200));
        fs::write(dir.path().join("new/b.md"), "x").unwrap();
        assert!(wait_for(&receiver, "new/b.md"));
    }

    #[test]
    fn reports_both_sides_of_a_rename() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("old")).unwrap();
        fs::write(dir.path().join("old/a.md"), "1").unwrap();
        let (sender, receiver) = channel();
        let _watcher = VaultWatcher::start(dir.path(), sender).unwrap();
        fs::rename(dir.path().join("old"), dir.path().join("new")).unwrap();
        let events = drain(&receiver);
        assert!(
            events.contains(&FsEvent::Changed("old".to_string())),
            "{events:?}"
        );
        assert!(
            events.contains(&FsEvent::Changed("new".to_string())),
            "{events:?}"
        );
    }

    #[test]
    fn reading_a_file_produces_no_event() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.md"), "1").unwrap();
        let (sender, receiver) = channel();
        let _watcher = VaultWatcher::start(dir.path(), sender).unwrap();
        fs::read(dir.path().join("a.md")).unwrap();
        assert!(drain(&receiver).is_empty());
    }
}
