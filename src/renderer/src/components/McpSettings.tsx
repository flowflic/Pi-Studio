import { useEffect, useRef, useState } from "react";
import type { McpConfig } from "../../../main/mcp-service";
import { McpMarketplace } from "./McpMarketplace";
import "./usage-settings.css";

export function McpSettings({ language }: { language: string }) {
  const zh = language === "zh";
  const [config, setConfig] = useState<McpConfig>({ mcpServers: {} });
  const [path, setPath] = useState("");
  const [editor, setEditor] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [codemode, setCodemode] = useState<"on" | "only">("on");
  const [running, setRunning] = useState<{ id: string; kind: string; name?: string } | null>(null);
  const activeRequest = useRef<string | null>(null);
  const load = async () => {
    setError(""); setBusy(true);
    try { const [r, cm] = await Promise.all([window.pi.settings.getMcp(), window.pi.settings.getCodemode()]); setConfig(r.config); setPath(r.path); setEditor(JSON.stringify(r.config, null, 2)); setCodemode(cm.mode); }
    catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    void load();
    const unsubscribe = window.pi.settings.onMcpOutput(({ requestId, text }) => {
      if (requestId === activeRequest.current) setOutput(previous => (previous + text).slice(-64_000));
    });
    return () => { unsubscribe(); if (activeRequest.current) void window.pi.settings.cancelMcpAction(activeRequest.current); activeRequest.current = null; };
  }, []);
  const save = async (value: unknown) => {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await window.pi.settings.saveMcp(value);
      setConfig(result.config); setEditor(JSON.stringify(result.config, null, 2)); setEditing(false);
      setNotice(zh ? "已保存。在聊天中输入 /reload 或重新打开聊天以应用更改。" : "Saved. Run /reload in chat or reopen the chat to apply changes.");
    } catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const action = async (kind: "list" | "login" | "logout", name?: string) => {
    if (activeRequest.current) return;
    const id = crypto.randomUUID(); activeRequest.current = id; setRunning({ id, kind, name }); setError(""); setNotice("");
    setOutput(kind === "login" ? (zh ? "正在打开浏览器授权页面，请在浏览器中完成登录（最多等待 5 分钟）。" : "Opening authorization in your browser. Complete sign-in there (up to 5 minutes).") : (zh ? "正在连接服务器…" : "Connecting to servers…"));
    try {
      const r = await window.pi.settings.mcpAction(kind, name, id);
      if (activeRequest.current !== id) return;
      setOutput([r.stdout, r.stderr].filter(Boolean).join("\n"));
      if (r.cancelled) setNotice(zh ? "已取消操作。" : "Operation cancelled.");
      else if (r.timedOut) setError(zh ? "操作超时，可以重新尝试。" : "Operation timed out. You can retry.");
      else if (r.code !== 0) setError(zh ? "操作未成功，请查看下方输出。" : "Operation failed. See output below.");
      else if (kind !== "list") setNotice(zh ? "登录状态已更新。在聊天中输入 /reload 或重新打开聊天以应用。" : "Authentication updated. Run /reload or reopen the chat to apply.");
    }
    catch (e: any) { if (activeRequest.current === id) setError(e.message || String(e)); }
    finally { if (activeRequest.current === id) { activeRequest.current = null; setRunning(null); } }
  };
  const saveCodemode = async (mode: "on" | "only") => {
    setBusy(true); setError("");
    try { const result = await window.pi.settings.saveCodemode({ mode }); setCodemode(result.mode); setNotice(zh ? "已保存。在聊天中输入 /reload 或重新打开聊天以应用更改。" : "Saved. Run /reload or reopen the chat to apply changes."); }
    catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  const links = [...new Set(output.match(/https?:\/\/[^\s<>\u001b]+/g) || [])];
  return <>
    <div className="set-card">
      <div className="mcp-row"><h3>{zh ? "Codemode 精简" : "Compact Codemode"}</h3>
        <select className="set-select" aria-label={zh ? "Codemode 模式" : "Codemode mode"} value={codemode} disabled={busy} onChange={event => void saveCodemode(event.target.value as "on" | "only")}>
          <option value="on">{zh ? "标准：工具可直接调用" : "Standard: direct tools available"}</option>
          <option value="only">{zh ? "精简：通过 Codemode 调用工具" : "Compact: call tools through Codemode"}</option>
        </select>
      </div>
      <p className="set-hint">{zh ? "精简模式将工具入口合并到 Codemode，减少发送给模型的工具定义；模型可按需搜索工具。需要 Pi 核心 1.1.0。" : "Compact mode routes tools through Codemode, reducing tool definitions sent to the model. Tools can be discovered on demand. Requires Pi core 1.1.0."}</p>
    </div>
    <McpMarketplace
      language={zh ? "zh" : "en"}
      existingNames={Object.keys(config.mcpServers)}
      onInstalled={({ config: next }) => {
        // The marketplace panel reports the install inline; just keep the
        // server list and raw editor in sync.
        setConfig(next);
        setEditor(JSON.stringify(next, null, 2));
      }}
    />
    <div className="set-card">
      <div className="mcp-row"><h3>{zh ? "MCP 服务器" : "MCP servers"}</h3><div className="mcp-actions">
        <button className="set-btn" disabled={busy || editing || !!running} onClick={() => action("list")}>{zh ? "检查连接与工具" : "Check connections & tools"}</button>
        <button className="set-btn" disabled={busy} onClick={() => { if (editing) setEditing(false); else { setEditor(JSON.stringify(config, null, 2)); setEditing(true); } }}>{editing ? (zh ? "取消编辑" : "Cancel editing") : (zh ? "添加 / 编辑配置" : "Add / edit config")}</button>
        <button className="set-btn" disabled={busy || editing} onClick={load}>{zh ? "刷新" : "Refresh"}</button>
      </div></div>
      <p className="set-hint">{zh ? "Codemode 服务器在聊天启动时后台连接，首次提问无需等待；调用工具时等待连接就绪。直接调用的服务器需要先连接。支持 stdio 和 Streamable HTTP，配置与终端 Pi 共享。" : "Codemode servers connect in the background without blocking the first prompt; tool calls wait for the connection. Direct servers connect before prompting. Supports stdio and Streamable HTTP; configuration is shared with terminal Pi."}</p>
      {Object.entries(config.mcpServers).map(([name, server]) => <div className="mcp-row" key={name}>
        <div><strong>{name}</strong><div className="set-hint">{String(server.url || server.command || "")} · {String(server.exposure || "codemode")}</div></div>
        <div className="mcp-actions">
          <label><input type="checkbox" checked={server.enabled !== false} disabled={busy || editing} onChange={e => save({ ...config, mcpServers: { ...config.mcpServers, [name]: { ...server, enabled: e.target.checked } } })} /> {zh ? "启用" : "Enabled"}</label>
          <select className="set-select" aria-label={`${name} ${zh ? "工具调用方式" : "tool exposure"}`} value={String(server.exposure || "codemode")} disabled={busy || editing} onChange={e => void save({ ...config, mcpServers: { ...config.mcpServers, [name]: { ...server, exposure: e.target.value } } })}>
            <option value="codemode">{zh ? "Codemode · 后台连接" : "Codemode · background"}</option><option value="direct">{zh ? "直接调用 · 等待连接" : "Direct · wait for connection"}</option><option value="deferred">{zh ? "工具搜索" : "Tool search"}</option><option value="hidden">{zh ? "隐藏" : "Hidden"}</option><option value="codemode-deferred">{zh ? "Codemode（兼容）" : "Codemode (legacy)"}</option>
          </select>
          {!!server.url && <><button className="set-btn" disabled={busy || editing || !!running} onClick={() => action("login", name)}>{zh ? "登录" : "Sign in"}</button><button className="set-btn" disabled={busy || editing || !!running} onClick={() => action("logout", name)}>{zh ? "退出登录" : "Sign out"}</button></>}
          <button className="set-btn" disabled={busy || editing} onClick={() => { const next = { ...config.mcpServers }; delete next[name]; void save({ ...config, mcpServers: next }); }}>{zh ? "移除" : "Remove"}</button>
        </div>
      </div>)}
      {!Object.keys(config.mcpServers).length && <p className="muted">{zh ? "暂无 MCP 服务器。添加配置后检查连接。" : "No MCP servers. Add configuration, then check connections."}</p>}
      {editing && <>
        <textarea className="set-json mcp-editor" aria-label="MCP JSON" spellCheck={false} value={editor} onChange={e => setEditor(e.target.value)} />
        <div className="mcp-actions"><button className="set-btn primary" disabled={busy} onClick={() => { try { void save(JSON.parse(editor)); } catch (e: any) { setError(e.message); } }}>{zh ? "保存配置" : "Save configuration"}</button>
          <button className="set-btn" onClick={() => setEditor(JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, example: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], enabled: false, exposure: "codemode" } } }, null, 2))}>{zh ? "插入 stdio 示例" : "Insert stdio example"}</button>
          <button className="set-btn" onClick={() => setEditor(JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, example: { url: "https://example.com/mcp", enabled: false, exposure: "direct" } } }, null, 2))}>{zh ? "插入 HTTP 示例" : "Insert HTTP example"}</button></div>
        <p className="set-hint">{zh ? "可粘贴 Claude / Cursor 等客户端的 mcpServers 配置。env 和 headers 支持 ${环境变量名}。示例默认禁用，替换为实际服务器后再启用。" : "Paste mcpServers JSON from Claude or Cursor. env and headers accept ${ENV_NAME}. Examples are disabled until configured."}</p>
      </>}
      <p className="set-hint">{path}</p>
    </div>
    {error && <div className="set-json-err" role="alert">{error}</div>}
    {notice && <p role="status">{notice}</p>}
    {(output || running) && <div className="set-card">
      {running && <div className="mcp-row"><span role="status">{running.name || "MCP"} · {zh ? "操作进行中…" : "Operation in progress…"}</span><button className="set-btn" onClick={() => void window.pi.settings.cancelMcpAction(running.id)}>{zh ? "取消操作" : "Cancel operation"}</button></div>}
      {running?.kind === "login" && links.map(url => <p key={url}><a href={url} target="_blank" rel="noreferrer">{zh ? "打开授权链接" : "Open authorization link"}</a></p>)}
      <pre className="mcp-output" role="status">{output}</pre>
    </div>}
  </>;
}
