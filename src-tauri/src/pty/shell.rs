//! Shells the terminal can start (profiles), how to launch them with shell integration, and
//! where a new session starts.

use std::env;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Shells with a profile. PowerShell is always available (Windows PowerShell as fallback).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    #[serde(rename = "powershell")]
    PowerShell,
    #[serde(rename = "gitbash")]
    GitBash,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub kind: ShellKind,
    pub name: String,
    pub program: PathBuf,
}

/// What to spawn for a profile.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// The shell integration script is injected (the shell will report cwd and commands).
    pub integration: bool,
}

/// Kept for tests and callers that just need "the" shell: PowerShell, no integration.
#[derive(Debug, Clone)]
pub struct ShellCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn default_shell() -> ShellCommand {
    let profile = powershell_profile();
    ShellCommand {
        program: profile.program,
        args: vec!["-NoLogo".to_owned()],
    }
}

/// Profiles available on this machine, default first.
pub fn available_shells() -> Vec<ShellProfile> {
    let mut shells = vec![powershell_profile()];
    if let Some(program) = find_git_bash() {
        shells.push(ShellProfile {
            kind: ShellKind::GitBash,
            name: "Git Bash".to_owned(),
            program,
        });
    }
    shells
}

pub fn shell_profile(kind: ShellKind) -> Option<ShellProfile> {
    available_shells()
        .into_iter()
        .find(|profile| profile.kind == kind)
}

/// How to start `profile`. With `integration_dir` (the folder holding `powershell.ps1` and
/// `bash.sh`), the shell loads the integration after the user's own startup files.
pub fn launch(profile: &ShellProfile, integration_dir: Option<&Path>) -> Launch {
    let integration_dir = integration_dir.map(without_verbatim_prefix);
    let integration_dir = integration_dir.as_deref();
    match profile.kind {
        ShellKind::PowerShell => {
            let script = integration_dir
                .map(|dir| dir.join("powershell.ps1"))
                .filter(|p| p.is_file());
            let mut args = vec!["-NoLogo".to_owned()];
            if let Some(script) = &script {
                // -NoExit -Command runs after the profile, which keeps loading as usual. A failure
                // (e.g. an execution policy that forbids scripts) is reported, not fatal.
                args.extend([
                    "-NoExit".to_owned(),
                    "-Command".to_owned(),
                    powershell_injector(script),
                ]);
            }
            Launch {
                program: profile.program.clone(),
                args,
                env: Vec::new(),
                integration: script.is_some(),
            }
        }
        ShellKind::GitBash => {
            let script = integration_dir
                .map(|dir| dir.join("bash.sh"))
                .filter(|p| p.is_file());
            let args = match &script {
                // MSYS accepts Windows paths with forward slashes.
                Some(script) => vec![
                    "--rcfile".to_owned(),
                    script.display().to_string().replace('\\', "/"),
                    "-i".to_owned(),
                ],
                None => vec!["--login".to_owned(), "-i".to_owned()],
            };
            Launch {
                program: profile.program.clone(),
                args,
                // Git Bash's /etc/profile would `cd ~` otherwise.
                env: vec![("CHERE_INVOKING".to_owned(), "1".to_owned())],
                integration: script.is_some(),
            }
        }
    }
}

/// `\\?\C:\x` → `C:\x` and `\\?\UNC\server\share` → `\\server\share`. Tauri resolves resources
/// as verbatim paths, and PowerShell treats `\\?\C:\...` as a network location: under the
/// default `RemoteSigned` policy the integration script was refused as "not digitally signed".
/// MSYS does not understand verbatim paths either.
fn without_verbatim_prefix(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

/// `try { . '<script>' } catch { <OSC 633;P;IntegrationError=...> }`
fn powershell_injector(script: &Path) -> String {
    let path = script.display().to_string().replace('\'', "''");
    format!(
        "try {{ . '{path}' }} catch {{ [Console]::Write([char]27 + ']633;P;IntegrationError=' + \
         (($_.Exception.Message -replace '[\\x00-\\x1f;]', ' ').Trim()) + [char]7) }}"
    )
}

/// The requested directory if it exists and can be listed; otherwise the user's home.
pub fn resolve_cwd(requested: Option<&Path>) -> Option<PathBuf> {
    requested
        .filter(|dir| std::fs::read_dir(dir).is_ok())
        .map(Path::to_path_buf)
        .or_else(default_cwd)
}

/// The user's home directory, which is where a new terminal starts by default.
pub fn default_cwd() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    env::var_os(var)
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
}

pub fn find_on_path(program: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(program))
        .find(|candidate| is_program(candidate))
}

/// PowerShell 7 (`pwsh`) when installed, otherwise Windows PowerShell 5.1.
#[cfg(windows)]
fn powershell_profile() -> ShellProfile {
    let pwsh = find_on_path("pwsh.exe").or_else(|| {
        ["ProgramFiles", "ProgramW6432"]
            .into_iter()
            .filter_map(env::var_os)
            .map(|dir| PathBuf::from(dir).join(r"PowerShell\7\pwsh.exe"))
            .find(|path| is_program(path))
    });
    match pwsh {
        Some(program) => ShellProfile {
            kind: ShellKind::PowerShell,
            name: "PowerShell".to_owned(),
            program,
        },
        None => {
            let root = env::var_os("SystemRoot")
                .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
            ShellProfile {
                kind: ShellKind::PowerShell,
                name: "Windows PowerShell".to_owned(),
                program: root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            }
        }
    }
}

