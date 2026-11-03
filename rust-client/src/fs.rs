//! Port of `plugin/src/sync/fs.ts` and `obsidianFs.ts`. The trait lets the
//! engine run against an in-memory store in tests and the real disk in
//! production. All paths are vault-relative with forward slashes.

use crate::paths::{ancestor_dirs, is_sync_excluded_path};
use crate::protocol::CLIENT_DATA_PATH;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathStat {
    File {
        size: u64,
        mtime_ns: i128,
    },
    Dir,
    /// Symlinks and other non-regular files are never synced.
    Other,
}

pub trait SyncFs {
    fn read(&self, path: &str) -> io::Result<String>;
    fn write(&self, path: &str, data: &str) -> io::Result<()>;
    fn append(&self, path: &str, data: &str) -> io::Result<()>;
    /// Journal existence: the file or its `.bak` left by an interrupted write.
    fn exists(&self, path: &str) -> io::Result<bool>;
    /// Stat without following a symlink at `path`. `None` when absent.
    fn stat(&self, path: &str) -> io::Result<Option<PathStat>>;
    fn read_binary(&self, path: &str) -> io::Result<Vec<u8>>;
    fn hash_file(&self, path: &str) -> io::Result<String>;
    fn write_binary(&self, path: &str, data: &[u8]) -> io::Result<()>;
    /// Removes a file, or a directory recursively. Missing paths are fine.
    fn remove(&self, path: &str) -> io::Result<()>;
    /// Removes the empty folders above `path`, deepest first, stopping at the
    /// first one still in use. Never removes the vault root.
    fn prune_empty_parents(&self, path: &str) -> io::Result<()>;
    /// Every regular file at or below `prefix` (`""` for the whole vault).
    fn list_files_under(&self, prefix: &str) -> io::Result<Vec<String>>;
}

