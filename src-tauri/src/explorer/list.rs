//! One level of a directory for the tree (lazy: a folder is read when it is expanded), with the
//! reason each entry is hidden by default: .gitignore, a well-known generated folder, or the
//! Windows hidden/system attribute. The UI decides what to show (toggle), so it never re-reads.

use std::cmp::Ordering;
use std::collections::HashSet;
use std::ffi::OsString;
use std::fs;
use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;

use super::ExplorerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// Why an entry is hidden unless the user chooses to see everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Hidden {
    /// A tooling or build folder (node_modules, .git, target...), see [`DEFAULT_HIDDEN`].
    Default,
    /// Matched by .gitignore, .git/info/exclude or the global excludes file.
    Ignored,
    /// Hidden or system attribute (desktop.ini, NTUSER.DAT...).
    System,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    /// Absolute path (lossy UTF-8: Windows names that are not valid UTF-16 are rare).
    pub path: String,
    pub kind: EntryKind,
    pub hidden: Option<Hidden>,
    /// Symbolic link or junction.
    pub link: bool,
}

/// Folders hidden by default whatever .gitignore says: dependencies, VCS data, build output and
/// tool caches. Only directories match.
pub const DEFAULT_HIDDEN: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "bin",
    "obj",
    "target",
    ".vs",
    ".idea",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".venv",
    ".next",
    ".nuxt",
    ".turbo",
    ".gradle",
    ".cache",
];

/// Entries of `dir`, directories first, then by name (case-insensitive, numbers in order).
pub fn list_dir(dir: &Path) -> Result<Vec<DirEntry>, ExplorerError> {
    let read = fs::read_dir(dir).map_err(|e| ExplorerError::io(dir, e))?;
    let kept = not_ignored(dir);
    let mut entries = Vec::new();
    for item in read.flatten() {
        let Ok(file_type) = item.file_type() else {
            continue;
        };
        let os_name = item.file_name();
        let name = os_name.to_string_lossy().into_owned();
        let path = item.path();
        let link = file_type.is_symlink();
        let is_dir = if link {
            // Junctions and directory links count as folders (their target decides).
            fs::metadata(&path).is_ok_and(|meta| meta.is_dir())
        } else {
            file_type.is_dir()
        };
        let hidden = if is_dir && DEFAULT_HIDDEN.iter().any(|h| h.eq_ignore_ascii_case(&name)) {
            Some(Hidden::Default)
        } else if !kept.contains(&os_name) {
            Some(Hidden::Ignored)
        } else if item.metadata().is_ok_and(|meta| hidden_attribute(&meta)) {
            Some(Hidden::System)
        } else {
            None
        };
        entries.push(DirEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            kind: if is_dir {
                EntryKind::Dir
            } else {
                EntryKind::File
            },
            hidden,
            link,
        });
    }
    entries.sort_by(|a, b| {
        (b.kind == EntryKind::Dir)
            .cmp(&(a.kind == EntryKind::Dir))
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    Ok(entries)
}

/// Names in `dir` that git would not ignore. Outside a repository nothing is ignored.
fn not_ignored(dir: &Path) -> HashSet<OsString> {
    WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        .ignore(false)
        .parents(true)
        .git_ignore(true)
        .git_exclude(true)
        .git_global(true)
        .require_git(true)
        .follow_links(false)
        .build()
        .flatten()
        .filter(|entry| entry.depth() == 1)
        .map(|entry| entry.file_name().to_os_string())
        .collect()
}

#[cfg(windows)]
fn hidden_attribute(meta: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    meta.file_attributes() & (HIDDEN | SYSTEM) != 0
}

#[cfg(not(windows))]
fn hidden_attribute(_meta: &fs::Metadata) -> bool {
    false
}

/// "file2" before "file10"; otherwise case-insensitive.
fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut a, mut b) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (a.peek().copied(), b.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut digits = String::new();
                    while let Some(c) = it.peek().copied().filter(char::is_ascii_digit) {
                        digits.push(c);
                        it.next();
                    }
                    digits
                };
                let (da, db) = (take(&mut a), take(&mut b));
                let (ta, tb) = (da.trim_start_matches('0'), db.trim_start_matches('0'));
                let order = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if order != Ordering::Equal {
                    return order;
                }
            }
            (Some(x), Some(y)) => {
                let order = x.to_lowercase().cmp(y.to_lowercase());
                if order != Ordering::Equal {
                    return order;
                }
                a.next();
                b.next();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natural_order() {
        let mut names = vec!["file10", "File2", "file1", "b", "A"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, ["A", "b", "file1", "File2", "file10"]);
    }
}
