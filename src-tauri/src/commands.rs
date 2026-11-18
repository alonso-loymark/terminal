//! Tauri commands: thin adapters between the IPC layer and [`PtyManager`].

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{State, Webview};

use crate::pty::{
    self, BusyProcess, PtyBackend, PtyError, PtyManager, SessionEvents, SessionId,
    ShiftEnterTarget, SpawnOptions,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExit {
    exit_code: Option<u32>,
}

/// Forwards a session's events to the webview through its own channels.
struct ChannelEvents {
    data: Channel<InvokeResponseBody>,
    exit: Channel<SessionExit>,
}

impl SessionEvents for ChannelEvents {
    fn output(&self, data: Vec<u8>) {
        // Raw bytes arrive in JS as an ArrayBuffer: no JSON encoding, no UTF-8 decoding here.
        // Sending only fails once the webview is gone, and then the session is being closed.
        let _ = self.data.send(InvokeResponseBody::Raw(data));
    }

    fn exit(&self, exit_code: Option<u32>) {
        let _ = self.exit.send(SessionExit { exit_code });
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_session(
    webview: Webview,
    manager: State<'_, PtyManager>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<SessionExit>,
) -> Result<SessionId, PtyError> {
    let shell = pty::default_shell();
    let options = SpawnOptions {
        program: shell.program,
        args: shell.args,
        cwd: cwd
            .map(PathBuf::from)
            .filter(|dir| dir.is_dir())
            .or_else(pty::default_cwd),
        env: vec![("COLORTERM".to_owned(), "truecolor".to_owned())],
        cols,
        rows,
    };
    let manager = manager.inner().clone();
    let owner = webview.label().to_owned();
    let events = ChannelEvents {
        data: on_data,
        exit: on_exit,
    };

    // Starting a shell (and its conhost) blocks for a few ms: keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || manager.create(&owner, options, events))
        .await
        .map_err(|e| PtyError::Spawn(format!("spawn task failed: {e}")))?
}

#[tauri::command]
pub fn write_to_session(
    manager: State<'_, PtyManager>,
    session_id: SessionId,
    data: String,
) -> Result<(), PtyError> {
    manager.write(session_id, data.into_bytes())
}

#[tauri::command]
pub fn resize_session(
    manager: State<'_, PtyManager>,
    session_id: SessionId,
    cols: u16,
    rows: u16,
) -> Result<(), PtyError> {
    manager.resize(session_id, cols, rows)
}

#[tauri::command]
pub fn close_session(
    manager: State<'_, PtyManager>,
    session_id: SessionId,
) -> Result<(), PtyError> {
    manager.close(session_id)
}

/// Shift+Enter, translated for whatever runs in the session (newline in AI agents, a real
/// Shift+Enter elsewhere). Synchronous like `write_to_session`, so keystrokes stay in order.
#[tauri::command]
pub fn send_shift_enter(
    manager: State<'_, PtyManager>,
    session_id: SessionId,
) -> Result<ShiftEnterTarget, PtyError> {
    manager.shift_enter(session_id)
}

/// Processes that closing the session would kill besides the shell, so the UI can ask before
/// closing a tab that runs a dev server or an agent.
#[tauri::command]
pub async fn session_busy(
    manager: State<'_, PtyManager>,
    session_id: SessionId,
) -> Result<Vec<BusyProcess>, PtyError> {
    let manager = manager.inner().clone();
    // Walks the process table: keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || manager.busy_processes(session_id))
        .await
        .map_err(|e| PtyError::Io(format!("busy check failed: {e}")))?
}

/// Lets xterm adapt to ConPTY (`windowsPty` option). `None` outside Windows.
#[tauri::command]
pub fn pty_backend() -> Option<PtyBackend> {
    pty::backend()
}
