import { useEffect, useState } from "react";
import type { McpConfig } from "../../../main/mcp-service";
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
  const load = async () => {
    setError(""); setBusy(true);
    try { const r = await window.pi.settings.getMcp(); setConfig(r.config); setPath(r.path); setEditor(JSON.stringify(r.config, null, 2)); }
    catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, []);
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
    setBusy(true); setError("");
    setOutput(kind === "login" ? (zh ? "正在打开浏览器授权页面，请在浏览器中完成登录（最多等待 5 分钟）。" : "Opening authorization in your browser. Complete sign-in there (up to 5 minutes).") : (zh ? "正在连接服务器…" : "Connecting to servers…"));
    try { const r = await window.pi.settings.mcpAction(kind, name); setOutput([r.stdout, r.stderr].filter(Boolean).join("\n")); if (r.code !== 0) setError(zh ? "操作未成功，请查看下方输出。" : "Operation failed. See output below."); }
    catch (e: any) { setError(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return <>
    <div className="set-card">
      <div className="mcp-row"><h3>{zh ? "MCP 服务器" : "MCP servers"}</h3><div className="mcp-actions">
        <button className="set-btn" disabled={busy || editing} onClick={() => action("list")}>{zh ? "检查连接与工具" : "Check connections & tools"}</button>
        <button className="set-btn" disabled={busy} onClick={() => { if (editing) setEditing(false); else { setEditor(JSON.stringify(config, null, 2)); setEditing(true); } }}>{editing ? (zh ? "取消编辑" : "Cancel editing") : (zh ? "添加 / 编辑配置" : "Add / edit config")}</button>
        <button className="set-btn" disabled={busy || editing} onClick={load}>{zh ? "刷新" : "Refresh"}</button>
      </div></div>
      <p className="set-hint">{zh ? "支持 stdio 和 Streamable HTTP。配置与终端 Pi 共享；工具可直接调用，也可通过 Codemode 或工具搜索使用。" : "Supports stdio and Streamable HTTP. Configuration is shared with terminal Pi. Tools support direct calls, Codemode and tool search."}</p>
      {Object.entries(config.mcpServers).map(([name, server]) => <div className="mcp-row" key={name}>
        <div><strong>{name}</strong><div className="set-hint">{String(server.url || server.command || "")} · {String(server.exposure || "codemode")}</div></div>
        <div className="mcp-actions">
          <label><input type="checkbox" checked={server.enabled !== false} disabled={busy || editing} onChange={e => save({ ...config, mcpServers: { ...config.mcpServers, [name]: { ...server, enabled: e.target.checked } } })} /> {zh ? "启用" : "Enabled"}</label>
          {!!server.url && <><button className="set-btn" disabled={busy || editing} onClick={() => action("login", name)}>{zh ? "登录" : "Sign in"}</button><button className="set-btn" disabled={busy || editing} onClick={() => action("logout", name)}>{zh ? "退出登录" : "Sign out"}</button></>}
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
    {output && <div className="set-card"><pre className="mcp-output" role="status">{output}</pre></div>}
  </>;
}
