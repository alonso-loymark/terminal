//! Parsers for what the providers stream back. Pure (unit tested with real captured lines).
//!
//! - `claude -p --output-format stream-json --verbose --include-partial-messages`: one JSON
//!   object per line. Text arrives as `stream_event` lines wrapping the API's
//!   `content_block_delta`; the last line is a `result` (`is_error` tells failures apart; a
//!   missing login comes as an `assistant` line with `"error": "authentication_failed"`).
//! - The Messages API with `"stream": true`: Server-Sent Events.

use serde_json::Value;

use super::{ErrorCode, Failure};

/// What one line or event means for the request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Delta(String),
    Status(String),
    /// The provider said it finished: successfully, or why not.
    Finished(Result<(), Failure>),
}

// ---------------------------------------------------------------- claude -p

#[derive(Debug, Default)]
pub struct ClaudeStream {
    /// Partial messages arrived: the complete `assistant` message repeats them.
    streamed: bool,
    /// `assistant` line with an `error` field (e.g. `authentication_failed`).
    error_kind: Option<String>,
    finished: bool,
}

impl ClaudeStream {
    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn line(&mut self, line: &str) -> Vec<Item> {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            return Vec::new();
        };
        let str_at = |v: &Value, path: &[&str]| -> Option<String> {
            let mut v = v;
            for key in path {
                v = v.get(key)?;
            }
            v.as_str().map(str::to_owned)
        };
        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                let event = &value["event"];
                if event["type"] == "content_block_delta"
                    && event["delta"]["type"] == "text_delta"
                    && let Some(text) = event["delta"]["text"].as_str()
                {
                    self.streamed = true;
                    return vec![Item::Delta(text.to_owned())];
                }
                Vec::new()
            }
            Some("assistant") => {
                let text = text_blocks(&value["message"]["content"]);
                if let Some(kind) = value.get("error").and_then(Value::as_str) {
                    self.error_kind = Some(kind.to_owned());
                    return Vec::new();
                }
                if self.streamed || text.is_empty() {
                    Vec::new()
                } else {
                    vec![Item::Delta(text)]
                }
            }
            Some("system") if value["subtype"] == "api_retry" => {
                let attempt = value["attempt"].as_u64().unwrap_or(0);
                let max = value["max_retries"].as_u64().unwrap_or(0);
                vec![Item::Status(format!(
                    "Reintentando la conexión (intento {attempt} de {max})…"
                ))]
            }
            Some("result") => {
                self.finished = true;
                let is_error = value["is_error"].as_bool().unwrap_or(false);
                if !is_error {
                    return vec![Item::Finished(Ok(()))];
                }
                let text = str_at(&value, &["result"])
                    .or_else(|| str_at(&value, &["subtype"]))
                    .unwrap_or_default();
                vec![Item::Finished(Err(classify_cli(
                    self.error_kind.as_deref(),
                    &text,
                )))]
            }
            _ => Vec::new(),
        }
    }
}

fn text_blocks(content: &Value) -> String {
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// A failed `claude -p` run, from the assistant's error kind and the result text.
pub fn classify_cli(kind: Option<&str>, text: &str) -> Failure {
    let lower = text.to_lowercase();
    let message = if text.trim().is_empty() {
        "Claude Code no pudo responder.".to_owned()
    } else {
        text.trim().to_owned()
    };
    let login = [
        "not logged in",
        "/login",
        "invalid api key",
        "oauth token",
        "please run",
    ];
    let limit = [
        "usage limit",
        "limit reached",
        "rate limit",
        "credit balance",
    ];
    let code = match kind {
        Some("authentication_failed") => ErrorCode::Auth,
        Some("rate_limit" | "billing_error") => ErrorCode::Limit,
        Some("invalid_request") => ErrorCode::Invalid,
        _ if login.iter().any(|p| lower.contains(p)) => ErrorCode::Auth,
        _ if limit.iter().any(|p| lower.contains(p)) => ErrorCode::Limit,
        _ => ErrorCode::Failed,
    };
    Failure::new(code, message)
}

/// `claude` exited without a result line: what its stderr says.
pub fn classify_cli_exit(stderr: &str, exit_code: Option<i32>) -> Failure {
    let lower = stderr.to_lowercase();
    if lower.contains("unknown option") || lower.contains("unknown argument") {
        return Failure::new(ErrorCode::Outdated, stderr.trim());
    }
    if lower.contains("not logged in") || lower.contains("/login") {
        return Failure::new(ErrorCode::Auth, stderr.trim());
    }
    let tail: String = {
        let trimmed = stderr.trim();
        let start = trimmed.char_indices().rev().nth(600).map_or(0, |(i, _)| i);
        trimmed[start..].to_owned()
    };
    let code = exit_code.map_or_else(|| "?".to_owned(), |c| c.to_string());
    Failure::new(
        ErrorCode::Failed,
        if tail.is_empty() {
            format!("claude terminó sin responder (código {code}).")
        } else {
            format!("claude terminó sin responder (código {code}): {tail}")
        },
    )
}

// ---------------------------------------------------------------- Server-Sent Events

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
}

