const form = document.getElementById("settingsForm");
const sourceLabel = document.getElementById("sourceLabel");
const sourceText = document.getElementById("sourceText");
const translationText = document.getElementById("translationText");
const statusText = document.getElementById("statusText");
const errorText = document.getElementById("errorText");
const inputMeta = document.getElementById("inputMeta");
const enabledToggle = document.getElementById("enabledToggle");
const translateNow = document.getElementById("translateNow");
const copyTranslation = document.getElementById("copyTranslation");
const clearState = document.getElementById("clearState");
const historyList = document.getElementById("historyList");
const openShortcutSettings = document.getElementById("openShortcutSettings");

let currentState = null;
let currentSettings = null;

init();

async function init() {
  const response = await sendMessage({ type: "GET_STATE" });
  if (response?.ok) {
    currentState = response.state;
    currentSettings = response.settings;
    hydrateSettings(currentSettings);
    render();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "STATE_UPDATED") return;
    currentState = message.state;
    render();
  });

  await armActiveTabCapture({ showFailures: true });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      armActiveTabCapture({ showFailures: false });
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = readSettingsForm();
  const response = await sendMessage({ type: "SAVE_SETTINGS", payload });
  if (response?.ok) {
    currentSettings = response.settings;
    hydrateSettings(currentSettings);
    render();
    if (currentState?.sourceText && currentSettings.autoTranslate) {
      sendMessage({ type: "TRANSLATE_NOW" });
    }
  }
});

enabledToggle.addEventListener("click", async () => {
  const response = await sendMessage({ type: "TOGGLE_ENABLED" });
  if (response?.ok) {
    currentSettings = response.settings;
    hydrateSettings(currentSettings);
    render();
  }
});

translateNow.addEventListener("click", async () => {
  await armActiveTabCapture({ showFailures: true });
  const response = await sendMessage({ type: "TRANSLATE_NOW" });
  if (response?.ok === false && response.error) {
    errorText.textContent = response.error;
    errorText.classList.add("visible");
  }
});

clearState.addEventListener("click", () => {
  sendMessage({ type: "CLEAR_STATE" });
});

openShortcutSettings.addEventListener("click", async () => {
  try {
    await chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
  } catch (error) {
    errorText.textContent = "请手动打开 chrome://extensions/shortcuts 设置快捷键";
    errorText.classList.add("visible");
  }
});

copyTranslation.addEventListener("click", async () => {
  const text = currentState?.translation || "";
  if (!text) return;
  const response = await sendMessage({ type: "COPY_TEXT", text });
  if (response?.ok === false && response.error) {
    errorText.textContent = response.error;
    errorText.classList.add("visible");
  }
});

historyList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-history-index]");
  if (!button) return;

  const index = Number(button.dataset.historyIndex);
  const item = currentState?.history?.[index];
  if (!item?.translation) return;
  const response = await sendMessage({ type: "COPY_TEXT", text: item.translation });
  if (response?.ok === false && response.error) {
    errorText.textContent = response.error;
    errorText.classList.add("visible");
  }
});

function render() {
  const state = currentState || {};
  const settings = currentSettings || {};
  const enabled = settings.enabled !== false;
  const copyNoticeActive = state.clipboardStatus === "copied"
    && Date.now() - Number(state.clipboardUpdatedAt || 0) < 2500;

  enabledToggle.textContent = enabled ? "暂停" : "启用";
  enabledToggle.classList.toggle("active", enabled);
  sourceLabel.textContent = "Chrome 输入";

  sourceText.textContent = state.sourceText || (enabled ? "等待网页输入" : "已暂停，点击启用后继续监听");
  sourceText.classList.toggle("muted", !state.sourceText);

  translationText.textContent = state.translation || (enabled ? statusPlaceholder(state.status) : "启用后显示译文");
  translationText.classList.toggle("muted", !state.translation);

  inputMeta.textContent = state.inputKind || "等待";
  statusText.textContent = copyNoticeActive ? "已复制" : (enabled ? statusLabel(state.status) : "暂停");

  const error = state.error || (state.clipboardStatus === "error" ? state.clipboardError : "");
  errorText.textContent = error || "";
  errorText.classList.toggle("visible", Boolean(error));

  copyTranslation.disabled = !state.translation;
  translateNow.disabled = !enabled || !state.sourceText || state.status === "translating";
  renderHistory(state.history || []);
}

