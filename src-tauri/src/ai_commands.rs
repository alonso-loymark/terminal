//! Tauri commands of the AI layer: thin adapters over [`AiManager`].

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{State, Webview};

use crate::ai::{AiEvent, AiEvents, AiManager, AiRequest, Failure, Provider, claude_cli, secrets};

struct ChannelEvents(Channel<AiEvent>);

impl AiEvents for ChannelEvents {
    fn send(&self, event: AiEvent) {
        // Fails only once the page is gone, and then its requests are being cancelled.
        let _ = self.0.send(event);
    }
}

/// The frontend tells the backend whether AI is on (`ai.enabled`). Off cancels everything and
/// makes every other command refuse to launch anything.
#[tauri::command]
pub fn ai_configure(manager: State<'_, AiManager>, enabled: bool) {
    manager.set_enabled(enabled);
}

#[tauri::command]
pub fn ai_query(
    webview: Webview,
    manager: State<'_, AiManager>,
    request: AiRequest,
    on_event: Channel<AiEvent>,
) -> Result<u32, Failure> {
    manager.start(webview.label(), request, ChannelEvents(on_event))
}

#[tauri::command]
pub fn ai_cancel(manager: State<'_, AiManager>, id: u32) {
    manager.cancel(id);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    enabled: bool,
    claude: Option<claude_cli::ClaudeStatus>,
    error: Option<Failure>,
    /// Last characters of the saved API key ("…abcd"), if there is one.
    api_key: Option<String>,
}

/// For the settings screen. With AI off, nothing is launched.
#[tauri::command]
pub async fn ai_status(
    manager: State<'_, AiManager>,
    provider: Provider,
    claude_path: Option<String>,
) -> Result<AiStatus, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut status = AiStatus {
            enabled: manager.enabled(),
            claude: None,
            error: None,
            api_key: None,
        };
        #[cfg(windows)]
        {
            status.api_key = crate::ai::credentials::hint(&manager.config().credential_target);
        }
        if status.enabled && provider == Provider::ClaudeCli {
            match claude_cli::status(manager.config(), claude_path.as_deref()) {
                Ok(claude) => status.claude = Some(claude),
                Err(failure) => status.error = Some(failure),
            }
        }
        status
    })
    .await
    .map_err(|e| e.to_string())
}

/// Saves the key in the Credential Manager; returns its hint.
#[tauri::command]
pub async fn ai_set_api_key(manager: State<'_, AiManager>, key: String) -> Result<String, String> {
    let key = key.trim().to_owned();
    if key.is_empty() || key.len() > 512 || key.chars().any(char::is_whitespace) {
        return Err("La clave no es válida.".to_owned());
    }
    let target = manager.config().credential_target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            crate::ai::credentials::write(&target, &key)?;
            crate::ai::credentials::hint(&target)
                .ok_or_else(|| "no se pudo leer la clave guardada".to_owned())
        }
        #[cfg(not(windows))]
        {
            let _ = (target, key);
            Err("Solo disponible en Windows.".to_owned())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ai_delete_api_key(manager: State<'_, AiManager>) -> Result<bool, String> {
    let target = manager.config().credential_target.clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            crate::ai::credentials::delete(&target)
        }
        #[cfg(not(windows))]
        {
            let _ = target;
            Ok(false)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replaces the values of this process's sensitive environment variables in `texts`.
#[tauri::command]
pub fn ai_scrub_env(texts: Vec<String>) -> secrets::Scrubbed {
    secrets::scrub(texts, &secrets::sensitive_vars(std::env::vars()))
}