/// Splits a byte stream into events (chunks may cut anywhere, even inside a UTF-8 sequence).
#[derive(Debug, Default)]
pub struct Sse {
    buf: Vec<u8>,
}

impl Sse {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(bytes);
        let mut out = Vec::new();
        while let Some((end, sep)) = find_blank_line(&self.buf) {
            let block = String::from_utf8_lossy(&self.buf[..end]).into_owned();
            self.buf.drain(..end + sep);
            let mut event = String::new();
            let mut data: Vec<&str> = Vec::new();
            for line in block.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim().to_owned();
                } else if let Some(v) = line.strip_prefix("data:") {
                    data.push(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if !event.is_empty() || !data.is_empty() {
                out.push(SseEvent {
                    event,
                    data: data.join("\n"),
                });
            }
        }
        out
    }
}

fn find_blank_line(buf: &[u8]) -> Option<(usize, usize)> {
    (0..buf.len()).find_map(|i| {
        if buf[i..].starts_with(b"\r\n\r\n") {
            Some((i, 4))
        } else if buf[i..].starts_with(b"\n\n") {
            Some((i, 2))
        } else {
            None
        }
    })
}

/// The Messages API stream: text deltas, refusals, errors.
#[derive(Debug, Default)]
pub struct ApiStream {
    refused: bool,
    finished: bool,
}

impl ApiStream {
    pub fn finished(&self) -> bool {
        self.finished
    }

    pub fn event(&mut self, event: &SseEvent) -> Vec<Item> {
        let Ok(data) = serde_json::from_str::<Value>(&event.data) else {
            return Vec::new();
        };
        match data["type"].as_str().unwrap_or(&event.event) {
            "content_block_delta" if data["delta"]["type"] == "text_delta" => data["delta"]["text"]
                .as_str()
                .map(|t| vec![Item::Delta(t.to_owned())])
                .unwrap_or_default(),
            "content_block_start" if data["content_block"]["type"] == "fallback" => {
                vec![Item::Status(
                    "Otro modelo continuó la respuesta.".to_owned(),
                )]
            }
            "message_delta" => {
                if data["delta"]["stop_reason"] == "refusal" {
                    self.refused = true;
                }
                Vec::new()
            }
            "message_stop" => {
                self.finished = true;
                vec![Item::Finished(if self.refused {
                    Err(Failure::new(
                        ErrorCode::Refusal,
                        "El modelo no quiso responder esta consulta.",
                    ))
                } else {
                    Ok(())
                })]
            }
            "error" => {
                self.finished = true;
                vec![Item::Finished(Err(api_error(None, &data)))]
            }
            _ => Vec::new(),
        }
    }
}

