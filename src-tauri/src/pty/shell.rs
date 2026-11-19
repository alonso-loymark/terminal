//! Shell profiles: the shells found on this machine, how to start one (with shell integration
//! when possible) and where a new session starts.
//!
//! The frontend owns the user's settings: it merges the detected profiles with the user's own
//! (name, icon, command, args, env...) and sends a [`ShellSpec`] for each session. What that spec
//! turns into (integration scripts, environment, WSL arguments) is decided here.

use std::collections::BTreeMap;
use std::env;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Shells the terminal knows how to integrate with. `Other` runs as is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    /// Windows PowerShell 5.1.
    #[serde(rename = "powershell")]
    PowerShell,
    /// PowerShell 7.
    Pwsh,
    Cmd,
    #[serde(rename = "gitbash")]
    GitBash,
    Wsl,
    Other,
}

/// A shell found on this machine. The default one comes first.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    /// Stable id the settings refer to: `pwsh`, `powershell`, `cmd`, `gitbash`, `wsl-<distro>`.
    pub id: String,
    pub kind: ShellKind,
    pub name: String,
    pub program: PathBuf,
    /// WSL distribution name.
    pub distro: Option<String>,
}

/// What the frontend asks to start: a detected profile, possibly customized, or the user's own.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShellSpec {
    /// None: guessed from `program`.
    pub kind: Option<ShellKind>,
    /// None: the detected program for `kind` (and `distro`).
    pub program: Option<String>,
    /// None: the default arguments, with shell integration.
    pub args: Option<Vec<String>>,
    pub env: BTreeMap<String, String>,
    pub distro: Option<String>,
}

/// A shell ready to launch: program found, environment variables expanded.
#[derive(Debug, Clone)]
pub struct Shell {
    pub kind: ShellKind,
    pub program: PathBuf,
    /// The user's arguments; None for the defaults (which carry the integration).
    pub args: Option<Vec<String>>,
    pub env: Vec<(String, String)>,
    pub distro: Option<String>,
}

/// How much the started shell reports through OSC sequences.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Integration {
    /// Integration script injected: cwd, prompt and command marks (it confirms with 633;P).
    Full,
    /// Only the current folder (cmd's prompt).
    Cwd,
    /// Nothing: a custom program, or arguments the injection would interfere with.
    None,
    /// The shell supports it but the script was not found.
    Missing,
}

/// What to spawn.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// The process' working directory (WSL gets its own as `--cd`).
    pub cwd: Option<PathBuf>,
    pub integration: Integration,
}

/// Kept for tests and callers that just need "the" shell: the default one, no integration.
#[derive(Debug, Clone)]
pub struct ShellCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn default_shell() -> ShellCommand {
    ShellCommand {
        program: available_shells()
            .into_iter()
            .next()
            .map_or_else(windows_powershell, |profile| profile.program),
        args: vec!["-NoLogo".to_owned()],
    }
}

/// Profiles available on this machine, default first: PowerShell 7 if installed, Windows
/// PowerShell, cmd, Git Bash and one per WSL distribution.
pub fn available_shells() -> Vec<ShellProfile> {
    let mut shells = Vec::new();
    if let Some(program) = find_pwsh() {
        shells.push(profile("pwsh", ShellKind::Pwsh, "PowerShell", program));
    }
    if cfg!(windows) {
        shells.push(profile(
            "powershell",
            ShellKind::PowerShell,
            "Windows PowerShell",
            windows_powershell(),
        ));
        let cmd = system32("cmd.exe");
        if is_program(&cmd) {
            shells.push(profile("cmd", ShellKind::Cmd, "Símbolo del sistema", cmd));
        }
    }
    if let Some(program) = find_git_bash() {
        shells.push(profile("gitbash", ShellKind::GitBash, "Git Bash", program));
    }
    let wsl = system32("wsl.exe");
    if is_program(&wsl) {
        for distro in super::wsl::installed_distros() {
            shells.push(ShellProfile {
                id: format!("wsl-{distro}"),
                kind: ShellKind::Wsl,
                name: distro.clone(),
                program: wsl.clone(),
                distro: Some(distro),
            });
        }
    }
    shells
}

fn profile(id: &str, kind: ShellKind, name: &str, program: PathBuf) -> ShellProfile {
    ShellProfile {
        id: id.to_owned(),
        kind,
        name: name.to_owned(),
        program,
        distro: None,
    }
}

