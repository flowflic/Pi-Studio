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
      u5();
      u6();
    };
  }, [handleEvent, handleExtUi, handleExit, handleError]);
}
