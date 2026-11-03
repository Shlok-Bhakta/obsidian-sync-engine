//! Port of `plugin/src/sync/inbox.ts`.

use crate::fs::SyncFs;
use crate::jsonl::{read_lines, write_lines};
use crate::protocol::{InboxOp, OpKind};
use anyhow::Result;

pub fn write_inbox(fs: &dyn SyncFs, path: &str, lines: &[InboxOp]) -> Result<()> {
    write_lines(fs, path, lines)
}

pub fn read_inbox(fs: &dyn SyncFs, path: &str) -> Result<Vec<InboxOp>> {
    read_lines(fs, path)
}

/// Appends freshly fetched ops onto the durable inbox file.
pub fn append_inbox(fs: &dyn SyncFs, path: &str, ops: &[InboxOp]) -> Result<()> {
    if ops.is_empty() {
        return Ok(());
    }
    let mut lines = read_inbox(fs, path)?;
    lines.extend_from_slice(ops);
    write_inbox(fs, path, &lines)
}

pub trait InboxHandler {
    fn apply_put(&mut self, path: &str) -> Result<()>;
    fn apply_delete(&mut self, path: &str) -> Result<()>;
    fn get_revision(&mut self) -> Result<u64>;
    fn set_revision(&mut self, revision: u64) -> Result<()>;
    /// True skips the vault mutation but still advances past the line.
    fn should_skip_apply(&mut self, _op: &InboxOp) -> Result<bool> {
        Ok(false)
    }
    /// True leaves this line and all later lines durable for a later tick.
    fn should_defer_apply(&mut self, _op: &InboxOp) -> Result<bool> {
        Ok(false)
    }
}

