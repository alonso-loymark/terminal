//! Shift+Enter: an AI agent in front of the user gets its own "insert newline" sequence (the
//! one its /terminal-setup installs in VS Code); anything else gets a real Shift+Enter.
//!
//! No single sequence works everywhere: ESC CR makes Claude Code insert a newline but is a
//! no-op in PSReadLine, while a real Shift+Enter key event gives PowerShell its native AddLine
//! but reaches Node-based agents as a plain CR (submit).

use std::collections::HashSet;

use serde::Serialize;

/// What Shift+Enter was translated into (reported back to the frontend).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum ShiftEnterTarget {
    /// An AI agent runs in the session: its newline sequence was sent.
    Agent { agent: &'static str },
    /// A real Shift+Enter key was sent (PowerShell: AddLine; other programs: as in Windows Terminal).
    Native,
}

pub(crate) struct AgentSpec {
    pub(crate) name: &'static str,
    /// Native executables (lowercase image names).
    executables: &'static [&'static str],
    /// npm package paths that identify the agent when it runs under node/bun.
    packages: &'static [&'static str],
    /// Verified from each agent's own /terminal-setup for VS Code.
    pub(crate) newline: &'static [u8],
}

/// Codex is not listed: it reads native console key events (crossterm), so it gets the same
/// real Shift+Enter that Windows Terminal would send.
pub(crate) const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        name: "claude",
        executables: &["claude.exe"],
        packages: &["@anthropic-ai/claude-code"],
        newline: b"\x1b\r",
    },
    AgentSpec {
        name: "gemini",
        executables: &["gemini.exe"],
        packages: &["@google/gemini-cli"],
        newline: b"\\\r\n",
    },
];

const SCRIPT_HOSTS: &[&str] = &["node.exe", "bun.exe"];

/// A real Shift+Enter in win32-input-mode (Shift down, Enter down/up, Shift up). ConPTY turns it
/// into console key events with SHIFT_PRESSED, exactly what a physical keyboard produces.
#[cfg(windows)]
pub(crate) const NATIVE_SHIFT_ENTER: &[u8] =
    b"\x1b[16;42;0;1;16;1_\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_\x1b[16;42;0;0;0;1_";
#[cfg(not(windows))]
pub(crate) const NATIVE_SHIFT_ENTER: &[u8] = b"\r";

/// Which agent, if any, `exe` (plus its command line, read lazily for script hosts) is.
fn match_agent(
    exe: &str,
    command_line: impl FnOnce() -> Option<String>,
) -> Option<&'static AgentSpec> {
    let exe = exe.to_ascii_lowercase();
    if let Some(agent) = AGENTS
        .iter()
        .find(|a| a.executables.contains(&exe.as_str()))
    {
        return Some(agent);
    }
    if !SCRIPT_HOSTS.contains(&exe.as_str()) {
        return None;
    }
    let command_line = command_line()?.to_ascii_lowercase().replace('\\', "/");
    AGENTS
        .iter()
        .find(|a| a.packages.iter().any(|pkg| command_line.contains(pkg)))
}

/// The innermost agent among the descendants of `shell`. `processes` are (pid, parent, exe).
pub(crate) fn find_agent(
    shell: u32,
    processes: &[(u32, u32, &str)],
    command_line: impl Fn(u32) -> Option<String>,
) -> Option<&'static AgentSpec> {
    let mut found = None;
    let mut seen = HashSet::from([shell]);
    let mut frontier = vec![shell];
    // Breadth-first: a deeper match (the program actually in front) replaces a shallower one.
    for _ in 0..32 {
        let mut next = Vec::new();
        for &(pid, parent, exe) in processes {
            if frontier.contains(&parent) && seen.insert(pid) {
                if let Some(agent) = match_agent(exe, || command_line(pid)) {
                    found = Some(agent);
                }
                next.push(pid);
            }
        }
        if next.is_empty() {
            break;
        }
        frontier = next;
    }
    found
}

/// Decides what Shift+Enter means right now for the session whose shell is `shell`.
pub(crate) fn shift_enter_for(shell: Option<u32>) -> (ShiftEnterTarget, &'static [u8]) {
    #[cfg(windows)]
    if let Some(agent) = shell.and_then(detect) {
        return (ShiftEnterTarget::Agent { agent: agent.name }, agent.newline);
    }
    #[cfg(not(windows))]
    let _ = shell;
    (ShiftEnterTarget::Native, NATIVE_SHIFT_ENTER)
}

#[cfg(windows)]
fn detect(shell: u32) -> Option<&'static AgentSpec> {
    let snapshot = super::procs::snapshot();
    let processes: Vec<(u32, u32, &str)> = snapshot
        .iter()
        .map(|p| (p.pid, p.parent, p.exe.as_str()))
        .collect();
    find_agent(shell, &processes, super::procs::command_line)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: u32 = 1;

    fn no_command_line(_: u32) -> Option<String> {
        None
    }

    #[test]
    fn native_agent_executables_are_detected() {
        let procs = [(2, SHELL, "claude.exe")];
        assert_eq!(
            find_agent(SHELL, &procs, no_command_line).unwrap().name,
            "claude"
        );
        let procs = [(2, SHELL, "Gemini.EXE")];
        assert_eq!(
            find_agent(SHELL, &procs, no_command_line).unwrap().name,
            "gemini"
        );
    }

    #[test]
    fn npm_installed_agents_are_detected_by_command_line() {
        // claude.cmd → node "...\node_modules\@anthropic-ai\claude-code\cli.js"
        let procs = [(2, SHELL, "cmd.exe"), (3, 2, "node.exe")];
        let cmd = |pid| {
            (pid == 3).then(|| {
                r#""C:\Program Files\nodejs\node.exe" "C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js""#
                    .to_owned()
            })
        };
        assert_eq!(find_agent(SHELL, &procs, cmd).unwrap().name, "claude");
    }

    #[test]
    fn other_programs_and_unknown_node_scripts_are_not_agents() {
        let procs = [
            (2, SHELL, "vim.exe"),
            (3, SHELL, "node.exe"),
            (4, SHELL, "codex.exe"),
        ];
        let cmd = |_| Some("node C:/work/server.js".to_owned());
        assert!(find_agent(SHELL, &procs, cmd).is_none());
    }

    #[test]
    fn processes_outside_the_session_are_ignored() {
        let procs = [(2, 999, "claude.exe")];
        assert!(find_agent(SHELL, &procs, no_command_line).is_none());
    }

    #[test]
    fn the_innermost_agent_wins() {
        // claude runs gemini as a subprocess: the user is talking to gemini now.
        let procs = [(2, SHELL, "claude.exe"), (3, 2, "gemini.exe")];
        assert_eq!(
            find_agent(SHELL, &procs, no_command_line).unwrap().name,
            "gemini"
        );
    }

    #[test]
    fn each_agent_gets_its_own_newline() {
        assert_eq!(AGENTS[0].newline, b"\x1b\r");
        assert_eq!(AGENTS[1].newline, b"\\\r\n");
    }
}
