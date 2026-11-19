//! Integration tests against real PowerShell processes running in ConPTY.
//!
//! Rule: no test ever sends input to a real AI agent (claude, codex, gemini). Agent behavior is
//! exercised with `e2e/fake-agent.mjs` run through a node.exe linked under the agent's name.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};

use terminal_lib::pty::{
    Integration, PtyManager, SessionEvents, SessionId, ShellKind, ShellSpec, ShiftEnterTarget,
    SpawnOptions, available_shells, default_shell, find_on_path, launch, resolve, shell_profile,
};
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
};

const FAKE_AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../e2e/fake-agent.mjs");
const SINK: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../e2e/sink.mjs");
const INTEGRATION_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/shell-integration");
const CHARMAP: &str = r"C:\Windows\System32\charmap.exe";

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
        // Do not type before PowerShell is ready to read input, and let the next prompt finish
        // drawing so that tests counting prompts start from a clean slate.
        shell.run("'ready' + '-prompt'", "ready-prompt");
        let ready = shell.output.rfind("ready-prompt").expect("marker");
        shell.wait_for(ready, "PS ");
        while shell.pump(Duration::from_millis(150)) {}
        shell
    }

    /// Starts any command line and waits for `ready` in its output.
    fn start(manager: &PtyManager, options: SpawnOptions, ready: &str) -> Self {
        let (tx, rx) = mpsc::channel();
        let id = manager
            .create("test", options, ChannelEvents(tx))
            .expect("spawn shell");
        let mut shell = Shell {
            manager: manager.clone(),
            id,
            events: rx,
            output: String::new(),
            exit: None,
            output_after_exit: false,
        };
        shell.wait_for(0, ready);
        while shell.pump(Duration::from_millis(150)) {}
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

fn kill_process(pid: u32) {
    // SAFETY: plain Win32 calls; the handle is closed before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if !handle.is_null() {
            TerminateProcess(handle, 1);
            CloseHandle(handle);
        }
    }
}

/// Comma-separated numbers between `prefix` and the end marker, from the last occurrence.
fn numbers_after(output: &str, prefix: &str) -> Vec<u32> {
    let start = output.rfind(prefix).expect("prefix") + prefix.len();
    output[start..]
        .split(|c: char| !(c.is_ascii_digit() || c == ','))
        .next()
        .unwrap_or_default()
        .split(',')
        .map(|n| n.parse().expect("number"))
        .collect()
}

/// node.exe linked as `<name>.exe`, so the fake agent looks like the real agent to the
/// terminal's process detection. `None` when node is not installed.
fn fake_agent_exe(dir: &Path, name: &str) -> Option<PathBuf> {
    let node = find_on_path("node.exe")?;
    fs::create_dir_all(dir).ok()?;
    let exe = dir.join(format!("{name}.exe"));
    if !exe.exists() && fs::hard_link(&node, &exe).is_err() {
        fs::copy(&node, &exe).ok()?;
    }
    Some(exe)
}

#[test]
fn close_spares_windowed_apps_and_kills_console_processes() {
    if !Path::new(CHARMAP).exists() {
        eprintln!("skipped: {CHARMAP} not found");
        return;
    }
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    let shell_pid = shell.pid();

    // charmap is a classic Win32 app (not a packaged one), so it really is the shell's child.
    // Hidden, it stands in for windowless GUI processes such as headless browsers.
    let from = shell.output.len();
    shell.send(concat!(
        "$v = Start-Process charmap -PassThru; ",
        "$h = Start-Process charmap -WindowStyle Hidden -PassThru; ",
        "$c = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru; ",
        "$n = 0; while ((Get-Process -Id $v.Id).MainWindowHandle -eq 0 -and $n -lt 100) { Start-Sleep -Milliseconds 100; $n++ }; ",
        "'ids=' + $v.Id + ',' + $h.Id + ',' + $c.Id + (':do' + 'ne')\r"
    ));
    let end = shell.wait_for(from, ":done");
    let ids = numbers_after(&shell.output[from..end], "ids=");
    let (visible, hidden, console) = (ids[0], ids[1], ids[2]);
    for pid in [visible, hidden, console] {
        assert!(
            !process_exited_within(pid, Duration::ZERO),
            "{pid} should be running"
        );
    }

    manager.close(shell.id).unwrap();
    let console_side_dead = [shell_pid, hidden, console]
        .into_iter()
        .all(|pid| process_exited_within(pid, Duration::from_secs(5)));
    let app_alive = !process_exited_within(visible, Duration::from_secs(1));
    kill_process(visible);
    assert!(
        console_side_dead,
        "shell, hidden GUI process or console grandchild survived"
    );
    assert!(app_alive, "the app with a visible window was killed");
    shell.wait_exit();
}

