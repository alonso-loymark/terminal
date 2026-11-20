//! Per-project files of the orchestrator, in `<config>\orchestrator\<name>-<hash>\`:
//! `conversation.json` (the chat: the orchestrator owns it), `decisions.json` (the decision log,
//! updated after every task) and `project.json` (the project's path and the commands the user
//! allowed for it). The frontend owns their format; this module only maps a project to its
//! folder and reads/writes atomically. Nothing is ever written inside the project.

use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFile {
    Conversation,
    Decisions,
    Project,
}

impl ProjectFile {
    pub fn name(self) -> &'static str {
        match self {
            ProjectFile::Conversation => "conversation.json",
            ProjectFile::Decisions => "decisions.json",
            ProjectFile::Project => "project.json",
        }
    }
}

/// 64-bit FNV-1a: stable across runs and builds (unlike `DefaultHasher`).
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// `<folder name>-<hash of the path>`: readable, unique per path, the same for `C:\A\b` and
/// `c:/a/B/` (Windows paths ignore case).
pub fn project_key(dir: &Path) -> String {
    let normalized = dir
        .display()
        .to_string()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let name: String = super::project_name(dir)
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    let name = name.trim_matches('.');
    format!(
        "{}-{:016x}",
        if name.is_empty() { "raiz" } else { name },
        fnv1a(&normalized)
    )
}

/// The project's folder of orchestrator files. Refused if it would fall inside the project
/// (a config folder moved there with `BRISA_CONFIG_DIR`).
pub fn folder(config_dir: &Path, project: &Path) -> io::Result<PathBuf> {
    let folder = config_dir.join("orchestrator").join(project_key(project));
    let lower = |p: &Path| p.display().to_string().replace('/', "\\").to_lowercase();
    let project_prefix = format!("{}\\", lower(project).trim_end_matches('\\'));
    if lower(&folder).starts_with(&project_prefix) {
        return Err(io::Error::other(
            "la carpeta de configuración está dentro del proyecto: el orquestador no escribe ahí",
        ));
    }
    Ok(folder)
}

pub fn read(config_dir: &Path, project: &Path, file: ProjectFile) -> io::Result<Option<String>> {
    settings::read(&folder(config_dir, project)?.join(file.name()))
}

pub fn write(config_dir: &Path, project: &Path, file: ProjectFile, text: &str) -> io::Result<()> {
    settings::write(&folder(config_dir, project)?.join(file.name()), text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_project_maps_to_one_folder_whatever_the_spelling() {
        let a = project_key(Path::new(r"C:\Repos\Cliente App"));
        assert!(a.starts_with("cliente_app-"), "{a}");
        assert_eq!(a, project_key(Path::new(r"c:/repos/cliente app/")));
        assert_ne!(a, project_key(Path::new(r"C:\Otros\Cliente App")));
        assert!(project_key(Path::new(r"C:\")).len() > 16);
    }

    #[test]
    fn files_live_in_the_config_folder_never_in_the_project() {
        let base = std::env::temp_dir().join(format!("brisa-store-{}", std::process::id()));
        let config = base.join("config");
        let project = base.join("proyecto");
        std::fs::create_dir_all(&project).unwrap();
        write(&config, &project, ProjectFile::Conversation, "{\"v\":1}").unwrap();
        assert_eq!(
            read(&config, &project, ProjectFile::Conversation)
                .unwrap()
                .as_deref(),
            Some("{\"v\":1}")
        );
        assert_eq!(
            read(&config, &project, ProjectFile::Decisions).unwrap(),
            None
        );
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
        // A config folder inside the project is refused.
        let inside = project.join(".brisa");
        assert!(write(&inside, &project, ProjectFile::Project, "{}").is_err());
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
