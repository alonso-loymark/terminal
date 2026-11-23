//! One PTY session: the pseudoconsole, the shell process and the threads that pump its data.

use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::error::PtyError;
use super::manager::SessionId;

/// While output keeps coming, what arrives within this window goes out as one message. The
/// first chunk after a quiet spell (a key's echo, a prompt) goes out at once.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(5);
/// Soft cap for one output message, so a flood still streams in steady pieces.
pub const MAX_BATCH_BYTES: usize = 256 * 1024;
const READ_BUFFER_BYTES: usize = 32 * 1024;
/// How long the flusher waits for the exit code once the output has ended.
const EXIT_CODE_TIMEOUT: Duration = Duration::from_secs(5);
/// Session threads only move buffers around; the default 2 MiB stack would be wasted.
const THREAD_STACK_BYTES: usize = 256 * 1024;

/// Receives what a session produces. Implemented by the Tauri layer (channels) and by tests.
pub trait SessionEvents: Send + 'static {
    /// A batch of raw PTY output. It may end in the middle of a UTF-8 sequence.
    fn output(&self, data: Vec<u8>);
    /// Called exactly once, after the last `output`. `None` when the exit code is unknown.
    fn exit(&self, exit_code: Option<u32>);
}

#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

/// Counters of the output path (bytes read from the PTY, batches sent to the page, bytes
/// waiting between the reader and the flusher, flow-control pauses). Cheap atomics; read by
/// the dev-only `debug_pty_stats` command (performance e2e).
#[derive(Debug, Default)]
pub struct OutputStats {
    bytes_read: AtomicU64,
    reads: AtomicU64,
    batches: AtomicU64,
    max_batch: AtomicU64,
    backlog: AtomicU64,
    max_backlog: AtomicU64,
    pauses: AtomicU64,
    /// Wall clock (µs since the Unix epoch) of the last input written, PTY read and batch sent:
    /// the perf e2e lines them up with the page's own clock to split the echo latency.
    last_input_us: AtomicU64,
    last_read_us: AtomicU64,
    last_sent_us: AtomicU64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatsSnapshot {
    pub bytes_read: u64,
    pub reads: u64,
    pub batches: u64,
    pub max_batch: u64,
    pub backlog: u64,
    pub max_backlog: u64,
    pub pauses: u64,
    pub last_input_us: u64,
    pub last_read_us: u64,
    pub last_sent_us: u64,
}

/// Microseconds since the Unix epoch (0 if the clock is before it).
fn wall_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_micros()).unwrap_or(u64::MAX))
}

impl OutputStats {
    fn input(&self) {
        self.last_input_us.store(wall_us(), Ordering::Relaxed);
    }

    fn read(&self, n: usize) {
        self.last_read_us.store(wall_us(), Ordering::Relaxed);
        let n = n as u64;
        self.bytes_read.fetch_add(n, Ordering::Relaxed);
        self.reads.fetch_add(1, Ordering::Relaxed);
        let backlog = self.backlog.fetch_add(n, Ordering::Relaxed) + n;
        self.max_backlog.fetch_max(backlog, Ordering::Relaxed);
    }

    fn sent(&self, n: usize) {
        let n = n as u64;
        self.last_sent_us.store(wall_us(), Ordering::Relaxed);
        self.batches.fetch_add(1, Ordering::Relaxed);
        self.max_batch.fetch_max(n, Ordering::Relaxed);
        // A batch is made of chunks the reader counted before sending them: no underflow.
        self.backlog.fetch_sub(n, Ordering::Relaxed);
    }

    pub(crate) fn paused(&self) {
        self.pauses.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> OutputStatsSnapshot {
        OutputStatsSnapshot {
            bytes_read: self.bytes_read.load(Ordering::Relaxed),
            reads: self.reads.load(Ordering::Relaxed),
            batches: self.batches.load(Ordering::Relaxed),
            max_batch: self.max_batch.load(Ordering::Relaxed),
            backlog: self.backlog.load(Ordering::Relaxed),
            max_backlog: self.max_backlog.load(Ordering::Relaxed),
            pauses: self.pauses.load(Ordering::Relaxed),
            last_input_us: self.last_input_us.load(Ordering::Relaxed),
            last_read_us: self.last_read_us.load(Ordering::Relaxed),
            last_sent_us: self.last_sent_us.load(Ordering::Relaxed),
        }
    }
}

/// Flow control: the page asks to pause reading the PTY while its terminal has too much output
/// still to parse, and to resume once it caught up. Not reading makes ConPTY wait, and when it
/// can write again it draws the screen as it is then: a TUI repainting faster than the page can
/// parse skips frames instead of piling them up (seconds of stale screen and slow echo before).
#[derive(Debug, Default)]
pub(crate) struct OutputGate {
    state: Mutex<GateState>,
    changed: Condvar,
}

#[derive(Debug, Default)]
struct GateState {
    paused: bool,
    /// The session is going away: the reader must keep reading until EOF.
    closed: bool,
}

impl OutputGate {
    pub(crate) fn set_paused(&self, paused: bool) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.paused = paused;
        self.changed.notify_all();
    }

