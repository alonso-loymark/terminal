//! Tauri commands for the app's files (settings.json, the session, saved layouts) and the
//! window's look: thin adapters over [`crate::settings`]. The frontend watches the folder with
//! the explorer's watcher.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::window::{Color, Effect, EffectsBuilder};
use tauri::{State, WebviewWindow};

use crate::settings::{self, Backdrop, ConfigFile};

/// Where the app's files live, and how the window was created (decided once, at startup).
pub struct SettingsState {
    pub dir: PathBuf,
    pub window_transparent: bool,
    /// The window was created with Windows' own title bar (`appearance.titleBar: "native"`).
    pub native_title_bar: bool,
}

impl SettingsState {
    fn file(&self, file: ConfigFile) -> PathBuf {
        self.dir.join(file.name())
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
    /// The window has Windows' own title bar (as created, or as last set live).
    native_title_bar: bool,
}

#[tauri::command]
pub async fn settings_load(state: State<'_, SettingsState>) -> Result<SettingsFile, String> {
    let path = state.file(ConfigFile::Settings);
    let dir = state.dir.clone();
    let window_transparent = state.window_transparent;
    let native_title_bar = state.native_title_bar;
    blocking(move || {
        Ok(SettingsFile {
            text: settings::read(&path)?,
            path: path.display().to_string(),
            dir: dir.display().to_string(),
            window_transparent,
            native_title_bar,
        })
    })
    .await
}

/// One of the app's files; None while it does not exist.
#[tauri::command]
pub async fn config_read(
    state: State<'_, SettingsState>,
    file: ConfigFile,
) -> Result<Option<String>, String> {
    let path = state.file(file);
    blocking(move || settings::read(&path)).await
}

/// Replaces the file atomically (a crash leaves the previous version, never half of one).
/// `only_if_changed`: skip identical content (the schemas are generated at every start).
#[tauri::command]
pub async fn config_write(
    state: State<'_, SettingsState>,
    file: ConfigFile,
    text: String,
    only_if_changed: Option<bool>,
) -> Result<(), String> {
    let path = state.file(file);
    blocking(move || {
        if only_if_changed.unwrap_or(false) {
            settings::write_if_changed(&path, &text).map(|_| ())
        } else {
            settings::write(&path, &text)
        }
    })
    .await
}

/// Opens settings.json or layouts.json in VS Code; without VS Code, in the app Windows
/// associates with .json.
#[tauri::command]
pub async fn config_open(state: State<'_, SettingsState>, file: ConfigFile) -> Result<(), String> {
    if !file.editable() {
        return Err(format!("{} no se abre en un editor", file.name()));
    }
    let path = state.file(file);
    tauri::async_runtime::spawn_blocking(move || open_config_file(&path))
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
}

fn open_config_file(path: &Path) -> Result<(), String> {
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
