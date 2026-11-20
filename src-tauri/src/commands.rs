//! Tauri commands: thin adapters between the IPC layer and [`PtyManager`].

use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::path::BaseDirectory;
use tauri::{Manager, State, Webview};

use crate::pty::{
    self, BusyProcess, Integration, PtyBackend, PtyError, PtyManager, SessionEvents, SessionId,
    ShellKind, ShellProfile, ShellSpec, ShiftEnterTarget, SpawnOptions,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionExit {
    exit_code: Option<u32>,
}

/// What `create_session` started.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    session_id: SessionId,
    shell: ShellKind,
    /// What the shell will report (cwd, command marks) through OSC sequences.
    integration: Integration,
}

/// Forwards a session's events to the webview through its own channels.
#[derive(Clone)]
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
    shell: Option<ShellSpec>,
    on_data: Channel<InvokeResponseBody>,
    on_exit: Channel<SessionExit>,
) -> Result<SessionInfo, PtyError> {
    // Bundled with the app (tauri.conf.json > bundle.resources); copied next to the exe in dev.
    let integration_dir = webview
        .app_handle()
        .path()
        .resolve("shell-integration", BaseDirectory::Resource)
        .ok();
    let manager = manager.inner().clone();
    let owner = webview.label().to_owned();
    let events = ChannelEvents {
        data: on_data,
        exit: on_exit,
    };

    // Probing shells and starting one (and its conhost) blocks for a few ms: keep it off the
    // async workers.
    tauri::async_runtime::spawn_blocking(move || {
        let detected = pty::available_shells();
        let shell = pty::resolve(shell.as_ref(), &detected)
            .ok_or_else(|| PtyError::Spawn("el perfil no tiene una shell instalada".to_owned()))?;
        // A directory that no longer exists or cannot be read falls back to the home folder.
        let cwd = pty::resolve_cwd(cwd.map(PathBuf::from).as_deref());
        let launch = pty::launch(&shell, integration_dir.as_deref(), cwd.as_deref());
        let mut env = vec![("COLORTERM".to_owned(), "truecolor".to_owned())];
        env.extend(launch.env);
        let options = SpawnOptions {
            program: launch.program,
            args: launch.args,
            cwd: launch.cwd,
            env,
            cols,
            rows,
        };
        let info = |session_id| SessionInfo {
            session_id,
            shell: shell.kind,
            integration: launch.integration,
        };
        match manager.create(&owner, options.clone(), events.clone()) {
            // The directory passed the checks but CreateProcess still refused it: use home.
            Err(PtyError::Spawn(_)) if options.cwd != pty::default_cwd() => manager.create(
                &owner,
                SpawnOptions {
                    cwd: pty::default_cwd(),
                    ..options
                },
                events,
            ),
            other => other,
        }
        .map(info)
    })
    .await
    .map_err(|e| PtyError::Spawn(format!("spawn task failed: {e}")))?
}

/// Facts the UI needs once: the home folder (to shorten paths) and the shells available.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    home_dir: Option<String>,
    shells: Vec<ShellProfile>,
}

/// Async: probing for shells touches the file system, never on the main thread.
#[tauri::command]
pub async fn system_info() -> SystemInfo {
    SystemInfo {
        home_dir: pty::default_cwd().map(|dir| dir.display().to_string()),
        shells: pty::available_shells(),
    }
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

/// The AI agent running in a session, if any (for the agent indicators).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAgent {
    session_id: SessionId,
    /// `claude`, `codex` or `gemini`.
    agent: Option<&'static str>,
}

/// Which sessions run an AI agent, with one look at the process table for all of them.
#[tauri::command]
pub async fn session_agents(
    manager: State<'_, PtyManager>,
    session_ids: Vec<SessionId>,
) -> Result<Vec<SessionAgent>, PtyError> {
    let manager = manager.inner().clone();
    // Walks the process table: keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        manager
            .agents(&session_ids)
            .into_iter()
            .map(|(session_id, agent)| SessionAgent { session_id, agent })
            .collect()
    })
    .await
    .map_err(|e| PtyError::Io(format!("agent check failed: {e}")))
}

/// Lets xterm adapt to ConPTY (`windowsPty` option). `None` outside Windows.
#[tauri::command]
pub fn pty_backend() -> Option<PtyBackend> {
    pty::backend()
}