/// The detected profile of a kind (the first one: for WSL, the default distribution).
pub fn shell_profile(kind: ShellKind) -> Option<ShellProfile> {
    available_shells()
        .into_iter()
        .find(|profile| profile.kind == kind)
}

/// What a spec asks for, against the shells detected on this machine. No spec: the default.
pub fn resolve(spec: Option<&ShellSpec>, detected: &[ShellProfile]) -> Option<Shell> {
    let Some(spec) = spec else {
        let first = detected.first()?;
        return Some(Shell {
            kind: first.kind,
            program: first.program.clone(),
            args: None,
            env: Vec::new(),
            distro: first.distro.clone(),
        });
    };
    let program = spec
        .program
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let (kind, program) = match program {
        Some(program) => {
            let program = PathBuf::from(expand_env(program));
            // A bare name ("nu", "node.exe") is looked up on the PATH like a shell would.
            let program = if program.components().count() == 1 {
                let name = program.display().to_string();
                find_on_path(&name)
                    .or_else(|| find_on_path(&format!("{name}.exe")))
                    .unwrap_or(program)
            } else {
                program
            };
            (spec.kind.unwrap_or_else(|| kind_of(&program)), program)
        }
        None => {
            let kind = spec.kind?;
            let found = detected.iter().find(|profile| {
                profile.kind == kind && (spec.distro.is_none() || profile.distro == spec.distro)
            })?;
            (kind, found.program.clone())
        }
    };
    let env = spec
        .env
        .iter()
        .map(|(key, value)| (key.clone(), expand_env(value)))
        .collect();
    Some(Shell {
        kind,
        program,
        args: spec.args.clone(),
        env,
        distro: spec.distro.clone(),
    })
}

