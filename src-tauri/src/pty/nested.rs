//! Variables an AI agent session (Claude Code) sets for the processes it starts.
//!
//! Brisa launched from inside such a session (a dev run, a script, a tool) passed them on to
//! every shell, and `claude` refused to start there ("nested session"). They describe that other
//! session, never the user's configuration, so shells and `claude -p` start without them.
//! Configuration variables (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_GIT_BASH_PATH`,
//! `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_OAUTH_TOKEN`...) are kept.

/// Seen in the environment of processes started by Claude Code (2.1.x).
pub const NESTED_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_CHILD_NOTES_DIR",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
];

/// True for a variable that belongs to another agent session (names are case-insensitive).
pub fn is_nested_session_var(name: &str) -> bool {
    NESTED_SESSION_VARS
        .iter()
        .any(|var| var.eq_ignore_ascii_case(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_variables_go_and_configuration_stays() {
        assert!(is_nested_session_var("CLAUDECODE"));
        assert!(is_nested_session_var("claudecode"));
        assert!(is_nested_session_var("CLAUDE_CODE_ENTRYPOINT"));
        assert!(is_nested_session_var("CLAUDE_CODE_SSE_PORT"));
        assert!(!is_nested_session_var("CLAUDE_CONFIG_DIR"));
        assert!(!is_nested_session_var("CLAUDE_CODE_GIT_BASH_PATH"));
        assert!(!is_nested_session_var("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(!is_nested_session_var("CLAUDE_CODE_USE_BEDROCK"));
        assert!(!is_nested_session_var("PATH"));
    }
}
