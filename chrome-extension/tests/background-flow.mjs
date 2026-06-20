const storage = {};
const messageListeners = [];
const installedListeners = [];
const commandListeners = [];
const broadcasts = [];
const fetchCalls = [];
const offscreenContexts = [];
let clipboardText = "";

globalThis.chrome = {
  runtime: {
    onInstalled: {
      addListener(listener) {
        installedListeners.push(listener);
      }
    },
    onMessage: {
      addListener(listener) {
        messageListeners.push(listener);
      }
    },
    getURL(pathname) {
      return `chrome-extension://test/${pathname}`;
    },
    async getContexts() {
      return offscreenContexts.slice();
    },
    sendMessage(message) {
      if (message?.type === "WRITE_CLIPBOARD") {
        clipboardText = String(message.text || "");
        return Promise.resolve({ ok: true });
      }
      broadcasts.push(message);
      return Promise.resolve();
    }
  },
  commands: {
    onCommand: {
      addListener(listener) {
        commandListeners.push(listener);
      }
    }
  },
  offscreen: {
    Reason: {
      CLIPBOARD: "CLIPBOARD"
    },
    async createDocument(options) {
      offscreenContexts.push({
        contextType: "OFFSCREEN_DOCUMENT",
        documentUrl: chrome.runtime.getURL(options.url)
      });
    }
  },
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        }
        if (typeof keys === "string") {
          return { [keys]: storage[keys] };
        }
        return { ...storage };
      },
      async set(value) {
        Object.assign(storage, value);
      }
    }
  }
};

globalThis.fetch = async (url, options) => {
  const payload = JSON.parse(options.body);
  fetchCalls.push({ url, options, payload });
  const text = payload.messages.find((message) => message.role === "user")?.content || "";
  return new Response(JSON.stringify({
    id: "chatcmpl-test",
    model: payload.model,
    choices: [
      {
        message: {
          role: "assistant",
          content: `[English] ${text}`
        }
      }
    ]
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};

await import("../background.js");

if (installedListeners.length !== 1) {
  throw new Error(`Expected 1 installed listener, got ${installedListeners.length}`);
}
if (messageListeners.length !== 1) {
  throw new Error(`Expected 1 message listener, got ${messageListeners.length}`);
}
if (commandListeners.length !== 1) {
  throw new Error(`Expected 1 command listener, got ${commandListeners.length}`);
}

await installedListeners[0]();

await sendRuntimeMessage({
  type: "SAVE_SETTINGS",
  payload: {
    endpointUrl: "http://agent.local/v1",
    apiKey: "test-key",
    model: "fake-model",
    targetLanguage: "English",
    stylePreset: "support",
    debounceMs: 150,
    autoTranslate: true,
    clearOnEnter: true,
    enabled: true
  }
});

const inputs = Array.from(
  { length: 5 },
  (_value, index) => `你好, 这是 Superinput background 测试 ${index + 1}`
);
let state = null;

for (const input of inputs) {
  await sendRuntimeMessage({
    type: "INPUT_UPDATED",
    text: input,
    inputKind: "textarea",
    title: "Fixture",
    url: "http://fixture.local"
  }, {
    tab: {
      title: "Fixture tab",
      url: "http://fixture.local"
    }
  });

  state = await waitFor(async () => {
    const response = await sendRuntimeMessage({ type: "GET_STATE" });
    if (response.state.status === "translated" && response.state.sourceText === input) return response.state;
    if (response.state.status === "error") {
      throw new Error(response.state.error);
    }
    return null;
  }, `translated state for ${input}`);
}

const latestInput = inputs.at(-1);
const latestTranslation = `[English] ${latestInput}`;

if (state.sourceText !== latestInput) {
  throw new Error(`Unexpected source text: ${state.sourceText}`);
}
if (state.translation !== latestTranslation) {
  throw new Error(`Unexpected translation: ${state.translation}`);
}
if (fetchCalls.length !== inputs.length) {
  throw new Error(`Expected ${inputs.length} Agent requests, got ${fetchCalls.length}`);
}
if (fetchCalls[0].url !== "http://agent.local/v1/chat/completions") {
  throw new Error(`Endpoint normalization failed: ${fetchCalls[0].url}`);
}
if (!fetchCalls[0].payload.messages[0].content.includes("customer support")) {
  throw new Error("Support tone was not included in the system prompt");
}
if (!Array.isArray(state.history) || state.history.length !== 4) {
  throw new Error(`Expected 4 history entries, got ${state.history?.length}`);
}
if (state.history[0].translation !== latestTranslation) {
  throw new Error(`Latest history entry was not first: ${state.history[0]?.translation}`);
}
if (state.history[3].translation !== `[English] ${inputs[1]}`) {
  throw new Error(`History did not drop the oldest result: ${state.history[3]?.translation}`);
}

commandListeners[0]("copy_latest_translation");
await waitFor(() => clipboardText === latestTranslation ? clipboardText : null, "shortcut clipboard copy");

console.log(JSON.stringify({
  ok: true,
  source: state.sourceText,
  translation: state.translation,
  history: state.history.map((item) => item.translation),
  clipboard: clipboardText,
  endpoint: fetchCalls[0].url,
  broadcasts: broadcasts.length
}, null, 2));

function sendRuntimeMessage(message, sender = {}) {
  return new Promise((resolve, reject) => {
    try {
      messageListeners[0](message, sender, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

async function waitFor(fn, label, timeoutMs = 3000, intervalMs = 50) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ""}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
