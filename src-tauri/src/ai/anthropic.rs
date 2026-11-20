//! The Anthropic Messages API, streamed (SSE). Raw HTTP: Rust has no official SDK.
//! The key comes from the Credential Manager at request time and only goes in a header.

use serde_json::{Value, json};

use super::stream::{ApiStream, Item, Sse, api_error};
use super::{AiConfig, AiEvent, AiRequest, CancelToken, Effort, ErrorCode, Failure, Message};

pub const API_VERSION: &str = "2026-10-21";
/// Server-side refusal fallbacks (Claude Opus 5.5, Sonnet 5.5, Fable): on a policy decline the
/// API continues with another model inside the same call.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// Error bodies are short; anything longer is cut.
const MAX_ERROR_BODY: usize = 64 * 1024;

fn supports_fallbacks(model: &str) -> bool {
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5-5"]
        .iter()
        .any(|p| model.starts_with(p))
}

fn supports_effort(model: &str) -> bool {
    [
        "claude-fable-5",
        "claude-mythos-5",
        "claude-opus-5",
        "claude-sonnet-5",
        "claude-haiku-5",
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
    ]
    .iter()
    .any(|p| model.starts_with(p))
}

/// The request body (no sampling parameters: the current API version rejects them).
pub fn body(
    model: &str,
    system: &str,
    messages: &[Message],
    effort: Option<Effort>,
    max_tokens: u32,
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens.clamp(256, 64_000),
        "stream": true,
        "system": system,
        "messages": messages,
    });
    if let Some(effort) = effort.filter(|_| supports_effort(model)) {
        body["output_config"] = json!({ "effort": effort.as_str() });
    }
    if supports_fallbacks(model) {
        body["fallbacks"] = json!("default");
    }
    body
}

pub fn run(
    config: &AiConfig,
    request: &AiRequest,
    cancel: &CancelToken,
    emit: &dyn Fn(AiEvent),
) -> Result<(), Failure> {
    #[cfg(not(windows))]
    {
        let _ = (config, request, cancel, emit);
        Err(Failure::new(
            ErrorCode::Failed,
            "Solo disponible en Windows.",
        ))
    }
    #[cfg(windows)]
    {
        use super::http::{self, HttpError};

        let model = super::api_model(&request.model);
        if !super::valid_model(model) {
            return Err(Failure::new(
                ErrorCode::Invalid,
                format!("Modelo inválido: «{model}»."),
            ));
        }
        let Some(key) = super::credentials::read(&config.credential_target) else {
            return Err(Failure::new(
                ErrorCode::NoKey,
                "No hay una API key de Anthropic guardada.",
            ));
        };
        let body = body(
            model,
            &request.system,
            &request.messages,
            request.effort,
            request.max_tokens,
        );
        let body = serde_json::to_vec(&body)
            .map_err(|e| Failure::new(ErrorCode::Failed, format!("pedido inválido: {e}")))?;
        let mut headers = vec![
            ("content-type", "application/json"),
            ("accept", "text/event-stream"),
            ("anthropic-version", API_VERSION),
            ("x-api-key", key.as_str()),
        ];
        if supports_fallbacks(model) {
            headers.push(("anthropic-beta", FALLBACK_BETA));
        }

        let mut sse = Sse::default();
        let mut stream = ApiStream::default();
        let mut outcome: Option<Result<(), Failure>> = None;
        let mut error_body: Vec<u8> = Vec::new();
        let result = http::post(
            &config.api,
            "/v1/messages",
            &headers,
            &body,
            cancel,
            &mut |status, data| {
                if status != 200 {
                    if error_body.len() < MAX_ERROR_BODY {
                        error_body.extend_from_slice(data);
                    }
                    return;
                }
                for event in sse.push(data) {
                    for item in stream.event(&event) {
                        match item {
                            Item::Delta(text) => emit(AiEvent::Delta { text }),
                            Item::Status(message) => emit(AiEvent::Status { message }),
                            Item::Finished(result) => outcome = Some(result),
                        }
                    }
                }
            },
        );
        drop(headers);
        drop(key);
        match result {
            Err(HttpError::Cancelled) => Ok(()),
            Err(HttpError::Network(message)) => Err(Failure::new(
                ErrorCode::Network,
                format!("Sin conexión con la API de Anthropic ({message})."),
            )),
            Ok(200) => outcome.unwrap_or_else(|| {
                Err(Failure::new(
                    ErrorCode::Network,
                    "La respuesta de la API se cortó.",
                ))
            }),
            Ok(status) => {
                let parsed = serde_json::from_slice::<Value>(&error_body).unwrap_or(Value::Null);
                Err(api_error(Some(status), &parsed))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::Role;

    #[test]
    fn body_shape() {
        let messages = [Message {
            role: Role::User,
            content: "hola".into(),
        }];
        let b = body("claude-opus-5-5", "sys", &messages, Some(Effort::Low), 4000);
        assert_eq!(b["model"], "claude-opus-5-5");
        assert_eq!(b["stream"], true);
        assert_eq!(b["system"], "sys");
        assert_eq!(b["messages"][0]["role"], "user");
        assert_eq!(b["messages"][0]["content"], "hola");
        assert_eq!(b["output_config"]["effort"], "low");
        assert_eq!(b["fallbacks"], "default");
        assert!(b.get("temperature").is_none());
        let b = body("claude-haiku-4-5", "sys", &messages, Some(Effort::Low), 10);
        assert!(b.get("output_config").is_none());
        assert!(b.get("fallbacks").is_none());
        assert_eq!(b["max_tokens"], 256);
    }
}