    /// Opens the gate for good (teardown: ConPTY only closes once its output is drained).
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.closed = true;
        self.changed.notify_all();
    }

    /// Blocks while paused.
    fn wait_open(&self) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        while state.paused && !state.closed {
            state = self
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

pub(crate) struct Session {
    pub(crate) owner: String,
    pub(crate) stats: Arc<OutputStats>,
    pub(crate) output_gate: Arc<OutputGate>,
    pub(crate) pid: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    input: Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(windows)]
    job: Option<super::job::Job>,
    killed: bool,
}

/// The child process, handed back separately so the manager can start waiting on it only
/// after the session is registered (a shell that dies instantly must find it to tear down).
pub(crate) struct ExitWatcher {
    id: SessionId,
    child: Box<dyn Child + Send + Sync>,
    exit_tx: Sender<Option<u32>>,
}

impl Session {
    pub(crate) fn spawn(
        id: SessionId,
        owner: String,
        options: SpawnOptions,
        events: impl SessionEvents,
    ) -> Result<(Self, ExitWatcher), PtyError> {
        let pair = native_pty_system()
            .openpty(pty_size(options.cols, options.rows))
            .map_err(|e| PtyError::Open(format!("{e:#}")))?;

        let mut command = CommandBuilder::new(&options.program);
        command.args(&options.args);
        if let Some(cwd) = &options.cwd {
            command.cwd(cwd);
        }
        // Another agent session's variables would make `claude` refuse to start in the shell.
        for var in super::NESTED_SESSION_VARS {
            command.env_remove(var);
        }
        for (key, value) in &options.env {
            command.env(key, value);
        }

        #[cfg(windows)]
        enable_ctrl_c_for_children();
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| PtyError::Spawn(format!("{}: {e:#}", options.program.display())))?;
        // Only the master may keep the pseudoconsole alive: once it is dropped the
        // pseudoconsole closes and the reader finally sees EOF.
        drop(pair.slave);

        let (input_tx, input_rx) = mpsc::channel();
        let stats = Arc::new(OutputStats::default());
        let gate = Arc::new(OutputGate::default());
        let session = Session {
            owner,
            stats: stats.clone(),
            output_gate: gate.clone(),
            pid: child.process_id(),
            killer: child.clone_killer(),
            #[cfg(windows)]
            job: contain_in_job(child.as_ref()),
            master: pair.master,
            input: input_tx,
            killed: false,
        };
        // From here on any early return drops `session`, which kills the shell.

        let reader = session
            .master
            .try_clone_reader()
            .map_err(|e| PtyError::Io(format!("{e:#}")))?;
        let writer = session
            .master
            .take_writer()
            .map_err(|e| PtyError::Io(format!("{e:#}")))?;
        let (output_tx, output_rx) = mpsc::channel();
        let (exit_tx, exit_rx) = mpsc::channel();

        spawn_thread(id, "writer", move || pump_input(writer, input_rx))?;
        let reader_stats = stats.clone();
        spawn_thread(id, "reader", move || {
            pump_output(reader, output_tx, &reader_stats, &gate)
        })?;
        spawn_thread(id, "flusher", move || {
            flush_output(output_rx, exit_rx, events, &stats)
        })?;

