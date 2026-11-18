mod commands;
pub mod pty;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::pty::PtyManager;

pub fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_to_session,
            commands::resize_session,
            commands::close_session,
            commands::send_shift_enter,
            commands::session_busy,
            commands::system_info,
            commands::pty_backend,
        ])
        .on_page_load(|webview, payload| {
            // A reloaded page can no longer receive its sessions' channels: close them.
            if payload.event() == PageLoadEvent::Started {
                webview
                    .state::<PtyManager>()
                    .close_owned_by(webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                window.state::<PtyManager>().close_owned_by(window.label());
            }
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<PtyManager>().shutdown();
        }
    });
    Ok(())
}
