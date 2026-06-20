use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tauri::{AppHandle, Manager};

const KEYRING_SERVICE: &str = "com.superinput.app";
const KEYRING_ACCOUNT: &str = "openai-compatible-agent-key";
const SECRET_FILE: &str = "secret.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettings {
    pub endpoint_url: String,
    pub model: String,
    pub target_language: String,
    pub style_preset: StylePreset,
    pub debounce_ms: u64,
    pub timeout_ms: u64,
    pub clear_on_enter: bool,
    pub pinned: bool,
    pub paused: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StylePreset {
    Natural,
    Formal,
    Concise,
    Chat,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsResponse {
    pub endpoint_url: String,
    pub model: String,
    pub target_language: String,
    pub style_preset: StylePreset,
    pub debounce_ms: u64,
    pub timeout_ms: u64,
    pub clear_on_enter: bool,
    pub pinned: bool,
    pub paused: bool,
    pub api_key_set: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPayload {
    pub endpoint_url: String,
    pub model: String,
    pub target_language: String,
    pub style_preset: StylePreset,
    pub debounce_ms: u64,
    pub timeout_ms: u64,
    pub clear_on_enter: bool,
    pub pinned: bool,
    pub paused: bool,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RuntimeSettings {
    pub endpoint_url: String,
    pub model: String,
    pub target_language: String,
    pub style_preset: StylePreset,
    pub timeout_ms: u64,
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretSettings {
    api_key: String,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            endpoint_url: "https://api.openai.com/v1/chat/completions".to_string(),
            model: "gpt-4.1-mini".to_string(),
            target_language: "English".to_string(),
            style_preset: StylePreset::Natural,
            debounce_ms: 450,
            timeout_ms: 12_000,
            clear_on_enter: true,
            pinned: true,
            paused: false,
        }
    }
}

pub fn load_app_settings(app: &AppHandle) -> Result<AppSettingsResponse, String> {
    let stored = load_stored_settings(app)?;
    Ok(to_response(stored, load_api_key(app).is_some()))
}

pub fn save_app_settings(
    app: &AppHandle,
    payload: SettingsPayload,
) -> Result<AppSettingsResponse, String> {
    validate_payload(&payload)?;

    let api_key_from_payload = payload
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|api_key| !api_key.is_empty());

    match api_key_from_payload {
        Some(api_key) => {
            save_api_key(app, api_key)?;
            ensure_api_key_available(app)?;
        }
        None if load_api_key(app).is_none() => {
            return Err("请填写 API Key 后保存；当前没有已保存的可用 token".to_string());
        }
        None => {}
    }

    let stored = StoredSettings {
        endpoint_url: payload.endpoint_url.trim().to_string(),
        model: payload.model.trim().to_string(),
        target_language: payload.target_language.trim().to_string(),
        style_preset: payload.style_preset,
        debounce_ms: payload.debounce_ms,
        timeout_ms: payload.timeout_ms,
        clear_on_enter: payload.clear_on_enter,
        pinned: payload.pinned,
        paused: payload.paused,
    };

    let path = settings_path(app)?;
    let serialized = serde_json::to_string_pretty(&stored).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())?;

    Ok(to_response(stored, load_api_key(app).is_some()))
}

pub fn load_runtime_settings(app: &AppHandle) -> Result<RuntimeSettings, String> {
    let stored = load_stored_settings(app)?;
    let api_key = load_api_key(app)
        .ok_or_else(|| "API Key 未保存或无法读取，请重新填写 API Key 并点击保存".to_string())?;

    Ok(RuntimeSettings {
        endpoint_url: stored.endpoint_url,
        model: stored.model,
        target_language: stored.target_language,
        style_preset: stored.style_preset,
        timeout_ms: stored.timeout_ms,
        api_key: Some(api_key),
    })
}

pub fn runtime_settings_from_payload(
    app: &AppHandle,
    payload: SettingsPayload,
) -> Result<RuntimeSettings, String> {
    validate_payload(&payload)?;

    let api_key = match payload.api_key.as_deref().map(str::trim).filter(|key| !key.is_empty()) {
        Some(key) => Some(key.to_string()),
        None => load_api_key(app),
    };

    Ok(RuntimeSettings {
        endpoint_url: payload.endpoint_url.trim().to_string(),
        model: payload.model.trim().to_string(),
        target_language: payload.target_language.trim().to_string(),
        style_preset: payload.style_preset,
        timeout_ms: payload.timeout_ms,
        api_key,
    })
}

