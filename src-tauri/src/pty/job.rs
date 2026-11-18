//! Windows Job Object that tracks a shell's whole process tree.
//!
//! Every process the shell starts (and their children) joins the job, including processes in
//! their own hidden console that would survive the pseudoconsole closing. On an orderly close
//! the session kills members selectively (see `teardown.rs`); `KILL_ON_JOB_CLOSE` stays armed
//! until then, so if the app crashes the OS kills the whole tree when it closes our handle.
//! `BREAKAWAY_OK` lets processes that explicitly ask for `CREATE_BREAKAWAY_FROM_JOB` escape
//! instead of failing to start.

use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::RawHandle;
use std::ptr::{addr_of, null, null_mut};

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_BASIC_PROCESS_ID_LIST,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicProcessIdList,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE, TerminateProcess,
};

use super::procs::OwnedHandle;

/// More processes than any terminal session should ever hold at once.
const MAX_LISTED_PROCESSES: usize = 4096;

pub(crate) struct Job(HANDLE);

// SAFETY: a job handle is a kernel object handle; the job APIs may be called from any thread.
unsafe impl Send for Job {}
// SAFETY: see above; `Job` exposes no interior state besides the handle.
unsafe impl Sync for Job {}

impl Job {
    pub(crate) fn kill_on_close() -> io::Result<Self> {
        // SAFETY: null attributes and name create an anonymous job with default security.
        let handle = unsafe { CreateJobObjectW(null(), null()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = Job(handle);
        job.set_kill_on_close(true)?;
        Ok(job)
    }

    /// Arms or disarms "closing the last handle kills every member".
    pub(crate) fn set_kill_on_close(&self, enabled: bool) -> io::Result<()> {
        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is valid ("no limits").
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK
            | if enabled {
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            } else {
                0
            };
        // SAFETY: the pointer and length describe `limits`, which outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    pub(crate) fn assign(&self, process: RawHandle) -> io::Result<()> {
        // SAFETY: both handles are valid for the duration of the call.
        if unsafe { AssignProcessToJobObject(self.0, process as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Ids of the processes currently in the job.
    pub(crate) fn process_ids(&self) -> Vec<u32> {
        // JOBOBJECT_BASIC_PROCESS_ID_LIST is two u32 counters followed by a variable usize
        // array; a usize buffer keeps it aligned on both 32- and 64-bit.
        let mut buf = vec![0usize; 2 + MAX_LISTED_PROCESSES];
        let bytes = (buf.len() * size_of::<usize>()) as u32;
        // SAFETY: `buf` is writable for `bytes` bytes and suitably aligned for the struct.
        let ok = unsafe {
            QueryInformationJobObject(
                self.0,
                JobObjectBasicProcessIdList,
                buf.as_mut_ptr().cast(),
                bytes,
                null_mut(),
            )
        };
        if ok == 0 {
            return Vec::new();
        }
        let list = buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
        // SAFETY: the API filled the header and `NumberOfProcessIdsInList` entries after it.
        unsafe {
            let count = ((*list).NumberOfProcessIdsInList as usize).min(MAX_LISTED_PROCESSES);
            let ids =
                std::slice::from_raw_parts(addr_of!((*list).ProcessIdList).cast::<usize>(), count);
            ids.iter().map(|&pid| pid as u32).collect()
        }
    }

    /// Terminates `pid` only if it is still a member of this job (guards against pid reuse).
    pub(crate) fn terminate_member(&self, pid: u32) -> bool {
        // SAFETY: the process handle is checked, used and closed by its guard.
        unsafe {
            let process = OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            );
            if process.is_null() {
                return false;
            }
            let _guard = OwnedHandle(process);
            let mut member = 0;
            IsProcessInJob(process, self.0, &mut member) != 0
                && member != 0
                && TerminateProcess(process, 1) != 0
        }
    }

    /// Kills every member at once. Last resort when selective teardown is impossible.
    pub(crate) fn terminate(&self) {
        // SAFETY: `self.0` is a valid job handle until `drop`.
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: we own the handle and close it exactly once.
        unsafe { CloseHandle(self.0) };
    }
}
