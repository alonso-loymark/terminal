//! The custom title bar (tabs in the same bar as minimize / maximize / close).
//!
//! The page draws the caption buttons, but Windows 11 only offers Snap Layouts when the window
//! answers `WM_NCHITTEST` with `HTMAXBUTTON` over the maximize button, and the WebView covers
//! the whole client area. So, like Windows Terminal, a native child window sits over the three
//! buttons: layered and without a redirection bitmap, it draws nothing (the page's buttons show
//! through) but receives the mouse. It answers the hit test, tells the page which button is
//! hovered or pressed (the page paints the state) and runs the button on release. Dragging the
//! window and double-click to maximize come from Tauri's `data-tauri-drag-region`.
//!
//! The overlay lives on the main thread (the window's thread), created on demand when the page
//! reports where its buttons are, and destroyed in native title bar mode.

use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
use tauri::ipc::Channel;

/// Where the page's caption buttons are, in physical pixels of the client area (the page
/// converts with its own `devicePixelRatio`, which is what maps its pixels to the screen).
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ButtonsRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Minimize,
    Maximize,
    Close,
}

/// What the page paints on its buttons while the overlay owns the mouse.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionState {
    /// The native overlay is in place: hover and clicks come from it, not from the page.
    pub native: bool,
    pub hover: Option<Button>,
    pub pressed: Option<Button>,
}

/// The three buttons share the width equally, left to right.
pub fn button_at(width: i32, x: i32) -> Option<Button> {
    if width <= 0 || x < 0 || x >= width {
        return None;
    }
    Some(match x * 3 / width {
        0 => Button::Minimize,
        1 => Button::Maximize,
        _ => Button::Close,
    })
}

static LISTENER: Mutex<Option<Channel<CaptionState>>> = Mutex::new(None);

fn emit(state: CaptionState) {
    if let Some(channel) = LISTENER
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .as_ref()
    {
        let _ = channel.send(state);
    }
}

/// The page subscribes to the caption buttons' state (hover, pressed, overlay in place).
#[tauri::command]
pub fn titlebar_listen(on_event: Channel<CaptionState>) {
    *LISTENER.lock().unwrap_or_else(PoisonError::into_inner) = Some(on_event);
}

/// The page's caption buttons moved (layout, resize, DPI) or went away (native title bar).
#[tauri::command]
pub fn titlebar_buttons(window: WebviewWindow, rect: Option<ButtonsRect>) -> Result<(), String> {
    #[cfg(windows)]
    {
        let parent = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let physical = rect.map(|r| {
            (
                r.x.round() as i32,
                r.y.round() as i32,
                r.width.round() as i32,
                r.height.round() as i32,
            )
        });
        window
            .run_on_main_thread(move || overlay::place(parent, physical))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = (window, rect);
        emit(CaptionState {
            native: false,
            hover: None,
            pressed: None,
        });
    }
    Ok(())
}

/// `appearance.titleBar`, live: Windows' own title bar, or the tabs in ours.
#[tauri::command]
pub fn set_title_bar(window: WebviewWindow, custom: bool) -> Result<(), String> {
    window.set_decorations(!custom).map_err(|e| e.to_string())?;
    // Undecorated: keep the shadow, the resize borders and (Windows 11) the rounded corners.
    window.set_shadow(custom).map_err(|e| e.to_string())?;
    if !custom {
        titlebar_buttons(window, None)?;
    }
    Ok(())
}

/// The window is gone: so is its overlay (a child window dies with its parent).
pub fn forget() {
    #[cfg(windows)]
    overlay::forget();
}

