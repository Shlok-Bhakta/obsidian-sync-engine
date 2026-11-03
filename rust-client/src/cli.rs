//! Argument parsing and the one-shot commands.

use crate::daemon::RunOptions;
use crate::engine::{JournalPaths, count_lines};
use crate::fs::{LocalFs, PathStat, SyncFs, sha256_hex};
use crate::guard::{DEFAULT_MAX_DELETES, DEFAULT_MAX_PUTS, obsidian_running};
use crate::outbox;
use crate::paths::is_watched_path;
use crate::protocol::{InboxOp, OpKind};
use crate::settings::Settings;
use crate::transport::{AuthOutcome, HttpTransport, RemoteFileNotFoundError, Transport};
use anyhow::{Context, Result, anyhow, bail};
use std::collections::BTreeMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

pub const USAGE: &str = "\
obsidian-sync-client: headless client for Obsidian Sync Engine

USAGE:
  obsidian-sync-client <command> --vault <path> [options]

COMMANDS:
  run                 Sync continuously until stopped
  status              Show the cursor, server tip and queued work (read-only)
  verify              Compare every server file with the disk (read-only)
  approve-mass-push   Release a batch stopped by the mass-push guard
  rename-client NAME  Rename this client on the server and in data.json

OPTIONS for run:
  --allow-seed             Permit the upload of the whole vault at revision 0
  --once                   Reconcile, run one tick, and exit
  --max-deletes N          Mass-push guard limit for deletes (default 50)
  --max-puts N             Mass-push guard limit for changes (default 300)
  --no-obsidian-guard      Do not pause while Obsidian is running

OPTIONS for verify:
  --path P                 Check a single vault path

LOGGING:
  OBSIDIAN_SYNC_LOG=debug|info|warn|error (default info)
";

#[derive(Debug, PartialEq)]
pub enum Command {
    Help,
    Run(CliRun),
    Status {
        vault: PathBuf,
    },
    Verify {
        vault: PathBuf,
        path: Option<String>,
    },
    ApproveMassPush {
        vault: PathBuf,
    },
    RenameClient {
        vault: PathBuf,
        name: String,
    },
}

#[derive(Debug, PartialEq)]
pub struct CliRun {
    pub vault: PathBuf,
    pub allow_seed: bool,
    pub once: bool,
    pub max_deletes: usize,
    pub max_puts: usize,
    pub obsidian_guard: bool,
}

impl From<CliRun> for RunOptions {
    fn from(cli: CliRun) -> Self {
        RunOptions {
            vault: cli.vault,
            allow_seed: cli.allow_seed,
            once: cli.once,
            max_deletes: cli.max_deletes,
            max_puts: cli.max_puts,
            obsidian_guard: cli.obsidian_guard,
        }
    }
}

pub fn parse_args(args: &[String]) -> Result<Command> {
    let mut iter = args.iter();
    let Some(command) = iter.next() else {
        return Ok(Command::Help);
    };
    let mut vault = None;
    let mut allow_seed = false;
    let mut once = false;
    let mut max_deletes = DEFAULT_MAX_DELETES;
    let mut max_puts = DEFAULT_MAX_PUTS;
    let mut obsidian_guard = true;
    let mut path = None;
    let mut positional = Vec::new();
    while let Some(arg) = iter.next() {
        let mut value = |name: &str| {
            iter.next()
                .cloned()
                .ok_or_else(|| anyhow!("{name} needs a value"))
        };
        match arg.as_str() {
            "--vault" => vault = Some(PathBuf::from(value("--vault")?)),
            "--allow-seed" => allow_seed = true,
            "--once" => once = true,
            "--no-obsidian-guard" => obsidian_guard = false,
            "--max-deletes" => {
                max_deletes = value("--max-deletes")?
                    .parse()
                    .context("--max-deletes must be a number")?;
            }
            "--max-puts" => {
                max_puts = value("--max-puts")?
                    .parse()
                    .context("--max-puts must be a number")?;
            }
            "--path" => path = Some(value("--path")?),
            "-h" | "--help" => return Ok(Command::Help),
            other if other.starts_with("--") => bail!("unknown option {other}"),
            other => positional.push(other.to_string()),
        }
    }
    let need_vault = || {
        vault
            .clone()
            .ok_or_else(|| anyhow!("--vault <path> is required"))
    };
    match command.as_str() {
        "-h" | "--help" | "help" => Ok(Command::Help),
        "run" => Ok(Command::Run(CliRun {
            vault: need_vault()?,
            allow_seed,
            once,
            max_deletes,
            max_puts,
            obsidian_guard,
        })),
        "status" => Ok(Command::Status {
            vault: need_vault()?,
        }),
        "verify" => Ok(Command::Verify {
            vault: need_vault()?,
            path,
        }),
        "approve-mass-push" => Ok(Command::ApproveMassPush {
            vault: need_vault()?,
        }),
        "rename-client" => {
            let name = positional
                .first()
                .cloned()
                .filter(|name| !name.is_empty())
                .ok_or_else(|| anyhow!("rename-client needs a new name"))?;
            Ok(Command::RenameClient {
                vault: need_vault()?,
                name,
            })
        }
        other => bail!("unknown command {other}\n\n{USAGE}"),
    }
}

