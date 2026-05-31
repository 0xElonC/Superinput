import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

const CHROME_PATH = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TEXTAREA_TEXT = "你好, 这是 textarea 捕获测试";
const EDITABLE_TEXT = "这是 contenteditable 捕获测试";

let chromeProcess = null;
let userDataDir = null;
const clients = [];

async function main() {
try {
  const debugPort = await getFreePort();
  userDataDir = await mkdtemp(path.join(os.tmpdir(), "superinput-content-"));
  chromeProcess = launchChrome({ debugPort, userDataDir });

  await waitFor(() => getTargets(debugPort), "Chrome DevTools");
  const target = await openTarget(debugPort, fixtureUrl());
  const page = await connect(target.webSocketDebuggerUrl);
  await page.send("Runtime.enable");

  await page.evaluate(`
    (() => {
      window.__superinputMessages = [];
      window.__superinputLastError = null;
      window.chrome = {
        runtime: {
          id: "content-test",
          lastError: null,
          sendMessage(message, callback) {
            window.__superinputMessages.push(message);
            callback?.();
          },
          onMessage: {
            addListener(listener) {
              window.__superinputMessageListener = listener;
            },
            removeListener() {}
          }
        }
      };
    })()
  `);

  const contentSource = await readFile(new URL("../content.js", import.meta.url), "utf8");
  await page.evaluate(`(() => { ${contentSource}\n })()`);
  await page.evaluate(`(() => { ${contentSource}\n })()`);

  await page.evaluate(`
    (() => {
      const input = document.querySelector("#message");
      input.focus();
      input.value = ${JSON.stringify(TEXTAREA_TEXT)};
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: ${JSON.stringify(TEXTAREA_TEXT)}
      }));
    })()
  `);

  const textareaMessage = await waitForMessage(page, TEXTAREA_TEXT, "textarea input");

  await page.evaluate(`
    (() => {
      const editable = document.querySelector("#editable");
      editable.focus();
      editable.textContent = ${JSON.stringify(EDITABLE_TEXT)};
      editable.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: ${JSON.stringify(EDITABLE_TEXT)}
      }));
    })()
  `);

  const editableMessage = await waitForMessage(page, EDITABLE_TEXT, "contenteditable input");

  await page.evaluate(`
    (() => {
      const input = document.querySelector("#message");
      input.focus();
      input.value = "CAPTURE_NOW 测试";
      window.__superinputMessageListener?.({ type: "CAPTURE_NOW" }, {}, () => {});
    })()
  `);

  const forcedMessage = await waitForMessage(page, "CAPTURE_NOW 测试", "CAPTURE_NOW");

  console.log(JSON.stringify({
    ok: true,
    textarea: textareaMessage.inputKind,
    contenteditable: editableMessage.inputKind,
    forcedCapture: forcedMessage.text
  }, null, 2));
} finally {
  for (const client of clients) client.close();
  if (chromeProcess) {
    chromeProcess.kill("SIGTERM");
    await delay(300);
  }
  if (userDataDir) {
    await rm(userDataDir, { recursive: true, force: true });
  }
}
}

function fixtureUrl() {
  const html = `<!doctype html>
<html>
  <head><title>Superinput Content Fixture</title></head>
  <body>
    <textarea id="message"></textarea>
    <div id="editable" contenteditable="true"></div>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function launchChrome({ debugPort, userDataDir }) {
  return spawn(CHROME_PATH, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "ignore"] });
}

async function waitForMessage(page, text, label) {
  return waitFor(async () => {
    const messages = await page.evaluate(`
      window.__superinputMessages.filter((message) => message.type === "INPUT_UPDATED")
    `);
    return messages.find((message) => message.text === text) || null;
  }, label);
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
