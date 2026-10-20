import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpConfig } from "../../../main/mcp-service";
import type { McpInstallCandidate, McpMarketplaceDetail, McpMarketplaceItem, McpMarketplaceSearchResult } from "../../../main/mcp-marketplace";
import "./mcp-marketplace.css";

/**
 * Browse, search and install MCP servers from the public Glama directory.
 * The panel never installs silently: every command is shown for review and the
 * generated `mcp.json` entry is previewed before it is written.
 */

type Props = {
  language: "en" | "zh";
  /** Server names already present in mcp.json, for collision feedback. */
  existingNames: string[];
  onInstalled: (result: { name: string; config: McpConfig }) => void;
};

type Row = { id: number; key: string; value: string };

type Draft = {
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  url: string;
  env: Row[];
  headers: Row[];
  exposure: string;
  overwrite: boolean;
};

let rowId = 0;
const newRow = (key = "", value = ""): Row => ({ id: ++rowId, key, value });

const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function rowsFromMap(map?: Record<string, string>): Row[] {
  const entries = Object.entries(map || {});
  return entries.length ? entries.map(([key, value]) => newRow(key, value)) : [];
}

function mapFromRows(rows: Row[]): Record<string, string> | undefined {
  const entries = rows.map((row) => [row.key.trim(), row.value] as const).filter(([key]) => key);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function draftFromCandidate(candidate: McpInstallCandidate, fallbackName: string, existingNames: string[]): Draft {
  const base = candidate.name || fallbackName;
  let name = base;
  let suffix = 2;
  while (existingNames.includes(name) && suffix < 50) name = `${base}-${suffix++}`;
  const env = rowsFromMap(candidate.env);
  const headers = rowsFromMap(candidate.headers);
  return {
    name,
    transport: candidate.transport,
    command: candidate.command || "",
    argsText: (candidate.args || []).join("\n"),
    url: candidate.url || "",
    env: env.length ? env : [newRow()],
    headers: headers.length ? headers : [newRow()],
    exposure: "codemode",
    overwrite: false,
  };
}

function buildEntry(draft: Draft): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  if (draft.transport === "http") {
    entry.url = draft.url.trim();
    const headers = mapFromRows(draft.headers);
    if (headers) entry.headers = headers;
    entry.type = "streamable-http";
  } else {
    entry.command = draft.command.trim();
    const args = draft.argsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (args.length) entry.args = args;
    const env = mapFromRows(draft.env);
    if (env) entry.env = env;
  }
  entry.enabled = true;
  entry.exposure = draft.exposure;
  return entry;
}

