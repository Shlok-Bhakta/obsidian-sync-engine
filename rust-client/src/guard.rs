//! Safety interlocks with no plugin counterpart.
//!
//! [`MassPushGuard`] stops a bad unmount or an `rm -rf` from reaching every other
//! device. [`is_obsidian_process`] keeps this client off the shared journals
//! while the real plugin is running.

use crate::protocol::OpKind;
use std::collections::VecDeque;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::{Duration, Instant};

pub const DEFAULT_MAX_DELETES: usize = 50;
pub const DEFAULT_MAX_PUTS: usize = 300;
const WINDOW: Duration = Duration::from_secs(10 * 60);

/// Counts queued plus recently pushed operations, so a slow delete spread over
/// many ticks cannot slip under the limit. Tripping stops all network work
/// until a person runs `approve-mass-push`.
pub struct MassPushGuard {
    max_deletes: usize,
    max_puts: usize,
    recent: VecDeque<(Instant, OpKind)>,
    approved: bool,
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Tripped {
    pub deletes: usize,
    pub puts: usize,
}

impl MassPushGuard {
    pub fn new(max_deletes: usize, max_puts: usize) -> Self {
        Self {
            max_deletes,
            max_puts,
            recent: VecDeque::new(),
            approved: false,
        }
    }

    pub fn check(
        &mut self,
        pending_deletes: usize,
        pending_puts: usize,
        now: Instant,
    ) -> Option<Tripped> {
        while let Some((at, _)) = self.recent.front() {
            if now.duration_since(*at) > WINDOW {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.approved {
            return None;
        }
        let recent_deletes = self
            .recent
            .iter()
            .filter(|(_, kind)| *kind == OpKind::Delete)
            .count();
        let recent_puts = self.recent.len() - recent_deletes;
        let deletes = pending_deletes + recent_deletes;
        let puts = pending_puts + recent_puts;
        (deletes > self.max_deletes || puts > self.max_puts).then_some(Tripped { deletes, puts })
    }

    pub fn record_pushed(&mut self, kind: OpKind, now: Instant) {
        self.recent.push_back((now, kind));
    }

    pub fn approve(&mut self) {
        self.approved = true;
    }

    /// Approval covers one batch: it ends once the outbox has been emptied.
    pub fn outbox_emptied(&mut self) {
        if self.approved {
            self.approved = false;
            self.recent.clear();
        }
    }
}

/// Whether a process is the Obsidian desktop app (or one of its Electron
/// helpers), going by its `comm` and argv. Must not match this client, whose
/// `comm` is `obsidian-sync-c`, or an editor opening a file named "obsidian".
pub fn is_obsidian_process(comm: &str, cmdline: &[String]) -> bool {
    let comm = comm.trim().to_ascii_lowercase();
    if comm == "obsidian" || comm.starts_with(".obsidian-wrap") {
        return true;
    }
    let argv0 = cmdline.first().map(String::as_str).unwrap_or_default();
    let name = argv0
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == "obsidian" {
        return true;
    }
    comm.starts_with("electron")
        && cmdline.iter().any(|arg| {
            let arg = arg.to_ascii_lowercase();
            arg.contains("obsidian.asar") || arg.contains("/obsidian/")
        })
}

/// Scans `/proc` for an Obsidian process owned by the given user.
pub fn obsidian_running(proc_root: &Path, uid: u32) -> bool {
    let Ok(entries) = fs::read_dir(proc_root) else {
        return false;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let dir = entry.path();
        if fs::metadata(&dir).map(|m| m.uid()).ok() != Some(uid) {
            continue;
        }
        let comm = fs::read_to_string(dir.join("comm")).unwrap_or_default();
        let cmdline: Vec<String> = fs::read(dir.join("cmdline"))
            .unwrap_or_default()
            .split(|byte| *byte == 0)
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect();
        if is_obsidian_process(&comm, &cmdline) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn recognizes_obsidian_installs() {
        assert!(is_obsidian_process(
            "obsidian\n",
            &args(&["/opt/Obsidian/obsidian"])
        ));
        assert!(is_obsidian_process(
            "obsidian",
            &args(&["/app/obsidian/obsidian", "--type=renderer"])
        ));
        assert!(is_obsidian_process(".obsidian-wrapp", &args(&[])));
        assert!(is_obsidian_process(
            "electron",
            &args(&["electron", "/usr/lib/obsidian/obsidian.asar"])
        ));
        assert!(is_obsidian_process(
            "AppRun",
            &args(&["/tmp/.mount/obsidian"])
        ));
    }

    #[test]
    fn does_not_match_other_processes() {
        assert!(!is_obsidian_process(
            "obsidian-sync-c",
            &args(&["/home/x/.local/bin/obsidian-sync-client", "run"])
        ));
        assert!(!is_obsidian_process(
            "nvim",
            &args(&["nvim", "/home/x/obsidian-notes/a.md"])
        ));
        assert!(!is_obsidian_process(
            "bash",
            &args(&["bash", "-c", "cd obsidian"])
        ));
        assert!(!is_obsidian_process(
            "electron",
            &args(&["electron", "/usr/lib/slack/app.asar"])
        ));
        assert!(!is_obsidian_process("", &args(&[])));
    }

    #[test]
    fn scans_a_fake_proc_tree() {
        let dir = tempfile::TempDir::new().unwrap();
        let uid = fs::metadata(dir.path()).unwrap().uid();
        let pid = dir.path().join("123");
        fs::create_dir(&pid).unwrap();
        fs::write(pid.join("comm"), "bash\n").unwrap();
        fs::write(pid.join("cmdline"), b"bash\0").unwrap();
        fs::create_dir(dir.path().join("self")).unwrap();
        assert!(!obsidian_running(dir.path(), uid));

        let obsidian = dir.path().join("456");
        fs::create_dir(&obsidian).unwrap();
        fs::write(obsidian.join("comm"), "obsidian\n").unwrap();
        fs::write(obsidian.join("cmdline"), b"/opt/Obsidian/obsidian\0").unwrap();
        assert!(obsidian_running(dir.path(), uid));
        // Someone else's Obsidian has its own vault and is not a concern.
        assert!(!obsidian_running(dir.path(), uid + 1));
    }

    #[test]
    fn guard_allows_normal_batches() {
        let mut guard = MassPushGuard::new(50, 300);
        assert_eq!(guard.check(50, 300, Instant::now()), None);
    }

    #[test]
    fn guard_trips_on_a_large_delete_or_change_batch() {
        let mut guard = MassPushGuard::new(50, 300);
        assert_eq!(
            guard.check(51, 0, Instant::now()),
            Some(Tripped {
                deletes: 51,
                puts: 0
            })
        );
        assert_eq!(
            guard.check(0, 301, Instant::now()),
            Some(Tripped {
                deletes: 0,
                puts: 301
            })
        );
    }

    #[test]
    fn guard_counts_recent_pushes_so_a_slow_delete_cannot_slip_past() {
        let mut guard = MassPushGuard::new(3, 300);
        let now = Instant::now();
        for _ in 0..3 {
            assert_eq!(guard.check(0, 0, now), None);
            guard.record_pushed(OpKind::Delete, now);
        }
        assert_eq!(
            guard.check(1, 0, now),
            Some(Tripped {
                deletes: 4,
                puts: 0
            })
        );
    }

    #[test]
    fn guard_window_expires() {
        let mut guard = MassPushGuard::new(3, 300);
        let start = Instant::now();
        for _ in 0..3 {
            guard.record_pushed(OpKind::Delete, start);
        }
        assert!(guard.check(1, 0, start).is_some());
        assert_eq!(
            guard.check(1, 0, start + WINDOW + Duration::from_secs(1)),
            None
        );
    }

    #[test]
    fn approval_covers_one_batch() {
        let mut guard = MassPushGuard::new(1, 1);
        let now = Instant::now();
        assert!(guard.check(5, 0, now).is_some());
        guard.approve();
        assert_eq!(guard.check(5, 0, now), None);
        guard.record_pushed(OpKind::Delete, now);
        guard.outbox_emptied();
        assert!(guard.check(5, 0, now).is_some());
        // The approved batch does not count against the next one.
        assert_eq!(guard.check(1, 0, now), None);
    }
}
