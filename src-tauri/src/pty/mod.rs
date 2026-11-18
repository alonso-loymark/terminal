//! PTY layer: owns shells and pseudoconsoles. It does not depend on Tauri, so it can be
//! exercised headless (see `tests/pty.rs`).

mod agents;
mod error;
#[cfg(windows)]
mod job;
mod manager;
mod platform;
#[cfg(windows)]
mod procs;
mod session;
mod shell;
mod teardown;

pub use agents::ShiftEnterTarget;
pub use error::PtyError;
pub use manager::{PtyManager, SessionId};
pub use platform::{PtyBackend, backend};
pub use session::{FLUSH_INTERVAL, MAX_BATCH_BYTES, SessionEvents, SpawnOptions};
pub use shell::{
    Launch, ShellCommand, ShellKind, ShellProfile, available_shells, default_cwd, default_shell,
    find_on_path, launch, resolve_cwd, shell_profile,
};
pub use teardown::BusyProcess;