/// The kind of shell a program is, from its file name.
pub fn kind_of(program: &Path) -> ShellKind {
    let stem = program
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match stem.as_str() {
        "powershell" => ShellKind::PowerShell,
        "pwsh" => ShellKind::Pwsh,
        "cmd" => ShellKind::Cmd,
        "wsl" => ShellKind::Wsl,
        // Git for Windows' launcher (bin\bash.exe) or the MSYS bash itself (usr\bin\bash.exe).
        "bash"
            if program
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains(r"\git\") =>
        {
            ShellKind::GitBash
        }
        _ => ShellKind::Other,
    }
}

/// How to start `shell` in `cwd` (already resolved). With `integration_dir` (the folder holding
/// `powershell.ps1` and `bash.sh`), the shell loads the integration after the user's own
/// startup files, unless the user's arguments would conflict with it.
pub fn launch(shell: &Shell, integration_dir: Option<&Path>, cwd: Option<&Path>) -> Launch {
    let integration_dir = integration_dir.map(without_verbatim_prefix);
    let script = |name: &str| {
        integration_dir
            .as_deref()
            .map(|dir| dir.join(name))
            .filter(|p| p.is_file())
    };
    let mut out = Launch {
        program: shell.program.clone(),
        args: shell.args.clone().unwrap_or_default(),
        env: Vec::new(),
        cwd: cwd.map(Path::to_path_buf),
        integration: Integration::None,
    };
    match shell.kind {
        ShellKind::PowerShell | ShellKind::Pwsh => {
            if shell.args.is_none() {
                out.args = vec!["-NoLogo".to_owned()];
            }
            if !powershell_takes_over(&out.args) {
                match script("powershell.ps1") {
                    Some(script) => {
                        // -NoExit -Command runs after the profile, which keeps loading as usual. A
                        // failure (e.g. an execution policy that forbids scripts) is reported, not
                        // fatal.
                        out.args.extend([
                            "-NoExit".to_owned(),
                            "-Command".to_owned(),
                            powershell_injector(&script),
                        ]);
                        out.integration = Integration::Full;
                    }
                    None => out.integration = Integration::Missing,
                }
            }
        }
        ShellKind::GitBash => {
            // Git Bash's /etc/profile would `cd ~` otherwise.
            out.env.push(("CHERE_INVOKING".to_owned(), "1".to_owned()));
            if shell.args.is_none() {
                match script("bash.sh") {
                    // MSYS accepts Windows paths with forward slashes.
                    Some(script) => {
                        out.args = vec![
                            "--rcfile".to_owned(),
                            script.display().to_string().replace('\\', "/"),
                            "-i".to_owned(),
                        ];
                        out.integration = Integration::Full;
                    }
                    None => {
                        out.args = vec!["--login".to_owned(), "-i".to_owned()];
                        out.integration = Integration::Missing;
                    }
                }
            }
        }
        ShellKind::Cmd => {
            // cmd has no hooks, but its prompt can carry escape sequences: report the folder at
            // every prompt (OSC 9;9, like Windows Terminal), before the user's own prompt.
            let own = shell
                .env
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("PROMPT"))
                .map(|(_, value)| value.clone())
                .or_else(|| env::var("PROMPT").ok());
            out.env
                .push(("PROMPT".to_owned(), cmd_prompt(own.as_deref())));
            out.integration = Integration::Cwd;
        }
        ShellKind::Wsl => {
            // wsl.exe takes the folder itself (Windows paths are translated) and starts in the
            // Linux home without one, like Windows Terminal.
            let mut args = Vec::new();
            if let Some(distro) = &shell.distro {
                args.extend(["-d".to_owned(), distro.clone()]);
            }
            let wsl_cwd = cwd.map_or_else(|| "~".to_owned(), |dir| dir.display().to_string());
            args.extend(["--cd".to_owned(), wsl_cwd]);
            out.cwd = default_cwd();
            match &shell.args {
                Some(user) => args.extend(user.iter().cloned()),
                None => match script("bash.sh") {
                    Some(script) => {
                        // WSLENV's /p flag hands the script's path over translated to Linux.
                        let wslenv = env::var("WSLENV").ok().filter(|v| !v.is_empty());
                        let wslenv = match wslenv {
                            Some(existing) => format!("{existing}:{WSL_RCFILE_VAR}/p"),
                            None => format!("{WSL_RCFILE_VAR}/p"),
                        };
                        out.env.push(("WSLENV".to_owned(), wslenv));
                        out.env
                            .push((WSL_RCFILE_VAR.to_owned(), script.display().to_string()));
                        args.extend([
                            "-e".to_owned(),
                            "sh".to_owned(),
                            "-c".to_owned(),
                            WSL_LAUNCHER.to_owned(),
                        ]);
                        out.integration = Integration::Full;
                    }
                    None => out.integration = Integration::Missing,
                },
            }
            out.args = args;
        }
        ShellKind::Other => {}
    }
    // The user's variables go last: they win over ours.
    out.env.extend(
        shell
            .env
            .iter()
            .filter(|(key, _)| {
                !(shell.kind == ShellKind::Cmd && key.eq_ignore_ascii_case("PROMPT"))
            })
            .cloned(),
    );
    out
}

const WSL_RCFILE_VAR: &str = "TERMINAL_WSL_RCFILE";

/// Run by `sh` inside the distribution: bash gets the integration (it reads the user's startup
/// files itself); any other login shell starts as usual and the terminal is told why there is
/// no integration.
pub const WSL_LAUNCHER: &str = r#"s=${SHELL:-$(getent passwd "$(id -un)" | cut -d: -f7)}; case "$s" in */bash) if [ -r "$TERMINAL_WSL_RCFILE" ]; then exec "$s" --rcfile "$TERMINAL_WSL_RCFILE" -i; fi; m='no se encontró el script de integración';; *) m="la integración en WSL funciona con bash (shell: $s)";; esac; printf '\033]633;P;IntegrationError=%s\007' "$m"; exec "${s:-/bin/sh}" -l"#;

/// cmd's PROMPT with the folder report in front of the user's prompt (default `$P$G`).
fn cmd_prompt(own: Option<&str>) -> String {
    format!("$e]9;9;$P$e\\{}", own.unwrap_or("$P$G"))
}

