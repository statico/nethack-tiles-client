//! Writes the LLM state-log directory.
//!
//! The frontend decides the text. This module only creates, replaces, and
//! deletes a fixed set of names so a bad IPC payload cannot write elsewhere.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Files this module will create or delete. Anything else in the directory
/// belongs to the player.
pub const STATE_FILENAMES: &[&str] = &[
    "README.md",
    "screen.txt",
    "level.txt",
    "messages.txt",
    "inventory.txt",
    "dungeon.txt",
];

#[derive(Debug, thiserror::Error)]
pub enum StateLogError {
    #[error("{0} is not a state-log file")]
    ForbiddenName(String),
    #[error("writing {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("removing {path}: {source}")]
    Remove {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

/// Payload from the frontend: one directory and the files to replace.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateLogWrite {
    pub directory: String,
    pub files: HashMap<String, String>,
}

pub fn is_allowed_name(name: &str) -> bool {
    STATE_FILENAMES.contains(&name)
}

fn target(dir: &Path, name: &str) -> Result<PathBuf, StateLogError> {
    if !is_allowed_name(name) {
        return Err(StateLogError::ForbiddenName(name.to_string()));
    }
    Ok(dir.join(name))
}

/// Deletes the known state files. Other entries in `dir` are not touched.
/// A missing file is fine; a missing directory is also fine.
pub fn clear(dir: &Path) -> Result<(), StateLogError> {
    for name in STATE_FILENAMES {
        let path = dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(StateLogError::Remove {
                    path,
                    source,
                })
            }
        }
    }
    Ok(())
}

pub fn write_file(dir: &Path, name: &str, contents: &str) -> Result<(), StateLogError> {
    let path = target(dir, name)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|source| StateLogError::Write {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    std::fs::write(&path, contents).map_err(|source| StateLogError::Write { path, source })
}

pub fn write_files(dir: &Path, files: &HashMap<String, String>) -> Result<(), StateLogError> {
    for (name, contents) in files {
        write_file(dir, name, contents)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "nethack-tiles-statelog-{tag}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).expect("temp dir");
            TempDir(base)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_known_file_is_written_into_the_directory() {
        let dir = TempDir::new("write");
        write_file(&dir.0, "screen.txt", "@\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.0.join("screen.txt")).unwrap(), "@\n");
    }

    #[test]
    fn an_unknown_name_is_refused() {
        let dir = TempDir::new("forbid");
        let err = write_file(&dir.0, "secret.txt", "nope").unwrap_err();
        assert!(matches!(err, StateLogError::ForbiddenName(_)));
        assert!(!dir.0.join("secret.txt").exists());
    }

    #[test]
    fn a_path_separator_in_the_name_is_refused() {
        let dir = TempDir::new("sep");
        assert!(write_file(&dir.0, "../screen.txt", "nope").is_err());
        assert!(write_file(&dir.0, "sub/screen.txt", "nope").is_err());
    }

    #[test]
    fn clear_removes_state_files_and_leaves_other_files() {
        let dir = TempDir::new("clear");
        write_file(&dir.0, "screen.txt", "@\n").unwrap();
        write_file(&dir.0, "messages.txt", "hi\n").unwrap();
        std::fs::write(dir.0.join("notes.md"), "mine").unwrap();

        clear(&dir.0).unwrap();

        assert!(!dir.0.join("screen.txt").exists());
        assert!(!dir.0.join("messages.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.0.join("notes.md")).unwrap(), "mine");
    }

    #[test]
    fn clear_of_a_missing_directory_is_fine() {
        let dir = TempDir::new("missing");
        let gone = dir.0.join("nope");
        clear(&gone).unwrap();
    }

    #[test]
    fn write_files_replaces_several_names_at_once() {
        let dir = TempDir::new("batch");
        let mut files = HashMap::new();
        files.insert("screen.txt".into(), "a\n".into());
        files.insert("messages.txt".into(), "b\n".into());
        write_files(&dir.0, &files).unwrap();
        assert_eq!(std::fs::read_to_string(dir.0.join("screen.txt")).unwrap(), "a\n");
        assert_eq!(std::fs::read_to_string(dir.0.join("messages.txt")).unwrap(), "b\n");
    }
}
