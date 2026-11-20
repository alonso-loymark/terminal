//! Running a CLI (`claude`) as a child process: clean environment, no window, the whole tree in
//! a Job Object (cancelling or closing the app kills it, also through `claude.cmd` → node), and
//! stdout read line by line. Shared by the AI layer (`claude -p` text answers) and the agent
//! adapters of the orchestrator (`claude -p` workers).

use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use crate::pty::NESTED_SESSION_VARS;

/// Kept from stderr, for the error message.
pub const STDERR_TAIL: usize = 8 * 1024;

/// `exe args` with a clean environment (no variables of a Claude Code session around Brisa),
/// no window, in `work_dir`.
pub fn command(exe: &Path, args: &[OsString], work_dir: &Path) -> Command {
    let mut command = Command::new(exe);
    command.args(args).current_dir(work_dir);
    for var in NESTED_SESSION_VARS {
        command.env_remove(var);
    }
    // Brisa owns what is remembered: nothing written to Claude Code's auto memory.
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
pub struct Tree {
    child: Mutex<Child>,
    #[cfg(windows)]
    job: Option<crate::pty::job::Job>,
}

impl Tree {
    pub fn spawn(mut command: Command) -> std::io::Result<Arc<Self>> {
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

    pub fn kill(&self) {
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

    /// `Some(code)` once it exited (`Some(None)`: no code or no way to know).
    pub fn try_wait(&self) -> Option<Option<i32>> {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code()),
            Ok(None) => None,
            Err(_) => Some(None),
        }
    }

    pub fn take_pipes(&self) -> (Option<ChildStdin>, Option<ChildStdout>, Option<ChildStderr>) {
        let mut child = self.child.lock().unwrap_or_else(PoisonError::into_inner);
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    }

    /// After stdout closed: the exit code, killing the tree if it does not exit in `grace` (a
    /// grandchild that kept the pipe; the job ends it).
    pub fn wait_exit(&self, grace: Duration) -> Option<i32> {
        let deadline = Instant::now() + grace;
        loop {
            if let Some(code) = self.try_wait() {
                return code;
            }
            if Instant::now() > deadline {
                self.kill();
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
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

/// Removes a temporary file however the request ends.
pub struct TempFile(pub PathBuf);

impl TempFile {
    pub fn write(path: PathBuf, text: &str) -> std::io::Result<Self> {
        fs::write(&path, text)?;
        Ok(Self(path))
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// The last `STDERR_TAIL` bytes of a pipe, read on its own thread.
pub fn read_tail(mut pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
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

/// Lines of stdout, on a channel (disconnected when stdout closes).
pub fn read_lines(stdout: ChildStdout) -> Receiver<String> {
    let (tx, rx) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

/// Writes `text` to stdin from another thread (a large prompt fills the pipe before the child
/// reads it), then closes it.
pub fn feed(stdin: Option<ChildStdin>, text: String) {
    if let Some(mut stdin) = stdin {
        thread::spawn(move || {
            let _ = stdin.write_all(text.as_bytes());
        });
    }
}

/// Runs `exe args` to completion (or kills it after `timeout`): (exit code, stdout).
pub fn capture(
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
