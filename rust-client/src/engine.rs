//! Port of `plugin/src/sync/engine.ts`: local edits flow out through the outbox,
//! remote edits flow in through the inbox, and the revision cursor advances only
//! when inbox lines are applied, including the echo of our own pushes.
//!
//! What differs from the plugin is how local changes are found (see
//! `tracker.rs`) and that everything runs on one thread, so the plugin's
//! mutexes and in-flight bookkeeping have no counterpart here.

use crate::fs::{PathStat, SyncFs, sha256_hex};
use crate::guard::{MassPushGuard, Tripped};
use crate::inbox::{InboxHandler, append_inbox, apply_inbox};
use crate::jsonl::read_lines;
use crate::outbox::{self, OutboxOp};
use crate::paths::{
    ancestor_dirs, canonicalize_sync_path, contains_client_state, is_sync_excluded_path,
    is_watched_path, paths_structurally_conflict, state_root,
};
use crate::protocol::{InboxOp, OpKind};
use crate::tracker::Tracker;
use crate::transport::{PermanentRemoteError, RemoteFileNotFoundError, Transport};
use anyhow::{Result, bail};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub trait RevisionStore {
    fn get(&self) -> u64;
    fn set(&mut self, revision: u64) -> Result<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalPaths {
    pub state_dir: String,
    pub outbox: String,
    pub inbox: String,
    pub dead_letter: String,
    pub manifest: String,
    pub approval: String,
    pub conflicts: String,
    pub temp: String,
    pub lock: String,
}

impl JournalPaths {
    pub fn for_identity(identity: &str) -> Self {
        let state_dir = format!("{}/{identity}", state_root());
        Self {
            outbox: format!("{state_dir}/outbox.jsonl"),
            inbox: format!("{state_dir}/inbox.jsonl"),
            dead_letter: format!("{state_dir}/dead-letter.jsonl"),
            manifest: format!("{state_dir}/rust-client-manifest.json"),
            approval: format!("{state_dir}/approve-mass-push"),
            conflicts: format!("{state_dir}/conflicts"),
            temp: format!("{state_dir}/tmp"),
            lock: format!("{state_dir}/rust-client.lock"),
            state_dir,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureKind {
    Error,
    DeadLetter,
    Suspended,
    Halted,
}

/// Discriminated result so callers never treat a failed tick as success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TickResult {
    pub failure: Option<(FailureKind, String)>,
    pub pushed: usize,
    pub applied: usize,
    pub dead_lettered: usize,
}

impl TickResult {
    #[cfg(test)]
    pub fn ok(&self) -> bool {
        self.failure.is_none()
    }
}

/// Too many pending or recent changes; nothing goes out until a person approves.
#[derive(Debug)]
pub struct MassPushHalted(pub Tripped);

impl fmt::Display for MassPushHalted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "refusing to push {} deletes and {} changes without approval; inspect the vault, then run `obsidian-sync-client approve-mass-push`",
            self.0.deletes, self.0.puts
        )
    }
}

impl std::error::Error for MassPushHalted {}

#[derive(Debug)]
struct SuspendedError;

impl fmt::Display for SuspendedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Sync is suspended")
    }
}

impl std::error::Error for SuspendedError {}

/// How the engine brought its manifest up to date on start.
#[derive(Debug, PartialEq, Eq)]
pub enum StartupOutcome {
    /// No manifest yet: the disk became the baseline and nothing was queued.
    FirstRun { files: usize },
    /// `data.json` moved past the manifest, so the plugin (or a crash) wrote
    /// last. Its changes are already handled, so nothing was queued.
    Rebaselined { differing: usize },
    /// Files changed while nothing was running; these were queued.
    Resumed {
        queued_puts: usize,
        queued_deletes: usize,
    },
    /// Revision 0: every file was queued, as the plugin's auto-seed does.
    Seeded { files: usize },
}

pub struct EngineOptions {
    pub paths: JournalPaths,
    pub suspended: Arc<AtomicBool>,
    pub guard: MassPushGuard,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct SyncEngine {
    fs: Arc<dyn SyncFs>,
    transport: Box<dyn Transport>,
    revision: Box<dyn RevisionStore>,
    paths: JournalPaths,
    suspended: Arc<AtomicBool>,
    guard: MassPushGuard,
    tracker: Tracker,
    /// Paths with a local change in the durable outbox. Hydrated on start so a
    /// restart cannot pull over pending work.
    pending_outbox_paths: BTreeSet<String>,
    failed_enqueues: BTreeMap<String, OutboxOp>,
    hydrated: bool,
}

impl SyncEngine {
    pub fn new(
        fs: Arc<dyn SyncFs>,
        transport: Box<dyn Transport>,
        revision: Box<dyn RevisionStore>,
        options: EngineOptions,
    ) -> Self {
        let tracker = Tracker::empty(options.paths.manifest.clone());
        Self {
            fs,
            transport,
            revision,
            paths: options.paths,
            suspended: options.suspended,
            guard: options.guard,
            tracker,
            pending_outbox_paths: BTreeSet::new(),
            failed_enqueues: BTreeMap::new(),
            hydrated: false,
        }
    }

    #[cfg(test)]
    pub fn is_pending(&self, path: &str) -> bool {
        self.pending_outbox_paths.contains(path)
    }

    pub fn revision(&self) -> u64 {
        self.revision.get()
    }

    pub fn replace_revision_store(&mut self, revision: Box<dyn RevisionStore>) {
        self.revision = revision;
    }

    #[cfg(test)]
    pub fn replace_transport(&mut self, transport: Box<dyn Transport>) {
        self.transport = transport;
    }

    pub fn tracked_files(&self) -> usize {
        self.tracker.len()
    }

    fn assert_active(&self) -> Result<()> {
        if self.suspended.load(Ordering::SeqCst) {
            return Err(SuspendedError.into());
        }
        Ok(())
    }

    /// Loads durable outbox paths into the conflict guard before the first pull.
    pub fn hydrate(&mut self) -> Result<()> {
        let ops = outbox::list(&*self.fs, &self.paths.outbox)?;
        self.pending_outbox_paths = ops.into_iter().map(|op| op.path).collect();
        self.pending_outbox_paths
            .extend(self.failed_enqueues.keys().cloned());
        self.hydrated = true;
        Ok(())
    }

    fn ensure_hydrated(&mut self) -> Result<()> {
        if !self.hydrated {
            self.hydrate()?;
        }
        Ok(())
    }

    /// Durably queues a local change. The network work happens on a later tick.
    pub fn enqueue_durable(&mut self, raw_path: &str, op: OpKind) -> Result<()> {
        self.assert_active()?;
        let path = canonicalize_sync_path(raw_path)?.to_string();
        let intent = OutboxOp {
            op,
            path: path.clone(),
            ts: now_ms(),
            base_revision: (op == OpKind::Delete).then(|| self.revision.get()),
        };
        self.pending_outbox_paths.insert(path.clone());
        if let Err(error) = outbox::enqueue(&*self.fs, &self.paths.outbox, &intent) {
            crate::error!(
                "enqueue.failed",
                path = path,
                operation = op.as_str(),
                error = format!("{error:#}"),
            );
            self.failed_enqueues.insert(path, intent);
            return Err(error);
        }
        self.failed_enqueues.remove(&path);
        crate::info!("enqueue.persisted", path = path, operation = op.as_str());
        Ok(())
    }

    fn retry_failed_enqueues(&mut self) -> Result<()> {
        for (path, op) in self.failed_enqueues.clone() {
            crate::warning!("enqueue.retrying", path = path, operation = op.op.as_str());
            outbox::enqueue(&*self.fs, &self.paths.outbox, &op)?;
            self.failed_enqueues.remove(&path);
            // The change was never recorded because the first enqueue failed.
            match self.fs.stat(&path)? {
                Some(stat @ PathStat::File { .. }) => {
                    let hash = self.fs.hash_file(&path)?;
                    self.tracker.record(&path, hash, stat);
                }
                _ => self.tracker.forget(&path),
            }
        }
        Ok(())
    }

