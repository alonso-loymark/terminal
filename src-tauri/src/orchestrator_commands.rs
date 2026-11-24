//! Tauri commands of the orchestrator (Fase 8A): thin adapters over [`crate::agents`] and
//! [`crate::orchestrator`]. Blocking work runs in `spawn_blocking`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::agents::permissions::{ProjectCommand, detect_commands, validate_pattern};
use crate::agents::{AgentInfo, AgentsManager, AskSpec, Failure, TaskEvent, TaskEvents, TaskSpec};
use crate::orchestrator::instructions::{self, InstructionFile, Instructions};
use crate::orchestrator::snapshot::{self, Snapshot, TaskDiff};
use crate::orchestrator::store::{self, ProjectFile};
use crate::orchestrator::{project_dir, project_name};
use crate::settings_commands::SettingsState;

/// Snapshots taken before tasks, until their diff is asked (or the page goes away).
#[derive(Default)]
pub struct OrchestratorState {
    next: AtomicU32,
    snapshots: Mutex<HashMap<u32, (String, Snapshot)>>,
}

impl OrchestratorState {
    pub fn forget_owned_by(&self, owner: &str) {
        self.snapshots
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|_, (o, _)| o != owner);
    }
}

struct ChannelEvents(Channel<TaskEvent>);

impl TaskEvents for ChannelEvents {
    fn send(&self, event: TaskEvent) {
        let _ = self.0.send(event);
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
}

fn git_exe() -> Option<PathBuf> {
    crate::pty::find_on_path("git.exe").or_else(|| crate::pty::find_on_path("git"))
}

/// The frontend tells whether the orchestrator is on (`orchestrator.enabled`). Off cancels
/// every task and makes the other commands refuse to launch anything.
#[tauri::command]
pub fn orch_configure(manager: State<'_, AgentsManager>, enabled: bool) {
    manager.set_enabled(enabled);
}

/// Every agent adapter: installed, logged in, models (cached unless `refresh`).
#[tauri::command]
pub async fn agents_detect(
    manager: State<'_, AgentsManager>,
    agent_path: Option<String>,
    refresh: bool,
) -> Result<Vec<AgentInfo>, Failure> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.detect(agent_path.as_deref(), refresh))
        .await
        .map_err(|e| Failure::new(crate::agents::ErrorCode::Failed, e.to_string()))?
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    dir: String,
    name: String,
    git: bool,
    /// Build, test and lint commands found in its files.
    commands: Vec<ProjectCommand>,
    instructions: Instructions,
    /// Where its orchestrator files live (Brisa's config folder).
    store: String,
}

#[tauri::command]
pub async fn orch_project(
    settings: State<'_, SettingsState>,
    dir: String,
) -> Result<ProjectInfo, String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        let instructions = instructions::inspect(&dir).map_err(|e| e.to_string())?;
        let store = store::folder(&config, &dir).map_err(|e| e.to_string())?;
        let git = git_exe().is_some_and(|git| {
            crate::explorer::git::run_code(&git, &dir, &["rev-parse", "--show-toplevel"])
                .is_ok_and(|(code, _)| code == Some(0))
        });
        Ok(ProjectInfo {
            name: project_name(&dir),
            dir: dir.display().to_string(),
            git,
            commands: detect_commands(&dir),
            instructions,
            store: store.display().to_string(),
        })
    })
    .await
}

/// Checks a command pattern before the user adds it (settings screen, "permitir siempre").
#[tauri::command]
pub fn orch_check_pattern(pattern: String) -> Result<String, String> {
    validate_pattern(&pattern)
}

#[tauri::command]
pub fn orch_ask(
    webview: Webview,
    manager: State<'_, AgentsManager>,
    spec: AskSpec,
    on_event: Channel<TaskEvent>,
) -> Result<u32, Failure> {
    manager.ask(webview.label(), spec, ChannelEvents(on_event))
}

