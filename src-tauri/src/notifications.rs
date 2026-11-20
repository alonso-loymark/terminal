//! Native notifications (Windows toasts) for what programs in the terminal ask for (BEL, OSC 9,
//! OSC 777) and for AI agents that wait for the user. The frontend decides when (only for panes
//! that are not on screen); a click brings the window to the front and tells the frontend which
//! pane to focus, through the channel it registered.
//!
//! An unpackaged app needs its AppUserModelID registered to show toasts: it goes under
//! `HKCU\Software\Classes\AppUserModelId\<identifier>` (name and icon), like the Windows App SDK
//! does for unpackaged apps. The click arrives in-process (`ToastNotification::Activated`), so
//! the toast objects are kept alive.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};

/// End-to-end tests: notifications are appended to this file (one JSON line each) instead of
/// showing on the user's screen.
pub const LOG_VAR: &str = "BRISA_NOTIFY_LOG";
/// Toasts kept for their click events; older ones are let go (Windows drops them anyway).
const KEEP: usize = 32;

/// Sent to the frontend when a notification is clicked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activation {
    /// What the frontend gave as the notification's tag (the pane to focus).
    tag: String,
}

#[derive(Default)]
pub struct NotificationState {
    channel: Mutex<Option<Channel<Activation>>>,
    #[cfg(windows)]
    shown: Mutex<Vec<windows::UI::Notifications::ToastNotification>>,
    #[cfg(windows)]
    registered: Mutex<bool>,
}

/// A notification was clicked: window to the front, then the pane.
pub fn activate<R: Runtime>(app: &AppHandle<R>, tag: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let state = app.state::<NotificationState>();
    let channel = state.channel.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(channel) = channel.as_ref() {
        let _ = channel.send(Activation {
            tag: tag.to_owned(),
        });
    }
}

/// `<`, `>`, `&` and quotes for the toast's XML.
pub fn escape_xml(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Control characters are not valid XML 1.0.
            c if (c as u32) < 0x20 && !matches!(c, '\n' | '\t') => {}
            c => out.push(c),
        }
    }
    out
}

/// The toast: a title and a body, nothing that needs network or extra assets.
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        "<toast><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape_xml(title),
        escape_xml(body)
    )
}

/// The frontend registers where clicks go (again after a reload).
#[tauri::command]
pub fn notifications_listen(state: State<'_, NotificationState>, on_activate: Channel<Activation>) {
    *state.channel.lock().unwrap_or_else(PoisonError::into_inner) = Some(on_activate);
}

#[tauri::command]
pub async fn notify(
    app: AppHandle,
    title: String,
    body: String,
    tag: String,
) -> Result<(), String> {
    if let Some(log) = std::env::var_os(LOG_VAR).filter(|v| !v.is_empty()) {
        let line = serde_json::json!({ "title": title, "body": body, "tag": tag });
        return std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(PathBuf::from(log))
            .and_then(|mut file| writeln!(file, "{line}"))
            .map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || show(&app, &title, &body, &tag))
        .await
        .map_err(|e| format!("tarea interrumpida: {e}"))?
}

/// Development only: what a click on the notification does (the e2e cannot click a toast).
#[tauri::command]
pub fn debug_notification_click(app: AppHandle, tag: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("solo en desarrollo".to_owned());
    }
    activate(&app, &tag);
    Ok(())
}

/// Development only: tags of Brisa's toasts in the Action Center (to check that Windows took
/// one), clearing them with `clear`.
#[tauri::command]
pub fn debug_notification_history(app: AppHandle, clear: bool) -> Result<Vec<String>, String> {
    if !cfg!(debug_assertions) {
        return Err("solo en desarrollo".to_owned());
    }
    history(&app, clear)
}

