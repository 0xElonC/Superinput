const openSidePanel = document.getElementById("openSidePanel");
const toggleEnabled = document.getElementById("toggleEnabled");
const translateNow = document.getElementById("translateNow");
const status = document.getElementById("status");

let settings = null;

init();

async function init() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (response?.ok) {
    settings = response.settings;
    status.textContent = response.state?.status || "waiting";
    render();
  }
}

openSidePanel.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await ensureContentScript(tab.id);
    await chrome.sidePanel.open({ tabId: tab.id });
  } else {
    const window = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: window.id });
  }
  window.close();
});

toggleEnabled.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "TOGGLE_ENABLED" });
  if (response?.ok) {
    settings = response.settings;
    render();
  }
});

translateNow.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TRANSLATE_NOW" });
  window.close();
});

function render() {
  const enabled = settings?.enabled !== false;
  toggleEnabled.textContent = enabled ? "暂停" : "启用";
}

async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
  } catch (_) {
    // Some pages, such as chrome:// URLs, do not allow script injection.
  }
}
