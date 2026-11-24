//! The Claude Code adapter: `claude` with the user's own login (subscription).
//!
//! - **Detect**: `claude --version`, `claude auth status --json` and the models from the CLI's
//!   `initialize` control request (stream-json input): the same list `/model` shows, with each
//!   model's effort levels and price. Nothing is asked to any model (verified with claude
//!   2.1.329 and an empty `CLAUDE_CONFIG_DIR`: it answers without a login).
//! - **Ask** (the plan): the AI layer's text-only command line (`ai::claude_cli::args`): no
//!   tools, no project, nothing saved.
//! - **Run** (a worker), in the project folder, flags from code.claude.com/docs/en/permissions,
//!   /cli-reference and /headless (accepted by claude 2.1.329):
//!   - `--restricted`: no command-running tool unless `--tools` names it, no user/project/local
//!     settings files (no hooks or allow rules of the repo), file tools confined to the project,
//!     writes to git and settings need a person, `bypassPermissions` refused.
//!   - `--tools Read,Edit,Write,Glob,Grep,Bash,PowerShell` (analysis: `Read,Glob,Grep`).
//!   - `--permission-mode dontAsk`: whatever is not pre-approved is denied, never prompted.
//!   - `--allowedTools Edit Write Bash(<pattern>)…` and `--disallowedTools` with the secret
//!     files (see `permissions.rs`).
//!   - `--strict-mcp-config`, `--disable-slash-commands`; `--model`, `--effort`,
//!     `--max-turns`, `--resume <session>`.
//!   - Never `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` or
//!     `--permission-mode bypassPermissions` (a test checks it).
//!
//! The prompt (the orchestrator's brief) goes through stdin; Brisa's rules for workers through
//! `--append-system-prompt-file`. The process tree runs in a Job Object: cancelling kills it.

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::permissions::{
    ANALYZE_TOOLS, WORK_TOOLS, allowed_rules, denied_rules, validate_pattern,
};
use super::stream::{Item, WorkStream};
use super::{
    AgentAdapter, AgentInfo, AgentsConfig, AskSpec, ModelInfo, Outcome, RunFailure, TaskEvent,
    TaskMode, TaskSpec, valid_effort, valid_session,
};
use crate::ai::process::{TempFile, Tree, capture, command, feed, read_lines, read_tail};
use crate::ai::stream::classify_cli_exit;
use crate::ai::{CancelToken, ErrorCode, Failure, claude_cli, valid_model};

const POLL: Duration = Duration::from_millis(100);
/// A worker that runs longer than this is stopped (the user can cancel before).
const WORK_TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);
const ASK_TIMEOUT: Duration = Duration::from_secs(300);
const DETECT_TIMEOUT: Duration = Duration::from_secs(25);
/// Upper bound of `--max-turns` (the setting's own range is smaller).
const MAX_TURNS: u32 = 500;

pub struct ClaudeCode;

/// The `initialize` control request (the SDKs send it first; the answer lists the models).
const INITIALIZE: &str =
    r#"{"type":"control_request","request_id":"brisa_init","request":{"subtype":"initialize"}}"#;

fn init_args() -> Vec<OsString> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--safe-mode",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--no-session-persistence",
    ]
    .iter()
    .map(OsString::from)
    .collect()
}

