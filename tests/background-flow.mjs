const storage = {};
const messageListeners = [];
const installedListeners = [];
const broadcasts = [];
const fetchCalls = [];

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
    sendMessage(message) {
      broadcasts.push(message);
      return Promise.resolve();
    }
  },
  storage: {
    local: {
      async get(keys) {
        if (Array.isArray(keys)) {
          return Object.fromEntries(keys.map((key) => [key, storage[key]]));
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

await installedListeners[0]();

await sendRuntimeMessage({
  type: "SAVE_SETTINGS",
  payload: {
    endpointUrl: "http://agent.local/v1",
    apiKey: "test-key",
    model: "fake-model",
    targetLanguage: "English",
    stylePreset: "natural",
    debounceMs: 150,
    autoTranslate: true,
    clearOnEnter: true,
    enabled: true
  }
});

const input = "你好, 这是 Superinput background 测试";
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

const state = await waitFor(async () => {
  const response = await sendRuntimeMessage({ type: "GET_STATE" });
  if (response.state.status === "translated") return response.state;
  if (response.state.status === "error") {
    throw new Error(response.state.error);
  }
  return null;
}, "translated state");

if (state.sourceText !== input) {
  throw new Error(`Unexpected source text: ${state.sourceText}`);
}
if (state.translation !== `[English] ${input}`) {
  throw new Error(`Unexpected translation: ${state.translation}`);
}
if (fetchCalls.length !== 1) {
  throw new Error(`Expected 1 Agent request, got ${fetchCalls.length}`);
}
if (fetchCalls[0].url !== "http://agent.local/v1/chat/completions") {
  throw new Error(`Endpoint normalization failed: ${fetchCalls[0].url}`);
}

console.log(JSON.stringify({
  ok: true,
  source: state.sourceText,
  translation: state.translation,
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
