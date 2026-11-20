//! Running agent tasks (plans and workers): each on its own thread, cancellable, owned by a
//! webview (closing or reloading the page cancels them, like PTY sessions). Off
//! (`orchestrator.enabled: false`) nothing is launched and whatever runs is cancelled.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;

use super::{
    AgentInfo, AgentsConfig, AskSpec, CancelToken, ErrorCode, Failure, Outcome, RunFailure,
    TaskEvent, TaskSpec, adapter, adapters,
};

/// Where a run's events go (a Tauri channel in the app, an mpsc in tests).
pub trait TaskEvents: Send + 'static {
    fn send(&self, event: TaskEvent);
}

struct Running {
    owner: String,
    cancel: Arc<CancelToken>,
}

struct Inner {
    config: AgentsConfig,
    enabled: AtomicBool,
    next_id: AtomicU32,
    running: Mutex<HashMap<u32, Running>>,
    /// Last detection per adapter and CLI path setting (models change rarely; "Actualizar"
    /// detects again).
    detected: Mutex<HashMap<(String, Option<String>), AgentInfo>>,
}

#[derive(Clone)]
pub struct AgentsManager {
    inner: Arc<Inner>,
}

enum Job {
    Ask(AskSpec),
    Run(TaskSpec),
}

impl AgentsManager {
    /// Disabled until the frontend says otherwise (`orchestrator.enabled`).
    pub fn new(config: AgentsConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                enabled: AtomicBool::new(false),
                next_id: AtomicU32::new(1),
                running: Mutex::new(HashMap::new()),
                detected: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn config(&self) -> &AgentsConfig {
        &self.inner.config
    }

    pub fn enabled(&self) -> bool {
        self.inner.enabled.load(Ordering::SeqCst)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.inner.enabled.store(enabled, Ordering::SeqCst);
        if !enabled {
            self.cancel_where(|_| true);
        }
    }

    fn disabled() -> Failure {
        Failure::new(
            ErrorCode::Disabled,
            "El modo orquestador está desactivado (orchestrator.enabled: false).",
        )
    }

    /// Every adapter, detected (cached unless `refresh`). Blocking: call off the main thread.
    pub fn detect(
        &self,
        custom_path: Option<&str>,
        refresh: bool,
    ) -> Result<Vec<AgentInfo>, Failure> {
        if !self.enabled() {
            return Err(Self::disabled());
        }
        let mut out = Vec::new();
        let path = custom_path.map(str::trim).filter(|p| !p.is_empty());
        for adapter in adapters() {
            let key = (adapter.id().to_owned(), path.map(str::to_owned));
            let cached = (!refresh)
                .then(|| {
                    self.inner
                        .detected
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get(&key)
                        .cloned()
                })
                .flatten();
            let info = match cached {
                Some(info) => info,
                None => {
                    let info = adapter.detect(&self.inner.config, path);
                    self.inner
                        .detected
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .insert(key, info.clone());
                    info
                }
            };
            out.push(info);
        }
        Ok(out)
    }

    /// A text-only answer (the plan).
    pub fn ask(&self, owner: &str, spec: AskSpec, events: impl TaskEvents) -> Result<u32, Failure> {
        self.start(owner, Job::Ask(spec), events)
    }

    /// A worker in the project folder.
    pub fn run(
        &self,
        owner: &str,
        spec: TaskSpec,
        events: impl TaskEvents,
    ) -> Result<u32, Failure> {
        self.start(owner, Job::Run(spec), events)
    }

    fn start(&self, owner: &str, job: Job, events: impl TaskEvents) -> Result<u32, Failure> {
        if !self.enabled() {
            return Err(Self::disabled());
        }
        let agent = match &job {
            Job::Ask(spec) => &spec.agent,
            Job::Run(spec) => &spec.agent,
        };
        let Some(adapter) = adapter(agent) else {
            return Err(Failure::new(
                ErrorCode::Invalid,
                format!("Agente desconocido: «{agent}»."),
            ));
        };
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
            .name(format!("agent-{id}"))
            .stack_size(512 * 1024)
            .spawn(move || {
                let emit = |e: TaskEvent| events.send(e);
                let result = match &job {
                    Job::Ask(spec) => adapter.ask(&inner.config, id, spec, &cancel, &emit),
                    Job::Run(spec) => adapter.run(&inner.config, id, spec, &cancel, &emit),
                };
                let last = match result {
                    Err(RunFailure { usage, .. }) if cancel.is_cancelled() => TaskEvent::Error {
                        code: ErrorCode::Cancelled,
                        message: "Tarea cancelada.".to_owned(),
                        usage,
                    },
                    Ok(Outcome {
                        result,
                        session_id,
                        usage,
                        denials,
                    }) => {
                        if cancel.is_cancelled() {
                            TaskEvent::Error {
                                code: ErrorCode::Cancelled,
                                message: "Tarea cancelada.".to_owned(),
                                usage: Some(usage),
                            }
                        } else {
                            TaskEvent::Done {
                                result,
                                session_id,
                                usage,
                                denials,
                            }
                        }
                    }
                    Err(RunFailure { failure, usage }) => TaskEvent::Error {
                        code: failure.code,
                        message: failure.message,
                        usage,
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
                format!("no se pudo iniciar la tarea: {error}"),
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
