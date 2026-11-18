//! Registry of live sessions. Cheap to clone; every clone shares the same sessions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;

use super::agents::{self, ShiftEnterTarget};
use super::error::PtyError;
use super::session::{Session, SessionEvents, SpawnOptions};
use super::teardown::BusyProcess;

/// Unique (per app run) session identifier, assigned by [`PtyManager`].
pub type SessionId = u32;

#[derive(Clone, Default)]
pub struct PtyManager {
    registry: Arc<Registry>,
}

#[derive(Default)]
struct Registry {
    sessions: Mutex<HashMap<SessionId, Session>>,
    next_id: AtomicU32,
}

impl Registry {
    fn sessions(&self) -> MutexGuard<'_, HashMap<SessionId, Session>> {
        // A panic while holding the lock leaves the map itself consistent.
        self.sessions.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn take(&self, id: SessionId) -> Option<Session> {
        self.sessions().remove(&id)
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawns a shell in a new pseudoconsole. `owner` groups sessions for bulk cleanup
    /// (the Tauri layer uses the webview label).
    pub fn create(
        &self,
        owner: &str,
        options: SpawnOptions,
        events: impl SessionEvents,
    ) -> Result<SessionId, PtyError> {
        let id = self.registry.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (session, watcher) = Session::spawn(id, owner.to_owned(), options, events)?;
        self.registry.sessions().insert(id, session);

        let registry = Arc::downgrade(&self.registry);
        let started = watcher.start(move || {
            // The shell exited by itself: dropping the session closes the pseudoconsole.
            if let Some(registry) = registry.upgrade() {
                drop(registry.take(id));
            }
        });
        if let Err(err) = started {
            drop(self.registry.take(id));
            return Err(err);
        }
        Ok(id)
    }

    pub fn write(&self, id: SessionId, data: Vec<u8>) -> Result<(), PtyError> {
        self.with_session(id, |session| session.write(id, data))
    }

    pub fn resize(&self, id: SessionId, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.with_session(id, |session| session.resize(cols, rows))
    }

    /// Sends Shift+Enter as the program in front of the user expects it: an AI agent gets its
    /// own newline sequence, anything else a real Shift+Enter (see `agents.rs`).
    pub fn shift_enter(&self, id: SessionId) -> Result<ShiftEnterTarget, PtyError> {
        let shell = self.with_session(id, |session| Ok(session.pid))?;
        // The process table is inspected without holding the sessions lock.
        let (target, bytes) = agents::shift_enter_for(shell);
        self.write(id, bytes.to_vec())?;
        Ok(target)
    }

    /// What closing the session would kill besides the shell (a dev server, an agent...).
    /// Apps with a visible window are not listed: they survive the close.
    pub fn busy_processes(&self, id: SessionId) -> Result<Vec<BusyProcess>, PtyError> {
        self.with_session(id, |session| Ok(session.busy_processes()))
    }

    /// Process id of the session's shell.
    pub fn pid(&self, id: SessionId) -> Option<u32> {
        self.registry
            .sessions()
            .get(&id)
            .and_then(|session| session.pid)
    }

    pub fn close(&self, id: SessionId) -> Result<(), PtyError> {
        let session = self.registry.take(id).ok_or(PtyError::NotFound(id))?;
        dispose(session);
        Ok(())
    }

    /// Closes every session created by `owner`. Returns how many were closed.
    pub fn close_owned_by(&self, owner: &str) -> usize {
        let doomed: Vec<Session> = self
            .registry
            .sessions()
            .extract_if(|_, session| session.owner == owner)
            .map(|(_, session)| session)
            .collect();
        let count = doomed.len();
        doomed.into_iter().for_each(dispose);
        count
    }

    /// Kills and tears down every session synchronously. Meant for app exit.
    pub fn shutdown(&self) {
        let all: Vec<Session> = self
            .registry
            .sessions()
            .drain()
            .map(|(_, session)| session)
            .collect();
        drop(all);
    }

    pub fn len(&self) -> usize {
        self.registry.sessions().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn with_session<T>(
        &self,
        id: SessionId,
        f: impl FnOnce(&Session) -> Result<T, PtyError>,
    ) -> Result<T, PtyError> {
        let sessions = self.registry.sessions();
        f(sessions.get(&id).ok_or(PtyError::NotFound(id))?)
    }
}

/// Kills the process tree right away and finishes the teardown off-thread, because closing
/// a pseudoconsole can block until conhost has flushed its output.
fn dispose(mut session: Session) {
    session.kill();
    let spawned = thread::Builder::new()
        .name("pty-teardown".into())
        .stack_size(64 * 1024)
        .spawn(move || drop(session));
    // If the thread could not start, the closure (and the session) was dropped right here.
    let _ = spawned;
}
