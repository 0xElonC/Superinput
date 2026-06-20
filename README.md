# Superinput

Superinput is a Tauri + React + Rust desktop prototype for a real-time input translation HUD.

Current scope:
- Windows/macOS desktop shell with Tauri 2
- Compact translation HUD and settings surface
- Configurable OpenAI-compatible agent URL, API key, model, target language, timeout, and debounce
- Rust-side request proxy so the frontend does not directly call the model provider
- Local test input that mirrors the intended "type, preview translation, Enter clears" workflow

Out of scope for this first pass:
- Replacing text in other apps
- Acting as a system IME
- Scraping ChatGPT web sessions, cookies, or private browser traffic

The agent endpoint is intentionally modeled as an OpenAI-compatible Chat Completions endpoint. Official OpenAI works with:

```text
https://api.openai.com/v1/chat/completions
```

Self-hosted or relay endpoints can be used when they accept the same request shape and return `choices[0].message.content`.

## Development

Install dependencies:

```bash
pnpm install
```

Run the desktop app:

```bash
pnpm tauri dev
```

Build:

```bash
pnpm tauri build
```

## Next native work

The system input-reading layer is deliberately separated from the translation provider. The next implementation step is to fill the native providers:

- macOS: Accessibility API / AXUIElement for focused text, CGEvent tap for Enter boundary events
- Windows: UI Automation for focused text, low-level keyboard hook for Enter boundary events

