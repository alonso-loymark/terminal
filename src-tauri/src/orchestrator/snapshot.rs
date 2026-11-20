//! What a task changed, as a diff. Before the worker starts, Brisa notes the repo's state
//! without touching it (no `git stash`, no index, no objects): the files that already had
//! changes are copied to a folder of Brisa's (in %TEMP%). After the task, each file that
//! changes now, had changes before or the worker touched is compared with its state before (the
//! copy, else HEAD's version, else nothing) and `git diff --no-index` writes the diff. Changes
//! that were already there before the task are not attributed to it.
//!
//! Without git, the diff is only the list of files the worker edited or wrote.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::explorer::git::run_code;

/// Files larger than this are compared by size only.
const MAX_FILE: u64 = 1024 * 1024;
/// Each file's diff and the whole diff are cut at these sizes.
const MAX_FILE_DIFF: usize = 64 * 1024;
const MAX_TOTAL_DIFF: usize = 512 * 1024;
const MAX_FILES: usize = 300;

#[derive(Debug)]
enum Before {
    /// Copied to the snapshot folder.
    Copied(PathBuf),
    /// Deleted in the working tree before the task.
    Missing,
    /// Too large to copy: only its size.
    Large(u64),
}

#[derive(Debug)]
pub struct Snapshot {
    root: Option<PathBuf>,
    head: bool,
    folder: PathBuf,
    before: HashMap<String, Before>,
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.folder);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    /// Relative to the repository root, with `/`.
    pub path: String,
    pub status: FileStatus,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
    /// Unified diff (hunks), possibly cut.
    pub diff: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiff {
    pub git: bool,
    pub files: Vec<FileDiff>,
    /// Without git: the files the worker edited or wrote.
    pub touched: Vec<String>,
}

/// `git status --porcelain=v1 -z`: path → deleted in the working tree.
fn status(git: &Path, root: &Path) -> Option<Vec<(String, bool)>> {
    let (code, out) = run_code(
        git,
        root,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
        ],
    )
    .ok()?;
    if code != Some(0) {
        return None;
    }
    let mut entries = Vec::new();
    for record in out.split(|b| *b == 0) {
        if record.len() < 4 {
            continue;
        }
        let xy = &record[..2];
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        entries.push((path, xy[1] == b'D' || (xy[0] == b'D' && xy[1] == b' ')));
    }
    Some(entries)
}

fn rel_of(root: &Path, path: &str) -> Option<String> {
    let path = Path::new(path);
    let lower = |p: &Path| p.display().to_string().replace('\\', "/").to_lowercase();
    let root_s = lower(root);
    let path_s = path.display().to_string().replace('\\', "/");
    if !path.is_absolute() {
        return Some(path_s.trim_start_matches("./").to_owned());
    }
    let prefix = format!("{}/", root_s.trim_end_matches('/'));
    path_s
        .to_lowercase()
        .starts_with(&prefix)
        .then(|| path_s[prefix.len()..].to_owned())
}

/// Notes the state of the repository around `dir` before a task.
pub fn take(git: Option<&Path>, dir: &Path, folder: PathBuf) -> Snapshot {
    let mut snapshot = Snapshot {
        root: None,
        head: false,
        folder,
        before: HashMap::new(),
    };
    let Some(git) = git else { return snapshot };
    let Some(root) = run_code(git, dir, &["rev-parse", "--show-toplevel"])
        .ok()
        .filter(|(code, _)| *code == Some(0))
        .map(|(_, out)| PathBuf::from(String::from_utf8_lossy(&out).trim()))
    else {
        return snapshot;
    };
    snapshot.head = run_code(git, &root, &["rev-parse", "--verify", "-q", "HEAD"])
        .is_ok_and(|(code, _)| code == Some(0));
    let Some(entries) = status(git, &root) else {
        return snapshot;
    };
    let _ = fs::create_dir_all(&snapshot.folder);
    for (index, (rel, deleted)) in entries.into_iter().take(5000).enumerate() {
        let file = root.join(&rel);
        let before = match fs::metadata(&file) {
            _ if deleted => Before::Missing,
            Ok(meta) if meta.is_file() && meta.len() > MAX_FILE => Before::Large(meta.len()),
            Ok(meta) if meta.is_file() => {
                let copy = snapshot.folder.join(index.to_string());
                if fs::copy(&file, &copy).is_err() {
                    continue;
                }
                Before::Copied(copy)
            }
            _ => continue,
        };
        snapshot.before.insert(rel, before);
    }
    snapshot.root = Some(root);
    snapshot
}

fn count(diff: &str) -> (u32, u32) {
    let mut add = 0;
    let mut del = 0;
    for line in diff.lines() {
        if line.starts_with('+') && !line.starts_with("+++") {
            add += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            del += 1;
        }
    }
    (add, del)
}

