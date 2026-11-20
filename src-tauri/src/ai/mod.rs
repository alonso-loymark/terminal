//! AI layer (Fase 7B): one completion per request, streamed back as text deltas.
//!
//! Two providers:
//! - `claude-cli`: the Claude Code CLI in print mode (`claude -p`) with the user's own login
//!   (subscription), no tools, no project context (see `claude_cli.rs`).
//! - `anthropic-api`: the Messages API with a key kept in the Windows Credential Manager,
//!   over WinHTTP (no HTTP crate).
//!
//! The frontend builds the exact text that is sent (already redacted: it shows it to the user
//! as "Ver qué se envía"); this layer only delivers it. Nothing runs until the frontend enables
//! it (`ai.enabled`): with AI off there is no network call and no `claude` process.
//! No Tauri here, so it can be tested headless (`tests/ai.rs`).

mod anthropic;
pub mod claude_cli;
#[cfg(windows)]
pub mod credentials;
#[cfg(windows)]
mod http;
mod manager;
pub mod secrets;
pub mod stream;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

pub use manager::{AiEvents, AiManager, CancelToken};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    ClaudeCli,
    AnthropicApi,
}

/// How much the model should think: low for one-line commands, the model's default otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
}

impl Effort {
    pub fn as_str(self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Message {
    pub role: Role,
    pub content: String,
}

/// One completion, exactly as the frontend showed it to the user.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRequest {
    pub provider: Provider,
    /// An alias (`opus`, `sonnet`, `haiku`, `fable`) or a full model id.
    pub model: String,
    pub system: String,
    /// The CLI gets a single user message (the frontend flattens a chat into one).
    pub messages: Vec<Message>,
    pub effort: Option<Effort>,
    /// Anthropic API only.
    pub max_tokens: u32,
    /// `ai.claudePath`: empty or missing = look for `claude` on this machine.
    pub claude_path: Option<String>,
}

/// What a request reports, in order: `Delta`s (and `Status`es), then exactly one `Done` or
/// `Error`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiEvent {
    Delta {
        text: String,
    },
    /// Informational (a retry, a fallback model).
    Status {
        message: String,
    },
    Done,
    Error {
        code: ErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// `ai.enabled` is false.
    Disabled,
    /// No `claude` on this machine (or `ai.claudePath` does not exist).
    NotInstalled,
    /// The installed `claude` lacks a flag Brisa needs to keep it isolated.
    Outdated,
    /// `claude` has no login.
    Auth,
    /// The plan's usage limit (subscription) or the account's credit.
    Limit,
    /// No API key saved.
    NoKey,
    /// The API rejected the key.
    ApiKey,
    RateLimit,
    Overloaded,
    Network,
    Refusal,
    Timeout,
    Cancelled,
    /// A request the provider rejected (bad model name...).
    Invalid,
    Failed,
}

/// A request that could not finish.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: ErrorCode,
    pub message: String,
}

impl Failure {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Where the API lives (tests point it to a local fake server).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub secure: bool,
    pub host: String,
    pub port: u16,
    /// Prefix of every path, without a trailing slash ("" for the real API).
    pub base_path: String,
}

impl Endpoint {
    pub const ANTHROPIC: &str = "https://api.anthropic.com";

    /// `https://host[:port][/path]` or `http://...`.
    pub fn parse(url: &str) -> Option<Self> {
        let (secure, rest) = if let Some(rest) = url.strip_prefix("https://") {
            (true, rest)
        } else {
            (false, url.strip_prefix("http://")?)
        };
        let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
        let (host, port) = match authority.rsplit_once(':') {
            Some((host, port)) => (host, port.parse().ok()?),
            None => (authority, if secure { 443 } else { 80 }),
        };
        if host.is_empty() {
            return None;
        }
        let path = path.trim_end_matches('/');
        Some(Self {
            secure,
            host: host.to_owned(),
            port,
            base_path: if path.is_empty() {
                String::new()
            } else {
                format!("/{path}")
            },
        })
    }
}

/// Fixed for the life of the app (lib.rs fills it; tests use their own).
#[derive(Debug, Clone)]
pub struct AiConfig {
    /// An empty folder `claude -p` runs in: no project around it, no CLAUDE.md to discover.
    pub work_dir: PathBuf,
    /// Credential Manager entry with the API key.
    pub credential_target: String,
    pub api: Endpoint,
    /// Dev builds only (`BRISA_CLAUDE_PATH`): the e2e's fake `claude`, so a test can never
    /// reach the real one, even before settings load.
    pub claude_override: Option<PathBuf>,
}

impl AiConfig {
    pub const CREDENTIAL_TARGET: &str = "Brisa/anthropic-api-key";
}

/// Model aliases for the API (the CLI resolves them itself).
pub fn api_model(model: &str) -> &str {
    match model {
        "opus" => "claude-opus-5-5",
        "sonnet" => "claude-sonnet-5-5",
        "haiku" => "claude-haiku-5-5",
        "fable" => "claude-fable-5-2",
        other => other,
    }
}

/// Model names are passed as one argument to `claude`: letters, digits and `.-_[]` only, never
/// something that looks like a flag.
pub fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 100
        && !model.starts_with('-')
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints() {
        assert_eq!(
            Endpoint::parse("https://api.anthropic.com"),
            Some(Endpoint {
                secure: true,
                host: "api.anthropic.com".into(),
                port: 443,
                base_path: String::new()
            })
        );
        assert_eq!(
            Endpoint::parse("http://127.0.0.1:4321/proxy/"),
            Some(Endpoint {
                secure: false,
                host: "127.0.0.1".into(),
                port: 4321,
                base_path: "/proxy".into()
            })
        );
        assert_eq!(Endpoint::parse("ftp://x"), None);
        assert_eq!(Endpoint::parse("http://:80"), None);
    }

    #[test]
    fn models() {
        assert_eq!(api_model("opus"), "claude-opus-5-5");
        assert_eq!(api_model("claude-sonnet-5-5"), "claude-sonnet-5-5");
        assert!(valid_model("opus"));
        assert!(valid_model("claude-opus-5-5"));
        assert!(valid_model("claude-sonnet-5-5[1m]"));
        assert!(!valid_model("--dangerously-skip-permissions"));
        assert!(!valid_model("opus --tools default"));
        assert!(!valid_model(""));
    }

    #[test]
    fn events_serialize_for_the_frontend() {
        let json = serde_json::to_string(&AiEvent::Error {
            code: ErrorCode::NotInstalled,
            message: "x".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"error","code":"not-installed","message":"x"}"#
        );
        let json = serde_json::to_string(&AiEvent::Delta { text: "a".into() }).unwrap();
        assert_eq!(json, r#"{"kind":"delta","text":"a"}"#);
    }
}
