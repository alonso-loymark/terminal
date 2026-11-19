//! Tauri commands for the file explorer: thin adapters over [`crate::explorer`]. Everything that
//! touches the disk or spawns git runs on the blocking pool, never on the main thread.

use std::path::PathBuf;
use std::sync::Mutex;

use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::explorer::{
    self, DirEntry, ExplorerError, GitStatus, NewEntryKind, WatchEvents, WatchId, WatchManager,
};

/// Runs blocking file-system work off the main thread.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ExplorerError> + Send + 'static,
) -> Result<T, ExplorerError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| ExplorerError::Unavailable(format!("tarea interrumpida: {e}")))?
}

#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, ExplorerError> {
    blocking(move || explorer::list_dir(&PathBuf::from(path))).await
}

/// Sends the folders that changed to the page that started the watcher.
struct ChannelWatchEvents(Mutex<Channel<Vec<String>>>);

impl WatchEvents for ChannelWatchEvents {
    fn changed(&self, dirs: Vec<PathBuf>) {
        let dirs = dirs.iter().map(|d| d.display().to_string()).collect();
        if let Ok(channel) = self.0.lock() {
            // Fails only once the page is gone; its watchers are being stopped.
            let _ = channel.send(dirs);
        }
    }
}

#[tauri::command]
pub fn watch_start(
    webview: Webview,
    watches: State<'_, WatchManager>,
    on_change: Channel<Vec<String>>,
) -> Result<WatchId, ExplorerError> {
    watches.start(webview.label(), ChannelWatchEvents(Mutex::new(on_change)))
}

/// The full set of folders to watch (the visible, expanded ones). Returns those being watched.
#[tauri::command]
pub async fn watch_set(
    watches: State<'_, WatchManager>,
    id: WatchId,
    dirs: Vec<String>,
) -> Result<Vec<String>, ExplorerError> {
    let dirs: Vec<PathBuf> = dirs.into_iter().map(PathBuf::from).collect();
    // Registering OS watches opens a handle per folder: keep it off the main thread.
    let manager = watches.inner().clone();
    blocking(move || manager.set_dirs(id, &dirs))
        .await
        .map(|dirs| dirs.iter().map(|d| d.display().to_string()).collect())
}

#[tauri::command]
pub fn watch_stop(watches: State<'_, WatchManager>, id: WatchId) {
    watches.stop(id);
}

#[tauri::command]
pub async fn git_status(path: String) -> Result<Option<GitStatus>, ExplorerError> {
    let Some(git) = crate::pty::find_on_path("git.exe").or_else(|| crate::pty::find_on_path("git"))
    else {
        return Ok(None);
    };
    blocking(move || explorer::git_status(&git, &PathBuf::from(path))).await
}

#[tauri::command]
pub async fn create_entry(
    dir: String,
    name: String,
    kind: NewEntryKind,
) -> Result<String, ExplorerError> {
    blocking(move || explorer::create_entry(&PathBuf::from(dir), &name, kind))
        .await
        .map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn rename_entry(path: String, name: String) -> Result<String, ExplorerError> {
    blocking(move || explorer::rename_entry(&PathBuf::from(path), &name))
        .await
        .map(|path| path.display().to_string())
}

#[tauri::command]
pub async fn trash_entries(paths: Vec<String>) -> Result<(), ExplorerError> {
    blocking(move || explorer::trash(&paths.into_iter().map(PathBuf::from).collect::<Vec<_>>()))
        .await
}

#[tauri::command]
pub async fn open_in_vscode(path: String) -> Result<(), ExplorerError> {
    blocking(move || explorer::open_in_vscode(&PathBuf::from(path))).await
}

#[tauri::command]
pub async fn open_in_file_manager(path: String) -> Result<(), ExplorerError> {
    blocking(move || explorer::open_in_file_manager(&PathBuf::from(path))).await
}
