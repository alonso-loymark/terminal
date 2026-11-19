//! Explorer backend against the real file system and the real `git` (skipped if missing).

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use brisa_lib::explorer::{EntryKind, GitFileStatus, Hidden, git_status, list_dir};
use brisa_lib::pty::find_on_path;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("terminal explorer {tag} {}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let long = dir.canonicalize().unwrap();
    PathBuf::from(long.display().to_string().trim_start_matches(r"\\?\"))
}

fn git(dir: &Path, args: &[&str]) {
    let git = find_on_path("git.exe").unwrap();
    let status = Command::new(git)
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=e2e",
            "-c",
            "user.email=e2e@example.invalid",
        ])
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[test]
fn listing_flags_ignored_default_and_system_entries() {
    let dir = temp_dir("list");
    fs::create_dir(dir.join(".git")).unwrap(); // enough for .gitignore to apply
    fs::write(dir.join(".gitignore"), "*.log\nsalida/\n").unwrap();
    for file in ["b.txt", "a10.txt", "a2.txt", "registro.log", "Ñandú áé.md"] {
        fs::write(dir.join(file), "x").unwrap();
    }
    for sub in ["node_modules", "salida", "src", "target"] {
        fs::create_dir(dir.join(sub)).unwrap();
    }
    fs::write(dir.join("oculto.ini"), "x").unwrap();
    let attrib = Command::new("attrib")
        .arg("+h")
        .arg(dir.join("oculto.ini"))
        .status()
        .unwrap();
    assert!(attrib.success());

    let entries = list_dir(&dir).unwrap();
    let summary: Vec<(&str, EntryKind, Option<Hidden>)> = entries
        .iter()
        .map(|e| (e.name.as_str(), e.kind, e.hidden))
        .collect();
    use EntryKind::{Dir, File};
    assert_eq!(
        summary,
        [
            (".git", Dir, Some(Hidden::Default)),
            ("node_modules", Dir, Some(Hidden::Default)),
            ("salida", Dir, Some(Hidden::Ignored)),
            ("src", Dir, None),
            ("target", Dir, Some(Hidden::Default)),
            (".gitignore", File, None),
            ("a2.txt", File, None),
            ("a10.txt", File, None),
            ("b.txt", File, None),
            ("oculto.ini", File, Some(Hidden::System)),
            ("registro.log", File, Some(Hidden::Ignored)),
            ("Ñandú áé.md", File, None),
        ]
    );
    assert_eq!(
        entries.iter().find(|e| e.name == "src").unwrap().path,
        dir.join("src").display().to_string()
    );
    assert!(list_dir(&dir.join("no existe")).is_err());
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_big_folder_lists_fast() {
    let dir = temp_dir("big");
    for i in 0..5000 {
        fs::write(dir.join(format!("archivo {i:05}.txt")), "").unwrap();
    }
    let started = std::time::Instant::now();
    let entries = list_dir(&dir).unwrap();
    let elapsed = started.elapsed();
    assert_eq!(entries.len(), 5000);
    assert_eq!(entries[4999].name, "archivo 04999.txt");
    assert!(elapsed.as_secs_f64() < 2.0, "listing took {elapsed:?}");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn git_status_reports_branch_and_changes() {
    let Some(git_exe) = find_on_path("git.exe") else {
        eprintln!("skipped: git not found");
        return;
    };
    let dir = temp_dir("git");
    assert!(
        git_status(&git_exe, &dir).unwrap().is_none(),
        "not a repository"
    );
    git(&dir, &["init", "-q", "-b", "principal"]);
    fs::write(dir.join("versionado.txt"), "uno").unwrap();
    fs::create_dir(dir.join("sub carpeta")).unwrap();
    fs::write(dir.join("sub carpeta").join("ñ.txt"), "uno").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-q", "-m", "inicial"]);
    fs::write(dir.join("versionado.txt"), "dos").unwrap();
    fs::write(dir.join("nuevo archivo.txt"), "x").unwrap();
    fs::write(dir.join("agregado.txt"), "x").unwrap();
    git(&dir, &["add", "agregado.txt"]);

    // Asked from a subfolder: the root is found.
    let status = git_status(&git_exe, &dir.join("sub carpeta"))
        .unwrap()
        .unwrap();
    assert_eq!(
        status.root.to_lowercase(),
        dir.display().to_string().to_lowercase()
    );
    assert_eq!(status.branch.as_deref(), Some("principal"));
    let mut changes: Vec<(String, GitFileStatus)> = status
        .changes
        .into_iter()
        .map(|c| (c.path, c.status))
        .collect();
    changes.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        changes,
        [
            ("agregado.txt".to_owned(), GitFileStatus::Added),
            ("nuevo archivo.txt".to_owned(), GitFileStatus::Untracked),
            ("versionado.txt".to_owned(), GitFileStatus::Modified),
        ]
    );
    fs::remove_dir_all(&dir).ok();
}
