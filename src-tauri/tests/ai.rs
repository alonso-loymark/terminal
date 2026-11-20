//! The AI layer end to end, without any real model.
//!
//! Rule: no test talks to a real `claude` or to the real Anthropic API. The CLI provider runs
//! `e2e/fake-agent.mjs` in print mode through a `.cmd` wrapper (like an npm install of Claude
//! Code); the API provider talks to a local fake server, with a throwaway credential.
#![cfg(windows)]

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::{Duration, Instant};

use brisa_lib::ai::{
    AiConfig, AiEvent, AiEvents, AiManager, AiRequest, Effort, Endpoint, ErrorCode, Message,
    Provider, Role, credentials,
};
use brisa_lib::pty::find_on_path;
use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject,
};

const FAKE_AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../e2e/fake-agent.mjs");
const TIMEOUT: Duration = Duration::from_secs(30);
const EXPLAIN_SYSTEM: &str = "Te pasan un comando que falló, con su salida.";

struct Events(Sender<AiEvent>);

impl AiEvents for Events {
    fn send(&self, event: AiEvent) {
        let _ = self.0.send(event);
    }
}

/// A fresh folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "brisa-ai-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// `fake-claude.cmd`: the fake agent in print mode, with its log and state next to it.
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

fn config(dir: &Path, claude: Option<PathBuf>) -> AiConfig {
    AiConfig {
        work_dir: dir.join("work"),
        credential_target: format!("Brisa/test-{}", dir.file_name().unwrap().to_string_lossy()),
        api: Endpoint::parse("http://127.0.0.1:9").unwrap(),
        claude_override: claude,
    }
}

fn request(provider: Provider, system: &str, prompt: &str) -> AiRequest {
    AiRequest {
        provider,
        model: "opus".to_owned(),
        system: system.to_owned(),
        messages: vec![Message {
            role: Role::User,
            content: prompt.to_owned(),
        }],
        effort: Some(Effort::Low),
        max_tokens: 2000,
        claude_path: None,
    }
}

fn start(manager: &AiManager, request: AiRequest) -> Receiver<AiEvent> {
    let (tx, rx) = mpsc::channel();
    manager.start("test", request, Events(tx)).unwrap();
    rx
}

/// Text received and the final event.
fn collect(rx: &Receiver<AiEvent>) -> (String, AiEvent) {
    let mut text = String::new();
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let event = rx
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .expect("the request never finished");
        match event {
            AiEvent::Delta { text: t } => text.push_str(&t),
            AiEvent::Status { .. } => {}
            last => return (text, last),
        }
    }
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

fn enabled(config: AiConfig) -> AiManager {
    let manager = AiManager::new(config);
    manager.set_enabled(true);
    manager
}

