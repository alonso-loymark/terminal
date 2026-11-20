//! The orchestrator's files and project inspection (Fase 8A), without Tauri:
//! - `store.rs`: the conversation, the decision log and the project's approvals, per project,
//!   in Brisa's config folder (never inside the repo).
//! - `snapshot.rs`: what a task changed (git), as a diff.
//! - `instructions.rs`: AGENTS.md and CLAUDE.md, read freely, written only with the exact text
//!   the user saw and confirmed.

pub mod instructions;
pub mod snapshot;
pub mod store;

use std::path::{Path, PathBuf};

/// A project folder as the frontend sends it: absolute, existing, without a trailing separator.
pub fn project_dir(dir: &str) -> Result<PathBuf, String> {
    let trimmed = dir.trim().trim_end_matches(['\\', '/']);
    let path = if trimmed.ends_with(':') {
        PathBuf::from(format!("{trimmed}\\"))
    } else {
        PathBuf::from(trimmed)
    };
    if !path.is_absolute() {
        return Err(format!("La carpeta no es una ruta absoluta: {dir}"));
    }
    if !path.is_dir() {
        return Err(format!("No existe la carpeta: {dir}"));
    }
    Ok(path)
}

/// The folder's name for the UI ("C:\\" for a drive).
pub fn project_name(dir: &Path) -> String {
    dir.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| dir.display().to_string())
}
