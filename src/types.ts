export type StylePreset = "natural" | "formal" | "concise" | "chat";

export interface AppSettings {
  endpointUrl: string;
  model: string;
  targetLanguage: string;
  stylePreset: StylePreset;
  debounceMs: number;
  timeoutMs: number;
  clearOnEnter: boolean;
  pinned: boolean;
  paused: boolean;
  apiKeySet: boolean;
}

export interface SettingsPayload extends Omit<AppSettings, "apiKeySet"> {
  apiKey?: string | null;
}

export interface TranslatePayload {
  text: string;
  sourceLanguage?: string | null;
  targetLanguage?: string | null;
}

export interface TranslationResult {
  translation: string;
  model: string;
  elapsedMs: number;
}

export interface InputSnapshot {
  appName: string;
  text: string;
  focused: boolean;
}

export type InputSource = "clipboard" | "local";
