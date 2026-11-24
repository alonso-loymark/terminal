//! Per-project files of the orchestrator, in `<config>\orchestrator\<name>-<hash>\`:
//! `chats.json` (the index of the project's chats: title, dates, which one is open),
//! `chats\<id>.json` (one chat's messages: the orchestrator owns them), `decisions.json` (the
//! decision log, updated after every task, shared by every chat) and `project.json` (the
//! project's path, main model and the commands the user allowed for it). `conversation.json` is
//! the single chat of before (Fase 8A): read once to migrate it, kept as it was. The frontend
//! owns the formats; this module only maps a project to its folder and reads/writes atomically.
//! Nothing is ever written inside the project.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::settings;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectFile {
    Conversation,
    Chats,
    Decisions,
    Project,
}

impl ProjectFile {
    pub fn name(self) -> &'static str {
        match self {
            ProjectFile::Conversation => "conversation.json",
            ProjectFile::Chats => "chats.json",
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

/// A chat's id as the frontend makes them (`chat-<base36>-<n>`): lowercase ASCII letters, digits
/// and dashes. Never a path: it names a file.
pub fn valid_chat_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn chat_path(config_dir: &Path, project: &Path, id: &str) -> io::Result<PathBuf> {
    if !valid_chat_id(id) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("id de chat inválido: «{id}»"),
        ));
    }
    Ok(folder(config_dir, project)?
        .join("chats")
        .join(format!("{id}.json")))
}

pub fn read_chat(config_dir: &Path, project: &Path, id: &str) -> io::Result<Option<String>> {
    settings::read(&chat_path(config_dir, project, id)?)
}

pub fn write_chat(config_dir: &Path, project: &Path, id: &str, text: &str) -> io::Result<()> {
    settings::write(&chat_path(config_dir, project, id)?, text)
}

/// Deletes a chat's file (one that does not exist is already deleted).
pub fn delete_chat(config_dir: &Path, project: &Path, id: &str) -> io::Result<()> {
    match fs::remove_file(chat_path(config_dir, project, id)?) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
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

    #[test]
    fn chats_are_files_named_by_a_safe_id() {
        assert!(valid_chat_id("chat-mfx3k2-12"));
        for bad in [
            "",
            "-x",
            "Chat",
            "a/b",
            "..",
            r"a\b",
            "chat.json",
            "c:x",
            &"a".repeat(65),
        ] {
            assert!(!valid_chat_id(bad), "{bad}");
        }
        let base = std::env::temp_dir().join(format!("brisa-chats-{}", std::process::id()));
        let config = base.join("config");
        let project = base.join("proyecto");
        std::fs::create_dir_all(&project).unwrap();
        write_chat(&config, &project, "chat-a-1", "{\"messages\":[]}").unwrap();
        assert_eq!(
            read_chat(&config, &project, "chat-a-1").unwrap().as_deref(),
            Some("{\"messages\":[]}")
        );
        assert!(
            folder(&config, &project)
                .unwrap()
                .join("chats")
                .join("chat-a-1.json")
                .is_file()
        );
        assert!(write_chat(&config, &project, "../decisions", "x").is_err());
        assert!(read_chat(&config, &project, "..").is_err());
        delete_chat(&config, &project, "chat-a-1").unwrap();
        assert_eq!(read_chat(&config, &project, "chat-a-1").unwrap(), None);
        // Deleting one that is not there is fine.
        delete_chat(&config, &project, "chat-a-1").unwrap();
        assert_eq!(std::fs::read_dir(&project).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
