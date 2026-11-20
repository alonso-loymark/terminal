//! Git worktrees for the multi-agent preset: one per pane, so the agents do not step on each
//! other's files. Brisa keeps a registry of the worktrees it created (`worktrees.json` in the
//! config folder, written only by the backend) and only ever removes those.
//!
//! Layout: next to the repository, `<parent>\<repo>.worktrees\<label>-<id>`, on a new branch
//! `brisa/<label>-<id>` from the current HEAD. Removing a worktree also deletes its branch with
//! `git branch -d`, which refuses (and the branch stays) if the agent committed something.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const REGISTRY_FILE: &str = "worktrees.json";
const TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// The worktree's folder (Windows path).
    pub path: String,
    /// The main repository's root.
    pub repo: String,
    pub branch: String,
    /// Seconds since the epoch.
    pub created: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    pub exists: bool,
    /// Uncommitted changes (modified, staged or untracked files).
    pub changes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Removed {
    /// The branch had no commits of its own and went too.
    pub branch_deleted: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum WorktreeError {
    #[error("no es un repositorio de git")]
    NotARepo,
    #[error("el repositorio todavía no tiene commits")]
    NoCommits,
    #[error("Brisa no creó ese worktree: no se toca")]
    NotOurs,
    #[error("git: {0}")]
    Git(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for WorktreeError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Runs git; `Err` with its message when it fails.
fn git(git: &Path, dir: &Path, args: &[&str]) -> Result<String, WorktreeError> {
    let mut command = Command::new(git);
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    let out = thread::spawn(move || {
        let mut text = String::new();
        if let Some(s) = stdout.as_mut() {
            let _ = s.read_to_string(&mut text);
        }
        text
    });
    let err = thread::spawn(move || {
        let mut text = String::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_string(&mut text);
        }
        text
    });
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(WorktreeError::Git("tardó demasiado".to_owned()));
            }
        }
    };
    let out = out.join().unwrap_or_default();
    let err = err.join().unwrap_or_default();
    if status.success() {
        Ok(out)
    } else {
        Err(WorktreeError::Git(err.trim().to_owned()))
    }
}

fn windows_path(text: &str) -> PathBuf {
    PathBuf::from(text.trim().replace('/', "\\"))
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        p.trim_end_matches(['\\', '/'])
            .replace('/', "\\")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// Letters, digits and dashes: safe for a folder and a branch name.
fn sanitize(label: &str) -> String {
    let clean: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let clean = clean.trim_matches('-').to_owned();
    if clean.is_empty() {
        "agente".to_owned()
    } else {
        clean
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A short id that changes every call (base 36 of the time in ms + a counter).
fn unique_id() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0) as u64;
    let mut n = millis
        .wrapping_mul(31)
        .wrapping_add(u64::from(COUNTER.fetch_add(1, Ordering::Relaxed)));
    let mut out = String::new();
    for _ in 0..6 {
        let digit = (n % 36) as u32;
        out.push(char::from_digit(digit, 36).unwrap_or('0'));
        n /= 36;
    }
    out
}

pub fn list(registry: &Path) -> Vec<Worktree> {
    crate::settings::read(registry)
        .ok()
        .flatten()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn save(registry: &Path, worktrees: &[Worktree]) -> Result<(), WorktreeError> {
    let text =
        serde_json::to_string_pretty(worktrees).map_err(|e| WorktreeError::Git(e.to_string()))?;
    crate::settings::write(registry, &format!("{text}\n"))?;
    Ok(())
}

/// A worktree of the repository that contains `dir`, on a new branch from its HEAD.
pub fn create(
    git_exe: &Path,
    registry: &Path,
    dir: &Path,
    label: &str,
) -> Result<Worktree, WorktreeError> {
    let top = git(git_exe, dir, &["rev-parse", "--show-toplevel"])
        .map_err(|_| WorktreeError::NotARepo)?;
    let root = windows_path(&top);
    git(git_exe, &root, &["rev-parse", "--verify", "HEAD"])
        .map_err(|_| WorktreeError::NoCommits)?;
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_owned());
    let parent = root
        .parent()
        .unwrap_or(&root)
        .join(format!("{name}.worktrees"));
    std::fs::create_dir_all(&parent)?;
    let leaf = format!("{}-{}", sanitize(label), unique_id());
    let path = parent.join(&leaf);
    let branch = format!("brisa/{leaf}");
    let path_text = path.display().to_string();
    git(
        git_exe,
        &root,
        &["worktree", "add", "-b", &branch, &path_text, "HEAD"],
    )?;
    let worktree = Worktree {
        path: path_text,
        repo: root.display().to_string(),
        branch,
        created: now(),
    };
    let mut all = list(registry);
    all.push(worktree.clone());
    save(registry, &all)?;
    Ok(worktree)
}

pub fn status(git_exe: &Path, path: &Path) -> WorktreeStatus {
    if !path.is_dir() {
        return WorktreeStatus {
            exists: false,
            changes: 0,
        };
    }
    let changes = git(
        git_exe,
        path,
        &["status", "--porcelain", "--untracked-files=normal"],
    )
    .map(|out| out.lines().filter(|l| !l.trim().is_empty()).count() as u32)
    .unwrap_or(0);
    WorktreeStatus {
        exists: true,
        changes,
    }
}

/// Removes a worktree Brisa created (`force`: even with uncommitted changes) and its branch if
/// it has no commits of its own.
pub fn remove(
    git_exe: &Path,
    registry: &Path,
    path: &str,
    force: bool,
) -> Result<Removed, WorktreeError> {
    let mut all = list(registry);
    let at = all
        .iter()
        .position(|w| same_path(&w.path, path))
        .ok_or(WorktreeError::NotOurs)?;
    let worktree = all[at].clone();
    let repo = PathBuf::from(&worktree.repo);
    if Path::new(&worktree.path).is_dir() {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&worktree.path);
        git(git_exe, &repo, &args)?;
    } else if repo.is_dir() {
        // Deleted by hand: forget it.
        let _ = git(git_exe, &repo, &["worktree", "prune"]);
    }
    let branch_deleted =
        repo.is_dir() && git(git_exe, &repo, &["branch", "-d", &worktree.branch]).is_ok();
    all.remove(at);
    save(registry, &all)?;
    Ok(Removed { branch_deleted })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_become_safe_names() {
        assert_eq!(sanitize("Claude 1"), "claude-1");
        assert_eq!(sanitize("../../x"), "x");
        assert_eq!(sanitize("ñ"), "agente");
        assert_ne!(unique_id(), unique_id());
        assert!(same_path(r"C:\a\b\", "c:/A/b"));
    }
}
