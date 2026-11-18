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
pub use shell::{ShellCommand, default_cwd, default_shell, find_on_path};
pub use teardown::BusyProcess;
