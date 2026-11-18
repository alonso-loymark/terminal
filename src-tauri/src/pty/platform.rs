//! Describes the PTY backend to the frontend (xterm's `windowsPty` option).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyBackend {
    pub backend: &'static str,
    /// Windows build number; xterm enables ConPTY-aware reflow from build 21376 on.
    pub build_number: Option<u32>,
}

#[cfg(windows)]
pub fn backend() -> Option<PtyBackend> {
    Some(PtyBackend {
        backend: "conpty",
        build_number: windows_build_number(),
    })
}

/// No Windows pseudoconsole on this platform.
#[cfg(not(windows))]
pub fn backend() -> Option<PtyBackend> {
    None
}

#[cfg(windows)]
fn windows_build_number() -> Option<u32> {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    // SAFETY: an all-zero OSVERSIONINFOW is valid; its size field is set before the call.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a writable, correctly sized OSVERSIONINFOW. Unlike GetVersionEx,
    // RtlGetVersion is not subject to manifest-based version lies.
    let status = unsafe { RtlGetVersion(&mut info) };
    (status == 0).then_some(info.dwBuildNumber)
}
