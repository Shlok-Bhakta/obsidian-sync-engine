//! The long-running service: what `registerVaultSync` and the connection
//! coordinator do in the plugin, around one blocking main loop. There is no
//! live server connection to hold: like the plugin, this polls every 3 seconds.

use crate::engine::{
    EngineOptions, FailureKind, JournalPaths, MassPushHalted, RevisionStore, StartupOutcome,
    SyncEngine, TickResult,
};
use crate::fs::{LocalFs, SyncFs};
use crate::guard::{MassPushGuard, obsidian_running};
use crate::settings::Settings;
use crate::transport::{AuthOutcome, AuthRejectedError, HttpTransport};
use crate::watcher::{FsEvent, VaultWatcher};
use anyhow::{Context, Result, bail};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread;
use std::time::{Duration, Instant};

const TICK_INTERVAL: Duration = Duration::from_millis(3000);
const DEBOUNCE: Duration = Duration::from_millis(1000);
const EVENT_QUIET: Duration = Duration::from_millis(250);
const EVENT_MAX_HOLD: Duration = Duration::from_millis(3000);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const RESCAN_INTERVAL: Duration = Duration::from_secs(5 * 60);
const MONITOR_INTERVAL: Duration = Duration::from_millis(100);
const OBSIDIAN_POLL_EVERY: u32 = 10;

#[derive(Debug, Clone)]
pub struct RunOptions {
    pub vault: PathBuf,
    pub allow_seed: bool,
    pub once: bool,
    pub max_deletes: usize,
    pub max_puts: usize,
    pub obsidian_guard: bool,
}

/// Decides when the next tick runs. Quiet polling every 3 seconds matches the
/// plugin. A local change pulls the tick to 1 second after the last change, its
/// debounce. Failures back off to 30 seconds: the plugin keeps 3 seconds, which
/// suits an app in the foreground but not a service that may sit offline for
/// days, and waiting costs nothing since the outbox is durable.
#[derive(Debug)]
pub struct TickSchedule {
    next: Instant,
    failures: u32,
}

impl TickSchedule {
    pub fn new(now: Instant) -> Self {
        Self {
            next: now,
            failures: 0,
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        now >= self.next
    }

    pub fn next(&self) -> Instant {
        self.next
    }

    pub fn local_change(&mut self, now: Instant) {
        if self.failures == 0 {
            self.next = now + DEBOUNCE;
        }
    }

    pub fn completed(&mut self, ok: bool, now: Instant) {
        if ok {
            self.failures = 0;
            self.next = now + TICK_INTERVAL;
        } else {
            self.failures = self.failures.saturating_add(1);
            let factor = 1u32 << self.failures.saturating_sub(1).min(6);
            self.next = now + (TICK_INTERVAL * factor).min(MAX_BACKOFF);
        }
    }
}

/// Collects watcher paths and releases them after a quiet moment, so a burst of
/// writes to one file is hashed once and a half-written file is rarely seen.
#[derive(Debug, Default)]
pub struct DirtyPaths {
    paths: BTreeSet<String>,
    first: Option<Instant>,
    last: Option<Instant>,
}

impl DirtyPaths {
    pub fn add(&mut self, path: String, now: Instant) {
        self.paths.insert(path);
        self.first.get_or_insert(now);
        self.last = Some(now);
    }

    pub fn ready(&self, now: Instant) -> bool {
        match (self.first, self.last) {
            (Some(first), Some(last)) => {
                now.duration_since(last) >= EVENT_QUIET
                    || now.duration_since(first) >= EVENT_MAX_HOLD
            }
            _ => false,
        }
    }

    pub fn take(&mut self) -> Vec<String> {
        self.first = None;
        self.last = None;
        std::mem::take(&mut self.paths).into_iter().collect()
    }
}

struct SettingsRevision {
    settings: Settings,
}

impl RevisionStore for SettingsRevision {
    fn get(&self) -> u64 {
        self.settings.revision
    }

    fn set(&mut self, revision: u64) -> Result<()> {
        self.settings.save_revision(revision)
    }
}

/// The engine's suspension flag covers both reasons to stop touching the
/// journals. It is checked between operations, which is what makes a pause
/// prompt even in the middle of a long catch-up.
fn spawn_monitor(
    obsidian_uid: Option<u32>,
    shutdown: Arc<AtomicBool>,
    obsidian: Arc<AtomicBool>,
    suspended: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut iteration = 0u32;
        loop {
            if let Some(uid) = obsidian_uid
                && iteration.is_multiple_of(OBSIDIAN_POLL_EVERY)
            {
                obsidian.store(obsidian_running(Path::new("/proc"), uid), Ordering::SeqCst);
            }
            iteration = iteration.wrapping_add(1);
            let value = shutdown.load(Ordering::SeqCst) || obsidian.load(Ordering::SeqCst);
            suspended.store(value, Ordering::SeqCst);
            thread::sleep(MONITOR_INTERVAL);
        }
    });
}