fn load_stored_settings(app: &AppHandle) -> Result<StoredSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(StoredSettings::default());
    }

    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join("settings.json"))
}

fn secret_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(config_dir(app)?.join(SECRET_FILE))
}

fn config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn validate_payload(payload: &SettingsPayload) -> Result<(), String> {
    let endpoint = payload.endpoint_url.trim();
    if endpoint.is_empty() {
        return Err("Agent URL 不能为空".to_string());
    }

    let parsed = url::Url::parse(endpoint).map_err(|_| "Agent URL 格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Agent URL 必须使用 http 或 https".to_string());
    }

    if payload.model.trim().is_empty() {
        return Err("Model 不能为空".to_string());
    }

    if payload.target_language.trim().is_empty() {
        return Err("目标语言不能为空".to_string());
    }

    if !(150..=1500).contains(&payload.debounce_ms) {
        return Err("停顿触发必须在 150-1500ms 之间".to_string());
    }

    if !(3_000..=60_000).contains(&payload.timeout_ms) {
        return Err("超时必须在 3000-60000ms 之间".to_string());
    }

    Ok(())
}

fn to_response(stored: StoredSettings, api_key_set: bool) -> AppSettingsResponse {
    AppSettingsResponse {
        endpoint_url: stored.endpoint_url,
        model: stored.model,
        target_language: stored.target_language,
        style_preset: stored.style_preset,
        debounce_ms: stored.debounce_ms,
        timeout_ms: stored.timeout_ms,
        clear_on_enter: stored.clear_on_enter,
        pinned: stored.pinned,
        paused: stored.paused,
        api_key_set,
    }
}

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|error| error.to_string())
}

fn load_api_key(app: &AppHandle) -> Option<String> {
    load_api_key_from_keyring()
        .or_else(|| load_api_key_from_file(app).ok().flatten())
}

fn load_api_key_from_keyring() -> Option<String> {
    keyring_entry()
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .filter(|value| !value.trim().is_empty())
}

fn save_api_key(app: &AppHandle, api_key: &str) -> Result<(), String> {
    let keyring_saved = keyring_entry()
        .and_then(|entry| {
            entry
                .set_password(api_key)
                .map_err(|error| format!("API Key 保存失败：{}", error))
        })
        .is_ok();

    if keyring_saved {
        if let Some(read_back) = load_api_key_from_keyring() {
            if read_back.trim() == api_key {
                return Ok(());
            }
        }
    }

    save_api_key_to_file(app, api_key)
}

fn ensure_api_key_available(app: &AppHandle) -> Result<(), String> {
    load_api_key(app)
        .map(|_| ())
        .ok_or_else(|| "API Key 保存后无法读取，请检查系统钥匙串或本地配置目录权限".to_string())
}

fn load_api_key_from_file(app: &AppHandle) -> Result<Option<String>, String> {
    let path = secret_path(app)?;
    if !path.exists() {
        return Ok(None);
    }

    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let secret: SecretSettings = serde_json::from_str(&contents).map_err(|error| error.to_string())?;
    Ok(Some(secret.api_key).filter(|value| !value.trim().is_empty()))
}

fn save_api_key_to_file(app: &AppHandle, api_key: &str) -> Result<(), String> {
    let path = secret_path(app)?;
    let serialized = serde_json::to_string_pretty(&SecretSettings {
        api_key: api_key.to_string(),
    })
    .map_err(|error| error.to_string())?;

    fs::write(&path, serialized).map_err(|error| format!("API Key fallback 保存失败：{}", error))?;

    #[cfg(unix)]
    {
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, permissions)
            .map_err(|error| format!("API Key 文件权限设置失败：{}", error))?;
    }

    match load_api_key_from_file(app)? {
        Some(read_back) if read_back.trim() == api_key => Ok(()),
        _ => Err("API Key fallback 保存后无法读取".to_string()),
    }
}
