//! Structured one-line logging to stderr (journald under systemd).
//!
//! Event names mirror the plugin's logger. Nothing logged here may contain the
//! client secret: it is only ever held in [`crate::settings::Secret`], whose
//! `Debug` and `Display` output is masked.

use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Level {
    Debug,
    Info,
    Warn,
    Error,
}

fn threshold() -> Level {
    static LEVEL: OnceLock<Level> = OnceLock::new();
    *LEVEL.get_or_init(|| match std::env::var("OBSIDIAN_SYNC_LOG").as_deref() {
        Ok("debug") => Level::Debug,
        Ok("warn") => Level::Warn,
        Ok("error") => Level::Error,
        _ => Level::Info,
    })
}

pub fn format_line(level: Level, event: &str, fields: &[(&str, String)]) -> String {
    let name = match level {
        Level::Debug => "DEBUG",
        Level::Info => "INFO",
        Level::Warn => "WARN",
        Level::Error => "ERROR",
    };
    let mut line = format!("{name} {event}");
    for (key, value) in fields {
        let needs_quotes = value.is_empty() || value.chars().any(|c| c.is_whitespace() || c == '"');
        if needs_quotes {
            line.push_str(&format!(" {key}={value:?}"));
        } else {
            line.push_str(&format!(" {key}={value}"));
        }
    }
    line
}

pub fn emit(level: Level, event: &str, fields: &[(&str, String)]) {
    if level >= threshold() {
        eprintln!("{}", format_line(level, event, fields));
    }
}

#[macro_export]
macro_rules! log_event {
    ($level:expr, $event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        $crate::log::emit($level, $event, &[$((stringify!($key), format!("{}", $value))),*])
    };
}

#[macro_export]
macro_rules! debug {
    ($($arg:tt)*) => { $crate::log_event!($crate::log::Level::Debug, $($arg)*) };
}

#[macro_export]
macro_rules! info {
    ($($arg:tt)*) => { $crate::log_event!($crate::log::Level::Info, $($arg)*) };
}

#[macro_export]
macro_rules! warning {
    ($($arg:tt)*) => { $crate::log_event!($crate::log::Level::Warn, $($arg)*) };
}

#[macro_export]
macro_rules! error {
    ($($arg:tt)*) => { $crate::log_event!($crate::log::Level::Error, $($arg)*) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_values_with_whitespace() {
        let line = format_line(
            Level::Info,
            "inbox.put_applied",
            &[
                ("path", "Crabcake/Hello World.md".to_string()),
                ("rev", "7".to_string()),
            ],
        );
        assert_eq!(
            line,
            r#"INFO inbox.put_applied path="Crabcake/Hello World.md" rev=7"#
        );
    }
}