    /// Queues whatever differs between disk and manifest for these paths. This
    /// is the entry point for the filesystem watcher. A path whose bytes match
    /// the manifest, like every file this client just wrote, queues nothing.
    /// Returns how many operations were queued.
    pub fn reconcile_paths(&mut self, dirty: &[String]) -> Result<usize> {
        let mut deletes = BTreeSet::new();
        let mut puts = BTreeSet::new();
        for path in dirty {
            if path.is_empty() {
                continue;
            }
            match self.fs.stat(path)? {
                Some(PathStat::File { .. }) => {
                    if is_watched_path(path) {
                        puts.insert(path.clone());
                    }
                    // A folder became a file: its old children are gone.
                    for child in self.tracker.tracked_under(path) {
                        if child != *path {
                            deletes.insert(child);
                        }
                    }
                }
                Some(PathStat::Dir) => {
                    // A renamed folder yields one event, not one per child, so
                    // both sides of the move are expanded here.
                    if self.tracker.contains(path) {
                        deletes.insert(path.clone());
                    }
                    for file in self.fs.list_files_under(path)? {
                        if is_watched_path(&file) {
                            puts.insert(file);
                        }
                    }
                    for tracked in self.tracker.tracked_under(path) {
                        if tracked != *path && self.fs.stat(&tracked)?.is_none() {
                            deletes.insert(tracked);
                        }
                    }
                }
                Some(PathStat::Other) | None => {
                    deletes.extend(self.tracker.tracked_under(path));
                }
            }
        }

        let mut queued = 0;
        // Deletes first, matching the plugin's rename order (delete old, put new).
        for path in deletes {
            match self.enqueue_durable(&path, OpKind::Delete) {
                Ok(()) => {
                    self.tracker.forget(&path);
                    queued += 1;
                }
                Err(error) if error.is::<SuspendedError>() => return Err(error),
                Err(_) => {}
            }
        }
        for path in puts {
            let Some(stat @ PathStat::File { .. }) = self.fs.stat(&path)? else {
                continue;
            };
            let hash = self.fs.hash_file(&path)?;
            if self.tracker.hash_of(&path) == Some(hash.as_str()) {
                self.tracker.record(&path, hash, stat);
                continue;
            }
            match self.enqueue_durable(&path, OpKind::Put) {
                Ok(()) => {
                    self.tracker.record(&path, hash, stat);
                    queued += 1;
                }
                Err(error) if error.is::<SuspendedError>() => return Err(error),
                Err(_) => {}
            }
        }
        Ok(queued)
    }

    /// Stat pass used periodically and when the watcher overflows.
    pub fn rescan(&mut self) -> Result<usize> {
        let diff = self.tracker.scan(&*self.fs)?;
        let mut dirty = diff.missing;
        dirty.extend(diff.changed.into_iter().map(|(path, _)| path));
        self.reconcile_paths(&dirty)
    }

    /// Brings the manifest up to date before the first tick. See
    /// [`StartupOutcome`] for the cases. The important property: no case can
    /// turn a stale or missing local copy into a push.
    pub fn startup_reconcile(&mut self, allow_seed: bool) -> Result<StartupOutcome> {
        self.ensure_hydrated()?;
        let revision = self.revision.get();
        let loaded = Tracker::load(&*self.fs, &self.paths.manifest)?;
        let outcome = match loaded {
            None if revision == 0 => {
                if !allow_seed {
                    bail!(
                        "revision is 0, so this client would upload the whole vault to the server. Re-run with --allow-seed if that is intended"
                    );
                }
                self.seed()?
            }
            None => {
                self.tracker = Tracker::empty(self.paths.manifest.clone());
                self.tracker.rebaseline(&*self.fs, revision)?;
                StartupOutcome::FirstRun {
                    files: self.tracker.len(),
                }
            }
            Some(mut tracker) if tracker.revision() != revision => {
                let differing = tracker.rebaseline(&*self.fs, revision)?;
                self.tracker = tracker;
                StartupOutcome::Rebaselined { differing }
            }
            Some(tracker) => {
                self.tracker = tracker;
                self.reconcile_offline_changes()?
            }
        };
        self.tracker.save(&*self.fs, revision)?;
        Ok(outcome)
    }

    /// The plugin just owned the vault. Everything on disk is its result, so
    /// the manifest is rebuilt with nothing queued.
    pub fn rebaseline_after_handover(&mut self) -> Result<()> {
        let revision = self.revision.get();
        let differing = self.tracker.rebaseline(&*self.fs, revision)?;
        crate::info!(
            "handover.rebaselined",
            differing_files = differing,
            revision = revision,
        );
        Ok(())
    }

    fn seed(&mut self) -> Result<StartupOutcome> {
        // An explicit --allow-seed is the approval for this one large batch.
        self.guard.approve();
        self.tracker = Tracker::empty(self.paths.manifest.clone());
        let files: Vec<String> = self
            .fs
            .list_files_under("")?
            .into_iter()
            .filter(|path| is_watched_path(path))
            .collect();
        let queued = self.reconcile_paths(&files)?;
        Ok(StartupOutcome::Seeded { files: queued })
    }

    /// Handles edits made while the service was down. Each candidate is checked
    /// against the server first, so a crash between writing a file and saving
    /// the manifest can never re-push content the server already has.
    fn reconcile_offline_changes(&mut self) -> Result<StartupOutcome> {
        let diff = self.tracker.scan(&*self.fs)?;
        let mut puts = Vec::new();
        let mut deletes = Vec::new();
        let mut conflict_copies = Vec::new();
        for (path, hash) in &diff.changed {
            match self.remote_bytes(path)? {
                Some(remote) if sha256_hex(&remote) == *hash => {
                    if let Some(stat) = self.fs.stat(path)? {
                        self.tracker.record(path, hash.clone(), stat);
                    }
                }
                Some(remote) => {
                    // Local edits win, as they do for a pending path in the
                    // plugin. If the server also moved, keep its bytes on disk
                    // instead of losing them silently.
                    if self.tracker.hash_of(path) != Some(sha256_hex(&remote).as_str()) {
                        conflict_copies.push((path.clone(), remote));
                    }
                    puts.push(path.clone());
                }
                None => puts.push(path.clone()),
            }
        }
        for path in &diff.missing {
            match self.remote_bytes(path)? {
                // The base revision on the delete protects anything newer on
                // the server, so a remote edit comes back through the inbox.
                Some(_) => deletes.push(path.clone()),
                None => self.tracker.forget(path),
            }
        }

        let ops = outbox::list(&*self.fs, &self.paths.outbox)?;
        let pending_deletes = ops.iter().filter(|op| op.op == OpKind::Delete).count();
        self.consume_approval()?;
        if let Some(tripped) = self.guard.check(
            pending_deletes + deletes.len(),
            ops.len() - pending_deletes + puts.len(),
            Instant::now(),
        ) {
            return Err(MassPushHalted(tripped).into());
        }

        for (path, remote) in &conflict_copies {
            self.keep_conflict_copy(path, remote)?;
        }
        let mut dirty = deletes.clone();
        dirty.extend(puts.iter().cloned());
        self.reconcile_paths(&dirty)?;
        Ok(StartupOutcome::Resumed {
            queued_puts: puts.len(),
            queued_deletes: deletes.len(),
        })
    }

    fn remote_bytes(&self, path: &str) -> Result<Option<Vec<u8>>> {
        match self.transport.download(path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.is::<RemoteFileNotFoundError>() => Ok(None),
            Err(error) => Err(error),
        }
    }

    fn keep_conflict_copy(&self, path: &str, remote: &[u8]) -> Result<()> {
        let copy = format!("{}/{}/{path}", self.paths.conflicts, now_ms());
        self.fs.write_binary(&copy, remote)?;
        crate::warning!("conflict.server_copy_kept", path = path, copy = copy);
        Ok(())
    }

    fn consume_approval(&mut self) -> Result<()> {
        if self.fs.exists(&self.paths.approval)? {
            self.fs.remove(&self.paths.approval)?;
            self.guard.approve();
            crate::warning!("mass_push.approved");
        }
        Ok(())
    }

    /// True when a person has asked for a halted startup to be retried.
    pub fn approval_pending(&self) -> Result<bool> {
        Ok(self.fs.exists(&self.paths.approval)?)
    }