#[test]
fn claude_cli_streams_text_from_an_isolated_process() {
    let dir = scratch("stream");
    let Some(claude) = fake_claude(&dir) else {
        eprintln!("skipped: node.exe not found");
        return;
    };
    // As if Brisa itself had been started from inside a Claude Code session.
    // SAFETY: Windows' environment block is safe to change while other threads read it.
    unsafe { std::env::set_var("CLAUDECODE", "1") };
    let manager = enabled(config(&dir, Some(claude)));
    let rx = start(
        &manager,
        request(
            Provider::ClaudeCli,
            EXPLAIN_SYSTEM,
            "Comando: cmd /c exit 3\nCódigo de salida: 3\nñandú €",
        ),
    );
    let (text, last) = collect(&rx);
    assert_eq!(last, AiEvent::Done, "{text}");
    assert!(
        text.starts_with("Explicación falsa: el comando terminó con código 3"),
        "{text}"
    );
    assert!(
        text.contains("```powershell\nWrite-Output arreglado\n```"),
        "{text}"
    );

    let entries = log_entries(&dir);
    let entry = entries.last().expect("the fake logged its run");
    assert_eq!(
        entry["prompt"],
        "Comando: cmd /c exit 3\nCódigo de salida: 3\nñandú €"
    );
    assert_eq!(entry["system"], EXPLAIN_SYSTEM);
    assert_eq!(
        entry["env"]["CLAUDECODE"],
        serde_json::Value::Null,
        "nested-session variables are removed"
    );
    assert_eq!(entry["env"]["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "1");
    let cwd = PathBuf::from(entry["cwd"].as_str().unwrap());
    assert_eq!(
        cwd.canonicalize().unwrap(),
        dir.join("work").canonicalize().unwrap(),
        "runs in Brisa's empty folder"
    );
    let work: Vec<_> = fs::read_dir(dir.join("work")).unwrap().collect();
    assert!(
        work.is_empty(),
        "the system prompt file is removed afterwards"
    );
    assert_eq!(manager.running(), 0);
}

#[test]
fn claude_cli_failures_are_explained() {
    let dir = scratch("failures");
    let Some(claude) = fake_claude(&dir) else {
        eprintln!("skipped: node.exe not found");
        return;
    };
    let manager = enabled(config(&dir, Some(claude.clone())));
    let code_of =
        |prompt: &str| match collect(&start(&manager, request(Provider::ClaudeCli, "x", prompt))).1
        {
            AiEvent::Error { code, message } => (code, message),
            other => panic!("{prompt}: {other:?}"),
        };
    let (code, message) = code_of("FAKE_AUTH_ERROR");
    assert_eq!(code, ErrorCode::Auth);
    assert!(message.contains("Not logged in"), "{message}");
    assert_eq!(code_of("FAKE_LIMIT").0, ErrorCode::Limit);
    assert_eq!(code_of("FAKE_UNKNOWN_OPTION").0, ErrorCode::Outdated);
    let (code, message) = code_of("FAKE_CRASH");
    assert_eq!(code, ErrorCode::Failed);
    assert!(
        message.contains("algo se rompió") && message.contains("código 3"),
        "{message}"
    );

    // Logged out according to the CLI itself.
    fs::write(dir.join("state.json"), r#"{"loggedIn":false}"#).unwrap();
    assert_eq!(code_of("hola").0, ErrorCode::Auth);
    let status = brisa_lib::ai::claude_cli::status(manager.config(), None).unwrap();
    assert_eq!(status.logged_in, Some(false));
    assert!(status.version.unwrap().contains("2.1.329"));

    // A configured path that does not exist: an error, never another claude.
    let mut missing = request(Provider::ClaudeCli, "x", "hola");
    missing.claude_path = Some(r"C:\no\existe\claude.exe".to_owned());
    match collect(&start(&manager, missing)).1 {
        AiEvent::Error { code, .. } => assert_eq!(code, ErrorCode::NotInstalled),
        other => panic!("{other:?}"),
    }
    let mut bad_model = request(Provider::ClaudeCli, "x", "hola");
    bad_model.model = "--dangerously-skip-permissions".to_owned();
    match collect(&start(&manager, bad_model)).1 {
        AiEvent::Error { code, .. } => assert_eq!(code, ErrorCode::Invalid),
        other => panic!("{other:?}"),
    }
}

#[test]
fn cancelling_kills_the_whole_claude_tree() {
    let dir = scratch("cancel");
    let Some(claude) = fake_claude(&dir) else {
        eprintln!("skipped: node.exe not found");
        return;
    };
    let manager = enabled(config(&dir, Some(claude)));
    let (tx, rx) = mpsc::channel();
    let id = manager
        .start(
            "test",
            request(Provider::ClaudeCli, "x", "FAKE_SLOW"),
            Events(tx),
        )
        .unwrap();
    // First text: the fake (node, under cmd.exe) is streaming.
    let first = rx.recv_timeout(TIMEOUT).unwrap();
    assert!(matches!(first, AiEvent::Delta { .. }), "{first:?}");
    let pid = log_entries(&dir)[0]["pid"].as_u64().unwrap() as u32;
    assert!(alive(pid));
    let started = Instant::now();
    manager.cancel(id);
    let (_, last) = collect(&rx);
    assert!(
        matches!(
            last,
            AiEvent::Error {
                code: ErrorCode::Cancelled,
                ..
            }
        ),
        "{last:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "cancelled promptly"
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(!alive(pid), "node (the grandchild through cmd.exe) is gone");
}

#[test]
fn nothing_runs_while_disabled() {
    let dir = scratch("disabled");
    let Some(claude) = fake_claude(&dir) else {
        eprintln!("skipped: node.exe not found");
        return;
    };
    let manager = AiManager::new(config(&dir, Some(claude)));
    let (tx, _rx) = mpsc::channel();
    let err = manager
        .start(
            "test",
            request(Provider::ClaudeCli, "x", "hola"),
            Events(tx),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Disabled);
    let (tx, _rx) = mpsc::channel();
    let err = manager
        .start(
            "test",
            request(Provider::AnthropicApi, "x", "hola"),
            Events(tx),
        )
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Disabled);
    thread::sleep(Duration::from_millis(300));
    assert!(log_entries(&dir).is_empty(), "the fake claude never ran");

    // Turning it off cancels what runs.
    manager.set_enabled(true);
    let rx = start(&manager, request(Provider::ClaudeCli, "x", "FAKE_SLOW"));
    assert!(matches!(
        rx.recv_timeout(TIMEOUT).unwrap(),
        AiEvent::Delta { .. }
    ));
    manager.set_enabled(false);
    assert!(matches!(
        collect(&rx).1,
        AiEvent::Error {
            code: ErrorCode::Cancelled,
            ..
        }
    ));
}

/// A one-request-at-a-time fake of the Messages API: records each request, answers with
/// `respond(headers, body)` → (status, content type, body).
fn fake_api(
    respond: impl Fn(&str, &str) -> (u16, &'static str, String) + Send + 'static,
) -> (Endpoint, Receiver<(String, String)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length = head
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            reader.read_exact(&mut body).unwrap();
            let body = String::from_utf8(body).unwrap();
            let (status, kind, reply) = respond(&head, &body);
            let _ = tx.send((head, body));
            let _ = write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: {kind}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                reply.len()
            );
        }
    });
    (
        Endpoint::parse(&format!("http://127.0.0.1:{port}")).unwrap(),
        rx,
    )
}