/// `Settings::load` adds the `serverIdentity` field the plugin would also add;
/// beyond that, the read-only commands change nothing on disk.
fn open(vault: &Path) -> Result<(Settings, HttpTransport)> {
    let settings = Settings::load(vault)?;
    let transport = HttpTransport::new(&settings.server_url, settings.client_secret.clone());
    Ok((settings, transport))
}

pub fn status(vault: &Path) -> Result<()> {
    let (settings, transport) = open(vault)?;
    let paths = JournalPaths::for_identity(&settings.server_identity);
    let fs = LocalFs::new(vault, paths.temp.clone());
    println!("vault:           {}", vault.display());
    println!("server:          {}", settings.server_url);
    println!("client name:     {}", settings.client_name);
    println!("revision:        {}", settings.revision);
    println!(
        "outbox depth:    {}",
        outbox::list(&fs, &paths.outbox)?.len()
    );
    println!("inbox depth:     {}", count_lines(&fs, &paths.inbox)?);
    println!("dead letters:    {}", count_lines(&fs, &paths.dead_letter)?);
    let uid = std::fs::metadata(vault)?.uid();
    println!(
        "obsidian open:   {}",
        obsidian_running(Path::new("/proc"), uid)
    );
    if !transport.health() {
        println!("server health:   UNREACHABLE");
        return Ok(());
    }
    println!("server health:   ok");
    match transport.authenticate(&settings.client_name) {
        Ok(AuthOutcome::Verified) => println!("auth:            ok"),
        Ok(AuthOutcome::Enrolled { .. }) => {
            println!("auth:            enrolled (server was empty)")
        }
        Err(error) => println!("auth:            FAILED ({error})"),
    }
    let ops = transport.fetch_inbox(settings.revision)?;
    let deletes = ops.iter().filter(|op| op.op == OpKind::Delete).count();
    println!(
        "server tip:      {}",
        ops.last().map_or(settings.revision, |op| op.rev)
    );
    println!(
        "behind by:       {} puts, {deletes} deletes",
        ops.len() - deletes
    );
    for op in ops.iter().take(40) {
        println!("  rev {} {} {}", op.rev, op.op.as_str(), op.path);
    }
    if ops.len() > 40 {
        println!("  ... and {} more", ops.len() - 40);
    }
    Ok(())
}

pub fn verify(vault: &Path, path: Option<&str>) -> Result<()> {
    let (settings, transport) = open(vault)?;
    let paths = JournalPaths::for_identity(&settings.server_identity);
    let fs = LocalFs::new(vault, paths.temp);
    match path {
        Some(path) => verify_one(&fs, &transport, path),
        None => verify_all(&fs, &transport),
    }
}

fn describe_local(fs: &dyn SyncFs, path: &str) -> Result<Option<String>> {
    Ok(match fs.stat(path)? {
        Some(PathStat::File { .. }) => Some(fs.hash_file(path)?),
        _ => None,
    })
}

fn verify_one(fs: &dyn SyncFs, transport: &dyn Transport, path: &str) -> Result<()> {
    let local = describe_local(fs, path)?;
    let remote = match transport.download(path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.is::<RemoteFileNotFoundError>() => None,
        Err(error) => return Err(error),
    };
    let line = transport
        .fetch_inbox(0)?
        .into_iter()
        .find(|op| op.path == path);
    println!("path:            {path}");
    match &line {
        Some(op) => println!("server line:     {} at revision {}", op.op.as_str(), op.rev),
        None => println!("server line:     none"),
    }
    match &remote {
        Some(bytes) => println!(
            "server copy:     {} bytes, sha256 {}",
            bytes.len(),
            sha256_hex(bytes)
        ),
        None => println!("server copy:     absent"),
    }
    match &local {
        Some(hash) => println!("local copy:      sha256 {hash}"),
        None => println!("local copy:      absent"),
    }
    let same = local == remote.as_deref().map(sha256_hex);
    println!("in sync:         {same}");
    if !same {
        bail!("{path} differs between disk and server");
    }
    Ok(())
}