    /// One sync round: drain the outbox, then pull and apply the inbox.
    pub fn tick(&mut self) -> TickResult {
        let mut result = TickResult {
            failure: None,
            pushed: 0,
            applied: 0,
            dead_lettered: 0,
        };
        if let Err(error) = self.run_tick(&mut result) {
            let kind = if error.is::<SuspendedError>() {
                FailureKind::Suspended
            } else if error.is::<MassPushHalted>() {
                FailureKind::Halted
            } else {
                FailureKind::Error
            };
            result.failure = Some((kind, format!("{error:#}")));
        } else if result.dead_lettered > 0 {
            result.failure = Some((
                FailureKind::DeadLetter,
                format!("{} operation(s) require attention", result.dead_lettered),
            ));
        }
        if let Err(error) = self.save_manifest() {
            crate::error!("manifest.save_failed", error = format!("{error:#}"));
        }
        result
    }

    pub fn save_manifest(&mut self) -> Result<()> {
        let revision = self.revision.get();
        self.tracker.save(&*self.fs, revision)
    }

    fn run_tick(&mut self, result: &mut TickResult) -> Result<()> {
        self.assert_active()?;
        self.retry_failed_enqueues()?;
        self.ensure_hydrated()?;
        self.check_mass_push()?;
        loop {
            self.drain_outbox_once(result)?;
            if outbox::list(&*self.fs, &self.paths.outbox)?.is_empty() {
                self.guard.outbox_emptied();
                break;
            }
        }
        self.rebuild_pending_paths()?;
        result.applied = self.apply_remote_inbox()?;
        Ok(())
    }

    fn check_mass_push(&mut self) -> Result<()> {
        let ops = outbox::list(&*self.fs, &self.paths.outbox)?;
        if ops.is_empty() {
            return Ok(());
        }
        let deletes = ops.iter().filter(|op| op.op == OpKind::Delete).count();
        self.consume_approval()?;
        if let Some(tripped) = self
            .guard
            .check(deletes, ops.len() - deletes, Instant::now())
        {
            return Err(MassPushHalted(tripped).into());
        }
        Ok(())
    }

    fn drain_outbox_once(&mut self, result: &mut TickResult) -> Result<()> {
        let fs = Arc::clone(&self.fs);
        let outbox_path = self.paths.outbox.clone();
        let mut processed = BTreeSet::new();
        outbox::drain(&*fs, &outbox_path, |op| {
            let is_file = matches!(fs.stat(&op.path), Ok(Some(PathStat::File { .. })));
            if op.op == OpKind::Put && !is_file {
                processed.insert(op.path.clone());
                crate::warning!(
                    "outbox.put_skipped",
                    path = op.path,
                    reason = "local_file_missing",
                );
                return Ok(());
            }
            let pushed = match op.op {
                OpKind::Put => self.push_put(&op.path),
                OpKind::Delete => self.push_delete(&op.path, op.base_revision),
            };
            match pushed {
                Ok(revision) => {
                    processed.insert(op.path.clone());
                    result.pushed += 1;
                    self.guard.record_pushed(op.op, Instant::now());
                    crate::info!(
                        "outbox.operation_pushed",
                        path = op.path,
                        operation = op.op.as_str(),
                        revision = revision,
                    );
                    Ok(())
                }
                Err(error) if error.is::<PermanentRemoteError>() => {
                    self.dead_letter(op, &error)?;
                    result.dead_lettered += 1;
                    processed.insert(op.path.clone());
                    crate::error!(
                        "outbox.operation_dead_lettered",
                        path = op.path,
                        operation = op.op.as_str(),
                        error = format!("{error:#}"),
                    );
                    Ok(())
                }
                Err(error) => {
                    crate::error!(
                        "outbox.operation_failed",
                        path = op.path,
                        operation = op.op.as_str(),
                        error = format!("{error:#}"),
                    );
                    Err(error)
                }
            }
        })?;
        for path in processed {
            self.refresh_pending(&path)?;
        }
        Ok(())
    }

    fn refresh_pending(&mut self, path: &str) -> Result<()> {
        let still_queued = outbox::list(&*self.fs, &self.paths.outbox)?
            .iter()
            .any(|op| op.path == path);
        if still_queued {
            self.pending_outbox_paths.insert(path.to_string());
        } else {
            self.pending_outbox_paths.remove(path);
        }
        Ok(())
    }

    fn rebuild_pending_paths(&mut self) -> Result<()> {
        self.pending_outbox_paths = outbox::list(&*self.fs, &self.paths.outbox)?
            .into_iter()
            .map(|op| op.path)
            .collect();
        self.pending_outbox_paths
            .extend(self.failed_enqueues.keys().cloned());
        Ok(())
    }

    fn dead_letter(&self, op: &OutboxOp, error: &anyhow::Error) -> Result<()> {
        let status = error
            .downcast_ref::<PermanentRemoteError>()
            .map(|permanent| permanent.status);
        let note = serde_json::json!({
            "kind": "dead-letter",
            "op": op.op.as_str(),
            "path": op.path,
            "originalTs": op.ts,
            "error": format!("{error:#}"),
            "status": status,
            "ts": now_ms(),
        });
        let path = &self.paths.dead_letter;
        let existing = if self.fs.exists(path)? {
            self.fs.read(path)?
        } else {
            String::new()
        };
        let base = if existing.is_empty() || existing.ends_with('\n') {
            existing
        } else {
            existing + "\n"
        };
        self.fs.write(path, &format!("{base}{note}\n"))?;
        Ok(())
    }

    fn push_put(&self, path: &str) -> Result<u64> {
        self.assert_active()?;
        let body = self.fs.read_binary(path)?;
        self.assert_active()?;
        self.transport.upload(path, &body)
    }

    fn push_delete(&self, path: &str, base_revision: Option<u64>) -> Result<u64> {
        self.assert_active()?;
        self.transport.delete_remote(path, base_revision)
    }

    fn apply_remote_inbox(&mut self) -> Result<usize> {
        self.assert_active()?;
        let revision = self.revision.get();
        let ops = self.transport.fetch_inbox(revision)?;
        self.assert_active()?;
        if !ops.is_empty() {
            let deletes = ops.iter().filter(|op| op.op == OpKind::Delete).count();
            crate::info!(
                "inbox.fetched",
                revision = revision,
                operations = ops.len(),
                deletes = deletes,
            );
        }
        let fs = Arc::clone(&self.fs);
        let inbox_path = self.paths.inbox.clone();
        append_inbox(&*fs, &inbox_path, &ops)?;
        let mut applier = Applier {
            engine: self,
            applied: 0,
        };
        apply_inbox(&*fs, &inbox_path, &mut applier)?;
        Ok(applier.applied)
    }

    /// Checks a path the inbox is about to touch for a change the watcher has
    /// not delivered yet. This closes the race between a user saving a file and
    /// the debounced event: the edit is queued and the inbox line deferred, so
    /// the pending-path rule protects it just as it does in the plugin.
    fn queue_unobserved_changes(&mut self, path: &str) -> Result<bool> {
        let mut candidates: Vec<String> = ancestor_dirs(path);
        candidates.push(path.to_string());
        let mut dirty = Vec::new();
        for candidate in &candidates {
            let is_target = candidate == path;
            match self.fs.stat(candidate)? {
                Some(PathStat::File { .. }) => {
                    if is_watched_path(candidate)
                        && !self.tracker.matches_disk(&*self.fs, candidate)?
                    {
                        dirty.push(candidate.clone());
                    }
                }
                Some(PathStat::Dir) if is_target => {
                    for file in self.fs.list_files_under(candidate)? {
                        if is_watched_path(&file) && !self.tracker.matches_disk(&*self.fs, &file)? {
                            dirty.push(file);
                        }
                    }
                }
                Some(PathStat::Dir) => {}
                _ => {
                    if is_target && self.tracker.contains(candidate) {
                        dirty.push(candidate.clone());
                    }
                }
            }
        }
        if dirty.is_empty() {
            return Ok(false);
        }
        Ok(self.reconcile_paths(&dirty)? > 0)
    }

