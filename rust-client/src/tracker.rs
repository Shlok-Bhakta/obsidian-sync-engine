//! The filesystem replacement for Obsidian's vault events.
//!
//! Obsidian tells the plugin *that* a user changed a file. A filesystem watcher
//! only reports that bytes moved, including the client's own writes. So this
//! keeps a manifest of the last state each path was known to be in (in sync
//! with the server or already queued). A change is local only if the bytes on
//! disk differ from the manifest. That one rule gives:
//!
//! - echo suppression, as inbound writes update the manifest and the event that
//!   follows compares equal;
//! - restart recovery, as a stat pass finds what changed while nothing ran;
//! - stale-copy safety, as the first run records the disk as a baseline instead
//!   of treating any difference from the server as an edit.

use crate::fs::{PathStat, SyncFs, sha256_hex};
use crate::paths::is_watched_path;
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

const MANIFEST_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    #[serde(rename = "h")]
    pub hash: String,
    #[serde(rename = "s")]
    pub size: u64,
    #[serde(rename = "m")]
    pub mtime_ns: i128,
}

#[derive(Serialize, Deserialize)]
struct ManifestFile {
    version: u32,
    revision: u64,
    files: BTreeMap<String, Entry>,
}

/// What a stat-and-hash pass over the vault found relative to the manifest.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct ScanDiff {
    /// New or modified files, with their current hash.
    pub changed: Vec<(String, String)>,
    pub missing: Vec<String>,
}

pub struct Tracker {
    path: String,
    entries: BTreeMap<String, Entry>,
    /// The revision cursor when the manifest was last saved. A different cursor
    /// in `data.json` means the plugin ran since then.
    revision: u64,
    dirty: bool,
}