/// `git diff --no-index` between two files, with the headers naming the project path.
fn unified(git: &Path, root: &Path, before: &Path, after: &Path, rel: &str) -> (String, bool) {
    let before_s = before.display().to_string();
    let after_s = after.display().to_string();
    let Ok((_, out)) = run_code(
        git,
        root,
        &[
            "diff",
            "--no-index",
            "--no-color",
            "--no-ext-diff",
            "-U3",
            "--",
            &before_s,
            &after_s,
        ],
    ) else {
        return (String::new(), false);
    };
    let text = String::from_utf8_lossy(&out);
    if text.lines().any(|l| l.starts_with("Binary files")) {
        return (String::new(), true);
    }
    let hunks: Vec<&str> = text.lines().skip_while(|l| !l.starts_with("@@")).collect();
    (
        format!("--- a/{rel}\n+++ b/{rel}\n{}\n", hunks.join("\n")),
        false,
    )
}

/// What changed since `snapshot`, plus anything the worker reported touching (`touched`:
/// absolute or project-relative paths from its tool calls).
pub fn diff(git: Option<&Path>, snapshot: &Snapshot, touched: &[String]) -> TaskDiff {
    let (Some(git), Some(root)) = (git, snapshot.root.as_deref()) else {
        let mut touched: Vec<String> = touched.iter().map(|t| t.replace('\\', "/")).collect();
        touched.sort();
        touched.dedup();
        return TaskDiff {
            git: false,
            files: Vec::new(),
            touched,
        };
    };
    let now = status(git, root).unwrap_or_default();
    let mut paths: BTreeSet<String> = now.into_iter().map(|(p, _)| p).collect();
    paths.extend(snapshot.before.keys().cloned());
    paths.extend(touched.iter().filter_map(|t| rel_of(root, t)));
    let scratch = snapshot.folder.join("after");
    let _ = fs::create_dir_all(&scratch);
    let empty = scratch.join("empty");
    let _ = fs::write(&empty, b"");
    let mut files = Vec::new();
    let mut total = 0usize;
    for (index, rel) in paths.into_iter().enumerate() {
        if files.len() >= MAX_FILES || rel.starts_with(".git/") || rel.contains("/../") {
            continue;
        }
        let current = root.join(&rel);
        let after_exists = current.is_file();
        // The state before: the copy, HEAD's version, or nothing.
        let before_file: Option<PathBuf> = match snapshot.before.get(&rel) {
            Some(Before::Copied(copy)) => Some(copy.clone()),
            Some(Before::Missing) => None,
            Some(Before::Large(size)) => {
                if fs::metadata(&current).is_ok_and(|m| m.len() == *size) {
                    continue;
                }
                files.push(FileDiff {
                    path: rel,
                    status: FileStatus::Modified,
                    additions: 0,
                    deletions: 0,
                    binary: true,
                    diff: String::new(),
                    truncated: false,
                });
                continue;
            }
            None if snapshot.head => {
                let spec = format!("HEAD:{rel}");
                match run_code(git, root, &["show", &spec]) {
                    Ok((Some(0), bytes)) => {
                        let file = scratch.join(format!("head-{index}"));
                        fs::write(&file, bytes).ok().map(|()| file)
                    }
                    _ => None,
                }
            }
            None => None,
        };
        let before_bytes = before_file.as_ref().and_then(|f| fs::read(f).ok());
        let after_bytes = after_exists.then(|| fs::read(&current).ok()).flatten();
        if before_bytes == after_bytes {
            continue;
        }
        let status = match (&before_bytes, &after_bytes) {
            (None, Some(_)) => FileStatus::Added,
            (Some(_), None) => FileStatus::Deleted,
            _ => FileStatus::Modified,
        };
        let from = before_file.unwrap_or_else(|| empty.clone());
        let to = if after_exists {
            current.clone()
        } else {
            empty.clone()
        };
        let (mut text, binary) = unified(git, root, &from, &to, &rel);
        let (additions, deletions) = count(&text);
        let mut truncated = false;
        let budget = MAX_FILE_DIFF.min(MAX_TOTAL_DIFF.saturating_sub(total));
        if text.len() > budget {
            let mut cut = budget;
            while cut > 0 && !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
            truncated = true;
        }
        total += text.len();
        files.push(FileDiff {
            path: rel,
            status,
            additions,
            deletions,
            binary,
            diff: text,
            truncated,
        });
    }
    TaskDiff {
        git: true,
        files,
        touched: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_made_relative_to_the_repository() {
        let root = Path::new(r"C:\Repos\App");
        assert_eq!(
            rel_of(root, r"C:\Repos\App\src\a.ts").as_deref(),
            Some("src/a.ts")
        );
        assert_eq!(
            rel_of(root, "c:/repos/app/README.md").as_deref(),
            Some("README.md")
        );
        assert_eq!(rel_of(root, r"C:\Otro\x.ts"), None);
        assert_eq!(rel_of(root, "./src/b.ts").as_deref(), Some("src/b.ts"));
    }

    #[test]
    fn lines_are_counted_without_headers() {
        assert_eq!(
            count("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"),
            (2, 1)
        );
    }
}
