import { invoke } from "@tauri-apps/api/core";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import type {
  AppSettings,
  InputSnapshot,
  SettingsPayload,
  TranslatePayload,
  TranslationResult
} from "./types";

const isTauri = "__TAURI_INTERNALS__" in window;

export async function getSettings(): Promise<AppSettings> {
  if (!isTauri) {
    return {
      endpointUrl: "https://api.openai.com/v1/chat/completions",
      model: "gpt-4.1-mini",
      targetLanguage: "English",
      stylePreset: "natural",
      debounceMs: 450,
      timeoutMs: 12000,
      clearOnEnter: true,
      pinned: true,
      paused: false,
      apiKeySet: false
    };
  }

  return invoke<AppSettings>("get_settings");
}

export async function saveSettings(payload: SettingsPayload): Promise<AppSettings> {
  if (!isTauri) {
    return {
      ...payload,
      apiKeySet: Boolean(payload.apiKey)
    };
  }

  return invoke<AppSettings>("save_settings", { payload });
}

export async function translateText(payload: TranslatePayload): Promise<TranslationResult> {
  if (!isTauri) {
    return {
      translation: `[browser preview] ${payload.text}`,
      model: "preview",
      elapsedMs: 0
    };
  }

  return invoke<TranslationResult>("translate_text", { payload });
}

export async function testAgent(payload: SettingsPayload): Promise<TranslationResult> {
  if (!isTauri) {
    return {
      translation: "Hello, this is a connection test.",
      model: payload.model,
      elapsedMs: 0
    };
  }

  return invoke<TranslationResult>("test_agent", { payload });
}

export async function getInputSnapshot(): Promise<InputSnapshot> {
  if (!isTauri) {
    return {
      appName: "Browser",
      text: "",
      focused: false
    };
  }

  return invoke<InputSnapshot>("get_input_snapshot");
}

export async function readClipboardText(): Promise<string> {
  if (!isTauri) {
    return "";
  }

  return readText();
}
