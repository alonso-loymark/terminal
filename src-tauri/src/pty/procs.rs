//! Windows process introspection: the process table (Toolhelp), owners of visible windows and
//! command lines. Used to tear sessions down selectively and to detect AI agents.

use std::collections::HashSet;
use std::mem::{size_of, zeroed};
use std::ptr::null_mut;

use windows_sys::Wdk::System::Threading::{
    NtQueryInformationProcess, ProcessCommandLineInformation,
};
use windows_sys::Win32::Foundation::{
    CloseHandle, HANDLE, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT, UNICODE_STRING,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible,
};
use windows_sys::core::BOOL;

#[derive(Debug, Clone)]
pub(crate) struct ProcessEntry {
    pub(crate) pid: u32,
    pub(crate) parent: u32,
    /// Image file name, e.g. `node.exe`.
    pub(crate) exe: String,
}

/// Closes a kernel handle when dropped.
pub(crate) struct OwnedHandle(pub(crate) HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle is owned by this guard and closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

/// Every process on the system with its parent and image name.
pub(crate) fn snapshot() -> Vec<ProcessEntry> {
    // SAFETY: plain Toolhelp enumeration; `entry` is a correctly sized PROCESSENTRY32W and the
    // snapshot handle is closed by its guard.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Vec::new();
        }
        let _guard = OwnedHandle(snap);
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut processes = Vec::with_capacity(512);
        let mut ok = Process32FirstW(snap, &mut entry);
        while ok != 0 {
            let name = &entry.szExeFile;
            let len = name.iter().position(|&c| c == 0).unwrap_or(name.len());
            processes.push(ProcessEntry {
                pid: entry.th32ProcessID,
                parent: entry.th32ParentProcessID,
                exe: String::from_utf16_lossy(&name[..len]),
            });
            ok = Process32NextW(snap, &mut entry);
        }
        processes
    }
}

/// Processes that own at least one visible, non-empty top-level window on this desktop.
pub(crate) fn window_owners() -> HashSet<u32> {
    unsafe extern "system" fn collect(hwnd: HWND, param: LPARAM) -> BOOL {
        // SAFETY: `param` is the `&mut HashSet` passed to EnumWindows below, alive for the call.
        let owners = unsafe { &mut *(param as *mut HashSet<u32>) };
        // SAFETY: `hwnd` comes from EnumWindows; the out-pointers are valid locals.
        unsafe {
            if IsWindowVisible(hwnd) != 0 {
                let mut rect: RECT = zeroed();
                if GetWindowRect(hwnd, &mut rect) != 0
                    && rect.right > rect.left
                    && rect.bottom > rect.top
                {
                    let mut pid = 0;
                    GetWindowThreadProcessId(hwnd, &mut pid);
                    if pid != 0 {
                        owners.insert(pid);
                    }
                }
            }
        }
        1 // keep enumerating
    }

    let mut owners = HashSet::new();
    // SAFETY: the callback only touches `owners`, which outlives the synchronous enumeration.
    unsafe { EnumWindows(Some(collect), (&raw mut owners) as LPARAM) };
    owners
}

/// The full command line of another process (same user), if it can be read.
pub(crate) fn command_line(pid: u32) -> Option<String> {
    // SAFETY: the process handle is closed by its guard; the buffer is u64-aligned (enough for
    // the UNICODE_STRING header) and NtQueryInformationProcess writes at most `len` bytes into it.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let _guard = OwnedHandle(handle);
        let mut len = 0u32;
        // First call only reports the required size.
        NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            null_mut(),
            0,
            &mut len,
        );
        if len < size_of::<UNICODE_STRING>() as u32 {
            return None;
        }
        let mut buf = vec![0u64; (len as usize).div_ceil(8)];
        let status = NtQueryInformationProcess(
            handle,
            ProcessCommandLineInformation,
            buf.as_mut_ptr().cast(),
            len,
            &mut len,
        );
        if status < 0 {
            return None;
        }
        let text = &*buf.as_ptr().cast::<UNICODE_STRING>();
        if text.Buffer.is_null() {
            return None;
        }
        let chars = std::slice::from_raw_parts(text.Buffer, text.Length as usize / 2);
        Some(String::from_utf16_lossy(chars))
    }
}