        Ok((session, ExitWatcher { id, child, exit_tx }))
    }

    pub(crate) fn write(&self, id: SessionId, data: Vec<u8>) -> Result<(), PtyError> {
        self.stats.input();
        self.input.send(data).map_err(|_| PtyError::Closed(id))
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master
            .resize(pty_size(cols, rows))
            .map_err(|e| PtyError::Resize(format!("{e:#}")))
    }

    /// Processes that closing this session would kill besides the shell.
    pub(crate) fn busy_processes(&self) -> Vec<super::teardown::BusyProcess> {
        #[cfg(windows)]
        if let Some(job) = &self.job {
            return super::teardown::busy_processes(job, self.pid);
        }
        Vec::new()
    }

    /// Kills the shell and, on Windows, every console process it started; apps with a visible
    /// window survive (see `teardown.rs`). Idempotent.
    pub(crate) fn kill(&mut self) {
        if std::mem::replace(&mut self.killed, true) {
            return;
        }
        self.output_gate.close();
        #[cfg(windows)]
        if let Some(job) = &self.job {
            super::teardown::close_job(job, self.pid);
        }
        // Fallback when the job could not be set up; harmless if the process is already gone.
        let _ = self.killer.kill();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.kill();
        // Fields drop next: `master` closes the pseudoconsole (reader gets EOF), `input`
        // stops the writer thread and `job` closes its handle.
    }
}

