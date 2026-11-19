//! File explorer backend: directory listings (with .gitignore), watchers, git status and file
//! operations. Like `pty`, it does not depend on Tauri, so it is tested headless.

mod git;
mod list;
mod ops;
mod watch;

use std::path::Path;

use serde::{Serialize, Serializer};

pub use git::{GitChange, GitFileStatus, GitStatus, git_status};
pub use list::{DEFAULT_HIDDEN, DirEntry, EntryKind, Hidden, list_dir};
pub use ops::{
    NewEntryKind, create_entry, open_in_file_manager, open_in_vscode, open_with_default_app,
    rename_entry, trash, validate_name,
};
pub use watch::{MAX_WATCHED_DIRS, WatchEvents, WatchId, WatchManager};

#[derive(Debug, thiserror::Error)]
pub enum ExplorerError {
    #[error("{path}: {message}")]
    Io { path: String, message: String },
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("watcher {0} does not exist")]
    NoWatcher(WatchId),
}

impl ExplorerError {
    pub(crate) fn io(path: &Path, error: std::io::Error) -> Self {
        let message = match error.kind() {
            std::io::ErrorKind::NotFound => "no existe".to_owned(),
            std::io::ErrorKind::PermissionDenied => "acceso denegado".to_owned(),
            std::io::ErrorKind::AlreadyExists => "ya existe".to_owned(),
            _ => error.to_string(),
        };
        Self::Io {
            path: path.display().to_string(),
            message,
        }
    }
}

/// Commands reject with the error message as a plain string.
impl Serialize for ExplorerError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}
