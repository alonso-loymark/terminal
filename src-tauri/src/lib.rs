mod commands;
pub mod explorer;
mod explorer_commands;
pub mod pty;

use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, WindowEvent};

use crate::explorer::WatchManager;
use crate::pty::PtyManager;

pub fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .manage(WatchManager::new())
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_to_session,
            commands::resize_session,
            commands::close_session,
            commands::send_shift_enter,
            commands::session_busy,
            commands::system_info,
            commands::pty_backend,
            explorer_commands::list_dir,
            explorer_commands::watch_start,
            explorer_commands::watch_set,
            explorer_commands::watch_stop,
            explorer_commands::git_status,
            explorer_commands::create_entry,
            explorer_commands::rename_entry,
            explorer_commands::trash_entries,
            explorer_commands::open_in_vscode,
            explorer_commands::open_in_file_manager,
        ])
        .on_page_load(|webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!(
                "[terminal] page load {:?} in {}: {}",
                payload.event(),
                webview.label(),
                payload.url()
            );
            // A reloaded page can no longer receive its channels: close its sessions and
            // release its file watchers.
            if payload.event() == PageLoadEvent::Started {
                webview
                    .state::<PtyManager>()
                    .close_owned_by(webview.label());
                webview
                    .state::<WatchManager>()
                    .stop_owned_by(webview.label());
            }
        })
        .on_window_event(|window, event| {
            // Dev builds: window lifecycle in the `tauri dev` log (diagnosing e2e runs).
            #[cfg(debug_assertions)]
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                eprintln!("[terminal] window {}: {event:?}", window.label());
            }
            if let WindowEvent::Destroyed = event {
                window.state::<PtyManager>().close_owned_by(window.label());
                window.state::<WatchManager>().stop_owned_by(window.label());
            }
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        #[cfg(debug_assertions)]
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            eprintln!("[terminal] {event:?}");
        }
        if let RunEvent::Exit = event {
            app.state::<PtyManager>().shutdown();
            app.state::<WatchManager>().shutdown();
        }
    });
    Ok(())
}
