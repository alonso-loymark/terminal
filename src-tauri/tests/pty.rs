//! Integration tests against real PowerShell processes running in ConPTY.
#![cfg(windows)]

use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use terminal_lib::pty::{PtyManager, SessionEvents, SessionId, SpawnOptions, default_shell};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const TIMEOUT: Duration = Duration::from_secs(20);
const CURSOR_POSITION_REQUEST: &str = "\x1b[6n";

enum Event {
    Output(Vec<u8>),
    Exit(Option<u32>),
}

struct ChannelEvents(Sender<Event>);

impl SessionEvents for ChannelEvents {
    fn output(&self, data: Vec<u8>) {
        let _ = self.0.send(Event::Output(data));
    }
    fn exit(&self, exit_code: Option<u32>) {
        let _ = self.0.send(Event::Exit(exit_code));
    }
}

/// Drives one shell session the way the frontend would, answering ConPTY's cursor query.
struct Shell {
    manager: PtyManager,
    id: SessionId,
    events: Receiver<Event>,
    output: String,
    exit: Option<Option<u32>>,
    output_after_exit: bool,
}

impl Shell {
    fn spawn(manager: &PtyManager, owner: &str) -> Self {
        let (tx, rx) = mpsc::channel();
        let shell = default_shell();
        let mut args = shell.args;
        args.push("-NoProfile".into());
        let options = SpawnOptions {
            program: shell.program,
            args,
            cwd: None,
            env: vec![],
            cols: 120,
            rows: 30,
        };
        let id = manager
            .create(owner, options, ChannelEvents(tx))
            .expect("spawn shell");
        let mut shell = Shell {
            manager: manager.clone(),
            id,
            events: rx,
            output: String::new(),
            exit: None,
            output_after_exit: false,
        };
        // Do not type before PowerShell is ready to read input.
        shell.run("'ready' + '-prompt'", "ready-prompt");
        shell
    }

    fn send(&self, text: &str) {
        self.manager
            .write(self.id, text.as_bytes().to_vec())
            .expect("write");
    }

    /// Types `command`, presses Enter and waits until `expected` shows up in the output.
    fn run(&mut self, command: &str, expected: &str) {
        let start = self.output.len();
        self.send(&format!("{command}\r"));
        self.wait_for(start, expected);
    }

    /// Waits until `needle` appears in the output produced after byte offset `from`.
    fn wait_for(&mut self, from: usize, needle: &str) -> usize {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(pos) = self.output[from..].find(needle) {
                return from + pos;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(
                self.pump(left),
                "timed out waiting for {needle:?}; output so far:\n{}",
                self.output
            );
        }
    }

    fn wait_exit(&mut self) -> Option<u32> {
        let deadline = Instant::now() + TIMEOUT;
        while self.exit.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(self.pump(left), "timed out waiting for exit");
        }
        // Nothing may arrive after the exit notice.
        while self.pump(Duration::from_millis(200)) {}
        assert!(
            !self.output_after_exit,
            "output arrived after the exit notice"
        );
        self.exit.flatten()
    }

    /// Processes one event. Returns false on timeout or when the session channel is gone.
    fn pump(&mut self, timeout: Duration) -> bool {
        match self.events.recv_timeout(timeout) {
            Ok(Event::Output(data)) => {
                self.output_after_exit |= self.exit.is_some();
                let text = String::from_utf8_lossy(&data);
                // ConPTY renders nothing until the terminal reports the cursor position.
                if text.contains(CURSOR_POSITION_REQUEST) {
                    let _ = self.manager.write(self.id, b"\x1b[1;1R".to_vec());
                }
                self.output.push_str(&text);
                true
            }
            Ok(Event::Exit(code)) => {
                self.exit = Some(code);
                true
            }
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => false,
        }
    }

    fn pid(&self) -> u32 {
        self.manager.pid(self.id).expect("shell pid")
    }
}

/// True once the process with `pid` has exited (or no longer exists).
fn process_exited_within(pid: u32, timeout: Duration) -> bool {
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return true;
        }
        let exited = WaitForSingleObject(handle, timeout.as_millis() as u32) == WAIT_OBJECT_0;
        CloseHandle(handle);
        exited
    }
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    condition()
}

/// Parses the digits that follow the last `prefix` in `output`.
fn number_after(output: &str, prefix: &str) -> u32 {
    let start = output.rfind(prefix).expect("prefix") + prefix.len();
    output[start..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .expect("number")
}

/// Parameters of the last SGR sequence (`ESC[...m`) in `text`.
fn last_sgr_params(text: &str) -> Vec<&str> {
    let Some(start) = text.rfind("\x1b[") else {
        return vec![];
    };
    let body = &text[start + 2..];
    body.find('m')
        .map(|end| body[..end].split(';').collect())
        .unwrap_or_default()
}

#[test]
fn runs_commands_and_streams_output() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    // The expected text only exists in the command's output, not in the echoed input.
    shell.run("'hola' + '-' + 'mundo'", "hola-mundo");
    manager.close(shell.id).unwrap();
}

