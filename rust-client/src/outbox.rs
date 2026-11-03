//! Port of `plugin/src/sync/outbox.ts`. The plugin's per-path mutex is not
//! needed: every journal access here happens on the daemon's single thread.

use crate::fs::SyncFs;
use crate::jsonl::{read_lines, write_lines};
use crate::protocol::OpKind;
use anyhow::Result;
use serde::{Deserialize, Serialize};

/// Field order matches the plugin's `JSON.stringify` output, so the journal is
/// interchangeable with one written by Obsidian.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct OutboxOp {
    pub op: OpKind,
    pub path: String,
    pub ts: u64,
    #[serde(rename = "baseRevision", skip_serializing_if = "Option::is_none")]
    pub base_revision: Option<u64>,
}

fn same_op(a: &OutboxOp, b: &OutboxOp) -> bool {
    a.op == b.op && a.path == b.path && a.ts == b.ts
}

fn coalesce(ops: Vec<OutboxOp>) -> Vec<OutboxOp> {
    let mut result: Vec<OutboxOp> = Vec::with_capacity(ops.len());
    for op in ops {
        match result.last_mut() {
            Some(last)
                if last.op == OpKind::Put && op.op == OpKind::Put && last.path == op.path =>
            {
                *last = op;
            }
            _ => result.push(op),
        }
    }
    result
}

pub fn enqueue(fs: &dyn SyncFs, outbox_path: &str, op: &OutboxOp) -> Result<()> {
    fs.append(outbox_path, &(serde_json::to_string(op)? + "\n"))?;
    Ok(())
}

pub fn list(fs: &dyn SyncFs, outbox_path: &str) -> Result<Vec<OutboxOp>> {
    Ok(coalesce(read_lines(fs, outbox_path)?))
}

/// Processes a snapshot of the outbox in order. A handled line is removed only
/// after success, matched against the re-read file so a line appended during
/// the handler survives. Stops at the first failure, keeping it and all later
/// lines.
pub fn drain(
    fs: &dyn SyncFs,
    outbox_path: &str,
    mut handler: impl FnMut(&OutboxOp) -> Result<()>,
) -> Result<()> {
    let snapshot: Vec<OutboxOp> = read_lines(fs, outbox_path)?;
    for op in &snapshot {
        handler(op)?;
        let mut current: Vec<OutboxOp> = read_lines(fs, outbox_path)?;
        if let Some(index) = current.iter().position(|candidate| same_op(candidate, op)) {
            current.remove(index);
            write_lines(fs, outbox_path, &current)?;
        } else {
            crate::warning!(
                "drain.acknowledgement_missing",
                path = op.path,
                operation = op.op.as_str()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::memory::MemoryFs;
    use anyhow::anyhow;

    const OUTBOX: &str = "outbox.jsonl";

    fn op(kind: OpKind, path: &str, ts: u64) -> OutboxOp {
        OutboxOp {
            op: kind,
            path: path.into(),
            ts,
            base_revision: None,
        }
    }

    #[test]
    fn journal_bytes_match_the_plugin() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        enqueue(
            &fs,
            OUTBOX,
            &OutboxOp {
                op: OpKind::Delete,
                path: "b c.md".into(),
                ts: 2,
                base_revision: Some(7),
            },
        )
        .unwrap();
        assert_eq!(
            fs.text(OUTBOX),
            "{\"op\":\"put\",\"path\":\"a.md\",\"ts\":1}\n{\"op\":\"delete\",\"path\":\"b c.md\",\"ts\":2,\"baseRevision\":7}\n"
        );
    }

    #[test]
    fn reads_lines_written_by_the_plugin() {
        let fs = MemoryFs::new();
        fs.write(
            OUTBOX,
            "{\"op\":\"delete\",\"path\":\"x.md\",\"ts\":9,\"baseRevision\":4}\n",
        )
        .unwrap();
        assert_eq!(
            list(&fs, OUTBOX).unwrap(),
            [OutboxOp {
                op: OpKind::Delete,
                path: "x.md".into(),
                ts: 9,
                base_revision: Some(4),
            }]
        );
    }

    #[test]
    fn coalesces_consecutive_puts_to_the_same_path() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 2)).unwrap();
        assert_eq!(list(&fs, OUTBOX).unwrap(), [op(OpKind::Put, "a.md", 2)]);
    }

    #[test]
    fn does_not_coalesce_different_paths() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "b.md", 2)).unwrap();
        assert_eq!(list(&fs, OUTBOX).unwrap().len(), 2);
    }

    #[test]
    fn does_not_coalesce_put_after_delete() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Delete, "a.md", 1)).unwrap();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 2)).unwrap();
        assert_eq!(
            list(&fs, OUTBOX).unwrap(),
            [op(OpKind::Delete, "a.md", 1), op(OpKind::Put, "a.md", 2)]
        );
    }

    #[test]
    fn drain_handles_in_order_and_removes_succeeded_lines() {
        let fs = MemoryFs::new();
        let ops = [
            op(OpKind::Put, "a.md", 1),
            op(OpKind::Put, "b.md", 2),
            op(OpKind::Delete, "c.md", 3),
        ];
        for line in &ops {
            enqueue(&fs, OUTBOX, line).unwrap();
        }
        let mut seen = Vec::new();
        drain(&fs, OUTBOX, |line| {
            seen.push(line.clone());
            Ok(())
        })
        .unwrap();
        assert_eq!(seen, ops);
        assert!(list(&fs, OUTBOX).unwrap().is_empty());
    }

    #[test]
    fn drain_stops_on_first_failure_and_keeps_remaining_lines() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "b.md", 2)).unwrap();
        enqueue(&fs, OUTBOX, &op(OpKind::Delete, "c.md", 3)).unwrap();
        let mut seen = Vec::new();
        let error = drain(&fs, OUTBOX, |line| {
            seen.push(line.path.clone());
            if line.path == "b.md" {
                return Err(anyhow!("upload failed"));
            }
            Ok(())
        })
        .unwrap_err();
        assert_eq!(error.to_string(), "upload failed");
        assert_eq!(seen, ["a.md", "b.md"]);
        assert_eq!(
            list(&fs, OUTBOX).unwrap(),
            [op(OpKind::Put, "b.md", 2), op(OpKind::Delete, "c.md", 3)]
        );
    }

    #[test]
    fn enqueue_during_drain_is_not_lost() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        let mut seen = Vec::new();
        drain(&fs, OUTBOX, |line| {
            seen.push(line.path.clone());
            enqueue(&fs, OUTBOX, &op(OpKind::Put, "b.md", 2))
        })
        .unwrap();
        assert_eq!(seen, ["a.md"]);
        assert_eq!(list(&fs, OUTBOX).unwrap(), [op(OpKind::Put, "b.md", 2)]);
    }

    #[test]
    fn a_newer_same_path_put_survives_acknowledgment_of_an_in_flight_put() {
        let fs = MemoryFs::new();
        enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 1)).unwrap();
        drain(&fs, OUTBOX, |_| {
            enqueue(&fs, OUTBOX, &op(OpKind::Put, "a.md", 2))
        })
        .unwrap();
        assert_eq!(list(&fs, OUTBOX).unwrap(), [op(OpKind::Put, "a.md", 2)]);
    }
}
