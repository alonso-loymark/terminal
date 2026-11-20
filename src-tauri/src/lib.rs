pub mod ai;
mod ai_commands;
mod commands;
pub mod explorer;
mod explorer_commands;
mod notifications;
pub mod pty;
pub mod settings;
mod settings_commands;
pub mod worktree;

use tauri::webview::PageLoadEvent;
use tauri::window::{Color, Effect, EffectsBuilder};
use tauri::{App, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::ai::{AiConfig, AiManager, Endpoint};
use crate::explorer::WatchManager;
use crate::notifications::NotificationState;
use crate::pty::PtyManager;
use crate::settings::Backdrop;
use crate::settings_commands::SettingsState;

/// The main window, created here (not in tauri.conf.json) because transparency is fixed at
/// creation: only a user who asked for a backdrop or translucency gets a transparent window.
fn create_main_window(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let dir = settings::config_dir(app.path().app_config_dir().ok())
        .ok_or("no hay carpeta de configuración")?;
    let text = settings::read(&dir.join(settings::SETTINGS_FILE)).unwrap_or(None);
    let look = settings::window_look(text.as_deref());
    let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
        .title("Brisa")
        .inner_size(1100.0, 700.0)
        .min_inner_size(480.0, 280.0)
        .center()
        .transparent(look.transparent);
    if !look.transparent {
        builder = builder.background_color(Color(13, 17, 23, 255));
    }
    let window = builder.build()?;
    let effect = match look.backdrop {
        Backdrop::None => None,
        Backdrop::Mica => Some(Effect::Mica),
        Backdrop::Acrylic => Some(Effect::Acrylic),
    };
    if let Some(effect) = effect {
        // The frontend applies it again with the theme's light/dark variant.
        let _ = window.set_effects(EffectsBuilder::new().effect(effect).build());
    }
    app.manage(SettingsState {
        dir,
        window_transparent: look.transparent,
    });
    Ok(())
}

/// The AI layer's fixed settings. Dev builds take overrides from the environment so the e2e can
/// point it at its fakes (a fake `claude`, a local fake API, a throwaway credential): release
/// builds ignore them.
fn ai_config() -> AiConfig {
    let dev = |name: &str| {
        if cfg!(debug_assertions) {
            std::env::var(name).ok().filter(|v| !v.is_empty())
        } else {
            None
        }
    };
    AiConfig {
        work_dir: std::env::temp_dir().join("brisa-ai"),
        credential_target: dev("BRISA_CREDENTIAL_TARGET")
            .unwrap_or_else(|| AiConfig::CREDENTIAL_TARGET.to_owned()),
        api: dev("BRISA_ANTHROPIC_BASE_URL")
            .and_then(|url| Endpoint::parse(&url))
            .unwrap_or_else(|| Endpoint {
                secure: true,
                host: "api.anthropic.com".to_owned(),
                port: 443,
                base_path: String::new(),
            }),
        claude_override: dev("BRISA_CLAUDE_PATH").map(std::path::PathBuf::from),
    }
}

pub fn run() -> tauri::Result<()> {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .manage(AiManager::new(ai_config()))
        .manage(WatchManager::new())
        .manage(NotificationState::default())
        .setup(|app| create_main_window(app))
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::write_to_session,
            commands::resize_session,
            commands::close_session,
            commands::send_shift_enter,
            commands::session_busy,
            commands::system_info,
            commands::pty_backend,
            commands::session_agents,
            notifications::notifications_listen,
            notifications::notify,
            notifications::debug_notification_click,
            notifications::debug_notification_history,
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
            explorer_commands::worktree_create,
            explorer_commands::worktree_status,
            explorer_commands::worktree_remove,
            explorer_commands::worktree_list,
            settings_commands::settings_load,
            settings_commands::config_read,
            settings_commands::config_write,
            settings_commands::config_open,
            settings_commands::read_theme_file,
            settings_commands::set_window_look,
            ai_commands::ai_configure,
            ai_commands::ai_query,
            ai_commands::ai_cancel,
            ai_commands::ai_status,
            ai_commands::ai_set_api_key,
            ai_commands::ai_delete_api_key,
            ai_commands::ai_scrub_env,
        ])
        .on_page_load(|webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!(
                "[brisa] page load {:?} in {}: {}",
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
                webview
                    .state::<AiManager>()
                    .cancel_owned_by(webview.label());
            }
        })
        .on_window_event(|window, event| {
            // Dev builds: window lifecycle in the `tauri dev` log (diagnosing e2e runs).
            #[cfg(debug_assertions)]
            if matches!(
                event,
                WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
            ) {
                eprintln!("[brisa] window {}: {event:?}", window.label());
            }
            if let WindowEvent::Destroyed = event {
                window.state::<PtyManager>().close_owned_by(window.label());
                window.state::<WatchManager>().stop_owned_by(window.label());
                window.state::<AiManager>().cancel_owned_by(window.label());
            }
        })
        .build(tauri::generate_context!())?;

    app.run(|app, event| {
        #[cfg(debug_assertions)]
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            eprintln!("[brisa] {event:?}");
        }
        if let RunEvent::Exit = event {
            app.state::<PtyManager>().shutdown();
            app.state::<WatchManager>().shutdown();
            app.state::<AiManager>().shutdown();
        }
    });
    Ok(())
}
