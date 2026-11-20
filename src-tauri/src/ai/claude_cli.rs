//! The Claude Code CLI as a text-only completion backend, with the user's own login.
//!
//! `claude -p` runs with every flag that keeps it to answering text (documented in
//! code.claude.com/docs/en/cli-reference and verified against claude 2.1.329):
//! - `--tools ""`: no built-in tools at all (no Bash, no file reads or edits).
//! - `--permission-mode dontAsk`: anything that would need a permission is denied.
//! - `--safe-mode`: no CLAUDE.md (user or project), hooks, MCP servers, skills or plugins;
//!   login, model and permissions work as usual. (`--bare` would skip the subscription login.)
//! - `--setting-sources user`, `--strict-mcp-config`, `--disable-slash-commands`: nothing from
//!   any project; `--no-session-persistence`: nothing saved; `--max-turns 1`.
//! - The current folder is an empty one of Brisa's: no project around it.
//! - The prompt goes through stdin (no length limit on the command line, not visible in the
//!   process list); the system prompt through a file.
//!
//! The process tree runs in a Job Object: cancelling (or closing the app) kills it whole, also
//! through `claude.cmd` (npm installs) → node.

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::stream::{ClaudeStream, Item, classify_cli_exit};
use super::{AiConfig, AiEvent, AiRequest, CancelToken, Effort, ErrorCode, Failure, Role};
use crate::pty::{NESTED_SESSION_VARS, expand_env, find_on_path};

/// A request that runs longer than this is abandoned (the user can cancel before).
const TIMEOUT: Duration = Duration::from_secs(180);
const POLL: Duration = Duration::from_millis(100);
/// Kept from stderr, for the error message.
const STDERR_TAIL: usize = 8 * 1024;

/// Where `claude` is: `ai.claudePath` if set (never anything else then: a wrong path is an
/// error, not a reason to run another `claude`), the dev override, or this machine's install.
pub fn find_claude(custom: Option<&str>, dev_override: Option<&Path>) -> Result<PathBuf, Failure> {
    if let Some(custom) = custom.map(str::trim).filter(|c| !c.is_empty()) {
        let path = PathBuf::from(expand_env(custom));
        if path.is_file() {
            return Ok(path);
        }
        if !path.is_absolute()
            && let Some(found) = find_on_path(custom)
        {
            return Ok(found);
        }
        return Err(Failure::new(
            ErrorCode::NotInstalled,
            format!("No existe {} (ai.claudePath).", path.display()),
        ));
    }
    if let Some(path) = dev_override {
        return if path.is_file() {
            Ok(path.to_owned())
        } else {
            Err(Failure::new(
                ErrorCode::NotInstalled,
                format!("No existe {} (BRISA_CLAUDE_PATH).", path.display()),
            ))
        };
    }
    let home = std::env::var_os("USERPROFILE").map(PathBuf::from);
    let appdata = std::env::var_os("APPDATA").map(PathBuf::from);
    find_on_path("claude.exe")
        .or_else(|| find_on_path("claude.cmd"))
        .or_else(|| {
            [
                home.map(|h| h.join(r".local\bin\claude.exe")),
                appdata.map(|a| a.join(r"npm\claude.cmd")),
            ]
            .into_iter()
            .flatten()
            .find(|p| p.is_file())
        })
        .ok_or_else(|| {
            Failure::new(
                ErrorCode::NotInstalled,
                "No se encontró Claude Code (claude) en este equipo.",
            )
        })
}

/// The command line after `claude`.
pub fn args(model: &str, effort: Option<Effort>, system_file: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model",
        model,
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--safe-mode",
        "--setting-sources",
        "user",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
        "--max-turns",
        "1",
        "--system-prompt-file",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(system_file.as_os_str().to_owned());
    if let Some(effort) = effort {
        args.push("--effort".into());
        args.push(effort.as_str().into());
    }
    args
}