#[test]
fn shift_enter_adds_a_line_in_powershell() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    let from = shell.output.len();
    shell.send("'uno'");
    let target = manager.shift_enter(shell.id).unwrap();
    assert_eq!(target, ShiftEnterTarget::Native);
    shell.send("'dos'\r");
    shell.wait_for(from, "PS ");
    while shell.pump(Duration::from_millis(500)) {}
    let tail = &shell.output[from..];
    // PSReadLine AddLine: a continuation prompt and both lines run as one input (one new
    // prompt). A plain Enter would have run 'uno' alone and shown two prompts.
    assert!(tail.contains(">>"), "no continuation prompt: {tail:?}");
    assert_eq!(
        tail.matches("PS ").count(),
        1,
        "ran as two inputs: {tail:?}"
    );
    assert!(tail.contains("uno") && tail.contains("dos"));
    manager.close(shell.id).unwrap();
}

#[test]
fn shift_enter_inserts_each_agents_own_newline() {
    let dir = std::env::temp_dir().join(format!("terminal-tests-agents-{}", std::process::id()));
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    for agent in ["claude", "gemini"] {
        let Some(exe) = fake_agent_exe(&dir, agent) else {
            eprintln!("skipped: node.exe not found");
            return;
        };
        let from = shell.output.len();
        shell.send(&format!("& '{}' '{}'\r", exe.display(), FAKE_AGENT));
        shell.wait_for(from, &format!("FAKE-AGENT {agent} listo"));

        let from = shell.output.len();
        shell.send("hola");
        assert_eq!(
            manager.shift_enter(shell.id).unwrap(),
            ShiftEnterTarget::Agent {
                agent: if agent == "claude" {
                    "claude"
                } else {
                    "gemini"
                }
            }
        );
        shell.send("mundo\r");
        shell.wait_for(from, r#"SUBMIT "hola\nmundo""#);

        let from = shell.output.len();
        shell.send("\x03");
        shell.wait_for(from, "Press Ctrl-C again");
        shell.send("\x03");
        shell.wait_for(from, "bye");
        shell.run("'back' + '-in-ps'", "back-in-ps");
    }
    manager.close(shell.id).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn shift_enter_is_native_for_programs_that_are_not_agents() {
    let Some(node) = find_on_path("node.exe") else {
        eprintln!("skipped: node.exe not found");
        return;
    };
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    // Same TUI, but under plain node.exe with an unknown script path: not an agent.
    let from = shell.output.len();
    shell.send(&format!("& '{}' '{}' claude\r", node.display(), FAKE_AGENT));
    shell.wait_for(from, "FAKE-AGENT claude listo");
    let from = shell.output.len();
    shell.send("hola");
    assert_eq!(
        manager.shift_enter(shell.id).unwrap(),
        ShiftEnterTarget::Native
    );
    // A real Shift+Enter reaches a raw-mode console app as CR: it submits, like in Windows Terminal.
    shell.wait_for(from, r#"SUBMIT "hola""#);
    manager.close(shell.id).unwrap();
}

#[test]
fn busy_lists_what_closing_would_kill_but_not_windowed_apps() {
    let manager = PtyManager::new();
    let mut shell = Shell::spawn(&manager, "test");
    assert!(
        manager.busy_processes(shell.id).unwrap().is_empty(),
        "an idle shell is not busy"
    );

    let from = shell.output.len();
    shell.send("ping -n 60 127.0.0.1\r");
    let pinging = shell.wait_for(from, "TTL=");
    let busy = manager.busy_processes(shell.id).unwrap();
    assert!(
        busy.iter().any(|p| p.name.eq_ignore_ascii_case("ping.exe")),
        "{busy:?}"
    );
    assert!(
        !busy
            .iter()
            .any(|p| p.name.eq_ignore_ascii_case("conhost.exe")),
        "{busy:?}"
    );
    shell.send("\x03");
    shell.wait_for(pinging, "PS ");
    assert!(
        wait_until(Duration::from_secs(5), || manager
            .busy_processes(shell.id)
            .unwrap()
            .is_empty()),
        "still busy after ping ended"
    );

    if Path::new(CHARMAP).exists() {
        // A windowed app survives closing the tab, so it must not trigger a confirmation.
        let from = shell.output.len();
        shell.send(concat!(
            "$v = Start-Process charmap -PassThru; ",
            "$n = 0; while ((Get-Process -Id $v.Id).MainWindowHandle -eq 0 -and $n -lt 100) { Start-Sleep -Milliseconds 100; $n++ }; ",
            "'ids=' + $v.Id + (':do' + 'ne')\r"
        ));
        let end = shell.wait_for(from, ":done");
        let app = numbers_after(&shell.output[from..end], "ids=")[0];
        let busy = manager.busy_processes(shell.id).unwrap();
        kill_process(app);
        assert!(busy.is_empty(), "a windowed app counted as busy: {busy:?}");
    }
    manager.close(shell.id).unwrap();
}

// ---------------------------------------------------------------- shell integration

/// A fresh directory with spaces, accents and ñ in its path (long form, no 8.3 names).
fn tricky_dir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir().join(format!("terminal it {tag} {}", std::process::id()));
    let dir = base.join("carpeta con espacios").join("Ñandú áéíóú");
    fs::create_dir_all(&dir).unwrap();
    let long = fs::canonicalize(&dir).unwrap();
    PathBuf::from(long.display().to_string().trim_start_matches(r"\\?\"))
}

/// What OSC 7 must carry for `path`: file://<host>/<drive>/<percent-encoded UTF-8 segments>.
fn file_uri(path: &Path) -> String {
    let host = std::env::var("COMPUTERNAME").unwrap();
    let segments: Vec<String> = path
        .display()
        .to_string()
        .split('\\')
        .map(|segment| {
            if segment.len() == 2 && segment.ends_with(':') {
                return segment.to_owned();
            }
            segment
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect()
        })
        .collect();
    format!("file://{host}/{}", segments.join("/"))
}

/// What the app would spawn for a profile (as the frontend sends it) in `cwd`.
fn launched(
    spec: ShellSpec,
    cwd: &Path,
    env: Vec<(String, String)>,
) -> Option<(SpawnOptions, Integration)> {
    let shell = resolve(Some(&spec), &available_shells())?;
    let launch = launch(&shell, Some(Path::new(INTEGRATION_DIR)), Some(cwd));
    let mut all_env = launch.env;
    all_env.extend(env);
    Some((
        SpawnOptions {
            program: launch.program,
            args: launch.args,
            cwd: launch.cwd,
            env: all_env,
            cols: 140,
            rows: 30,
        },
        launch.integration,
    ))
}

fn kind(kind: ShellKind) -> ShellSpec {
    ShellSpec {
        kind: Some(kind),
        ..Default::default()
    }
}

fn integrated(kind_: ShellKind, cwd: &Path, env: Vec<(String, String)>) -> Option<SpawnOptions> {
    let (options, integration) = launched(kind(kind_), cwd, env)?;
    assert_eq!(
        integration,
        Integration::Full,
        "integration script not found in {INTEGRATION_DIR}"
    );
    Some(options)
}

#[test]
fn powershell_integration_reports_cwd_commands_and_exit_codes() {
    let dir = tricky_dir("ps");
    let manager = PtyManager::new();
    let options = integrated(ShellKind::PowerShell, &dir, vec![]).unwrap();
    let mut shell = Shell::start(&manager, options, "\x1b]133;B\x07");
    assert!(
        shell.output.contains("\x1b]633;P;Shell=powershell\x07"),
        "loaded mark"
    );
    assert!(
        shell
            .output
            .contains(&format!("\x1b]7;{}\x07", file_uri(&dir))),
        "OSC 7 with spaces, accents and ñ:\n{:?}",
        shell.output
    );
    assert!(shell.output.contains("\x1b]133;A\x07"));

    let commands = [
        ("'uno'", "\x1b]133;D;0\x07"),
        ("cmd /c exit 7", "\x1b]133;D;7\x07"),
        (r"Get-Item C:\no-existe-terminal-test", "\x1b]133;D;1\x07"),
        ("'a;b'", "\x1b]133;D;0\x07"),
    ];
    for (command, done) in commands {
        let from = shell.output.len();
        shell.send(&format!("{command}\r"));
        let at = shell.wait_for(from, done);
        let tail = &shell.output[from..at];
        assert!(tail.contains("\x1b]133;C\x07"), "{command}: no C mark");
        let escaped = command.replace('\\', "\\\\").replace(';', "\\x3b");
        assert!(
            tail.contains(&format!("\x1b]633;E;{escaped}\x07")),
            "{command}: command line not reported: {tail:?}"
        );
        shell.wait_for(at, "\x1b]133;B\x07");
    }

    // The user redefines the prompt: it keeps its text and the integration re-wraps it.
    let from = shell.output.len();
    shell.send("function global:prompt { 'CUSTOM> ' }\r");
    shell.wait_for(from, "CUSTOM> ");
    let from = shell.output.len();
    shell.send("'despues'\r");
    let at = shell.wait_for(from, "\x1b]133;D;0\x07");
    let prompt = shell.wait_for(at, "CUSTOM> ");
    assert!(
        shell.output[at..prompt].contains("\x1b]133;A\x07"),
        "prompt not re-wrapped"
    );
    shell.wait_for(prompt, "\x1b]133;B\x07");

    // A prompt that depends on $? (like oh-my-posh) still sees the real status.
    let from = shell.output.len();
    shell.send("function global:prompt { if ($?) { 'BIEN> ' } else { 'MAL> ' } }\r");
    shell.wait_for(from, "BIEN> ");
    let from = shell.output.len();
    shell.send("Get-Item C:\\no-existe-terminal-test\r");
    shell.wait_for(from, "MAL> ");
    let from = shell.output.len();
    shell.send("'ok'\r");
    shell.wait_for(from, "BIEN> ");

    // PSReadLine 2.2+ (pwsh 7) reads $? first thing in PSConsoleHostReadLine, to color the
    // prompt after an error. One built like that must still see the failure through our wrapper.
    let from = shell.output.len();
    shell.send(concat!(
        "function global:PSConsoleHostReadLine { $global:rlStatus = $?; ",
        "[Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($host.Runspace, $ExecutionContext) }\r"
    ));
    shell.wait_for(from, "BIEN> ");
    let from = shell.output.len();
    shell.send("Get-Item C:\\no-existe-terminal-test\r");
    shell.wait_for(from, "MAL> ");
    let from = shell.output.len();
    shell.send("'rl=' + $global:rlStatus + (';' + 'end')\r");
    shell.wait_for(from, "rl=False;end");
    let from = shell.output.len();
    shell.send("'rl=' + $global:rlStatus + (';' + 'end')\r");
    shell.wait_for(from, "rl=True;end");

    // Moving reports the new directory.
    let parent = dir.parent().unwrap().to_owned();
    let from = shell.output.len();
    shell.send(&format!(
        "Set-Location -LiteralPath '{}'\r",
        parent.display()
    ));
    shell.wait_for(from, &format!("\x1b]7;{}\x07", file_uri(&parent)));
    manager.close(shell.id).unwrap();
}

#[test]
fn powershell_integration_failure_is_reported_and_harmless() {
    // A Restricted execution policy (process scope) forbids the script: the terminal must say
    // so and the shell must keep working.
    let dir = tricky_dir("policy");
    let manager = PtyManager::new();
    let env = vec![(
        "PSExecutionPolicyPreference".to_owned(),
        "Restricted".to_owned(),
    )];
    let options = integrated(ShellKind::PowerShell, &dir, env).unwrap();
    let mut shell = Shell::start(&manager, options, "\x1b]633;P;IntegrationError=");
    assert!(
        !shell.output.contains("633;P;Shell="),
        "integration must not report success"
    );
    shell.wait_for(0, "PS ");
    shell.run("'sigue-' + 'viva'", "sigue-viva");
    manager.close(shell.id).unwrap();
}

#[test]
fn git_bash_integration_loads_the_users_profile_and_reports_commands() {
    if shell_profile(ShellKind::GitBash).is_none() {
        eprintln!("skipped: Git Bash not found");
        return;
    }
    let dir = tricky_dir("bash");
    // A throwaway HOME with its own profile: proves the user's startup files still load.
    let home = dir.parent().unwrap().join("home");
    fs::create_dir_all(&home).unwrap();
    fs::write(
        home.join(".bash_profile"),
        "alias saludo='echo hola-desde-perfil'\nPS1='CUSTOMBASH$ '\n",
    )
    .unwrap();
    let manager = PtyManager::new();
    let env = vec![("HOME".to_owned(), home.display().to_string())];
    let options = integrated(ShellKind::GitBash, &dir, env).unwrap();
    let mut shell = Shell::start(&manager, options, "\x1b]133;B\x07");
    assert!(
        shell.output.contains("\x1b]633;P;Shell=bash\x07"),
        "loaded mark"
    );
    assert!(
        shell
            .output
            .contains(&format!("\x1b]7;{}\x07", file_uri(&dir))),
        "OSC 7:\n{:?}",
        shell.output
    );
    assert!(
        shell.output.contains("CUSTOMBASH$ "),
        "the profile's PS1 is kept"
    );

    shell.run("saludo", "hola-desde-perfil");
    // An empty line is not a command: no start mark.
    let at = shell.wait_for(0, "hola-desde-perfil");
    shell.wait_for(at, "\x1b]133;B\x07");
    let from = shell.output.len();
    shell.send("\r");
    let next = shell.wait_for(from, "\x1b]133;B\x07");
    assert!(
        !shell.output[from..next].contains("\x1b]133;C"),
        "empty line reported as a command"
    );
    for (command, done) in [
        ("false", "\x1b]133;D;1\x07"),
        ("(exit 4)", "\x1b]133;D;4\x07"),
        (r"echo a\;b", "\x1b]133;D;0\x07"),
    ] {
        let from = shell.output.len();
        shell.send(&format!("{command}\r"));
        let at = shell.wait_for(from, done);
        let tail = &shell.output[from..at];
        let escaped = command.replace('\\', "\\\\").replace(';', "\\x3b");
        assert!(tail.contains("\x1b]133;C\x07"), "{command}: no C mark");
        assert!(
            tail.contains(&format!("\x1b]633;E;{escaped}\x07")),
            "{command}: {tail:?}"
        );
        shell.wait_for(at, "\x1b]133;B\x07");
    }
    manager.close(shell.id).unwrap();
}

/// WSL has no Git Bash, but bash.sh is the same script: with `WSL_DISTRO_NAME` set, a folder
/// outside /mnt is reported as \\wsl.localhost\<distro>\... (here the MSYS path stands in for a
/// Linux one).
#[test]
fn bash_integration_reports_wsl_distro_paths() {
    if shell_profile(ShellKind::GitBash).is_none() {
        eprintln!("skipped: Git Bash not found");
        return;
    }
    let dir = tricky_dir("wslpath");
    let manager = PtyManager::new();
    let env = vec![("WSL_DISTRO_NAME".to_owned(), "Ubuntu-24.04".to_owned())];
    let options = integrated(ShellKind::GitBash, &dir, env).unwrap();
    let shell = Shell::start(&manager, options, "\x1b]133;B\x07");
    let text = dir.display().to_string();
    let msys = format!(
        "/{}{}",
        text[..1].to_lowercase(),
        text[2..].replace('\\', "/")
    );
    let encoded: String = msys
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~/:".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    let expected = format!("\x1b]7;file://wsl.localhost/Ubuntu-24.04{encoded}\x07");
    assert!(
        shell.output.contains(&expected),
        "expected {expected:?} in:\n{:?}",
        shell.output
    );
    manager.close(shell.id).unwrap();
}

// ---------------------------------------------------------------- profiles

#[test]
fn cmd_reports_its_folder_through_the_prompt() {
    let dir = tricky_dir("cmd");
    let manager = PtyManager::new();
    let (options, integration) = launched(kind(ShellKind::Cmd), &dir, vec![]).unwrap();
    assert_eq!(integration, Integration::Cwd);
    // OSC 9;9 with the raw Windows path (spaces, accents and ñ as UTF-8), then the prompt.
    let report = format!("\x1b]9;9;{}", dir.display());
    let mut shell = Shell::start(&manager, options, &report);
    shell.wait_for(0, &format!("{}>", dir.display()));
    let parent = dir.parent().unwrap().to_owned();
    let from = shell.output.len();
    shell.send("cd ..\r");
    shell.wait_for(from, &format!("\x1b]9;9;{}", parent.display()));
    shell.run("echo sigue-%COMSPEC:~0,0%viva", "sigue-viva");
    manager.close(shell.id).unwrap();
}

#[test]
fn a_profiles_environment_reaches_the_shell() {
    let dir = tricky_dir("env");
    let manager = PtyManager::new();
    let user = std::env::var("USERNAME").unwrap();
    let spec = ShellSpec {
        kind: Some(ShellKind::PowerShell),
        env: [(
            "TERMINAL_PROFILE_VAR".to_owned(),
            "hola %USERNAME%".to_owned(),
        )]
        .into(),
        ..Default::default()
    };
    let (options, _) = launched(spec, &dir, vec![]).unwrap();
    let mut shell = Shell::start(&manager, options, "\x1b]133;B\x07");
    shell.run(
        "'var=' + $env:TERMINAL_PROFILE_VAR + (';' + 'end')",
        &format!("var=hola {user};end"),
    );
    manager.close(shell.id).unwrap();
}

#[test]
fn powershell_with_custom_switches_keeps_the_integration() {
    let dir = tricky_dir("noprofile");
    let manager = PtyManager::new();
    let spec = ShellSpec {
        kind: Some(ShellKind::PowerShell),
        args: Some(vec!["-NoProfile".to_owned(), "-NoLogo".to_owned()]),
        ..Default::default()
    };
    let (options, integration) = launched(spec, &dir, vec![]).unwrap();
    assert_eq!(integration, Integration::Full);
    let shell = Shell::start(&manager, options, "\x1b]633;P;Shell=powershell\x07");
    assert!(
        shell
            .output
            .contains(&format!("\x1b]7;{}\x07", file_uri(&dir)))
    );
    manager.close(shell.id).unwrap();
}

// ---------------------------------------------------------------- input integrity

/// What a program in the terminal received, compared byte by byte with what was sent.
fn first_difference(expected: &str, got: &str) -> Option<String> {
    if expected == got {
        return None;
    }
    let (e, g): (Vec<char>, Vec<char>) = (expected.chars().collect(), got.chars().collect());
    let at = e
        .iter()
        .zip(&g)
        .position(|(a, b)| a != b)
        .unwrap_or(e.len().min(g.len()));
    let around = |s: &[char]| {
        s[at.saturating_sub(10)..(at + 10).min(s.len())]
            .iter()
            .collect::<String>()
    };
    Some(format!(
        "{} chars expected, {} received; first difference at {at}: expected {:?}, got {:?}",
        e.len(),
        g.len(),
        around(&e),
        around(&g)
    ))
}

#[test]
fn every_keystroke_reaches_the_program_byte_for_byte() {
    // Thousands of one-character writes as fast as possible (each keystroke in the app is one
    // write_to_session), into a raw-mode program that records what it gets.
    let Some(node) = find_on_path("node.exe") else {
        eprintln!("skipped: node not found");
        return;
    };
    let out = std::env::temp_dir().join(format!("terminal-sink-{}.txt", std::process::id()));
    let manager = PtyManager::new();
    let options = SpawnOptions {
        program: node,
        args: vec![SINK.into(), out.display().to_string()],
        cwd: None,
        env: vec![],
        cols: 120,
        rows: 30,
    };
    let mut sink = Shell::start(&manager, options, "SINK listo");
    let alphabet: Vec<char> =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 '\"\\-_.,;:!?()[]{}<>/|@#$%^&*+=~`áéíóúñÑü€"
            .chars()
            .collect();
    let mut seed = 20_261_119_u32;
    let mut expected = String::new();
    for _ in 0..5000 {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let c = alphabet[(seed >> 16) as usize % alphabet.len()];
        expected.push(c);
        sink.send(&c.to_string());
    }
    let from = sink.output.len();
    sink.send("\x04");
    sink.wait_for(from, "SINK fin");
    let got = fs::read_to_string(&out).unwrap();
    fs::remove_file(&out).ok();
    if let Some(diff) = first_difference(&expected, &got) {
        panic!("input lost or reordered: {diff}");
    }
    manager.close(sink.id).ok();
}