fn verify_all(fs: &dyn SyncFs, transport: &dyn Transport) -> Result<()> {
    let ops: Vec<InboxOp> = transport.fetch_inbox(0)?;
    let tip = ops.last().map_or(0, |op| op.rev);
    let live: BTreeMap<&str, u64> = ops
        .iter()
        .filter(|op| op.op == OpKind::Put)
        .map(|op| (op.path.as_str(), op.rev))
        .collect();
    let mut missing = Vec::new();
    let mut different = Vec::new();
    for path in live.keys() {
        match describe_local(fs, path)? {
            None => missing.push(path.to_string()),
            Some(hash) => match transport.download(path) {
                Ok(bytes) if sha256_hex(&bytes) == hash => {}
                Ok(_) => different.push(path.to_string()),
                Err(error) if error.is::<RemoteFileNotFoundError>() => {
                    different.push(format!("{path} (deleted on server since listing)"));
                }
                Err(error) => return Err(error),
            },
        }
    }
    let extra: Vec<String> = fs
        .list_files_under("")?
        .into_iter()
        .filter(|path| is_watched_path(path) && !live.contains_key(path.as_str()))
        .collect();
    println!("server tip:      {tip}");
    println!("server files:    {}", live.len());
    println!("tombstones:      {}", ops.len() - live.len());
    println!(
        "byte-identical:  {}",
        live.len() - missing.len() - different.len()
    );
    let report = |label: &str, paths: &[String]| {
        println!("{label} {}", paths.len());
        for path in paths.iter().take(40) {
            println!("  {path}");
        }
        if paths.len() > 40 {
            println!("  ... and {} more", paths.len() - 40);
        }
    };
    report("missing on disk:", &missing);
    report("differ on disk: ", &different);
    report("only on disk:   ", &extra);
    if !missing.is_empty() || !different.is_empty() {
        bail!("disk and server differ");
    }
    Ok(())
}

pub fn approve_mass_push(vault: &Path) -> Result<()> {
    let settings = Settings::load(vault)?;
    let paths = JournalPaths::for_identity(&settings.server_identity);
    let fs = LocalFs::new(vault, paths.temp.clone());
    let ops = outbox::list(&fs, &paths.outbox)?;
    let deletes = ops.iter().filter(|op| op.op == OpKind::Delete).count();
    fs.write(&paths.approval, "")?;
    println!(
        "Approved. The running client will now push {deletes} deletes and {} changes already queued, plus any changes held at startup.",
        ops.len() - deletes
    );
    Ok(())
}

/// `clientName` is half of the `/auth` credential and unique on the server, so
/// the server row and `data.json` must change together.
pub fn rename_client(vault: &Path, name: &str) -> Result<()> {
    let uid = std::fs::metadata(vault)?.uid();
    if obsidian_running(Path::new("/proc"), uid) {
        bail!("close Obsidian first: the plugin keeps its own copy of the name in memory");
    }
    let (mut settings, transport) = open(vault)?;
    let renamed = transport.rename_client(name)?;
    settings.save_client_name(&renamed)?;
    println!("client renamed to {renamed} on the server and in data.json");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    #[test]
    fn parses_run_with_defaults_and_overrides() {
        let Command::Run(run) = parse_args(&args(&["run", "--vault", "/v"])).unwrap() else {
            panic!("expected run");
        };
        assert_eq!(run.vault, PathBuf::from("/v"));
        assert!(!run.allow_seed);
        assert!(run.obsidian_guard);
        assert_eq!(run.max_deletes, DEFAULT_MAX_DELETES);

        let Command::Run(run) = parse_args(&args(&[
            "run",
            "--vault",
            "/v",
            "--allow-seed",
            "--once",
            "--max-deletes",
            "5",
            "--max-puts",
            "6",
            "--no-obsidian-guard",
        ]))
        .unwrap() else {
            panic!("expected run");
        };
        assert!(run.allow_seed && run.once && !run.obsidian_guard);
        assert_eq!((run.max_deletes, run.max_puts), (5, 6));
    }

    #[test]
    fn requires_a_vault_and_rejects_unknown_input() {
        assert!(parse_args(&args(&["run"])).is_err());
        assert!(parse_args(&args(&["run", "--vault"])).is_err());
        assert!(parse_args(&args(&["run", "--vault", "/v", "--nope"])).is_err());
        assert!(parse_args(&args(&["nonsense", "--vault", "/v"])).is_err());
        assert!(parse_args(&args(&["run", "--vault", "/v", "--max-puts", "lots"])).is_err());
        assert_eq!(parse_args(&[]).unwrap(), Command::Help);
    }

    #[test]
    fn parses_other_commands() {
        assert_eq!(
            parse_args(&args(&["verify", "--vault", "/v", "--path", "a b.md"])).unwrap(),
            Command::Verify {
                vault: PathBuf::from("/v"),
                path: Some("a b.md".into())
            }
        );
        assert_eq!(
            parse_args(&args(&["rename-client", "crabcake", "--vault", "/v"])).unwrap(),
            Command::RenameClient {
                vault: PathBuf::from("/v"),
                name: "crabcake".into()
            }
        );
        assert!(parse_args(&args(&["rename-client", "--vault", "/v"])).is_err());
    }
}
