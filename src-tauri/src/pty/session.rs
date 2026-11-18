//! One PTY session: the pseudoconsole, the shell process and the threads that pump its data.

use std::io::{ErrorKind, Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{Child, ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

use super::error::PtyError;
use super::manager::SessionId;

/// Output arriving within this window after the first chunk of a burst goes out as one message.
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

pub(crate) struct Session {
    pub(crate) owner: String,
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
        let session = Session {
            owner,
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
        spawn_thread(id, "reader", move || pump_output(reader, output_tx))?;
        spawn_thread(id, "flusher", move || {
            flush_output(output_rx, exit_rx, events)
        })?;

        Ok((session, ExitWatcher { id, child, exit_tx }))
    }

    pub(crate) fn write(&self, id: SessionId, data: Vec<u8>) -> Result<(), PtyError> {
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

fn pump_output(mut reader: Box<dyn Read + Send>, output: Sender<Vec<u8>>) {
    let mut buf = vec![0u8; READ_BUFFER_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
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
) {
    while let Ok(first) = output.recv() {
        events.output(collect_batch(
            first,
            &output,
            FLUSH_INTERVAL,
            MAX_BATCH_BYTES,
        ));
    }
    // The reader is gone, so no output can follow: only now is it safe to report the exit.
    let exit_code = exit.recv_timeout(EXIT_CODE_TIMEOUT).ok().flatten();
    events.exit(exit_code);
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