/// PowerShell arguments after which `-NoExit -Command <integration>` would change what the user
/// asked for: they run something else (`-Command`, `-File`, a script), or already decide whether
/// the shell stays open (`-NoExit`). Parameter names may be abbreviated, as PowerShell allows.
fn powershell_takes_over(args: &[String]) -> bool {
    const TAKE_OVER: &[(&str, usize)] = &[
        ("command", 1),
        ("file", 1),
        ("encodedcommand", 1),
        ("noexit", 3),
        ("commandwithargs", 8),
    ];
    const SWITCHES: &[(&str, usize)] = &[
        ("nologo", 3),
        ("noprofile", 3),
        ("noninteractive", 4),
        ("sta", 3),
        ("mta", 3),
        ("login", 1),
        ("interactive", 1),
    ];
    let abbreviates = |name: &str, list: &[(&str, usize)]| {
        list.iter()
            .any(|(full, min)| name.len() >= *min && full.starts_with(name))
    };
    let mut previous_is_switch = true;
    for arg in args {
        match arg.strip_prefix('-').or_else(|| arg.strip_prefix('/')) {
            Some(name) => {
                let name = name.to_ascii_lowercase();
                let name = name.trim_end_matches(':');
                if abbreviates(name, TAKE_OVER) || name == "ec" || name == "cwa" {
                    return true;
                }
                previous_is_switch = abbreviates(name, SWITCHES);
            }
            // A value after a parameter that takes one (-ExecutionPolicy Bypass) is fine; a
            // bare word after a switch or first is a script (-File) or a command.
            None if previous_is_switch => return true,
            None => previous_is_switch = true,
        }
    }
    false
}

