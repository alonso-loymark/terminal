//! Running requests: each on its own thread, cancellable, owned by a webview (closing or
//! reloading the page cancels its requests, like PTY sessions).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use super::{AiConfig, AiEvent, AiRequest, ErrorCode, Failure, Provider, anthropic, claude_cli};

/// Where a request's events go (a Tauri channel in the app, an mpsc in tests).
pub trait AiEvents: Send + 'static {
    fn send(&self, event: AiEvent);
}

type Hook = Box<dyn FnOnce() + Send>;

/// Set once; whoever does the blocking work registers a hook that interrupts it (kill the
/// `claude` process tree, close the HTTP request).
#[derive(Default)]
pub struct CancelToken {
    cancelled: AtomicBool,
    hooks: Mutex<Vec<Hook>>,
}

impl CancelToken {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        let hooks = std::mem::take(&mut *self.hooks.lock().unwrap_or_else(PoisonError::into_inner));
        for hook in hooks {
            hook();
        }
    }

    /// Runs `hook` on cancellation, or right away if already cancelled.
    pub fn on_cancel(&self, hook: impl FnOnce() + Send + 'static) {
        let mut hooks = self.hooks.lock().unwrap_or_else(PoisonError::into_inner);
        if self.is_cancelled() {
            drop(hooks);
            hook();
        } else {
            hooks.push(Box::new(hook));
        }
    }
}

struct Running {
    owner: String,
    cancel: Arc<CancelToken>,
}

struct Inner {
    config: AiConfig,
    enabled: AtomicBool,
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, Running>>,
}

#[derive(Clone)]
pub struct AiManager {
    inner: Arc<Inner>,
}

impl AiManager {
    /// Disabled until the frontend says otherwise (it reads `ai.enabled` from settings.json).
    pub fn new(config: AiConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                enabled: AtomicBool::new(false),
                next_id: AtomicU32::new(1),
                running: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn config(&self) -> &AiConfig {
        &self.inner.config
    }

    pub fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::SeqCst)
    }

    /// Turning AI off cancels whatever is running.
    pub fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.cancel_where(|_| true);
        }
    }

    /// Starts a request; its events (deltas, then `Done` or `Error`) go to `events`.
    pub fn start(
        &self,
        owner: &str,
        request: AiRequest,
        events: impl AiEvents,
    ) -> Result<u32, Failure> {
        if !self.enabled() {
            return Err(Failure::new(
                ErrorCode::Disabled,
                "La IA está desactivada (ai.enabled: false).",
            ));
        }
        let id = self.inner.next_id.fetch_add(1, Ordering::SeqCst);
        let cancel = CancelToken::new();
        self.lock().insert(
            id,
            Running {
                owner: owner.to_owned(),
                cancel: cancel.clone(),
            },
        );
        let inner = self.inner.clone();
        let spawned = thread::Builder::new()
            .name(format!("ai-{id}"))
            .stack_size(256 * 1024)
            .spawn(move || {
                let result = match request.provider {
                    Provider::ClaudeCli => {
                        claude_cli::run(&inner.config, id, &request, &cancel, &|e| events.send(e))
                    }
                    Provider::AnthropicApi => {
                        anthropic::run(&inner.config, &request, &cancel, &|e| events.send(e))
                    }
                };
                let last = match result {
                    _ if cancel.is_cancelled() => AiEvent::Error {
                        code: ErrorCode::Cancelled,
                        message: "Consulta cancelada.".to_owned(),
                    },
                    Ok(()) => AiEvent::Done,
                    Err(failure) => AiEvent::Error {
                        code: failure.code,
                        message: failure.message,
                    },
                };
                inner
                    .running
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                events.send(last);
            });
        if let Err(error) = spawned {
            self.lock().remove(&id);
            return Err(Failure::new(
                ErrorCode::Failed,
                format!("no se pudo iniciar la consulta: {error}"),
            ));
        }
        Ok(id)
    }

    pub fn cancel(&self, id: u32) {
        let token = self.lock().get(&id).map(|r| r.cancel.clone());
        if let Some(token) = token {
            token.cancel();
        }
    }

    pub fn cancel_owned_by(&self, owner: &str) {
        self.cancel_where(|r| r.owner == owner);
    }

    pub fn shutdown(&self) {
        self.cancel_where(|_| true);
    }

    pub fn running(&self) -> usize {
        self.lock().len()
    }

    fn cancel_where(&self, pred: impl Fn(&Running) -> bool) {
        // Collected first: hooks may take a while (killing a process tree).
        let tokens: Vec<_> = self
            .lock()
            .values()
            .filter(|r| pred(r))
            .map(|r| r.cancel.clone())
            .collect();
        for token in tokens {
            token.cancel();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<u32, Running>> {
        self.inner
            .running
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn cancel_runs_hooks_once_and_late_hooks_right_away() {
        let token = CancelToken::new();
        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        token.on_cancel(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        token.cancel();
        token.cancel();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let c = count.clone();
        token.on_cancel(move || {
            c.fetch_add(10, Ordering::SeqCst);
        });
        assert_eq!(count.load(Ordering::SeqCst), 11);
        assert!(token.is_cancelled());
    }
}
