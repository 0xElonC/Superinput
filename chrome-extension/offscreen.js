chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "WRITE_CLIPBOARD") return false;

  writeClipboard(message.text)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function writeClipboard(text) {
  const value = String(text || "");
  if (!value) throw new Error("Clipboard text is empty");

  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch (error) {
    if (!String(error?.message || "").includes("Document is not focused")) {
      throw error;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = [
    "position: fixed",
    "top: 0",
    "left: 0",
    "width: 1px",
    "height: 1px",
    "opacity: 0",
    "pointer-events: none"
  ].join(";");

  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    if (!document.execCommand("copy")) {
      throw new Error("document.execCommand(\"copy\") returned false");
    }
  } finally {
    textarea.remove();
  }
}