impl Tracker {
    pub fn empty(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            entries: BTreeMap::new(),
            revision: 0,
            dirty: true,
        }
    }

    /// `None` means no manifest exists yet: this client's first run on the vault.
    pub fn load(fs: &dyn SyncFs, path: &str) -> Result<Option<Self>> {
        if !fs.exists(path)? {
            return Ok(None);
        }
        let raw = fs.read(path)?;
        let Ok(manifest) = serde_json::from_str::<ManifestFile>(&raw) else {
            // The journal write is atomic, so this is outside damage. Fall back
            // to first-run behaviour, which never pushes.
            crate::warning!("manifest.unreadable", path = path);
            return Ok(None);
        };
        if manifest.version != MANIFEST_VERSION {
            bail!("unsupported manifest version {}", manifest.version);
        }
        Ok(Some(Self {
            path: path.to_string(),
            entries: manifest.files,
            revision: manifest.revision,
            dirty: false,
        }))
    }

    pub fn save(&mut self, fs: &dyn SyncFs, revision: u64) -> Result<()> {
        if !self.dirty && self.revision == revision {
            return Ok(());
        }
        let manifest = ManifestFile {
            version: MANIFEST_VERSION,
            revision,
            files: self.entries.clone(),
        };
        fs.write(&self.path, &serde_json::to_string(&manifest)?)?;
        self.revision = revision;
        self.dirty = false;
        Ok(())
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn contains(&self, path: &str) -> bool {
        self.entries.contains_key(path)
    }

    pub fn hash_of(&self, path: &str) -> Option<&str> {
        self.entries.get(path).map(|entry| entry.hash.as_str())
    }

    /// Tracked paths at or below `path`.
    pub fn tracked_under(&self, path: &str) -> Vec<String> {
        let nested = format!("{path}/");
        self.entries
            .keys()
            .filter(|key| *key == path || key.starts_with(&nested))
            .cloned()
            .collect()
    }

    pub fn record(&mut self, path: &str, hash: String, stat: PathStat) {
        if let PathStat::File { size, mtime_ns } = stat {
            self.entries.insert(
                path.to_string(),
                Entry {
                    hash,
                    size,
                    mtime_ns,
                },
            );
            self.dirty = true;
        }
    }

    /// Records bytes this client just wrote, so the event it causes is ignored.
    /// Hidden paths the inbox can deliver stay untracked, like the plugin's
    /// adapter writes to paths the vault index cannot see.
    pub fn record_written(&mut self, fs: &dyn SyncFs, path: &str, data: &[u8]) -> Result<()> {
        if is_watched_path(path)
            && let Some(stat) = fs.stat(path)?
        {
            self.record(path, sha256_hex(data), stat);
        }
        Ok(())
    }

    pub fn forget(&mut self, path: &str) {
        if self.entries.remove(path).is_some() {
            self.dirty = true;
        }
    }

    /// Replaces the manifest with what is on disk now, pushing nothing. Returns
    /// how many files differ from the previous manifest or are new to it.
    pub fn rebaseline(&mut self, fs: &dyn SyncFs, revision: u64) -> Result<usize> {
        let mut entries = BTreeMap::new();
        let mut unchanged = 0;
        for path in fs.list_files_under("")? {
            if !is_watched_path(&path) {
                continue;
            }
            let Some(PathStat::File { size, mtime_ns }) = fs.stat(&path)? else {
                continue;
            };
            let hash = match self.entries.get(&path) {
                Some(known) if known.size == size && known.mtime_ns == mtime_ns => {
                    unchanged += 1;
                    known.hash.clone()
                }
                _ => fs.hash_file(&path)?,
            };
            entries.insert(
                path,
                Entry {
                    hash,
                    size,
                    mtime_ns,
                },
            );
        }
        let differing = entries.len() - unchanged;
        self.entries = entries;
        self.dirty = true;
        self.save(fs, revision)?;
        Ok(differing)
    }

    /// Stat pass over the vault. Hashes only files whose size or mtime moved. A
    /// touch with identical bytes just refreshes the stored stat.
    pub fn scan(&mut self, fs: &dyn SyncFs) -> Result<ScanDiff> {
        let mut diff = ScanDiff::default();
        let mut present = HashSet::new();
        for path in fs.list_files_under("")? {
            if !is_watched_path(&path) {
                continue;
            }
            let Some(stat @ PathStat::File { size, mtime_ns }) = fs.stat(&path)? else {
                continue;
            };
            match self.entries.get(&path) {
                Some(known) if known.size == size && known.mtime_ns == mtime_ns => {}
                known => {
                    let known_hash = known.map(|entry| entry.hash.clone());
                    let hash = fs.hash_file(&path)?;
                    if known_hash.as_deref() == Some(hash.as_str()) {
                        self.record(&path, hash, stat);
                    } else {
                        diff.changed.push((path.clone(), hash));
                    }
                }
            }
            present.insert(path);
        }
        for path in self.entries.keys() {
            if !present.contains(path) {
                diff.missing.push(path.clone());
            }
        }
        Ok(diff)
    }

    /// Compares one file against the manifest, reading its bytes to be exact.
    pub fn matches_disk(&self, fs: &dyn SyncFs, path: &str) -> Result<bool> {
        let known = self.hash_of(path);
        match fs.stat(path)? {
            Some(PathStat::File { .. }) => {
                let Some(known) = known else { return Ok(false) };
                Ok(fs.hash_file(path)? == known)
            }
            _ => Ok(known.is_none()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::memory::MemoryFs;

    const MANIFEST: &str = ".obsidian/plugins/obsidian-sync-engine/state/x/manifest.json";

    fn baseline(fs: &MemoryFs, revision: u64) -> Tracker {
        let mut tracker = Tracker::empty(MANIFEST);
        tracker.rebaseline(fs, revision).unwrap();
        tracker
    }

    #[test]
    fn first_run_is_detected_by_a_missing_manifest() {
        let fs = MemoryFs::new();
        assert!(Tracker::load(&fs, MANIFEST).unwrap().is_none());
    }

    #[test]
    fn baseline_records_watched_files_only() {
        let fs = MemoryFs::new();
        fs.put("a.md", b"a");
        fs.put(".obsidian/app.json", b"{}");
        fs.put(".git/config", b"x");
        fs.put(
            ".obsidian/plugins/obsidian-sync-engine/data.json",
            b"secret",
        );
        let tracker = baseline(&fs, 5);
        assert!(tracker.contains("a.md"));
        assert!(tracker.contains(".obsidian/app.json"));
        assert!(!tracker.contains(".git/config"));
        assert!(!tracker.contains(".obsidian/plugins/obsidian-sync-engine/data.json"));
        assert_eq!(tracker.revision(), 5);
    }

    #[test]
    fn manifest_survives_a_restart() {
        let fs = MemoryFs::new();
        fs.put("a.md", b"a");
        baseline(&fs, 5);
        let mut loaded = Tracker::load(&fs, MANIFEST).unwrap().unwrap();
        assert_eq!(loaded.revision(), 5);
        assert_eq!(loaded.hash_of("a.md").unwrap(), sha256_hex(b"a"));
        assert_eq!(loaded.scan(&fs).unwrap(), ScanDiff::default());
    }

    #[test]
    fn a_damaged_manifest_falls_back_to_first_run() {
        let fs = MemoryFs::new();
        fs.put(MANIFEST, b"{ not json");
        assert!(Tracker::load(&fs, MANIFEST).unwrap().is_none());
    }

    #[test]
    fn scan_finds_edits_new_files_and_missing_files() {
        let fs = MemoryFs::new();
        fs.put("edited.md", b"1");
        fs.put("removed.md", b"2");
        fs.put("same.md", b"3");
        let mut tracker = baseline(&fs, 1);
        fs.put("edited.md", b"changed");
        fs.delete("removed.md");
        fs.put("new.md", b"4");
        let diff = tracker.scan(&fs).unwrap();
        let changed: Vec<_> = diff.changed.iter().map(|(path, _)| path.as_str()).collect();
        assert_eq!(changed, ["edited.md", "new.md"]);
        assert_eq!(diff.missing, ["removed.md"]);
    }

    #[test]
    fn scan_ignores_a_touch_with_identical_bytes_and_refreshes_the_stat() {
        let fs = MemoryFs::new();
        fs.put("a.md", b"same");
        let mut tracker = baseline(&fs, 1);
        let before = tracker.entries["a.md"].clone();
        fs.put("a.md", b"same");
        assert_eq!(tracker.scan(&fs).unwrap(), ScanDiff::default());
        assert_ne!(tracker.entries["a.md"].mtime_ns, before.mtime_ns);
    }

    #[test]
    fn an_emptied_vault_reports_everything_missing() {
        let fs = MemoryFs::new();
        fs.put("a.md", b"a");
        fs.put("b.md", b"b");
        let mut tracker = baseline(&fs, 1);
        fs.delete("a.md");
        fs.delete("b.md");
        assert_eq!(tracker.scan(&fs).unwrap().missing, ["a.md", "b.md"]);
    }

    #[test]
    fn matches_disk_compares_bytes() {
        let fs = MemoryFs::new();
        fs.put("a.md", b"a");
        let tracker = baseline(&fs, 1);
        assert!(tracker.matches_disk(&fs, "a.md").unwrap());
        fs.put("a.md", b"b");
        assert!(!tracker.matches_disk(&fs, "a.md").unwrap());
        fs.delete("a.md");
        assert!(!tracker.matches_disk(&fs, "a.md").unwrap());
        assert!(tracker.matches_disk(&fs, "never-seen.md").unwrap());
        fs.put("untracked.md", b"new");
        assert!(!tracker.matches_disk(&fs, "untracked.md").unwrap());
    }

    #[test]
    fn tracked_under_finds_exact_and_nested_without_prefix_siblings() {
        let fs = MemoryFs::new();
        fs.put("a/b.md", b"1");
        fs.put("a/c/d.md", b"2");
        fs.put("ab.md", b"3");
        let tracker = baseline(&fs, 1);
        assert_eq!(tracker.tracked_under("a"), ["a/b.md", "a/c/d.md"]);
        assert_eq!(tracker.tracked_under("ab.md"), ["ab.md"]);
    }

    #[test]
    fn hidden_paths_from_the_inbox_stay_untracked() {
        let fs = MemoryFs::new();
        let mut tracker = baseline(&fs, 1);
        fs.put(".trash/old.md", b"x");
        tracker.record_written(&fs, ".trash/old.md", b"x").unwrap();
        assert!(!tracker.contains(".trash/old.md"));
    }
}
