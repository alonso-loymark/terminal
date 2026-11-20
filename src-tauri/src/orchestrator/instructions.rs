//! AGENTS.md (the single source of instructions for every agent) and CLAUDE.md (Claude Code
//! reads it; a minimal one imports AGENTS.md with `@AGENTS.md`).
//!
//! These files belong to the project (often a client's repo): Brisa reads them, but only
//! writes the exact text the user saw and confirmed, and never commits. A write says what it
//! expects to find (nothing, or the content the user saw): if the file changed in between, it
//! is refused instead of overwriting.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Larger files are not shown or written (instructions are short).
const MAX_SIZE: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstructionFile {
    Agents,
    Claude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    /// Relative to the project (`AGENTS.md`, `CLAUDE.md` or `.claude/CLAUDE.md`).
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instructions {
    pub agents: Option<FileState>,
    pub claude: Option<FileState>,
    /// CLAUDE.md already imports AGENTS.md (`@AGENTS.md` on a line of its own).
    pub claude_imports_agents: bool,
}

fn read_limited(path: &Path) -> io::Result<Option<String>> {
    match fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            if meta.len() as usize > MAX_SIZE {
                return Err(io::Error::other(format!(
                    "{} es demasiado grande para mostrarlo",
                    path.display()
                )));
            }
            Ok(Some(String::from_utf8_lossy(&fs::read(path)?).into_owned()))
        }
        Ok(_) => Ok(None),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `@AGENTS.md` (or `@./AGENTS.md`) on a line of its own, outside code fences.
pub fn imports_agents(text: &str) -> bool {
    let mut fence = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("```") {
            fence = !fence;
            continue;
        }
        if !fence && matches!(line, "@AGENTS.md" | "@./AGENTS.md") {
            return true;
        }
    }
    false
}

/// Where the project's CLAUDE.md is: `CLAUDE.md`, else `.claude/CLAUDE.md` if that one exists.
fn claude_path(dir: &Path) -> (PathBuf, &'static str) {
    let root = dir.join("CLAUDE.md");
    let nested = dir.join(".claude").join("CLAUDE.md");
    if !root.exists() && nested.is_file() {
        (nested, ".claude/CLAUDE.md")
    } else {
        (root, "CLAUDE.md")
    }
}

fn path_of(dir: &Path, file: InstructionFile) -> (PathBuf, &'static str) {
    match file {
        InstructionFile::Agents => (dir.join("AGENTS.md"), "AGENTS.md"),
        InstructionFile::Claude => claude_path(dir),
    }
}

pub fn inspect(dir: &Path) -> io::Result<Instructions> {
    let state = |file| -> io::Result<Option<FileState>> {
        let (path, rel) = path_of(dir, file);
        Ok(read_limited(&path)?.map(|content| FileState {
            path: rel.to_owned(),
            content,
        }))
    };
    let agents = state(InstructionFile::Agents)?;
    let claude = state(InstructionFile::Claude)?;
    Ok(Instructions {
        claude_imports_agents: claude.as_ref().is_some_and(|c| imports_agents(&c.content)),
        agents,
        claude,
    })
}

/// Writes the text the user confirmed. `expected`: `None` = the file must not exist (it is
/// created, never overwritten); `Some(text)` = it must still have exactly that content.
pub fn write(
    dir: &Path,
    file: InstructionFile,
    content: &str,
    expected: Option<&str>,
) -> io::Result<Instructions> {
    if content.len() > MAX_SIZE {
        return Err(io::Error::other("el contenido es demasiado grande"));
    }
    let (path, rel) = path_of(dir, file);
    match expected {
        None => {
            // `create_new`: fails if it appeared meanwhile.
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|e| {
                    if e.kind() == io::ErrorKind::AlreadyExists {
                        io::Error::other(format!("{rel} ya existe: no se pisa"))
                    } else {
                        e
                    }
                })?;
            out.write_all(content.as_bytes())?;
        }
        Some(expected) => {
            let current = read_limited(&path)?;
            if current.as_deref() != Some(expected) {
                return Err(io::Error::other(format!(
                    "{rel} cambió desde que lo viste: no se escribió nada"
                )));
            }
            crate::settings::write(&path, content)?;
        }
    }
    inspect(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("brisa-instr-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn imports_are_found_outside_code_fences() {
        assert!(imports_agents("# Proyecto\n\n@AGENTS.md\n"));
        assert!(imports_agents("@./AGENTS.md"));
        assert!(!imports_agents("```\n@AGENTS.md\n```"));
        assert!(!imports_agents("Ver @AGENTS.md para más"));
    }

    #[test]
    fn nothing_is_overwritten_without_the_content_the_user_saw() {
        let dir = temp("write");
        let state = inspect(&dir).unwrap();
        assert_eq!(state.agents, None);
        assert_eq!(state.claude, None);
        let state = write(&dir, InstructionFile::Agents, "# A\n", None).unwrap();
        assert_eq!(state.agents.unwrap().content, "# A\n");
        // Creating again (expecting nothing) never overwrites.
        assert!(write(&dir, InstructionFile::Agents, "# B\n", None).is_err());
        // Changed since the user saw it: refused.
        fs::write(dir.join("CLAUDE.md"), "mío\n").unwrap();
        assert!(
            write(
                &dir,
                InstructionFile::Claude,
                "@AGENTS.md\nmío\n",
                Some("otro\n")
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "mío\n");
        let state = write(
            &dir,
            InstructionFile::Claude,
            "@AGENTS.md\n\nmío\n",
            Some("mío\n"),
        )
        .unwrap();
        assert!(state.claude_imports_agents);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_claude_md_inside_dot_claude_counts() {
        let dir = temp("nested");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude").join("CLAUDE.md"), "x").unwrap();
        let state = inspect(&dir).unwrap();
        assert_eq!(state.claude.unwrap().path, ".claude/CLAUDE.md");
        let _ = fs::remove_dir_all(&dir);
    }
}
