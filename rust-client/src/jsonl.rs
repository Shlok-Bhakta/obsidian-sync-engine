//! Port of `plugin/src/sync/jsonl.ts`.

use crate::fs::SyncFs;
use anyhow::{Result, bail};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Only a truncated or corrupt *final* non-empty line is quarantined. Corrupt
/// lines in the middle are an error so FIFO order never skips durable ops.
pub fn read_lines<T>(fs: &dyn SyncFs, path: &str) -> Result<Vec<T>>
where
    T: DeserializeOwned + Serialize,
{
    if !fs.exists(path)? {
        return Ok(Vec::new());
    }
    let data = fs.read(path)?;
    let non_empty: Vec<&str> = data.split('\n').filter(|l| !l.trim().is_empty()).collect();
    let mut parsed = Vec::with_capacity(non_empty.len());
    for (index, line) in non_empty.iter().enumerate() {
        match serde_json::from_str::<T>(line) {
            Ok(value) => parsed.push(value),
            Err(error) if index + 1 == non_empty.len() => {
                let quarantine = format!("{path}.corrupt");
                crate::warning!(
                    "read.corrupt_tail",
                    path = path,
                    quarantine_path = quarantine,
                    parsed_lines = parsed.len(),
                    error = error,
                );
                let existing = if fs.exists(&quarantine)? {
                    fs.read(&quarantine)?
                } else {
                    String::new()
                };
                let base = if existing.is_empty() || existing.ends_with('\n') {
                    existing
                } else {
                    existing + "\n"
                };
                fs.write(&quarantine, &format!("{base}{line}\n"))?;
                write_lines(fs, path, &parsed)?;
                return Ok(parsed);
            }
            Err(_) => {
                bail!(
                    "Corrupt JSONL line in the middle of {path} (line {}); refusing to skip durable ops",
                    index + 1
                );
            }
        }
    }
    Ok(parsed)
}

pub fn write_lines<T: Serialize>(fs: &dyn SyncFs, path: &str, lines: &[T]) -> Result<()> {
    let mut body = String::new();
    for line in lines {
        body.push_str(&serde_json::to_string(line)?);
        body.push('\n');
    }
    fs.write(path, &body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::memory::MemoryFs;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, Debug, PartialEq)]
    struct Line {
        a: u32,
    }

    #[test]
    fn missing_file_is_empty() {
        let fs = MemoryFs::new();
        assert!(read_lines::<Line>(&fs, "missing.jsonl").unwrap().is_empty());
    }

    #[test]
    fn round_trips_objects_with_plugin_bytes() {
        let fs = MemoryFs::new();
        write_lines(&fs, "log.jsonl", &[Line { a: 1 }, Line { a: 2 }]).unwrap();
        assert_eq!(fs.text("log.jsonl"), "{\"a\":1}\n{\"a\":2}\n");
        assert_eq!(
            read_lines::<Line>(&fs, "log.jsonl").unwrap(),
            [Line { a: 1 }, Line { a: 2 }]
        );
    }

    #[test]
    fn write_rewrites_the_whole_file() {
        let fs = MemoryFs::new();
        write_lines(&fs, "log.jsonl", &[Line { a: 1 }]).unwrap();
        write_lines(&fs, "log.jsonl", &[Line { a: 9 }]).unwrap();
        assert_eq!(
            read_lines::<Line>(&fs, "log.jsonl").unwrap(),
            [Line { a: 9 }]
        );
    }

    #[test]
    fn quarantines_a_corrupt_final_line_and_keeps_valid_lines() {
        let fs = MemoryFs::new();
        fs.write("log.jsonl", "{\"a\":1}\n{\"a\":2}\n{\"a\":")
            .unwrap();
        let expected = [Line { a: 1 }, Line { a: 2 }];
        assert_eq!(read_lines::<Line>(&fs, "log.jsonl").unwrap(), expected);
        assert!(fs.text("log.jsonl.corrupt").contains("{\"a\":"));
        // The file was repaired, so a second read is clean.
        assert_eq!(read_lines::<Line>(&fs, "log.jsonl").unwrap(), expected);
    }

    #[test]
    fn repeated_corruption_appends_to_the_quarantine() {
        let fs = MemoryFs::new();
        fs.write("log.jsonl", "{\"a\":").unwrap();
        read_lines::<Line>(&fs, "log.jsonl").unwrap();
        fs.write("log.jsonl", "{\"b\":").unwrap();
        read_lines::<Line>(&fs, "log.jsonl").unwrap();
        assert_eq!(fs.text("log.jsonl.corrupt"), "{\"a\":\n{\"b\":\n");
    }

    #[test]
    fn refuses_to_skip_a_corrupt_middle_line() {
        let fs = MemoryFs::new();
        fs.write("log.jsonl", "{\"a\":1}\n{\"a\":2\n{\"a\":3}\n")
            .unwrap();
        let error = read_lines::<Line>(&fs, "log.jsonl").unwrap_err();
        assert!(error.to_string().contains("middle"));
        assert!(!fs.exists("log.jsonl.corrupt").unwrap());
    }

    #[test]
    fn blank_lines_are_ignored() {
        let fs = MemoryFs::new();
        fs.write("log.jsonl", "\n{\"a\":1}\n\n  \n{\"a\":2}\n")
            .unwrap();
        assert_eq!(read_lines::<Line>(&fs, "log.jsonl").unwrap().len(), 2);
    }
}
