(() => {
  const SUPERINPUT_CONTENT_VERSION = "0.1.2";
  const existing = globalThis.__SUPERINPUT_TRANSLATOR_CONTENT__;
  existing?.controller?.abort?.();
  if (existing?.messageListener) {
    try {
      chrome.runtime.onMessage.removeListener(existing.messageListener);
    } catch (_) {
      // A previous extension context can be invalid after reload.
    }
  }

  const controller = new AbortController();
  let activeElement = null;
  let isComposing = false;
  let lastSentText = "";
  let captureTimer = null;

  globalThis.__SUPERINPUT_TRANSLATOR_CONTENT__ = {
    version: SUPERINPUT_CONTENT_VERSION,
    controller,
    messageListener: handleRuntimeMessage
  };

  document.addEventListener("focusin", handleFocusIn, { capture: true, signal: controller.signal });
  document.addEventListener("input", handleInput, { capture: true, signal: controller.signal });
  document.addEventListener("keyup", handleInput, { capture: true, signal: controller.signal });
  document.addEventListener("compositionstart", () => {
    isComposing = true;
  }, { capture: true, signal: controller.signal });
  document.addEventListener("compositionend", (event) => {
    isComposing = false;
    activeElement = findEditableFromEvent(event) || activeElement;
    scheduleCapture(80);
  }, { capture: true, signal: controller.signal });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      sendRuntimeMessage({ type: "INPUT_SUBMITTED" });
    }
  }, { capture: true, signal: controller.signal });

  try {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
  } catch (_) {
    // The extension may have been reloaded while this page was still open.
  }

  function handleRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === "PING") {
      sendResponse({ ok: true, version: SUPERINPUT_CONTENT_VERSION });
      return false;
    }

    if (message?.type === "CAPTURE_NOW") {
      const captured = captureActiveElement({ force: true });
      sendResponse({ ok: captured });
      return false;
    }

    return false;
  }

  function handleFocusIn(event) {
    const editable = findEditableFromEvent(event);
    if (!editable) return;
    activeElement = editable;
    scheduleCapture(120);
  }

  function handleInput(event) {
    const editable = findEditableFromEvent(event);
    if (!editable) return;
    activeElement = editable;
    if (isComposing || event.isComposing) return;
    scheduleCapture(180);
  }

  function scheduleCapture(delay) {
    clearTimeout(captureTimer);
    captureTimer = setTimeout(captureActiveElement, delay);
  }

  function captureActiveElement(options = {}) {
    const element = activeElement || findEditable(document.activeElement) || findFocusedEditable();
    if (!element || shouldIgnoreElement(element)) return false;

    const text = getEditableText(element).trim();
    if (!text || (!options.force && text === lastSentText)) return false;

    lastSentText = text;
    sendRuntimeMessage({
      type: "INPUT_UPDATED",
      text,
      inputKind: getInputKind(element),
      title: document.title,
      url: location.href
    });
    return true;
  }

  function sendRuntimeMessage(payload) {
    try {
      if (!globalThis.chrome?.runtime?.id) return;
      chrome.runtime.sendMessage(payload, () => {
        try {
          void chrome.runtime.lastError;
        } catch (_) {
          // The extension context can disappear between sendMessage and callback.
        }
      });
    } catch (_) {
      // The extension was reloaded while this page still had an old content script.
      // Refreshing the page replaces this stale script with the current one.
    }
  }

  function findEditableFromEvent(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      const editable = findEditable(node);
      if (editable) return editable;
    }

    return findEditable(event.target);
  }

  function findEditable(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node;

    if (isEditableElement(element)) return element;

    if (element.shadowRoot?.activeElement) {
      return findEditable(element.shadowRoot.activeElement);
    }

    return null;
  }

  function findFocusedEditable() {
    const direct = document.querySelector("input:focus, textarea:focus, [contenteditable='true']:focus, [contenteditable='']:focus, [role='textbox']:focus");
    if (direct) return findEditable(direct);

    const active = document.activeElement;
    if (active?.shadowRoot?.activeElement) {
      return findEditable(active.shadowRoot.activeElement);
    }

    return null;
  }

  function isEditableElement(element) {
    if (element instanceof HTMLTextAreaElement) return true;
    if (element instanceof HTMLInputElement) return isTextInput(element);
    if (element instanceof HTMLElement && element.isContentEditable) return true;
    return false;
  }

  function isTextInput(input) {
    const type = (input.getAttribute("type") || "text").toLowerCase();
    return [
      "text",
      "search",
      "email",
      "url",
      "tel",
      "number"
    ].includes(type);
  }

  function shouldIgnoreElement(element) {
    if (element instanceof HTMLInputElement) {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["password", "hidden", "file"].includes(type)) return true;
      const autocomplete = (element.getAttribute("autocomplete") || "").toLowerCase();
      if (autocomplete.includes("password") || autocomplete === "one-time-code") return true;
    }

    const ariaHidden = element.closest?.("[aria-hidden='true']");
    return Boolean(ariaHidden);
  }

  function getEditableText(element) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value || "";
    }

    if (element instanceof HTMLElement && element.isContentEditable) {
      return element.innerText || element.textContent || "";
    }

    return "";
  }

  function getInputKind(element) {
    if (element instanceof HTMLTextAreaElement) return "textarea";
    if (element instanceof HTMLInputElement) return `input:${element.type || "text"}`;
    if (element instanceof HTMLElement && element.isContentEditable) return "contenteditable";
    return "input";
  }
})();
