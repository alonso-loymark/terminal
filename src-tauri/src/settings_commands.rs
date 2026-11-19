//! Tauri commands for the settings file and the window's look: thin adapters over
//! [`crate::settings`]. The frontend watches the folder with the explorer's watcher.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::window::{Color, Effect, EffectsBuilder};
use tauri::{State, WebviewWindow};

use crate::settings::{self, Backdrop, SCHEMA_FILE, SETTINGS_FILE};

/// Where the settings live, and how the window was created (decided once, at startup).
pub struct SettingsState {
    pub dir: PathBuf,
    pub window_transparent: bool,
}

impl SettingsState {
    fn file(&self) -> PathBuf {
        self.dir.join(SETTINGS_FILE)
    }
}

/// Runs blocking file work off the main thread; errors reach the frontend as text.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> std::io::Result<T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
        .map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsFile {
    path: String,
    dir: String,
    /// None while the file does not exist.
    text: Option<String>,
    /// The window can show a backdrop / translucency (it was created transparent).
    window_transparent: bool,
}

#[tauri::command]
pub async fn settings_load(state: State<'_, SettingsState>) -> Result<SettingsFile, String> {
    let path = state.file();
    let dir = state.dir.clone();
    let window_transparent = state.window_transparent;
    blocking(move || {
        Ok(SettingsFile {
            text: settings::read(&path)?,
            path: path.display().to_string(),
            dir: dir.display().to_string(),
            window_transparent,
        })
    })
    .await
}

#[tauri::command]
pub async fn settings_read(state: State<'_, SettingsState>) -> Result<Option<String>, String> {
    let path = state.file();
    blocking(move || settings::read(&path)).await
}

#[tauri::command]
pub async fn settings_write(state: State<'_, SettingsState>, text: String) -> Result<(), String> {
    let path = state.file();
    blocking(move || settings::write(&path, &text)).await
}

/// The JSON Schema next to the file, for completions and hover help in VS Code.
#[tauri::command]
pub async fn settings_write_schema(
    state: State<'_, SettingsState>,
    text: String,
) -> Result<(), String> {
    let path = state.dir.join(SCHEMA_FILE);
    blocking(move || settings::write_if_changed(&path, &text).map(|_| ())).await
}

/// Opens settings.json in VS Code; without VS Code, in the app Windows associates with .json.
#[tauri::command]
pub async fn settings_open(state: State<'_, SettingsState>) -> Result<(), String> {
    let path = state.file();
    tauri::async_runtime::spawn_blocking(move || open_settings_file(&path))
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
}

fn open_settings_file(path: &Path) -> Result<(), String> {
    if crate::explorer::open_in_vscode(path).is_ok() {
        return Ok(());
    }
    crate::explorer::open_with_default_app(path).map_err(|e| e.to_string())
}

/// A theme file dropped on the settings screen.
#[tauri::command]
pub async fn read_theme_file(path: String) -> Result<String, String> {
    blocking(move || settings::read_theme_file(&PathBuf::from(path))).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowLookResult {
    /// The effect is on screen now.
    applied: bool,
    /// The window was created opaque: translucency needs a restart.
    restart_required: bool,
}

/// Applies the backdrop (Mica, Acrylic or none) and the window's background color. Only a
/// window created transparent can show a backdrop or translucency.
#[tauri::command]
pub fn set_window_look(
    window: WebviewWindow,
    state: State<'_, SettingsState>,
    backdrop: Backdrop,
    translucent: bool,
    dark: bool,
    background: Option<String>,
) -> Result<WindowLookResult, String> {
    let wants_transparency = backdrop != Backdrop::None || translucent;
    if !state.window_transparent {
        // What shows while resizing, and before the page paints.
        if let Some(color) = background.as_deref().and_then(parse_hex) {
            window
                .set_background_color(Some(color))
                .map_err(|e| e.to_string())?;
        }
        return Ok(WindowLookResult {
            applied: !wants_transparency,
            restart_required: wants_transparency,
        });
    }
    let effect = match backdrop {
        Backdrop::None => None,
        Backdrop::Mica if dark => Some(Effect::MicaDark),
        Backdrop::Mica => Some(Effect::MicaLight),
        Backdrop::Acrylic => Some(Effect::Acrylic),
    };
    let effects = effect.map(|effect| EffectsBuilder::new().effect(effect).build());
    window.set_effects(effects).map_err(|e| e.to_string())?;
    Ok(WindowLookResult {
        applied: true,
        restart_required: false,
    })
}

/// `#rrggbb` → an opaque color.
fn parse_hex(text: &str) -> Option<Color> {
    let hex = text.strip_prefix('#')?;
    if hex.len() < 6 {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok();
    Some(Color(channel(0)?, channel(2)?, channel(4)?, 255))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_colors_parse() {
        assert_eq!(parse_hex("#0d1117"), Some(Color(13, 17, 23, 255)));
        assert_eq!(parse_hex("#0d1117cc"), Some(Color(13, 17, 23, 255)));
        assert_eq!(parse_hex("0d1117"), None);
        assert_eq!(parse_hex("#fff"), None);
        assert_eq!(parse_hex("#zz1117"), None);
    }
}
