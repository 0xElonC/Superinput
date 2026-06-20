import {
  Bot,
  Check,
  Clipboard,
  KeyRound,
  Languages,
  Link2,
  Loader2,
  Pause,
  Pin,
  Play,
  RefreshCw,
  Send,
  Settings,
  ShieldCheck
} from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, InputSource, SettingsPayload, StylePreset, TranslationResult } from "./types";
import { getSettings, readClipboardText, saveSettings, testAgent, translateText } from "./tauri";

const languageOptions = ["English", "Japanese", "Korean", "Spanish", "French", "German"];
const styleOptions: Array<{ value: StylePreset; label: string }> = [
  { value: "natural", label: "自然" },
  { value: "formal", label: "正式" },
  { value: "concise", label: "简短" },
  { value: "chat", label: "聊天" }
];

const defaultSettings: AppSettings = {
  endpointUrl: "https://api.openai.com/v1/chat/completions",
  model: "gpt-4.1-mini",
  targetLanguage: "English",
  stylePreset: "natural",
  debounceMs: 450,
  timeoutMs: 12000,
  clearOnEnter: true,
  pinned: true,
  paused: false,
  apiKeySet: false
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [translation, setTranslation] = useState("");
  const [status, setStatus] = useState("待机");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastResult, setLastResult] = useState<TranslationResult | null>(null);
  const [appName, setAppName] = useState("剪贴板监听");
  const [inputSource, setInputSource] = useState<InputSource>("clipboard");
  const [copied, setCopied] = useState(false);
  const requestIdRef = useRef(0);
  const lastClipboardRef = useRef("");

  const canTranslate = useMemo(() => {
    return sourceText.trim().length > 0 && !settings.paused;
  }, [settings.paused, sourceText]);

  useEffect(() => {
    getSettings()
      .then((loaded) => setSettings(loaded))
      .catch((error) => setStatus(`设置读取失败：${getErrorMessage(error)}`));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      readClipboardText()
        .then((text) => {
          const nextText = text.trim();
          if (!nextText || nextText === lastClipboardRef.current) return;

          lastClipboardRef.current = nextText;
          setInputSource("clipboard");
          setAppName("剪贴板监听");
          setTranslation("");
          setLastResult(null);
          setSourceText(nextText);
        })
        .catch(() => undefined);
    }, 700);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!canTranslate) {
      setIsLoading(false);
      if (!sourceText.trim()) {
        setTranslation("");
        setStatus(settings.paused ? "已暂停" : "待机");
      }
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus("等待输入停顿");
    setIsLoading(false);

    const timer = window.setTimeout(() => {
      setIsLoading(true);
      setStatus("翻译中");
      translateText({
        text: sourceText,
        sourceLanguage: "auto",
        targetLanguage: settings.targetLanguage
      })
        .then((result) => {
          if (requestIdRef.current !== requestId) return;
          setTranslation(result.translation);
          setLastResult(result);
          setStatus("已更新");
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          setTranslation("");
          setStatus(`翻译失败：${getErrorMessage(error)}`);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) {
            setIsLoading(false);
          }
        });
    }, settings.debounceMs);

    return () => window.clearTimeout(timer);
  }, [canTranslate, settings.debounceMs, settings.targetLanguage, sourceText]);

  function buildSettingsPayload(overrides: Partial<SettingsPayload> = {}): SettingsPayload {
    return {
      endpointUrl: settings.endpointUrl,
      model: settings.model,
      targetLanguage: settings.targetLanguage,
      stylePreset: settings.stylePreset,
      debounceMs: settings.debounceMs,
      timeoutMs: settings.timeoutMs,
      clearOnEnter: settings.clearOnEnter,
      pinned: settings.pinned,
      paused: settings.paused,
      apiKey: apiKeyDraft.trim().length > 0 ? apiKeyDraft.trim() : null,
      ...overrides
    };
  }

  async function handleSave(event?: FormEvent) {
    event?.preventDefault();
    setIsSaving(true);
    setStatus("保存中");

    try {
      const saved = await saveSettings(buildSettingsPayload());
      setSettings(saved);
      setApiKeyDraft("");
      setStatus(saved.apiKeySet ? "设置和 Key 已保存" : "设置已保存");
    } catch (error) {
      setStatus(`保存失败：${getErrorMessage(error)}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTestAgent() {
    setIsLoading(true);
    setStatus("测试连接");

    try {
      const usingDraftKey = apiKeyDraft.trim().length > 0;
      const result = await testAgent(buildSettingsPayload());
      setTranslation(result.translation);
      setLastResult(result);
      setStatus(usingDraftKey ? "临时 Key 连接正常" : "保存的 Key 连接正常");
    } catch (error) {
      setStatus(`连接失败：${getErrorMessage(error)}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleCopy() {
    if (!translation) return;

    await navigator.clipboard.writeText(translation);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function handleSourceKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || !settings.clearOnEnter) return;

    event.preventDefault();
    setInputSource("local");
    setSourceText("");
    setTranslation("");
    setLastResult(null);
    setStatus("已清空");
  }

  function updateSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => ({
      ...current,
      [key]: value
    }));
  }

  const statusTone = status.includes("失败") ? "danger" : status.includes("已") || status.includes("正常") ? "good" : "idle";

  return (
    <main className="app-shell">
      <section className="hud-panel" aria-label="实时翻译">
        <header className="hud-header">
          <div className="brand-mark">
            <Languages size={18} />
          </div>
          <div>
            <p className="eyebrow">{appName}</p>
            <h1>Superinput</h1>
          </div>
          <div className={`status-pill ${statusTone}`}>
            {isLoading ? <Loader2 size={14} className="spin" /> : <span />}
            {status}
          </div>
        </header>

        <div className="language-strip">
          <span>{inputSource === "clipboard" ? "Clipboard" : "Manual"}</span>
          <Send size={14} />
          <span>Auto</span>
          <Send size={14} />
          <span>{settings.targetLanguage}</span>
        </div>

        <div className="translation-box">
          {translation ? (
            <p>{translation}</p>
          ) : (
            <p className="muted">{settings.paused ? "监听暂停" : "复制文本后自动翻译"}</p>
          )}
        </div>

        <div className="hud-actions">
          <button type="button" className="icon-button" onClick={handleCopy} disabled={!translation} aria-label="复制译文" title="复制译文">
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => updateSetting("pinned", !settings.pinned)}
            aria-label="固定窗口"
            title="固定窗口"
          >
            <Pin size={17} fill={settings.pinned ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => updateSetting("paused", !settings.paused)}
            aria-label={settings.paused ? "继续" : "暂停"}
            title={settings.paused ? "继续" : "暂停"}
          >
            {settings.paused ? <Play size={17} /> : <Pause size={17} />}
          </button>
        </div>

        <label className="field-label" htmlFor="sourceText">当前待翻译文本</label>
        <textarea
          id="sourceText"
          value={sourceText}
          onChange={(event) => {
            setInputSource("local");
            setSourceText(event.target.value);
          }}
          onKeyDown={handleSourceKeyDown}
          placeholder="复制任意文本后会自动填入这里并翻译；也可以手动输入测试。Enter 清空，Shift+Enter 换行。"
          spellCheck={false}
        />

        {lastResult && (
          <div className="result-meta">
            <span>{lastResult.model}</span>
            <span>{lastResult.elapsedMs}ms</span>
          </div>
        )}
      </section>

      <form className="settings-panel" onSubmit={handleSave} aria-label="设置">
        <div className="section-title">
          <Settings size={18} />
          <h2>设置</h2>
        </div>

        <label className="field-label" htmlFor="endpointUrl">
          <Link2 size={15} />
          Agent URL
        </label>
        <input
          id="endpointUrl"
          value={settings.endpointUrl}
          onChange={(event) => updateSetting("endpointUrl", event.target.value)}
          placeholder="https://api.openai.com/v1/chat/completions"
          autoComplete="off"
        />

        <label className="field-label" htmlFor="apiKey">
          <KeyRound size={15} />
          API Key
        </label>
        <input
          id="apiKey"
          value={apiKeyDraft}
          onChange={(event) => setApiKeyDraft(event.target.value)}
          placeholder={settings.apiKeySet ? "已保存，留空保持不变" : "sk-..."}
          autoComplete="off"
          type="password"
        />

        <div className="two-column">
          <div>
            <label className="field-label" htmlFor="model">
              <Bot size={15} />
              Model
            </label>
            <input
              id="model"
              value={settings.model}
              onChange={(event) => updateSetting("model", event.target.value)}
              placeholder="gpt-4.1-mini"
              autoComplete="off"
            />
          </div>

          <div>
            <label className="field-label" htmlFor="targetLanguage">目标语言</label>
            <select
              id="targetLanguage"
              value={settings.targetLanguage}
              onChange={(event) => updateSetting("targetLanguage", event.target.value)}
            >
              {languageOptions.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="field-label" htmlFor="stylePreset">语气</label>
        <div className="segmented" id="stylePreset">
          {styleOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              className={settings.stylePreset === option.value ? "active" : ""}
              onClick={() => updateSetting("stylePreset", option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="two-column">
          <div>
            <label className="field-label" htmlFor="debounceMs">停顿触发</label>
            <input
              id="debounceMs"
              type="number"
              min={150}
              max={1500}
              step={50}
              value={settings.debounceMs}
              onChange={(event) => updateSetting("debounceMs", Number(event.target.value))}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="timeoutMs">超时</label>
            <input
              id="timeoutMs"
              type="number"
              min={3000}
              max={60000}
              step={1000}
              value={settings.timeoutMs}
              onChange={(event) => updateSetting("timeoutMs", Number(event.target.value))}
            />
          </div>
        </div>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={settings.clearOnEnter}
            onChange={(event) => updateSetting("clearOnEnter", event.target.checked)}
          />
          <span>Enter 后清空</span>
        </label>

        <div className="privacy-row">
          <ShieldCheck size={17} />
          <span>{settings.apiKeySet ? "Key 已保存，请求从本机发出" : "Key 未保存，实际翻译不会发送请求"}</span>
        </div>

        <div className="form-actions">
          <button type="button" className="secondary-button" onClick={handleTestAgent} disabled={isLoading || isSaving}>
            <RefreshCw size={16} className={isLoading ? "spin" : ""} />
            测试
          </button>
          <button type="submit" className="primary-button" disabled={isSaving}>
            {isSaving ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
            保存
          </button>
        </div>
      </form>
    </main>
  );
}

export default App;
