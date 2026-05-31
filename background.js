const DEFAULT_SETTINGS = {
  endpointUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-4.1-mini",
  targetLanguage: "English",
  stylePreset: "natural",
  debounceMs: 500,
  autoTranslate: true,
  clearOnEnter: true,
  enabled: true
};

let appState = {
  sourceText: "",
  translation: "",
  status: "waiting",
  error: "",
  sourceTitle: "",
  sourceUrl: "",
  inputKind: "",
  model: "",
  elapsedMs: 0,
  updatedAt: 0,
  revision: 0
};

let debounceTimer = null;
let activeRequestId = 0;

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  await chrome.storage.local.set({ ...DEFAULT_SETTINGS, ...compactSettings(existing) });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "INPUT_UPDATED":
      return handleInputUpdated(message, sender);
    case "INPUT_SUBMITTED":
      return handleInputSubmitted();
    case "GET_STATE":
      return { ok: true, state: appState, settings: await getSettings() };
    case "SAVE_SETTINGS":
      return saveSettings(message.payload);
    case "TRANSLATE_NOW":
      return translateCurrentInput({ immediate: true });
    case "CLEAR_STATE":
      return clearState();
    case "TOGGLE_ENABLED":
      return toggleEnabled();
    case "CAPTURE_ACTIVE_TAB":
      return captureActiveTab();
    default:
      return { ok: false, error: "Unknown message" };
  }
}

async function handleInputUpdated(message, sender) {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true, ignored: true };

  const text = String(message.text || "").trim();
  if (!text) return { ok: true, ignored: true };
  if (text === appState.sourceText && appState.status !== "error") return { ok: true, unchanged: true };

  activeRequestId += 1;
  appState = {
    ...appState,
    sourceText: text,
    translation: "",
    status: settings.autoTranslate ? "queued" : "ready",
    error: "",
    sourceTitle: message.title || sender.tab?.title || "",
    sourceUrl: message.url || sender.tab?.url || "",
    inputKind: message.inputKind || "input",
    model: "",
    elapsedMs: 0,
    updatedAt: Date.now(),
    revision: appState.revision + 1
  };
  broadcastState();

  if (settings.autoTranslate) {
    scheduleTranslation(settings.debounceMs);
  }

  return { ok: true };
}

async function handleInputSubmitted() {
  const settings = await getSettings();
  if (!settings.clearOnEnter) return { ok: true };

  return clearState();
}

function scheduleTranslation(debounceMs) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    translateCurrentInput({ immediate: true }).catch((error) => {
      setError(getErrorMessage(error));
    });
  }, clampNumber(debounceMs, 150, 1500));
}