/// The models of an `initialize` answer.
pub fn models_of(line: &Value) -> Option<Vec<ModelInfo>> {
    if line["type"] != "control_response" {
        return None;
    }
    let response = &line["response"];
    let body = if response["response"].is_object() {
        &response["response"]
    } else {
        response
    };
    let models = body["models"].as_array()?;
    Some(
        models
            .iter()
            .filter_map(|m| {
                let value = m["value"].as_str()?.to_owned();
                if !valid_model(&value) {
                    return None;
                }
                let efforts = if m["supportsEffort"].as_bool().unwrap_or(false) {
                    m["supportedEffortLevels"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .filter(|e| valid_effort(e))
                        .map(str::to_owned)
                        .collect()
                } else {
                    Vec::new()
                };
                Some(ModelInfo {
                    display_name: m["displayName"].as_str().unwrap_or(&value).to_owned(),
                    description: m["description"].as_str().unwrap_or_default().to_owned(),
                    resolved: m["resolvedModel"].as_str().map(str::to_owned),
                    value,
                    efforts,
                })
            })
            .collect(),
    )
}

/// The fixed shape of a worker's final answer (the orchestrator shows it as markdown).
pub const SUMMARY_FORMAT: &str = "**Qué cambió:** los archivos y el cambio, en una o dos líneas.\n\
     **Cómo probarlo:** el comando o los pasos para verificarlo.\n\
     **Pendiente:** lo que quedó sin hacer o sin verificar (o «Nada.»).";

/// The line a worker adds when the task left AGENTS.md out of date (the orchestrator offers to
/// update it, with the user's confirmation).
pub const AGENTS_STALE_MARKER: &str = "AGENTS.md desactualizado:";

/// Brisa's rules for a worker, appended to Claude Code's own system prompt.
pub fn worker_rules(mode: TaskMode, commands: &[String]) -> String {
    match mode {
        TaskMode::Analyze => {
            "Trabajás para Brisa (un orquestador de agentes) de forma no interactiva: nadie \
             puede responderte durante la tarea. Solo podés leer el proyecto (no editar ni \
             ejecutar comandos). No leas archivos de secretos (.env, claves). Tu respuesta final \
             es el resultado de la tarea, completo y sin comentarios alrededor."
                .to_owned()
        }
        TaskMode::Work => {
            let list = if commands.is_empty() {
                "ninguno".to_owned()
            } else {
                commands
                    .iter()
                    .map(|c| format!("`{c}`"))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            format!(
                "Trabajás para Brisa (un orquestador de agentes) de forma no interactiva: nadie \
                 puede responderte durante la tarea.\n\
                 - Hacé solo la tarea pedida, en la carpeta del proyecto.\n\
                 - Podés leer y editar archivos del proyecto y ejecutar solo estos comandos \
                 (`*` = cualquier argumento): {list}. Cualquier otro comando o herramienta será \
                 denegado: no busques rodeos (otro comando equivalente, scripts). Si necesitás \
                 algo fuera de lo permitido, terminá y explicá qué necesitás y por qué: Brisa se \
                 lo pregunta al usuario.\n\
                 - No leas archivos de secretos (.env, claves). No hagas commits ni cambies de \
                 rama.\n\
                 - Las instrucciones del proyecto están en AGENTS.md (y CLAUDE.md), si existen: \
                 seguilas. No edites AGENTS.md ni CLAUDE.md.\n\
                 - Tu respuesta final es un resumen corto en español con exactamente estas tres \
                 secciones, en este orden, sin nada antes ni después, sin repetir información \
                 entre ellas ni copiar el diff (Brisa ya lo muestra):\n\
                 {SUMMARY_FORMAT}\n\
                 - Si la tarea dejó AGENTS.md desactualizado (comandos, estructura o \
                 convenciones que cambiaron), agregá al final una sola línea: \
                 `{AGENTS_STALE_MARKER} <qué hay que cambiar>`. Si no, no la agregues."
            )
        }
    }
}

/// The command line of a worker after `claude`.
pub fn work_args(
    spec: &TaskSpec,
    commands: &[String],
    rules_file: &Path,
) -> Result<Vec<OsString>, Failure> {
    let invalid = |what: String| Failure::new(ErrorCode::Invalid, what);
    if !valid_model(&spec.model) {
        return Err(invalid(format!("Modelo inválido: «{}».", spec.model)));
    }
    let mut args: Vec<OsString> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--restricted",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--disable-slash-commands",
        "--model",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    args.push(spec.model.clone().into());
    if spec.mode == TaskMode::Work && !spec.images.is_empty() {
        // The brief and the images go as one stream-json message (see `stream_json_prompt`).
        args.push("--input-format".into());
        args.push("stream-json".into());
    }
    args.push("--tools".into());
    match spec.mode {
        TaskMode::Work => {
            args.push(WORK_TOOLS.into());
            args.push("--allowedTools".into());
            args.extend(allowed_rules(commands).into_iter().map(OsString::from));
        }
        TaskMode::Analyze => args.push(ANALYZE_TOOLS.into()),
    }
    args.push("--disallowedTools".into());
    args.extend(denied_rules().into_iter().map(OsString::from));
    if let Some(effort) = spec.effort.as_deref() {
        if !valid_effort(effort) {
            return Err(invalid(format!("Esfuerzo inválido: «{effort}».")));
        }
        args.push("--effort".into());
        args.push(effort.into());
    }
    if let Some(turns) = spec.max_turns {
        args.push("--max-turns".into());
        args.push(turns.clamp(1, MAX_TURNS).to_string().into());
    }
    if let Some(session) = spec.resume.as_deref() {
        if !valid_session(session) {
            return Err(invalid(format!("Sesión inválida: «{session}».")));
        }
        args.push("--resume".into());
        args.push(session.into());
    }
    args.push("--append-system-prompt-file".into());
    args.push(rules_file.as_os_str().to_owned());
    Ok(args)
}

/// The brief with the pasted images as one stream-json user message (`--input-format
/// stream-json`, the same shape the SDKs send): an image cannot go in plain stdin text, and the
/// worker's file tools cannot read Brisa's temporary folder (they are confined to the project).
/// Images first, as the Messages API recommends.
pub fn stream_json_prompt(text: &str, images: &[Vec<u8>]) -> String {
    let mut content: Vec<Value> = images
        .iter()
        .map(|png| {
            serde_json::json!({
                "type": "image",
                "source": { "type": "base64", "media_type": "image/png", "data": crate::images::base64(png) },
            })
        })
        .collect();
    content.push(serde_json::json!({ "type": "text", "text": text }));
    let message =
        serde_json::json!({ "type": "user", "message": { "role": "user", "content": content } });
    format!("{message}\n")
}

/// The images of a task, read and checked (only PNGs Brisa saved).
fn attachments(spec: &TaskSpec) -> Result<Vec<Vec<u8>>, Failure> {
    let dir = crate::images::images_dir();
    spec.images
        .iter()
        .map(|path| {
            crate::images::read_attachment(&dir, Path::new(path)).map_err(|e| {
                Failure::new(
                    ErrorCode::Invalid,
                    format!("No se pudo adjuntar la imagen: {e}."),
                )
            })
        })
        .collect()
}

fn find(config: &AgentsConfig, custom: Option<&str>) -> Result<PathBuf, Failure> {
    claude_cli::find_claude(custom, config.claude_override.as_deref())
}

fn ensure_dir(dir: &Path) -> Result<(), Failure> {
    fs::create_dir_all(dir).map_err(|e| {
        Failure::new(
            ErrorCode::Failed,
            format!("no se pudo crear {}: {e}", dir.display()),
        )
    })
}

/// Runs `claude args` in `cwd` with `prompt` on stdin and turns its stream into events.
#[allow(clippy::too_many_arguments)]
fn stream_run(
    exe: &Path,
    args: &[OsString],
    cwd: &Path,
    prompt: String,
    timeout: Duration,
    cancel: &CancelToken,
    emit: &dyn Fn(TaskEvent),
) -> Result<Outcome, RunFailure> {
    let mut command = command(exe, args, cwd);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if cancel.is_cancelled() {
        return Err(Failure::new(ErrorCode::Cancelled, "Cancelado.").into());
    }
    let tree = Tree::spawn(command).map_err(|e| {
        Failure::new(
            ErrorCode::NotInstalled,
            format!("No se pudo ejecutar {}: {e}", exe.display()),
        )
    })?;
    let killer = Arc::downgrade(&tree);
    cancel.on_cancel(move || {
        if let Some(tree) = killer.upgrade() {
            tree.kill();
        }
    });
    let (stdin, stdout, stderr) = tree.take_pipes();
    feed(stdin, prompt);
    let stderr = stderr.map(read_tail);
    let Some(rx) = stdout.map(read_lines) else {
        return Err(Failure::new(ErrorCode::Failed, "claude no tiene salida.").into());
    };

    let deadline = Instant::now() + timeout;
    let mut parser = WorkStream::default();
    let mut finish = None;
    let mut timed_out = false;
    loop {
        match rx.recv_timeout(POLL) {
            Ok(line) => {
                for item in parser.line(&line) {
                    match item {
                        Item::Started { session_id, model } => {
                            emit(TaskEvent::Started { session_id, model });
                        }
                        Item::Text(text) => emit(TaskEvent::Text { text }),
                        Item::Tool {
                            id,
                            tool,
                            action,
                            target,
                        } => emit(TaskEvent::Tool {
                            id,
                            tool,
                            action,
                            target,
                        }),
                        Item::ToolDone { id, ok } => emit(TaskEvent::ToolDone { id, ok }),
                        Item::Denied(denial) => emit(TaskEvent::Denied { denial }),
                        Item::Status(message) => emit(TaskEvent::Status { message }),
                        Item::Finished(f) => finish = Some(f),
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                if Instant::now() > deadline && !timed_out {
                    timed_out = true;
                    tree.kill();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    let exit_code = tree.wait_exit(Duration::from_secs(5));
    let stderr = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
    if cancel.is_cancelled() {
        return Err(RunFailure {
            failure: Failure::new(ErrorCode::Cancelled, "Cancelado."),
            usage: finish.map(|f| f.usage),
        });
    }
    if timed_out {
        return Err(Failure::new(
            ErrorCode::Timeout,
            format!("El agente no terminó en {} min.", timeout.as_secs() / 60),
        )
        .into());
    }
    let Some(finish) = finish else {
        return Err(classify_cli_exit(&stderr, exit_code).into());
    };
    match finish.result {
        Ok(result) => Ok(Outcome {
            result,
            session_id: finish.session_id,
            usage: finish.usage,
            denials: finish.denials,
        }),
        Err(mut failure) => {
            // A bare subtype (`error_during_execution`) says less than stderr ("No conversation
            // found with session ID…").
            let stderr = stderr.trim();
            if !failure.message.contains(char::is_whitespace) && !stderr.is_empty() {
                let start = stderr.char_indices().rev().nth(600).map_or(0, |(i, _)| i);
                failure.message = stderr[start..].to_owned();
            }
            Err(RunFailure {
                failure,
                usage: Some(finish.usage),
            })
        }
    }
}

/// The models from the CLI's `initialize` answer.
fn detect_models(exe: &Path, work_dir: &Path) -> Result<Vec<ModelInfo>, Failure> {
    let mut command = command(exe, &init_args(), work_dir);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let tree = Tree::spawn(command).map_err(|e| {
        Failure::new(
            ErrorCode::NotInstalled,
            format!("No se pudo ejecutar {}: {e}", exe.display()),
        )
    })?;
    let (stdin, stdout, stderr) = tree.take_pipes();
    feed(stdin, format!("{INITIALIZE}\n"));
    let stderr = stderr.map(read_tail);
    let Some(rx) = stdout.map(read_lines) else {
        return Err(Failure::new(ErrorCode::Failed, "claude no tiene salida."));
    };
    let deadline = Instant::now() + DETECT_TIMEOUT;
    let mut models = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(POLL) {
            Ok(line) => {
                if let Some(found) = serde_json::from_str::<Value>(&line)
                    .ok()
                    .and_then(|v| models_of(&v))
                {
                    models = Some(found);
                    break;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
    // Nothing else to ask: no user message was sent, so no model was called.
    tree.kill();
    let stderr = stderr.and_then(|t| t.join().ok()).unwrap_or_default();
    match models {
        Some(models) if !models.is_empty() => Ok(models),
        Some(_) => Err(Failure::new(
            ErrorCode::Failed,
            "Claude Code no informó ningún modelo.",
        )),
        None => {
            let mut failure = classify_cli_exit(&stderr, None);
            if failure.code == ErrorCode::Failed {
                failure.message =
                    format!("No se pudieron detectar los modelos: {}", failure.message);
            }
            Err(failure)
        }
    }
}

impl AgentAdapter for ClaudeCode {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn name(&self) -> &'static str {
        "Claude Code"
    }

    fn detect(&self, config: &AgentsConfig, custom_path: Option<&str>) -> AgentInfo {
        let mut info = AgentInfo {
            id: self.id().to_owned(),
            name: self.name().to_owned(),
            installed: false,
            path: None,
            version: None,
            logged_in: None,
            auth_method: None,
            models: Vec::new(),
            error: None,
        };
        let exe = match find(config, custom_path) {
            Ok(exe) => exe,
            Err(failure) => {
                info.error = Some(failure);
                return info;
            }
        };
        info.installed = true;
        info.path = Some(exe.display().to_string());
        if let Err(failure) = ensure_dir(&config.work_dir) {
            info.error = Some(failure);
            return info;
        }
        info.version = capture(
            &exe,
            &["--version"],
            &config.work_dir,
            Duration::from_secs(15),
        )
        .and_then(|(code, out)| (code == Some(0)).then(|| out.trim().to_owned()))
        .filter(|v| !v.is_empty());
        let auth = capture(
            &exe,
            &["auth", "status", "--json"],
            &config.work_dir,
            Duration::from_secs(20),
        )
        .and_then(|(_, out)| serde_json::from_str::<Value>(out.trim()).ok());
        info.logged_in = auth.as_ref().and_then(|a| a["loggedIn"].as_bool());
        info.auth_method = auth
            .as_ref()
            .and_then(|a| a["authMethod"].as_str().map(str::to_owned));
        match detect_models(&exe, &config.work_dir) {
            Ok(models) => info.models = models,
            Err(failure) => info.error = Some(failure),
        }
        info
    }

    fn ask(
        &self,
        config: &AgentsConfig,
        id: u32,
        spec: &AskSpec,
        cancel: &CancelToken,
        emit: &dyn Fn(TaskEvent),
    ) -> Result<Outcome, RunFailure> {
        if !valid_model(&spec.model) {
            return Err(Failure::new(
                ErrorCode::Invalid,
                format!("Modelo inválido: «{}».", spec.model),
            )
            .into());
        }
        if let Some(effort) = spec.effort.as_deref().filter(|e| !valid_effort(e)) {
            return Err(Failure::new(
                ErrorCode::Invalid,
                format!("Esfuerzo inválido: «{effort}»."),
            )
            .into());
        }
        let exe = find(config, spec.agent_path.as_deref())?;
        ensure_dir(&config.work_dir)?;
        let system = TempFile::write(
            config
                .work_dir
                .join(format!("plan-{}-{id}.txt", std::process::id())),
            &spec.system,
        )
        .map_err(|e| Failure::new(ErrorCode::Failed, format!("no se pudo preparar: {e}")))?;
        let args = claude_cli::args(&spec.model, spec.effort.as_deref(), &system.0);
        stream_run(
            &exe,
            &args,
            &config.work_dir,
            spec.prompt.clone(),
            ASK_TIMEOUT,
            cancel,
            emit,
        )
    }

    fn run(
        &self,
        config: &AgentsConfig,
        id: u32,
        spec: &TaskSpec,
        cancel: &CancelToken,
        emit: &dyn Fn(TaskEvent),
    ) -> Result<Outcome, RunFailure> {
        let dir = PathBuf::from(&spec.dir);
        if !dir.is_dir() {
            return Err(Failure::new(
                ErrorCode::Invalid,
                format!("No existe la carpeta del proyecto: {}", dir.display()),
            )
            .into());
        }
        let mut commands: Vec<String> = Vec::new();
        for pattern in &spec.allowed_commands {
            let pattern = validate_pattern(pattern).map_err(|why| {
                Failure::new(
                    ErrorCode::Invalid,
                    format!("Comando permitido inválido «{pattern}»: {why}."),
                )
            })?;
            if !commands.contains(&pattern) {
                commands.push(pattern);
            }
        }
        let exe = find(config, spec.agent_path.as_deref())?;
        ensure_dir(&config.work_dir)?;
        let rules = TempFile::write(
            config
                .work_dir
                .join(format!("worker-{}-{id}.txt", std::process::id())),
            &worker_rules(spec.mode, &commands),
        )
        .map_err(|e| Failure::new(ErrorCode::Failed, format!("no se pudo preparar: {e}")))?;
        let args = work_args(spec, &commands, &rules.0)?;
        let prompt = if spec.mode == TaskMode::Work && !spec.images.is_empty() {
            stream_json_prompt(&spec.prompt, &attachments(spec)?)
        } else {
            spec.prompt.clone()
        };
        stream_run(&exe, &args, &dir, prompt, WORK_TIMEOUT, cancel, emit)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(mode: TaskMode) -> TaskSpec {
        TaskSpec {
            agent: "claude".into(),
            dir: r"C:\p".into(),
            prompt: "x".into(),
            model: "sonnet".into(),
            effort: Some("medium".into()),
            resume: Some("c609e3fd-c1a8-498c-89cb-750d4d5afb16".into()),
            mode,
            allowed_commands: Vec::new(),
            max_turns: Some(40),
            agent_path: None,
            images: Vec::new(),
        }
    }

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn a_worker_edits_and_runs_only_the_allowed_commands() {
        let args = strings(
            work_args(
                &spec(TaskMode::Work),
                &["npm run build *".to_owned(), "npm test *".to_owned()],
                Path::new(r"C:\t\rules.txt"),
            )
            .unwrap(),
        );
        let pair = |flag: &str, value: &str| args.windows(2).any(|w| w[0] == flag && w[1] == value);
        assert_eq!(args[0], "-p");
        assert!(pair("--output-format", "stream-json"));
        assert!(args.contains(&"--restricted".to_owned()));
        assert!(pair("--permission-mode", "dontAsk"));
        assert!(pair("--tools", WORK_TOOLS));
        assert!(pair("--model", "sonnet"));
        assert!(pair("--effort", "medium"));
        assert!(pair("--max-turns", "40"));
        assert!(pair("--resume", "c609e3fd-c1a8-498c-89cb-750d4d5afb16"));
        assert!(pair("--append-system-prompt-file", r"C:\t\rules.txt"));
        assert!(args.contains(&"--strict-mcp-config".to_owned()));
        let allowed = args.iter().position(|a| a == "--allowedTools").unwrap();
        let denied = args.iter().position(|a| a == "--disallowedTools").unwrap();
        assert_eq!(
            &args[allowed + 1..allowed + 5],
            [
                "Edit",
                "Write",
                "Bash(npm run build *)",
                "PowerShell(npm run build *)"
            ]
        );
        assert!(args[denied + 1..].contains(&"Read(.env)".to_owned()));
        // Never anything that turns permissions off.
        assert!(!args.iter().any(|a| a.contains("dangerously")
            || a.contains("bypassPermissions")
            || a == "--permission-mode=acceptEdits"
            || a == "default"));
    }

    #[test]
    fn images_go_with_the_brief_as_one_stream_json_message() {
        let mut with_images = spec(TaskMode::Work);
        with_images.images = vec![r"C:\t\brisa-1.png".into()];
        let args = strings(work_args(&with_images, &[], Path::new("r.txt")).unwrap());
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--input-format" && w[1] == "stream-json")
        );
        let plain = strings(work_args(&spec(TaskMode::Work), &[], Path::new("r.txt")).unwrap());
        assert!(!plain.contains(&"--input-format".to_owned()));
        let line = stream_json_prompt("## Tarea\nx", &[b"\x89PNG".to_vec()]);
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["type"], "user");
        let content = value["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], "iVBORw==");
        assert_eq!(content[1]["text"], "## Tarea\nx");
    }

    #[test]
    fn an_analysis_only_reads() {
        let args = strings(work_args(&spec(TaskMode::Analyze), &[], Path::new("r.txt")).unwrap());
        assert!(
            args.windows(2)
                .any(|w| w[0] == "--tools" && w[1] == ANALYZE_TOOLS)
        );
        assert!(!args.contains(&"--allowedTools".to_owned()));
        assert!(!args.contains(&"Edit".to_owned()) && !args.contains(&"Write".to_owned()));
    }

    #[test]
    fn arguments_that_could_be_flags_are_refused() {
        let mut bad = spec(TaskMode::Work);
        bad.model = "--dangerously-skip-permissions".into();
        assert_eq!(
            work_args(&bad, &[], Path::new("r")).unwrap_err().code,
            ErrorCode::Invalid
        );
        let mut bad = spec(TaskMode::Work);
        bad.effort = Some("high --tools default".into());
        assert!(work_args(&bad, &[], Path::new("r")).is_err());
        let mut bad = spec(TaskMode::Work);
        bad.resume = Some("--continue".into());
        assert!(work_args(&bad, &[], Path::new("r")).is_err());
    }

    #[test]
    fn models_come_from_the_initialize_answer() {
        let line: Value = serde_json::from_str(r#"{"type":"control_response","response":{"subtype":"success","request_id":"brisa_init","response":{"models":[
            {"value":"default","resolvedModel":"claude-opus-5-5","displayName":"Default (recommended)","description":"Use the default model (currently Opus 5.5) · $4/$20 per Mtok","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet","description":"Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"]},
            {"value":"haiku","resolvedModel":"claude-haiku-5-5","displayName":"Haiku","description":"Haiku 5.5 · Fastest","supportsEffort":false},
            {"value":"--bad","displayName":"x"}
        ],"claude_code_version":"2.1.329"}}}"#).unwrap();
        let models = models_of(&line).unwrap();
        assert_eq!(models.len(), 3);
        assert_eq!(models[1].value, "sonnet");
        assert_eq!(models[1].display_name, "Sonnet");
        assert_eq!(models[1].resolved.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(models[1].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert!(models[2].efforts.is_empty());
        assert!(models_of(&serde_json::json!({"type":"system"})).is_none());
    }

    #[test]
    fn worker_rules_list_the_allowed_commands() {
        let rules = worker_rules(TaskMode::Work, &["npm test *".to_owned()]);
        assert!(rules.contains("`npm test *`"));
        assert!(rules.contains("AGENTS.md"));
        assert!(worker_rules(TaskMode::Work, &[]).contains("ninguno"));
        // The fixed summary, and the line that says AGENTS.md is out of date.
        for part in [
            "**Qué cambió:**",
            "**Cómo probarlo:**",
            "**Pendiente:**",
            "en español",
            AGENTS_STALE_MARKER,
        ] {
            assert!(rules.contains(part), "{part}");
        }
    }
}