#[cfg(windows)]
mod overlay {
    use std::sync::{Mutex, OnceLock, PoisonError};

    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::ScreenToClient;
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, HTCLOSE, HTMAXBUTTON, HTMINBUTTON,
        HTNOWHERE, HWND_TOP, IDC_ARROW, IsZoomed, LoadCursorW, PostMessageW, RegisterClassW,
        SC_CLOSE, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, SWP_NOACTIVATE, SWP_SHOWWINDOW, SetCursor,
        SetWindowPos, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
        WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SETCURSOR, WM_SYSCOMMAND, WNDCLASSW, WS_CHILD,
        WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOREDIRECTIONBITMAP, WS_VISIBLE,
    };

    use super::{Button, CaptionState, button_at, emit};

    struct Overlay {
        hwnd: isize,
        parent: isize,
        width: i32,
        hover: Option<Button>,
        pressed: Option<Button>,
    }

    static OVERLAY: Mutex<Option<Overlay>> = Mutex::new(None);

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn class_name() -> &'static [u16] {
        static NAME: OnceLock<Vec<u16>> = OnceLock::new();
        NAME.get_or_init(|| wide("BrisaCaptionButtons"))
    }

    fn register_class() -> bool {
        static REGISTERED: OnceLock<bool> = OnceLock::new();
        *REGISTERED.get_or_init(|| {
            // SAFETY: a static class name and window procedure; the struct outlives the call.
            unsafe {
                let class = WNDCLASSW {
                    lpfnWndProc: Some(window_proc),
                    hInstance: GetModuleHandleW(std::ptr::null()),
                    lpszClassName: class_name().as_ptr(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    ..Default::default()
                };
                RegisterClassW(&class) != 0
            }
        })
    }

    fn state_of(o: &Overlay) -> CaptionState {
        CaptionState {
            native: true,
            hover: o.hover,
            pressed: o.pressed,
        }
    }

    /// Creates, moves or (with `None`) destroys the overlay. Main thread only.
    pub fn place(parent: isize, rect: Option<(i32, i32, i32, i32)>) {
        let mut slot = OVERLAY.lock().unwrap_or_else(PoisonError::into_inner);
        let Some((x, y, w, h)) = rect else {
            if let Some(old) = slot.take() {
                // SAFETY: a window this thread created.
                unsafe { DestroyWindow(old.hwnd as HWND) };
            }
            drop(slot);
            emit(CaptionState {
                native: false,
                hover: None,
                pressed: None,
            });
            return;
        };
        if slot.as_ref().is_some_and(|o| o.parent != parent)
            && let Some(old) = slot.take()
        {
            // SAFETY: a window this thread created.
            unsafe { DestroyWindow(old.hwnd as HWND) };
        }
        if slot.is_none() {
            if !register_class() {
                drop(slot);
                emit(CaptionState {
                    native: false,
                    hover: None,
                    pressed: None,
                });
                return;
            }
            // Layered + no redirection bitmap: invisible (the page shows through) yet it gets
            // the mouse. Child layered windows need Windows 8+ in the app manifest (build.rs).
            // SAFETY: registered class, valid parent window of this thread.
            let hwnd = unsafe {
                CreateWindowExW(
                    WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP,
                    class_name().as_ptr(),
                    std::ptr::null(),
                    WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS,
                    x,
                    y,
                    w,
                    h,
                    parent as HWND,
                    std::ptr::null_mut(),
                    GetModuleHandleW(std::ptr::null()),
                    std::ptr::null(),
                )
            };
            if hwnd.is_null() {
                eprintln!(
                    "titlebar: caption overlay not created ({}); no Snap Layouts",
                    std::io::Error::last_os_error()
                );
                drop(slot);
                emit(CaptionState {
                    native: false,
                    hover: None,
                    pressed: None,
                });
                return;
            }
            *slot = Some(Overlay {
                hwnd: hwnd as isize,
                parent,
                width: w,
                hover: None,
                pressed: None,
            });
        }
        let Some(overlay) = slot.as_mut() else { return };
        overlay.width = w;
        // Above the WebView's container (a sibling created later would cover it).
        // SAFETY: a window this thread created.
        unsafe {
            SetWindowPos(
                overlay.hwnd as HWND,
                HWND_TOP,
                x,
                y,
                w,
                h,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )
        };
        let state = state_of(overlay);
        drop(slot);
        emit(state);
    }

    pub fn forget() {
        *OVERLAY.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }

    fn hit_code(button: Option<Button>) -> u32 {
        match button {
            Some(Button::Minimize) => HTMINBUTTON,
            Some(Button::Maximize) => HTMAXBUTTON,
            Some(Button::Close) => HTCLOSE,
            None => HTNOWHERE,
        }
    }

    fn button_of(code: WPARAM) -> Option<Button> {
        match code as u32 {
            HTMINBUTTON => Some(Button::Minimize),
            HTMAXBUTTON => Some(Button::Maximize),
            HTCLOSE => Some(Button::Close),
            _ => None,
        }
    }

    /// Updates hover / pressed and tells the page.
    fn update(f: impl FnOnce(&mut Overlay)) -> Option<isize> {
        let mut slot = OVERLAY.lock().unwrap_or_else(PoisonError::into_inner);
        let overlay = slot.as_mut()?;
        let before = state_of(overlay);
        f(overlay);
        let after = state_of(overlay);
        let parent = overlay.parent;
        drop(slot);
        if after != before {
            emit(after);
        }
        Some(parent)
    }

    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_NCHITTEST => {
                let mut point = POINT {
                    x: (lparam & 0xffff) as i16 as i32,
                    y: ((lparam >> 16) & 0xffff) as i16 as i32,
                };
                // SAFETY: our own window; `point` is a valid POINT.
                unsafe { ScreenToClient(hwnd, &mut point) };
                let width = OVERLAY
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                    .map_or(0, |o| o.width);
                hit_code(button_at(width, point.x)) as LRESULT
            }
            WM_NCMOUSEMOVE => {
                let mut track = TRACKMOUSEEVENT {
                    cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                    dwFlags: TME_LEAVE | TME_NONCLIENT,
                    hwndTrack: hwnd,
                    dwHoverTime: 0,
                };
                // SAFETY: a valid TRACKMOUSEEVENT for our own window.
                unsafe { TrackMouseEvent(&mut track) };
                let hovered = button_of(wparam);
                update(|o| {
                    o.hover = hovered;
                    if o.pressed.is_some() && o.pressed != hovered {
                        o.pressed = None;
                    }
                });
                0
            }
            WM_NCMOUSELEAVE => {
                update(|o| {
                    o.hover = None;
                    o.pressed = None;
                });
                0
            }
            // Handled here: the default handling would run the old caption button tracking.
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                let button = button_of(wparam);
                update(|o| o.pressed = button);
                0
            }
            WM_NCLBUTTONUP => {
                let button = button_of(wparam);
                let mut released = None;
                let parent = update(|o| {
                    if o.pressed.is_some() && o.pressed == button {
                        released = button;
                    }
                    o.pressed = None;
                });
                if let (Some(button), Some(parent)) = (released, parent) {
                    let parent = parent as HWND;
                    // SAFETY: the overlay's parent window, alive while the overlay is.
                    let command = match button {
                        Button::Minimize => SC_MINIMIZE,
                        Button::Maximize if unsafe { IsZoomed(parent) } != 0 => SC_RESTORE,
                        Button::Maximize => SC_MAXIMIZE,
                        Button::Close => SC_CLOSE,
                    };
                    // SAFETY: posting a system command to a valid window.
                    unsafe { PostMessageW(parent, WM_SYSCOMMAND, command as WPARAM, 0) };
                }
                0
            }
            WM_SETCURSOR => {
                // SAFETY: the system arrow cursor.
                unsafe { SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_ARROW)) };
                1
            }
            // SAFETY: default handling for everything else.
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_equal_buttons() {
        assert_eq!(button_at(138, 0), Some(Button::Minimize));
        assert_eq!(button_at(138, 45), Some(Button::Minimize));
        assert_eq!(button_at(138, 46), Some(Button::Maximize));
        assert_eq!(button_at(138, 91), Some(Button::Maximize));
        assert_eq!(button_at(138, 92), Some(Button::Close));
        assert_eq!(button_at(138, 137), Some(Button::Close));
        assert_eq!(button_at(138, 138), None);
        assert_eq!(button_at(138, -1), None);
        assert_eq!(button_at(0, 0), None);
    }

    #[test]
    fn state_serializes_for_the_page() {
        let json = serde_json::to_string(&CaptionState {
            native: true,
            hover: Some(Button::Maximize),
            pressed: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"native":true,"hover":"maximize","pressed":null}"#);
    }
}
