//! PTY layer: owns shells and pseudoconsoles. It does not depend on Tauri, so it can be
//! exercised headless (see `tests/pty.rs`).

mod agents;
mod error;
#[cfg(windows)]
pub(crate) mod job;
mod manager;
mod nested;
mod platform;
#[cfg(windows)]
mod procs;
mod session;
mod shell;
mod teardown;
mod wsl;

pub use agents::ShiftEnterTarget;
pub use error::PtyError;
pub use manager::{PtyManager, SessionId};
pub use nested::{NESTED_SESSION_VARS, is_nested_session_var};
pub use platform::{PtyBackend, backend};
pub use session::{
    FLUSH_INTERVAL, MAX_BATCH_BYTES, OutputStatsSnapshot, SessionEvents, SpawnOptions,
};
pub use shell::{
    Integration, Launch, Shell, ShellCommand, ShellKind, ShellProfile, ShellSpec, available_shells,
    default_cwd, default_shell, expand_env, find_on_path, kind_of, launch, resolve, resolve_cwd,
    shell_profile,
};
pub use teardown::BusyProcess;
pub use wsl::installed_distros;
