import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SkillHubSkill } from "../renderer/src/lib/types";

/**
 * The renderer talks to the main process exclusively through this surface.
 * Keep it narrow and typed; the matching declaration lives in index.d.ts.
 */

type Unsub = () => void;
function on(channel: string, cb: (payload: any) => void): Unsub {
  const listener = (_e: IpcRendererEvent, payload: any) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const api = {
  app: {
    getVersion: () => ipcRenderer.invoke("app:getVersion"),
    getConfig: () => ipcRenderer.invoke("app:getConfig"),
    setConfig: (patch: Record<string, unknown>) => ipcRenderer.invoke("app:setConfig", patch),
    resolveRuntime: () => ipcRenderer.invoke("app:resolveRuntime"),
    getProjects: () => ipcRenderer.invoke("app:getProjects"),
    searchThreads: (query: string) => ipcRenderer.invoke("app:searchThreads", query),
    getTotalUsage: () => ipcRenderer.invoke("app:getTotalUsage"),
    openProject: (absPath: string) => ipcRenderer.invoke("app:openProject", absPath),
    prewarm: (cwd: string) => ipcRenderer.invoke("app:prewarm", cwd),
    unpinProject: (absPath: string) => ipcRenderer.invoke("app:unpinProject", absPath),
    setProjectPinned: (args: { cwd: string; pinned: boolean }) => ipcRenderer.invoke("app:setProjectPinned", args),
    setThreadPinned: (args: { file: string; pinned: boolean }) => ipcRenderer.invoke("app:setThreadPinned", args),
    showOpenDialog: (kind: "folder" | "file" | "files") => ipcRenderer.invoke("app:showOpenDialog", kind),
    getFileTree: (cwd: string, rel?: string) => ipcRenderer.invoke("app:getFileTree", cwd, rel),
    fileExists: (absPath: string) => ipcRenderer.invoke("app:fileExists", absPath),
    readPreview: (absPath: string, projectRoot?: string) => ipcRenderer.invoke("app:readPreview", absPath, projectRoot),
    showFileContextMenu: (absPath: string) => ipcRenderer.invoke("app:showFileContextMenu", absPath),
    updatePi: () => ipcRenderer.invoke("app:updatePi"),
    checkAppUpdate: () => ipcRenderer.invoke("app:checkAppUpdate"),
    downloadAppUpdate: () => ipcRenderer.invoke("app:downloadAppUpdate"),
    installAppUpdate: () => ipcRenderer.invoke("app:installAppUpdate"),
    checkCoreUpdate: () => ipcRenderer.invoke("app:checkCoreUpdate"),
    relaunch: () => ipcRenderer.invoke("app:relaunch"),
    editAction: (action: "copy" | "cut" | "paste" | "delete" | "selectAll") => ipcRenderer.invoke("app:editAction", action),
  },
  plugins: {
    getPackages: () => ipcRenderer.invoke("plugins:getPackages"),
    setPackageEnabled: (source: string, enabled: boolean) => ipcRenderer.invoke("plugins:setPackageEnabled", { source, enabled }),
    installPackage: (source: string) => ipcRenderer.invoke("plugins:installPackage", source),
    removePackage: (source: string) => ipcRenderer.invoke("plugins:removePackage", source),
    getSkills: (cwd?: string) => ipcRenderer.invoke("plugins:getSkills", cwd),
    setSkillEnabled: (path: string, enabled: boolean) => ipcRenderer.invoke("plugins:setSkillEnabled", { path, enabled }),
    updatePackages: (source?: string) => ipcRenderer.invoke("plugins:updatePackages", source),
    getSkillsHubLeaderboard: () => ipcRenderer.invoke("skillsHub:leaderboard"),
    searchSkillsHub: (query: string) => ipcRenderer.invoke("skillsHub:search", query),
    getSkillDetails: (skill: SkillHubSkill) => ipcRenderer.invoke("skillsHub:detail", skill),
    installSkill: (args: { source: string; skillId: string }) => ipcRenderer.invoke("skillsHub:install", args),
  },
  automation: {
    getTasks: () => ipcRenderer.invoke("automation:getTasks"),
    saveTask: (task: unknown) => ipcRenderer.invoke("automation:saveTask", task),
    deleteTask: (id: string) => ipcRenderer.invoke("automation:deleteTask", id),
    runNow: (id: string) => ipcRenderer.invoke("automation:runNow", id),
  },
  remote: {
    getStatus: () => ipcRenderer.invoke("remote:getStatus"),
    createPairing: () => ipcRenderer.invoke("remote:createPairing"),
    enableSignaling: (manual = false) => ipcRenderer.invoke("remote:enableSignaling", { manual }),
    disableSignaling: () => ipcRenderer.invoke("remote:disableSignaling"),
    approvePairing: (connectionId: string) => ipcRenderer.invoke("remote:approvePairing", connectionId),
    rejectPairing: (connectionId: string) => ipcRenderer.invoke("remote:rejectPairing", connectionId),
    revokeDevice: (deviceId: string) => ipcRenderer.invoke("remote:revokeDevice", deviceId),
    getTransportConfig: () => ipcRenderer.invoke("remote:getTransportConfig"),
    setConfig: (patch: { signalingUrl?: string }) => ipcRenderer.invoke("remote:setConfig", patch),
    transportOpen: (args: { connectionId: string; sessionId?: string }) => ipcRenderer.invoke("remote:transportOpen", args),
    transportClose: (args: { connectionId: string; reason?: string }) => ipcRenderer.invoke("remote:transportClose", args),
    transportStatus: (args: { connectionId: string; state?: string; candidateType?: string; localCandidateType?: string; remoteCandidateType?: string }) =>
      ipcRenderer.invoke("remote:transportStatus", args),
    transportFrame: (args: { connectionId: string; frame: string }) => ipcRenderer.invoke("remote:transportFrame", args),
    sendSignal: (args: { connectionId: string; payload: Record<string, unknown> }) => ipcRenderer.invoke("remote:sendSignal", args),
    onSignal: (cb: (p: { connectionId: string; message: any }) => void) => on("remote:signal", cb),
    onOutbound: (cb: (p: { connectionId: string; frame: string }) => void) => on("remote:outbound", cb),
    onPairingRequest: (cb: (p: { connectionId: string; deviceId: string; deviceName: string }) => void) => on("remote:pairing-request", cb),
  },
  thread: {
    open: (args: { cwd: string; sessionFile?: string; name?: string; permission?: "sandbox" | "full" }) => ipcRenderer.invoke("thread:open", args),
    loadHistory: (args: { cwd: string; sessionFile: string }) => ipcRenderer.invoke("thread:loadHistory", args),
    close: (threadId: string) => ipcRenderer.invoke("thread:close", threadId),
    prompt: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:prompt", args),
    steer: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:steer", args),
    followUp: (args: { threadId: string; text: string; images?: unknown[]; attachments?: { abs: string; name: string }[] }) =>
      ipcRenderer.invoke("thread:followUp", args),
    abort: (threadId: string) => ipcRenderer.invoke("thread:abort", threadId),
    setModel: (args: { threadId: string; provider: string; modelId: string }) => ipcRenderer.invoke("thread:setModel", args),
    getModels: (threadId: string) => ipcRenderer.invoke("thread:getModels", threadId),
    refreshModels: (threadId: string) => ipcRenderer.invoke("thread:refreshModels", threadId),
    setThinking: (args: { threadId: string; level: string }) => ipcRenderer.invoke("thread:setThinking", args),
    getThinkingLevels: (threadId: string) => ipcRenderer.invoke("thread:getThinkingLevels", threadId),
    newSession: (threadId: string) => ipcRenderer.invoke("thread:newSession", threadId),
    getBranchMessages: (threadId: string) => ipcRenderer.invoke("thread:getBranchMessages", threadId),
    fork: (args: { threadId: string; entryId: string }) => ipcRenderer.invoke("thread:fork", args),
    clone: (args: { threadId: string; entryId: string }) => ipcRenderer.invoke("thread:clone", args),
    setName: (args: { threadId: string; name: string }) => ipcRenderer.invoke("thread:setName", args),
    getStats: (threadId: string) => ipcRenderer.invoke("thread:getStats", threadId),
    getCommands: (threadId: string) => ipcRenderer.invoke("thread:getCommands", threadId),
    extuiResponse: (args: { threadId: string; id: string; payload: Record<string, unknown> }) =>
      ipcRenderer.invoke("thread:extuiResponse", args),
    setPermission: (args: { threadId: string; permission: "sandbox" | "full" }) => ipcRenderer.invoke("thread:setPermission", args),
  },
  settings: {
    getModels: () => ipcRenderer.invoke("settings:getModels"),
    testModel: (args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      ipcRenderer.invoke("settings:testModel", args),
    saveModels: (providers: Record<string, unknown>) => ipcRenderer.invoke("settings:saveModels", providers),
    getThinking: () => ipcRenderer.invoke("settings:getThinking"),
    saveThinking: (patch: Record<string, unknown>) => ipcRenderer.invoke("settings:saveThinking", patch),
    getDiagnostics: () => ipcRenderer.invoke("settings:getDiagnostics"),
    getPaths: () => ipcRenderer.invoke("settings:getPaths"),
    openPath: (abs: string) => ipcRenderer.invoke("settings:openPath", abs),
    showItem: (abs: string) => ipcRenderer.invoke("settings:showItem", abs),
    openAgentDir: () => ipcRenderer.invoke("settings:openAgentDir"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    maximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizedChanged: (cb: (max: boolean) => void) => on("window:maximized-changed", cb),
  },
  on: {
    event: (cb: (p: { threadId: string; event: any }) => void) => on("pi:event", cb),
    extui: (cb: (p: { threadId: string; request: any }) => void) => on("pi:extui", cb),
    exit: (cb: (p: { threadId: string; code: number | null; signal: string | null; stderr: string }) => void) => on("pi:exit", cb),
    error: (cb: (p: { threadId: string; message: string }) => void) => on("pi:error", cb),
    focusThread: (cb: (p: { threadId: string }) => void) => on("app:focus-thread", cb),
    automation: (cb: (p: { type: "start" | "done"; taskId: string; name: string; ok?: boolean; error?: string }) => void) =>
      on("pi:automation", cb),
    projectsChanged: (cb: (p: { cwd?: string; sessionFile?: string }) => void) => on("pi:projects-changed", cb),
    appUpdate: (cb: (p: { stage: string; message: string; pct?: number }) => void) => on("pi:appUpdate", cb),
    coreUpdate: (cb: (p: { stage: string; message: string; pct?: number }) => void) => on("pi:coreUpdate", cb),
  },
};

contextBridge.exposeInMainWorld("pi", api);

export type PiApi = typeof api;