#[cfg(not(windows))]
fn powershell_profile() -> ShellProfile {
    let program = find_on_path("pwsh").unwrap_or_else(|| PathBuf::from("/bin/sh"));
    ShellProfile {
        kind: ShellKind::PowerShell,
        name: "PowerShell".to_owned(),
        program,
    }
}

/// Git for Windows' bash launcher (`<Git>\bin\bash.exe`, which sets up the MSYS environment).
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    // git.exe on PATH lives in <Git>\cmd or <Git>\bin.
    let from_git = find_on_path("git.exe").and_then(|git| {
        git.parent()?
            .parent()
            .map(|root| root.join(r"bin\bash.exe"))
    });
    let installs = ["ProgramFiles", "ProgramW6432"]
        .into_iter()
        .filter_map(env::var_os)
        .map(|dir| PathBuf::from(dir).join(r"Git\bin\bash.exe"))
        .chain(
            env::var_os("LOCALAPPDATA")
                .map(|dir| PathBuf::from(dir).join(r"Programs\Git\bin\bash.exe")),
        );
    from_git
        .into_iter()
        .chain(installs)
        .find(|path| is_program(path))
}

#[cfg(not(windows))]
fn find_git_bash() -> Option<PathBuf> {
    None
}

fn is_program(path: &Path) -> bool {
    // App Execution Aliases (e.g. Store-installed pwsh in WindowsApps) are reparse points
    // that `metadata` cannot follow, so fall back to the link itself.
    path.is_file() || path.symlink_metadata().is_ok_and(|meta| !meta.is_dir())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_exists() {
        let shell = default_shell();
        assert!(
            is_program(&shell.program),
            "{} does not exist",
            shell.program.display()
        );
    }

    #[cfg(windows)]
    #[test]
    fn default_shell_is_powershell() {
        let name = default_shell()
            .program
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_lowercase();
        assert!(
            name == "pwsh.exe" || name == "powershell.exe",
            "unexpected shell {name}"
        );
    }

    #[test]
    fn powershell_loads_integration_after_the_profile() {
        let dir = std::env::temp_dir().join(format!("terminal-shell-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("powershell.ps1"), "").unwrap();
        let with_script = launch(&powershell_profile(), Some(&dir));
        assert!(with_script.integration);
        assert!(
            !with_script
                .args
                .iter()
                .any(|a| a.eq_ignore_ascii_case("-NoProfile")),
            "the profile must load"
        );
        assert_eq!(
            with_script.args[1..3],
            ["-NoExit".to_owned(), "-Command".to_owned()]
        );
        assert!(
            with_script.args[3].starts_with("try { . '")
                && with_script.args[3].contains("IntegrationError")
        );
        // Without the script: plain PowerShell.
        let plain = launch(&powershell_profile(), Some(Path::new("Z:\\no-existe")));
        assert!(!plain.integration);
        assert_eq!(plain.args, ["-NoLogo"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn verbatim_paths_are_made_plain() {
        assert_eq!(
            without_verbatim_prefix(Path::new(r"\\?\C:\Program Files\Terminal")),
            PathBuf::from(r"C:\Program Files\Terminal")
        );
        assert_eq!(
            without_verbatim_prefix(Path::new(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            without_verbatim_prefix(Path::new(r"C:\plain")),
            PathBuf::from(r"C:\plain")
        );
    }

    #[cfg(windows)]
    #[test]
    fn the_injected_script_path_is_never_verbatim() {
        let dir = std::env::temp_dir().join(format!("terminal-verbatim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("powershell.ps1"), "").unwrap();
        std::fs::write(dir.join("bash.sh"), "").unwrap();
        // canonicalize() is what yields \\?\ paths (like Tauri's resource dir).
        let verbatim = dir.canonicalize().unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        let ps = launch(&powershell_profile(), Some(&verbatim));
        assert!(
            ps.integration && !ps.args[3].contains(r"\\?\"),
            "{}",
            ps.args[3]
        );
        let bash = ShellProfile {
            kind: ShellKind::GitBash,
            name: "Git Bash".to_owned(),
            program: PathBuf::from("bash.exe"),
        };
        let bash = launch(&bash, Some(&verbatim));
        assert!(
            bash.integration && !bash.args[1].starts_with("//?/"),
            "{}",
            bash.args[1]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn single_quotes_in_the_script_path_are_escaped() {
        let injector = powershell_injector(Path::new(r"C:\O'Brien\powershell.ps1"));
        assert!(injector.contains(r"C:\O''Brien\powershell.ps1"));
    }

    #[test]
    fn unusable_directories_fall_back_to_home() {
        assert_eq!(
            resolve_cwd(Some(Path::new(r"Z:\no\existe\nunca"))),
            default_cwd()
        );
        assert_eq!(resolve_cwd(None), default_cwd());
        let here = std::env::current_dir().unwrap();
        assert_eq!(resolve_cwd(Some(&here)), Some(here.clone()));
    }
}
