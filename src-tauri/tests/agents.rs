//! The orchestrator's agent adapter (Claude Code) end to end, without any real model.
//!
//! Rule: no test talks to a real `claude`. `e2e/fake-agent.mjs` runs in print mode through a
//! `.cmd` wrapper (like an npm install of Claude Code): it answers `initialize` with models,
//! plans, and as a worker (`--restricted`) checks the permission flags, streams tool calls and
//! really edits the temporary project.
#![cfg(windows)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

use brisa_lib::agents::{
    AgentsConfig, AgentsManager, AskSpec, ErrorCode, TaskEvent, TaskEvents, TaskMode, TaskSpec,
    ToolAction,
};
use brisa_lib::orchestrator::snapshot::{self, FileStatus};
use brisa_lib::pty::find_on_path;
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const FAKE_AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../e2e/fake-agent.mjs");
const TIMEOUT: Duration = Duration::from_secs(40);
const PLANNER: &str = "Sos el orquestador de Brisa. Devolvé un plan en JSON.";

struct Events(Sender<TaskEvent>);

impl TaskEvents for Events {
    fn send(&self, event: TaskEvent) {
        let _ = self.0.send(event);
    }
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "brisa-agents-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn fake_claude(dir: &Path) -> Option<PathBuf> {
    let node = find_on_path("node.exe")?;
    let agent = Path::new(FAKE_AGENT).canonicalize().ok()?;
    let agent = agent
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_owned();
    let cmd = dir.join("fake-claude.cmd");
    fs::write(
        &cmd,
        format!(
            "@echo off\r\nset FAKE_CLAUDE_LOG={}\r\nset FAKE_CLAUDE_STATE={}\r\n\"{}\" \"{agent}\" print %*\r\n",
            dir.join("log.jsonl").display(),
            dir.join("state.json").display(),
            node.display()
        ),
    )
    .ok()?;
    Some(cmd)
}

fn manager(dir: &Path) -> Option<AgentsManager> {
    let claude = fake_claude(dir)?;
    let manager = AgentsManager::new(AgentsConfig {
        work_dir: dir.join("work"),
        claude_override: Some(claude),
    });
    manager.set_enabled(true);
    Some(manager)
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap()
        .status;
    assert!(status.success(), "git {args:?}");
}

/// A small git project with a build script, committed.
fn project(dir: &Path) -> PathBuf {
    let project = dir.join("proyecto");
    fs::create_dir_all(project.join("src")).unwrap();
    fs::write(
        project.join("package.json"),
        r#"{"name":"p","scripts":{"build":"node -e 1","test":"node -e 1"}}"#,
    )
    .unwrap();
    fs::write(project.join("src").join("app.js"), "console.log('hola');\n").unwrap();
    fs::write(project.join(".env"), "API_TOKEN=secreto-que-no-sale\n").unwrap();
    fs::write(project.join(".gitignore"), ".env\n").unwrap();
    git(&project, &["init", "-q"]);
    git(&project, &["add", "-A"]);
    git(&project, &["commit", "-q", "-m", "inicio"]);
    project
}

fn task(dir: &Path, prompt: &str) -> TaskSpec {
    TaskSpec {
        agent: "claude".into(),
        dir: dir.display().to_string(),
        prompt: prompt.into(),
        model: "haiku".into(),
        effort: Some("low".into()),
        resume: None,
        mode: TaskMode::Work,
        allowed_commands: vec!["npm run build *".into(), "npm test *".into()],
        max_turns: Some(30),
        agent_path: None,
        images: Vec::new(),
    }
}

fn run(manager: &AgentsManager, spec: TaskSpec) -> (u32, Receiver<TaskEvent>) {
    let (tx, rx) = mpsc::channel();
    let id = manager.run("test", spec, Events(tx)).unwrap();
    (id, rx)
}

