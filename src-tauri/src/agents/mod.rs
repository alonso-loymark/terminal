//! Agent adapters for the orchestrator (Fase 8A): one common interface per coding-agent CLI.
//!
//! An adapter knows how to:
//! - detect its CLI: installed, version, logged in (`detect`), without asking any model;
//! - list the models the CLI offers and the effort levels of each one (detected from the CLI
//!   itself, never hardcoded);
//! - answer a text-only question (`ask`: the orchestrator's plan), isolated like the AI layer;
//! - run a task non-interactively in the project folder with streaming events (`run`): what it
//!   reads, edits and runs, its text, and at the end tokens and cost as the CLI reports them;
//! - resume a session (`TaskSpec::resume`) to continue a task (after a permission the user
//!   granted, for example).
//!
//! Only Claude Code is implemented (`claude_code.rs`). CLAUDE.md explains how to add Codex,
//! agy or Gemini CLI. No Tauri here, so it can be tested headless (`tests/agents.rs`).

pub mod claude_code;
mod manager;
pub mod permissions;
pub mod stream;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use crate::ai::{CancelToken, ErrorCode, Failure};
pub use manager::{AgentsManager, TaskEvents};

/// Fixed for the life of the app (lib.rs fills it; tests use their own).
#[derive(Debug, Clone)]
pub struct AgentsConfig {
    /// An empty folder of Brisa's for what must not run inside a project (detection, plans).
    pub work_dir: PathBuf,
    /// Dev builds only (`BRISA_CLAUDE_PATH`): the e2e's fake `claude`.
    pub claude_override: Option<PathBuf>,
}

/// A model the CLI offers, as the CLI describes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    /// What `--model` takes (`sonnet`, `opus`…); `default` is the CLI's own choice.
    pub value: String,
    pub display_name: String,
    /// The CLI's text (Claude Code includes the price per million tokens).
    pub description: String,
    /// The full model id behind the alias, if the CLI says it.
    pub resolved: Option<String>,
    /// Effort levels it accepts (empty: no effort control).
    pub efforts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// `None`: could not tell.
    pub logged_in: Option<bool>,
    pub auth_method: Option<String>,
    pub models: Vec<ModelInfo>,
    /// Why something is missing (not installed, models not detected…).
    pub error: Option<Failure>,
}

/// What a task may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskMode {
    /// Edit files in the project and run the allowed commands.
    Work,
    /// Read the project only (AGENTS.md draft): no edits, no commands.
    Analyze,
}

/// A task for a worker, built by the orchestrator (the prompt is the brief, already redacted).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSpec {
    pub agent: String,
    /// The project folder: the worker runs there.
    pub dir: String,
    pub prompt: String,
    pub model: String,
    pub effort: Option<String>,
    /// Session to continue (a previous run's `session_id`).
    pub resume: Option<String>,
    pub mode: TaskMode,
    /// Command patterns the worker may run (`npm run build *`); everything else is denied.
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    pub max_turns: Option<u32>,
    /// `ai.claudePath` (or the agent's own path setting): empty = look for it.
    pub agent_path: Option<String>,
}

/// A text-only question (the orchestrator's plan): no tools, no project.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskSpec {
    pub agent: String,
    pub model: String,
    pub effort: Option<String>,
    pub system: String,
    pub prompt: String,
    pub agent_path: Option<String>,
}

/// What a tool call does, for the live activity list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ToolAction {
    Read,
    Edit,
    Write,
    Command,
    Search,
    Other,
}

/// A tool call the CLI did not allow (outside the allowed list): reported to the user as a
/// question, never run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Denial {
    pub tool: String,
    pub action: ToolAction,
    /// The command line or path.
    pub target: String,
    /// Command patterns that would allow it (one per part of a compound command); empty when
    /// it cannot be allowed (a tool the worker does not have).
    pub allow: Vec<String>,
}

/// Tokens and cost of one run, as the CLI reports them.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// `total_cost_usd` (with a subscription, what it would cost at API prices).
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub turns: u64,
    /// Models that answered (the CLI may use a smaller one for side work).
    pub models: Vec<String>,
}

