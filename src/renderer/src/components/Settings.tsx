import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useStore } from "../store";
import type { ApiType, Diagnostics, ModelDef, ModelsFile, ProviderDef, ThinkingDefaults } from "../lib/types";
import { cleanOutput, hasLibuvAssertion, lastLine, stripAnsi } from "../lib/update";
import { reasoningLevelLabel } from "../lib/reasoning";
import { translateUiText } from "../lib/i18n";
import { Archive, Check, Close, Edit, Plus, Refresh, Folder } from "./icons";
import appIconUrl from "../../../../resources/icon.png";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

const API_TYPES: ApiType[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const TOKENS_PER_K = 1000;

function formatTokenLimitK(tokens?: number): string {
  const value = Number(tokens);
  if (!Number.isFinite(value)) return "";
  return String(Number((value / TOKENS_PER_K).toFixed(3)));
}

function TokenLimitInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value?: number;
  onChange: (value: number | undefined) => void;
  label: string;
  placeholder: string;
}) {
  const [draft, setDraft] = useState(() => formatTokenLimitK(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(formatTokenLimitK(value));
  }, [editing, value]);

  const commit = () => {
    setEditing(false);
    const raw = draft.trim();
    if (raw === "") {
      onChange(undefined);
      return;
    }
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric >= 0) {
      onChange(Math.round(numeric * TOKENS_PER_K));
    } else {
      setDraft(formatTokenLimitK(value));
    }
  };

  return (
    <div className="set-token-input" title={label}>
      <input
        className="set-input num"
        type="number"
        min={0}
        step={0.1}
        placeholder={placeholder}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        aria-label={label}
      />
      <span className="set-token-unit" aria-hidden="true">K</span>
    </div>
  );
}

function supportedThinkingLevels(model?: ModelDef): readonly string[] {
  // This is a desired global default, not the live model capability list.
  // Keep unmapped levels visible so models without an explicit map can still
  // choose max here; the live composer still narrows levels using Pi's
  // model-specific capability response.
  if (!model) return THINK_LEVELS;
  if (!model.reasoning) return ["off"];
  return THINK_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const Eye = ({ off }: { off?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
    {off && <path d="M3 3l18 18" />}
  </svg>
);

/* ------------------------------------------------------------------ *
 * Small building blocks
 * ------------------------------------------------------------------ */

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={`set-toggle ${checked ? "on" : ""}`} aria-checked={checked} role="switch" onClick={() => onChange(!checked)}>
      <span className="set-toggle-knob" />
    </button>
  );
}

function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`set-row ${wide ? "wide" : ""}`}>
      <label className="set-label">{label}</label>
      <div className="set-control">
        {children}
        {hint && <div className="set-hint">{hint}</div>}
      </div>
    </div>
  );
}

/**
 * JSON editor for free-form advanced fields such as compat.
 * Single source of truth = the text the user sees; a successful parse is pushed
 * up via onChange, a failed parse is flagged via register() so Save can block.
 * Parent should pass a stable `path` and key the component by it so switching
 * objects remounts and re-seeds the text from the new value.
 */
