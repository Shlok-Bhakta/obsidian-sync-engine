//! Headless client for Obsidian Sync Engine: the `plugin/` sync runtime with
//! Obsidian's vault events replaced by a filesystem watcher.

#[macro_use]
mod log;

mod cli;
mod daemon;
mod engine;
mod fs;
mod guard;
mod inbox;
mod jsonl;
mod outbox;
mod paths;
mod protocol;
mod settings;
mod tracker;
mod transport;
mod watcher;

use cli::Command;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = cli::parse_args(&args).and_then(|command| match command {
        Command::Help => {
            print!("{}", cli::USAGE);
            Ok(())
        }
        Command::Run(run) => daemon::run(run.into()),
        Command::Status { vault } => cli::status(&vault),
        Command::Verify { vault, path } => cli::verify(&vault, path.as_deref()),
        Command::ApproveMassPush { vault } => cli::approve_mass_push(&vault),
        Command::RenameClient { vault, name } => cli::rename_client(&vault, &name),
    });
    if let Err(error) = result {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}
