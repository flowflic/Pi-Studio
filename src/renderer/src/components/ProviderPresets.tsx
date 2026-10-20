import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PRESET_REGIONS,
  PROVIDER_PRESETS,
  presetsForRegion,
  type ProviderPreset,
} from "../../../shared/provider-presets";
import { useStore } from "../store";
import { Check, Close, Refresh, Trash } from "./icons";

/**
 * One-paste setup for the providers Pi already knows.
 *
 * Selecting a preset only stores an API key under the provider id in
 * `models.json`; Pi keeps its built-in endpoint and model catalog. That is why
 * the panel shows the endpoint read-only and never asks for a model id — the
 * composer gains every built-in model for that provider as soon as the key is
 * saved and the open threads refresh.
 */

/** Mirrors `ProviderCredentialStatus` from the main process without importing it. */
export type ProviderCredentialStatus = {
  provider: string;
  source: "auth" | "models" | "env" | "none";
  detail?: string;
  resolved: boolean;
  stored: boolean;
  shadowed: boolean;
};

type TestState =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; message?: string; latencyMs?: number }
  | { state: "error"; message?: string; latencyMs?: number };

const Eye = ({ off }: { off?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);

export function ProviderPresets({
  language,
  onProviderSaved,
  onModelsChanged,
}: {
  language: "en" | "zh";
  /** Merge the saved provider entry into the Settings draft (null removes it). */
  onProviderSaved: (provider: string, entry: Record<string, unknown> | null) => void;
  /** Refresh open threads so the composer lists the newly available models. */
  onModelsChanged: () => void | Promise<void>;
}) {
  const pushToast = useStore((s) => s.pushToast);
  const [statuses, setStatuses] = useState<Record<string, ProviderCredentialStatus>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "test" | "remove">(null);
  const [test, setTest] = useState<TestState>({ state: "idle" });
  const [testElapsed, setTestElapsed] = useState(0);
  /** The inline panel is opened under the clicked card; keep it in view. */
  const detailRef = useRef<HTMLDivElement | null>(null);

  const requests = useMemo(() => PROVIDER_PRESETS.map((preset) => ({ provider: preset.provider, envVar: preset.envVar })), []);

  const loadStatuses = useCallback(async () => {
    try {
      const rows = await window.pi.settings.getProviderCredentials(requests);
      setStatuses(Object.fromEntries((rows || []).map((row) => [row.provider, row])));
    } catch {
      // A missing IPC bridge only affects the status pills; the panel stays usable.
    }
  }, [requests]);

  useEffect(() => {
    void loadStatuses();
  }, [loadStatuses]);

  useEffect(() => {
    if (test.state !== "testing") return;
    const started = Date.now();
    setTestElapsed(0);
    const timer = window.setInterval(() => setTestElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [test.state]);

  useEffect(() => {
    if (!selectedId) return;
    detailRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const selected = PROVIDER_PRESETS.find((preset) => preset.id === selectedId) || null;
  const selectedStatus = selected ? statuses[selected.provider] : undefined;

  const select = (preset: ProviderPreset) => {
    if (selectedId === preset.id) {
      setSelectedId(null);
      return;
    }
    setSelectedId(preset.id);
    setKeyDraft("");
    setShowKey(false);
    setTest({ state: "idle" });
  };

  const statusLabel = (status: ProviderCredentialStatus | undefined): string => {
    if (!status || status.source === "none") return language === "zh" ? "未配置" : "Not configured";
    if (status.source === "auth") return language === "zh" ? "已有 Pi 登录凭据" : "Pi credential";
    if (status.source === "env") return language === "zh" ? "已设置环境变量" : "Environment variable";
    if (!status.resolved) return language === "zh" ? "引用未生效" : "Reference unusable";
    return language === "zh" ? "已保存密钥" : "Key saved";
  };

  const isConfigured = (status: ProviderCredentialStatus | undefined) => Boolean(status && status.source !== "none");

  const save = async () => {
    if (!selected) return;
    const key = keyDraft.trim();
    if (!key) {
      pushToast("warning", language === "zh" ? "请先粘贴 API Key" : "Paste an API key first.");
      return;
    }
    setBusy("save");
    try {
      const result = await window.pi.settings.saveProviderKey({ provider: selected.provider, apiKey: key });
      if (!result?.ok) {
        pushToast("error", (language === "zh" ? "保存失败：" : "Could not save: ") + (result?.error || ""));
        return;
      }
      setKeyDraft("");
      setShowKey(false);
      setTest({ state: "idle" });
      await loadStatuses();
      onProviderSaved(selected.provider, (result.provider as Record<string, unknown> | null) || null);
      await onModelsChanged();
      pushToast(
        "info",
        language === "zh"
          ? `${selected.label.zh} 已启用，模型选择器中可直接选用。`
          : `${selected.label.en} is ready; pick its models in the composer.`,
      );
      if (result.credentials?.shadowed) {
        pushToast(
          "warning",
          language === "zh"
            ? "auth.json 中已存在该供应商的 Pi 登录凭据，它会覆盖这里的密钥。"
            : "A Pi credential for this provider already exists in auth.json and takes precedence over this key.",
        );
      }
    } catch (error: any) {
      pushToast("error", (language === "zh" ? "保存失败：" : "Could not save: ") + (error?.message || String(error)));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!selected) return;
    const confirmed = window.confirm(
      language === "zh"
        ? `移除 ${selected.label.zh} 的 API Key？模型会自动从选择器中消失。`
        : `Remove the API key for ${selected.label.en}? Its models will disappear from the composer.`,
    );
    if (!confirmed) return;
    setBusy("remove");
    try {
      const result = await window.pi.settings.removeProviderKey(selected.provider);
      if (!result?.ok) {
        pushToast("error", (language === "zh" ? "移除失败：" : "Could not remove: ") + (result?.error || ""));
        return;
      }
      setKeyDraft("");
      setTest({ state: "idle" });
      await loadStatuses();
      onProviderSaved(selected.provider, (result.provider as Record<string, unknown> | null) || null);
      await onModelsChanged();
      pushToast("info", language === "zh" ? "API Key 已移除。" : "API key removed.");
    } catch (error: any) {
      pushToast("error", (language === "zh" ? "移除失败：" : "Could not remove: ") + (error?.message || String(error)));
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    if (!selected) return;
    setTest({ state: "testing" });
    setBusy("test");
    try {
      const result = await window.pi.settings.testProviderKey({
        provider: selected.provider,
        apiKey: keyDraft.trim() || undefined,
        modelId: selected.testModel,
      });
      setTest({ state: result?.ok ? "ok" : "error", message: result?.message, latencyMs: result?.latencyMs });
    } catch (error: any) {
      setTest({ state: "error", message: error?.message || String(error) });
    } finally {
      setBusy(null);
    }
  };

  const renderDetail = () => {
    if (!selected) return null;
    return (
        <div className="set-quick-detail" data-preset-detail={selected.id} ref={detailRef}>
          <div className="set-quick-detail-head">
            <div className="set-quick-detail-title">
              <span className="set-prov-id">{selected.provider}</span>
              <span className="set-quick-detail-name">{selected.label[language]}</span>
            </div>
            <button
              type="button"
              className="set-iconbtn"
              title={language === "zh" ? "收起" : "Collapse"}
              onClick={() => setSelectedId(null)}
            >
              <Close size={15} />
            </button>
          </div>

          <div className="set-quick-facts">
            <div className="wide">
              <span className="set-quick-fact-k">{language === "zh" ? "API 地址（Pi 内置，无需填写）" : "API URL (built into Pi)"}</span>
              <span className="set-quick-fact-v mono" title={selected.baseUrl}>
                {selected.baseUrl}
              </span>
            </div>
            <div>
              <span className="set-quick-fact-k">{language === "zh" ? "协议" : "Protocol"}</span>
              <span className="set-quick-fact-v">
                {selected.api || (language === "zh" ? "多种协议，由 Pi 按模型选择" : "Mixed, chosen per model by Pi")}
              </span>
            </div>
            <div>
              <span className="set-quick-fact-k">{language === "zh" ? "环境变量" : "Env var"}</span>
              <span className="set-quick-fact-v mono">{selected.envVar}</span>
            </div>
            <div>
              <span className="set-quick-fact-k">{language === "zh" ? "内置模型" : "Built-in models"}</span>
              <span className="set-quick-fact-v set-quick-chips">
                {selected.samples.map((model) => (
                  <code key={model}>{model}</code>
                ))}
              </span>
            </div>
          </div>

          {selectedStatus?.shadowed && (
            <div className="set-quick-warn" role="status">
              {language === "zh"
                ? "auth.json 中已有该供应商的 Pi 登录凭据，它会优先于这里的密钥。如需改用此密钥，请先在终端执行 pi 的 /logout。"
                : "A Pi credential for this provider already exists in auth.json and wins over this key. Run Pi's /logout for the provider to use this key instead."}
            </div>
          )}

          <div className="set-quick-status">
            <span className={`set-quick-dot ${isConfigured(selectedStatus) ? "on" : ""}`} aria-hidden="true" />
            <span>{statusLabel(selectedStatus)}</span>
            {selectedStatus?.detail && <span className="set-quick-detail-value mono">{selectedStatus.detail}</span>}
          </div>

          <div className="set-quick-keyrow">
            <input
              className="set-input"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              aria-label={language === "zh" ? "API Key" : "API key"}
              placeholder={
                selectedStatus?.stored
                  ? language === "zh"
                    ? "已保存密钥，留空则保持不变；粘贴新值可替换"
                    : "A key is stored. Leave blank to keep it, or paste a new one."
                  : language === "zh"
                    ? "粘贴 API Key，也支持 $ENV_VAR"
                    : "Paste an API key; $ENV_VAR is supported"
              }
              value={keyDraft}
              onChange={(event) => {
                setKeyDraft(event.target.value);
                setTest({ state: "idle" });
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setKeyDraft("");
                  setSelectedId(null);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (keyDraft.trim()) void save();
                }
              }}
            />
            <button className="set-iconbtn" title={showKey ? "隐藏" : "显示"} onClick={() => setShowKey((value) => !value)}>
              <Eye off={!showKey} />
            </button>
            <button
              type="button"
              className="set-btn primary"
              disabled={!keyDraft.trim() || busy !== null}
              onClick={save}
            >
              {busy === "save" ? <span className="spinner" /> : <Check size={14} />}
              {language === "zh" ? "保存并启用" : "Save & enable"}
            </button>
          </div>

          <div className="set-quick-actions">
            <button
              type="button"
              className="set-btn"
              disabled={busy !== null || (!keyDraft.trim() && !selectedStatus?.stored)}
              onClick={runTest}
            >
              {busy === "test" ? <span className="spinner" /> : <Refresh size={13} />}
              {language === "zh" ? "测试连接" : "Test connection"}
            </button>
            <button type="button" className="set-btn ghost danger" disabled={busy !== null || !selectedStatus?.stored} onClick={remove}>
              {busy === "remove" ? <span className="spinner" /> : <Trash size={13} />}
              {language === "zh" ? "移除密钥" : "Remove key"}
            </button>
            {selected.consoleUrl && (
              <a className="set-quick-link" href={selected.consoleUrl} target="_blank" rel="noreferrer noopener">
                {language === "zh" ? "获取 API Key ↗" : "Get an API key ↗"}
              </a>
            )}
            <div className={`set-model-testresult ${test.state}`} role="status">
              {test.state === "testing" && (
                <>
                  <span className="spinner" />{" "}
                  {language === "zh" ? `等待 ${selected.testModel} 首次输出 · ${testElapsed} 秒` : `Waiting for ${selected.testModel} · ${testElapsed}s`}
                </>
              )}
              {test.state === "ok" && (
                <>
                  <span className="set-model-testdot" />
                  {language === "zh"
                    ? `密钥可用 · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)} 秒`
                    : `Key works · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)}s`}
                </>
              )}
              {test.state === "error" && (
                <>
                  <span className="set-model-testdot" />
                  <span title={test.message}>{test.message || ""}</span>
                </>
              )}
            </div>
          </div>
        </div>
    );
  };

  return (
    <section className="set-quick" aria-label={language === "zh" ? "常用供应商快捷配置" : "Provider quick setup"}>
      <div className="set-quick-head">
        <div>
          <div className="set-quick-title">{language === "zh" ? "快捷配置供应商" : "Quick provider setup"}</div>
          <div className="set-quick-sub">
            {language === "zh"
              ? "选择供应商并粘贴 API Key 即可。API 地址与模型列表由 Pi 内置目录提供，无需手动填写；密钥写入 models.json 的同名提供商。"
              : "Pick a provider and paste an API key. Pi supplies the endpoint and model catalog, and the key is stored under that provider in models.json."}
          </div>
        </div>
      </div>

      {PRESET_REGIONS.map((region) => (
        <div className="set-quick-group" key={region.id}>
          <div className="set-quick-group-title">{region.label[language]}</div>
          <div className="set-quick-grid">
            {presetsForRegion(region.id).map((preset) => {
              const status = statuses[preset.provider];
              const configured = isConfigured(status);
              return (
                <Fragment key={preset.id}>
                <button
                  type="button"
                  data-preset={preset.id}
                  aria-pressed={selectedId === preset.id}
                  className={`set-quick-item ${selectedId === preset.id ? "active" : ""} ${configured ? "on" : ""}`}
                  onClick={() => select(preset)}
                >
                  <span className={`set-quick-dot ${configured ? "on" : ""}`} aria-hidden="true" />
                  <span className="set-quick-name">{preset.label[language]}</span>
                  <span className="set-quick-meta">{statusLabel(status)}</span>
                </button>
                {selectedId === preset.id ? renderDetail() : null}
                </Fragment>
              );
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
