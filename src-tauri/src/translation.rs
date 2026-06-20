use crate::settings::{RuntimeSettings, StylePreset};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Instant;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslatePayload {
    pub text: String,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationResult {
    pub translation: String,
    pub model: String,
    pub elapsed_ms: u128,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
    model: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: Option<Message>,
}

#[derive(Debug, Deserialize)]
struct Message {
    content: Option<Value>,
}

pub async fn translate_with_settings(
    settings: &RuntimeSettings,
    payload: TranslatePayload,
) -> Result<TranslationResult, String> {
    let text = payload.text.trim();
    if text.is_empty() {
        return Err("输入内容不能为空".to_string());
    }

    let target_language = payload
        .target_language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(&settings.target_language);
    let source_language = payload
        .source_language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("auto");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(settings.timeout_ms))
        .build()
        .map_err(|error| error.to_string())?;

    let system_prompt = build_system_prompt(target_language, source_language, settings.style_preset);
    let request_body = json!({
        "model": settings.model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": system_prompt
            },
            {
                "role": "user",
                "content": text
            }
        ]
    });

    let started = Instant::now();
    let mut request = client
        .post(settings.endpoint_url.trim())
        .header("Content-Type", "application/json")
        .json(&request_body);

    if let Some(api_key) = settings.api_key.as_deref().filter(|key| !key.trim().is_empty()) {
        request = request.bearer_auth(api_key);
    }

    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.map_err(|error| error.to_string())?;

    if !status.is_success() {
        return Err(format!(
            "Agent 请求失败 {}：{}",
            status.as_u16(),
            compact_error_body(&body)
        ));
    }

    let parsed: ChatCompletionResponse = serde_json::from_str(&body)
        .map_err(|error| format!("Agent 响应无法解析：{}；{}", error, compact_error_body(&body)))?;
    let translation = parsed
        .choices
        .first()
        .and_then(|choice| choice.message.as_ref())
        .and_then(|message| message.content.as_ref())
        .and_then(content_to_text)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "Agent 响应里没有可用译文".to_string())?;

    Ok(TranslationResult {
        translation,
        model: parsed.model.unwrap_or_else(|| settings.model.clone()),
        elapsed_ms: started.elapsed().as_millis(),
    })
}

fn build_system_prompt(target_language: &str, source_language: &str, style: StylePreset) -> String {
    let style_instruction = match style {
        StylePreset::Natural => "Use natural everyday wording.",
        StylePreset::Formal => "Use a professional and polite tone.",
        StylePreset::Concise => "Use concise wording without losing meaning.",
        StylePreset::Chat => "Use casual chat wording that still sounds fluent.",
    };

    format!(
        "You are Superinput's real-time translation engine. Translate from {source_language} to {target_language}. Preserve names, URLs, code, numbers, and intent. {style_instruction} Return only the translated text, with no explanations."
    )
}

fn content_to_text(content: &Value) -> Option<&str> {
    match content {
        Value::String(value) => Some(value.as_str()),
        Value::Array(parts) => parts.iter().find_map(|part| {
            part.get("text")
                .and_then(Value::as_str)
                .or_else(|| part.get("content").and_then(Value::as_str))
        }),
        _ => None,
    }
}

fn compact_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.len() <= 360 {
        return trimmed.to_string();
    }

    format!("{}...", &trimmed[..360])
}