/// An API error body (`{"type":"error","error":{"type":...,"message":...}}`) and/or status.
pub fn api_error(status: Option<u16>, body: &Value) -> Failure {
    let kind = body["error"]["type"].as_str().unwrap_or("");
    let message = body["error"]["message"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| match status {
            Some(s) => format!("La API respondió {s}."),
            None => "Error de la API.".to_owned(),
        });
    let lower = message.to_lowercase();
    let code = match (kind, status) {
        _ if lower.contains("credit balance") => ErrorCode::Limit,
        ("authentication_error", _) | (_, Some(401)) => ErrorCode::ApiKey,
        ("permission_error", _) | (_, Some(403)) => ErrorCode::ApiKey,
        ("rate_limit_error", _) | (_, Some(429)) => ErrorCode::RateLimit,
        ("overloaded_error", _) | (_, Some(529)) => ErrorCode::Overloaded,
        ("billing_error", _) => ErrorCode::Limit,
        ("invalid_request_error" | "not_found_error" | "request_too_large", _)
        | (_, Some(400 | 404 | 413)) => ErrorCode::Invalid,
        _ => ErrorCode::Failed,
    };
    Failure::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from claude 2.1.329 with an empty CLAUDE_CONFIG_DIR (no login).
    const NOT_LOGGED_IN: &[&str] = &[
        r#"{"type":"system","subtype":"init","cwd":"C:\\t","tools":[],"mcp_servers":[],"model":"claude-sonnet-5-5","permissionMode":"dontAsk","slash_commands":[],"apiKeySource":"none"}"#,
        r#"{"type":"system","subtype":"status","status":"requesting"}"#,
        r#"{"type":"assistant","message":{"id":"x","model":"<synthetic>","role":"assistant","stop_reason":"stop_sequence","type":"message","content":[{"type":"text","text":"Not logged in · Please run /login"}]},"error":"authentication_failed"}"#,
        r#"{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"Not logged in · Please run /login","terminal_reason":"api_error","total_cost_usd":0}"#,
    ];

    fn feed(lines: &[&str]) -> Vec<Item> {
        let mut parser = ClaudeStream::default();
        lines.iter().flat_map(|l| parser.line(l)).collect()
    }

    #[test]
    fn a_missing_login_is_an_auth_error() {
        let items = feed(NOT_LOGGED_IN);
        assert_eq!(items.len(), 1, "{items:?}");
        let Item::Finished(Err(failure)) = &items[0] else {
            panic!("{items:?}")
        };
        assert_eq!(failure.code, ErrorCode::Auth);
        assert!(failure.message.contains("Not logged in"));
    }

    #[test]
    fn partial_messages_stream_text_and_the_full_message_is_not_repeated() {
        let items = feed(&[
            r#"{"type":"stream_event","event":{"type":"message_start","message":{}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hola "}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"mundo"}}}"#,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hola mundo"}]}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"Hola mundo"}"#,
        ]);
        assert_eq!(
            items,
            vec![
                Item::Delta("Hola ".into()),
                Item::Delta("mundo".into()),
                Item::Finished(Ok(()))
            ]
        );
    }

    #[test]
    fn without_partial_messages_the_full_message_is_the_text() {
        let items = feed(&[
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Todo"}]}}"#,
            "not json",
            r#"{"type":"result","is_error":false}"#,
        ]);
        assert_eq!(
            items,
            vec![Item::Delta("Todo".into()), Item::Finished(Ok(()))]
        );
    }

    #[test]
    fn limits_and_other_failures() {
        assert_eq!(
            classify_cli(None, "Claude AI usage limit reached|1700000000").code,
            ErrorCode::Limit
        );
        assert_eq!(classify_cli(Some("rate_limit"), "x").code, ErrorCode::Limit);
        assert_eq!(
            classify_cli(None, "OAuth token has expired. Please run /login").code,
            ErrorCode::Auth
        );
        assert_eq!(classify_cli(None, "boom").code, ErrorCode::Failed);
        assert_eq!(
            classify_cli_exit("error: unknown option '--safe-mode'", Some(1)).code,
            ErrorCode::Outdated
        );
        let generic = classify_cli_exit("", Some(3));
        assert_eq!(generic.code, ErrorCode::Failed);
        assert!(generic.message.contains("código 3"));
        let retry = feed(&[
            r#"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500}"#,
        ]);
        assert!(matches!(&retry[0], Item::Status(s) if s.contains("1 de 10")));
    }

    #[test]
    fn sse_events_survive_any_chunking() {
        let stream = "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{}}\n\nevent: content_block_delta\r\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Ñandú €\"}}\r\n\r\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        for size in [1, 2, 3, 7, 64, 4096] {
            let mut sse = Sse::default();
            let mut api = ApiStream::default();
            let mut items = Vec::new();
            for chunk in stream.as_bytes().chunks(size) {
                for event in sse.push(chunk) {
                    items.extend(api.event(&event));
                }
            }
            assert_eq!(
                items,
                vec![Item::Delta("Ñandú €".into()), Item::Finished(Ok(()))],
                "chunk {size}"
            );
            assert!(api.finished());
        }
    }

    #[test]
    fn api_refusals_and_errors() {
        let mut api = ApiStream::default();
        let ev = |data: &str| SseEvent {
            event: String::new(),
            data: data.into(),
        };
        assert!(
            api.event(&ev(
                r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#
            ))
            .is_empty()
        );
        let items = api.event(&ev(r#"{"type":"message_stop"}"#));
        assert!(matches!(&items[0], Item::Finished(Err(f)) if f.code == ErrorCode::Refusal));

        let mut api = ApiStream::default();
        let items = api.event(&ev(
            r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#,
        ));
        assert!(matches!(&items[0], Item::Finished(Err(f)) if f.code == ErrorCode::Overloaded));

        let body: Value = serde_json::from_str(
            r#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#,
        )
        .unwrap();
        assert_eq!(api_error(Some(401), &body).code, ErrorCode::ApiKey);
        assert_eq!(
            api_error(Some(429), &Value::Null).code,
            ErrorCode::RateLimit
        );
        let credit: Value = serde_json::from_str(r#"{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low"}}"#).unwrap();
        assert_eq!(api_error(Some(400), &credit).code, ErrorCode::Limit);
        let model: Value = serde_json::from_str(
            r#"{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}"#,
        )
        .unwrap();
        assert_eq!(api_error(Some(404), &model).code, ErrorCode::Invalid);
    }
}
