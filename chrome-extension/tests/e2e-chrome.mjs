import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INPUT_TEXT = "你好, 这是 Superinput 自动化测试";
const EXPECTED_TRANSLATION = `[English] ${INPUT_TEXT}`;

let chromeProcess = null;
let server = null;
let userDataDir = null;
const clients = [];

async function main() {
try {
  const app = await startFixtureServer();
  server = app.server;

  const debugPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(os.tmpdir(), "superinput-chrome-"));
  chromeProcess = launchChrome({
    debugPort,
    startUrl: `${app.origin}/input.html`,
    userDataDir
  });

  const pageTarget = await waitFor(
    async () => (await getTargets(debugPort)).find((target) => target.type === "page" && target.url.endsWith("/input.html")),
    "test page target"
  );
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send("Runtime.enable");
  await waitFor(
    () => page.evaluate(`Boolean(document.querySelector("#message"))`),
    "fixture textarea"
  );
  await page.evaluate(`
    (() => {
      const input = document.querySelector("#message");
      input.focus();
      input.value = "wake service worker";
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: "wake service worker"
      }));
      return input.value;
    })()
  `);

  let workerTarget;
  try {
    workerTarget = await waitFor(
      async () => (await getTargets(debugPort)).find((target) => target.type === "service_worker" && target.url.includes("/background.js")),
      "extension service worker"
    );
  } catch (error) {
    const targets = await getTargets(debugPort).catch(() => []);
    console.error(JSON.stringify({
      targets: targets.map((target) => ({
        type: target.type,
        title: target.title,
        url: target.url
      })),
      chromeStderr: chromeProcess?.getStderr?.().slice(-5000) || ""
    }, null, 2));
    throw error;
  }

  const extensionId = workerTarget.url.match(/^chrome-extension:\/\/([^/]+)\//)?.[1];
  if (!extensionId) throw new Error(`Could not parse extension id from ${workerTarget.url}`);

  const sidepanelTarget = await openTarget(debugPort, `chrome-extension://${extensionId}/sidepanel.html`);
  const sidepanel = await connect(sidepanelTarget.webSocketDebuggerUrl);

  await sidepanel.send("Runtime.enable");

  await sidepanel.evaluate(`
    chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      payload: {
        endpointUrl: ${JSON.stringify(`${app.origin}/v1/chat/completions`)},
        apiKey: "test-key",
        model: "fake-model",
        targetLanguage: "English",
        stylePreset: "natural",
        debounceMs: 150,
        autoTranslate: true,
        clearOnEnter: true,
        enabled: true
      }
    })
  `);

  await page.send("Page.bringToFront");
  await page.evaluate(`
    (() => {
      const input = document.querySelector("#message");
      input.focus();
      input.value = ${JSON.stringify(INPUT_TEXT)};
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: ${JSON.stringify(INPUT_TEXT)}
      }));
      return {
        activeTag: document.activeElement?.tagName,
        value: input.value
      };
    })()
  `);

  const state = await waitFor(async () => {
    const snapshot = await sidepanel.evaluate(`
      (() => ({
        source: document.querySelector("#sourceText")?.textContent || "",
        translation: document.querySelector("#translationText")?.textContent || "",
        history: Array.from(document.querySelectorAll(".history-text")).map((node) => node.textContent || ""),
        status: document.querySelector("#statusText")?.textContent || "",
        error: document.querySelector("#errorText")?.textContent || "",
        apiCalls: Number(document.body.dataset.apiCalls || "0")
      }))()
    `);
    if (
      snapshot.source.includes(INPUT_TEXT)
      && snapshot.translation.includes(EXPECTED_TRANSLATION)
      && snapshot.history.some((text) => text.includes(EXPECTED_TRANSLATION))
    ) {
      return snapshot;
    }
    if (snapshot.error) {
      throw new Error(`sidepanel error: ${snapshot.error}`);
    }
    return null;
  }, "sidepanel translated state", 10000);

  if (app.calls.length !== 1) {
    throw new Error(`Expected exactly 1 fake Agent call, got ${app.calls.length}`);
  }

  console.log(JSON.stringify({
    ok: true,
    extensionId,
    source: state.source,
    translation: state.translation,
    history: state.history,
    status: state.status,
    agentCalls: app.calls.length
  }, null, 2));
} finally {
  for (const client of clients) client.close();
  if (chromeProcess) {
    chromeProcess.kill("SIGTERM");
    await delay(300);
  }
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
}
}

function launchChrome({ debugPort, startUrl, userDataDir }) {
  const args = [
    "--disable-gpu",
    "--enable-logging=stderr",
    "--enable-unsafe-extension-debugging",
    "--disable-component-extensions-with-background-pages",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    startUrl
  ];
  if (process.env.SUPERINPUT_HEADED !== "1") {
    args.unshift("--headless=new");
  }

  const child = spawn(CHROME_PATH, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.getStderr = () => stderr;
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.error(stderr.trim());
    }
  });
  return child;
}

async function startFixtureServer() {
  const calls = [];
  const localServer = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/input.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html>
<html>
  <head><title>Superinput E2E Fixture</title></head>
  <body>
    <label for="message">Message</label>
    <textarea id="message" rows="5" cols="60"></textarea>
  </body>
</html>`);
      return;
    }

    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const body = await readBody(request);
      const payload = JSON.parse(body);
      calls.push(payload);
      const userText = payload.messages?.find((message) => message.role === "user")?.content || "";
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: payload.model || "fake-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: `[English] ${userText}`
            },
            finish_reason: "stop"
          }
        ]
      }));
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
  });

  await new Promise((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const { port } = localServer.address();
  return {
    server: localServer,
    origin: `http://127.0.0.1:${port}`,
    calls
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function getTargets(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
  if (!response.ok) throw new Error(`CDP target list failed: ${response.status}`);
  return response.json();
}

async function openTarget(debugPort, url) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT"
  });
  if (!response.ok) throw new Error(`CDP open target failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function connect(webSocketUrl) {
  const client = new CdpClient(webSocketUrl);
  clients.push(client);
  await client.ready;
  return client;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(webSocketUrl);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  handleMessage(data) {
    const message = JSON.parse(data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${message.error.message}: ${message.error.data || ""}`));
    } else {
      pending.resolve(message.result);
    }
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(fn, label, timeoutMs = 8000, intervalMs = 150) {
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const localServer = net.createServer();
    localServer.listen(0, "127.0.0.1", () => {
      const { port } = localServer.address();
      localServer.close(() => resolve(port));
    });
    localServer.on("error", reject);
  });
}

await main();
