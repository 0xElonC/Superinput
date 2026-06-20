# Superinput Translator

Chrome Manifest V3 extension for real-time translation in browser input fields.

It listens to text typed in supported web inputs, shows the current source text in a Chrome side panel, and translates it through an OpenAI-compatible Chat Completions endpoint.

## Current Scope

- Chrome side panel for current input and translation.
- Popup with quick actions.
- Supports `input`, `textarea`, and `contenteditable`.
- Handles IME composition: Chinese/Japanese/Korean input is captured after `compositionend`, not while the user is still typing pinyin/kana.
- New browser input replaces the previous captured text and current translation.
- Keeps the latest 4 generated translation results in the side panel.
- Configurable Agent URL, API Key, model, target language, tone, debounce delay, auto-translate, and Enter-clear behavior.
- Built-in target language presets include English, Japanese, Korean, Spanish, French, German, Indonesian, and Vietnamese.

## Install Locally

1. Open Chrome and go to:

```text
chrome://extensions
```

2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select this folder:

```text
/Users/elon/Agent/Superinput/chrome-extension
```

5. Click the Superinput extension icon.
6. Click `打开侧边栏`.

## Configure

Open the side panel and fill in:

- `Agent URL`
- `API Key`
- `Model`
- `目标语言`
- `语气`, including `客服优化`
- `停顿触发`

For the official OpenAI Chat Completions endpoint, use:

```text
https://api.openai.com/v1/chat/completions
```

For a compatible relay, use either the full chat completions path:

```text
https://your-relay.example.com/v1/chat/completions
```

Or the base `/v1` path. Superinput will normalize it to `/v1/chat/completions` before sending:

```text
https://your-relay.example.com/v1
```

## Usage

1. Open a normal webpage with a text field.
2. Open the Superinput side panel.
3. Type into a supported input field.
4. After a short pause, Superinput translates the current input.
5. Use the recent results list to copy any of the latest 4 generated results.
6. Press `Alt+Shift+C` to copy the latest generated result without focusing the side panel.
7. Change that shortcut at `chrome://extensions/shortcuts`.
8. Press `Enter` to clear the current state when `Enter 后清空` is enabled.

The extension does not replace or send your original text. It only displays a translation preview.

## Supported Input Types

Supported:

- `<input type="text">`
- `<input type="search">`
- `<input type="email">`
- `<input type="url">`
- `<input type="tel">`
- `<input type="number">`
- `<textarea>`
- `contenteditable`

Ignored:

- Password inputs
- Hidden inputs
- File inputs
- One-time-code fields
- Browser internal pages such as `chrome://...`
- Some complex editors that render text outside the DOM

## Privacy Notes

- The extension reads text from supported fields on pages where it is active.
- It ignores password, hidden, file, and one-time-code inputs.
- Settings are stored in `chrome.storage.local`.
- The API Key is currently stored locally in extension storage.
- Source text is sent to the configured Agent URL for translation.
- Use your own API key or a trusted relay endpoint.

## Troubleshooting

If nothing appears in the side panel:

- Refresh the page after installing or reloading the extension.
- Make sure the side panel is open.
- Test on a simple page with a regular `<textarea>`.
- Check that the extension is enabled in the popup.
- Chrome extensions do not run on `chrome://` pages.

If translation fails:

- Confirm `Agent URL` is the full `/v1/chat/completions` endpoint.
- Confirm the API Key is correct.
- Confirm the model exists on your endpoint.
- Check whether the endpoint supports OpenAI-compatible Chat Completions responses.

If Chinese input translates too early:

- The extension already waits for composition events.
- Some web apps custom-handle IME input; those may need site-specific adapters.

## Files

- `manifest.json`: Chrome extension manifest.
- `background.js`: state management, settings, and translation requests.
- `content.js`: webpage input detection and IME-aware capture.
- `sidepanel.html`: side panel UI.
- `sidepanel.js`: side panel state and settings logic.
- `popup.html`: quick action popup.
- `icons/`: extension icon source and exported PNG assets.

## Development

After editing files:

1. Open `chrome://extensions`.
2. Click reload on Superinput Translator.
3. Refresh the target webpage.
4. Reopen the side panel if needed.

Useful local checks:

```bash
pnpm test:extension:content
pnpm test:extension:background
```

`test:extension:content` launches a temporary Chrome page, injects `content.js`, and verifies textarea, contenteditable, and forced capture.

`test:extension:background` mocks Chrome extension APIs and verifies settings save, input update, Agent request, endpoint normalization, and translated state.

There is also a full extension e2e command:

```bash
pnpm test:extension
```

Current Google Chrome builds may block command-line loading of unpacked extensions. If that happens, run it with Chrome for Testing or Chromium by setting `CHROME_PATH`.
