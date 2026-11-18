//! Picks the shell and working directory for new sessions.

use std::env;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct ShellCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// PowerShell 7 (`pwsh`) when installed, otherwise Windows PowerShell 5.1.
#[cfg(windows)]
pub fn default_shell() -> ShellCommand {
    let program = find_on_path("pwsh.exe")
        .or_else(|| {
            ["ProgramFiles", "ProgramW6432"]
                .into_iter()
                .filter_map(env::var_os)
                .map(|dir| PathBuf::from(dir).join(r"PowerShell\7\pwsh.exe"))
                .find(|path| is_program(path))
        })
        .unwrap_or_else(|| {
            let root = env::var_os("SystemRoot")
                .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from);
            root.join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
        });
    ShellCommand {
        program,
        args: vec!["-NoLogo".to_owned()],
    }
}

#[cfg(not(windows))]
pub fn default_shell() -> ShellCommand {
    let program = env::var_os("SHELL").map_or_else(|| PathBuf::from("/bin/sh"), PathBuf::from);
    ShellCommand {
        program,
        args: vec!["-l".to_owned()],
    }
}

/// The user's home directory, which is where a new terminal should start.
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
}