    fn apply_remote_put(&mut self, path: &str) -> Result<()> {
        canonicalize_sync_path(path)?;
        if is_sync_excluded_path(path) {
            crate::warning!(
                "inbox.put_skipped",
                path = path,
                reason = "client_state_path",
            );
            return Ok(());
        }
        let data = match self.transport.download(path) {
            Ok(data) => data,
            Err(error) => {
                self.assert_active()?;
                // A stale put raced a later delete: treat as success so the
                // inbox can advance. A later tombstone still applies normally.
                if error.is::<RemoteFileNotFoundError>() {
                    crate::warning!(
                        "inbox.put_skipped",
                        path = path,
                        reason = "remote_file_missing",
                    );
                    return Ok(());
                }
                return Err(error);
            }
        };
        self.assert_active()?;
        // The echo of our own upload usually lands here. Skipping the rewrite
        // spares an mtime bump and a pointless watcher event.
        let already_there = matches!(self.fs.stat(path)?, Some(PathStat::File { .. }))
            && self.fs.hash_file(path)? == sha256_hex(&data);
        if !already_there {
            self.fs.write_binary(path, &data)?;
            for dir in ancestor_dirs(path) {
                self.tracker.forget(&dir);
            }
        }
        self.tracker.record_written(&*self.fs, path, &data)
    }

    fn apply_remote_delete(&mut self, path: &str) -> Result<()> {
        canonicalize_sync_path(path)?;
        if contains_client_state(path) {
            crate::warning!(
                "inbox.delete_skipped",
                path = path,
                reason = "would_remove_client_state",
            );
            return Ok(());
        }
        self.fs.remove(path)?;
        for tracked in self.tracker.tracked_under(path) {
            self.tracker.forget(&tracked);
        }
        // The server only tracks files, so a folder deleted on another device
        // arrives as deletes of its files. Hidden folders hold app config.
        if !path.split('/').any(|segment| segment.starts_with('.'))
            && let Err(error) = self.fs.prune_empty_parents(path)
        {
            crate::warning!("inbox.prune_failed", path = path, error = error.to_string(),);
        }
        Ok(())
    }
}

struct Applier<'a> {
    engine: &'a mut SyncEngine,
    applied: usize,
}

impl InboxHandler for Applier<'_> {
    fn apply_put(&mut self, path: &str) -> Result<()> {
        self.engine.assert_active()?;
        self.engine.apply_remote_put(path)?;
        self.applied += 1;
        crate::info!("inbox.put_applied", path = path);
        Ok(())
    }

    fn apply_delete(&mut self, path: &str) -> Result<()> {
        self.engine.assert_active()?;
        self.engine.apply_remote_delete(path)?;
        self.applied += 1;
        crate::info!("inbox.delete_applied", path = path);
        Ok(())
    }

    fn get_revision(&mut self) -> Result<u64> {
        Ok(self.engine.revision.get())
    }

    fn set_revision(&mut self, revision: u64) -> Result<()> {
        self.engine.assert_active()?;
        self.engine.revision.set(revision)
    }

    fn should_defer_apply(&mut self, op: &InboxOp) -> Result<bool> {
        if self
            .engine
            .pending_outbox_paths
            .iter()
            .any(|pending| paths_structurally_conflict(pending, &op.path))
        {
            return Ok(true);
        }
        self.engine.queue_unobserved_changes(&op.path)
    }
}