/// What a run reports, in order: `Started`, then text, tools and statuses, then exactly one
/// `Done` or `Error`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskEvent {
    #[serde(rename_all = "camelCase")]
    Started {
        session_id: Option<String>,
        model: Option<String>,
    },
    Text {
        text: String,
    },
    Tool {
        id: String,
        tool: String,
        action: ToolAction,
        target: String,
    },
    #[serde(rename_all = "camelCase")]
    ToolDone {
        id: String,
        ok: bool,
    },
    Denied {
        denial: Denial,
    },
    Status {
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Done {
        result: String,
        session_id: Option<String>,
        usage: Usage,
        denials: Vec<Denial>,
    },
    Error {
        code: ErrorCode,
        message: String,
        usage: Option<Usage>,
    },
}

/// How a run ended well.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub result: String,
    pub session_id: Option<String>,
    pub usage: Usage,
    pub denials: Vec<Denial>,
}

/// A run that failed, with what it had spent until then.
#[derive(Debug, Clone, PartialEq)]
pub struct RunFailure {
    pub failure: Failure,
    pub usage: Option<Usage>,
}

impl From<Failure> for RunFailure {
    fn from(failure: Failure) -> Self {
        Self {
            failure,
            usage: None,
        }
    }
}

/// The common interface of every coding-agent CLI.
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    /// Installed, logged in, models: local only, no question to any model.
    fn detect(&self, config: &AgentsConfig, custom_path: Option<&str>) -> AgentInfo;
    /// A text-only answer (the plan).
    fn ask(
        &self,
        config: &AgentsConfig,
        id: u32,
        spec: &AskSpec,
        cancel: &CancelToken,
        emit: &dyn Fn(TaskEvent),
    ) -> Result<Outcome, RunFailure>;
    /// A task in the project folder (or the continuation of one, with `spec.resume`).
    fn run(
        &self,
        config: &AgentsConfig,
        id: u32,
        spec: &TaskSpec,
        cancel: &CancelToken,
        emit: &dyn Fn(TaskEvent),
    ) -> Result<Outcome, RunFailure>;
}

/// Every adapter Brisa knows (only Claude Code in this phase).
pub fn adapters() -> [&'static dyn AgentAdapter; 1] {
    [&claude_code::ClaudeCode]
}

pub fn adapter(id: &str) -> Option<&'static dyn AgentAdapter> {
    adapters().into_iter().find(|a| a.id() == id)
}

/// Effort levels are passed as one argument: a short lowercase word.
pub fn valid_effort(effort: &str) -> bool {
    (2..=10).contains(&effort.len()) && effort.chars().all(|c| c.is_ascii_lowercase())
}

/// Session ids are passed as one argument: letters, digits and dashes (a UUID), never something
/// that looks like a flag.
pub fn valid_session(id: &str) -> bool {
    (8..=100).contains(&id.len())
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_serialize_for_the_frontend() {
        let json = serde_json::to_string(&TaskEvent::Tool {
            id: "t1".into(),
            tool: "Edit".into(),
            action: ToolAction::Edit,
            target: "src/a.ts".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"tool","id":"t1","tool":"Edit","action":"edit","target":"src/a.ts"}"#
        );
        let json = serde_json::to_string(&TaskEvent::Started {
            session_id: Some("s".into()),
            model: None,
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"started","sessionId":"s","model":null}"#);
        let json = serde_json::to_string(&TaskEvent::ToolDone {
            id: "t".into(),
            ok: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"toolDone","id":"t","ok":false}"#);
    }

    #[test]
    fn arguments_are_validated() {
        assert!(valid_effort("low"));
        assert!(valid_effort("xhigh"));
        assert!(!valid_effort("--model"));
        assert!(!valid_effort("high now"));
        assert!(valid_session("c609e3fd-c1a8-498c-89cb-750d4d5afb16"));
        assert!(!valid_session("--dangerously-skip-permissions"));
        assert!(!valid_session("abc def ghi"));
        assert!(!valid_session("x"));
    }
}