impl ExitWatcher {
    /// Waits for the shell on its own thread, reports the exit code to the flusher and then
    /// runs `on_exit`, which must tear the session down so the pseudoconsole gets closed.
    pub(crate) fn start(self, on_exit: impl FnOnce() + Send + 'static) -> Result<(), PtyError> {
        let ExitWatcher {
            id,
            mut child,
            exit_tx,
        } = self;
        spawn_thread(id, "waiter", move || {
            let exit_code = child.wait().ok().map(|status| status.exit_code());
            let _ = exit_tx.send(exit_code);
            on_exit();
        })
    }
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    // ConPTY rejects a zero-sized console.
    PtySize {
        cols: cols.max(1),
        rows: rows.max(1),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// "Ignore Ctrl+C" (`SetConsoleCtrlHandler(NULL, TRUE)`, also implied by
/// `CREATE_NEW_PROCESS_GROUP`) is inherited by child processes. If whatever launched this
/// app had it set, every shell and program in the terminal would ignore ^C. Clearing it in
/// our own process right before spawning makes shells start with Ctrl+C enabled.
#[cfg(windows)]
fn enable_ctrl_c_for_children() {
    use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;
    // SAFETY: a null handler with FALSE only clears the process-wide "ignore Ctrl+C" flag.
    unsafe { SetConsoleCtrlHandler(None, 0) };
}

#[cfg(windows)]
fn contain_in_job(child: &(dyn Child + Send + Sync)) -> Option<super::job::Job> {
    // The shell starts running before it is assigned; it does not spawn children that fast.
    let process = child.as_raw_handle()?;
    match super::job::Job::kill_on_close().and_then(|job| job.assign(process).map(|()| job)) {
        Ok(job) => Some(job),
        Err(err) => {
            eprintln!(
                "pty: shell not placed in a job object ({err}); only the shell will be killed"
            );
            None
        }
    }
}

fn spawn_thread(
    id: SessionId,
    role: &str,
    f: impl FnOnce() + Send + 'static,
) -> Result<(), PtyError> {
    thread::Builder::new()
        .name(format!("pty-{id}-{role}"))
        .stack_size(THREAD_STACK_BYTES)
        .spawn(f)
        .map(drop)
        .map_err(|e| PtyError::Io(format!("could not start the {role} thread: {e}")))
}

/// Writes queued input on its own thread so a busy console never blocks the IPC handler.
fn pump_input(mut writer: Box<dyn Write + Send>, input: Receiver<Vec<u8>>) {
    // Ends when the session (the only sender) is dropped.
    for data in input {
        if writer
            .write_all(&data)
            .and_then(|()| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn pump_output(
    mut reader: Box<dyn Read + Send>,
    output: Sender<Vec<u8>>,
    stats: &OutputStats,
    gate: &OutputGate,
) {
    let mut buf = vec![0u8; READ_BUFFER_BYTES];
    loop {
        gate.wait_open();
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                stats.read(n);
                if output.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            // ConPTY reports a broken pipe once the pseudoconsole is closed: that is our EOF.
            Err(_) => break,
        }
    }
}

fn flush_output(
    output: Receiver<Vec<u8>>,
    exit: Receiver<Option<u32>>,
    events: impl SessionEvents,
    stats: &OutputStats,
) {
    let mut last_sent: Option<Instant> = None;
    while let Ok(first) = output.recv() {
        let window = batch_window(last_sent.map(|at| at.elapsed()));
        let batch = collect_batch(first, &output, window, MAX_BATCH_BYTES);
        stats.sent(batch.len());
        events.output(batch);
        last_sent = Some(Instant::now());
    }
    // The reader is gone, so no output can follow: only now is it safe to report the exit.
    let exit_code = exit.recv_timeout(EXIT_CODE_TIMEOUT).ok().flatten();
    events.exit(exit_code);
}

/// How long to gather output after its first chunk, given the time since the last message.
/// After a quiet spell, nothing: a key's echo should not wait for more output that is not
/// coming (only what is already queued joins it). While output keeps coming, FLUSH_INTERVAL.
fn batch_window(since_last: Option<Duration>) -> Duration {
    match since_last {
        Some(elapsed) if elapsed < FLUSH_INTERVAL => FLUSH_INTERVAL,
        _ => Duration::ZERO,
    }
}

/// Appends to `first` whatever else arrives within `window`, stopping early at `max_bytes`.
fn collect_batch(
    first: Vec<u8>,
    rx: &Receiver<Vec<u8>>,
    window: Duration,
    max_bytes: usize,
) -> Vec<u8> {
    let mut batch = first;
    let deadline = Instant::now() + window;
    while batch.len() < max_bytes {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(chunk) => batch.extend_from_slice(&chunk),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    batch
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_chunks_that_arrive_within_the_window() {
        let (tx, rx) = mpsc::channel();
        for chunk in [b"b".to_vec(), b"c".to_vec(), b"d".to_vec()] {
            tx.send(chunk).unwrap();
        }
        let batch = collect_batch(b"a".to_vec(), &rx, Duration::from_millis(50), 1024);
        assert_eq!(batch, b"abcd");
    }

    #[test]
    fn stops_at_the_size_cap() {
        let (tx, rx) = mpsc::channel();
        tx.send(vec![1; 8]).unwrap();
        tx.send(vec![2; 8]).unwrap();
        let batch = collect_batch(vec![0; 8], &rx, Duration::from_secs(5), 16);
        assert_eq!(batch.len(), 16, "third chunk must wait for the next batch");
        assert_eq!(rx.try_recv().unwrap(), vec![2; 8]);
    }

    #[test]
    fn does_not_wait_past_the_window() {
        let (_tx, rx) = mpsc::channel::<Vec<u8>>();
        let started = Instant::now();
        let batch = collect_batch(b"x".to_vec(), &rx, Duration::from_millis(20), 1024);
        assert_eq!(batch, b"x");
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn output_after_a_quiet_spell_goes_out_at_once() {
        assert_eq!(
            batch_window(None),
            Duration::ZERO,
            "the first output of a session"
        );
        assert_eq!(
            batch_window(Some(Duration::from_millis(40))),
            Duration::ZERO
        );
        assert_eq!(batch_window(Some(Duration::from_millis(1))), FLUSH_INTERVAL);
        // A zero window still takes what is already queued, without waiting for more.
        let (tx, rx) = mpsc::channel();
        tx.send(b"cho".to_vec()).unwrap();
        let started = Instant::now();
        let batch = collect_batch(b"e".to_vec(), &rx, Duration::ZERO, 1024);
        assert_eq!(batch, b"echo");
        assert!(started.elapsed() < Duration::from_millis(50));
    }

    #[test]
    fn a_paused_gate_holds_the_reader_until_resumed_or_closed() {
        let gate = Arc::new(OutputGate::default());
        gate.set_paused(true);
        let (done_tx, done_rx) = mpsc::channel();
        let waiting = gate.clone();
        thread::spawn(move || {
            waiting.wait_open();
            done_tx.send(()).unwrap();
        });
        assert!(
            done_rx.recv_timeout(Duration::from_millis(100)).is_err(),
            "paused: must wait"
        );
        gate.set_paused(false);
        assert!(
            done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "resumed"
        );

        // Closing (teardown) opens it for good, even if paused again.
        gate.set_paused(true);
        let (done_tx, done_rx) = mpsc::channel();
        let waiting = gate.clone();
        thread::spawn(move || {
            waiting.wait_open();
            done_tx.send(()).unwrap();
        });
        gate.close();
        assert!(
            done_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
            "closed"
        );
        gate.set_paused(true);
        gate.wait_open();
    }

    #[test]
    fn returns_immediately_when_the_reader_is_gone() {
        let (tx, rx) = mpsc::channel();
        tx.send(b"tail".to_vec()).unwrap();
        drop(tx);
        let started = Instant::now();
        let batch = collect_batch(b"head-".to_vec(), &rx, Duration::from_secs(5), 1024);
        assert_eq!(batch, b"head-tail");
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