/// Line count for the status command. Journals have differing shapes.
pub fn count_lines(fs: &dyn SyncFs, path: &str) -> Result<usize> {
    let lines: Vec<serde_json::Value> = read_lines(fs, path)?;
    Ok(lines.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::memory::MemoryFs;
    use crate::guard::{DEFAULT_MAX_DELETES, DEFAULT_MAX_PUTS};
    use crate::inbox::{read_inbox, write_inbox};
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::Mutex;

    fn journals() -> JournalPaths {
        JournalPaths::for_identity("test-server")
    }

    /// A fake server modelling the shared revision log. Like the real one, the
    /// inbox has one line per path, at that path's newest revision.
    #[derive(Default)]
    struct FakeServer {
        revision: u64,
        files: BTreeMap<String, Vec<u8>>,
        log: Vec<InboxOp>,
        uploads: Vec<String>,
        deletes: Vec<(String, Option<u64>)>,
        downloads: Vec<String>,
        fetches: Vec<u64>,
        fail_uploads: bool,
        permanent_failure: Option<String>,
    }

    impl FakeServer {
        fn apply(&mut self, op: OpKind, path: &str, content: Option<&[u8]>) -> u64 {
            self.revision += 1;
            match content {
                Some(bytes) => {
                    self.files.insert(path.to_string(), bytes.to_vec());
                }
                None => {
                    self.files.remove(path);
                }
            }
            self.log.retain(|line| line.path != path);
            self.log.push(InboxOp {
                rev: self.revision,
                op,
                path: path.to_string(),
            });
            self.revision
        }

        fn remote_put(&mut self, path: &str, content: &[u8]) -> u64 {
            self.apply(OpKind::Put, path, Some(content))
        }

        fn remote_delete(&mut self, path: &str) -> u64 {
            self.apply(OpKind::Delete, path, None)
        }
    }

    #[derive(Clone)]
    struct Server(Arc<Mutex<FakeServer>>);

    impl Transport for Server {
        fn upload(&self, path: &str, body: &[u8]) -> Result<u64> {
            let mut server = self.0.lock().unwrap();
            if server.fail_uploads {
                bail!("Upload of {path:?} failed with status 503: unavailable");
            }
            if server.permanent_failure.as_deref() == Some(path) {
                return Err(PermanentRemoteError {
                    message: "Payload too large".into(),
                    status: 413,
                }
                .into());
            }
            server.uploads.push(path.to_string());
            Ok(server.apply(OpKind::Put, path, Some(body)))
        }

        fn delete_remote(&self, path: &str, base_revision: Option<u64>) -> Result<u64> {
            let mut server = self.0.lock().unwrap();
            server.deletes.push((path.to_string(), base_revision));
            // Causal delete: a file newer than the base revision survives.
            if let Some(base) = base_revision
                && let Some(line) = server.log.iter().find(|line| line.path == path)
                && line.rev > base
                && line.op == OpKind::Put
            {
                return Ok(line.rev);
            }
            Ok(server.apply(OpKind::Delete, path, None))
        }

        fn download(&self, path: &str) -> Result<Vec<u8>> {
            let mut server = self.0.lock().unwrap();
            server.downloads.push(path.to_string());
            server
                .files
                .get(path)
                .cloned()
                .ok_or_else(|| RemoteFileNotFoundError { path: path.into() }.into())
        }

        fn fetch_inbox(&self, revision: u64) -> Result<Vec<InboxOp>> {
            let mut server = self.0.lock().unwrap();
            server.fetches.push(revision);
            Ok(server
                .log
                .iter()
                .filter(|line| line.rev > revision)
                .cloned()
                .collect())
        }
    }

    #[derive(Clone)]
    struct Revision(Rc<RefCell<u64>>);

    impl RevisionStore for Revision {
        fn get(&self) -> u64 {
            *self.0.borrow()
        }
        fn set(&mut self, revision: u64) -> Result<()> {
            *self.0.borrow_mut() = revision;
            Ok(())
        }
    }

    struct Harness {
        fs: Arc<MemoryFs>,
        server: Server,
        revision: Revision,
        suspended: Arc<AtomicBool>,
        engine: SyncEngine,
    }

    impl Harness {
        fn new(start_revision: u64) -> Self {
            Self::build(
                Arc::new(MemoryFs::new()),
                Server(Arc::new(Mutex::new(FakeServer::default()))),
                Revision(Rc::new(RefCell::new(start_revision))),
                MassPushGuard::new(DEFAULT_MAX_DELETES, DEFAULT_MAX_PUTS),
            )
        }

        fn build(
            fs: Arc<MemoryFs>,
            server: Server,
            revision: Revision,
            guard: MassPushGuard,
        ) -> Self {
            let suspended = Arc::new(AtomicBool::new(false));
            let engine = SyncEngine::new(
                fs.clone(),
                Box::new(server.clone()),
                Box::new(revision.clone()),
                EngineOptions {
                    paths: journals(),
                    suspended: suspended.clone(),
                    guard,
                },
            );
            Self {
                fs,
                server,
                revision,
                suspended,
                engine,
            }
        }

        /// Simulates a process restart over the same disk and server.
        fn restart(self) -> Self {
            Self::build(
                self.fs,
                self.server,
                self.revision,
                MassPushGuard::new(DEFAULT_MAX_DELETES, DEFAULT_MAX_PUTS),
            )
        }

        fn server(&self) -> std::sync::MutexGuard<'_, FakeServer> {
            self.server.0.lock().unwrap()
        }

        fn outbox(&self) -> Vec<OutboxOp> {
            outbox::list(&*self.fs, &journals().outbox).unwrap()
        }

        fn inbox(&self) -> Vec<InboxOp> {
            read_inbox(&*self.fs, &journals().inbox).unwrap()
        }

        fn rev(&self) -> u64 {
            self.revision.get()
        }

        fn ready(mut self) -> Self {
            self.engine.startup_reconcile(false).unwrap();
            self
        }

        fn edit(&mut self, path: &str, content: &[u8]) {
            self.fs.put(path, content);
            self.engine.reconcile_paths(&[path.to_string()]).unwrap();
        }
    }

    fn enqueue_raw(fs: &MemoryFs, op: OpKind, path: &str, ts: u64) {
        outbox::enqueue(
            fs,
            &journals().outbox,
            &OutboxOp {
                op,
                path: path.into(),
                ts,
                base_revision: None,
            },
        )
        .unwrap();
    }

    // --- Ported from plugin/src/sync/engine.test.ts ---

    #[test]
    fn tick_drains_the_outbox_before_applying_the_inbox() {
        let mut h = Harness::new(5).ready();
        h.server().revision = 5;
        h.server().remote_put("remote.md", b"from the server");
        h.edit("local.md", b"hello world");
        let result = h.engine.tick();
        assert!(result.ok(), "{result:?}");
        assert_eq!(h.server().uploads, ["local.md"]);
        assert!(h.outbox().is_empty());
        assert_eq!(h.fs.text("remote.md"), "from the server");
        assert!(h.inbox().is_empty());
        assert_eq!(h.rev(), 7);
    }

    #[test]
    fn uploading_alone_does_not_move_the_cursor() {
        struct NoInbox(Server);
        impl Transport for NoInbox {
            fn upload(&self, path: &str, body: &[u8]) -> Result<u64> {
                self.0.upload(path, body)
            }
            fn delete_remote(&self, path: &str, base: Option<u64>) -> Result<u64> {
                self.0.delete_remote(path, base)
            }
            fn download(&self, path: &str) -> Result<Vec<u8>> {
                self.0.download(path)
            }
            fn fetch_inbox(&self, _revision: u64) -> Result<Vec<InboxOp>> {
                Ok(Vec::new())
            }
        }
        let mut h = Harness::new(1).ready();
        let server = h.server.clone();
        h.engine.replace_transport(Box::new(NoInbox(server)));
        h.edit("a.md", b"content");
        h.engine.tick();
        assert_eq!(h.server().revision, 1);
        assert_eq!(h.rev(), 1);
    }

    #[test]
    fn the_echo_of_our_own_push_advances_the_cursor_without_rewriting() {
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.edit("a.md", b"content");
        let before = h.fs.stat("a.md").unwrap();
        h.engine.tick();
        assert_eq!(h.rev(), 2);
        assert!(h.inbox().is_empty());
        assert_eq!(h.fs.text("a.md"), "content");
        assert_eq!(
            h.fs.stat("a.md").unwrap(),
            before,
            "no rewrite, so no watcher event"
        );
    }

    #[test]
    fn an_offline_local_put_survives_an_older_remote_tombstone() {
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.server().remote_delete("a.md");
        h.edit("a.md", b"offline edit");
        assert!(h.engine.tick().ok());
        assert_eq!(h.rev(), 3);
        assert_eq!(h.fs.text("a.md"), "offline edit");
        assert_eq!(h.server().files["a.md"], b"offline edit");
    }

    #[test]
    fn a_pending_path_is_not_overwritten_by_an_inbound_put() {
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.edit("a.md", b"local-v2");
        h.server().remote_put("a.md", b"remote-should-not-land");
        assert!(h.engine.is_pending("a.md"));
        h.engine.tick();
        assert_eq!(h.fs.text("a.md"), "local-v2");
        assert_eq!(h.server().files["a.md"], b"local-v2");
    }

    #[test]
    fn draining_a_put_for_a_locally_deleted_file_skips_without_error() {
        let mut h = Harness::new(1).ready();
        enqueue_raw(&h.fs, OpKind::Put, "a.md", 1);
        let result = h.engine.tick();
        assert!(result.ok());
        assert!(h.server().uploads.is_empty());
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn a_skipped_put_does_not_block_the_delete_behind_it() {
        let mut h = Harness::new(1).ready();
        enqueue_raw(&h.fs, OpKind::Put, "a.md", 1);
        enqueue_raw(&h.fs, OpKind::Delete, "a.md", 2);
        h.engine.tick();
        assert!(h.server().uploads.is_empty());
        assert_eq!(h.server().deletes.len(), 1);
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn a_remote_delete_prunes_visible_folders_only() {
        let mut h = Harness::new(0);
        h.engine.startup_reconcile(true).unwrap();
        h.server().remote_delete("folder/note.md");
        h.server().remote_delete(".obsidian/snippets/old.css");
        assert!(h.engine.tick().ok());
        assert_eq!(h.fs.pruned(), ["folder/note.md"]);
    }

    #[test]
    fn a_failed_prune_still_applies_the_delete() {
        let mut h = Harness::new(0);
        h.engine.startup_reconcile(true).unwrap();
        h.server().remote_delete("folder/note.md");
        h.fs.fail_next("prune", 1);
        assert!(h.engine.tick().ok());
        assert_eq!(h.rev(), 1);
        assert!(h.inbox().is_empty());
    }

    #[test]
    fn a_failing_remote_delete_keeps_the_line_and_the_cursor() {
        let mut h = Harness::new(0);
        h.engine.startup_reconcile(true).unwrap();
        h.server().remote_delete("gone.md");
        h.fs.fail_next("remove", 1);
        let result = h.engine.tick();
        assert!(!result.ok());
        assert_eq!(h.rev(), 0);
        assert_eq!(h.inbox().len(), 1);
        // The next tick recovers.
        assert!(h.engine.tick().ok());
        assert_eq!(h.rev(), 1);
        assert!(h.inbox().is_empty());
    }

    #[test]
    fn a_remote_put_whose_download_404s_is_skipped_so_apply_can_advance() {
        let mut h = Harness::new(0);
        h.engine.startup_reconcile(true).unwrap();
        h.server().log.push(InboxOp {
            rev: 1,
            op: OpKind::Put,
            path: "race.md".into(),
        });
        assert!(h.engine.tick().ok());
        assert_eq!(h.rev(), 1);
        assert!(h.inbox().is_empty());
        assert_eq!(h.fs.stat("race.md").unwrap(), None);
    }

    #[test]
    fn hydrate_marks_journal_paths_pending_before_the_first_pull() {
        let mut h = Harness::new(1);
        h.fs.put("local.md", b"mine");
        enqueue_raw(&h.fs, OpKind::Put, "local.md", 1);
        h.server().revision = 1;
        h.server()
            .remote_put("local.md", b"remote-wins-if-not-pending");
        h.engine.hydrate().unwrap();
        assert!(h.engine.is_pending("local.md"));
        h.engine.startup_reconcile(false).unwrap();
        h.engine.tick();
        assert_eq!(h.fs.text("local.md"), "mine");
        assert_eq!(h.server().uploads, ["local.md"]);
    }

    #[test]
    fn dead_lettering_a_permanent_failure_does_not_block_later_ops() {
        let mut h = Harness::new(1).ready();
        h.server().permanent_failure = Some("big.md".into());
        h.edit("big.md", b"too big");
        h.edit("ok.md", b"fine");
        let result = h.engine.tick();
        assert!(!result.ok());
        assert_eq!(result.failure.as_ref().unwrap().0, FailureKind::DeadLetter);
        assert_eq!(result.dead_lettered, 1);
        assert_eq!(result.pushed, 1);
        assert!(h.outbox().is_empty());
        assert_eq!(h.server().uploads, ["ok.md"]);
        let note: serde_json::Value =
            serde_json::from_str(h.fs.text(&journals().dead_letter).trim()).unwrap();
        assert_eq!(note["kind"], "dead-letter");
        assert_eq!(note["path"], "big.md");
        assert_eq!(note["status"], 413);
    }

    #[test]
    fn a_transient_upload_failure_keeps_the_op_and_skips_the_inbox() {
        let mut h = Harness::new(1).ready();
        h.server().fail_uploads = true;
        h.edit("a.md", b"x");
        let result = h.engine.tick();
        assert_eq!(result.failure.as_ref().unwrap().0, FailureKind::Error);
        assert_eq!(h.outbox().len(), 1);
        assert!(
            h.server().fetches.is_empty(),
            "no inbox pull after a failed drain"
        );
        h.server().fail_uploads = false;
        assert!(h.engine.tick().ok());
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn suspension_blocks_network_ticks_and_new_durable_intent() {
        let mut h = Harness::new(1).ready();
        h.fs.put("a.md", b"local");
        h.suspended.store(true, Ordering::SeqCst);
        assert!(h.engine.enqueue_durable("a.md", OpKind::Put).is_err());
        let result = h.engine.tick();
        assert_eq!(result.failure.unwrap().0, FailureKind::Suspended);
        assert!(h.server().fetches.is_empty());
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn a_failed_outbox_append_is_retried_on_the_next_tick() {
        let mut h = Harness::new(1).ready();
        h.fs.put("a.md", b"local");
        h.fs.fail_next("append", 1);
        assert_eq!(h.engine.reconcile_paths(&["a.md".to_string()]).unwrap(), 0);
        assert!(h.engine.is_pending("a.md"));
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().uploads, ["a.md"]);
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn deleting_a_never_uploaded_path_still_goes_through_the_transport() {
        let mut h = Harness::new(1).ready();
        enqueue_raw(&h.fs, OpKind::Delete, "never-uploaded.md", 1);
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().deletes[0].0, "never-uploaded.md");
    }

    #[test]
    fn a_new_delete_carries_the_observed_revision() {
        let mut h = Harness::new(7).ready();
        h.engine
            .enqueue_durable("deleted.md", OpKind::Delete)
            .unwrap();
        assert_eq!(h.outbox()[0].base_revision, Some(7));
        h.engine.tick();
        assert_eq!(h.server().deletes, [("deleted.md".to_string(), Some(7))]);
    }

    #[test]
    fn a_put_never_carries_a_base_revision() {
        let mut h = Harness::new(7).ready();
        h.edit("a.md", b"x");
        assert_eq!(h.outbox()[0].base_revision, None);
    }

    // --- Echo suppression: the watcher sees every write this client makes ---

    #[test]
    fn events_from_inbound_writes_never_queue_anything() {
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.server().remote_put("note.md", b"remote");
        h.server().remote_put("dir/nested.md", b"remote nested");
        assert!(h.engine.tick().ok());
        let events = vec![
            "note.md".to_string(),
            "dir".to_string(),
            "dir/nested.md".to_string(),
        ];
        assert_eq!(h.engine.reconcile_paths(&events).unwrap(), 0);
        assert!(h.outbox().is_empty());
        assert!(h.server().uploads.is_empty());
    }

    #[test]
    fn events_from_inbound_deletes_never_queue_anything() {
        let mut h = Harness::new(1);
        h.fs.put("note.md", b"same");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_delete("note.md");
        assert!(h.engine.tick().ok());
        assert_eq!(h.fs.stat("note.md").unwrap(), None);
        assert_eq!(
            h.engine.reconcile_paths(&["note.md".to_string()]).unwrap(),
            0
        );
        assert!(h.server().deletes.is_empty());
    }

    #[test]
    fn a_real_edit_after_an_inbound_write_is_still_seen() {
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.server().remote_put("note.md", b"remote");
        h.engine.tick();
        h.edit("note.md", b"then edited here");
        assert_eq!(h.outbox().len(), 1);
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().files["note.md"], b"then edited here");
    }

    #[test]
    fn repeated_events_for_the_same_bytes_queue_one_put() {
        let mut h = Harness::new(1).ready();
        h.edit("a.md", b"x");
        let path = vec!["a.md".to_string()];
        assert_eq!(h.engine.reconcile_paths(&path).unwrap(), 0);
        assert_eq!(h.engine.reconcile_paths(&path).unwrap(), 0);
        assert_eq!(h.outbox().len(), 1);
    }

    #[test]
    fn excluded_and_hidden_paths_are_never_queued() {
        let mut h = Harness::new(1).ready();
        let paths = [
            ".obsidian/plugins/obsidian-sync-engine/data.json",
            ".obsidian/plugins/obsidian-sync-engine/state/x/outbox.jsonl",
            ".git/config",
            ".trash/a.md",
            "folder/.hidden",
        ];
        for path in paths {
            h.fs.put(path, b"x");
        }
        let dirty: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
        assert_eq!(h.engine.reconcile_paths(&dirty).unwrap(), 0);
        assert!(h.outbox().is_empty());
    }

    // --- Rename and delete ---

    #[test]
    fn a_file_rename_queues_delete_then_put() {
        let mut h = Harness::new(1);
        h.fs.put("old.md", b"content");
        h.engine.startup_reconcile(false).unwrap();
        h.fs.delete("old.md");
        h.fs.put("new.md", b"content");
        let queued = h
            .engine
            .reconcile_paths(&["old.md".to_string(), "new.md".to_string()])
            .unwrap();
        assert_eq!(queued, 2);
        let ops = h.outbox();
        assert_eq!(
            (ops[0].op, ops[0].path.as_str()),
            (OpKind::Delete, "old.md")
        );
        assert_eq!((ops[1].op, ops[1].path.as_str()), (OpKind::Put, "new.md"));
    }

    #[test]
    fn a_folder_rename_expands_to_every_child() {
        let mut h = Harness::new(1);
        h.fs.put("old/a.md", b"a");
        h.fs.put("old/sub/b.md", b"b");
        h.fs.put("other.md", b"c");
        h.engine.startup_reconcile(false).unwrap();
        h.fs.delete("old/a.md");
        h.fs.delete("old/sub/b.md");
        h.fs.put("new/a.md", b"a");
        h.fs.put("new/sub/b.md", b"b");
        h.engine
            .reconcile_paths(&["old".to_string(), "new".to_string()])
            .unwrap();
        let ops: Vec<(OpKind, String)> = h.outbox().into_iter().map(|o| (o.op, o.path)).collect();
        assert_eq!(
            ops,
            [
                (OpKind::Delete, "old/a.md".to_string()),
                (OpKind::Delete, "old/sub/b.md".to_string()),
                (OpKind::Put, "new/a.md".to_string()),
                (OpKind::Put, "new/sub/b.md".to_string()),
            ]
        );
    }

    #[test]
    fn a_folder_delete_queues_each_child_not_the_folder() {
        let mut h = Harness::new(1);
        h.fs.put("dir/a.md", b"a");
        h.fs.put("dir/b.md", b"b");
        h.engine.startup_reconcile(false).unwrap();
        h.fs.delete("dir/a.md");
        h.fs.delete("dir/b.md");
        h.engine.reconcile_paths(&["dir".to_string()]).unwrap();
        let paths: Vec<String> = h.outbox().into_iter().map(|o| o.path).collect();
        assert_eq!(paths, ["dir/a.md", "dir/b.md"]);
    }

    // --- Conflicts and the local-edit race ---

    #[test]
    fn an_edit_the_watcher_has_not_delivered_is_not_overwritten() {
        let mut h = Harness::new(1);
        h.fs.put("note.md", b"baseline");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_put("note.md", b"remote");
        // Saved just now: no event has reached the engine yet.
        h.fs.put("note.md", b"typed just now");
        let result = h.engine.tick();
        assert!(result.ok());
        assert_eq!(h.fs.text("note.md"), "typed just now");
        assert_eq!(h.inbox().len(), 1, "the inbound line is deferred, not lost");
        assert_eq!(h.rev(), 1);
        // The next tick pushes the edit, then the inbox converges on it.
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().files["note.md"], b"typed just now");
        assert_eq!(h.fs.text("note.md"), "typed just now");
        assert!(h.inbox().is_empty());
        assert_eq!(h.rev(), 3);
    }

    #[test]
    fn an_unobserved_edit_also_blocks_an_inbound_delete() {
        let mut h = Harness::new(1);
        h.fs.put("note.md", b"baseline");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_delete("note.md");
        h.fs.put("note.md", b"typed just now");
        h.engine.tick();
        assert_eq!(h.fs.text("note.md"), "typed just now");
        h.engine.tick();
        assert_eq!(h.fs.text("note.md"), "typed just now");
        assert_eq!(h.server().files["note.md"], b"typed just now");
    }

    #[test]
    fn a_new_unobserved_file_in_a_tombstoned_folder_survives() {
        let mut h = Harness::new(1);
        h.fs.put("dir/old.md", b"old");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_delete("dir");
        h.fs.put("dir/new.md", b"just created");
        h.engine.tick();
        assert_eq!(h.fs.text("dir/new.md"), "just created");
        assert!(h.engine.tick().ok());
        assert_eq!(h.fs.text("dir/new.md"), "just created");
        assert_eq!(h.server().files["dir/new.md"], b"just created");
    }

    #[test]
    fn an_inbound_tree_replacing_an_edited_file_defers() {
        let mut h = Harness::new(1);
        h.fs.put("a", b"a file");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_put("a/b.md", b"nested");
        h.fs.put("a", b"edited file");
        h.engine.tick();
        assert_eq!(h.fs.text("a"), "edited file");
    }

    #[test]
    fn structural_conflicts_between_pending_and_inbound_paths_defer() {
        let mut h = Harness::new(1).ready();
        h.edit("a/b.md", b"local nested");
        assert!(h.engine.is_pending("a/b.md"));
        let mut applier = Applier {
            engine: &mut h.engine,
            applied: 0,
        };
        for path in ["a", "a/b.md", "a/b.md/c"] {
            let op = InboxOp {
                rev: 9,
                op: OpKind::Delete,
                path: path.into(),
            };
            assert!(applier.should_defer_apply(&op).unwrap(), "{path}");
        }
    }

    // --- First catch-up with a stale copy ---

    #[test]
    fn the_first_run_with_a_stale_vault_pushes_nothing() {
        // The server has moved on from the revision this vault was unpacked at.
        let mut h = Harness::new(2517);
        h.fs.put("unchanged.md", b"same on both sides");
        h.fs.put("stale.md", b"old bytes");
        h.fs.put("deleted-remotely.md", b"will go away");
        // "gone.md" is on the server but missing locally, and must not be
        // treated as an intentional local delete.
        {
            let mut server = h.server();
            server.revision = 2517;
            server
                .files
                .insert("unchanged.md".into(), b"same on both sides".to_vec());
            server
                .files
                .insert("gone.md".into(), b"server only".to_vec());
            server.remote_put("stale.md", b"new bytes");
            server.remote_delete("deleted-remotely.md");
            server.remote_put("brand-new.md", b"from the phone");
        }
        let outcome = h.engine.startup_reconcile(false).unwrap();
        assert_eq!(outcome, StartupOutcome::FirstRun { files: 3 });
        assert!(h.outbox().is_empty());

        let result = h.engine.tick();
        assert!(result.ok(), "{result:?}");
        assert_eq!(result.pushed, 0);
        assert_eq!(result.applied, 3);
        assert!(h.server().uploads.is_empty(), "nothing uploaded");
        assert!(h.server().deletes.is_empty(), "nothing deleted");
        assert_eq!(h.fs.text("stale.md"), "new bytes");
        assert_eq!(h.fs.text("brand-new.md"), "from the phone");
        assert_eq!(h.fs.stat("deleted-remotely.md").unwrap(), None);
        assert_eq!(h.rev(), 2520);
        assert!(
            h.server().files.contains_key("gone.md"),
            "server copy untouched"
        );
    }

    #[test]
    fn revision_zero_refuses_to_seed_without_explicit_permission() {
        let mut h = Harness::new(0);
        h.fs.put("a.md", b"a");
        let error = h.engine.startup_reconcile(false).unwrap_err();
        assert!(error.to_string().contains("--allow-seed"));
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn revision_zero_seeds_every_file_when_allowed() {
        let mut h = Harness::new(0);
        h.fs.put("a.md", b"a");
        h.fs.put("b/c.md", b"c");
        h.fs.put(".obsidian/app.json", b"{}");
        let outcome = h.engine.startup_reconcile(true).unwrap();
        assert_eq!(outcome, StartupOutcome::Seeded { files: 3 });
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().uploads.len(), 3);
        assert_eq!(h.rev(), 3);
    }

    #[test]
    fn seeding_more_than_the_limit_is_covered_by_allow_seed() {
        let fs = Arc::new(MemoryFs::new());
        for index in 0..5 {
            fs.put(&format!("{index}.md"), b"x");
        }
        let mut h = Harness::build(
            fs,
            Server(Arc::new(Mutex::new(FakeServer::default()))),
            Revision(Rc::new(RefCell::new(0))),
            MassPushGuard::new(1, 1),
        );
        h.engine.startup_reconcile(true).unwrap();
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().uploads.len(), 5);
    }

    // --- Restart recovery ---

    #[test]
    fn a_clean_restart_pushes_nothing_and_downloads_nothing() {
        let mut h = Harness::new(1);
        h.fs.put("a.md", b"a");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.edit("b.md", b"b");
        h.engine.tick();
        let uploads = h.server().uploads.len();
        let downloads = h.server().downloads.len();
        let mut h = h.restart();
        let outcome = h.engine.startup_reconcile(false).unwrap();
        assert_eq!(
            outcome,
            StartupOutcome::Resumed {
                queued_puts: 0,
                queued_deletes: 0
            }
        );
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().uploads.len(), uploads);
        assert_eq!(h.server().downloads.len(), downloads);
    }

    #[test]
    fn edits_made_while_stopped_are_pushed_on_restart() {
        let mut h = Harness::new(1);
        h.fs.put("edited.md", b"v1");
        h.fs.put("removed.md", b"v1");
        h.engine.startup_reconcile(false).unwrap();
        {
            let mut server = h.server();
            server.revision = 1;
            server.files.insert("edited.md".into(), b"v1".to_vec());
            server.files.insert("removed.md".into(), b"v1".to_vec());
        }
        let mut h = h.restart();
        h.fs.put("edited.md", b"v2 offline");
        h.fs.delete("removed.md");
        h.fs.put("added.md", b"new offline");
        let outcome = h.engine.startup_reconcile(false).unwrap();
        assert_eq!(
            outcome,
            StartupOutcome::Resumed {
                queued_puts: 2,
                queued_deletes: 1
            }
        );
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().files["edited.md"], b"v2 offline");
        assert_eq!(h.server().files["added.md"], b"new offline");
        assert!(!h.server().files.contains_key("removed.md"));
        assert_eq!(h.outbox().len(), 0);
    }

    #[test]
    fn a_crash_before_the_manifest_save_does_not_re_push() {
        // Crash window: the inbound file reached the disk, the manifest did not.
        let mut h = Harness::new(1);
        h.fs.put("a.md", b"old");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server()
            .files
            .insert("a.md".into(), b"new from server".to_vec());
        let mut h = h.restart();
        h.fs.put("a.md", b"new from server");
        h.engine.startup_reconcile(false).unwrap();
        assert!(h.outbox().is_empty());
        assert!(h.server().uploads.is_empty());
    }

    #[test]
    fn an_inbound_delete_not_yet_in_the_manifest_is_not_re_pushed() {
        let mut h = Harness::new(1);
        h.fs.put("a.md", b"old");
        h.engine.startup_reconcile(false).unwrap();
        let mut h = h.restart();
        h.fs.delete("a.md");
        h.engine.startup_reconcile(false).unwrap();
        assert!(h.outbox().is_empty());
        assert!(h.server().deletes.is_empty());
    }

    #[test]
    fn when_the_plugin_ran_since_the_last_save_its_changes_are_not_re_pushed() {
        let mut h = Harness::new(1);
        h.fs.put("a.md", b"v1");
        h.fs.put("b.md", b"v1");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 10;
        h.server().remote_put("a.md", b"newer than the local copy");
        let mut h = h.restart();
        // The plugin applied some inbound changes and moved the cursor.
        h.fs.put("a.md", b"applied by plugin, older than server now");
        h.fs.delete("b.md");
        *h.revision.0.borrow_mut() = 9;
        let outcome = h.engine.startup_reconcile(false).unwrap();
        assert_eq!(outcome, StartupOutcome::Rebaselined { differing: 1 });
        assert!(h.outbox().is_empty(), "the plugin already handled these");
        h.engine.tick();
        assert!(h.server().uploads.is_empty());
        assert!(h.server().deletes.is_empty());
        assert_eq!(h.fs.text("a.md"), "newer than the local copy");
    }

    #[test]
    fn handing_back_from_the_plugin_queues_nothing() {
        let mut h = Harness::new(1);
        h.fs.put("a.md", b"v1");
        h.engine.startup_reconcile(false).unwrap();
        h.fs.put("a.md", b"edited inside Obsidian");
        h.fs.put("b.md", b"created inside Obsidian");
        h.engine.rebaseline_after_handover().unwrap();
        assert_eq!(
            h.engine
                .reconcile_paths(&["a.md".to_string(), "b.md".to_string()])
                .unwrap(),
            0
        );
        assert!(h.outbox().is_empty());
    }

    #[test]
    fn pending_journal_lines_survive_a_restart() {
        let mut h = Harness::new(1).ready();
        h.server().fail_uploads = true;
        h.edit("a.md", b"queued");
        h.engine.tick();
        let mut h = h.restart();
        h.server().fail_uploads = false;
        h.engine.startup_reconcile(false).unwrap();
        assert!(h.engine.is_pending("a.md"));
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().files["a.md"], b"queued");
    }

    #[test]
    fn an_interrupted_inbox_replays_without_reapplying_committed_lines() {
        let mut h = Harness::new(2).ready();
        h.server().files.insert("old.md".into(), b"x".to_vec());
        h.server().files.insert("next.md".into(), b"y".to_vec());
        write_inbox(
            &*h.fs,
            &journals().inbox,
            &[
                InboxOp {
                    rev: 2,
                    op: OpKind::Put,
                    path: "old.md".into(),
                },
                InboxOp {
                    rev: 3,
                    op: OpKind::Put,
                    path: "next.md".into(),
                },
            ],
        )
        .unwrap();
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().downloads, ["next.md"]);
        assert_eq!(h.rev(), 3);
    }

    #[test]
    fn offline_conflict_pushes_local_and_keeps_the_server_copy() {
        let mut h = Harness::new(1);
        h.fs.put("note.md", b"base");
        h.engine.startup_reconcile(false).unwrap();
        h.server()
            .files
            .insert("note.md".into(), b"phone edit".to_vec());
        let mut h = h.restart();
        h.fs.put("note.md", b"box edit");
        h.engine.startup_reconcile(false).unwrap();
        assert_eq!(h.outbox().len(), 1);
        let copies = h.fs.list_all_for_test(&journals().conflicts);
        assert_eq!(copies.len(), 1);
        assert_eq!(h.fs.text(&copies[0]), "phone edit");
    }

    #[test]
    fn offline_delete_of_a_file_edited_remotely_lets_the_remote_edit_survive() {
        let mut h = Harness::new(1);
        h.fs.put("note.md", b"base");
        h.engine.startup_reconcile(false).unwrap();
        h.server().revision = 1;
        h.server().remote_put("note.md", b"phone edit");
        let mut h = h.restart();
        h.fs.delete("note.md");
        h.engine.startup_reconcile(false).unwrap();
        assert!(h.engine.tick().ok());
        assert_eq!(h.server().files["note.md"], b"phone edit");
        assert_eq!(h.fs.text("note.md"), "phone edit");
    }

    // --- Mass push guard ---

    fn guarded(max_deletes: usize, max_puts: usize) -> Harness {
        let fs = Arc::new(MemoryFs::new());
        for index in 0..10 {
            fs.put(&format!("note{index}.md"), b"x");
        }
        let mut h = Harness::build(
            fs,
            Server(Arc::new(Mutex::new(FakeServer::default()))),
            Revision(Rc::new(RefCell::new(1))),
            MassPushGuard::new(max_deletes, max_puts),
        );
        h.engine.startup_reconcile(false).unwrap();
        h
    }

    fn note_paths() -> Vec<String> {
        (0..10).map(|i| format!("note{i}.md")).collect()
    }

    #[test]
    fn a_mass_delete_stops_the_tick_before_anything_is_sent() {
        let mut h = guarded(3, 300);
        for path in note_paths() {
            h.fs.delete(&path);
        }
        h.engine.reconcile_paths(&note_paths()).unwrap();
        let result = h.engine.tick();
        assert_eq!(result.failure.as_ref().unwrap().0, FailureKind::Halted);
        assert!(h.server().deletes.is_empty());
        assert!(h.server().fetches.is_empty());
        assert_eq!(h.outbox().len(), 10, "intent is kept for review");
    }

    #[test]
    fn approval_releases_one_batch() {
        let mut h = guarded(3, 300);
        for path in note_paths() {
            h.fs.delete(&path);
        }
        h.engine.reconcile_paths(&note_paths()).unwrap();
        assert!(!h.engine.tick().ok());
        h.fs.put(&journals().approval, b"");
        assert!(h.engine.approval_pending().unwrap());
        let result = h.engine.tick();
        assert!(result.ok(), "{result:?}");
        assert_eq!(h.server().deletes.len(), 10);
        assert!(!h.engine.approval_pending().unwrap());
    }

    #[test]
    fn a_mass_put_is_also_stopped() {
        let mut h = guarded(50, 3);
        for path in note_paths() {
            h.edit(&path, b"rewritten");
        }
        let result = h.engine.tick();
        assert_eq!(result.failure.unwrap().0, FailureKind::Halted);
        assert!(h.server().uploads.is_empty());
    }

    #[test]
    fn a_vault_that_vanished_while_stopped_halts_startup_with_nothing_queued() {
        let h = guarded(3, 300);
        {
            let mut server = h.server();
            for path in note_paths() {
                server.files.insert(path, b"x".to_vec());
            }
        }
        let mut h = Harness::build(
            h.fs.clone(),
            h.server.clone(),
            h.revision.clone(),
            MassPushGuard::new(3, 300),
        );
        for path in note_paths() {
            h.fs.delete(&path);
        }
        let error = h.engine.startup_reconcile(false).unwrap_err();
        assert!(error.is::<MassPushHalted>(), "{error:#}");
        assert!(h.outbox().is_empty());
        // The manifest is untouched, so a remount recovers with no side effects.
        for path in note_paths() {
            h.fs.put(&path, b"x");
        }
        assert!(h.engine.startup_reconcile(false).is_ok());
        assert!(h.outbox().is_empty());
    }

    // --- Inbound safety ---

    #[test]
    fn inbound_ops_cannot_touch_client_state() {
        let mut h = Harness::new(1).ready();
        let state = format!("{}/x/outbox.jsonl", state_root());
        h.fs.put(&state, b"journal");
        h.server().revision = 1;
        h.server().remote_put(&state, b"hostile");
        h.server().remote_delete(".obsidian/plugins");
        h.server().remote_delete(".obsidian");
        assert!(h.engine.tick().ok());
        assert_eq!(h.fs.text(&state), "journal");
        assert_eq!(h.rev(), 4);
    }

    #[test]
    fn inbound_writes_handle_binary_and_file_to_folder_transitions() {
        let mut h = Harness::new(1);
        h.fs.put("thing", b"was a file");
        h.fs.put("dir/child.md", b"child");
        h.engine.startup_reconcile(false).unwrap();
        let binary: Vec<u8> = (0..=255).collect();
        {
            let mut server = h.server();
            server.revision = 1;
            server.remote_delete("thing");
            server.remote_put("thing/inside.png", &binary);
            server.remote_delete("dir/child.md");
            server.remote_put("dir", b"now a file");
        }
        assert!(h.engine.tick().ok());
        assert_eq!(h.fs.get("thing/inside.png").unwrap(), binary);
        assert_eq!(h.fs.text("dir"), "now a file");
        assert_eq!(
            h.engine
                .reconcile_paths(&["thing".to_string(), "dir".to_string()])
                .unwrap(),
            0
        );
    }

    #[test]
    fn the_inbox_stays_durable_when_the_cursor_cannot_be_saved() {
        struct BrokenRevision(u64);
        impl RevisionStore for BrokenRevision {
            fn get(&self) -> u64 {
                self.0
            }
            fn set(&mut self, _revision: u64) -> Result<()> {
                bail!("disk full")
            }
        }
        let mut h = Harness::new(1).ready();
        h.server().revision = 1;
        h.server().remote_put("a.md", b"x");
        h.engine.replace_revision_store(Box::new(BrokenRevision(1)));
        let result = h.engine.tick();
        assert!(!result.ok());
        assert_eq!(h.inbox().len(), 1);
    }
}