/// `%NAME%` → the variable's value (unknown names stay as written), like Windows Terminal.
pub fn expand_env(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match env::var(name) {
                    Ok(value) => out.push_str(&value),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
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

/// The requested directory (`%VAR%` and a leading `~` expanded) if it exists and can be listed;
/// otherwise the user's home.
pub fn resolve_cwd(requested: Option<&Path>) -> Option<PathBuf> {
    requested
        .map(expand_dir)
        .filter(|dir| std::fs::read_dir(dir).is_ok())
        .or_else(default_cwd)
}

fn expand_dir(dir: &Path) -> PathBuf {
    let text = expand_env(&dir.to_string_lossy());
    match (text.strip_prefix('~'), default_cwd()) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['\\', '/']) => {
            home.join(rest.trim_start_matches(['\\', '/']))
        }
        _ => PathBuf::from(text),
    }
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

fn system32(program: &str) -> PathBuf {
    env::var_os("SystemRoot")
        .map_or_else(|| PathBuf::from(r"C:\Windows"), PathBuf::from)
        .join("System32")
        .join(program)
}

/// Windows PowerShell 5.1 (always present on Windows).
fn windows_powershell() -> PathBuf {
    if cfg!(windows) {
        system32(r"WindowsPowerShell\v1.0\powershell.exe")
    } else {
        find_on_path("pwsh").unwrap_or_else(|| PathBuf::from("/bin/sh"))
    }
}

/// PowerShell 7 (`pwsh`), from the PATH or its usual install folders.
fn find_pwsh() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    find_on_path("pwsh.exe").or_else(|| {
        ["ProgramFiles", "ProgramW6432"]
            .into_iter()
            .filter_map(env::var_os)
            .map(|dir| PathBuf::from(dir).join(r"PowerShell\7\pwsh.exe"))
            .find(|path| is_program(path))
    })
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

    fn shell(kind: ShellKind, program: &str, args: Option<&[&str]>) -> Shell {
        Shell {
            kind,
            program: PathBuf::from(program),
            args: args.map(|a| a.iter().map(|s| (*s).to_owned()).collect()),
            env: Vec::new(),
            distro: None,
        }
    }

    /// A folder with both integration scripts (empty: only their presence matters here).
    fn scripts(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("terminal-shell-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("powershell.ps1"), "").unwrap();
        std::fs::write(dir.join("bash.sh"), "").unwrap();
        dir
    }

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
    fn default_shell_is_powershell_and_the_usual_shells_are_detected() {
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
        let shells = available_shells();
        let ids: Vec<&str> = shells.iter().map(|s| s.id.as_str()).collect();
        assert!(
            ids.contains(&"powershell") && ids.contains(&"cmd"),
            "{ids:?}"
        );
        assert_eq!(
            shells[0].kind,
            if ids.contains(&"pwsh") {
                ShellKind::Pwsh
            } else {
                ShellKind::PowerShell
            }
        );
        // Ids are unique: the settings refer to profiles by id.
        let mut unique = ids.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), ids.len());
    }

    #[test]
    fn powershell_loads_integration_after_the_profile() {
        let dir = scripts("ps");
        let ps = shell(ShellKind::PowerShell, "powershell.exe", None);
        let with_script = launch(&ps, Some(&dir), None);
        assert_eq!(with_script.integration, Integration::Full);
        assert!(
            !with_script
                .args
                .iter()
                .any(|a| a.eq_ignore_ascii_case("-NoProfile")),
            "the profile must load"
        );
        assert_eq!(with_script.args[..3], ["-NoLogo", "-NoExit", "-Command"]);
        assert!(
            with_script.args[3].starts_with("try { . '")
                && with_script.args[3].contains("IntegrationError")
        );
        // Without the script: plain PowerShell, and the status bar says why.
        let plain = launch(&ps, Some(Path::new("Z:\\no-existe")), None);
        assert_eq!(plain.integration, Integration::Missing);
        assert_eq!(plain.args, ["-NoLogo"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn powershell_user_arguments_keep_the_integration_unless_they_take_over() {
        let dir = scripts("psargs");
        let with = |args: &[&str]| {
            launch(
                &shell(ShellKind::Pwsh, "pwsh.exe", Some(args)),
                Some(&dir),
                None,
            )
        };
        for args in [
            &["-NoProfile"][..],
            &["-NoProfile", "-ExecutionPolicy", "Bypass"],
            &["-nop", "-ep", "RemoteSigned", "-NoLogo"],
            &[],
        ] {
            let launched = with(args);
            assert_eq!(launched.integration, Integration::Full, "{args:?}");
            assert_eq!(launched.args[..args.len()], *args, "user arguments first");
            assert_eq!(launched.args[args.len()], "-NoExit");
        }
        for args in [
            &["-Command", "dir"][..],
            &["-c", "dir"],
            &["-File", "x.ps1"],
            &["-f", "x.ps1"],
            &["-NoExit"],
            &["-noe"],
            &["-e", "ZABpAHIA"],
            &["-EncodedCommand", "ZABpAHIA"],
            &["script.ps1"],
            &["-NoProfile", "script.ps1"],
        ] {
            let launched = with(args);
            assert_eq!(launched.integration, Integration::None, "{args:?}");
            assert_eq!(launched.args, *args, "exactly what the user asked for");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn git_bash_integration_only_with_the_default_arguments() {
        let dir = scripts("bash");
        let bash = launch(
            &shell(ShellKind::GitBash, "bash.exe", None),
            Some(&dir),
            None,
        );
        assert_eq!(bash.integration, Integration::Full);
        assert_eq!(bash.args[0], "--rcfile");
        assert!(
            bash.env
                .contains(&("CHERE_INVOKING".to_owned(), "1".to_owned()))
        );
        let own = launch(
            &shell(ShellKind::GitBash, "bash.exe", Some(&["--login", "-i"])),
            Some(&dir),
            None,
        );
        assert_eq!(own.integration, Integration::None);
        assert_eq!(own.args, ["--login", "-i"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cmd_reports_its_folder_in_front_of_the_users_prompt() {
        let cmd = launch(&shell(ShellKind::Cmd, "cmd.exe", None), None, None);
        assert_eq!(cmd.integration, Integration::Cwd);
        let prompt = cmd.env.iter().find(|(k, _)| k == "PROMPT").unwrap();
        assert!(prompt.1.starts_with("$e]9;9;$P$e\\"), "{}", prompt.1);
        let mut own = shell(ShellKind::Cmd, "cmd.exe", Some(&["/k", "echo hola"]));
        own.env = vec![("PROMPT".to_owned(), "[$T] $P$G".to_owned())];
        let own = launch(&own, None, None);
        let prompts: Vec<_> = own.env.iter().filter(|(k, _)| k == "PROMPT").collect();
        assert_eq!(
            prompts.len(),
            1,
            "the user's PROMPT is merged, not set twice"
        );
        assert_eq!(prompts[0].1, "$e]9;9;$P$e\\[$T] $P$G");
        assert_eq!(own.args, ["/k", "echo hola"]);
    }

    #[test]
    fn wsl_starts_in_the_folder_with_the_integration_launcher() {
        let dir = scripts("wsl");
        let mut wsl = shell(ShellKind::Wsl, r"C:\Windows\System32\wsl.exe", None);
        wsl.distro = Some("Ubuntu-24.04".to_owned());
        let launched = launch(&wsl, Some(&dir), Some(Path::new(r"C:\Users\Ana María")));
        assert_eq!(launched.integration, Integration::Full);
        assert_eq!(
            launched.args[..4],
            ["-d", "Ubuntu-24.04", "--cd", r"C:\Users\Ana María"]
        );
        assert_eq!(launched.args[4..7], ["-e", "sh", "-c"]);
        let rcfile = launched
            .env
            .iter()
            .find(|(k, _)| k == WSL_RCFILE_VAR)
            .unwrap();
        assert!(rcfile.1.ends_with("bash.sh"));
        assert!(
            launched
                .env
                .iter()
                .any(|(k, v)| k == "WSLENV" && v.ends_with("TERMINAL_WSL_RCFILE/p"))
        );
        // No folder: the Linux home. User arguments: as given, no integration.
        let mut own = wsl.clone();
        own.args = Some(vec!["-u".to_owned(), "root".to_owned()]);
        let own = launch(&own, Some(&dir), None);
        assert_eq!(own.args, ["-d", "Ubuntu-24.04", "--cd", "~", "-u", "root"]);
        assert_eq!(own.integration, Integration::None);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The launcher snippet is plain POSIX sh: run it with Git's sh standing in for the distro's.
    #[cfg(windows)]
    #[test]
    fn the_wsl_launcher_execs_bash_with_the_rcfile_or_explains_why_not() {
        let Some(git_bash) = find_git_bash() else {
            return;
        };
        let usr_bin = git_bash
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(r"usr\bin");
        let sh = usr_bin.join("sh.exe");
        let bash = usr_bin.join("bash.exe");
        if !sh.is_file() || !bash.is_file() {
            return;
        }
        let dir =
            std::env::temp_dir().join(format!("terminal wsl launcher {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("rc with spaces.sh");
        std::fs::write(&rc, "printf 'RCFILE-OK\\n'; exit 0\n").unwrap();
        let run = |shell: &str, rcfile: &Path| {
            let output = std::process::Command::new(&sh)
                .args(["-c", WSL_LAUNCHER])
                .env("SHELL", shell)
                .env(
                    WSL_RCFILE_VAR,
                    rcfile.display().to_string().replace('\\', "/"),
                )
                .env(
                    "PATH",
                    format!(
                        "{};{}",
                        usr_bin.display(),
                        env::var("PATH").unwrap_or_default()
                    ),
                )
                .stdin(std::process::Stdio::null())
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).into_owned()
        };
        let bash_path = "/usr/bin/bash";
        assert!(
            run(bash_path, &rc).contains("RCFILE-OK"),
            "bash runs the rcfile"
        );
        let missing = run(bash_path, &dir.join("nope.sh"));
        assert!(
            missing.contains("633;P;IntegrationError=no se encontr"),
            "{missing:?}"
        );
        // Another login shell: started as is (here `true`), with the reason reported.
        let other = run("/usr/bin/true", &rc);
        assert!(other.contains("IntegrationError=la integraci"), "{other:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn other_programs_run_as_given() {
        let mut node = shell(ShellKind::Other, r"C:\node\node.exe", Some(&["-i"]));
        node.env = vec![("FOO".to_owned(), "bar".to_owned())];
        let launched = launch(&node, Some(&scripts("other")), Some(Path::new(r"C:\x")));
        assert_eq!(launched.args, ["-i"]);
        assert_eq!(launched.integration, Integration::None);
        assert_eq!(launched.env, [("FOO".to_owned(), "bar".to_owned())]);
        assert_eq!(launched.cwd.as_deref(), Some(Path::new(r"C:\x")));
    }

    #[test]
    fn kinds_come_from_the_program_name() {
        assert_eq!(
            kind_of(Path::new(r"C:\x\PowerShell.exe")),
            ShellKind::PowerShell
        );
        assert_eq!(kind_of(Path::new("pwsh")), ShellKind::Pwsh);
        assert_eq!(
            kind_of(Path::new(r"C:\Windows\System32\cmd.exe")),
            ShellKind::Cmd
        );
        assert_eq!(
            kind_of(Path::new(r"C:\Windows\System32\wsl.exe")),
            ShellKind::Wsl
        );
        assert_eq!(
            kind_of(Path::new(r"C:\Program Files\Git\bin\bash.exe")),
            ShellKind::GitBash
        );
        assert_eq!(
            kind_of(Path::new(r"C:\msys64\usr\bin\bash.exe")),
            ShellKind::Other
        );
        assert_eq!(kind_of(Path::new("nu.exe")), ShellKind::Other);
    }

    #[test]
    fn specs_resolve_against_the_detected_shells() {
        let detected = vec![
            profile(
                "pwsh",
                ShellKind::Pwsh,
                "PowerShell",
                PathBuf::from(r"C:\ps7\pwsh.exe"),
            ),
            profile(
                "powershell",
                ShellKind::PowerShell,
                "Windows PowerShell",
                PathBuf::from(r"C:\ps5\powershell.exe"),
            ),
            ShellProfile {
                id: "wsl-Debian".to_owned(),
                kind: ShellKind::Wsl,
                name: "Debian".to_owned(),
                program: PathBuf::from("wsl.exe"),
                distro: Some("Debian".to_owned()),
            },
        ];
        // No spec: the default (first) one.
        assert_eq!(resolve(None, &detected).unwrap().kind, ShellKind::Pwsh);
        let by_kind = ShellSpec {
            kind: Some(ShellKind::PowerShell),
            ..Default::default()
        };
        assert_eq!(
            resolve(Some(&by_kind), &detected).unwrap().program,
            PathBuf::from(r"C:\ps5\powershell.exe")
        );
        let wsl = ShellSpec {
            kind: Some(ShellKind::Wsl),
            distro: Some("Debian".to_owned()),
            ..Default::default()
        };
        assert_eq!(
            resolve(Some(&wsl), &detected).unwrap().distro.as_deref(),
            Some("Debian")
        );
        // A kind that is not installed, without a program: nothing to start.
        let missing = ShellSpec {
            kind: Some(ShellKind::GitBash),
            ..Default::default()
        };
        assert!(resolve(Some(&missing), &detected).is_none());
        // A program: its kind comes from the name, variables are expanded.
        let custom = ShellSpec {
            program: Some(r"%SystemRoot%\System32\cmd.exe".to_owned()),
            env: BTreeMap::from([("WHERE".to_owned(), "%SystemRoot%".to_owned())]),
            ..Default::default()
        };
        let custom = resolve(Some(&custom), &detected).unwrap();
        assert_eq!(custom.kind, ShellKind::Cmd);
        assert!(!custom.program.to_string_lossy().contains('%'));
        assert!(!custom.env[0].1.contains('%'));
    }

    #[test]
    fn environment_variables_expand_like_windows_terminal() {
        // SAFETY: test-only variable, unique to this test.
        unsafe { env::set_var("TERMINAL_TEST_EXPAND", "valor") };
        assert_eq!(expand_env("%TERMINAL_TEST_EXPAND%\\x"), "valor\\x");
        assert_eq!(
            expand_env("a %TERMINAL_NO_EXISTE% b"),
            "a %TERMINAL_NO_EXISTE% b"
        );
        assert_eq!(expand_env("100% y %"), "100% y %");
        assert_eq!(expand_env("%%"), "%%");
        assert_eq!(expand_env("sin variables"), "sin variables");
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
        let dir = scripts("verbatim");
        // canonicalize() is what yields \\?\ paths (like Tauri's resource dir).
        let verbatim = dir.canonicalize().unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"));
        let ps = launch(
            &shell(ShellKind::PowerShell, "powershell.exe", None),
            Some(&verbatim),
            None,
        );
        assert!(
            ps.integration == Integration::Full && !ps.args[3].contains(r"\\?\"),
            "{}",
            ps.args[3]
        );
        let bash = launch(
            &shell(ShellKind::GitBash, "bash.exe", None),
            Some(&verbatim),
            None,
        );
        assert!(
            bash.integration == Integration::Full && !bash.args[1].starts_with("//?/"),
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
        // ~ and %VAR% (a profile's starting folder).
        assert_eq!(resolve_cwd(Some(Path::new("~"))), default_cwd());
        if cfg!(windows) {
            assert_eq!(resolve_cwd(Some(Path::new("%USERPROFILE%"))), default_cwd());
        }
    }
}
