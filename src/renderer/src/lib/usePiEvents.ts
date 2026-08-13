import { useEffect } from "react";
import { useStore } from "../store";

/**
 * Subscribes to the main-process push channels exactly once at the app root.
 * Events are fanned into the zustand store by threadId.
 */
export function usePiEvents() {
  const handleEvent = useStore((s) => s.handleEvent);
  const handleExtUi = useStore((s) => s.handleExtUi);
  const handleExit = useStore((s) => s.handleExit);
  const handleError = useStore((s) => s.handleError);

  useEffect(() => {
    const u1 = window.pi.on.event((p) => handleEvent(p.threadId, p.event));
    const u2 = window.pi.on.extui((p) => handleExtUi(p.threadId, p.request));
    const u3 = window.pi.on.exit((p) => handleExit(p.threadId, p));
    const u4 = window.pi.on.error((p) => handleError(p.threadId, p.message));
    const u7 = window.pi.on.focusThread((p) => {
      const threadId = typeof p?.threadId === "string" ? p.threadId : "";
      if (!threadId) return;
      const focus = () => {
        const state = useStore.getState();
        if (state.threads[threadId]) {
          state.setActiveThread(threadId);
          return true;
        }
        const target = state.projects
          .map((project) => ({ project, thread: project.threads.find((item) => item.file.toLowerCase() === threadId.toLowerCase()) }))
          .find((item) => !!item.thread);
        if (!target?.thread) return false;
        void state.goToThread(target.project.cwd, target.thread.file);
        return true;
      };
      if (!focus()) void useStore.getState().refreshProjects().then(focus);
    });
    const u5 = window.pi.on.automation((p) => {
      const st = useStore.getState();
      if (p.type === "done") {
        st.refreshProjects();
        st.loadTasks();
        if (p.ok) st.pushToast("info", `自动化任务完成：${p.name}`);
        else st.pushToast("error", `自动化任务失败：${p.name}${p.error ? " · " + p.error : ""}`);
      }
    });
    const u6 = window.pi.on.projectsChanged(() => {
      void useStore.getState().refreshProjects();
    });
    return () => {
      u1();
      u2();
      u3();
      u4();
      u7();
      u5();
      u6();
    };
  }, [handleEvent, handleExtUi, handleExit, handleError]);
}
