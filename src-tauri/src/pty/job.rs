//! Windows Job Object that ties a shell's whole process tree to its session.
//!
//! With `KILL_ON_JOB_CLOSE`, terminating the job (or closing its last handle, which the OS
//! does if the app crashes) kills the shell and every descendant, including processes that
//! run in their own hidden console and would otherwise survive the pseudoconsole closing.
//! `BREAKAWAY_OK` lets processes that explicitly ask for `CREATE_BREAKAWAY_FROM_JOB` escape
//! instead of failing to start.

use std::ffi::c_void;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::io::RawHandle;
use std::ptr::null;

use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};

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

        // SAFETY: an all-zero JOBOBJECT_EXTENDED_LIMIT_INFORMATION is valid ("no limits").
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        // SAFETY: the pointer and length describe `limits`, which outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(job)
    }

    pub(crate) fn assign(&self, process: RawHandle) -> io::Result<()> {
        // SAFETY: both handles are valid for the duration of the call.
        if unsafe { AssignProcessToJobObject(self.0, process as HANDLE) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Kills every process in the job. Returns immediately; termination is asynchronous.
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
