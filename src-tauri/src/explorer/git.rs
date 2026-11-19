//! Git status through the `git` CLI (no libgit2: it honors the user's config, hooks off, and costs
//! nothing in binary size). Runs off the main thread with a timeout, and with optional locks off
//! so it never fights the user's own git commands over `index.lock`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::ExplorerError;

/// Huge repositories: give up instead of piling up git processes.
const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Relative to the repository root, with `/` (as git prints it). Untracked folders end in `/`.
    pub path: String,
    pub status: GitFileStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Repository root (Windows path).
    pub root: String,
    /// Branch name, or `None` when detached.
    pub branch: Option<String>,
    /// Short commit id (detached HEAD), `None` before the first commit.
    pub commit: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
}

/// Status of the repository that contains `dir`; `None` if it is not in one (or git is missing).
pub fn git_status(git: &Path, dir: &Path) -> Result<Option<GitStatus>, ExplorerError> {
    let Some(top) = run(git, dir, &["rev-parse", "--show-toplevel"])? else {
        return Ok(None);
    };
    let root = PathBuf::from(String::from_utf8_lossy(&top).trim().replace('/', "\\"));
    let Some(out) = run(
        git,
        &root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=normal",
        ],
    )?
    else {
        return Err(ExplorerError::Unavailable("git status falló".to_owned()));
    };
    let mut status = parse(&out);
    status.root = root.display().to_string();
    Ok(Some(status))
}

/// Runs git; `Ok(None)` when it exits with an error (not a repository, dubious ownership...).
fn run(git: &Path, dir: &Path, args: &[&str]) -> Result<Option<Vec<u8>>, ExplorerError> {
    let mut command = Command::new(git);
    command
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| ExplorerError::Unavailable(format!("git: {e}")))?;
    // Read concurrently: a big status fills the pipe before git exits.
    let mut stdout = child.stdout.take();
    let reader = thread::spawn(move || {
        let mut out = Vec::new();
        if let Some(stdout) = stdout.as_mut() {
            let _ = stdout.read_to_end(&mut out);
        }
        out
    });
    let deadline = Instant::now() + TIMEOUT;
    let exit = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break exit,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ExplorerError::Unavailable(
                    "git tardó demasiado; repositorio muy grande".to_owned(),
                ));
            }
        }
    };
    let out = reader.join().unwrap_or_default();
    Ok(exit.success().then_some(out))
}

/// `git status --porcelain=v2 --branch -z`.
fn parse(out: &[u8]) -> GitStatus {
    let mut status = GitStatus {
        root: String::new(),
        branch: None,
        commit: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
    };
    let mut records = out
        .split(|b| *b == 0)
        .map(|r| String::from_utf8_lossy(r).into_owned());
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" if value != "(initial)" => {
                    status.commit = Some(value.chars().take(7).collect());
                }
                "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
                "branch.ab" => {
                    for part in value.split(' ') {
                        let n = part.get(1..).and_then(|n| n.parse().ok()).unwrap_or(0);
                        if part.starts_with('+') {
                            status.ahead = n;
                        } else if part.starts_with('-') {
                            status.behind = n;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        let kind = record.chars().next();
        let change = match kind {
            // 1 XY sub mH mI mW hH hI path
            Some('1') => record
                .splitn(9, ' ')
                .nth(8)
                .map(|path| (path.to_owned(), xy_status(record.get(2..4).unwrap_or("")))),
            // 2 XY sub mH mI mW hH hI Xscore path, then the original path as its own record
            Some('2') => {
                let path = record.splitn(10, ' ').nth(9).map(str::to_owned);
                records.next();
                path.map(|path| (path, GitFileStatus::Renamed))
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            Some('u') => record
                .splitn(11, ' ')
                .nth(10)
                .map(|path| (path.to_owned(), GitFileStatus::Conflict)),
            Some('?') => record
                .get(2..)
                .map(|path| (path.to_owned(), GitFileStatus::Untracked)),
            _ => None,
        };
        if let Some((path, status_kind)) = change {
            status.changes.push(GitChange {
                path,
                status: status_kind,
            });
        }
    }
    status
}

fn xy_status(xy: &str) -> GitFileStatus {
    if xy.contains('A') {
        GitFileStatus::Added
    } else if xy.contains('D') {
        GitFileStatus::Deleted
    } else if xy.contains('R') || xy.contains('C') {
        GitFileStatus::Renamed
    } else {
        GitFileStatus::Modified
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = [
            "# branch.oid 0123456789abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb src/con espacio.ts",
            "1 A. N... 000000 100644 100644 aaa bbb nuevo.ts",
            "2 R. N... 100644 100644 100644 aaa bbb R100 nombre nuevo.ts",
            "nombre viejo.ts",
            "u UU N... 100644 100644 100644 100644 a b c conflicto.ts",
            "? sin seguir/",
            "? ñandú.txt",
            "",
        ]
        .join("\0");
        let status = parse(out.as_bytes());
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.commit.as_deref(), Some("0123456"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let changes: Vec<(&str, GitFileStatus)> = status
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.status))
            .collect();
        assert_eq!(
            changes,
            [
                ("src/con espacio.ts", GitFileStatus::Modified),
                ("nuevo.ts", GitFileStatus::Added),
                ("nombre nuevo.ts", GitFileStatus::Renamed),
                ("conflicto.ts", GitFileStatus::Conflict),
                ("sin seguir/", GitFileStatus::Untracked),
                ("ñandú.txt", GitFileStatus::Untracked),
            ]
        );
    }

    #[test]
    fn detached_and_initial() {
        let status = parse(b"# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(status.branch, None);
        assert_eq!(status.commit, None);
    }
}
