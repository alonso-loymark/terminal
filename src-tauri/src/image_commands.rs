//! Images for the terminals: pasted ones saved as files, and drops from other apps (files, and
//! images that are not files) delivered to the page through a channel. The logic lives in
//! `images.rs` and `dragdrop.rs`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{State, WebviewWindow};

use crate::dragdrop::{self, DropEvent, Dropped, ImageSource};
use crate::images;

/// What the page hears about a drag (positions in physical pixels of the page).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DropMessage {
    Over {
        x: i32,
        y: i32,
        image: bool,
    },
    Leave,
    Drop {
        x: i32,
        y: i32,
        paths: Vec<String>,
    },
    /// The bytes wait in Rust: the page takes them with `take_dropped_image`.
    DropImage {
        x: i32,
        y: i32,
        id: u32,
        name: String,
    },
}

/// Dropped images the page has not taken yet (at most a few).
const KEEP_DROPPED: usize = 4;

#[derive(Default)]
pub struct DropState {
    channel: Mutex<Option<Channel<DropMessage>>>,
    images: Mutex<Vec<(u32, Vec<u8>)>>,
    next: AtomicU32,
}

impl DropState {
    fn deliver(&self, event: DropEvent) {
        let message = match event {
            DropEvent::Over { x, y, image } => DropMessage::Over { x, y, image },
            DropEvent::Leave => DropMessage::Leave,
            DropEvent::Drop {
                x,
                y,
                dropped: Dropped::Files(paths),
            } => DropMessage::Drop {
                x,
                y,
                paths: paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect(),
            },
            DropEvent::Drop {
                x,
                y,
                dropped: Dropped::Image { bytes, name },
            } => {
                let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
                let mut images = self.images.lock().unwrap_or_else(PoisonError::into_inner);
                images.push((id, bytes));
                let excess = images.len().saturating_sub(KEEP_DROPPED);
                images.drain(..excess);
                DropMessage::DropImage { x, y, id, name }
            }
        };
        if let Some(channel) = self
            .channel
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
        {
            let _ = channel.send(message);
        }
    }
}

/// The page listens for drops (on each load): Brisa's drop target replaces wry's on the
/// WebView2 windows.
#[tauri::command]
pub fn drop_listen(
    window: WebviewWindow,
    state: State<'_, DropState>,
    on_event: Channel<DropMessage>,
) -> Result<(), String> {
    *state.channel.lock().unwrap_or_else(PoisonError::into_inner) = Some(on_event);
    #[cfg(windows)]
    {
        use std::rc::Rc;
        use tauri::Manager;
        let top = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let app = window.app_handle().clone();
        window
            .run_on_main_thread(move || {
                let sink: Rc<dyn Fn(DropEvent)> =
                    Rc::new(move |event| app.state::<DropState>().deliver(event));
                let windows = dragdrop::register(top, sink);
                #[cfg(debug_assertions)]
                eprintln!("[brisa] drop target en {windows} ventanas");
                let _ = windows;
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

/// The bytes of a dropped image (once).
#[tauri::command]
pub fn take_dropped_image(state: State<'_, DropState>, id: u32) -> Result<Response, String> {
    let mut images = state.images.lock().unwrap_or_else(PoisonError::into_inner);
    let at = images
        .iter()
        .position(|(i, _)| *i == id)
        .ok_or("la imagen ya no está")?;
    Ok(Response::new(images.remove(at).1))
}

/// Saves a PNG (the raw request body) in Brisa's temporary folder and returns its path.
#[tauri::command]
pub async fn save_pasted_image(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("se esperaban los bytes de la imagen".to_owned());
    };
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || images::save_png(&images::images_dir(), &bytes))
        .await
        .map_err(|e| e.to_string())?
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|e| e.to_string())
}

/// Development only: a drop as if from another app, through the same path as a real one
/// (the e2e cannot drag from another process). `image` comes as a virtual file, "PNG" or a DIB.
#[tauri::command]
pub fn debug_drop(
    state: State<'_, DropState>,
    x: i32,
    y: i32,
    paths: Option<Vec<String>>,
    image: Option<Vec<u8>>,
    format: Option<String>,
    name: Option<String>,
) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("solo en desarrollo".to_owned());
    }
    let dropped = match (paths, image) {
        (Some(paths), _) => Dropped::Files(paths.into_iter().map(PathBuf::from).collect()),
        (None, Some(bytes)) => {
            let source = match format.as_deref() {
                Some("png") => ImageSource::Png,
                Some("dib") => ImageSource::Dib,
                _ => ImageSource::File,
            };
            dragdrop::image_from(source, bytes, name.as_deref().unwrap_or(""))
                .ok_or("no es una imagen")?
        }
        (None, None) => return Err("nada que soltar".to_owned()),
    };
    state.deliver(DropEvent::Over {
        x,
        y,
        image: matches!(dropped, Dropped::Image { .. }),
    });
    state.deliver(DropEvent::Drop { x, y, dropped });
    Ok(())
}
