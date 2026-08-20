import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { modelShort } from "../lib/format";
import { Minus, Square, Close, Maximize, Contract, Sidebar, Settings as SettingsIcon } from "./icons";
import appIconUrl from "../../../../resources/icon.png";

type MenuId = "file" | "edit" | "view" | "help";

interface MenuItem {
  label: string;
  onClick?: () => void;
  sep?: boolean;
}

export function TitleBar() {
  const activeThreadId = useStore((s) => s.activeThreadId);
  const threads = useStore((s) => s.threads);
  const runtime = useStore((s) => s.runtime);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const togglePreview = useStore((s) => s.togglePreview);
  const togglePreviewExpanded = useStore((s) => s.togglePreviewExpanded);
  const openSettings = useStore((s) => s.openSettings);
  const previewExpanded = useStore((s) => s.previewExpanded);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const language = useStore((s) => s.config?.language || "en");

  const [menu, setMenu] = useState<MenuId | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u = window.pi.window.onMaximizedChanged(setMax);
    window.pi.window.isMaximized().then(setMax).catch(() => {});
    return u;
  }, []);

  const [max, setMax] = useState(false);

  // close dropdown on outside click
  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const st = () => useStore.getState();
  const act = (fn: () => void) => () => {
    setMenu(null);
    fn();
  };

  const MENUS: { id: MenuId; label: string; items: MenuItem[] }[] = [
    {
      id: "file",
      label: "文件",
      items: [
        { label: "新建对话", onClick: act(() => st().newTask()) },
        { label: "打开文件夹…", onClick: act(() => st().openProjectFolder()) },
      ],
    },
    {
      id: "edit",
      label: "编辑",
      items: [
        { label: "复制", onClick: act(() => st().editAction("copy")) },
        { label: "剪切", onClick: act(() => st().editAction("cut")) },
        { label: "粘贴", onClick: act(() => st().editAction("paste")) },
        { label: "删除", onClick: act(() => st().editAction("delete")) },
        { label: "", sep: true },
        { label: "进入设置…", onClick: act(() => st().openSettings()) },
      ],
    },
    {
      id: "view",
      label: "视图",
      items: [
        { label: sidebarOpen ? "折叠侧栏" : "展开侧栏", onClick: act(toggleSidebar) },
        { label: "切换预览面板", onClick: act(togglePreview) },
      ],
    },
    {
      id: "help",
      label: "帮助",
      items: [{ label: "关于 Pi Studio", onClick: act(() => st().pushToast("info", "Pi Studio · 终端 pi 的 Windows 桌面端")) }],
    },
  ];

  const active = activeThreadId ? threads[activeThreadId] : null;
  const activeName = active
    ? active.sessionName || active.cwd.split(/[\\/]/).filter(Boolean).pop() || active.cwd
    : "";
  const status = active
    ? `${activeName} · ${
        active.error
          ? language === "zh" ? "连接失败" : "connection failed"
          : active.connected
            ? active.model
              ? modelShort(active.model)
              : language === "zh" ? "就绪" : "ready"
            : language === "zh" ? "连接中…" : "connecting…"
      }`
    : runtime?.ok
      ? language === "zh" ? "Pi 已就绪" : "Pi ready"
      : runtime
        ? language === "zh" ? "Pi 不可用" : "Pi unavailable"
        : "Pi Studio";
  const statusTitle = active?.error || runtime?.error || status;

  return (
    <div className="titlebar">
      <button
        className="tb-sidebar-toggle"
        onClick={toggleSidebar}
        title={sidebarOpen ? "折叠侧栏" : "展开侧栏"}
        aria-label={sidebarOpen ? "折叠侧栏" : "展开侧栏"}
      >
        <Sidebar size={16} />
      </button>
      <div className="tb-brand">
        <img className="tb-brand-icon" src={appIconUrl} alt="" aria-hidden="true" />
        Pi Studio
      </div>
      <div className="tb-menu" ref={menuRef}>
        {MENUS.map((m) => (
          <div className="tb-menu-wrap" key={m.id}>
            <button className={`tb-menu-btn ${menu === m.id ? "open" : ""}`} onClick={() => setMenu((cur) => (cur === m.id ? null : m.id))}>
              {m.label}
            </button>
            {menu === m.id && (
              <div className="tb-dropdown">
                {m.items.map((it, i) =>
                  it.sep ? (
                    <div className="tb-dd-sep" key={i} />
                  ) : (
                    <button className="tb-dd-item" key={i} onClick={it.onClick}>
                      {it.label}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="tb-spacer" />
      <div className="tb-status" title={statusTitle}>
        {status}
      </div>
      <button className="tb-settings-btn" onClick={openSettings} title={language === "zh" ? "设置" : "Settings"} aria-label={language === "zh" ? "设置" : "Settings"}>
        <SettingsIcon size={15} />
      </button>
      <div className="tb-win">
        <button
          className={`tb-win-btn ${previewExpanded ? "tb-preview-restore" : ""}`}
          onClick={() => (previewExpanded ? togglePreviewExpanded() : togglePreview())}
          title={previewExpanded ? (language === "zh" ? "收回侧边栏预览" : "Restore side preview") : language === "zh" ? "切换预览" : "Toggle preview"}
          aria-label={previewExpanded ? (language === "zh" ? "收回侧边栏预览" : "Restore side preview") : language === "zh" ? "切换预览" : "Toggle preview"}
        >
          {previewExpanded ? <Contract size={14} /> : <Maximize size={14} />}
        </button>
        <button className="tb-win-btn" onClick={() => window.pi.window.minimize()} title={language === "zh" ? "最小化" : "Minimize"} aria-label={language === "zh" ? "最小化" : "Minimize"}>
          <Minus size={14} />
        </button>
        <button className="tb-win-btn" onClick={() => window.pi.window.maximize()} title={language === "zh" ? "最大化" : "Maximize"} aria-label={language === "zh" ? "最大化" : "Maximize"}>
          <Square size={12} />
        </button>
        <button className="tb-win-btn close" onClick={() => window.pi.window.close()} title={language === "zh" ? "关闭" : "Close"} aria-label={language === "zh" ? "关闭" : "Close"}>
          <Close size={14} />
        </button>
      </div>
    </div>
  );
}
