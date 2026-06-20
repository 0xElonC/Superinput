mod input;
mod settings;
mod translation;

use input::InputSnapshot;
use settings::{save_app_settings, AppSettingsResponse, SettingsPayload};
use translation::{translate_with_settings, TranslatePayload, TranslationResult};

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> Result<AppSettingsResponse, String> {
    settings::load_app_settings(&app)
}

#[tauri::command]
fn save_settings(
    app: tauri::AppHandle,
    payload: SettingsPayload,
) -> Result<AppSettingsResponse, String> {
    save_app_settings(&app, payload)
}

#[tauri::command]
async fn translate_text(
    app: tauri::AppHandle,
    payload: TranslatePayload,
) -> Result<TranslationResult, String> {
    let settings = settings::load_runtime_settings(&app)?;
    translate_with_settings(&settings, payload).await
}

#[tauri::command]
async fn test_agent(
    app: tauri::AppHandle,
    payload: SettingsPayload,
) -> Result<TranslationResult, String> {
    let settings = settings::runtime_settings_from_payload(&app, payload)?;
    translate_with_settings(
        &settings,
        TranslatePayload {
            text: "你好，这是一次连接测试。".to_string(),
            source_language: Some("auto".to_string()),
            target_language: Some(settings.target_language.clone()),
        },
    )
    .await
}

#[tauri::command]
fn get_input_snapshot() -> InputSnapshot {
    input::current_snapshot()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            translate_text,
            test_agent,
            get_input_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Superinput");
}