function JsonField({
  value,
  onChange,
  path,
  register,
  placeholder,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  path: string;
  register: (path: string, ok: boolean) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState(() => (value === undefined ? "" : JSON.stringify(value, null, 2)));
  const [valid, setValid] = useState(true);
  const edit = (t: string) => {
    setText(t);
    if (t.trim() === "") {
      setValid(true);
      register(path, true);
      onChange(undefined);
      return;
    }
    try {
      onChange(JSON.parse(t));
      setValid(true);
      register(path, true);
    } catch {
      setValid(false);
      register(path, false);
    }
  };
  return (
    <div className="set-json-wrap">
      <textarea
        className={`set-json ${valid ? "" : "err"}`}
        spellCheck={false}
        placeholder={placeholder || '{\n  "thinkingFormat": "qwen"\n}'}
        value={text}
        onChange={(e) => edit(e.target.value)}
      />
      {!valid && <div className="set-json-err">JSON 语法错误，保存前请修正</div>}
    </div>
  );
}

const MAP_UNSET = "__unset__";
const MAP_HIDDEN = "__hidden__";
const MAP_CUSTOM = "__custom__";

/** Configure the fixed Pi effort levels without asking users to edit JSON. */
function ThinkingLevelMapEditor({
  value,
  onChange,
  language,
}: {
  value?: Record<string, string | null>;
  onChange: (value: Record<string, string | null> | undefined) => void;
  language: "en" | "zh";
}) {
  const map = value || {};
  const isBuiltInLevel = (raw: string) => THINK_LEVELS.some((level) => level === raw);
  const choiceFor = (level: string) => {
    if (!Object.prototype.hasOwnProperty.call(map, level)) return MAP_UNSET;
    if (map[level] === null) return MAP_HIDDEN;
    return typeof map[level] === "string" && isBuiltInLevel(map[level] as string) ? map[level] : MAP_CUSTOM;
  };
  const emit = (next: Record<string, string | null>) => onChange(Object.keys(next).length ? next : undefined);
  const setChoice = (level: string, choice: string) => {
    const next = { ...map };
    if (choice === MAP_UNSET) delete next[level];
    else if (choice === MAP_HIDDEN) next[level] = null;
    else if (choice === MAP_CUSTOM) {
      const current = next[level];
      next[level] = typeof current === "string" && current.trim() ? current : level;
    } else next[level] = choice;
    emit(next);
  };
  const setCustom = (level: string, raw: string) => {
    const next = { ...map };
    if (raw.trim()) next[level] = raw.trim();
    else delete next[level];
    emit(next);
  };

  return (
    <div className="set-thinking-map">
      <div className="set-thinking-map-head">
        <span>{language === "zh" ? "Pi 档位" : "Pi level"}</span>
        <span>{language === "zh" ? "提供方设置" : "Provider setting"}</span>
      </div>
      {THINK_LEVELS.map((level) => {
        const choice = choiceFor(level);
        const raw = map[level];
        return (
          <div className="set-thinking-map-row" key={level}>
            <div className="set-thinking-map-level">
              <span>{reasoningLevelLabel(level, language)}</span>
              <code>{level}</code>
            </div>
            <div className="set-thinking-map-control">
              <select className="set-select" value={choice} onChange={(event) => setChoice(level, event.target.value)}>
                <option value={MAP_UNSET}>{language === "zh" ? "未指定（使用提供方默认）" : "Unspecified (provider default)"}</option>
                <option value={MAP_HIDDEN}>{language === "zh" ? "隐藏该档位" : "Hide this level"}</option>
                {THINK_LEVELS.map((providerLevel) => (
                  <option key={providerLevel} value={providerLevel}>
                    {reasoningLevelLabel(providerLevel, language)} ({providerLevel})
                  </option>
                ))}
                <option value={MAP_CUSTOM}>{language === "zh" ? "自定义提供方值" : "Custom provider value"}</option>
              </select>
              {choice === MAP_CUSTOM && (
                <input
                  className="set-input set-thinking-map-custom"
                  value={typeof raw === "string" ? raw : ""}
                  placeholder={language === "zh" ? "提供方档位" : "Provider level"}
                  onChange={(event) => setCustom(level, event.target.value)}
                />
              )}
            </div>
          </div>
        );
      })}
      <div className="set-hint">
        {language === "zh"
          ? "未指定不会写入该档位；隐藏会写入 null。自定义值用于供应商使用非标准档位名称的情况。"
          : "Unspecified omits the level; Hide writes null. Use a custom value for providers with non-standard level names."}
      </div>
    </div>
  );
}

/** Key/value list editor for provider `headers`. */
function KvList({ value, onChange }: { value?: Record<string, string>; onChange: (v: Record<string, string> | undefined) => void }) {
  const [rows, setRows] = useState(() => Object.entries(value || {}).map(([k, v], i) => ({ k, v, id: `r${i}` })));
  const emit = (next: typeof rows) => {
    const o: Record<string, string> = {};
    for (const r of next) if (r.k.trim()) o[r.k.trim()] = r.v;
    onChange(Object.keys(o).length ? o : undefined);
  };
  const update = (id: string, patch: Partial<{ k: string; v: string }>) => {
    const next = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    setRows(next);
    emit(next);
  };
  const add = () => {
    const next = [...rows, { k: "", v: "", id: `r${Date.now()}` }];
    setRows(next);
  };
  const remove = (id: string) => {
    const next = rows.filter((r) => r.id !== id);
    setRows(next);
    emit(next);
  };
  return (
    <div className="set-kv">
      {rows.map((r) => (
        <div className="set-kv-row" key={r.id}>
        <input className="set-input" placeholder="请求头名称" value={r.k} onChange={(e) => update(r.id, { k: e.target.value })} />
          <input className="set-input" placeholder="值（支持 $ENV / !cmd）" value={r.v} onChange={(e) => update(r.id, { v: e.target.value })} />
          <button className="set-iconbtn danger" title="删除" onClick={() => remove(r.id)}>
            ×
          </button>
        </div>
      ))}
      <button className="set-addline" onClick={add}>
        <Plus size={13} /> 添加请求头
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Model row
 * ------------------------------------------------------------------ */

function ModelRow({
  m,
  i,
  pfx,
  providerId,
  provider,
  language,
  patch,
  remove,
  register,
}: {
  m: ModelDef;
  i: number;
  pfx: string;
  providerId: string;
  provider: ProviderDef;
  language: "en" | "zh";
  patch: (p: Partial<ModelDef>) => void;
  remove: () => void;
  register: (path: string, ok: boolean) => void;
}) {
  const [adv, setAdv] = useState(false);
  const [test, setTest] = useState<{ state: "idle" | "testing" | "ok" | "error"; message?: string; latencyMs?: number }>({ state: "idle" });
  const [testElapsed, setTestElapsed] = useState(0);
  const testFingerprint = JSON.stringify({
    providerId,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: provider.apiKey,
    headers: provider.headers,
    compat: provider.compat,
    model: m,
  });
  useEffect(() => setTest({ state: "idle" }), [testFingerprint]);
  useEffect(() => {
    if (test.state !== "testing") return;
    const started = Date.now();
    setTestElapsed(0);
    const timer = window.setInterval(() => setTestElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [test.state]);

  const runAvailabilityTest = async () => {
    if (!m.id.trim()) {
      setTest({ state: "error", message: language === "zh" ? "请先填写模型 ID。" : "Enter a model ID first." });
      return;
    }
    setTest({ state: "testing" });
    try {
      const result = await window.pi.settings.testModel({ providerId, provider, modelId: m.id.trim() });
      setTest({
        state: result.ok ? "ok" : "error",
        message: result.message,
        latencyMs: result.latencyMs,
      });
    } catch (error: any) {
      setTest({ state: "error", message: error?.message || String(error) });
    }
  };
  const setInput = (t: "text" | "image", on: boolean) => {
    const cur = new Set<"text" | "image">((m.input || []) as ("text" | "image")[]);
    on ? cur.add(t) : cur.delete(t);
    const arr = [...cur];
    patch({ input: arr.length ? arr : undefined });
  };
  const has = (t: "text" | "image") => (m.input || []).includes(t);
  return (
    <div className="set-model">
      <div className="set-model-grid">
        <input
          className="set-input"
          autoFocus={i === (provider.models || []).length - 1 && !m.id}
          placeholder="模型 id（必填）"
          value={m.id || ""}
          onChange={(e) => patch({ id: e.target.value })}
        />
        <input className="set-input" placeholder="显示名称" value={m.name || ""} onChange={(e) => patch({ name: e.target.value || undefined })} />
        <label className="set-check" title="支持扩展思考">
          <Toggle checked={!!m.reasoning} onChange={(v) => patch({ reasoning: v })} />
          <span>思考</span>
        </label>
        <label className="set-check">
          <input type="checkbox" checked={has("image")} onChange={(e) => setInput("image", e.target.checked)} />
          <span>图像</span>
        </label>
        <TokenLimitInput
          value={m.contextWindow}
          onChange={(value) => patch({ contextWindow: value })}
          label={language === "zh" ? "上下文长度（K 令牌）" : "Context length (K tokens)"}
          placeholder="128"
        />
        <TokenLimitInput
          value={m.maxTokens}
          onChange={(value) => patch({ maxTokens: value })}
          label={language === "zh" ? "最大输出（K 令牌）" : "Max output (K tokens)"}
          placeholder="16"
        />
        <button className="set-iconbtn" title="高级" onClick={() => setAdv((v) => !v)}>
          ⚙
        </button>
        <button className="set-iconbtn danger" title="删除模型" onClick={remove}>
          ×
        </button>
      </div>
      <div className="set-model-testbar">
        <div className={`set-model-testresult ${test.state}`}>
          {test.state === "testing" && (
            <>
              <span className="spinner" />{" "}
              {language === "zh"
                ? `等待模型首次输出 · ${testElapsed} 秒`
                : `Waiting for the model's first output · ${testElapsed}s`}
            </>
          )}
          {test.state === "ok" && (
            <>
              <span className="set-model-testdot" />
              {language === "zh" ? `模型可用 · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)} 秒` : `Available · ${(Number(test.latencyMs || 0) / 1000).toFixed(1)}s`}
            </>
          )}
          {test.state === "error" && (
            <>
              <span className="set-model-testdot" />
              <span title={test.message}>{test.message ? translateUiText(test.message, language) : ""}</span>
            </>
          )}
        </div>
        <button type="button" className="set-model-testbtn" onClick={runAvailabilityTest} disabled={test.state === "testing"}>
          {test.state === "testing" ? (language === "zh" ? "检查中" : "Testing") : language === "zh" ? "测试可用性" : "Test availability"}
        </button>
      </div>
      {adv && (
        <div className="set-model-adv">
          <Field
            label={language === "zh" ? "API 类型覆盖" : "API type override"}
            hint={language === "zh" ? "留空则继承提供商；切换 Anthropic 时地址仍填写带 /v1 的形式。" : "Leave empty to inherit the provider; enter Anthropic URLs with /v1 too."}
          >
            <select className="set-select" value={m.api || ""} onChange={(e) => patch({ api: (e.target.value || undefined) as ApiType | undefined })}>
              <option value="">{language === "zh" ? "（继承提供商）" : "(Inherit provider)"}</option>
              {API_TYPES.map((api) => (
                <option key={api} value={api}>
                  {api}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={language === "zh" ? "基础地址" : "Base URL"}
            hint={language === "zh" ? "可选的模型级地址覆盖；界面统一填写带 /v1 的地址。" : "Optional model-level endpoint override; enter the URL with /v1."}
          >
            <input
              className="set-input"
              placeholder="https://api.example.com/v1"
              value={m.baseUrl || ""}
              onChange={(e) => patch({ baseUrl: e.target.value || undefined })}
            />
          </Field>
          <Field label="compat" hint="兼容性覆盖，如 thinkingFormat / supportsDeveloperRole 等">
            <JsonField key={`${pfx}:compat`} path={`${pfx}:compat`} value={m.compat} register={register} onChange={(v) => patch({ compat: v as Record<string, unknown> | undefined })} />
          </Field>
          <Field
            label="thinkingLevelMap"
            hint={language === "zh" ? "按 Pi 思考档位逐项选择提供方设置" : "Configure the provider setting for each Pi effort level"}
          >
            <ThinkingLevelMapEditor value={m.thinkingLevelMap} language={language} onChange={(v) => patch({ thinkingLevelMap: v })} />
          </Field>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Provider card
 * ------------------------------------------------------------------ */

function ProviderCard({
  k,
  def,
  language,
  rename,
  patch,
  del,
  register,
  addModel,
  updateModel,
  deleteModel,
}: {
  k: string;
  def: ProviderDef;
  language: "en" | "zh";
  rename: (name: string) => boolean;
  patch: (p: Partial<ProviderDef>) => void;
  del: () => void;
  register: (path: string, ok: boolean) => void;
  addModel: () => void;
  updateModel: (i: number, p: Partial<ModelDef>) => void;
  deleteModel: (i: number) => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [adv, setAdv] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [providerName, setProviderName] = useState(k);
  useEffect(() => {
    setProviderName(k);
    setRenaming(false);
  }, [k]);
  const submitRename = () => {
    if (rename(providerName)) setRenaming(false);
  };
  const models = def.models || [];
  return (
    <div className="set-card">
      <div className="set-card-head">
        {renaming ? (
          <form
            className="set-prov-rename"
            onSubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <input
              className="set-input"
              autoFocus
              value={providerName}
              onChange={(event) => setProviderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setProviderName(k);
                  setRenaming(false);
                }
              }}
            />
            <button type="submit" className="set-iconbtn" title={language === "zh" ? "确认修改" : "Save name"}>
              <Check size={14} />
            </button>
            <button
              type="button"
              className="set-iconbtn"
              title={language === "zh" ? "取消" : "Cancel"}
              onClick={() => {
                setProviderName(k);
                setRenaming(false);
              }}
            >
              <Close size={14} />
            </button>
          </form>
        ) : (
          <>
            <span className="set-prov-id" title={k}>
              {k}
            </span>
            <button
              type="button"
              className="set-iconbtn set-prov-name-edit"
              title={language === "zh" ? "修改供应商名称" : "Rename provider"}
              onClick={() => setRenaming(true)}
            >
              <Edit size={13} />
            </button>
          </>
        )}
        <span className="set-prov-count">{models.length} 模型</span>
        <button className="set-iconbtn danger" title="删除提供商" onClick={del}>
          ×
        </button>
      </div>

      <Field
        label={language === "zh" ? "基础地址" : "Base URL"}
        hint={
          language === "zh"
            ? "界面统一填写带 /v1 的地址；Anthropic 写入 Pi 时会自动去掉末尾 /v1。"
            : "Enter URLs with /v1; Pi removes the trailing /v1 internally for Anthropic."
        }
      >
        <input className="set-input" placeholder="https://api.example.com/v1" value={def.baseUrl || ""} onChange={(e) => patch({ baseUrl: e.target.value || undefined })} />
      </Field>

      <Field label="API 类型">
        <select className="set-select" value={def.api || ""} onChange={(e) => patch({ api: (e.target.value || undefined) as ApiType | undefined })}>
          <option value="">{language === "zh" ? "（继承 / 未设）" : "(Inherit / not set)"}</option>
          {API_TYPES.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>

      <Field label={language === "zh" ? "API 密钥" : "API Key"} hint="支持明文、环境变量 $MY_KEY、或 shell 命令 !cmd">
        <div className="set-keywrap">
          <input className="set-input" type={showKey ? "text" : "password"} placeholder="sk-... 或 $ENV_VAR 或 !command" value={def.apiKey || ""} onChange={(e) => patch({ apiKey: e.target.value || undefined })} />
          <button className="set-iconbtn" title={showKey ? "隐藏" : "显示"} onClick={() => setShowKey((v) => !v)}>
            <Eye off={!showKey} />
          </button>
        </div>
      </Field>

      <Field label={language === "zh" ? "请求头" : "Request headers"} hint="自定义请求头，值同样支持 $ENV / !cmd">
        <KvList value={def.headers as Record<string, string> | undefined} onChange={(v) => patch({ headers: v })} />
      </Field>

      <button className="set-adv-toggle" onClick={() => setAdv((v) => !v)}>
        <span style={{ transform: adv ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .15s" }}>›</span> 提供商级 compat（高级 JSON）
      </button>
      {adv && (
        <div className="set-adv-body">
          <JsonField key={`p:${k}:compat`} path={`p:${k}:compat`} value={def.compat} register={register} onChange={(v) => patch({ compat: v as Record<string, unknown> | undefined })} />
        </div>
      )}

      <div className="set-models-head">
        <span>模型</span>
        <button className="set-addline" onClick={addModel}>
          <Plus size={13} /> 添加模型
        </button>
      </div>
      {models.length === 0 && <div className="set-empty-mini">暂无模型，点击“添加模型”。</div>}
      {models.map((m, i) => (
        <ModelRow
          key={i}
          m={m}
          i={i}
          pfx={`m:${k}:${i}`}
          providerId={k}
          provider={def}
          language={language}
          patch={(p) => updateModel(i, p)}
          remove={() => deleteModel(i)}
          register={register}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Main panel
 * ------------------------------------------------------------------ */

type Tab = "models" | "thinking" | "archive" | "diag" | "update" | "about";

interface NewProviderDraft {
  id: string;
  baseUrl: string;
  apiKey: string;
  api: ApiType;
  modelId: string;
}

const emptyNewProvider = (): NewProviderDraft => ({
  id: "",
  baseUrl: "",
  apiKey: "",
  api: "openai-completions",
  modelId: "",
});

/**
 * Map each updater stage onto a slice of one continuous 0–100 bar, so the
 * fill never jumps backwards when a new stage starts. Stages without a
 * per-stage pct (checking / pruning / activating) render indeterminate.
 */
const UPDATE_STAGE_SPANS: Record<string, [number, number]> = {
  checking: [0, 6],
  downloading: [6, 50],
  installing: [50, 88],
  pruning: [88, 94],
  activating: [94, 100],
  done: [100, 100],
};
function overallUpdatePct(stage: string, pct?: number): number | null {
  const span = UPDATE_STAGE_SPANS[stage];
  if (!span) return null;
  if (stage === "done") return 100;
  if (pct == null) return null;
  return Math.min(100, Math.round(span[0] + ((span[1] - span[0]) * pct) / 100));
}

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const close = useStore((s) => s.closeSettings);
  const pushToast = useStore((s) => s.pushToast);
  const config = useStore((s) => s.config);
  const restoreProject = useStore((s) => s.restoreProject);
  const restoreThread = useStore((s) => s.restoreThread);
  const refreshOpenThreadModels = useStore((s) => s.refreshOpenThreadModels);
  const language = config?.language || "en";

  const [tab, setTab] = useState<Tab>("models");
  const [draft, setDraft] = useState<ModelsFile>({ providers: {} });
  const [initialProviders, setInitialProviders] = useState("{}");
  const [thinking, setThinking] = useState<ThinkingDefaults>({});
  const [initialThinking, setInitialThinking] = useState("{}");
  const [invalidJson, setInvalidJson] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<null | "models" | "thinking">(null);
  const [flash, setFlash] = useState<null | "models" | "thinking">(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [paths, setPaths] = useState<{ agentDir: string; models: string; settings: string; auth: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [newProvider, setNewProvider] = useState<NewProviderDraft>(emptyNewProvider);

  // ---- pi update ----
  const [updating, setUpdating] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{
    current: string | null;
    latest: string | null;
    hasUpdate: boolean;
    note?: string | null;
    source: string | null;
    error?: string;
  } | null>(null);
  const [progress, setProgress] = useState<{ stage: string; message: string; pct?: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatedTo, setUpdatedTo] = useState<string | null>(null);

  // ---- Pi Studio application update ----
  const [appUpdating, setAppUpdating] = useState(false);
  const [appUpdateStatus, setAppUpdateStatus] = useState<{
    current: string;
    latest: string | null;
    hasUpdate: boolean;
    source: string | null;
    releaseUrl: string | null;
    assetName: string | null;
    supported: boolean;
    installable: boolean;
    downloaded: boolean;
    error?: string;
  } | null>(null);
  const [appUpdateProgress, setAppUpdateProgress] = useState<{ stage: string; message: string; pct?: number } | null>(null);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);
  const [appUpdateReady, setAppUpdateReady] = useState(false);

  // Track the in-app core updater with a single state object so the progress
  // bar updates in place instead of appending one line per percentage point.
  useEffect(() => {
    if (!updating) return;
    const off = window.pi.on.coreUpdate((p) => {
      setProgress(p);
      if (p.stage === "error") setUpdateError(p.message);
    });
    return off;
  }, [updating]);

  useEffect(() => {
    const off = window.pi.on.appUpdate((p) => {
      setAppUpdateProgress(p);
      if (p.stage === "error") setAppUpdateError(p.message);
    });
    return off;
  }, []);

  const refreshUpdateState = async () => {
    try {
      const [d, s, a] = await Promise.all([
        window.pi.settings.getDiagnostics(),
        window.pi.app.checkCoreUpdate(),
        window.pi.app.checkAppUpdate(),
      ]);
      setDiag(d as any);
      setUpdateStatus(s as any);
      setAppUpdateStatus(a as any);
      setAppUpdateReady(Boolean((a as any)?.downloaded));
    } catch {
      /* keep stale values; not worth a toast */
    }
  };

  const checkAppRelease = async () => {
    setAppUpdating(true);
    setAppUpdateError(null);
    setAppUpdateProgress({ stage: "checking", message: language === "zh" ? "正在检查 GitHub 发布页最新版本…" : "Checking the latest GitHub Release…" });
    try {
      const status: any = await window.pi.app.checkAppUpdate();
      setAppUpdateStatus(status);
      setAppUpdateReady(Boolean(status?.downloaded));
      if (status?.error) setAppUpdateError(status.error);
    } catch (e: any) {
      setAppUpdateError(e?.message || String(e));
    } finally {
      setAppUpdating(false);
    }
  };

  const downloadAppRelease = async () => {
    setAppUpdating(true);
    setAppUpdateProgress(null);
    setAppUpdateError(null);
    try {
      const result: any = await window.pi.app.downloadAppUpdate();
      if (result?.ok && result?.downloaded) {
        setAppUpdateReady(true);
        pushToast("success", language === "zh" ? result.message : `Pi Studio v${result.version || ""} is ready to install.`);
      } else if (result?.ok) {
        pushToast("info", language === "zh" ? result.message : "Pi Studio is already up to date.");
      } else {
        setAppUpdateError(result?.message || (language === "zh" ? "应用更新失败" : "App update failed"));
      }
      const status: any = await window.pi.app.checkAppUpdate();
      setAppUpdateStatus(status);
      setAppUpdateReady(Boolean(result?.downloaded || status?.downloaded));
    } catch (e: any) {
      setAppUpdateError(e?.message || String(e));
    } finally {
      setAppUpdating(false);
    }
  };

  const installAppRelease = async () => {
    setAppUpdateError(null);
    try {
      const result: any = await window.pi.app.installAppUpdate();
      if (!result?.ok) setAppUpdateError(result?.message || (language === "zh" ? "启动安装程序失败" : "Could not start the installer"));
    } catch (e: any) {
      setAppUpdateError(e?.message || String(e));
    }
  };

  const runUpdate = async () => {
    setUpdating(true);
    setProgress(null);
    setUpdateError(null);
    setUpdatedTo(null);
    try {
      const res: any = await window.pi.app.updatePi();

      if (res?.managed) {
        // In-app updater for the bundled / app-managed runtime.
        if (res.ok && res.updated) {
          pushToast("success", res.output);
          setUpdatedTo(res.to);
        } else if (res.ok) {
          pushToast("info", res.output);
        } else {
          pushToast("error", res.output);
        }
      } else {
        // System-installed pi (npm/pnpm global) updated itself via `pi update`.
        const raw = stripAnsi(res?.output || "");
        const text = cleanOutput(raw);
        const assertion = hasLibuvAssertion(raw);

        if (res?.ok) {
          if (/already up to date/i.test(text)) pushToast("info", "Pi 已是最新版本。");
          else pushToast("success", "Pi 已更新到最新版本。");
        } else if (assertion) {
          if (/already up to date/i.test(text)) {
            pushToast("info", "Pi 已是最新版本。");
          } else if (/Updating/i.test(text)) {
            pushToast("warning", "Pi 更新命令已执行，但进程退出时出现已知 Windows 兼容问题。请重启 Pi Studio 以使用新版本。");
          } else {
            pushToast("warning", "Pi 更新状态不确定（进程退出异常）。请重启 Pi Studio 后检查版本。");
          }
        } else {
          pushToast("error", "Pi 更新失败：" + (lastLine(text) || "未知错误"));
        }
      }
      await refreshUpdateState();
    } catch (e: any) {
      pushToast("error", "Pi 更新失败：" + (e?.message || String(e)));
    } finally {
      setUpdating(false);
    }
  };

  const register = useCallback((p: string, ok: boolean) => setInvalidJson((s) => ({ ...s, [p]: ok })), []);

  useEffect(() => {
    if (!open) return;
    setTab("models");
    setInvalidJson({});
    setAdding(false);
    setNewProvider(emptyNewProvider());
    setProgress(null);
    setUpdateError(null);
    setUpdatedTo(null);
    setAppUpdating(false);
    setAppUpdateStatus(null);
    setAppUpdateProgress(null);
    setAppUpdateError(null);
    setAppUpdateReady(false);
    setAppVersion(null);
    (async () => {
      try {
        const [models, think, d, p, version] = await Promise.all([
          window.pi.settings.getModels(),
          window.pi.settings.getThinking(),
          window.pi.settings.getDiagnostics(),
          window.pi.settings.getPaths(),
          window.pi.app.getVersion(),
        ]);
        setDraft(clone(models));
        setInitialProviders(JSON.stringify(models.providers || {}));
        setThinking(think || {});
        setInitialThinking(JSON.stringify(think || {}));
        setDiag(d);
        setPaths(p);
        setAppVersion(typeof version === "string" ? version : null);
      } catch (e: any) {
        pushToast("error", "读取配置失败：" + (e?.message || e));
      }
      // Version check is network-bound; don't let it hold up the panel.
      window.pi.app
        .checkCoreUpdate()
        .then((s: any) => setUpdateStatus(s))
        .catch(() => undefined);
      window.pi.app
        .checkAppUpdate()
        .then((s: any) => {
          setAppUpdateStatus(s);
          setAppUpdateReady(Boolean(s?.downloaded));
        })
        .catch(() => undefined);
    })();
  }, [open, pushToast]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") attemptClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, thinking, initialProviders, initialThinking]);

  const modelDirty = useMemo(() => JSON.stringify(draft.providers) !== initialProviders, [draft.providers, initialProviders]);
  const thinkDirty = useMemo(() => JSON.stringify(thinking) !== initialThinking, [thinking, initialThinking]);
  /** Continuous 0–100 value for the update progress bar (null = indeterminate). */
  const liveUpdatePct = progress ? overallUpdatePct(progress.stage, progress.pct) : null;

  function attemptClose() {
    if (
      (modelDirty || thinkDirty) &&
      !window.confirm(language === "zh" ? "有未保存的更改，确定放弃并关闭？" : "Discard unsaved changes and close?")
    ) return;
    close();
  }

  /* ---- model mutations (spread preserves unknown fields) ---- */
  const updateProvider = (k: string, p: Partial<ProviderDef>) =>
    setDraft((d) => ({ ...d, providers: { ...d.providers, [k]: { ...d.providers[k], ...p } } }));
  const renameProvider = (from: string, rawName: string): boolean => {
    const to = rawName.trim();
    if (!to) {
      pushToast("warning", language === "zh" ? "供应商名称不能为空" : "Provider name cannot be empty.");
      return false;
    }
    if (to === from) return true;
    if (draft.providers[to]) {
      pushToast("error", language === "zh" ? "该供应商名称已存在" : "That provider name already exists.");
      return false;
    }
    setDraft((current) => ({
      ...current,
      providers: Object.fromEntries(
        Object.entries(current.providers).map(([key, value]) => (key === from ? [to, value] : [key, value])),
      ),
    }));
    setInvalidJson((current) =>
      Object.fromEntries(
        Object.entries(current).map(([path, valid]) => [
          path.replace(`p:${from}:`, `p:${to}:`).replace(`m:${from}:`, `m:${to}:`),
          valid,
        ]),
      ),
    );
    return true;
  };
  const updateModel = (k: string, i: number, p: Partial<ModelDef>) =>
    setDraft((d) => {
      const prov = d.providers[k];
      const models = [...(prov.models || [])];
      models[i] = { ...models[i], ...p };
      return { ...d, providers: { ...d.providers, [k]: { ...prov, models } } };
    });
  const addModel = (k: string) => updateProvider(k, { models: [...(draft.providers[k].models || []), { id: "" }] });
  const deleteModel = (k: string, i: number) =>
    setDraft((d) => {
      const prov = d.providers[k];
      const models = (prov.models || []).filter((_, idx) => idx !== i);
      return { ...d, providers: { ...d.providers, [k]: { ...prov, models } } };
    });
  const deleteProvider = (k: string) => {
    const question = language === "zh" ? `删除提供商 “${k}” 及其全部模型？` : `Delete provider “${k}” and all of its models?`;
    if (!window.confirm(question)) return;
    setDraft((d) => {
      const p = { ...d.providers };
      delete p[k];
      return { ...d, providers: p };
    });
  };
  const confirmAddProvider = () => {
    const id = newProvider.id.trim();
    const baseUrl = newProvider.baseUrl.trim();
    const modelId = newProvider.modelId.trim();
    if (!id) return pushToast("warning", language === "zh" ? "请输入供应商名称" : "Enter a provider name.");
    if (!baseUrl) return pushToast("warning", language === "zh" ? "请输入 API 地址" : "Enter the API URL.");
    if (!modelId) return pushToast("warning", language === "zh" ? "请输入模型 ID" : "Enter a model ID.");
    if (draft.providers[id]) return pushToast("error", language === "zh" ? "该供应商名称已存在" : "That provider name already exists.");
    const provider: ProviderDef = {
      baseUrl,
      api: newProvider.api,
      apiKey: newProvider.apiKey.trim() || undefined,
      models: [{ id: modelId, name: modelId }],
    };
    setDraft((d) => ({ ...d, providers: { ...d.providers, [id]: provider } }));
    setAdding(false);
    setNewProvider(emptyNewProvider());
  };
  const reloadModels = async () => {
    if (
      modelDirty &&
      !window.confirm(
        language === "zh"
          ? "将丢弃未保存的模型编辑并重新读取 models.json，继续？"
          : "Discard unsaved model changes and reload models.json?",
      )
    ) return;
    const models = await window.pi.settings.getModels();
    setDraft(clone(models));
    setInitialProviders(JSON.stringify(models.providers || {}));
    setInvalidJson({});
  };

  /* ---- save ---- */
  const saveModels = async () => {
    if (Object.values(invalidJson).some((valid) => !valid)) return pushToast("error", "请先修正标红的高级 JSON 字段");
    setSaving("models");
    try {
      const saved = await window.pi.settings.saveModels(draft.providers);
      const savedModels = saved?.models as ModelsFile | undefined;
      if (savedModels) {
        setDraft(clone(savedModels));
        setInitialProviders(JSON.stringify(savedModels.providers || {}));
      } else {
        setInitialProviders(JSON.stringify(draft.providers));
      }
      await refreshOpenThreadModels();
      setFlash("models");
      setTimeout(() => setFlash(null), 1500);
      pushToast(
        "info",
        language === "zh"
          ? "模型配置已保存，新模型现在可在对话框中选择。"
          : "Model settings saved. New models are now available in the composer.",
      );
    } catch (e: any) {
      pushToast("error", "保存失败：" + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };
  const saveThinking = async () => {
    setSaving("thinking");
    try {
      const res = await window.pi.settings.saveThinking(thinking as Record<string, unknown>);
      setThinking(res);
      setInitialThinking(JSON.stringify(res));
      setFlash("thinking");
      setTimeout(() => setFlash(null), 1500);
      pushToast("info", "思考默认值已保存到 settings.json。");
    } catch (e: any) {
      pushToast("error", "保存失败：" + (e?.message || e));
    } finally {
      setSaving(null);
    }
  };

  if (!open) return null;

  const providerKeys = Object.keys(draft.providers);
  const defaultModelDefs = thinking.defaultProvider ? draft.providers[thinking.defaultProvider]?.models || [] : [];
  const defaultModels = defaultModelDefs.map((m) => m.id);
  const selectedDefaultModel = defaultModelDefs.find((m) => m.id === thinking.defaultModel);
  const availableThinkingLevels = supportedThinkingLevels(selectedDefaultModel);

  const changeLanguage = async (language: "en" | "zh") => {
    const next = await window.pi.app.setConfig({ language });
    useStore.setState({ config: next });
  };

  const changeTheme = async (theme: "dark" | "light" | "system") => {
    const next = await window.pi.app.setConfig({ theme });
    useStore.setState({ config: next });
  };

  const openFile = async (abs: string) => {
    const r = await window.pi.settings.openPath(abs);
    if (r && r.ok === false) pushToast("error", "打开失败：" + (r.error || ""));
  };

  return (
    <div className="settings-backdrop" onMouseDown={attemptClose}>
      <div className="set-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <aside className="set-side">
          <div className="set-brand">
            <span className="set-brand-mark set-brand-app-icon">
              <img src={appIconUrl} alt="" aria-hidden="true" />
            </span>
            <div>
              <div className="set-brand-title">设置</div>
              <div className="set-brand-sub">Pi Studio</div>
            </div>
          </div>
          <nav className="set-tabs">
            {([
              ["models", "模型与提供商"],
              ["thinking", "思考默认值"],
              ["archive", "已归档项目"],
              ["diag", "诊断与配置"],
              ["update", language === "zh" ? "应用更新" : "App updates"],
              ["about", language === "zh" ? "关于" : "About"],
            ] as [Tab, string][]).map(([id, label]) => (
              <button key={id} className={`set-tab ${tab === id ? "active" : ""}`} onClick={() => setTab(id)}>
                <span className="set-tab-bar" />
                {label}
                {id === "models" && modelDirty && <span className="set-dot" />}
                {id === "thinking" && thinkDirty && <span className="set-dot" />}
              </button>
            ))}
          </nav>
          <div className="set-side-foot">
            <label className="set-language">
              <span>{language === "zh" ? "主题模式" : "Theme"}</span>
              <select value={config?.theme || "light"} onChange={(e) => changeTheme(e.target.value as "dark" | "light" | "system")}>
                <option value="system">{language === "zh" ? "跟随系统" : "System"}</option>
                <option value="light">{language === "zh" ? "浅色" : "Light"}</option>
                <option value="dark">{language === "zh" ? "夜间" : "Dark"}</option>
              </select>
            </label>
            <label className="set-language">
              <span>{language === "zh" ? "语言" : "Language"}</span>
              <select value={config?.language || "en"} onChange={(e) => changeLanguage(e.target.value as "en" | "zh")}>
                <option value="en">{language === "zh" ? "英文" : "English"}</option>
                <option value="zh">{language === "zh" ? "中文" : "Chinese"}</option>
              </select>
            </label>
            编辑会写入 <code>~/.pi/agent</code>，与终端 pi 共享。
          </div>
        </aside>

        <section className="set-main">
          <header className="set-head">
            <h2>
              {tab === "models"
                ? "模型与提供商"
                : tab === "thinking"
                  ? "思考默认值"
                    : tab === "archive"
                      ? "已归档项目"
                      : tab === "update"
                      ? language === "zh"
                        ? "应用更新"
                        : "App updates"
                      : tab === "about"
                        ? language === "zh"
                          ? "关于"
                          : "About"
                        : "诊断与配置文件"}
            </h2>
            <div className="set-head-actions">
              {tab === "models" && (
                <>
                  <button className="set-btn ghost" onClick={reloadModels} title="重新读取 models.json">
                    <Refresh size={14} /> 重新加载
                  </button>
                  <button className={`set-btn primary ${flash === "models" ? "saved" : ""}`} onClick={saveModels} disabled={!!saving}>
                    {saving === "models" ? <span className="spinner" /> : flash === "models" ? "已保存 ✓" : "保存模型配置"}
                    {modelDirty && flash !== "models" && <span className="set-dot" />}
                  </button>
                </>
              )}
              {tab === "thinking" && (
                <button className={`set-btn primary ${flash === "thinking" ? "saved" : ""}`} onClick={saveThinking} disabled={!!saving}>
                  {saving === "thinking" ? <span className="spinner" /> : flash === "thinking" ? "已保存 ✓" : "保存思考默认值"}
                  {thinkDirty && flash !== "thinking" && <span className="set-dot" />}
                </button>
              )}
              <button className="set-iconbtn" title="关闭" onClick={attemptClose}>
                <Close size={16} />
              </button>
            </div>
          </header>

          <div className="set-body">
            {tab === "models" && (
              <>
                <div className="set-prov-toolbar">
                  <span className="muted">
                    {language === "zh"
                      ? "自定义提供商与模型，参考 models.md。常用字段图形化；compat 在“高级”里用 JSON 编辑，thinkingLevelMap 按档位配置。"
                      : "Configure custom providers and models using models.md. Common fields have controls; edit compat as JSON under Advanced and configure thinkingLevelMap by level."}
                  </span>
                  {!adding && (
                    <button className="set-btn" onClick={() => setAdding(true)}>
                      <Plus size={14} /> {language === "zh" ? "添加供应商" : "Add provider"}
                    </button>
                  )}
                </div>

                {adding && (
                  <form
                    className="set-addprov-card"
                    onSubmit={(event) => {
                      event.preventDefault();
                      confirmAddProvider();
                    }}
                  >
                    <div className="set-addprov-head">
                      <div>
                        <div className="set-addprov-title">{language === "zh" ? "新增模型供应商" : "Add model provider"}</div>
                        <div className="set-addprov-sub">
                          {language === "zh"
                            ? "一次填写连接信息和首个模型，添加后仍可继续配置高级选项。"
                            : "Set up the connection and first model in one step. Advanced options remain editable afterward."}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="set-iconbtn"
                        title={language === "zh" ? "取消" : "Cancel"}
                        onClick={() => {
                          setAdding(false);
                          setNewProvider(emptyNewProvider());
                        }}
                      >
                        <Close size={15} />
                      </button>
                    </div>

                    <div className="set-addprov-grid">
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "供应商名称" : "Provider name"}</span>
                        <input
                          className="set-input"
                          autoFocus
                          placeholder="my-provider"
                          value={newProvider.id}
                          onChange={(event) => setNewProvider((value) => ({ ...value, id: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "API 类型" : "API type"}</span>
                        <select
                          className="set-select"
                          value={newProvider.api}
                          onChange={(event) => setNewProvider((value) => ({ ...value, api: event.target.value as ApiType }))}
                        >
                          {API_TYPES.map((api) => (
                            <option key={api} value={api}>
                              {api}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="set-addprov-field wide">
                        <span>{language === "zh" ? "API 地址" : "API URL"}</span>
                        <input
                          className="set-input"
                          placeholder="https://api.example.com/v1"
                          value={newProvider.baseUrl}
                          onChange={(event) => setNewProvider((value) => ({ ...value, baseUrl: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "API 密钥" : "API key"}</span>
                        <input
                          className="set-input"
                          type="password"
                          placeholder={language === "zh" ? "可留空，支持 $ENV_VAR" : "Optional; supports $ENV_VAR"}
                          value={newProvider.apiKey}
                          onChange={(event) => setNewProvider((value) => ({ ...value, apiKey: event.target.value }))}
                        />
                      </label>
                      <label className="set-addprov-field">
                        <span>{language === "zh" ? "模型 ID" : "Model ID"}</span>
                        <input
                          className="set-input"
                          placeholder="model-id"
                          value={newProvider.modelId}
                          onChange={(event) => setNewProvider((value) => ({ ...value, modelId: event.target.value }))}
                        />
                      </label>
                    </div>

                    <div className="set-addprov-actions">
                      <button
                        type="button"
                        className="set-btn ghost"
                        onClick={() => {
                          setAdding(false);
                          setNewProvider(emptyNewProvider());
                        }}
                      >
                        {language === "zh" ? "取消" : "Cancel"}
                      </button>
                      <button type="submit" className="set-btn primary">
                        {language === "zh" ? "添加供应商" : "Add provider"}
                      </button>
                    </div>
                  </form>
                )}

                {providerKeys.length === 0 && !adding && <div className="set-empty">尚无提供商。点“添加提供商”接入自定义 API（OpenAI / Anthropic / Gemini 兼容端点、Ollama、代理等）。</div>}

                {providerKeys.map((k) => (
                  <ProviderCard
                    key={k}
                    k={k}
                    def={draft.providers[k]}
                    language={language}
                    rename={(name) => renameProvider(k, name)}
                    patch={(p) => updateProvider(k, p)}
                    del={() => deleteProvider(k)}
                    register={register}
                    addModel={() => addModel(k)}
                    updateModel={(i, p) => updateModel(k, i, p)}
                    deleteModel={(i) => deleteModel(k, i)}
                  />
                ))}
              </>
            )}

            {tab === "thinking" && (
              <div className="set-card">
                <Field label="默认思考深度" hint="新建会话的初始思考等级；模型需 reasoning=true 才生效">
                  <select className="set-select" value={thinking.defaultThinkingLevel || "off"} onChange={(e) => setThinking((t) => ({ ...t, defaultThinkingLevel: e.target.value }))}>
                    {availableThinkingLevels.map((l) => (
                      <option key={l} value={l}>
                        {reasoningLevelLabel(l, config?.language || "en")}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="默认提供商">
                  <select className="set-select" value={thinking.defaultProvider || ""} onChange={(e) => setThinking((t) => ({ ...t, defaultProvider: e.target.value || undefined, defaultModel: undefined }))}>
                    <option value="">（未设）</option>
                    {providerKeys.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="默认模型">
                  <select className="set-select" value={thinking.defaultModel || ""} onChange={(e) => setThinking((t) => ({ ...t, defaultModel: e.target.value || undefined }))} disabled={!thinking.defaultProvider}>
                    <option value="">（未设）</option>
                    {defaultModels.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="隐藏思考块">
                  <Toggle checked={!!thinking.hideThinkingBlock} onChange={(v) => setThinking((t) => ({ ...t, hideThinkingBlock: v }))} />
                </Field>
                <div className="set-hint" style={{ marginTop: 8 }}>
                  这些是全局默认值，写入 settings.json。单个模型的思考能力由该模型的“思考”开关与 compat 决定。
                </div>
              </div>
            )}

            {tab === "archive" && (
              <div className="set-card">
                <div className="set-card-title">已归档项目</div>
                <div className="set-hint archived-project-hint">
                  归档只会从侧栏、搜索和新建任务的项目列表中隐藏文件夹，不会删除文件夹或其中的线程。
                </div>
                {(config?.archivedProjects || []).length === 0 ? (
                  <div className="set-empty">暂无归档项目。</div>
                ) : (
                  <div className="archived-project-list">
                    {(config?.archivedProjects || []).map((cwd) => {
                      const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
                      return (
                        <div className="archived-project-row" key={cwd}>
                          <Folder size={17} />
                          <div className="archived-project-main">
                            <div className="archived-project-name">{name}</div>
                            <div className="archived-project-path" title={cwd}>{cwd}</div>
                          </div>
                          <button className="set-btn" onClick={() => restoreProject(cwd)}>恢复项目</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <div className="archived-thread-section">
                  <div className="set-card-title">已归档线程</div>
                  <div className="set-hint archived-project-hint">
                    归档只会隐藏线程，不会删除会话文件；恢复后线程会重新出现在所属项目下。
                  </div>
                  {(config?.archivedThreads || []).length === 0 ? (
                    <div className="set-empty">暂无归档线程。</div>
                  ) : (
                    <div className="archived-thread-list">
                      {(config?.archivedThreads || []).map((thread) => {
                        const projectName = thread.cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || thread.cwd;
                        return (
                          <div className="archived-thread-row" key={thread.file}>
                            <Archive size={17} />
                            <div className="archived-thread-main">
                              <div className="archived-thread-name" title={thread.title}>{thread.title || thread.file}</div>
                              <div className="archived-thread-path" title={thread.file}>{projectName} · {thread.file}</div>
                            </div>
                            <button className="set-btn" onClick={() => restoreThread(thread.file)}>恢复线程</button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === "diag" && (
              <>
                <div className="set-card">
                  <div className="set-card-title">Pi 运行时</div>
                  {diag?.error && <div className="set-diag-err">⚠ {diag.error}</div>}
                  <div className="set-diag-grid">
                    <div className="set-diag-k">node</div>
                    <div className="set-diag-v">{diag?.node || "—"}</div>
                    <div className="set-diag-k">node 版本</div>
                    <div className="set-diag-v">{diag?.nodeVersion || "—"}</div>
                    <div className="set-diag-k">pi cli.js</div>
                    <div className="set-diag-v">{diag?.cli || "—"}</div>
                    <div className="set-diag-k">pi 版本</div>
                    <div className="set-diag-v">{diag?.piVersion || "—"}</div>
                  </div>
                </div>

                <div className="set-card">
                  <div className="set-card-title">配置文件</div>
                  <div className="set-diag-grid">
                    <div className="set-diag-k">配置目录</div>
                    <div className="set-diag-v">{paths?.agentDir || diag?.agentDir || "—"}</div>
                    <div className="set-diag-k">settings.json</div>
                    <div className="set-diag-v">{paths?.settings || "—"}</div>
                    <div className="set-diag-k">models.json</div>
                    <div className="set-diag-v">{paths?.models || "—"}</div>
                    <div className="set-diag-k">auth.json</div>
                    <div className="set-diag-v">{paths?.auth || "—"}</div>
                  </div>
                  <div className="set-diag-btns">
                    <button className="set-btn ghost" onClick={() => window.pi.settings.openAgentDir()}>
                      打开配置目录
                    </button>
                    <button className="set-btn ghost" onClick={() => paths && openFile(paths.settings)}>
                      打开 settings.json
                    </button>
                    <button className="set-btn ghost" onClick={() => paths && openFile(paths.models)}>
                      打开 models.json
                    </button>
                    {paths && (
                      <button className="set-btn ghost" onClick={() => window.pi.settings.showItem(paths.models)} title="在资源管理器中显示">
                        在资源管理器显示
                      </button>
                    )}
                  </div>
                  <div className="set-hint" style={{ marginTop: 8 }}>
                    这些文件由桌面端与终端 pi 共享。在此面板保存会原子写回并保留你手写的高级字段；也可用上方按钮直接在外部编辑。
                  </div>
                </div>
              </>
            )}

            {tab === "update" && (
              <>
                <div className="set-card">
                  <div className="set-card-title">{language === "zh" ? "Pi Studio 应用更新" : "Pi Studio app update"}</div>
                  <div className="set-hint" style={{ marginBottom: 12 }}>
                    {language === "zh"
                      ? "从 GitHub 发布页检查最新正式版本。发现新版本后，可在此下载 Windows 安装包并安装重启。"
                      : "Check the latest stable release from GitHub Releases. Download and install a Windows update here, then restart Pi Studio."}
                  </div>
                  <div className="set-diag-grid" style={{ marginBottom: 12 }}>
                    <div className="set-diag-k">{language === "zh" ? "当前版本" : "Current version"}</div>
                    <div className="set-diag-v">{appUpdateStatus?.current ? `v${appUpdateStatus.current}` : appVersion ? `v${appVersion}` : "—"}</div>
                    <div className="set-diag-k">{language === "zh" ? "最新版本" : "Latest version"}</div>
                    <div className="set-diag-v">
                      {appUpdateStatus?.error ? (
                        <span className="set-diag-err" style={{ display: "inline-block", margin: 0 }}>
                          {language === "zh" ? "检查失败：" : "Check failed: "}{appUpdateStatus.error}
                        </span>
                      ) : (
                        <>
                          {appUpdateStatus?.latest ? `v${appUpdateStatus.latest}` : "—"}
                          {appUpdateStatus?.hasUpdate && <span className="set-tag-new">{language === "zh" ? "可更新" : "Update available"}</span>}
                        </>
                      )}
                    </div>
                    <div className="set-diag-k">{language === "zh" ? "来源" : "Source"}</div>
                    <div className="set-diag-v">{language === "zh" ? "GitHub 发布页" : "GitHub Releases"}</div>
                  </div>
                  <div className="set-diag-btns">
                    <button className="set-btn ghost" onClick={checkAppRelease} disabled={appUpdating}>
                      {appUpdating && appUpdateProgress?.stage === "checking"
                        ? language === "zh"
                          ? "检查中…"
                          : "Checking…"
                        : language === "zh"
                          ? "检查最新版本"
                          : "Check for updates"}
                    </button>
                    {appUpdateStatus?.hasUpdate && !appUpdateReady && (
                      <button
                        className="set-btn primary"
                        onClick={downloadAppRelease}
                        disabled={appUpdating || !appUpdateStatus.supported || !appUpdateStatus.installable}
                      >
                        {appUpdating && appUpdateProgress?.stage === "downloading"
                          ? language === "zh"
                            ? "下载中…"
                            : "Downloading…"
                          : language === "zh"
                            ? `下载 v${appUpdateStatus.latest}`
                            : `Download v${appUpdateStatus.latest}`}
                      </button>
                    )}
                    {appUpdateReady && (
                      <button className="set-btn primary" onClick={installAppRelease} disabled={!appUpdateStatus?.installable}>
                        {language === "zh" ? "安装并重启" : "Install and restart"}
                      </button>
                    )}
                  </div>
                  {appUpdateProgress && (appUpdating || appUpdateReady) && (
                    <div className="upd-progress">
                      <div className="upd-progress-head">
                        <span className="upd-progress-label">{translateUiText(appUpdateProgress.message, language)}</span>
                        {appUpdateProgress.pct != null && <span className="upd-progress-pct">{appUpdateProgress.pct}%</span>}
                      </div>
                      <div className={"upd-bar" + (appUpdateProgress.pct == null ? " indeterminate" : "")}>
                        <div className="upd-bar-fill" style={appUpdateProgress.pct != null ? { width: `${appUpdateProgress.pct}%` } : undefined} />
                      </div>
                    </div>
                  )}
                  {appUpdateError && !appUpdating && <div className="set-diag-err">⚠ {translateUiText(appUpdateError, language)}</div>}
                </div>

                <div className="set-card">
                <div className="set-card-title">更新 Pi 核心</div>
                <div className="set-hint" style={{ marginBottom: 12 }}>
                  {diag?.bundled ? (
                    <>Pi 核心由 Pi Studio 统一管理（内置副本不可被 <code>pi update</code> 原地更新）。点击下方按钮后，Pi Studio 会自行下载并安装新版本到应用数据目录，更新完成后新开的线程使用新版本。扩展请在「插件」面板更新。</>
                  ) : (
                    <>运行 <code>pi update</code> 更新 pi CLI 本体（不含扩展，扩展请在「插件」面板更新）。会先检查是否为最新版本，结果以提示呈现。更新完成后新开的线程使用新版本。</>
                  )}
                </div>
                <div className="set-diag-grid" style={{ marginBottom: 12 }}>
                  <div className="set-diag-k">当前版本</div>
                  <div className="set-diag-v">{updateStatus?.current || diag?.piVersion || "—"}</div>
                  <div className="set-diag-k">最新版本</div>
                  <div className="set-diag-v">
                    {updateStatus?.error ? (
                      <span className="set-diag-err" style={{ display: "inline-block", margin: 0 }}>检查失败：{updateStatus.error}</span>
                    ) : (
                      <>
                        {updateStatus?.latest || "—"}
                        {updateStatus?.hasUpdate && <span className="set-tag-new">可更新</span>}
                      </>
                    )}
                  </div>
                </div>
                {updateStatus?.note && <div className="set-hint" style={{ marginBottom: 12 }}>{updateStatus.note}</div>}
                <div>
                  <button className="set-btn primary" onClick={runUpdate} disabled={updating}>
                    {updating ? (
                      <>
                        <span className="spinner" /> 检查并更新中…
                      </>
                    ) : updateStatus?.hasUpdate && updateStatus.latest ? (
                      `更新到 v${updateStatus.latest}`
                    ) : (
                      "检查并更新 Pi"
                    )}
                  </button>
                  {updatedTo && (
                    <button className="set-btn" style={{ marginLeft: 8 }} onClick={() => window.pi.app.relaunch()}>
                      立即重启 Pi Studio
                    </button>
                  )}
                </div>
                {updating && progress && (
                  <div className="upd-progress">
                    <div className="upd-progress-head">
                      <span className="upd-progress-label">{translateUiText(progress.message, language)}</span>
                      {liveUpdatePct != null && <span className="upd-progress-pct">{liveUpdatePct}%</span>}
                    </div>
                    <div className={"upd-bar" + (liveUpdatePct == null ? " indeterminate" : "")}>
                      <div className="upd-bar-fill" style={liveUpdatePct != null ? { width: `${liveUpdatePct}%` } : undefined} />
                    </div>
                  </div>
                )}
                {updateError && !updating && <div className="set-diag-err">⚠ {translateUiText(updateError, language)}</div>}
                </div>
              </>
            )}

            {tab === "about" && (
              <div className="set-card set-about-card">
                <div className="set-card-title">{language === "zh" ? "关于 Pi Studio" : "About Pi Studio"}</div>
                <div className="set-about-list">
                  <div className="set-about-row">
                    <span>{language === "zh" ? "软件版本" : "Software version"}</span>
                    <code>{appVersion ? `v${appVersion}` : "—"}</code>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
