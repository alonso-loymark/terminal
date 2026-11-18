//! Closing a session: console processes die, apps with a window survive.
//!
//! A process survives if it, or one of its ancestors inside the session's job (other than the
//! shell), owns a visible top-level window: `code .` keeps Code.exe and all its helper
//! processes, `notepad` keeps Notepad. Everything else dies: the shell, node, dev servers,
//! agents, MCP servers in hidden consoles and GUI-subsystem processes without a window
//! (headless browsers). The shell itself never survives.
//!
//! Deliberate limits: an app that has not shown its window yet, or lives only in the tray, is
//! treated as background work; and if the terminal crashes, `KILL_ON_JOB_CLOSE` still kills
//! the whole tree (no zombies beats keeping windows open after a crash).

use std::collections::{HashMap, HashSet};

/// Job members that must be killed, shell first. Pure, so it can be unit-tested.
pub(crate) fn doomed(
    members: &[u32],
    parent_of: &HashMap<u32, u32>,
    window_owners: &HashSet<u32>,
    shell: Option<u32>,
) -> Vec<u32> {
    let in_job: HashSet<u32> = members.iter().copied().collect();
    let spared = |pid: u32| {
        let mut current = pid;
        // Bounded walk: parent ids can form cycles after pid reuse.
        for _ in 0..64 {
            if Some(current) == shell {
                return false;
            }
            if window_owners.contains(&current) {
                return true;
            }
            match parent_of.get(&current) {
                Some(&parent) if parent != current && in_job.contains(&parent) => current = parent,
                _ => return false,
            }
        }
        false
    };
    let mut doomed: Vec<u32> = members
        .iter()
        .copied()
        .filter(|&pid| !spared(pid))
        .collect();
    // Stop the shell first so it cannot start anything new while the rest is being killed.
    doomed.sort_by_key(|&pid| Some(pid) != shell);
    doomed
}

/// Kills the console side of the session's process tree and releases the job so that the
/// surviving windowed apps are not killed when our handle closes.
#[cfg(windows)]
pub(crate) fn close_job(job: &super::job::Job, shell: Option<u32>) {
    use super::procs;

    if job.set_kill_on_close(false).is_err() {
        // Cannot spare anything without disarming the job: kill the whole tree instead.
        job.terminate();
        return;
    }
    // A few passes catch processes started while we were killing their parents.
    for _ in 0..5 {
        let members = job.process_ids();
        if members.is_empty() {
            return;
        }
        let parent_of = procs::snapshot()
            .into_iter()
            .map(|p| (p.pid, p.parent))
            .collect();
        let targets = doomed(&members, &parent_of, &procs::window_owners(), shell);
        if targets.is_empty() {
            return;
        }
        for pid in targets {
            job.terminate_member(pid);
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHELL: u32 = 10;

    fn tree(edges: &[(u32, u32)]) -> HashMap<u32, u32> {
        edges.iter().copied().collect()
    }

    #[test]
    fn console_processes_die_and_shell_goes_first() {
        // shell → node (dev server) → node (worker); shell → ping (hidden console)
        let parents = tree(&[(20, SHELL), (21, 20), (30, SHELL)]);
        let doomed = doomed(&[20, 21, SHELL, 30], &parents, &HashSet::new(), Some(SHELL));
        assert_eq!(doomed[0], SHELL);
        assert_eq!(doomed.len(), 4);
    }

    #[test]
    fn windowed_apps_survive_with_their_helpers() {
        // shell → code.cmd launcher (40) → Code.exe main (41, has a window) → helpers (42, 43)
        let parents = tree(&[(40, SHELL), (41, 40), (42, 41), (43, 42)]);
        let windows = HashSet::from([41]);
        let mut doomed = doomed(&[SHELL, 40, 41, 42, 43], &parents, &windows, Some(SHELL));
        doomed.sort_unstable();
        assert_eq!(
            doomed,
            vec![SHELL, 40],
            "launcher and shell die, the app tree survives"
        );
    }

    #[test]
    fn windowless_gui_processes_die() {
        // A headless browser: GUI subsystem, no visible window anywhere in its subtree.
        let parents = tree(&[(50, SHELL), (51, 50)]);
        let doomed = doomed(&[SHELL, 50, 51], &parents, &HashSet::new(), Some(SHELL));
        assert_eq!(doomed.len(), 3);
    }

    #[test]
    fn the_shell_never_survives_even_with_a_window() {
        let parents = tree(&[(60, SHELL)]);
        let windows = HashSet::from([SHELL]);
        assert_eq!(
            doomed(&[SHELL, 60], &parents, &windows, Some(SHELL)),
            vec![SHELL, 60]
        );
    }

    #[test]
    fn parent_cycles_terminate() {
        let parents = tree(&[(70, 71), (71, 70)]);
        assert_eq!(
            doomed(&[70, 71], &parents, &HashSet::new(), Some(SHELL)).len(),
            2
        );
    }
}