fn wait_while_obsidian_runs(obsidian: &AtomicBool, shutdown: &AtomicBool) {
    if obsidian.load(Ordering::SeqCst) {
        crate::warning!("obsidian.running", action = "paused until Obsidian exits");
    }
    while obsidian.load(Ordering::SeqCst) && !shutdown.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(500));
    }
}

/// Health then auth, as `ServerConnectionCoordinator.update` does. A rejected
/// credential keeps retrying slowly rather than exiting, so an outage or a
/// rename in progress does not put the unit into a restart loop.
fn connect(
    transport: &mut HttpTransport,
    settings: &mut Settings,
    shutdown: &AtomicBool,
) -> Result<()> {
    let mut delay = Duration::from_secs(1);
    while !shutdown.load(Ordering::SeqCst) {
        if transport.health() {
            match transport.authenticate(&settings.client_name) {
                Ok(AuthOutcome::Verified) => {
                    crate::info!("auth.verified", client_name = settings.client_name);
                    return Ok(());
                }
                Ok(AuthOutcome::Enrolled {
                    client_name,
                    client_secret,
                }) => {
                    crate::info!("auth.enrolled", client_name = client_name);
                    settings.save_credentials(&client_name, client_secret.clone())?;
                    transport.set_secret(client_secret);
                    return Ok(());
                }
                Err(error) if error.is::<AuthRejectedError>() => {
                    crate::error!(
                        "auth.rejected",
                        client_name = settings.client_name,
                        error = error,
                        hint = "clientName and clientSecret in data.json must match the server",
                    );
                    delay = MAX_BACKOFF;
                }
                Err(error) => {
                    crate::warning!("auth.failed", error = format!("{error:#}"));
                }
            }
        } else {
            crate::warning!(
                "server.unhealthy",
                server_url = settings.server_url,
                retry_seconds = delay.as_secs(),
            );
        }
        let wake = Instant::now() + delay;
        while Instant::now() < wake && !shutdown.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_millis(200));
        }
        delay = (delay * 2).min(MAX_BACKOFF);
    }
    Ok(())
}

pub fn run(options: RunOptions) -> Result<()> {
    if !Settings::path_in(&options.vault).is_file() {
        bail!(
            "{} has no data.json for this plugin; is the vault mounted?",
            options.vault.display()
        );
    }
    let mut settings = Settings::load(&options.vault)?;
    let paths = JournalPaths::for_identity(&settings.server_identity);
    let fs_impl: Arc<dyn SyncFs> = Arc::new(LocalFs::new(&options.vault, paths.temp.clone()));

    fs::create_dir_all(options.vault.join(&paths.state_dir))?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(options.vault.join(&paths.lock))?;
    if lock.try_lock().is_err() {
        bail!("another obsidian-sync-client is already running on this vault");
    }
    let _ = fs::remove_dir_all(options.vault.join(&paths.temp));

    let shutdown = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&shutdown))?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&shutdown))?;

    let obsidian = Arc::new(AtomicBool::new(false));
    let suspended = Arc::new(AtomicBool::new(false));
    let obsidian_uid = if options.obsidian_guard {
        let uid = fs::metadata(&options.vault)?.uid();
        obsidian.store(obsidian_running(Path::new("/proc"), uid), Ordering::SeqCst);
        Some(uid)
    } else {
        None
    };
    spawn_monitor(
        obsidian_uid,
        Arc::clone(&shutdown),
        Arc::clone(&obsidian),
        Arc::clone(&suspended),
    );

    crate::info!(
        "client.starting",
        version = env!("CARGO_PKG_VERSION"),
        vault = options.vault.display(),
        server_url = settings.server_url,
        client_name = settings.client_name,
        revision = settings.revision,
    );

    // The watcher starts before the first scan so nothing falls in between.
    let (events_sender, events) = channel();
    let _watcher = VaultWatcher::start(&options.vault, events_sender)?;

    wait_while_obsidian_runs(&obsidian, &shutdown);
    if shutdown.load(Ordering::SeqCst) {
        return Ok(());
    }
    settings.reload(&options.vault)?;

    let mut transport = HttpTransport::new(&settings.server_url, settings.client_secret.clone());
    connect(&mut transport, &mut settings, &shutdown)?;
    if shutdown.load(Ordering::SeqCst) {
        return Ok(());
    }

    let mut engine = SyncEngine::new(
        Arc::clone(&fs_impl),
        Box::new(transport),
        Box::new(SettingsRevision { settings }),
        EngineOptions {
            paths,
            suspended: Arc::clone(&suspended),
            guard: MassPushGuard::new(options.max_deletes, options.max_puts),
        },
    );

    if !startup(&mut engine, &options, &shutdown)? {
        return Ok(());
    }

    if options.once {
        let result = engine.tick();
        log_tick(&result, &mut None);
        return match result.failure {
            Some((_, error)) => bail!(error),
            None => Ok(()),
        };
    }

    main_loop(&mut engine, &options, &events, &shutdown, &obsidian)?;
    engine.save_manifest()?;
    crate::info!("client.stopped", revision = engine.revision());
    Ok(())
}