function hydrateSettings(settings) {
  if (!settings) return;
  form.endpointUrl.value = settings.endpointUrl || "";
  form.apiKey.value = settings.apiKey || "";
  form.model.value = settings.model || "";
  form.targetLanguage.value = settings.targetLanguage || "English";
  form.stylePreset.value = settings.stylePreset || "natural";
  form.debounceMs.value = settings.debounceMs || 500;
  form.autoTranslate.checked = Boolean(settings.autoTranslate);
  form.clearOnEnter.checked = Boolean(settings.clearOnEnter);
}

function readSettingsForm() {
  return {
    endpointUrl: form.endpointUrl.value,
    apiKey: form.apiKey.value,
    model: form.model.value,
    targetLanguage: form.targetLanguage.value,
    stylePreset: form.stylePreset.value,
    debounceMs: Number(form.debounceMs.value),
    autoTranslate: form.autoTranslate.checked,
    clearOnEnter: form.clearOnEnter.checked,
    enabled: currentSettings?.enabled !== false
  };
}

function renderHistory(history) {
  historyList.replaceChildren();
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "生成后的结果会显示在这里";
    historyList.append(empty);
    return;
  }

  history.slice(0, 4).forEach((item, index) => {
    const row = document.createElement("li");
    row.className = "history-item";

    const body = document.createElement("div");
    body.className = "history-body";

    const text = document.createElement("p");
    text.className = "history-text";
    text.textContent = item.translation;

    const meta = document.createElement("p");
    meta.className = "history-meta";
    meta.textContent = historyMeta(item);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-copy";
    button.dataset.historyIndex = String(index);
    button.textContent = "复制";

    body.append(text, meta);
    row.append(body, button);
    historyList.append(row);
  });
}

function historyMeta(item) {
  const parts = [styleLabel(item.stylePreset)];
  if (item.elapsedMs) parts.push(`${item.elapsedMs}ms`);
  if (item.createdAt) parts.push(formatTime(item.createdAt));
  return parts.filter(Boolean).join(" · ");
}

function styleLabel(stylePreset) {
  return {
    natural: "自然",
    formal: "正式",
    concise: "简短",
    chat: "聊天",
    support: "客服优化"
  }[stylePreset] || "自然";
}

function formatTime(timestamp) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusLabel(status) {
  return {
    waiting: "待机",
    ready: "待翻译",
    queued: "等待停顿",
    translating: "翻译中",
    translated: "已更新",
    error: "失败"
  }[status] || "待机";
}

function statusPlaceholder(status) {
  return {
    waiting: "输入停顿后显示译文",
    ready: "点击立即翻译",
    queued: "等待输入停顿",
    translating: "翻译中",
    translated: "",
    error: ""
  }[status] || "输入停顿后显示译文";
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    errorText.textContent = error instanceof Error ? error.message : String(error);
    errorText.classList.add("visible");
    return null;
  }
}

async function armActiveTabCapture(options = {}) {
  const response = await sendMessage({ type: "CAPTURE_ACTIVE_TAB" });
  if (response?.ok === false && options.showFailures && isConnectionError(response.error)) {
    errorText.textContent = formatConnectionError(response);
    errorText.classList.add("visible");
  }
  return response;
}

function formatConnectionError(response) {
  if (response?.code === "UNSUPPORTED_PAGE") {
    const page = readablePage(response.tabUrl);
    return `当前页面不能监听：${page}。请切到普通 https/http 网页后重新输入。`;
  }

  if (response?.code === "NO_ACTIVE_TAB") {
    return "没有找到当前网页。请先打开一个普通网页，再打开侧边栏。";
  }

  return `网页监听未连接：${response?.error || "unknown error"}`;
}

function readablePage(url) {
  const text = String(url || "");
  if (!text) return "未知页面";
  if (text.startsWith("chrome://newtab")) return "Chrome 新标签页";
  if (text.startsWith("chrome://extensions")) return "Chrome 扩展管理页";
  if (text.startsWith("chrome://")) return "Chrome 内部页面";
  if (text.startsWith("chrome-extension://")) return "扩展页面";
  if (text.startsWith("devtools://")) return "DevTools 页面";
  if (text.startsWith("file://")) return "本地文件页面";
  return text;
}

function isConnectionError(error) {
  const text = String(error || "");
  return text.includes("injection failed")
    || text.includes("did not respond")
    || text.includes("does not allow")
    || text.includes("No active tab");
}