#[tauri::command]
pub fn orch_run(
    webview: Webview,
    manager: State<'_, AgentsManager>,
    spec: TaskSpec,
    on_event: Channel<TaskEvent>,
) -> Result<u32, Failure> {
    manager.run(webview.label(), spec, ChannelEvents(on_event))
}

#[tauri::command]
pub fn orch_cancel(manager: State<'_, AgentsManager>, id: u32) {
    manager.cancel(id);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFiles {
    /// The single chat of before (Fase 8A), to migrate when there is no `chats`.
    conversation: Option<String>,
    chats: Option<String>,
    decisions: Option<String>,
    project: Option<String>,
}

#[tauri::command]
pub async fn orch_load(
    settings: State<'_, SettingsState>,
    dir: String,
) -> Result<ProjectFiles, String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        let read = |file| store::read(&config, &dir, file).map_err(|e| e.to_string());
        Ok(ProjectFiles {
            conversation: read(ProjectFile::Conversation)?,
            chats: read(ProjectFile::Chats)?,
            decisions: read(ProjectFile::Decisions)?,
            project: read(ProjectFile::Project)?,
        })
    })
    .await
}

#[tauri::command]
pub async fn orch_save(
    settings: State<'_, SettingsState>,
    dir: String,
    file: ProjectFile,
    text: String,
) -> Result<(), String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        store::write(&config, &dir, file, &text).map_err(|e| e.to_string())
    })
    .await
}

/// One chat's messages (`None`: it has no file yet).
#[tauri::command]
pub async fn orch_chat_load(
    settings: State<'_, SettingsState>,
    dir: String,
    id: String,
) -> Result<Option<String>, String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        store::read_chat(&config, &dir, &id).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn orch_chat_save(
    settings: State<'_, SettingsState>,
    dir: String,
    id: String,
    text: String,
) -> Result<(), String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        store::write_chat(&config, &dir, &id, &text).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn orch_chat_delete(
    settings: State<'_, SettingsState>,
    dir: String,
    id: String,
) -> Result<(), String> {
    let config = settings.dir.clone();
    blocking(move || {
        let dir = project_dir(&dir)?;
        store::delete_chat(&config, &dir, &id).map_err(|e| e.to_string())
    })
    .await
}

/// Notes the repository's state before a task; returns the id to ask its diff with.
#[tauri::command]
pub async fn orch_snapshot(
    webview: Webview,
    state: State<'_, OrchestratorState>,
    dir: String,
) -> Result<u32, String> {
    let id = state.next.fetch_add(1, Ordering::SeqCst) + 1;
    let folder = std::env::temp_dir()
        .join("brisa-snapshots")
        .join(format!("{}-{id}", std::process::id()));
    let taken = blocking(move || {
        let dir = project_dir(&dir)?;
        Ok(snapshot::take(git_exe().as_deref(), &dir, folder))
    })
    .await?;
    state
        .snapshots
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id, (webview.label().to_owned(), taken));
    Ok(id)
}

/// What changed since the snapshot (which is then released).
#[tauri::command]
pub async fn orch_diff(
    state: State<'_, OrchestratorState>,
    id: u32,
    touched: Vec<String>,
) -> Result<TaskDiff, String> {
    let taken = state
        .snapshots
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&id)
        .map(|(_, s)| s)
        .ok_or_else(|| format!("no existe la foto {id}"))?;
    blocking(move || Ok(snapshot::diff(git_exe().as_deref(), &taken, &touched))).await
}

/// Writes AGENTS.md or CLAUDE.md with the text the user confirmed (see `instructions.rs`).
#[tauri::command]
pub async fn orch_write_instructions(
    dir: String,
    file: InstructionFile,
    content: String,
    expected: Option<String>,
) -> Result<Instructions, String> {
    blocking(move || {
        let dir = project_dir(&dir)?;
        instructions::write(&dir, file, &content, expected.as_deref()).map_err(|e| e.to_string())
    })
    .await
}