/// Returns false when asked to stop while waiting for an approval.
fn startup(engine: &mut SyncEngine, options: &RunOptions, shutdown: &AtomicBool) -> Result<bool> {
    loop {
        match engine.startup_reconcile(options.allow_seed) {
            Ok(outcome) => {
                log_startup(&outcome, engine);
                return Ok(true);
            }
            Err(error) if error.is::<MassPushHalted>() => {
                crate::error!("mass_push.halted", error = error);
                if options.once {
                    return Err(error);
                }
                while !engine.approval_pending()? {
                    if shutdown.load(Ordering::SeqCst) {
                        return Ok(false);
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            }
            Err(error) => return Err(error).context("startup failed"),
        }
    }
}

fn log_startup(outcome: &StartupOutcome, engine: &SyncEngine) {
    match outcome {
        StartupOutcome::FirstRun { files } => {
            crate::info!(
                "startup.first_run_baseline",
                files = files,
                pushed = 0,
                revision = engine.revision(),
            );
        }
        StartupOutcome::Rebaselined { differing } => {
            crate::warning!(
                "startup.rebaselined",
                reason = "revision_moved_since_last_save",
                differing_files = differing,
                pushed = 0,
                revision = engine.revision(),
            );
        }
        StartupOutcome::Resumed {
            queued_puts,
            queued_deletes,
        } => {
            crate::info!(
                "startup.resumed",
                queued_puts = queued_puts,
                queued_deletes = queued_deletes,
                revision = engine.revision(),
                tracked_files = engine.tracked_files(),
            );
        }
        StartupOutcome::Seeded { files } => {
            crate::warning!("startup.seeding_server", files = files);
        }
    }
}

fn log_tick(result: &TickResult, last_error: &mut Option<String>) {
    match &result.failure {
        Some((kind, error)) => {
            // The same failure every few seconds is one event, not a log flood.
            if last_error.as_deref() != Some(error) {
                match kind {
                    FailureKind::Suspended => {}
                    FailureKind::Halted => crate::error!("mass_push.halted", error = error),
                    FailureKind::Error | FailureKind::DeadLetter => crate::error!(
                        "tick.failed",
                        error = error,
                        pushed = result.pushed,
                        applied = result.applied,
                    ),
                }
                *last_error = Some(error.clone());
            }
        }
        None => {
            if last_error.take().is_some() {
                crate::info!("tick.recovered");
            }
            if result.pushed > 0 || result.applied > 0 {
                crate::info!(
                    "tick.completed",
                    pushed = result.pushed,
                    applied = result.applied,
                );
            }
        }
    }
}

fn main_loop(
    engine: &mut SyncEngine,
    options: &RunOptions,
    events: &Receiver<FsEvent>,
    shutdown: &AtomicBool,
    obsidian: &AtomicBool,
) -> Result<()> {
    let mut schedule = TickSchedule::new(Instant::now());
    let mut dirty = DirtyPaths::default();
    let mut last_error: Option<String> = None;
    let mut last_rescan = Instant::now();
    let mut rescan_requested = false;

    while !shutdown.load(Ordering::SeqCst) {
        let wait = schedule
            .next()
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(100));
        match events.recv_timeout(wait) {
            Ok(event) => {
                absorb(event, &mut dirty, &mut rescan_requested);
                for event in events.try_iter() {
                    absorb(event, &mut dirty, &mut rescan_requested);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => bail!("filesystem watcher stopped"),
        }

        if obsidian.load(Ordering::SeqCst) {
            pause_for_obsidian(engine, options, events, shutdown, obsidian)?;
            dirty.take();
            rescan_requested = false;
            schedule = TickSchedule::new(Instant::now());
            continue;
        }

        let now = Instant::now();
        if rescan_requested || now.duration_since(last_rescan) >= RESCAN_INTERVAL {
            rescan_requested = false;
            last_rescan = now;
            match engine.rescan() {
                Ok(0) => {}
                Ok(queued) => {
                    crate::info!("rescan.found_changes", queued = queued);
                    schedule.local_change(now);
                }
                Err(error) => crate::error!("rescan.failed", error = format!("{error:#}")),
            }
        }

        if dirty.ready(now) {
            let paths = dirty.take();
            match engine.reconcile_paths(&paths) {
                Ok(0) => {}
                Ok(_) => schedule.local_change(now),
                Err(error) => {
                    crate::error!("reconcile.failed", error = format!("{error:#}"));
                    rescan_requested = true;
                }
            }
        }

        if schedule.due(Instant::now()) {
            let result = engine.tick();
            log_tick(&result, &mut last_error);
            let settled = matches!(
                result.failure.as_ref().map(|(kind, _)| *kind),
                None | Some(FailureKind::DeadLetter)
            );
            schedule.completed(settled, Instant::now());
        }
    }
    Ok(())
}

fn absorb(event: FsEvent, dirty: &mut DirtyPaths, rescan_requested: &mut bool) {
    match event {
        FsEvent::Changed(path) => dirty.add(path, Instant::now()),
        FsEvent::Rescan => *rescan_requested = true,
    }
}

/// While Obsidian runs, the plugin owns the vault, `data.json` and the journals.
/// On exit, its revision and journals are picked up. Whatever changed on disk
/// was the plugin's to sync, so the manifest is rebuilt without pushing.
fn pause_for_obsidian(
    engine: &mut SyncEngine,
    options: &RunOptions,
    events: &Receiver<FsEvent>,
    shutdown: &AtomicBool,
    obsidian: &AtomicBool,
) -> Result<()> {
    crate::warning!("obsidian.running", action = "paused until Obsidian exits");
    while obsidian.load(Ordering::SeqCst) && !shutdown.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(500));
        let _ = events.try_iter().count();
    }
    if shutdown.load(Ordering::SeqCst) {
        return Ok(());
    }
    // Give the plugin's unload flush a moment after the process disappears, and
    // the monitor time to lift the suspension.
    thread::sleep(Duration::from_secs(1));
    let _ = events.try_iter().count();
    let settings = Settings::load(&options.vault)?;
    crate::info!(
        "obsidian.exited",
        action = "resuming",
        revision = settings.revision,
    );
    engine.replace_revision_store(Box::new(SettingsRevision { settings }));
    engine.hydrate()?;
    engine.rebaseline_after_handover()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_polls_every_three_seconds_when_healthy() {
        let start = Instant::now();
        let mut schedule = TickSchedule::new(start);
        assert!(schedule.due(start));
        schedule.completed(true, start);
        assert!(!schedule.due(start + Duration::from_millis(2999)));
        assert!(schedule.due(start + Duration::from_millis(3000)));
    }

    #[test]
    fn a_local_change_pulls_the_tick_to_the_debounce() {
        let start = Instant::now();
        let mut schedule = TickSchedule::new(start);
        schedule.completed(true, start);
        schedule.local_change(start);
        assert!(schedule.due(start + Duration::from_millis(1000)));
        // Each further change resets the quiet period.
        schedule.local_change(start + Duration::from_millis(800));
        assert!(!schedule.due(start + Duration::from_millis(1000)));
        assert!(schedule.due(start + Duration::from_millis(1800)));
    }

    #[test]
    fn failures_back_off_to_a_cap_and_success_resets() {
        let start = Instant::now();
        let mut schedule = TickSchedule::new(start);
        let mut delays = Vec::new();
        for _ in 0..7 {
            schedule.completed(false, start);
            delays.push(schedule.next().duration_since(start).as_secs());
        }
        assert_eq!(delays, [3, 6, 12, 24, 30, 30, 30]);
        schedule.completed(true, start);
        assert_eq!(schedule.next().duration_since(start).as_secs(), 3);
    }

    #[test]
    fn local_changes_do_not_hammer_a_failing_server() {
        let start = Instant::now();
        let mut schedule = TickSchedule::new(start);
        schedule.completed(false, start);
        schedule.completed(false, start);
        schedule.local_change(start);
        assert_eq!(schedule.next().duration_since(start).as_secs(), 6);
    }

    #[test]
    fn dirty_paths_wait_for_quiet_and_deduplicate() {
        let start = Instant::now();
        let mut dirty = DirtyPaths::default();
        assert!(!dirty.ready(start));
        dirty.add("a.md".into(), start);
        dirty.add("a.md".into(), start + Duration::from_millis(100));
        dirty.add("b.md".into(), start + Duration::from_millis(100));
        assert!(!dirty.ready(start + Duration::from_millis(300)));
        assert!(dirty.ready(start + Duration::from_millis(350)));
        assert_eq!(dirty.take(), ["a.md", "b.md"]);
        assert!(!dirty.ready(start + Duration::from_secs(10)));
    }

    #[test]
    fn a_constantly_changing_file_is_not_held_forever() {
        let start = Instant::now();
        let mut dirty = DirtyPaths::default();
        for step in 0..40 {
            dirty.add("log.md".into(), start + Duration::from_millis(step * 100));
        }
        assert!(dirty.ready(start + Duration::from_millis(3900)));
    }
}