/// `claude` with a clean environment, no window, in Brisa's empty folder.
fn command(exe: &Path, args: &[OsString], work_dir: &Path) -> Command {
    let mut command = Command::new(exe);
    command.args(args).current_dir(work_dir);
    for var in NESTED_SESSION_VARS {
        command.env_remove(var);
    }
    // Nothing to remember from these one-off questions.
    command.env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// The running process tree: killed whole on cancel, timeout or drop.
struct Tree {
    child: Mutex<Child>,
    #[cfg(windows)]
    job: Option<crate::pty::job::Job>,
}

impl Tree {
    fn spawn(mut command: Command) -> std::io::Result<Arc<Self>> {
        let child = command.spawn()?;
        #[cfg(windows)]
        let job = {
            use std::os::windows::io::AsRawHandle;
            crate::pty::job::Job::kill_on_close()
                .and_then(|job| job.assign(child.as_raw_handle()).map(|()| job))
                .ok()
        };
        Ok(Arc::new(Self {
            child: Mutex::new(child),
            #[cfg(windows)]
            job,
        }))
    }

    fn kill(&self) {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            return;
        }
        let _ = self
            .child
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .kill();
    }

    fn try_wait(&self) -> Option<Option<i32>> {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            Ok(None) => None,
            Err(_) => Some(None),
        }
    }

    fn take_pipes(
        &self,
    ) -> (
        Option<std::process::ChildStdin>,
        Option<std::process::ChildStdout>,
        Option<std::process::ChildStderr>,
    ) {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        // Nothing of a request outlives it (the job's KILL_ON_JOB_CLOSE does the same).
        if self.try_wait().is_none() {
            self.kill();
        }
    }
}

/// Removes the system prompt file however the request ends.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn read_tail(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut tail: Vec<u8> = Vec::new();
        let mut buf = [0u8; 4096];
        while let Ok(n) = pipe.read(&mut buf) {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buf[..n]);
            if tail.len() > STDERR_TAIL {
                tail.drain(..tail.len() - STDERR_TAIL);
            }
        }
        String::from_utf8_lossy(&tail).into_owned()
    })
}