export function McpMarketplace({ language, existingNames, onInstalled }: Props) {
  const zh = language === "zh";
  const [query, setQuery] = useState("");
  const [attribute, setAttribute] = useState("");
  const [result, setResult] = useState<McpMarketplaceSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");

  const [target, setTarget] = useState<McpMarketplaceItem | null>(null);
  const [detail, setDetail] = useState<McpMarketplaceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installedName, setInstalledName] = useState("");
  const installRef = useRef<HTMLDivElement | null>(null);

  // The review panel opens below the results; keep it in view on tall lists.
  useEffect(() => {
    if (!target) return;
    installRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [target, detailLoading]);

  const runSearch = useCallback(async (text: string, facet: string) => {
    setSearching(true);
    setSearchError("");
    try {
      const next = await window.pi.settings.searchMcpMarketplace({ query: text.trim() || undefined, attribute: facet || undefined });
      setResult(next);
    } catch (error: any) {
      setResult(null);
      setSearchError(error?.message || String(error));
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    void runSearch("", "");
  }, [runSearch]);

  const submitSearch = () => {
    setTarget(null);
    void runSearch(query, attribute);
  };

  const toggleFacet = (next: string) => {
    const value = attribute === next ? "" : next;
    setAttribute(value);
    setTarget(null);
    void runSearch(query, value);
  };

  const openInstall = async (item: McpMarketplaceItem) => {
    setTarget(item);
    setDetail(null);
    setDraft(null);
    setDraftError("");
    setDetailError("");
    setInstalledName("");
    setCandidateIndex(0);
    setDetailLoading(true);
    try {
      const loaded = await window.pi.settings.getMcpMarketplaceDetail(item.url);
      setDetail(loaded);
      const first = loaded.candidates[0];
      if (first) setDraft(draftFromCandidate(first, loaded.id.split("/").pop() || "mcp-server", existingNames));
    } catch (error: any) {
      setDetailError(error?.message || String(error));
    } finally {
      setDetailLoading(false);
    }
  };

  const chooseCandidate = (index: number) => {
    setCandidateIndex(index);
    const candidate = detail?.candidates[index];
    if (candidate && detail) {
      setDraft(draftFromCandidate(candidate, detail.id.split("/").pop() || "mcp-server", existingNames));
      setDraftError("");
    }
  };

  const closeInstall = () => {
    setTarget(null);
    setDetail(null);
    setDraft(null);
    setDetailError("");
    setDraftError("");
  };

  const patchDraft = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const updateRow = (field: "env" | "headers", id: number, patch: Partial<Row>) =>
    setDraft((current) =>
      current ? { ...current, [field]: current[field].map((row) => (row.id === id ? { ...row, ...patch } : row)) } : current,
    );

  const addRow = (field: "env" | "headers") =>
    setDraft((current) => (current ? { ...current, [field]: [...current[field], newRow()] } : current));

  const removeRow = (field: "env" | "headers", id: number) =>
    setDraft((current) => (current ? { ...current, [field]: current[field].filter((row) => row.id !== id) } : current));

  const preview = useMemo(() => (draft ? JSON.stringify({ [draft.name || "server"]: buildEntry(draft) }, null, 2) : ""), [draft]);

  const nameTaken = Boolean(draft && existingNames.includes(draft.name.trim()));
  const facets = result?.facets || [];

  const install = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!NAME_PATTERN.test(name)) {
      setDraftError(zh ? "名称只能包含字母、数字、下划线和短横线（最长 64 个字符）。" : "Use letters, digits, underscores and dashes only (max 64 characters).");
      return;
    }
    if (draft.transport === "stdio" && !draft.command.trim()) {
      setDraftError(zh ? "请填写启动命令，例如 npx、uvx 或 docker。" : "Enter a start command, for example npx, uvx or docker.");
      return;
    }
    if (draft.transport === "http" && !/^https?:\/\//i.test(draft.url.trim())) {
      setDraftError(zh ? "远程服务器需要填写 HTTP(S) 地址。" : "A remote server needs an HTTP(S) URL.");
      return;
    }
    if (nameTaken && !draft.overwrite) {
      setDraftError(zh ? `已存在同名服务器「${name}」，可改名或勾选覆盖。` : `"${name}" already exists. Rename it or allow overwriting.`);
      return;
    }
    setInstalling(true);
    setDraftError("");
    try {
      const written = await window.pi.settings.installMcpServer({ name, server: buildEntry(draft), overwrite: draft.overwrite });
      onInstalled({ name: written.name, config: written.config });
      closeInstall();
      setInstalledName(written.name);
    } catch (error: any) {
      const message = error?.message || String(error);
      setDraftError(/already exists|已存在/i.test(message) && !draft.overwrite ? (zh ? "已存在同名服务器，可改名或勾选覆盖。" : "That name already exists. Rename it or allow overwriting.") : message);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="set-card mcp-market" aria-label={zh ? "MCP 市场" : "MCP marketplace"}>
      <div className="mcp-row mcp-market-head">
        <h3>{zh ? "MCP 市场" : "MCP marketplace"}</h3>
        <span className="mcp-market-credit">
          {zh ? "数据来自 " : "Data from "}
          <a href="https://glama.ai" target="_blank" rel="noopener">
            Glama
          </a>
          {" · "}
          <a href="https://glama.ai/mcp/servers" target="_blank" rel="noopener">
            {zh ? "浏览全部" : "browse all"}
          </a>
        </span>
      </div>
      <p className="set-hint">
        {zh
          ? "搜索 Glama 目录并一键写入 mcp.json。安装前会显示启动命令与生成配置，可先修改再安装；同名配置需要确认覆盖。安装后运行 /reload 或重新打开聊天以加载工具。"
          : "Search the Glama directory and write a server into mcp.json. The command and generated entry are shown for review before installing, and existing names require confirmation. Run /reload or reopen the chat to load its tools."}
      </p>

      <div className="mcp-market-search">
        <input
          className="set-input"
          aria-label={zh ? "搜索 MCP 服务器" : "Search MCP servers"}
          placeholder={zh ? "搜索服务器，例如 playwright、filesystem、postgres" : "Search servers, e.g. playwright, filesystem, postgres"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSearch();
          }}
        />
        <button className="set-btn primary" disabled={searching} onClick={submitSearch}>
          {searching ? <span className="spinner" /> : null}
          {zh ? "搜索" : "Search"}
        </button>
      </div>

      {facets.length > 0 && (
        <div className="mcp-market-facets" aria-label={zh ? "筛选" : "Filters"}>
          {facets.map((facet) => (
            <button
              key={facet.attribute}
              type="button"
              className={`mcp-market-chip ${attribute === facet.attribute ? "active" : ""}`}
              aria-pressed={attribute === facet.attribute}
              onClick={() => toggleFacet(facet.attribute)}
            >
              {facet.label}
              {facet.count !== undefined && <span>{facet.count.toLocaleString()}</span>}
            </button>
          ))}
        </div>
      )}

      {searchError && (
        <div className="set-json-err" role="alert">
          {searchError}
        </div>
      )}
      {installedName && !target && (
        <p role="status" className="mcp-market-installed">
          {zh ? `已安装「${installedName}」。运行 /reload 或重新打开聊天以加载工具。` : `Installed "${installedName}". Run /reload or reopen the chat to load its tools.`}
        </p>
      )}

      {result && (
        <div className="mcp-market-results">
          {result.items.length === 0 && !searching && (
            <p className="muted">{zh ? "没有匹配的服务器，换个关键词或清除筛选试试。" : "No matching servers. Try another keyword or clear the filter."}</p>
          )}
          {result.items.map((item) => (
            <div className="mcp-market-item" key={item.id} data-market-item={item.id}>
              <div className="mcp-market-item-main">
                <div className="mcp-market-item-title">
                  <strong>{item.name}</strong>
                  {item.author && <span className="mcp-market-author">@{item.author}</span>}
                  {item.operatingSystem && <span className="mcp-market-os">{item.operatingSystem}</span>}
                </div>
                {item.description && <p className="mcp-market-desc">{item.description}</p>}
                <div className="mcp-market-item-links">
                  <a href={item.url} target="_blank" rel="noopener">
                    {zh ? "在 Glama 查看" : "View on Glama"} ↗
                  </a>
                </div>
              </div>
              <div className="mcp-market-item-actions">
                <button
                  type="button"
                  className="set-btn"
                  data-market-install={item.id}
                  disabled={detailLoading && target?.id === item.id}
                  onClick={() => void openInstall(item)}
                >
                  {detailLoading && target?.id === item.id ? <span className="spinner" /> : null}
                  {zh ? "安装" : "Install"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {result && !searching && (
        <p className="set-hint mcp-market-foot">
          {zh
            ? "目录页每次返回最多 20 条，可结合关键词与分类筛选；完整结果请在 Glama 查看。"
            : "The directory page returns up to 20 matches; combine keywords with filters, and open Glama for the full list."}
        </p>
      )}

      {target && (
        <div className="mcp-market-install" data-market-detail={target.id} ref={installRef}>
          <div className="mcp-market-install-head">
            <div>
              <strong>{zh ? "安装 " : "Install "}{target.name}</strong>
              <div className="set-hint">
                <a href={target.url} target="_blank" rel="noopener">
                  {target.url}
                </a>
              </div>
            </div>
            <button type="button" className="set-iconbtn" title={zh ? "关闭" : "Close"} onClick={closeInstall}>
              ×
            </button>
          </div>

          {detailLoading && (
            <p className="muted">
              <span className="spinner" /> {zh ? "正在读取 Glama 上的安装示例…" : "Loading install examples from Glama…"}
            </p>
          )}
          {detailError && (
            <div className="set-json-err" role="alert">
              {detailError}
            </div>
          )}

          {detail && draft && (
            <>
              {detail.warnings.map((warning) => (
                <p className="mcp-market-warning" key={warning}>
                  {warning}
                </p>
              ))}
              {detail.candidates[candidateIndex]?.note && (
                <p className="mcp-market-warning">{detail.candidates[candidateIndex].note}</p>
              )}
              {detail.license && (
                <p className="set-hint">
                  {zh ? "许可证" : "License"}: {detail.license}
                  {detail.repositoryUrl && (
                    <>
                      {" · "}
                      <a href={detail.repositoryUrl} target="_blank" rel="noopener">
                        {zh ? "上游仓库" : "Repository"}
                      </a>
                    </>
                  )}
                </p>
              )}

              {detail.candidates.length > 1 && (
                <label className="mcp-market-field">
                  <span>{zh ? "安装示例" : "Install example"}</span>
                  <select
                    className="set-select"
                    aria-label={zh ? "安装示例" : "Install example"}
                    data-market-candidate
                    value={candidateIndex}
                    onChange={(event) => chooseCandidate(Number(event.target.value))}
                  >
                    {detail.candidates.map((candidate, index) => (
                      <option key={index} value={index}>
                        {`#${index + 1} ${candidate.transport === "http" ? candidate.url : [candidate.command, ...(candidate.args || [])].join(" ")}`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="mcp-market-grid">
                <label className="mcp-market-field">
                  <span>{zh ? "配置名称" : "Server name"}</span>
                  <input
                    className="set-input"
                    aria-label={zh ? "配置名称" : "Server name"}
                    data-market-name
                    value={draft.name}
                    onChange={(event) => patchDraft({ name: event.target.value })}
                  />
                </label>
                <label className="mcp-market-field">
                  <span>{zh ? "连接方式" : "Transport"}</span>
                  <select className="set-select" value={draft.transport} onChange={(event) => patchDraft({ transport: event.target.value as "stdio" | "http" })}>
                    <option value="stdio">stdio</option>
                    <option value="http">HTTP</option>
                  </select>
                </label>
                <label className="mcp-market-field">
                  <span>{zh ? "工具暴露" : "Tool exposure"}</span>
                  <select className="set-select" value={draft.exposure} onChange={(event) => patchDraft({ exposure: event.target.value })}>
                    <option value="codemode">{zh ? "Codemode · 后台连接" : "Codemode · background"}</option>
                    <option value="direct">{zh ? "直接调用" : "Direct"}</option>
                    <option value="deferred">{zh ? "工具搜索" : "Tool search"}</option>
                    <option value="hidden">{zh ? "隐藏" : "Hidden"}</option>
                  </select>
                </label>
              </div>

              {draft.transport === "stdio" ? (
                <>
                  <label className="mcp-market-field">
                    <span>{zh ? "启动命令" : "Command"}</span>
                    <input
                      className="set-input"
                      aria-label={zh ? "启动命令" : "Command"}
                      data-market-command
                      placeholder="npx"
                      value={draft.command}
                      onChange={(event) => patchDraft({ command: event.target.value })}
                    />
                  </label>
                  <label className="mcp-market-field">
                    <span>{zh ? "参数（每行一个）" : "Arguments (one per line)"}</span>
                    <textarea
                      className="set-input mcp-market-args"
                      aria-label={zh ? "参数" : "Arguments"}
                      data-market-args
                      spellCheck={false}
                      value={draft.argsText}
                      onChange={(event) => patchDraft({ argsText: event.target.value })}
                    />
                  </label>
                  <div className="mcp-market-field">
                    <span>{zh ? "环境变量" : "Environment variables"}</span>
                    {draft.env.map((row) => (
                      <div className="mcp-market-row" key={row.id}>
                        <input
                          className="set-input"
                          aria-label="env name"
                          placeholder="API_KEY"
                          value={row.key}
                          onChange={(event) => updateRow("env", row.id, { key: event.target.value })}
                        />
                        <input
                          className="set-input"
                          aria-label="env value"
                          placeholder={zh ? "值或 ${ENV_NAME}" : "value or ${ENV_NAME}"}
                          value={row.value}
                          onChange={(event) => updateRow("env", row.id, { value: event.target.value })}
                        />
                        <button type="button" className="set-iconbtn" title={zh ? "删除" : "Remove"} onClick={() => removeRow("env", row.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button type="button" className="set-btn" onClick={() => addRow("env")}>
                      {zh ? "添加变量" : "Add variable"}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <label className="mcp-market-field">
                    <span>{zh ? "服务器地址" : "Server URL"}</span>
                    <input
                      className="set-input"
                      placeholder="https://example.com/mcp"
                      value={draft.url}
                      onChange={(event) => patchDraft({ url: event.target.value })}
                    />
                  </label>
                  <div className="mcp-market-field">
                    <span>{zh ? "请求头" : "Headers"}</span>
                    {draft.headers.map((row) => (
                      <div className="mcp-market-row" key={row.id}>
                        <input
                          className="set-input"
                          aria-label="header name"
                          placeholder="Authorization"
                          value={row.key}
                          onChange={(event) => updateRow("headers", row.id, { key: event.target.value })}
                        />
                        <input
                          className="set-input"
                          aria-label="header value"
                          placeholder="Bearer ${TOKEN}"
                          value={row.value}
                          onChange={(event) => updateRow("headers", row.id, { value: event.target.value })}
                        />
                        <button type="button" className="set-iconbtn" title={zh ? "删除" : "Remove"} onClick={() => removeRow("headers", row.id)}>
                          ×
                        </button>
                      </div>
                    ))}
                    <button type="button" className="set-btn" onClick={() => addRow("headers")}>
                      {zh ? "添加请求头" : "Add header"}
                    </button>
                  </div>
                </>
              )}

              {nameTaken && (
                <label className="mcp-market-overwrite">
                  <input
                    type="checkbox"
                    data-market-overwrite
                    checked={draft.overwrite}
                    onChange={(event) => patchDraft({ overwrite: event.target.checked })}
                  />
                  <span>{zh ? `覆盖已有的「${draft.name.trim()}」` : `Overwrite the existing "${draft.name.trim()}"`}</span>
                </label>
              )}

              <details className="mcp-market-preview" data-market-preview>
                <summary>{zh ? "预览写入的配置" : "Preview the generated entry"}</summary>
                <pre>{preview}</pre>
              </details>

              {draftError && (
                <div className="set-json-err" role="alert">
                  {draftError}
                </div>
              )}

              <div className="mcp-actions">
                <button type="button" className="set-btn primary" disabled={installing} data-market-submit onClick={() => void install()}>
                  {installing ? <span className="spinner" /> : null}
                  {zh ? "安装到 mcp.json" : "Install into mcp.json"}
                </button>
                <button type="button" className="set-btn" disabled={installing} onClick={closeInstall}>
                  {zh ? "取消" : "Cancel"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