#[cfg(windows)]
fn show<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str, tag: &str) -> Result<(), String> {
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;

    let aumid = app.config().identifier.clone();
    register(app, &aumid);
    let result = (|| -> windows::core::Result<ToastNotification> {
        let xml = XmlDocument::new()?;
        xml.LoadXml(&HSTRING::from(toast_xml(title, body)))?;
        let toast = ToastNotification::CreateToastNotification(&xml)?;
        // One per pane at a time: a newer one replaces the older.
        let short: String = tag.chars().take(60).collect();
        toast.SetTag(&HSTRING::from(short))?;
        toast.SetGroup(&HSTRING::from("brisa"))?;
        let handle = app.clone();
        let clicked = tag.to_owned();
        toast.Activated(&TypedEventHandler::new(move |_, _| {
            activate(&handle, &clicked);
            Ok(())
        }))?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(aumid.as_str()))?
            .Show(&toast)?;
        Ok(toast)
    })();
    let toast = result.map_err(|e| format!("notificación: {e}"))?;
    let state = app.state::<NotificationState>();
    let mut shown = state.shown.lock().unwrap_or_else(PoisonError::into_inner);
    shown.push(toast);
    if shown.len() > KEEP {
        let extra = shown.len() - KEEP;
        shown.drain(..extra);
    }
    Ok(())
}

#[cfg(not(windows))]
fn show<R: Runtime>(_: &AppHandle<R>, _: &str, _: &str, _: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn history<R: Runtime>(app: &AppHandle<R>, clear: bool) -> Result<Vec<String>, String> {
    use windows::UI::Notifications::ToastNotificationManager;
    use windows::core::HSTRING;

    let aumid = HSTRING::from(app.config().identifier.as_str());
    let run = || -> windows::core::Result<Vec<String>> {
        let history = ToastNotificationManager::History()?;
        let tags = history
            .GetHistoryWithId(&aumid)?
            .into_iter()
            .filter_map(|toast| toast.Tag().ok().map(|t| t.to_string()))
            .collect();
        if clear {
            history.ClearWithId(&aumid)?;
        }
        Ok(tags)
    };
    run().map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn history<R: Runtime>(_: &AppHandle<R>, _: bool) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}

/// Registers the app's AppUserModelID (name and icon of its toasts) once per run.
#[cfg(windows)]
fn register<R: Runtime>(app: &AppHandle<R>, aumid: &str) {
    let state = app.state::<NotificationState>();
    let mut done = state
        .registered
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    if *done {
        return;
    }
    *done = true;
    let icon = app.path().app_local_data_dir().ok().and_then(|dir| {
        let path = dir.join("brisa.png");
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&path, include_bytes!("../icons/128x128.png")).ok()?;
        Some(path)
    });
    if let Err(error) = registry::register_aumid(aumid, "Brisa", icon.as_deref()) {
        eprintln!("[brisa] no se pudo registrar las notificaciones: {error}");
    }
}

#[cfg(windows)]
mod registry {
    use std::path::Path;
    use std::ptr::null_mut;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ, RegCloseKey,
        RegCreateKeyExW, RegSetValueExW,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    /// `HKCU\Software\Classes\AppUserModelId\<aumid>` with DisplayName and IconUri.
    pub(super) fn register_aumid(aumid: &str, name: &str, icon: Option<&Path>) -> Result<(), u32> {
        let key_path = wide(&format!(r"Software\Classes\AppUserModelId\{aumid}"));
        let mut key: HKEY = null_mut();
        // SAFETY: valid null-terminated strings; the key handle is closed below.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key_path.as_ptr(),
                0,
                null_mut(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                null_mut(),
                &mut key,
                null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            return Err(status);
        }
        let set = |value: &str, data: &str| {
            let value = wide(value);
            let data = wide(data);
            // SAFETY: `data` is a null-terminated UTF-16 buffer of the given byte length.
            unsafe {
                RegSetValueExW(
                    key,
                    value.as_ptr(),
                    0,
                    REG_SZ,
                    data.as_ptr().cast(),
                    (data.len() * 2) as u32,
                )
            }
        };
        let mut result = set("DisplayName", name);
        if let Some(icon) = icon
            && result == ERROR_SUCCESS
        {
            result = set("IconUri", &icon.display().to_string());
        }
        // SAFETY: opened above.
        unsafe { RegCloseKey(key) };
        if result == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(result)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_text_is_escaped() {
        assert_eq!(
            escape_xml("a < b & \"c\" > 'd'"),
            "a &lt; b &amp; &quot;c&quot; &gt; &apos;d&apos;"
        );
        // Control characters (an ESC that slipped through) are dropped.
        assert_eq!(escape_xml("hola\u{1b}\u{7}"), "hola");
        let xml = toast_xml("Claude <espera>", "Necesita tu respuesta");
        assert!(
            xml.contains("<text>Claude &lt;espera&gt;</text><text>Necesita tu respuesta</text>")
        );
    }
}