#[test]
fn passes_ansi_and_truecolor_through() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");

    let from = shell.output.len();
    shell.send("Write-Host -ForegroundColor Red ('ro' + 'jo')\r");
    let at = shell.wait_for(from, "rojo");
    let params = last_sgr_params(&shell.output[from..at]);
    // ConPTY may use the 16-color form (91) or the indexed form (38;5;9) for bright red.
    let red = params.iter().any(|p| *p == "91" || *p == "31")
        || matches!(params.as_slice(), [.., "38", "5", "9" | "1"]);
    assert!(red, "no red SGR before the text: {params:?}");

    // ConPTY may place the SGR before the line break instead of right before the text, so
    // check the attribute in effect rather than exact adjacency.
    let from = shell.output.len();
    shell
        .send("Write-Output ([char]27 + '[38;2;255;100;0m' + 'nar' + 'anja' + [char]27 + '[0m')\r");
    let at = shell.wait_for(from, "naranja");
    let params = last_sgr_params(&shell.output[from..at]);
    assert_eq!(
        params,
        ["38", "2", "255", "100", "0"],
        "truecolor not passed through"
    );
    manager.close(shell.id).unwrap();
}

#[test]
fn ctrl_c_interrupts_the_foreground_program() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");

    let from = shell.output.len();
    shell.send("ping -t 127.0.0.1\r");
    let pinging = shell.wait_for(from, "TTL=");
    shell.send("\x03");
    // Only a stopped ping gives the prompt back. (Typing ahead right after ^C is not a valid
    // check: the shell discards pending input when it regains the console.)
    shell.wait_for(pinging, "PS ");
    shell.run("'after' + '-ctrl-c'", "after-ctrl-c");
    manager.close(shell.id).unwrap();
}

#[test]
fn resize_reaches_the_console() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    manager.resize(shell.id, 100, 40).unwrap();
    shell.run(
        "'size=' + [Console]::WindowWidth + 'x' + [Console]::WindowHeight",
        "size=100x40",
    );
    manager.close(shell.id).unwrap();
}

#[test]
fn natural_exit_reports_code_and_releases_the_session() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    let pid = shell.pid();
    shell.send("exit 7\r");
    assert_eq!(shell.wait_exit(), Some(7));
    assert!(process_exited_within(pid, Duration::from_secs(5)));
    assert!(
        wait_until(Duration::from_secs(5), || manager.is_empty()),
        "session not released"
    );
}

#[test]
fn close_kills_the_whole_process_tree() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    let shell_pid = shell.pid();

    // A grandchild in its own hidden console: closing the pseudoconsole alone would not
    // reach it, only the job object does.
    let from = shell.output.len();
    shell.send(
        "$p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru; 'child=' + $p.Id + (':do' + 'ne')\r",
    );
    let end = shell.wait_for(from, ":done");
    // The echoed command also contains "child=", so take the last one before the marker.
    let child_pid = number_after(&shell.output[from..end], "child=");
    assert!(
        !process_exited_within(child_pid, Duration::ZERO),
        "grandchild should be running"
    );

    manager.close(shell.id).unwrap();
    assert!(manager.is_empty());
    assert!(
        process_exited_within(shell_pid, Duration::from_secs(5)),
        "shell survived"
    );
    assert!(
        process_exited_within(child_pid, Duration::from_secs(5)),
        "grandchild survived"
    );
    shell.wait_exit();
}

#[test]
fn closing_an_owner_only_closes_its_sessions_and_shutdown_closes_the_rest() {
    let manager = PtyManager::new();
    let window_a = Shell::spawn(&manager, "window-a");
    let window_b = Shell::spawn(&manager, "window-b");
    let (pid_a, pid_b) = (window_a.pid(), window_b.pid());

    assert_eq!(manager.close_owned_by("window-a"), 1);
    assert!(process_exited_within(pid_a, Duration::from_secs(5)));
    assert!(
        !process_exited_within(pid_b, Duration::ZERO),
        "other owner's shell was killed"
    );
    assert_eq!(manager.len(), 1);

    manager.shutdown();
    assert!(manager.is_empty());
    assert!(process_exited_within(pid_b, Duration::from_secs(5)));
}

#[test]
fn unknown_sessions_are_errors() {
    let manager = PtyManager::new();
    assert!(manager.write(999, b"x".to_vec()).is_err());
    assert!(manager.resize(999, 80, 24).is_err());
    assert!(manager.close(999).is_err());
}