pub fn sha256_hex(data: &[u8]) -> String {
    to_hex(&Sha256::digest(data))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// [`SyncFs`] on the real vault directory.
///
/// Inbound files are staged in `temp_dir`, which lives under the excluded
/// state directory, then renamed into place. A half-written file is never
/// visible in the vault and the temporary never shows up as a vault event.
pub struct LocalFs {
    root: PathBuf,
    temp_dir: String,
    counter: AtomicU64,
}

impl LocalFs {
    pub fn new(root: impl Into<PathBuf>, temp_dir: impl Into<String>) -> Self {
        Self {
            root: root.into(),
            temp_dir: temp_dir.into(),
            counter: AtomicU64::new(0),
        }
    }

    fn resolve(&self, path: &str) -> io::Result<PathBuf> {
        let unsafe_path = path.is_empty()
            || path.starts_with('/')
            || path.contains('\0')
            || path
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..");
        if unsafe_path {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("refusing unsafe vault path {path:?}"),
            ));
        }
        Ok(self.root.join(path))
    }

    /// Refuses to follow a symlinked directory out of the vault.
    fn assert_no_symlinked_ancestor(&self, path: &str) -> io::Result<()> {
        for dir in ancestor_dirs(path) {
            match fs::symlink_metadata(self.root.join(&dir)) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("refusing to traverse symlink {dir:?}"),
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::NotADirectory => return Ok(()),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn ensure_parent_dir(&self, path: &str) -> io::Result<()> {
        self.assert_no_symlinked_ancestor(path)?;
        for dir in ancestor_dirs(path) {
            let full = self.root.join(&dir);
            match fs::symlink_metadata(&full) {
                Ok(meta) if meta.is_dir() => continue,
                // A remote tree replaced a file: the directory wins, as in
                // `ensureVaultParentDir`. The engine has already checked that
                // this file has no local changes.
                Ok(meta) if meta.is_file() => fs::remove_file(&full)?,
                Ok(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("{dir:?} is not a directory"),
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            if let Err(error) = fs::create_dir(&full)
                && !full.is_dir()
            {
                return Err(error);
            }
        }
        Ok(())
    }

    fn recover_journal(&self, full: &Path) -> io::Result<()> {
        if full.exists() {
            return Ok(());
        }
        let backup = backup_path(full);
        if backup.exists() {
            fs::rename(backup, full)?;
        }
        Ok(())
    }
}

fn backup_path(full: &Path) -> PathBuf {
    let mut name = full.as_os_str().to_owned();
    name.push(".bak");
    PathBuf::from(name)
}

fn sync_parent(full: &Path) -> io::Result<()> {
    if let Some(parent) = full.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

impl SyncFs for LocalFs {
    fn read(&self, path: &str) -> io::Result<String> {
        let full = self.resolve(path)?;
        self.recover_journal(&full)?;
        fs::read_to_string(full)
    }

    fn write(&self, path: &str, data: &str) -> io::Result<()> {
        let full = self.resolve(path)?;
        self.ensure_parent_dir(path)?;
        self.recover_journal(&full)?;
        let mut tmp = full.as_os_str().to_owned();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        {
            let mut file = File::create(&tmp)?;
            file.write_all(data.as_bytes())?;
            file.sync_all()?;
        }
        // POSIX rename replaces atomically, so no `.bak` step is needed here.
        // `recover_journal` still honours one left behind by the plugin.
        fs::rename(&tmp, &full)?;
        let backup = backup_path(&full);
        if backup.exists() {
            fs::remove_file(backup)?;
        }
        sync_parent(&full)
    }

    fn append(&self, path: &str, data: &str) -> io::Result<()> {
        let full = self.resolve(path)?;
        self.ensure_parent_dir(path)?;
        self.recover_journal(&full)?;
        let mut file = OpenOptions::new().create(true).append(true).open(&full)?;
        file.write_all(data.as_bytes())?;
        file.sync_all()
    }

    fn exists(&self, path: &str) -> io::Result<bool> {
        let full = self.resolve(path)?;
        Ok(full.exists() || backup_path(&full).exists())
    }

    fn stat(&self, path: &str) -> io::Result<Option<PathStat>> {
        let full = self.resolve(path)?;
        self.assert_no_symlinked_ancestor(path)?;
        match fs::symlink_metadata(full) {
            Ok(meta) if meta.is_file() => Ok(Some(PathStat::File {
                size: meta.len(),
                mtime_ns: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
            })),
            Ok(meta) if meta.is_dir() => Ok(Some(PathStat::Dir)),
            Ok(_) => Ok(Some(PathStat::Other)),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::NotADirectory =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }

    fn read_binary(&self, path: &str) -> io::Result<Vec<u8>> {
        self.assert_no_symlinked_ancestor(path)?;
        fs::read(self.resolve(path)?)
    }

    fn hash_file(&self, path: &str) -> io::Result<String> {
        self.assert_no_symlinked_ancestor(path)?;
        let mut file = File::open(self.resolve(path)?)?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        loop {
            let read = file.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
        }
        Ok(to_hex(&hasher.finalize()))
    }

    fn write_binary(&self, path: &str, data: &[u8]) -> io::Result<()> {
        if path == CLIENT_DATA_PATH {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to overwrite client credentials",
            ));
        }
        let full = self.resolve(path)?;
        self.ensure_parent_dir(path)?;
        let mut mode = None;
        match fs::symlink_metadata(&full) {
            Ok(meta) if meta.is_dir() => {
                fs::remove_dir(&full).map_err(|error| {
                    io::Error::new(
                        error.kind(),
                        format!("Cannot replace non-empty folder {path:?}: {error}"),
                    )
                })?;
            }
            Ok(meta) if meta.is_file() => mode = Some(meta.permissions()),
            _ => {}
        }
        let temp_dir = self.root.join(&self.temp_dir);
        fs::create_dir_all(&temp_dir)?;
        let temp = temp_dir.join(format!(
            "inbound-{}-{}",
            std::process::id(),
            self.counter.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut file = File::create(&temp)?;
            file.write_all(data)?;
            match mode {
                Some(permissions) => file.set_permissions(permissions)?,
                None => file.set_permissions(fs::Permissions::from_mode(0o600))?,
            }
            file.sync_all()?;
            fs::rename(&temp, &full)?;
            sync_parent(&full)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        result
    }

    fn remove(&self, path: &str) -> io::Result<()> {
        self.assert_no_symlinked_ancestor(path)?;
        let full = self.resolve(path)?;
        match fs::symlink_metadata(&full) {
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(&full),
            Ok(_) => fs::remove_file(&full),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::NotADirectory =>
            {
                Ok(())
            }
            Err(error) => Err(error),
        }
    }

    fn prune_empty_parents(&self, path: &str) -> io::Result<()> {
        self.assert_no_symlinked_ancestor(path)?;
        for dir in ancestor_dirs(path).into_iter().rev() {
            match fs::remove_dir(self.resolve(&dir)?) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                // Not empty, or not a plain folder: everything above it stays too.
                Err(_) => return Ok(()),
            }
        }
        Ok(())
    }

    fn list_files_under(&self, prefix: &str) -> io::Result<Vec<String>> {
        let mut files = Vec::new();
        let start = if prefix.is_empty() {
            self.root.clone()
        } else {
            self.assert_no_symlinked_ancestor(prefix)?;
            self.resolve(prefix)?
        };
        let mut stack = vec![(start, prefix.to_string())];
        while let Some((dir, relative)) = stack.pop() {
            let entries = match fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name();
                let Some(name) = name.to_str() else {
                    crate::warning!("list.skipped", reason = "non_utf8_name", dir = relative);
                    continue;
                };
                let child = if relative.is_empty() {
                    name.to_string()
                } else {
                    format!("{relative}/{name}")
                };
                // Never descend into our own journals and staging area.
                if is_sync_excluded_path(&child) {
                    continue;
                }
                let kind = entry.file_type()?;
                if kind.is_dir() {
                    stack.push((entry.path(), child));
                } else if kind.is_file() {
                    files.push(child);
                }
            }
        }
        files.sort();
        Ok(files)
    }
}

#[cfg(test)]
pub mod memory {
    //! In-memory vault, the Rust counterpart of `plugin/src/test/sync.ts`.

    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    pub struct MemoryFs {
        files: Mutex<BTreeMap<String, (Vec<u8>, i128)>>,
        clock: AtomicU64,
        /// Remaining forced failures per operation name.
        failures: Mutex<BTreeMap<&'static str, u32>>,
        /// Paths passed to `prune_empty_parents`. This fake stores no folders.
        pruned: Mutex<Vec<String>>,
    }

    impl MemoryFs {
        pub fn new() -> Self {
            Self::default()
        }

        pub fn pruned(&self) -> Vec<String> {
            self.pruned.lock().unwrap().clone()
        }

        pub fn put(&self, path: &str, data: &[u8]) {
            let stamp = self.tick();
            self.files
                .lock()
                .unwrap()
                .insert(path.to_string(), (data.to_vec(), stamp));
        }

        pub fn get(&self, path: &str) -> Option<Vec<u8>> {
            self.files.lock().unwrap().get(path).map(|f| f.0.clone())
        }

        pub fn text(&self, path: &str) -> String {
            String::from_utf8(self.get(path).expect("file should exist")).unwrap()
        }

        pub fn delete(&self, path: &str) {
            self.files.lock().unwrap().remove(path);
        }

        pub fn list_all_for_test(&self, prefix: &str) -> Vec<String> {
            self.files
                .lock()
                .unwrap()
                .keys()
                .filter(|key| key.starts_with(prefix))
                .cloned()
                .collect()
        }

        pub fn fail_next(&self, operation: &'static str, times: u32) {
            self.failures.lock().unwrap().insert(operation, times);
        }

        fn check_failure(&self, operation: &'static str) -> io::Result<()> {
            let mut failures = self.failures.lock().unwrap();
            if let Some(remaining) = failures.get_mut(operation)
                && *remaining > 0
            {
                *remaining -= 1;
                return Err(io::Error::other(format!("{operation} forced failure")));
            }
            Ok(())
        }

        fn tick(&self) -> i128 {
            i128::from(self.clock.fetch_add(1, Ordering::Relaxed))
        }
    }

    impl SyncFs for MemoryFs {
        fn read(&self, path: &str) -> io::Result<String> {
            self.get(path)
                .map(|bytes| String::from_utf8(bytes).unwrap())
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.to_string()))
        }

        fn write(&self, path: &str, data: &str) -> io::Result<()> {
            self.check_failure("write")?;
            self.put(path, data.as_bytes());
            Ok(())
        }

        fn append(&self, path: &str, data: &str) -> io::Result<()> {
            self.check_failure("append")?;
            let mut current = self.get(path).unwrap_or_default();
            current.extend_from_slice(data.as_bytes());
            self.put(path, &current);
            Ok(())
        }

        fn exists(&self, path: &str) -> io::Result<bool> {
            Ok(self.get(path).is_some())
        }

        fn stat(&self, path: &str) -> io::Result<Option<PathStat>> {
            let files = self.files.lock().unwrap();
            if let Some((data, stamp)) = files.get(path) {
                return Ok(Some(PathStat::File {
                    size: data.len() as u64,
                    mtime_ns: *stamp,
                }));
            }
            let prefix = format!("{path}/");
            if files.keys().any(|key| key.starts_with(&prefix)) {
                return Ok(Some(PathStat::Dir));
            }
            Ok(None)
        }

        fn read_binary(&self, path: &str) -> io::Result<Vec<u8>> {
            self.get(path)
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, path.to_string()))
        }

        fn hash_file(&self, path: &str) -> io::Result<String> {
            Ok(sha256_hex(&self.read_binary(path)?))
        }

        fn write_binary(&self, path: &str, data: &[u8]) -> io::Result<()> {
            self.check_failure("write_binary")?;
            for dir in ancestor_dirs(path) {
                self.files.lock().unwrap().remove(&dir);
            }
            let prefix = format!("{path}/");
            if self
                .files
                .lock()
                .unwrap()
                .keys()
                .any(|key| key.starts_with(&prefix))
            {
                return Err(io::Error::other(format!(
                    "Cannot replace non-empty folder {path:?}"
                )));
            }
            self.put(path, data);
            Ok(())
        }

        fn remove(&self, path: &str) -> io::Result<()> {
            self.check_failure("remove")?;
            let prefix = format!("{path}/");
            self.files
                .lock()
                .unwrap()
                .retain(|key, _| key != path && !key.starts_with(&prefix));
            Ok(())
        }

        fn prune_empty_parents(&self, path: &str) -> io::Result<()> {
            self.check_failure("prune")?;
            self.pruned.lock().unwrap().push(path.to_string());
            Ok(())
        }

        fn list_files_under(&self, prefix: &str) -> io::Result<Vec<String>> {
            let nested = format!("{prefix}/");
            Ok(self
                .files
                .lock()
                .unwrap()
                .keys()
                .filter(|key| prefix.is_empty() || *key == prefix || key.starts_with(&nested))
                .filter(|key| !is_sync_excluded_path(key))
                .cloned()
                .collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn local() -> (TempDir, LocalFs) {
        let dir = TempDir::new().unwrap();
        let fs = LocalFs::new(
            dir.path(),
            ".obsidian/plugins/obsidian-sync-engine/state/x/tmp",
        );
        (dir, fs)
    }

    #[test]
    fn journal_write_and_read_round_trip_and_leave_no_temporaries() {
        let (dir, fs) = local();
        fs.write("state/outbox.jsonl", "one\n").unwrap();
        fs.write("state/outbox.jsonl", "two\n").unwrap();
        assert_eq!(fs.read("state/outbox.jsonl").unwrap(), "two\n");
        let names: Vec<_> = fs::read_dir(dir.path().join("state"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["outbox.jsonl"]);
    }

    #[test]
    fn a_backup_left_by_an_interrupted_plugin_write_is_recovered() {
        let (dir, fs) = local();
        fs::write(dir.path().join("inbox.jsonl.bak"), "committed\n").unwrap();
        assert!(fs.exists("inbox.jsonl").unwrap());
        assert_eq!(fs.read("inbox.jsonl").unwrap(), "committed\n");
        assert!(!dir.path().join("inbox.jsonl.bak").exists());
    }

    #[test]
    fn append_creates_parents_and_appends() {
        let (_dir, fs) = local();
        fs.append("a/b/log.jsonl", "1\n").unwrap();
        fs.append("a/b/log.jsonl", "2\n").unwrap();
        assert_eq!(fs.read("a/b/log.jsonl").unwrap(), "1\n2\n");
    }

    #[test]
    fn write_binary_creates_folders_and_stages_outside_the_visible_vault() {
        let (dir, fs) = local();
        fs.write_binary("Crabcake/Hello World.md", b"hi").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("Crabcake/Hello World.md")).unwrap(),
            b"hi"
        );
        assert_eq!(
            fs.list_files_under("").unwrap(),
            ["Crabcake/Hello World.md"]
        );
    }

    #[test]
    fn write_binary_keeps_existing_mode_and_binary_bytes() {
        let (dir, fs) = local();
        let target = dir.path().join("a.bin");
        std::fs::write(&target, b"old").unwrap();
        std::fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let bytes: Vec<u8> = (0..=255).collect();
        fs.write_binary("a.bin", &bytes).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), bytes);
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o640);
    }

    #[test]
    fn write_binary_replaces_a_file_ancestor_with_a_directory() {
        let (dir, fs) = local();
        std::fs::write(dir.path().join("a"), b"file").unwrap();
        fs.write_binary("a/b.md", b"nested").unwrap();
        assert_eq!(std::fs::read(dir.path().join("a/b.md")).unwrap(), b"nested");
    }

    #[test]
    fn write_binary_replaces_only_an_empty_directory() {
        let (dir, fs) = local();
        std::fs::create_dir(dir.path().join("empty")).unwrap();
        fs.write_binary("empty", b"now a file").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("empty")).unwrap(),
            b"now a file"
        );
        std::fs::create_dir(dir.path().join("full")).unwrap();
        std::fs::write(dir.path().join("full/x"), b"x").unwrap();
        let error = fs.write_binary("full", b"nope").unwrap_err();
        assert!(error.to_string().contains("non-empty folder"));
        assert_eq!(std::fs::read(dir.path().join("full/x")).unwrap(), b"x");
    }

    #[test]
    fn refuses_paths_that_escape_the_vault() {
        let (_dir, fs) = local();
        for path in ["../evil.md", "/etc/passwd", "a/../../evil.md", "a//b", ""] {
            assert!(fs.write_binary(path, b"x").is_err(), "{path:?}");
            assert!(fs.remove(path).is_err(), "{path:?}");
            assert!(fs.read_binary(path).is_err(), "{path:?}");
        }
        assert!(fs.write_binary(CLIENT_DATA_PATH, b"x").is_err());
    }

    #[test]
    fn refuses_to_write_through_a_symlinked_directory() {
        let (dir, fs) = local();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(fs.write_binary("link/evil.md", b"x").is_err());
        assert!(fs.remove("link/evil.md").is_err());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn remove_handles_files_folders_and_missing_paths() {
        let (dir, fs) = local();
        fs.write_binary("folder/a.md", b"a").unwrap();
        fs.write_binary("b.md", b"b").unwrap();
        fs.remove("b.md").unwrap();
        fs.remove("never-existed.md").unwrap();
        fs.remove("b.md/child").unwrap();
        fs.remove("folder").unwrap();
        assert!(!dir.path().join("folder").exists());
    }

    #[test]
    fn pruning_removes_only_empty_parents() {
        let (dir, fs) = local();
        fs.write_binary("a/b/c/note.md", b"x").unwrap();
        fs.write_binary("a/keep.md", b"x").unwrap();
        fs.remove("a/b/c/note.md").unwrap();
        fs.prune_empty_parents("a/b/c/note.md").unwrap();
        assert!(!dir.path().join("a/b").exists());
        assert!(dir.path().join("a/keep.md").exists());

        fs.remove("a/keep.md").unwrap();
        fs.prune_empty_parents("a/keep.md").unwrap();
        assert!(!dir.path().join("a").exists());
        assert!(dir.path().exists());
        fs.prune_empty_parents("top-level.md").unwrap();
        fs.prune_empty_parents("never/existed.md").unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pruning_never_follows_a_symlink() {
        let (dir, fs) = local();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join("link")).unwrap();
        assert!(fs.prune_empty_parents("link/gone.md").is_err());
        assert!(outside.path().exists());
        assert!(dir.path().join("link").exists());
    }

    #[test]
    fn listing_skips_state_symlinks_and_never_follows_links() {
        let (dir, fs) = local();
        fs.write_binary("a.md", b"a").unwrap();
        fs.write("x.jsonl", "").unwrap();
        fs.write(
            ".obsidian/plugins/obsidian-sync-engine/state/x/outbox.jsonl",
            "",
        )
        .unwrap();
        std::fs::write(
            dir.path()
                .join(".obsidian/plugins/obsidian-sync-engine/data.json"),
            "{}",
        )
        .unwrap();
        std::os::unix::fs::symlink(dir.path().join("a.md"), dir.path().join("link.md")).unwrap();
        assert_eq!(fs.list_files_under("").unwrap(), ["a.md", "x.jsonl"]);
        assert_eq!(fs.stat("link.md").unwrap(), Some(PathStat::Other));
        assert_eq!(fs.stat("missing.md").unwrap(), None);
        assert_eq!(fs.stat("a.md/child").unwrap(), None);
    }

    #[test]
    fn hash_file_matches_in_memory_hash() {
        let (_dir, fs) = local();
        fs.write_binary("a.bin", b"some bytes").unwrap();
        assert_eq!(fs.hash_file("a.bin").unwrap(), sha256_hex(b"some bytes"));
    }
}