/// Applies inbox lines oldest revision first. Each line is either dropped
/// (already covered by the revision), deferred, skipped, or applied. The order
/// apply, set revision, rewrite journal makes a crash at any point safe: the
/// worst case replays one idempotent line. On failure this stops, leaving that
/// line and everything after it in the file.
pub fn apply_inbox(
    fs: &dyn SyncFs,
    inbox_path: &str,
    handler: &mut dyn InboxHandler,
) -> Result<()> {
    let mut lines = read_inbox(fs, inbox_path)?;
    lines.sort_by_key(|line| line.rev);
    let mut current = handler.get_revision()?;
    let mut remaining = lines.as_slice();

    while let Some((line, rest)) = remaining.split_first() {
        if line.rev <= current {
            remaining = rest;
            write_inbox(fs, inbox_path, remaining)?;
            continue;
        }
        if handler.should_defer_apply(line)? {
            crate::info!(
                "apply.deferred",
                path = line.path,
                operation = line.op.as_str(),
                revision = line.rev
            );
            return Ok(());
        }
        if !handler.should_skip_apply(line)? {
            match line.op {
                OpKind::Put => handler.apply_put(&line.path)?,
                OpKind::Delete => handler.apply_delete(&line.path)?,
            }
        }
        handler.set_revision(line.rev)?;
        current = line.rev;
        remaining = rest;
        write_inbox(fs, inbox_path, remaining)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::memory::MemoryFs;
    use anyhow::anyhow;
    use std::collections::HashSet;

    const INBOX: &str = "inbox.jsonl";

    fn put(rev: u64, path: &str) -> InboxOp {
        InboxOp {
            rev,
            op: OpKind::Put,
            path: path.into(),
        }
    }

    fn delete(rev: u64, path: &str) -> InboxOp {
        InboxOp {
            rev,
            op: OpKind::Delete,
            path: path.into(),
        }
    }

    #[derive(Default)]
    struct Recorder {
        revision: u64,
        applied: Vec<String>,
        fail_on: Option<String>,
        skip: HashSet<String>,
        skip_revs: HashSet<u64>,
        defer: bool,
    }

    impl InboxHandler for Recorder {
        fn apply_put(&mut self, path: &str) -> Result<()> {
            self.applied.push(path.into());
            if self.fail_on.as_deref() == Some(path) {
                return Err(anyhow!("write failed"));
            }
            Ok(())
        }
        fn apply_delete(&mut self, path: &str) -> Result<()> {
            self.apply_put(path)
        }
        fn get_revision(&mut self) -> Result<u64> {
            Ok(self.revision)
        }
        fn set_revision(&mut self, revision: u64) -> Result<()> {
            self.revision = revision;
            Ok(())
        }
        fn should_skip_apply(&mut self, op: &InboxOp) -> Result<bool> {
            Ok(self.skip.contains(&op.path) || self.skip_revs.remove(&op.rev))
        }
        fn should_defer_apply(&mut self, _op: &InboxOp) -> Result<bool> {
            Ok(self.defer)
        }
    }

    #[test]
    fn read_returns_empty_when_missing() {
        assert!(read_inbox(&MemoryFs::new(), INBOX).unwrap().is_empty());
    }

    #[test]
    fn write_read_round_trips() {
        let fs = MemoryFs::new();
        let lines = [put(1, "a.md"), delete(2, "b.md")];
        write_inbox(&fs, INBOX, &lines).unwrap();
        assert_eq!(read_inbox(&fs, INBOX).unwrap(), lines);
    }

    #[test]
    fn applies_ascending_by_rev_bumps_revision_and_drops_lines() {
        let fs = MemoryFs::new();
        write_inbox(
            &fs,
            INBOX,
            &[put(3, "c.md"), put(1, "a.md"), delete(2, "b.md")],
        )
        .unwrap();
        let mut handler = Recorder::default();
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert_eq!(handler.applied, ["a.md", "b.md", "c.md"]);
        assert_eq!(handler.revision, 3);
        assert!(read_inbox(&fs, INBOX).unwrap().is_empty());
    }

    #[test]
    fn stops_on_first_failure_leaving_remaining_lines_and_revision() {
        let fs = MemoryFs::new();
        write_inbox(
            &fs,
            INBOX,
            &[put(1, "a.md"), put(2, "b.md"), delete(3, "c.md")],
        )
        .unwrap();
        let mut handler = Recorder {
            fail_on: Some("b.md".into()),
            ..Default::default()
        };
        let error = apply_inbox(&fs, INBOX, &mut handler).unwrap_err();
        assert_eq!(error.to_string(), "write failed");
        assert_eq!(handler.applied, ["a.md", "b.md"]);
        assert_eq!(handler.revision, 1);
        assert_eq!(
            read_inbox(&fs, INBOX).unwrap(),
            [put(2, "b.md"), delete(3, "c.md")]
        );
    }

    #[test]
    fn skip_advances_revision_and_drops_the_line() {
        let fs = MemoryFs::new();
        write_inbox(
            &fs,
            INBOX,
            &[put(1, "a.md"), put(2, "pending.md"), put(3, "c.md")],
        )
        .unwrap();
        let mut handler = Recorder::default();
        handler.skip.insert("pending.md".into());
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert_eq!(handler.applied, ["a.md", "c.md"]);
        assert_eq!(handler.revision, 3);
        assert!(read_inbox(&fs, INBOX).unwrap().is_empty());
    }

    #[test]
    fn skip_by_rev_consumes_the_echo() {
        let fs = MemoryFs::new();
        write_inbox(
            &fs,
            INBOX,
            &[put(1, "a.md"), put(2, "echoed.md"), put(3, "c.md")],
        )
        .unwrap();
        let mut handler = Recorder::default();
        handler.skip_revs.insert(2);
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert_eq!(handler.applied, ["a.md", "c.md"]);
        assert_eq!(handler.revision, 3);
        assert!(handler.skip_revs.is_empty());
    }

    #[test]
    fn defer_neither_advances_nor_drops() {
        let fs = MemoryFs::new();
        write_inbox(&fs, INBOX, &[put(2, "a.md")]).unwrap();
        let mut handler = Recorder {
            revision: 1,
            defer: true,
            ..Default::default()
        };
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert!(handler.applied.is_empty());
        assert_eq!(handler.revision, 1);
        assert_eq!(read_inbox(&fs, INBOX).unwrap(), [put(2, "a.md")]);
    }

    #[test]
    fn drops_lines_already_covered_without_reapplying() {
        let fs = MemoryFs::new();
        write_inbox(&fs, INBOX, &[put(1, "a.md"), put(2, "b.md")]).unwrap();
        let mut handler = Recorder {
            revision: 1,
            ..Default::default()
        };
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert_eq!(handler.applied, ["b.md"]);
        assert_eq!(handler.revision, 2);
        assert!(read_inbox(&fs, INBOX).unwrap().is_empty());
    }

    #[test]
    fn duplicated_lines_from_a_deferred_refetch_apply_once() {
        let fs = MemoryFs::new();
        write_inbox(&fs, INBOX, &[put(5, "a.md")]).unwrap();
        append_inbox(&fs, INBOX, &[put(5, "a.md"), put(6, "b.md")]).unwrap();
        let mut handler = Recorder::default();
        apply_inbox(&fs, INBOX, &mut handler).unwrap();
        assert_eq!(handler.applied, ["a.md", "b.md"]);
        assert_eq!(handler.revision, 6);
    }

    #[test]
    fn append_keeps_existing_lines_and_is_a_no_op_for_empty() {
        let fs = MemoryFs::new();
        append_inbox(&fs, INBOX, &[put(1, "a.md")]).unwrap();
        append_inbox(&fs, INBOX, &[put(2, "b.md")]).unwrap();
        append_inbox(&fs, INBOX, &[]).unwrap();
        assert_eq!(
            read_inbox(&fs, INBOX).unwrap(),
            [put(1, "a.md"), put(2, "b.md")]
        );
    }
}