/// The user's text for stdin: the frontend sends one message for the CLI; a longer history
/// (never expected) is flattened rather than dropped.
fn prompt_of(request: &AiRequest) -> String {
    if let [only] = request.messages.as_slice() {
        return only.content.clone();
    }
    request
        .messages
        .iter()
        .map(|m| {
            let who = if m.role == Role::User {
                "Usuario"
            } else {
                "Asistente"
            };
            format!("{who}:\n{}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub fn run(
    config: &AiConfig,
    id: u32,
    request: &AiRequest,
    cancel: &CancelToken,
    emit: &dyn Fn(AiEvent),
) -> Result<(), Failure> {
    if !super::valid_model(&request.model) {
        return Err(Failure::new(
            ErrorCode::Invalid,
            format!("Modelo inválido: «{}».", request.model),
        ));
    }
    let exe = find_claude(
        request.claude_path.as_deref(),
        config.claude_override.as_deref(),
    )?;
    fs::create_dir_all(&config.work_dir).map_err(|e| {
        Failure::new(
            ErrorCode::Failed,
            format!("no se pudo crear {}: {e}", config.work_dir.display()),
        )
    })?;
    let system_file = TempFile(
        config
            .work_dir
            .join(format!("system-{}-{id}.txt", std::process::id())),
    );
    fs::write(&system_file.0, &request.system).map_err(|e| {
        Failure::new(
            ErrorCode::Failed,
            format!("no se pudo preparar la consulta: {e}"),
        )
    })?;

    let mut command = command(
        &exe,
        &args(&request.model, request.effort, &system_file.0),
        &config.work_dir,
    );
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cancel.is_cancelled() {
        return Ok(());
    }
    let tree = Tree::spawn(command).map_err(|e| {
        Failure::new(
            ErrorCode::NotInstalled,
            format!("No se pudo ejecutar {}: {e}", exe.display()),
        )
    })?;
    let killer = Arc::downgrade(&tree);
    cancel.on_cancel(move || {
        if let Some(tree) = killer.upgrade() {
            tree.kill();
        }
    });

    let (stdin, stdout, stderr) = tree.take_pipes();
    let prompt = prompt_of(request);
    if let Some(mut stdin) = stdin {
        // A large prompt fills the pipe before claude reads it: write from another thread.
        thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    let stderr = stderr.map(read_tail);
    let (tx, rx) = mpsc::channel::<String>();
    if let Some(stdout) = stdout {
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
    }

    let deadline = Instant::now() + TIMEOUT;
    let mut parser = ClaudeStream::default();
    let mut outcome: Option<Result<(), Failure>> = None;
    let mut timed_out = false;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(line) => {
                for item in parser.line(&line) {
                    match item {
                        Item::Delta(text) => emit(AiEvent::Delta { text }),
                        Item::Status(message) => emit(AiEvent::Status { message }),
                        Item::Finished(result) => outcome = Some(result),
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if Instant::now() > deadline && !timed_out {
                    timed_out = true;
                    tree.kill();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // stdout closed: the process is exiting (or a grandchild kept the pipe; the job ends it).
    let exit_deadline = Instant::now() + Duration::from_secs(5);
    let exit_code = loop {
        if let Some(code) = tree.try_wait() {
            break code;
        }
        if Instant::now() > exit_deadline {
            tree.kill();
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stderr = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
    if cancel.is_cancelled() {
        return Ok(());
    }
    if timed_out {
        return Err(Failure::new(
            ErrorCode::Timeout,
            format!("Claude Code no terminó en {} s.", TIMEOUT.as_secs()),
        ));
    }
    outcome.unwrap_or_else(|| Err(classify_cli_exit(&stderr, exit_code)))
}

/// What the settings screen shows about the CLI ("Verificar").
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub path: String,
    pub version: Option<String>,
    /// `claude auth status --json` (local: no request to any model).
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
}

/// Runs `claude <args>` to completion (or kills it after `timeout`): (exit code, stdout).
fn capture(
    exe: &Path,
    args: &[&str],
    work_dir: &Path,
    timeout: Duration,
) -> Option<(Option<i32>, String)> {
    let args: Vec<OsString> = args.iter().map(OsString::from).collect();
    let mut command = command(exe, &args, work_dir);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let tree = Tree::spawn(command).ok()?;
    let (_, stdout, _) = tree.take_pipes();
    let out = read_tail(stdout?);
    let deadline = Instant::now() + timeout;
    let code = loop {
        if let Some(code) = tree.try_wait() {
            break code;
        }
        if Instant::now() > deadline {
            tree.kill();
            return None;
        }
        thread::sleep(Duration::from_millis(30));
    };
    Some((code, out.join().unwrap_or_default()))
}

pub fn status(config: &AiConfig, custom: Option<&str>) -> Result<ClaudeStatus, Failure> {
    let exe = find_claude(custom, config.claude_override.as_deref())?;
    let _ = fs::create_dir_all(&config.work_dir);
    let version = capture(
        &exe,
        &["--version"],
        &config.work_dir,
        Duration::from_secs(15),
    )
    .and_then(|(code, out)| (code == Some(0)).then(|| out.trim().to_owned()))
    .filter(|v| !v.is_empty());
    let auth = capture(
        &exe,
        &["auth", "status", "--json"],
        &config.work_dir,
        Duration::from_secs(20),
    )
    .and_then(|(_, out)| serde_json::from_str::<serde_json::Value>(out.trim()).ok());
    Ok(ClaudeStatus {
        path: exe.display().to_string(),
        version,
        logged_in: auth.as_ref().and_then(|a| a["loggedIn"].as_bool()),
        auth_method: auth
            .as_ref()
            .and_then(|a| a["authMethod"].as_str().map(str::to_owned)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_isolation_flag_is_on_the_command_line() {
        let args: Vec<String> = args("opus", Some(Effort::Low), Path::new(r"C:\t\system.txt"))
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let pair = |flag: &str, value: &str| args.windows(2).any(|w| w[0] == flag && w[1] == value);
        assert_eq!(args[0], "-p");
        assert!(pair("--output-format", "stream-json"));
        assert!(args.contains(&"--verbose".to_owned()));
        assert!(args.contains(&"--include-partial-messages".to_owned()));
        assert!(pair("--model", "opus"));
        assert!(pair("--tools", ""), "no tools at all");
        assert!(pair("--permission-mode", "dontAsk"));
        assert!(
            args.contains(&"--safe-mode".to_owned()),
            "no CLAUDE.md, hooks, MCP, skills"
        );
        assert!(pair("--setting-sources", "user"));
        assert!(args.contains(&"--strict-mcp-config".to_owned()));
        assert!(args.contains(&"--disable-slash-commands".to_owned()));
        assert!(args.contains(&"--no-session-persistence".to_owned()));
        assert!(pair("--max-turns", "1"));
        assert!(pair("--system-prompt-file", r"C:\t\system.txt"));
        assert!(pair("--effort", "low"));
        assert!(
            !args
                .iter()
                .any(|a| a.contains("dangerously") || a == "bypassPermissions")
        );
    }

    #[test]
    fn a_configured_path_that_does_not_exist_never_falls_back() {
        let missing = find_claude(Some(r"C:\no\existe\claude.exe"), None).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotInstalled);
        assert!(missing.message.contains("ai.claudePath"));
        let missing = find_claude(None, Some(Path::new(r"C:\no\existe\fake.cmd"))).unwrap_err();
        assert!(missing.message.contains("BRISA_CLAUDE_PATH"));
    }
}
