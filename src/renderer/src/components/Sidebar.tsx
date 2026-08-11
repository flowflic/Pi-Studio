import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useStore } from "../store";
import { fileIcon, formatTokens } from "../lib/format";
import { useOutsideClose } from "../lib/useOutsideClose";
import type { FileNode } from "../lib/types";
import { Plus, Folder, Archive, Star, ChevronRight, Edit, Clock, At, Search, Settings, Help, Refresh, Gauge, Smartphone, Sidebar as SidebarIcon } from "./icons";

const treeKey = (cwd: string, rel?: string) => `${cwd}::${rel || ""}`;
const SIDEBAR_WIDTH_KEY = "pi-studio.sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 286;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 520;
const clampSidebarWidth = (width: number) => Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));

function initialSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function Sidebar({ onOpenRemote, remoteOpen = false }: { onOpenRemote: () => void; remoteOpen?: boolean }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const projects = useStore((s) => s.projects);
  const activeProjectCwd = useStore((s) => s.activeProjectCwd);
  const expandedProjects = useStore((s) => s.expandedProjects);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sidebarTab = useStore((s) => s.sidebarTab);
  const language = useStore((s) => s.config?.language || "en");

  // ids of threads currently streaming, joined into a stable string so this
  // component only re-renders when the running set changes (not on every token).
  const runningKey = useStore((s) =>
    Object.keys(s.threads)
      .filter((id) => s.threads[id].isStreaming)
      .sort()
      .join("\u0000")
  );
  const runningSet = useMemo(() => new Set(runningKey ? runningKey.split("\u0000") : []), [runningKey]);

  // total-usage popover (sidebar footer)
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageData, setUsageData] = useState<any>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [projectMenu, setProjectMenu] = useState<{ cwd: string; name: string; pinned: boolean; x: number; y: number } | null>(null);
  const [threadMenu, setThreadMenu] = useState<{ file: string; name: string; pinned: boolean; x: number; y: number } | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const usageRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const threadMenuRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  useOutsideClose(usageRef, usageOpen, () => setUsageOpen(false));
  useOutsideClose(projectMenuRef, !!projectMenu, () => setProjectMenu(null));
  useOutsideClose(threadMenuRef, !!threadMenu, () => setThreadMenu(null));

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = resizeRef.current;
      if (!drag) return;
      drag.width = clampSidebarWidth(drag.startWidth + event.clientX - drag.startX);
      setSidebarWidth(drag.width);
    };
    const onPointerUp = () => {
      const drag = resizeRef.current;
      if (!drag) return;
      resizeRef.current = null;
      document.body.classList.remove("sidebar-resizing");
      try {
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(drag.width)));
      } catch {
        // A persisted width is convenient, but resizing must still work when
        // storage is unavailable.
      }
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      document.body.classList.remove("sidebar-resizing");
    };
  }, []);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = { startX: event.clientX, startWidth: sidebarWidth, width: sidebarWidth };
    document.body.classList.add("sidebar-resizing");
  };

  const persistSidebarWidth = (width: number) => {
    const next = clampSidebarWidth(width);
    setSidebarWidth(next);
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(next)));
    } catch {
      // See pointer-up persistence note above.
    }
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth - 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      persistSidebarWidth(sidebarWidth + 16);
    } else if (event.key === "Home") {
      event.preventDefault();
      persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
    }
  };

  const loadUsage = async () => {
    setUsageLoading(true);
    try {
      setUsageData(await window.pi.app.getTotalUsage());
    } catch {
      setUsageData(null);
    }
    setUsageLoading(false);
  };
  const toggleUsage = () => {
    const next = !usageOpen;
    setUsageOpen(next);
    if (next) loadUsage();
  };

  const toggleProject = useStore((s) => s.toggleProject);
  const openThread = useStore((s) => s.openThread);
  const goToThread = useStore((s) => s.goToThread);
  const openProjectFolder = useStore((s) => s.openProjectFolder);
  const setProjectPinned = useStore((s) => s.setProjectPinned);
  const unpinProject = useStore((s) => s.unpinProject);
  const setThreadPinned = useStore((s) => s.setThreadPinned);
  const archiveProject = useStore((s) => s.archiveProject);
  const archiveThread = useStore((s) => s.archiveThread);
  const setSidebarTab = useStore((s) => s.setSidebarTab);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  if (!sidebarOpen) return null;

  const newTask = async () => {
    const cwd = useStore.getState().activeProjectCwd;
    if (!cwd) {
      await openProjectFolder();
      return;
    }
    await openThread(cwd);
  };

  const onThreadClick = (cwd: string, file: string) => {
    void goToThread(cwd, file);
  };

  return (
    <aside className="sidebar" style={{ width: sidebarWidth, flexBasis: sidebarWidth }}>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={language === "zh" ? "调整侧边栏宽度" : "Resize sidebar"}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={beginResize}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => persistSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        title={language === "zh" ? "拖动调整侧边栏宽度；双击恢复默认" : "Drag to resize; double-click to reset"}
      />
      <div className="sb-head">
        <button className="sb-head-btn" title="搜索会话与文件" onClick={() => useStore.getState().openSearch()}>
          <Search size={16} />
        </button>
        <button className="sb-head-btn" title="折叠侧栏" aria-label="折叠侧栏" onClick={toggleSidebar}>
          <SidebarIcon size={16} />
        </button>
      </div>
      <div className="sb-scroll">
        <div className="sb-nav">
          <button className="sb-nav-item" onClick={newTask}>
            <span className="ico">
              <Edit size={15} />
            </span>
            新建任务
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openAutomation()}>
            <span className="ico">
              <Clock size={15} />
            </span>
            自动化
          </button>
          <button className="sb-nav-item" onClick={() => useStore.getState().openPlugins()}>
            <span className="ico">
              <At size={15} />
            </span>
            插件
          </button>
        </div>

        <div className="sb-tabs">
          <button className={`sb-tab ${sidebarTab === "threads" ? "active" : ""}`} onClick={() => setSidebarTab("threads")}>
            线程
          </button>
          <button className={`sb-tab ${sidebarTab === "files" ? "active" : ""}`} onClick={() => setSidebarTab("files")}>
            文件
          </button>
        </div>

        {sidebarTab === "threads" ? (
          <>
            <div className="sb-section-head">
              <span>项目</span>
              <button onClick={openProjectFolder} title="Open folder">
                <Plus size={14} />
              </button>
            </div>
            {projects.length === 0 && <div className="ft-empty">尚无项目，点击 + 打开一个文件夹。</div>}
            {projects.map((p) => {
              const open = !!expandedProjects[p.cwd];
              return (
                <div className="project" key={p.cwd}>
                  <div
                    className={`project-head ${open ? "open" : ""}`}
                    onClick={() => toggleProject(p.cwd)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setThreadMenu(null);
                      setProjectMenu({
                        cwd: p.cwd,
                        name: p.name,
                        pinned: !!p.pinned,
                        x: Math.min(event.clientX, window.innerWidth - 190),
                        y: Math.min(event.clientY, window.innerHeight - 70),
                      });
                    }}
                  >
                    <span className="caret">
                      <ChevronRight size={10} />
                    </span>
                    <Folder size={15} />
                    {p.pinned && (
                      <span className="pin-indicator" title={language === "zh" ? "已置顶项目" : "Pinned project"}>
                        <Star size={12} />
                      </span>
                    )}
                    <span className="pname" title={p.cwd}>
                      {p.name}
                    </span>
                    <span className="pcount">{p.threads.length}</span>
                    <button
                      className="pact"
                      title="New thread"
                      onClick={(e) => {
                        e.stopPropagation();
                        openThread(p.cwd);
                      }}
                    >
                      <Plus size={13} />
                    </button>
                    {p.pinned && (
                      <button
                        className="pact"
                        title={language === "zh" ? "取消置顶项目" : "Unpin project"}
                        onClick={(e) => {
                          e.stopPropagation();
                          unpinProject(p.cwd);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="thread-list">
                      {p.threads.length === 0 && <div className="ft-empty">暂无线程</div>}
                      {p.threads.map((t) => {
                        const running = runningSet.has(t.file);
                        const openThread = () => onThreadClick(p.cwd, t.file);
                        return (
                          <div
                            key={t.file}
                            className={`thread ${activeThreadId === t.file ? "active" : ""}`}
                            role="button"
                            tabIndex={0}
                            onClick={openThread}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setProjectMenu(null);
                              setThreadMenu({
                                file: t.file,
                                name: t.title,
                                pinned: !!t.pinned,
                                x: Math.min(event.clientX, window.innerWidth - 190),
                                y: Math.min(event.clientY, window.innerHeight - 70),
                              });
                            }}
                            onKeyDown={(event) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openThread();
                              }
                            }}
                            title={t.title}
                          >
                            <div className="thread-title">
                              {running && <span className="thread-running" />}
                              {t.pinned && (
                                <span className="thread-pin" title={language === "zh" ? "已置顶线程" : "Pinned thread"}>
                                  <Star size={11} />
                                </span>
                              )}
                              <span className="tt-text">{t.title}</span>
                              <button
                                type="button"
                                className="thread-archive-btn"
                                title="归档线程"
                                aria-label={`归档线程：${t.title}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void archiveThread(p.cwd, t.file, t.title);
                                }}
                              >
                                <Archive size={13} />
                              </button>
                            </div>
                            {t.preview && t.preview !== t.title && <div className="thread-preview">{t.preview}</div>}
                            <div className="thread-meta">
                              {t.messageCount} 条 · {new Date(t.updatedAt).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        ) : (
          <FileTreeView cwd={activeProjectCwd} />
        )}
      </div>

      <div className="sb-foot">
        <button className="iconbtn" title="Settings" onClick={() => useStore.getState().openSettings()}>
          <Settings size={15} />
        </button>
        <span className="sb-foot-spacer" aria-hidden="true" />
        <button
          className={`iconbtn ${remoteOpen ? "on" : ""}`}
          title={language === "zh" ? "手机远程控制" : "Phone remote control"}
          aria-label={language === "zh" ? "打开手机远程控制配置" : "Open phone remote control settings"}
          onClick={onOpenRemote}
        >
          <Smartphone size={15} />
        </button>
        <div className="usage-wrap" ref={usageRef}>
          <button className={`iconbtn ${usageOpen ? "on" : ""}`} title="Pi 合计 token 用量" onClick={toggleUsage}>
            <Gauge size={15} />
          </button>
          {usageOpen && (
            <div className="usage-pop">
              <div className="usage-pop-head">
                <span>Pi 合计用量</span>
                <button className="ctx-refresh" title="刷新" onClick={loadUsage}>
                  <Refresh size={12} />
                </button>
              </div>
              {usageLoading ? (
                <div className="ctx-loading">
                  <span className="spinner" />
                </div>
              ) : usageData ? (
                <>
                  <div className="usage-bignum">{formatTokens(usageData.tokens)}</div>
                  <div className="usage-sub">tokens · {usageData.sessions} 个会话</div>
                  {usageData.cost > 0 && <div className="usage-cost">合计 ${usageData.cost.toFixed(4)}</div>}
                </>
              ) : (
                <div className="ctx-empty">暂无用量数据</div>
              )}
            </div>
          )}
        </div>
        <button className="iconbtn" title="Help" onClick={() => useStore.getState().pushToast("info", "Pi Studio · inherits terminal pi")}>
          <Help size={15} />
        </button>
      </div>
      {projectMenu && (
        <div
          ref={projectMenuRef}
          className="project-context-menu"
          style={{ left: projectMenu.x, top: projectMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={projectMenu.cwd}>{projectMenu.name}</div>
          <button
            role="menuitem"
            onClick={() => {
              const item = projectMenu;
              setProjectMenu(null);
              void setProjectPinned(item.cwd, !item.pinned);
            }}
          >
            {projectMenu.pinned
              ? language === "zh"
                ? "取消置顶项目"
                : "Unpin project"
              : language === "zh"
                ? "置顶项目"
                : "Pin project"}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const cwd = projectMenu.cwd;
              setProjectMenu(null);
              archiveProject(cwd);
            }}
          >
            归档项目
          </button>
        </div>
      )}
      {threadMenu && (
        <div
          ref={threadMenuRef}
          className="project-context-menu"
          style={{ left: threadMenu.x, top: threadMenu.y }}
          role="menu"
        >
          <div className="project-context-name" title={threadMenu.file}>{threadMenu.name}</div>
          <button
            role="menuitem"
            onClick={() => {
              const item = threadMenu;
              setThreadMenu(null);
              void setThreadPinned(item.file, !item.pinned);
            }}
          >
            {threadMenu.pinned
              ? language === "zh"
                ? "取消置顶线程"
                : "Unpin thread"
              : language === "zh"
                ? "置顶线程"
                : "Pin thread"}
          </button>
        </div>
      )}
    </aside>
  );
}

function FileTreeView({ cwd }: { cwd: string | null }) {
  const loadFileTree = useStore((s) => s.loadFileTree);
  const fileTree = useStore((s) => s.fileTree);
  useEffect(() => {
    if (cwd && !fileTree[treeKey(cwd, "")]?.loaded) loadFileTree(cwd, "");
  }, [cwd, loadFileTree, fileTree]);
  if (!cwd) return <div className="ft-empty">先在“线程”页打开一个项目。</div>;
  const root = fileTree[treeKey(cwd, "")];
  if (!root?.loaded) return <div className="ft-empty">加载中…</div>;
  return (
    <div className="filetree">
      {root.nodes.map((n) => (
        <FileRow key={n.rel} cwd={cwd} node={n} depth={0} />
      ))}
    </div>
  );
}

function FileRow({ cwd, node, depth }: { cwd: string; node: FileNode; depth: number }) {
  const toggleFolder = useStore((s) => s.toggleFolder);
  const openPreview = useStore((s) => s.openPreview);
  const fileTree = useStore((s) => s.fileTree);
  const previewPath = useStore((s) => s.previewPath);
  const entry = node.isDir ? fileTree[treeKey(cwd, node.rel)] : undefined;
  const expanded = !!entry?.expanded;

  return (
    <>
      <div
        className={`ft-row ${!node.isDir && previewPath === node.abs ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (node.isDir ? toggleFolder(cwd, node.rel) : openPreview(node.abs, cwd))}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void window.pi.app.showFileContextMenu(node.abs);
        }}
        title={node.abs}
      >
        {node.isDir ? (
          <span className="ft-ico" style={{ transform: expanded ? "rotate(90deg)" : "none", display: "inline-block", transition: "transform .12s" }}>
            <ChevronRight size={11} />
          </span>
        ) : (
          <span className="ft-ico">{fileIcon(node.ext, false)}</span>
        )}
        <span className="ft-name">{node.name}</span>
      </div>
      {node.isDir && expanded && entry?.loaded && entry.nodes.map((c) => <FileRow key={c.rel} cwd={cwd} node={c} depth={depth + 1} />)}
    </>
  );
}