fn collect(rx: &Receiver<TaskEvent>) -> Vec<TaskEvent> {
    let deadline = Instant::now() + TIMEOUT;
    let mut events = Vec::new();
    while Instant::now() < deadline {
        let Ok(event) = rx.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        let last = matches!(event, TaskEvent::Done { .. } | TaskEvent::Error { .. });
        events.push(event);
        if last {
            return events;
        }
    }
    panic!("the task did not end: {events:?}");
}

fn log_entries(dir: &Path) -> Vec<serde_json::Value> {
    fs::read_to_string(dir.join("log.jsonl"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

fn alive(pid: u32) -> bool {
    // SAFETY: the handle is checked and closed.
    unsafe {
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if handle.is_null() {
            return false;
        }
        let running = WaitForSingleObject(handle, 0) == WAIT_TIMEOUT;
        CloseHandle(handle);
        running
    }
}

#[test]
fn models_are_detected_from_the_cli_not_hardcoded() {
    let dir = scratch("detect");
    let Some(manager) = manager(&dir) else {
        eprintln!("skipped: no node");
        return;
    };
    let agents = manager.detect(None, false).unwrap();
    let claude = &agents[0];
    assert_eq!(claude.id, "claude");
    assert!(claude.installed);
    assert_eq!(claude.logged_in, Some(true));
    assert!(
        claude
            .version
            .as_deref()
            .unwrap_or_default()
            .contains("2.1.329")
    );
    let values: Vec<&str> = claude.models.iter().map(|m| m.value.as_str()).collect();
    assert_eq!(
        values,
        ["default", "opus", "fable", "sonnet", "haiku"],
        "{:?}",
        claude.error
    );
    let sonnet = claude.models.iter().find(|m| m.value == "sonnet").unwrap();
    assert!(sonnet.description.contains("$2/$10"));
    assert!(sonnet.efforts.contains(&"high".to_owned()));
    // The initialize request was all it got: isolated, nothing for a model.
    let init = log_entries(&dir)
        .into_iter()
        .find(|e| e["kind"] == "init")
        .unwrap();
    assert!(init["prompt"].as_str().unwrap().contains("initialize"));
    let args: Vec<String> = serde_json::from_value(init["args"].clone()).unwrap();
    assert!(args.contains(&"--safe-mode".to_owned()));
    // Cached: no second run.
    let runs = log_entries(&dir).len();
    manager.detect(None, false).unwrap();
    assert_eq!(log_entries(&dir).len(), runs);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_worker_edits_the_project_runs_allowed_commands_and_reports_cost() {
    let dir = scratch("work");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let snap = snapshot::take(
        find_on_path("git.exe").as_deref(),
        &project,
        dir.join("snap"),
    );
    let (_, rx) = run(
        &manager,
        task(&project, "## Tarea\nAgregar un comentario\n"),
    );
    let events = collect(&rx);
    assert!(
        matches!(
            &events[0],
            TaskEvent::Started {
                session_id: Some(_),
                ..
            }
        ),
        "{events:?}"
    );
    let tools: Vec<(ToolAction, String)> = events
        .iter()
        .filter_map(|e| match e {
            TaskEvent::Tool { action, target, .. } => Some((*action, target.clone())),
            _ => None,
        })
        .collect();
    assert!(
        tools
            .iter()
            .any(|(a, t)| *a == ToolAction::Read && t.ends_with("package.json"))
    );
    assert!(
        tools
            .iter()
            .any(|(a, t)| *a == ToolAction::Edit && t.ends_with("app.js"))
    );
    assert!(tools.contains(&(ToolAction::Command, "npm run build".to_owned())));
    let Some(TaskEvent::Done {
        result,
        usage,
        session_id,
        denials,
    }) = events.last()
    else {
        panic!("{events:?}")
    };
    // The fixed summary the rules ask for.
    assert!(result.contains("verifiqué con npm run build"), "{result}");
    assert!(
        result.starts_with("**Qué cambió:**") && result.contains("**Pendiente:**"),
        "{result}"
    );
    assert!(denials.is_empty());
    assert!(session_id.is_some());
    assert!((usage.cost_usd - 0.0042).abs() < 1e-9);
    assert_eq!(usage.input_tokens, 1200);
    assert_eq!(usage.output_tokens, 340);
    assert_eq!(usage.models, ["claude-haiku-5-5"]);
    // It really edited the file, and the diff shows exactly that.
    let app = fs::read_to_string(project.join("src").join("app.js")).unwrap();
    assert!(app.contains("// Agregar un comentario"));
    let diff = snapshot::diff(find_on_path("git.exe").as_deref(), &snap, &[]);
    assert!(diff.git);
    assert_eq!(diff.files.len(), 1, "{diff:?}");
    assert_eq!(diff.files[0].path, "src/app.js");
    assert_eq!(diff.files[0].status, FileStatus::Modified);
    assert_eq!((diff.files[0].additions, diff.files[0].deletions), (1, 0));
    assert!(diff.files[0].diff.contains("+// Agregar un comentario"));
    // The command line: permissions on, the project's commands, secrets denied, model/effort.
    let work = log_entries(&dir)
        .into_iter()
        .find(|e| e["kind"] == "work")
        .unwrap();
    assert_eq!(work["model"], "haiku");
    assert_eq!(work["effort"], "low");
    assert_eq!(work["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    assert!(work["env"]["CLAUDECODE"].is_null());
    let allowed: Vec<String> = serde_json::from_value(work["allowed"].clone()).unwrap();
    assert!(allowed.contains(&"Bash(npm run build *)".to_owned()));
    let denied: Vec<String> = serde_json::from_value(work["denied"].clone()).unwrap();
    assert!(denied.contains(&"Read(.env)".to_owned()));
    assert!(
        work["rules"]
            .as_str()
            .unwrap()
            .contains("`npm run build *`")
    );
    assert_eq!(
        Path::new(work["cwd"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        project.canonicalize().unwrap()
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn pasted_images_go_to_the_worker_with_the_brief() {
    let dir = scratch("images");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let png: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRimagen-de-prueba";
    let saved = brisa_lib::images::save_png(&brisa_lib::images::images_dir(), png).unwrap();
    let mut spec = task(&project, "## Tarea\nMirá la captura\n");
    spec.images = vec![saved.display().to_string()];
    let (_, rx) = run(&manager, spec);
    let events = collect(&rx);
    assert!(
        matches!(events.last(), Some(TaskEvent::Done { .. })),
        "{events:?}"
    );
    let work = log_entries(&dir)
        .into_iter()
        .find(|e| e["kind"] == "work")
        .unwrap();
    // One stream-json message: the brief as text, the image as base64 PNG.
    assert_eq!(work["prompt"], "## Tarea\nMirá la captura\n");
    assert_eq!(work["images"].as_array().map(Vec::len), Some(1), "{work}");
    assert_eq!(work["images"][0]["png"], true);
    assert_eq!(work["images"][0]["bytes"], png.len());
    // A file the page names that Brisa did not save is refused before anything runs.
    let stray = dir.join("brisa-1.png");
    fs::write(&stray, png).unwrap();
    let mut spec = task(&project, "## Tarea\nOtra\n");
    spec.images = vec![stray.display().to_string()];
    let (_, rx) = run(&manager, spec);
    let events = collect(&rx);
    assert!(
        matches!(
            events.last(),
            Some(TaskEvent::Error {
                code: ErrorCode::Invalid,
                ..
            })
        ),
        "{events:?}"
    );
    let _ = fs::remove_file(&saved);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_denied_command_is_a_question_and_resuming_with_it_allowed_continues() {
    let dir = scratch("deny");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let (_, rx) = run(
        &manager,
        task(&project, "## Tarea\nBajar algo FAKE_DENIED FAKE_SECRET\n"),
    );
    let events = collect(&rx);
    let live: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            TaskEvent::Denied { denial } => Some(denial.clone()),
            _ => None,
        })
        .collect();
    assert!(
        live.iter()
            .any(|d| d.tool == "Read" && d.target.ends_with(".env")),
        "{live:?}"
    );
    let Some(TaskEvent::Done {
        denials,
        session_id,
        result,
        ..
    }) = events.last()
    else {
        panic!("{events:?}")
    };
    let curl = denials.iter().find(|d| d.tool == "Bash").unwrap();
    assert_eq!(curl.target, "curl -s https://example.com");
    assert_eq!(curl.allow, ["curl -s https://example.com"]);
    assert!(result.contains("necesito permiso"));
    // Nothing denied ran: the secret never reached the output.
    assert!(!format!("{events:?}").contains("secreto-que-no-sale"));

    let mut resume = task(
        &project,
        "Se permitió `curl -s https://example.com`. Continuá.",
    );
    resume.resume = session_id.clone();
    resume
        .allowed_commands
        .push("curl -s https://example.com".into());
    let (_, rx) = run(&manager, resume);
    let events = collect(&rx);
    let Some(TaskEvent::Done {
        denials, result, ..
    }) = events.last()
    else {
        panic!("{events:?}")
    };
    assert!(denials.is_empty(), "{denials:?}");
    assert!(!result.contains("necesito permiso"));
    let last = log_entries(&dir)
        .into_iter()
        .rfind(|e| e["kind"] == "work")
        .unwrap();
    assert_eq!(last["resume"].as_str(), session_id.as_deref());
    let allowed: Vec<String> = serde_json::from_value(last["allowed"].clone()).unwrap();
    assert!(allowed.contains(&"Bash(curl -s https://example.com)".to_owned()));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn resuming_an_unknown_session_fails_with_the_cli_message() {
    let dir = scratch("resume");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let mut spec = task(&project, "sigue");
    spec.resume = Some("c609e3fd-c1a8-498c-89cb-750d4d5afb16".into());
    let (_, rx) = run(&manager, spec);
    let events = collect(&rx);
    let Some(TaskEvent::Error { message, .. }) = events.last() else {
        panic!("{events:?}")
    };
    assert!(message.contains("No conversation found"), "{message}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn cancelling_kills_the_whole_tree() {
    let dir = scratch("cancel");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let (id, rx) = run(&manager, task(&project, "## Tarea\nDespacio FAKE_SLOW\n"));
    let deadline = Instant::now() + TIMEOUT;
    let child = loop {
        if let Some(pid) = log_entries(&dir).into_iter().find_map(|e| {
            (e["kind"] == "child")
                .then(|| e["child"].as_u64())
                .flatten()
        }) {
            break pid as u32;
        }
        assert!(
            Instant::now() < deadline,
            "the fake never started its child"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert!(alive(child));
    manager.cancel(id);
    let events = collect(&rx);
    assert!(
        matches!(
            events.last(),
            Some(TaskEvent::Error {
                code: ErrorCode::Cancelled,
                ..
            })
        ),
        "{events:?}"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(child) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(child), "the worker's child survived the cancel");
    assert_eq!(manager.running(), 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_plan_is_a_text_only_answer_with_its_usage() {
    let dir = scratch("plan");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let (tx, rx) = mpsc::channel();
    manager
        .ask(
            "test",
            AskSpec {
                agent: "claude".into(),
                model: "sonnet".into(),
                effort: Some("low".into()),
                system: PLANNER.into(),
                prompt: "## Mensaje del usuario\nrenombrá la variable x\n".into(),
                agent_path: None,
            },
            Events(tx),
        )
        .unwrap();
    let events = collect(&rx);
    let Some(TaskEvent::Done { result, usage, .. }) = events.last() else {
        panic!("{events:?}")
    };
    assert!(result.contains("\"model\": \"haiku\""), "{result}");
    assert!(usage.cost_usd > 0.0);
    let plan = log_entries(&dir).into_iter().last().unwrap();
    let args: Vec<String> = serde_json::from_value(plan["args"].clone()).unwrap();
    // The AI layer's isolation: no tools at all.
    assert!(
        args.windows(2)
            .any(|w| w[0] == "--tools" && w[1].is_empty())
    );
    assert!(!args.contains(&"--restricted".to_owned()));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn an_analysis_only_reads_and_answers_the_draft() {
    let dir = scratch("analyze");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let mut spec = task(&project, "Escribí AGENTS.md");
    spec.mode = TaskMode::Analyze;
    let (_, rx) = run(&manager, spec);
    let events = collect(&rx);
    let Some(TaskEvent::Done { result, .. }) = events.last() else {
        panic!("{events:?}")
    };
    assert!(result.starts_with("# AGENTS.md"));
    assert!(!events.iter().any(|e| matches!(
        e,
        TaskEvent::Tool {
            action: ToolAction::Edit | ToolAction::Write | ToolAction::Command,
            ..
        }
    )));
    assert!(
        !project.join("AGENTS.md").exists(),
        "the draft is only text"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn nothing_runs_when_off_or_with_a_pattern_that_allows_anything() {
    let dir = scratch("off");
    let Some(manager) = manager(&dir) else {
        return;
    };
    let project = project(&dir);
    let mut broad = task(&project, "x");
    broad.allowed_commands = vec!["bash *".into()];
    let (_, rx) = run(&manager, broad);
    let events = collect(&rx);
    assert!(matches!(
        events.last(),
        Some(TaskEvent::Error {
            code: ErrorCode::Invalid,
            ..
        })
    ));
    manager.set_enabled(false);
    let (tx, _rx) = mpsc::channel();
    let refused = manager
        .run("test", task(&project, "x"), Events(tx))
        .unwrap_err();
    assert_eq!(refused.code, ErrorCode::Disabled);
    assert!(manager.detect(None, false).is_err());
    assert!(!log_entries(&dir).iter().any(|e| e["kind"] == "work"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_diff_leaves_out_what_was_already_changed_before_the_task() {
    let dir = scratch("diff");
    let repo = dir.join("repo");
    fs::create_dir_all(&repo).unwrap();
    fs::write(repo.join("a.txt"), "uno\ndos\n").unwrap();
    fs::write(repo.join("b.txt"), "b\n").unwrap();
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "inicio"]);
    // The user's own changes before the task.
    fs::write(repo.join("a.txt"), "uno\ndos\ntres\n").unwrap();
    fs::write(repo.join("mio.txt"), "mío\n").unwrap();
    let git_exe = find_on_path("git.exe");
    let snap = snapshot::take(git_exe.as_deref(), &repo, dir.join("snap"));
    // The task's changes.
    fs::write(repo.join("a.txt"), "uno\ndos\ntres\ncuatro\n").unwrap();
    fs::write(repo.join("b.txt"), "B\n").unwrap();
    fs::write(repo.join("nuevo.txt"), "nuevo\n").unwrap();
    let diff = snapshot::diff(git_exe.as_deref(), &snap, &[]);
    let paths: Vec<&str> = diff.files.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["a.txt", "b.txt", "nuevo.txt"], "{diff:?}");
    let a = &diff.files[0];
    assert_eq!(
        (a.additions, a.deletions),
        (1, 0),
        "only the task's line: {}",
        a.diff
    );
    assert!(a.diff.contains("+cuatro") && !a.diff.contains("+tres"));
    assert_eq!(diff.files[2].status, FileStatus::Added);
    // Nothing of Brisa's in the repository.
    let status = Command::new("git")
        .args(["-C", &repo.display().to_string(), "stash", "list"])
        .output()
        .unwrap();
    assert!(status.stdout.is_empty());
    drop(snap);
    assert!(!dir.join("snap").exists(), "the snapshot folder is removed");
    let _ = fs::remove_dir_all(&dir);
}