fn sse(text: &str) -> String {
    let delta = serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}});
    format!(
        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{}}}}\n\nevent: content_block_delta\ndata: {delta}\n\nevent: message_delta\ndata: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}}}}\n\nevent: message_stop\ndata: {{\"type\":\"message_stop\"}}\n\n"
    )
}

#[test]
fn anthropic_api_streams_with_the_key_from_the_credential_manager() {
    let dir = scratch("api");
    // In pieces: no key-shaped literal in the repository (secret scanners).
    let key = concat!("sk-", "ant-", "api03-", "test-key-for-brisa-e2e-0000");
    let (endpoint, requests) = fake_api(move |head, _| {
        if head
            .to_ascii_lowercase()
            .contains(&format!("x-api-key: {key}"))
        {
            (200, "text/event-stream", sse("Hola desde la API falsa"))
        } else {
            (401, "application/json", r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#.to_owned())
        }
    });
    let mut config = config(&dir, None);
    config.api = endpoint;
    let target = config.credential_target.clone();
    let manager = enabled(config);

    // No key yet.
    match collect(&start(
        &manager,
        request(Provider::AnthropicApi, "sys", "hola"),
    ))
    .1
    {
        AiEvent::Error { code, .. } => assert_eq!(code, ErrorCode::NoKey),
        other => panic!("{other:?}"),
    }

    credentials::write(&target, key).unwrap();
    assert_eq!(credentials::read(&target).as_deref(), Some(key));
    assert_eq!(credentials::hint(&target).as_deref(), Some("…0000"));
    let (text, last) = collect(&start(
        &manager,
        request(Provider::AnthropicApi, "sys", "hola"),
    ));
    assert_eq!(last, AiEvent::Done);
    assert_eq!(text, "Hola desde la API falsa");
    let (head, body) = requests.recv_timeout(TIMEOUT).unwrap();
    let head = head.to_ascii_lowercase();
    assert!(head.starts_with("post /v1/messages "), "{head}");
    assert!(head.contains("anthropic-version: 2026-10-21"), "{head}");
    let body: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["model"], "claude-opus-5-5");
    assert_eq!(body["stream"], true);
    assert_eq!(body["system"], "sys");
    assert_eq!(body["messages"][0]["content"], "hola");

    credentials::write(&target, "sk-ant-api03-wrong").unwrap();
    match collect(&start(
        &manager,
        request(Provider::AnthropicApi, "sys", "hola"),
    ))
    .1
    {
        AiEvent::Error { code, message } => {
            assert_eq!(code, ErrorCode::ApiKey);
            assert!(message.contains("invalid x-api-key"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(credentials::delete(&target), Ok(true));
    assert_eq!(credentials::delete(&target), Ok(false));
    assert_eq!(credentials::read(&target), None);
}

#[test]
fn no_server_is_a_network_error() {
    let dir = scratch("network");
    let mut config = config(&dir, None);
    // Nothing listens on port 9 (discard) here.
    config.api = Endpoint::parse("http://127.0.0.1:9").unwrap();
    let target = config.credential_target.clone();
    credentials::write(&target, "sk-ant-api03-whatever").unwrap();
    let manager = enabled(config);
    let result = collect(&start(
        &manager,
        request(Provider::AnthropicApi, "sys", "hola"),
    ))
    .1;
    let _ = credentials::delete(&target);
    match result {
        AiEvent::Error { code, .. } => assert_eq!(code, ErrorCode::Network),
        other => panic!("{other:?}"),
    }
}
