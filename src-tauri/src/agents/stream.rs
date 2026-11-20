//! Parser of `claude -p --output-format stream-json --verbose --include-partial-messages` for a
//! worker: one JSON object per line. Pure (unit tested with the shapes captured from claude
//! 2.1.329 and the documentation).
//!
//! - `system`/`init`: the session id and model.
//! - `stream_event` with a `text_delta`: text as it is written.
//! - `assistant`: the complete message; its `tool_use` blocks are what the worker does (read,
//!   edit, run…). An `error` field (`authentication_failed`…) explains a failed run.
//! - `user` with `tool_result`: how each call ended.
//! - `system`/`permission_denied` and the result's `permission_denials`: calls the permission
//!   rules did not allow (never run).
//! - `result`: the end, with `usage`, `total_cost_usd`, `num_turns` and `session_id`.

use std::collections::HashSet;

use serde_json::Value;

use super::permissions::{SHELL_TOOLS, suggest_allow};
use super::{Denial, ToolAction, Usage};
use crate::ai::stream::classify_cli;
use crate::ai::{ErrorCode, Failure};

/// What one line means for the run.
#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    Started {
        session_id: Option<String>,
        model: Option<String>,
    },
    Text(String),
    Tool {
        id: String,
        tool: String,
        action: ToolAction,
        target: String,
    },
    ToolDone {
        id: String,
        ok: bool,
    },
    Denied(Denial),
    Status(String),
    Finished(Box<Finish>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finish {
    pub result: Result<String, Failure>,
    pub session_id: Option<String>,
    pub usage: Usage,
    pub denials: Vec<Denial>,
}

#[derive(Debug, Default)]
pub struct WorkStream {
    /// Partial messages arrived: the complete `assistant` message repeats their text.
    streamed: bool,
    /// Some text was shown: the next text after a tool call starts a new paragraph.
    wrote: bool,
    after_tool: bool,
    error_kind: Option<String>,
    tools: HashSet<String>,
    denied: HashSet<String>,
    session_id: Option<String>,
    finished: bool,
}

fn str_of<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str))
}

/// What a tool call does and on what (path, command, pattern).
pub fn describe_tool(name: &str, input: &Value) -> (ToolAction, String) {
    let text = |keys: &[&str]| str_of(input, keys).unwrap_or_default().to_owned();
    match name {
        "Read" => (ToolAction::Read, text(&["file_path", "path"])),
        "Edit" | "MultiEdit" => (ToolAction::Edit, text(&["file_path", "path"])),
        "NotebookEdit" => (ToolAction::Edit, text(&["notebook_path", "file_path"])),
        "Write" => (ToolAction::Write, text(&["file_path", "path"])),
        "Bash" | "PowerShell" => (ToolAction::Command, text(&["command"])),
        "Glob" | "Grep" => {
            let pattern = text(&["pattern"]);
            let path = text(&["path"]);
            let target = if path.is_empty() {
                pattern
            } else {
                format!("{pattern} en {path}")
            };
            (ToolAction::Search, target)
        }
        "LS" => (ToolAction::Search, text(&["path"])),
        _ => (
            ToolAction::Other,
            text(&["description", "url", "query", "file_path", "path"]),
        ),
    }
}

fn denial_of(value: &Value) -> Option<(String, Denial)> {
    let tool = str_of(value, &["tool_name", "toolName", "tool"])?.to_owned();
    let id = str_of(value, &["tool_use_id", "toolUseId", "id"])
        .unwrap_or_default()
        .to_owned();
    let input = ["tool_input", "toolInput", "input"]
        .iter()
        .find_map(|k| value.get(*k))
        .cloned()
        .unwrap_or(Value::Null);
    let (action, target) = describe_tool(&tool, &input);
    let allow = if SHELL_TOOLS.contains(&tool.as_str()) {
        suggest_allow(&target)
    } else {
        Vec::new()
    };
    Some((
        id,
        Denial {
            tool,
            action,
            target,
            allow,
        },
    ))
}