async function translateCurrentInput() {
  const settings = await getSettings();
  const text = appState.sourceText.trim();
  if (!text) return { ok: false, error: "No input text" };
  if (!settings.enabled) return { ok: true, ignored: true };
  const endpointUrl = normalizeEndpointUrl(settings.endpointUrl);
  if (!endpointUrl) return setError("Agent URL is empty");
  if (!settings.model.trim()) return setError("Model is empty");
  if (!settings.apiKey.trim()) return setError("API Key is empty");

  const requestId = activeRequestId + 1;
  activeRequestId = requestId;
  appState = { ...appState, status: "translating", error: "", revision: appState.revision + 1 };
  broadcastState();

  const started = performance.now();
  let response;
  try {
    response = await fetch(endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey.trim()}`
      },
      body: JSON.stringify({
        model: settings.model.trim(),
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: buildSystemPrompt(settings)
          },
          {
            role: "user",
            content: text
          }
        ]
      })
    });
  } catch (error) {
    return setError(`Agent request failed: ${getErrorMessage(error)}`);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    return setError(`Agent request failed ${response.status}: ${compactText(bodyText, 360)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (_) {
    return setError(`Agent response was not valid JSON: ${compactText(bodyText, 240)}`);
  }
  const translation = extractChatContent(parsed).trim();
  if (!translation) return setError("Agent response did not include translated text");
  if (requestId !== activeRequestId) return { ok: true, stale: true };

  appState = {
    ...appState,
    translation,
    status: "translated",
    error: "",
    model: parsed.model || settings.model,
    elapsedMs: Math.round(performance.now() - started),
    revision: appState.revision + 1
  };
  broadcastState();
  return { ok: true, state: appState };
}

async function saveSettings(payload) {
  const clean = normalizeSettings(payload || {});
  await chrome.storage.local.set(clean);
  broadcastState();
  return { ok: true, settings: await getSettings() };
}

async function toggleEnabled() {
  const settings = await getSettings();
  await chrome.storage.local.set({ enabled: !settings.enabled });
  broadcastState();
  return { ok: true, settings: await getSettings() };
}

async function clearState() {
  clearTimeout(debounceTimer);
  activeRequestId += 1;
  appState = {
    ...appState,
    sourceText: "",
    translation: "",
    status: "waiting",
    error: "",
    model: "",
    elapsedMs: 0,
    updatedAt: Date.now(),
    revision: appState.revision + 1
  };
  broadcastState();
  return { ok: true, state: appState };
}

async function captureActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    return {
      ok: false,
      code: "NO_ACTIVE_TAB",
      error: "No active browser tab was found"
    };
  }

  if (!/^https?:\/\//i.test(tab.url)) {
    return {
      ok: false,
      code: "UNSUPPORTED_PAGE",
      error: "This page does not allow content scripts",
      tabUrl: tab.url,
      tabTitle: tab.title || ""
    };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"]
    });
  } catch (error) {
    return { ok: false, error: `Content script injection failed: ${getErrorMessage(error)}` };
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURE_NOW" });
    return response || { ok: true };
  } catch (error) {
    return { ok: false, error: `Content script did not respond: ${getErrorMessage(error)}` };
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return { ...DEFAULT_SETTINGS, ...compactSettings(stored) };
}

function normalizeSettings(payload) {
  return {
    endpointUrl: String(payload.endpointUrl || DEFAULT_SETTINGS.endpointUrl).trim(),
    apiKey: String(payload.apiKey || ""),
    model: String(payload.model || DEFAULT_SETTINGS.model).trim(),
    targetLanguage: String(payload.targetLanguage || DEFAULT_SETTINGS.targetLanguage).trim(),
    stylePreset: ["natural", "formal", "concise", "chat"].includes(payload.stylePreset)
      ? payload.stylePreset
      : DEFAULT_SETTINGS.stylePreset,
    debounceMs: clampNumber(Number(payload.debounceMs), 150, 1500),
    autoTranslate: Boolean(payload.autoTranslate),
    clearOnEnter: Boolean(payload.clearOnEnter),
    enabled: Boolean(payload.enabled)
  };
}

function compactSettings(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, entry]) => entry !== undefined));
}

function buildSystemPrompt(settings) {
  const tone = {
    natural: "Use natural everyday wording.",
    formal: "Use a professional and polite tone.",
    concise: "Use concise wording without losing meaning.",
    chat: "Use casual chat wording that still sounds fluent."
  }[settings.stylePreset] || "Use natural everyday wording.";

  return [
    "You are Superinput's browser translation engine.",
    `Translate the user's current input to ${settings.targetLanguage}.`,
    "Preserve names, URLs, code, numbers, emoji, and intent.",
    tone,
    "Return only the translated text, with no explanations."
  ].join(" ");
}

function extractChatContent(parsed) {
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text || part?.content || "";
      })
      .join("");
  }
  return "";
}

function setError(error) {
  appState = {
    ...appState,
    status: "error",
    error,
    translation: "",
    revision: appState.revision + 1
  };
  broadcastState();
  return { ok: false, error };
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: "STATE_UPDATED", state: appState }).catch(() => undefined);
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.debounceMs;
  return Math.min(max, Math.max(min, value));
}

function compactText(value, limit) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function normalizeEndpointUrl(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path || path === "/v1") {
      url.pathname = "/v1/chat/completions";
      return url.toString();
    }
    return trimmed;
  } catch (_) {
    return trimmed;
  }
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
