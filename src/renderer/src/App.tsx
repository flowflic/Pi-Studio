import { useEffect, useState } from "react";
import { useStore } from "./store";
import { usePiEvents } from "./lib/usePiEvents";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Preview } from "./components/Preview";
import { Toasts } from "./components/Toasts";
import { ExtUiModal } from "./components/ExtUiModal";
import { Settings } from "./components/Settings";
import { SearchModal } from "./components/SearchModal";
import { PluginsPanel } from "./components/PluginsPanel";
import { AutomationPanel } from "./components/AutomationPanel";
import { Folder, Plus } from "./components/icons";
import { LanguageBridge } from "./components/LanguageBridge";
import { RemotePanel } from "./components/RemotePanel";
import appIconUrl from "../../../resources/icon.png";

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const activeThreadId = useStore((s) => s.activeThreadId);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const previewOpen = useStore((s) => s.previewOpen);
  const previewExpanded = useStore((s) => s.previewExpanded);
  const projects = useStore((s) => s.projects);
  const runtime = useStore((s) => s.runtime);
  const theme = useStore((s) => s.config?.theme || "light");
  const language = useStore((s) => s.config?.language || "en");
  const [remoteOpen, setRemoteOpen] = useState(false);
  usePiEvents();

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolved = theme === "system" ? (media.matches ? "dark" : "light") : theme;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    if (theme !== "system") return;
    media.addEventListener?.("change", applyTheme);
    return () => media.removeEventListener?.("change", applyTheme);
  }, [theme]);

  // Ctrl/Cmd+K opens the thread search palette
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        useStore.getState().openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const newTask = async () => {
    let cwd: string | null = useStore.getState().activeProjectCwd;
    if (!cwd) {
      const p = await window.pi.app.showOpenDialog("folder");
      if (!p || Array.isArray(p)) return;
      await window.pi.app.openProject(p);
      await useStore.getState().refreshProjects();
      useStore.getState().setActiveProject(p);
      cwd = p;
    }
    if (cwd) await useStore.getState().openThread(cwd);
  };

  return (
    <div className="app">
      <LanguageBridge />
      <TitleBar />
      <div className={`body ${previewExpanded ? "preview-expanded" : ""}`}>
        <Sidebar onOpenRemote={() => setRemoteOpen(true)} remoteOpen={remoteOpen} />
        {activeThreadId ? (
          <Chat />
        ) : (
          <section className="main">
            <div className="empty-state">
              <div>
                <div className="empty-state-app-icon">
                  <img src={appIconUrl} alt="" aria-hidden="true" />
                </div>
                <h2>Pi Studio</h2>
                <p style={{ maxWidth: 420, margin: "0 auto 16px" }}>
                  终端 pi 的 Windows 桌面端：完整继承模型、运行框架与插件系统。左侧选择项目与线程，右侧预览文件。
                </p>
                {!runtime?.ok && runtime && <p style={{ color: "#b23a2c" }}>未检测到 pi：{runtime.error}</p>}
                <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                  <button className="btn primary" onClick={newTask}>
                    <Plus size={14} /> 新建任务
                  </button>
                  <button className="btn" onClick={() => useStore.getState().openProjectFolder()}>
                    <Folder size={14} /> 打开项目文件夹
                  </button>
                </div>
                {projects.length === 0 && <p className="muted" style={{ marginTop: 14 }}>尚未打开任何项目。</p>}
              </div>
            </div>
          </section>
        )}
        {previewOpen && <Preview />}
      </div>
      <Toasts />
      <ExtUiModal />
      <SearchModal />
      <PluginsPanel />
      <AutomationPanel />
      <Settings />
      {remoteOpen && (
        <div className="settings-backdrop" onMouseDown={() => setRemoteOpen(false)}>
          <div className="set-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <section className="set-main" style={{ width: "min(900px, 94vw)" }}>
              <header className="set-head">
                <h2>{language === "zh" ? "Android 手机远程控制" : "Android remote companion"}</h2>
                <button className="set-iconbtn" onClick={() => setRemoteOpen(false)} aria-label={language === "zh" ? "关闭远程设置" : "Close remote settings"}>×</button>
              </header>
              <div className="set-body">
                <RemotePanel language={language} />
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