fn usage_of(result: &Value) -> Usage {
    let u = &result["usage"];
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    let mut models: Vec<String> = result["modelUsage"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    models.sort();
    Usage {
        input_tokens: n(&u["input_tokens"]),
        output_tokens: n(&u["output_tokens"]),
        cache_read_tokens: n(&u["cache_read_input_tokens"]),
        cache_creation_tokens: n(&u["cache_creation_input_tokens"]),
        cost_usd: result["total_cost_usd"].as_f64().unwrap_or(0.0),
        duration_ms: n(&result["duration_ms"]),
        turns: n(&result["num_turns"]),
        models,
    }
}

impl WorkStream {
    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    fn text(&mut self, text: &str) -> Vec<Item> {
        if text.is_empty() {
            return Vec::new();
        }
        let mut out = String::new();
        if self.after_tool && self.wrote {
            out.push_str("\n\n");
        }
        self.after_tool = false;
        self.wrote = true;
        out.push_str(text);
        vec![Item::Text(out)]
    }

    pub fn line(&mut self, line: &str) -> Vec<Item> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        if let Some(id) = value["session_id"].as_str() {
            self.session_id = Some(id.to_owned());
        }
        match value["type"].as_str() {
            Some("system") => match value["subtype"].as_str() {
                Some("init") => vec![Item::Started {
                    session_id: value["session_id"].as_str().map(str::to_owned),
                    model: value["model"].as_str().map(str::to_owned),
                }],
                Some("api_retry") => {
                    let attempt = value["attempt"].as_u64().unwrap_or(0);
                    let max = value["max_retries"].as_u64().unwrap_or(0);
                    vec![Item::Status(format!(
                        "Reintentando la conexión (intento {attempt} de {max})…"
                    ))]
                }
                Some("permission_denied") => match denial_of(&value) {
                    Some((id, denial)) if id.is_empty() || self.denied.insert(id.clone()) => {
                        vec![Item::Denied(denial)]
                    }
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            },
            Some("stream_event") => {
                let event = &value["event"];
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str()
                {
                    self.streamed = true;
                    return self.text(text);
                }
                Vec::new()
            }
            Some("assistant") => {
                if let Some(kind) = value["error"].as_str() {
                    self.error_kind = Some(kind.to_owned());
                    return Vec::new();
                }
                let mut out = Vec::new();
                for block in value["message"]["content"].as_array().into_iter().flatten() {
                    match block["type"].as_str() {
                        Some("text") if !self.streamed => {
                            if let Some(text) = block["text"].as_str() {
                                out.extend(self.text(text));
                            }
                        }
                        Some("tool_use") => {
                            let id = block["id"].as_str().unwrap_or_default().to_owned();
                            if !self.tools.insert(id.clone()) {
                                continue;
                            }
                            let tool = block["name"].as_str().unwrap_or("?").to_owned();
                            let (action, target) = describe_tool(&tool, &block["input"]);
                            self.after_tool = true;
                            out.push(Item::Tool {
                                id,
                                tool,
                                action,
                                target,
                            });
                        }
                        _ => {}
                    }
                }
                out
            }
            Some("user") => value["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|b| b["type"] == "tool_result")
                .filter_map(|b| {
                    let id = b["tool_use_id"].as_str()?.to_owned();
                    let ok = !b["is_error"].as_bool().unwrap_or(false);
                    Some(Item::ToolDone { id, ok })
                })
                .collect(),
            Some("result") => {
                self.finished = true;
                let usage = usage_of(&value);
                let mut denials = Vec::new();
                let mut seen = HashSet::new();
                for d in value["permission_denials"].as_array().into_iter().flatten() {
                    if let Some((id, denial)) = denial_of(d)
                        && (id.is_empty() || seen.insert(id))
                        && !denials.contains(&denial)
                    {
                        denials.push(denial);
                    }
                }
                let text = value["result"].as_str().unwrap_or_default().to_owned();
                let result = if value["is_error"].as_bool().unwrap_or(false)
                    || self.error_kind.is_some()
                {
                    let reason = if text.is_empty() {
                        value["subtype"].as_str().unwrap_or_default().to_owned()
                    } else {
                        text
                    };
                    Err(classify_cli(self.error_kind.as_deref(), &reason))
                } else if value["subtype"] == "error_max_turns" {
                    Err(Failure::new(
                        ErrorCode::Limit,
                        "El agente llegó al máximo de turnos (orchestrator.maxTurns) sin terminar.",
                    ))
                } else {
                    Ok(text)
                };
                vec![Item::Finished(Box::new(Finish {
                    result,
                    session_id: value["session_id"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| self.session_id.clone()),
                    usage,
                    denials,
                }))]
            }
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"C:\\p","session_id":"e74e84db-17a4-485c-a177-6f6fe9203dec","tools":["Bash","Edit","Glob","Grep","Read","Write"],"model":"claude-sonnet-5-5","permissionMode":"dontAsk"}"#;

    fn run(lines: &[&str]) -> Vec<Item> {
        let mut s = WorkStream::default();
        lines.iter().flat_map(|l| s.line(l)).collect()
    }

    #[test]
    fn a_task_reports_what_the_worker_reads_edits_and_runs() {
        let items = run(&[
            INIT,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Miro el archivo."}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Miro el archivo."},{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"C:\\p\\src\\a.ts"}}]},"session_id":"e74e84db-17a4-485c-a177-6f6fe9203dec"}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"1→x"}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"C:\\p\\src\\a.ts","old_string":"x","new_string":"y"}},{"type":"tool_use","id":"toolu_3","name":"Bash","input":{"command":"npm run build","description":"Build"}}]}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_3","name":"Bash","input":{"command":"npm run build"}}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"ok"},{"type":"tool_result","tool_use_id":"toolu_3","content":"fail","is_error":true}]}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Listo."}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":5300,"num_turns":4,"result":"Listo.","session_id":"e74e84db-17a4-485c-a177-6f6fe9203dec","total_cost_usd":0.0123,"usage":{"input_tokens":120,"cache_creation_input_tokens":2000,"cache_read_input_tokens":8000,"output_tokens":340},"modelUsage":{"claude-sonnet-5-5":{"inputTokens":120},"claude-haiku-5-5":{"inputTokens":3}},"permission_denials":[]}"#,
        ]);
        assert_eq!(
            items[0],
            Item::Started {
                session_id: Some("e74e84db-17a4-485c-a177-6f6fe9203dec".into()),
                model: Some("claude-sonnet-5-5".into())
            }
        );
        assert_eq!(items[1], Item::Text("Miro el archivo.".into()));
        assert_eq!(
            items[2],
            Item::Tool {
                id: "toolu_1".into(),
                tool: "Read".into(),
                action: ToolAction::Read,
                target: r"C:\p\src\a.ts".into()
            }
        );
        assert_eq!(
            items[3],
            Item::ToolDone {
                id: "toolu_1".into(),
                ok: true
            }
        );
        assert!(matches!(
            &items[4],
            Item::Tool {
                action: ToolAction::Edit,
                ..
            }
        ));
        assert!(
            matches!(&items[5], Item::Tool { action: ToolAction::Command, target, .. } if target == "npm run build")
        );
        // The repeated message does not repeat the call.
        assert_eq!(
            items[6],
            Item::ToolDone {
                id: "toolu_2".into(),
                ok: true
            }
        );
        assert_eq!(
            items[7],
            Item::ToolDone {
                id: "toolu_3".into(),
                ok: false
            }
        );
        assert_eq!(items[8], Item::Text("\n\nListo.".into()));
        let Item::Finished(finish) = &items[9] else {
            panic!("{:?}", items[9])
        };
        assert_eq!(finish.result, Ok("Listo.".into()));
        assert_eq!(finish.usage.input_tokens, 120);
        assert_eq!(finish.usage.output_tokens, 340);
        assert_eq!(finish.usage.cache_read_tokens, 8000);
        assert_eq!(finish.usage.cache_creation_tokens, 2000);
        assert!((finish.usage.cost_usd - 0.0123).abs() < 1e-9);
        assert_eq!(finish.usage.turns, 4);
        assert_eq!(
            finish.usage.models,
            ["claude-haiku-5-5", "claude-sonnet-5-5"]
        );
        assert_eq!(items.len(), 10);
    }

    #[test]
    fn denied_calls_are_reported_once_with_what_would_allow_them() {
        let items = run(&[
            INIT,
            r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_9","name":"Bash","input":{"command":"curl -s https://example.com && npm test"}}]}}"#,
            r#"{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_9","tool_input":{"command":"curl -s https://example.com && npm test"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_9","content":"Permission to use Bash has been denied.","is_error":true}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"No pude.","session_id":"s-1234567","total_cost_usd":0.001,"usage":{"input_tokens":1,"output_tokens":2},"permission_denials":[{"tool_name":"Bash","tool_use_id":"toolu_9","tool_input":{"command":"curl -s https://example.com && npm test"}},{"tool_name":"WebFetch","tool_use_id":"toolu_10","tool_input":{"url":"https://x.dev"}}]}"#,
        ]);
        let denied: Vec<&Denial> = items
            .iter()
            .filter_map(|i| match i {
                Item::Denied(d) => Some(d),
                _ => None,
            })
            .collect();
        assert_eq!(denied.len(), 1);
        assert_eq!(denied[0].allow, ["curl -s https://example.com", "npm test"]);
        let Some(Item::Finished(finish)) = items.last() else {
            panic!()
        };
        assert_eq!(finish.denials.len(), 2);
        assert_eq!(finish.denials[1].tool, "WebFetch");
        assert!(
            finish.denials[1].allow.is_empty(),
            "the worker has no WebFetch"
        );
        assert_eq!(finish.session_id.as_deref(), Some("s-1234567"));
    }

    #[test]
    fn errors_keep_what_was_spent() {
        let items = run(&[
            INIT,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#,
            r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login","session_id":"c609e3fd-c1a8-498c-89cb-750d4d5afb16","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"permission_denials":[]}"#,
        ]);
        let Some(Item::Finished(finish)) = items.last() else {
            panic!()
        };
        assert_eq!(finish.result.as_ref().unwrap_err().code, ErrorCode::Auth);
        let items = run(&[
            r#"{"type":"result","subtype":"error_max_turns","is_error":false,"session_id":"abcdefgh-1","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":10},"num_turns":60}"#,
        ]);
        let Some(Item::Finished(finish)) = items.last() else {
            panic!()
        };
        assert_eq!(finish.result.as_ref().unwrap_err().code, ErrorCode::Limit);
        assert!((finish.usage.cost_usd - 0.5).abs() < 1e-9);
    }

    #[test]
    fn tools_are_described_for_the_activity_list() {
        let v = |s: &str| serde_json::from_str::<Value>(s).unwrap();
        assert_eq!(
            describe_tool("Grep", &v(r#"{"pattern":"TODO","path":"src"}"#)),
            (ToolAction::Search, "TODO en src".into())
        );
        assert_eq!(
            describe_tool("Glob", &v(r#"{"pattern":"**/*.ts"}"#)),
            (ToolAction::Search, "**/*.ts".into())
        );
        assert_eq!(
            describe_tool("Write", &v(r#"{"file_path":"a.md","content":"x"}"#)),
            (ToolAction::Write, "a.md".into())
        );
        assert_eq!(
            describe_tool("TodoWrite", &v(r#"{"todos":[]}"#)),
            (ToolAction::Other, String::new())
        );
    }
}
