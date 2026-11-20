//! Worktrees of the multi-agent preset with a real git: created next to the repository on a new
//! branch, status with and without changes, removal only of Brisa's own, branch kept when the
//! agent committed something.

use std::path::{Path, PathBuf};
use std::process::Command;

use brisa_lib::pty::find_on_path;
use brisa_lib::worktree::{self, WorktreeError};

fn git_exe() -> Option<PathBuf> {
    find_on_path("git.exe").or_else(|| find_on_path("git"))
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new(git_exe().unwrap())
        .arg("-C")
        .arg(dir)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repository with one commit, in its own temporary folder.
fn repo(name: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!("brisa-wt-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let repo = base.join("proyecto");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.email", "e2e@example.com"]);
    git(&repo, &["config", "user.name", "e2e"]);
    std::fs::write(repo.join("leeme.txt"), "hola").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-q", "-m", "inicio"]);
    (base, repo)
}

#[test]
fn worktrees_are_created_next_to_the_repo_and_only_brisas_are_removed() {
    let Some(git_path) = git_exe() else {
        eprintln!("sin git: se saltea");
        return;
    };
    let (base, repo) = repo("crear");
    let registry = base.join("config").join(worktree::REGISTRY_FILE);

    let a = worktree::create(&git_path, &registry, &repo, "claude 1").unwrap();
    let b = worktree::create(&git_path, &registry, &repo.join("."), "codex 2").unwrap();
    assert!(a.path.contains("proyecto.worktrees"), "{}", a.path);
    assert!(a.branch.starts_with("brisa/claude-1-"), "{}", a.branch);
    assert!(Path::new(&a.path).join("leeme.txt").exists());
    assert_ne!(a.path, b.path);
    assert_eq!(worktree::list(&registry).len(), 2);
    let listed = git(&repo, &["worktree", "list", "--porcelain"]);
    assert_eq!(listed.matches("worktree ").count(), 3, "{listed}");

    // Clean: removed with its branch (no commits of its own).
    assert_eq!(worktree::status(&git_path, Path::new(&a.path)).changes, 0);
    let removed = worktree::remove(&git_path, &registry, &a.path, false).unwrap();
    assert!(removed.branch_deleted);
    assert!(!Path::new(&a.path).exists());
    assert!(!git(&repo, &["branch", "--list"]).contains(&a.branch));

    // Uncommitted changes: refused without force.
    std::fs::write(Path::new(&b.path).join("nuevo.txt"), "cambio").unwrap();
    let status = worktree::status(&git_path, Path::new(&b.path));
    assert!(status.exists && status.changes == 1);
    assert!(worktree::remove(&git_path, &registry, &b.path, false).is_err());
    assert!(Path::new(&b.path).exists());
    // A commit of the agent's: the branch stays after removing the worktree.
    git(Path::new(&b.path), &["add", "."]);
    git(Path::new(&b.path), &["commit", "-q", "-m", "del agente"]);
    let removed = worktree::remove(&git_path, &registry, &b.path, false).unwrap();
    assert!(!removed.branch_deleted);
    assert!(git(&repo, &["branch", "--list"]).contains(&b.branch));
    assert!(worktree::list(&registry).is_empty());

    // Not created by Brisa: never touched.
    let other = base.join("otro");
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "ajeno",
            &other.display().to_string(),
        ],
    );
    assert!(matches!(
        worktree::remove(&git_path, &registry, &other.display().to_string(), true),
        Err(WorktreeError::NotOurs)
    ));
    assert!(other.exists());

    git(
        &repo,
        &[
            "worktree",
            "remove",
            "--force",
            &other.display().to_string(),
        ],
    );
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn a_folder_without_a_repo_or_commits_is_explained() {
    let Some(git_path) = git_exe() else {
        return;
    };
    let base = std::env::temp_dir().join(format!("brisa-wt-norepo-{}", std::process::id()));
    std::fs::create_dir_all(&base).unwrap();
    let registry = base.join(worktree::REGISTRY_FILE);
    assert!(matches!(
        worktree::create(&git_path, &registry, &base, "x"),
        Err(WorktreeError::NotARepo)
    ));
    let empty = base.join("vacio");
    std::fs::create_dir_all(&empty).unwrap();
    git(&empty, &["init", "-q"]);
    assert!(matches!(
        worktree::create(&git_path, &registry, &empty, "x"),
        Err(WorktreeError::NoCommits)
    ));
    // A worktree deleted by hand is forgotten without errors.
    let (base2, repo) = repo("borrado");
    let registry2 = base2.join(worktree::REGISTRY_FILE);
    let w = worktree::create(&git_path, &registry2, &repo, "gemini").unwrap();
    std::fs::remove_dir_all(&w.path).unwrap();
    assert!(!worktree::status(&git_path, Path::new(&w.path)).exists);
    worktree::remove(&git_path, &registry2, &w.path, false).unwrap();
    assert!(worktree::list(&registry2).is_empty());
    let _ = std::fs::remove_dir_all(&base);
    let _ = std::fs::remove_dir_all(&base2);
}
