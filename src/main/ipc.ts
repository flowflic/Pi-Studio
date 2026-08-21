import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { checkForAppUpdate, downloadAppUpdate, installAppUpdate } from "./app-updater";
import { checkForCoreUpdate, installCoreUpdate } from "./core-updater";
import {
  BUILT_IN_REMOTE_STUN_URLS,
  DEFAULT_REMOTE_SIGNALING_URL,
  getConfig,
  getConfigDir,
  reloadConfig,
  updateConfig,
  type AutomationTask,
} from "./config";
import { listDir } from "./fs-service";
import { createHtmlPreviewUrl } from "./html-preview-protocol";
import {
  getAuthPath,
  getDiagnostics,
  getModelsPath,
  getSettingsPath,
  readModelsFile,
  readThinking,
  testModelAvailability,
  writeModelsProviders,
  writeThinking,
} from "./models-service";
import { PiBridge, isAppManagedRuntime, resetPiRuntime, resolvePiRuntime, runtimeKind } from "./pi-bridge";
import { createGateModeFile, ensureGateExtension, removeGateModeFile, writeGateMode } from "./permission-gate";
import { readPreview, readRemotePreview, writePreviewHtml } from "./preview-service";
import { getAgentDir, getSessionsDir, getTotalUsage, type ProjectSummary, readThreadHistory, scanProjects, searchThreads, type ThreadSearchHit } from "./session-store";
import {
  getAdditionalSkillPaths,
  getSkillCommands,
  listPackages,
  listManagedSkills,
  listSkills,
  probePiStartup,
  removePackageEntry,
  runPiCli,
  setPackageEnabled,
  setSkillEnabled,
} from "./plugins";
import { getSkillDetails, getSkillsHubLeaderboard, installSkillFromHub, searchSkillsHub } from "./skills-hub";
import { removeAutomationTask, runTaskNow, startScheduler } from "./automation";
import { loadOrCreateIdentity, opaqueId } from "./remote/identity";
import { RemoteHost } from "./remote/host";
import { FilePreviewService, ProjectService, RemoteEventHub, ThreadService } from "./remote/services";
import { RemoteService, type RemoteBackend } from "./remote/service";
import {
  createSystemNotificationCenter,
  isSandboxApprovalRequest,
  sandboxOperationFromTitle,
  type SystemNotificationCenter,
} from "./system-notifications";
import {
  RemoteProtocolError,
  type RemoteFileArtifact,
  type RemoteMessage,
  type RemoteModelOption,
  type RemoteProject,
  type RemoteSkill,
  type RemoteThreadEventPayload,
  type RemoteThreadSnapshot,
  type RemoteThreadState,
} from "./remote/protocol";

type PermissionLevel = "sandbox" | "full";

/**
 * Wires the renderer's window.pi.* calls to main-process services and to the
 * per-thread pi RPC bridges. Agent events and extension-UI requests are pushed
 * back to the renderer as `pi:event` / `pi:extui` / `pi:exit` / `pi:error`.
 *
 * The bridge registry stores the *handle* (not just the bridge) so that when a
 * session file path changes (new session / fork) we can re-key the map AND the
 * closure id used for event routing in one step.
 */

interface BridgeHandle {
  bridge: PiBridge;
  getId: () => string;
  setId: (n: string) => void;
  permission: PermissionLevel;
  gateModeFile: string;
}

const bridges = new Map<string, BridgeHandle>();
let systemNotifications: SystemNotificationCenter | null = null;
let activeRemoteHost: RemoteHost | null = null;

// Opening a folder makes it available for the current workspace session, but
// it must not silently become a persisted pinned project. Keep empty folders
// visible until they have a session on disk; explicit pinning still goes
// through app:setProjectPinned and remains persisted in the config.
const openedProjects = new Map<string, ProjectSummary>();
let openedProjectOrder: string[] = [];

const IMG_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};
const TEXT_ATTACH_EXTS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv", ".log", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".css",
  ".scss", ".html", ".htm", ".py", ".go", ".rs", ".java", ".sh", ".bash", ".sql",
  ".env", ".ini", ".cfg", ".conf", ".vue", ".svelte",
]);

interface Attachment {
  abs: string;
  name: string;
}

const CLIPBOARD_FILE_MAX_BYTES = 50_000_000;
const CLIPBOARD_FILE_DIR = "pi-studio-clipboard";
const CLIPBOARD_MIME_EXT: Record<string, string> = {
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
};

function stageClipboardFile(args: { name?: string; mimeType?: string; data?: string }): { abs: string; name: string; size: number } {
  const encoded = typeof args?.data === "string" ? args.data : "";
  if (!encoded) throw new Error("Clipboard file is empty");
  if (encoded.length > Math.ceil(CLIPBOARD_FILE_MAX_BYTES * 4 / 3) + 16) {
    throw new Error("Clipboard file is too large (maximum 50 MB)");
  }

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new Error("Clipboard file is empty");
  if (bytes.length > CLIPBOARD_FILE_MAX_BYTES) throw new Error("Clipboard file is too large (maximum 50 MB)");

  const rawName = basename(String(args?.name || "pasted-file"))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  let name = (rawName || "pasted-file").slice(0, 180);
  if (!extname(name)) name += CLIPBOARD_MIME_EXT[String(args?.mimeType || "").toLowerCase()] || ".bin";

  const directory = join(app.getPath("temp"), CLIPBOARD_FILE_DIR);
  mkdirSync(directory, { recursive: true });
  const abs = join(directory, `${randomUUID()}-${name}`);
  writeFileSync(abs, bytes, { flag: "wx" });
  return { abs, name, size: bytes.length };
}

function sameSessionFile(left: string, right: string): boolean {
  if (!left || !right) return false;
  try {
    const a = resolve(left);
    const b = resolve(right);
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return left === right;
  }
}

/** Only the session store may be permanently modified from the delete action. */
function assertDeletableSessionFile(file: string): string {
  const requested = file.trim();
  if (!requested || !isAbsolute(requested) || extname(requested).toLowerCase() !== ".jsonl") {
    throw new Error("A session JSONL path is required");
  }

  let storeRoot: string;
  let target: string;
  try {
    storeRoot = realpathSync(resolve(getSessionsDir()));
    target = resolve(requested);
  } catch {
    throw new Error("Thread session file not found");
  }

  const assertInsideStore = (candidate: string) => {
    const rel = relative(storeRoot, candidate);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error("Thread session path is outside the session store");
    }
  };

  assertInsideStore(target);
  if (!existsSync(target) || !statSync(target).isFile()) throw new Error("Thread session file not found");

  // Resolve symlinks before deleting so a link inside the session store cannot
  // redirect the destructive operation elsewhere.
  const realTarget = realpathSync(target);
  assertInsideStore(realTarget);
  if (extname(realTarget).toLowerCase() !== ".jsonl") throw new Error("Only JSONL session files can be deleted");
  return realTarget;
}

async function unlinkSessionWithRetry(file: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await unlink(file);
      return;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      lastError = error;
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || attempt === 4) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * (attempt + 1)));
    }
  }
  throw lastError || new Error("Could not delete thread session file");
}

function processAttachments(attachments: Attachment[] | undefined, text: string): { text: string; images: unknown[] } {
  const images: unknown[] = [];
  let extra = "";
  if (attachments && attachments.length) {
    for (const a of attachments) {
      const ext = extname(a.name || a.abs).toLowerCase();
      try {
        if (ext in IMG_MIME) {
          const buf = readFileSync(a.abs);
          images.push({ type: "image", data: buf.toString("base64"), mimeType: IMG_MIME[ext] });
          continue;
        }
        if (TEXT_ATTACH_EXTS.has(ext) || ext === "") {
          const st = statSync(a.abs);
          if (st.size <= 500_000) {
            const content = readFileSync(a.abs, "utf8");
            extra += `\n\n<file name="${a.name}" path="${a.abs}">\n${content}\n</file>`;
            continue;
          }
        }
        extra += `\n\n<file name="${a.name}" path="${a.abs}" note="attached (binary or large; not inlined)" />`;
      } catch (e: any) {
        extra += `\n\n<file name="${a.name}" path="${a.abs}" error="${e?.message || "read failed"}" />`;
      }
    }
  }
  return { text: text + extra, images };
}

function agentContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => (block?.type === "text" ? String(block.text || "") : ""))
    .filter(Boolean)
    .join("\n");
}

function finalAssistantReply(message: any): { text: string } | null {
  if (!message || message.role !== "assistant") return null;
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : "";
  if (stopReason === "error" || stopReason === "aborted") return null;
  if (Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall")) return null;
  return { text: agentContentText(message.content) };
}

function createHandle(
  cwd: string,
  sessionFile: string | undefined,
  name: string | undefined,
  permission: PermissionLevel,
  send: (ch: string, p: unknown) => void,
): BridgeHandle {
  let id = sessionFile || `boot:${randomUUID()}`;
  const gateModeFile = createGateModeFile(getConfigDir(), permission);
  let turnStarted = false;
  let promptForNotification = name || "";
  let completedReply: { text: string } | null = null;
  const handle: BridgeHandle = {
    bridge: null as unknown as PiBridge,
    getId: () => id,
    setId: (n: string) => {
      if (n && n !== id) {
        bridges.delete(id);
        id = n;
        bridges.set(n, handle);
      }
    },
    permission,
    gateModeFile,
  };
  handle.bridge = new PiBridge({
    cwd,
    piCliPath: getConfig().piCliPath,
    sessionFile,
    name,
    // The gate extension is always loaded; its sandbox/full behaviour is decided
    // at runtime by the per-thread mode file, so permission can change live.
    extensions: [ensureGateExtension(getConfigDir())],
    // Keep pi's runtime in sync with the Plugins inventory, including the
    // singular `.pi/agent/skill` compatibility path and other local roots.
    skills: getAdditionalSkillPaths(cwd),
    gateModeFile,
    onEvent: (e) => {
      const event: any = e;
      if (event?.type === "agent_start") {
        turnStarted = true;
        completedReply = null;
      }
      if (event?.type === "message_start" && event.message?.role === "user") {
        turnStarted = true;
        promptForNotification = agentContentText(event.message.content).trim();
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        // Intermediate assistant messages contain tool calls. Only retain the
        // final user-facing assistant message for the native completion card.
        completedReply = finalAssistantReply(event.message);
      }

      send("pi:event", { threadId: id, event });

      if (event?.type === "agent_settled") {
        const shouldNotify = turnStarted;
        const reply = completedReply;
        const prompt = promptForNotification;
        turnStarted = false;
        completedReply = null;
        if (shouldNotify && reply) {
          systemNotifications?.notifyTaskComplete(id, {
            language: getConfig().language === "zh" ? "zh" : "en",
            prompt,
            reply: reply.text,
          });
        }
      }
    },
    onExtUi: (r) => {
      send("pi:extui", { threadId: id, request: r });
      if (isSandboxApprovalRequest(r)) {
        systemNotifications?.notifySandboxApproval(
          id,
          getConfig().language === "zh" ? "zh" : "en",
          sandboxOperationFromTitle((r as any)?.title, getConfig().language === "zh" ? "zh" : "en"),
        );
      }
    },
    onExit: (info) => {
      // Only forget the bridge if it is still the one registered under this id
      // (a delayed exit must not evict a bridge that replaced it).
      if (bridges.get(id) === handle) bridges.delete(id);
      if (warmHandle === handle) {
        warmHandle = null;
        if (!info.expected) warmFailures++;
        // eslint-disable-next-line no-console
        console.log(`[pi] warm spare exited (code=${info.code}, expected=${!!info.expected}, failures=${warmFailures})`);
        // Refill unless the spare keeps dying (avoid a crash loop).
        if (warmFailures < 3) setTimeout(() => ensureWarmBridge(), 500);
      }
      removeGateModeFile(gateModeFile);
      // An intentional stop (thread close / app quit) is expected and must not
      // surface as a "pi process exited" error.
      if (!info.expected) send("pi:exit", { threadId: id, ...info });
    },
    onError: (err) => send("pi:error", { threadId: id, message: err.message }),
  });
  return handle;
}

/* ------------------------------------------------------------------ *
 * Warm spare bridge
 * ------------------------------------------------------------------ *
 * pi's cold start takes ~5s on Windows: its ESM module graph is thousands
 * of small files and Windows Defender's real-time filter scans each open
 * synchronously (measured: 3.5s wall time with <100ms CPU — pure I/O wait).
 * Every thread open used to spawn a fresh process and block on it, so
 * clicks appeared dead for 5 seconds.
 *
 * Fix: keep exactly ONE fully-booted pi process on standby. thread:open
 * adopts it when the cwd matches (switching sessions on a warm process
 * measures ~0.5s vs ~5s cold) and refills the spare in the background.
 * Cost: one idle node process (~190MB); it is stopped on app quit.
 */
let warmHandle: BridgeHandle | null = null;
let lastOpenCwd: string | null = null;
let warmFailures = 0;
let warmEnabled = false;
let sendToRenderer: ((ch: string, p: unknown) => void) | null = null;

function warmCwd(): string {
  // Prefer the project actually used most recently (persisted), so the first
  // click after an app restart already hits a matching spare.
  return lastOpenCwd || getConfig().lastThreadCwd || (getConfig().pinnedProjects || [])[0] || homedir();
}

/**
 * Directory identity across sources. On Windows the same folder arrives in
 * different spellings depending on who produced it — the folder dialog,
 * pinned config, and the cwd pi recorded inside a session file can differ in
 * drive-letter case and slash direction. Compare normalized, or the warm
 * spare would never match and every open would fall back to a cold start.
 */
function sameDir(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (process.platform === "win32") {
    const norm = (p: string) => p.replace(/[\\/]+/g, "\\").replace(/[\\/]+$/, "").toLowerCase();
    return norm(a) === norm(b);
  }
  const norm = (p: string) => p.replace(/\/+$/, "") || "/";
  return norm(a) === norm(b);
}

/**
 * Keep the renderer's command list aligned with the skills on disk. Pi is the
 * command authority, but older RPC responses and disconnected history loads
 * can omit skill entries. The disk-side list uses the same 0.84.1 discovery
 * rules, so it is safe to use as a reconciliation source and to remove stale
 * skill entries after a skill is disabled.
 */
function synchronizedCommands(raw: unknown, cwd: string): any[] {
  const diskSkills = getSkillCommands(cwd);
  const byName = new Map(diskSkills.map((skill) => [skill.name, skill]));
  const result: any[] = [];
  const seen = new Set<string>();
  const commands = Array.isArray(raw) ? raw : [];

  for (const command of commands) {
    if (!command || typeof command !== "object" || (command as any).name === "pi-studio-branch-at") continue;
    if ((command as any).source === "skill") {
      const name = String((command as any).name || "");
      const canonical = byName.get(name);
      if (!canonical || seen.has(name)) continue;
      seen.add(name);
      result.push({ ...command, description: canonical.description });
      continue;
    }
    result.push(command);
  }

  // This also covers a Pi RPC response captured before the skill scan finished.
  for (const skill of diskSkills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    result.push(skill);
  }
  return result;
}

/** Spawn the standby process if there is none. Safe to call anytime. */
export function ensureWarmBridge(): void {
  if (!warmEnabled || warmHandle || !sendToRenderer) return;
  if (warmFailures >= 3) return; // repeated crashes: stop respawning
  const cwd = warmCwd();
  const handle = createHandle(cwd, undefined, undefined, "sandbox", sendToRenderer);
  warmHandle = handle;
  // eslint-disable-next-line no-console
  console.log("[pi] warm spare spawning (cwd=" + cwd + ")");
  handle.bridge
    .start()
    .then(() => handle.bridge.getState()) // wait until pi answers: fully booted
    .then(() => {
      if (warmHandle === handle) {
        // eslint-disable-next-line no-console
        console.log("[pi] warm spare ready — thread opens are now fast");
      }
    })
    .catch((err) => {
      if (warmHandle === handle) warmHandle = null;
      // A spawned-but-dead process is counted by its onExit handler; only
      // count spawn-time failures here to avoid double counting.
      if (!handle.bridge.running) warmFailures++;
      // eslint-disable-next-line no-console
      console.error("[pi] warm bridge failed to start:", (err as Error)?.message || String(err));
    });
}

/** Kill the standby process (runtime changed, quitting, etc.). */
export function dropWarmBridge(): void {
  if (warmHandle) {
    warmHandle.bridge.stop();
    warmHandle = null;
  }
}

async function gatherThread(bridge: PiBridge, threadId: string, permission: PermissionLevel) {
  const state: any = await bridge.getState();
  const [msgRes, modelsRes, cmdsRes, entriesRes]: any[] = await Promise.all([
    bridge.getMessages(),
    bridge.getAvailableModels(),
    bridge.getCommands().catch(() => ({ commands: [] })),
    bridge.getEntries().catch(() => ({ entries: [], leafId: null })),
  ]);
  return {
    threadId,
    cwd: bridge.cwd,
    sessionFile: state.sessionFile ?? null,
    sessionName: state.sessionName ?? null,
    model: state.model ?? null,
    thinkingLevel: state.thinkingLevel ?? "off",
    isStreaming: !!state.isStreaming,
    messages: msgRes?.messages ?? [],
    branchMessages: activeBranchMessages(entriesRes),
    models: modelsRes?.models ?? [],
    commands: synchronizedCommands(cmdsRes?.commands, bridge.cwd),
    permission,
  };
}

/** Resolve visible user/assistant messages on the active entry branch to their
 * stable session ids. Walking parent links avoids targeting an identically
 * worded reply that belongs to an inactive branch. */
function activeBranchMessages(entriesRes: any): { entryId: string; role: "user" | "assistant"; text: string }[] {
  const entries = Array.isArray(entriesRes?.entries) ? entriesRes.entries : [];
  const byId = new Map(entries.map((entry: any) => [entry?.id, entry]));
  const branch: any[] = [];
  let entry: any = entriesRes?.leafId ? byId.get(entriesRes.leafId) : undefined;
  const seen = new Set<string>();
  while (entry?.id && !seen.has(entry.id)) {
    seen.add(entry.id);
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  branch.reverse();
  const result: { entryId: string; role: "user" | "assistant"; text: string }[] = [];
  for (const item of branch) {
    const role = item?.message?.role;
    if (item?.type !== "message" || (role !== "user" && role !== "assistant")) continue;
    const content = item.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((block: any) => (block?.type === "text" ? block.text || "" : "")).filter(Boolean).join("\n")
          : "";
    result.push({ entryId: item.id, role, text });
  }
  return result;
}

/** Resolve the effective permission level for a thread open request. */
function resolvePermission(sessionFile: string | undefined, requested: PermissionLevel | undefined): PermissionLevel {
  if (requested === "sandbox" || requested === "full") return requested;
  if (sessionFile) {
    const stored = getConfig().threadPermissions[sessionFile];
    if (stored === "sandbox" || stored === "full") return stored;
  }
  return "sandbox"; // default
}

export function stopAllBridges(): void {
  warmEnabled = false; // no respawns while shutting down
  for (const h of bridges.values()) h.bridge.stop();
  bridges.clear();
  dropWarmBridge();
}

export function stopRemoteHost(): void {
  activeRemoteHost?.stop();
  activeRemoteHost = null;
}

export function registerIpc(getWin: () => BrowserWindow | null): void {
  let remotePublish: ((channel: string, payload: unknown) => void) | null = null;
  const send = (channel: string, payload: unknown) => {
    const w = getWin();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    remotePublish?.(channel, payload);
  };
  sendToRenderer = send;
  systemNotifications = createSystemNotificationCenter(getWin);
  warmEnabled = true;
  // ---- remote companion backend -----------------------------------------
  // The remote surface is deliberately built beside the existing renderer IPC
  // rather than exposing renderer channels to the network. It receives only
  // opaque project/thread ids and calls the same PiBridge registry used by the
  // desktop UI.
  const remoteIdentity = loadOrCreateIdentity(getConfigDir());
  const remoteDrafts = new Map<string, { cwd: string; projectId: string; name?: string; permission: PermissionLevel; sessionFile?: string; localId?: string }>();
  const remoteLocalToId = new Map<string, string>();
  const remoteEventHub = new RemoteEventHub();
  const remoteUiRequests = new Map<string, { threadId: string; localId: string }>();
  let remoteProjectsCache: { expiresAt: number; value: ProjectSummary[] } | null = null;
  let remoteProjectsLoad: Promise<ProjectSummary[]> | null = null;
  const invalidateRemoteProjects = () => {
    remoteProjectsCache = null;
  };

  const remoteProjectId = (cwd: string) => opaqueId(remoteIdentity.hmacSecret, `project:${resolve(cwd).toLowerCase()}`);
  const remoteThreadId = (file: string) => opaqueId(remoteIdentity.hmacSecret, `thread:${resolve(file).toLowerCase()}`);

  function remoteText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map((block: any) => (block?.type === "text" ? String(block.text || "") : "")).filter(Boolean).join("\n");
  }

  const REMOTE_FILE_TOOL = /(?:^|[_-])(write|edit|create|save|export|apply[_-]?patch)(?:[_-]|$)/i;
  const REMOTE_COMMAND_TOOL = /(?:^|[_-])(bash|shell|exec|execute|command|run|python)(?:[_-]|$)/i;
  const REMOTE_OUTPUT_EXTENSIONS = "html?|pdf|csv|xlsx?|docx|pptx|json|md|txt|xml|svg|png|jpe?g|gif|webp|zip|tar|gz|mp4|webm|py|js|jsx|ts|tsx|css";
  const REMOTE_ABSOLUTE_OUTPUT_PATH = new RegExp(
    String.raw`(?:[a-zA-Z]:[\\/]|/[a-zA-Z]/)[^"'<>\r\n|?*]+?\.(?:${REMOTE_OUTPUT_EXTENSIONS})`,
    "gi",
  );
  const REMOTE_QUOTED_OUTPUT_PATH = new RegExp(
    String.raw`["']([^"'<>\r\n|?*]+?\.(?:${REMOTE_OUTPUT_EXTENSIONS}))["']`,
    "gi",
  );
  const REMOTE_SIMPLE_OUTPUT_PATH = new RegExp(
    String.raw`(?:^|[\s(])((?:\.{0,2}[\\/])?[\w\u3400-\u9fff@().+ -]+(?:[\\/][\w\u3400-\u9fff@().+ -]+)*\.(?:${REMOTE_OUTPUT_EXTENSIONS}))(?=$|[\s,.;:!?])`,
    "gi",
  );

  function remoteCleanPath(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const cleaned = value.trim().replace(/^["']|["']$/g, "");
    return cleaned || null;
  }

  function remotePathFromArgs(args: unknown): string | null {
    if (typeof args === "string") {
      try {
        return remotePathFromArgs(JSON.parse(args));
      } catch {
        return null;
      }
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    const record = args as Record<string, unknown>;
    for (const key of ["path", "filePath", "file_path", "filename", "file"]) {
      const path = remoteCleanPath(record[key]);
      if (path) return path;
    }
    return null;
  }

  function remoteToolName(value: unknown): string {
    return String(value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[^a-zA-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase();
  }

  function remoteIsFileTool(value: unknown): boolean {
    return REMOTE_FILE_TOOL.test(remoteToolName(value));
  }

  function remoteIsCommandTool(value: unknown): boolean {
    return REMOTE_COMMAND_TOOL.test(remoteToolName(value));
  }

  function remoteRelativeArtifactPath(rawPath: string, cwd: string): string | null {
    const root = resolve(cwd);
    const absolute = /^[a-zA-Z]:[\\/]/.test(rawPath) || rawPath.startsWith("\\\\") || isAbsolute(rawPath)
      ? resolve(rawPath)
      : resolve(root, rawPath);
    const relativePath = relative(root, absolute);
    if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return null;
    const normalized = relativePath.replace(/\\/g, "/");
    if (!normalized || normalized.length > 1_000 || normalized.split("/").includes("..")) return null;
    if (!existsSync(absolute)) return null;
    return normalized;
  }

  function remoteArtifactFromPath(rawPath: string, cwd: string, action: RemoteFileArtifact["action"]): RemoteFileArtifact | null {
    const path = remoteRelativeArtifactPath(rawPath, cwd);
    if (!path) return null;
    const name = basename(path);
    return {
      name: name.slice(0, 260),
      path,
      ext: extname(name).toLowerCase().slice(0, 12),
      action,
    };
  }

  function remoteOutputPathsFromText(text: string): string[] {
    const paths: string[] = [];
    REMOTE_ABSOLUTE_OUTPUT_PATH.lastIndex = 0;
    REMOTE_QUOTED_OUTPUT_PATH.lastIndex = 0;
    REMOTE_SIMPLE_OUTPUT_PATH.lastIndex = 0;
    for (const match of text.matchAll(REMOTE_ABSOLUTE_OUTPUT_PATH)) paths.push(match[0]);
    for (const match of text.matchAll(REMOTE_QUOTED_OUTPUT_PATH)) paths.push(match[1]);
    for (const match of text.matchAll(REMOTE_SIMPLE_OUTPUT_PATH)) paths.push(match[1]);
    return paths;
  }

  function remoteArtifactsByMessage(messages: any[], cwd: string): Map<number, RemoteFileArtifact[]> {
    const toolCalls = new Map<string, { name: string; args: unknown }>();
    const toolResults = new Map<string, { text: string; isError: boolean }>();
    for (const message of messages || []) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
          toolCalls.set(block.id, { name: String(block.name || ""), args: block.arguments });
        }
      }
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        toolResults.set(message.toolCallId, {
          text: remoteText(message.content),
          isError: !!message.isError,
        });
      }
    }

    const result = new Map<number, RemoteFileArtifact[]>();
    const round = new Map<string, RemoteFileArtifact>();
    let lastAssistantIndex = -1;
    // A tool round can contain several assistant messages: thinking, one or
    // more tool calls, and finally the user-facing answer. Keep the output on
    // that final visible answer so mobile renders it directly after the text.
    let lastReplyIndex = -1;
    const addToRound = (rawPath: string, action: RemoteFileArtifact["action"]) => {
      const artifact = remoteArtifactFromPath(rawPath, cwd, action);
      if (!artifact) return;
      const key = artifact.path.toLowerCase();
      const previous = round.get(key);
      round.set(key, previous
        ? { ...artifact, action: previous.action === "created" ? "created" : artifact.action }
        : artifact);
    };
    const flushRound = () => {
      const targetIndex = lastReplyIndex >= 0 ? lastReplyIndex : lastAssistantIndex;
      if (targetIndex < 0 || round.size === 0) return;
      result.set(targetIndex, [...round.values()]);
      round.clear();
    };

    for (let index = 0; index < (messages || []).length; index += 1) {
      const message = messages[index];
      if (message?.role === "user") {
        flushRound();
        lastAssistantIndex = -1;
        lastReplyIndex = -1;
        continue;
      }
      if (message?.role !== "assistant") continue;
      lastAssistantIndex = index;
      const hasToolCall = Array.isArray(message.content) && message.content.some((block: any) => block?.type === "toolCall");
      if (remoteText(message.content).trim() && !hasToolCall) lastReplyIndex = index;
      if (!Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
        const call = toolCalls.get(block.id);
        const toolResult = toolResults.get(block.id);
        if (!call || toolResult?.isError) continue;
        const toolName = remoteToolName(call.name);
        if (remoteIsFileTool(toolName)) {
          // Some Pi versions expose the arguments on the collected call and
          // others only retain them on the content block. Accept both forms.
          const rawPath = remotePathFromArgs(call.args) || remotePathFromArgs(block.arguments);
          if (rawPath) addToRound(rawPath, /edit|patch|replace|update/i.test(toolName) ? "updated" : "created");
        }
        if (remoteIsCommandTool(toolName) && toolResult?.text) {
          for (const rawPath of remoteOutputPathsFromText(toolResult.text)) addToRound(rawPath, "created");
        }
      }
    }
    flushRound();
    return result;
  }

  function remoteSafeString(value: string): string {
    return value
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
      .replace(/(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|workspace)\/)[^\s"'<>`]*/gi, "[path]")
      .slice(0, 100_000);
  }

  function modelArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as any).models)) {
      return (value as any).models;
    }
    return [];
  }

  function remoteModelOptions(value: unknown): RemoteModelOption[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const options: RemoteModelOption[] = [];
    for (const item of value.slice(0, 200)) {
      if (!item || typeof item !== "object") continue;
      const provider = String((item as any).provider || "").trim().slice(0, 160);
      const id = String((item as any).id || "").trim().slice(0, 240);
      if (!provider || !id) continue;
      const key = `${provider}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const option: RemoteModelOption = { provider, id };
      if (typeof (item as any).name === "string" && (item as any).name.trim()) {
        option.name = remoteSafeString((item as any).name.trim()).slice(0, 180);
      }
      if (typeof (item as any).reasoning === "boolean") option.reasoning = (item as any).reasoning;
      options.push(option);
    }
    return options;
  }

  function configuredRemoteModelOptions(): RemoteModelOption[] {
    try {
      const configured = readModelsFile();
      const entries = Object.entries(configured.providers || {}).flatMap(([provider, definition]) =>
        (definition.models || []).map((model: any) => ({ ...model, provider })),
      );
      return remoteModelOptions(entries);
    } catch {
      return [];
    }
  }

  function remoteSkills(value: unknown, cwd: string): RemoteSkill[] {
    const skills: RemoteSkill[] = [];
    const seen = new Set<string>();
    const add = (rawName: unknown, description?: unknown) => {
      const raw = String(rawName || "").trim().replace(/^\/+/, "");
      const withoutPrefix = raw.replace(/^skill:/i, "");
      // Slash invocations are a single safe token. Never forward a path,
      // shell fragment, or arbitrary command text to the phone.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(withoutPrefix)) return;
      const command = `skill:${withoutPrefix}`;
      if (seen.has(command)) return;
      seen.add(command);
      const skill: RemoteSkill = { name: withoutPrefix, command };
      if (typeof description === "string" && description.trim()) {
        skill.description = remoteSafeString(description.trim()).slice(0, 600);
      }
      skills.push(skill);
    };

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 300)) {
        if (!item || typeof item !== "object" || (item as any).source !== "skill") continue;
        add((item as any).name, (item as any).description);
      }
    }
    // Keep the list useful even when an older Pi RPC omits skill commands.
    for (const skill of listSkills(cwd).slice(0, 300)) {
      if (skill.enabled) add(skill.name, skill.description);
    }
    return skills.slice(0, 200);
  }

  // File mtime values on Windows can contain fractional milliseconds. The
  // versioned remote protocol exposes timestamps as integer milliseconds so
  // Kotlin Long decoders and other strict clients receive stable values.
  function remoteTimestamp(value: unknown): number {
    const timestamp = typeof value === "number" ? value : Number(value);
    return Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0;
  }

  function remoteSafeEventValue(value: unknown, depth = 0): unknown {
    if (depth > 4 || value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return remoteSafeString(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => remoteSafeEventValue(item, depth + 1));
    if (!value || typeof value !== "object") return undefined;
    const blocked = /(?:^|)(?:cwd|path|file|absolute|command|args|arguments|env|secret|token|authorization|credential|input)$/i;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      if (blocked.test(key)) continue;
      const safe = remoteSafeEventValue(item, depth + 1);
      if (safe !== undefined) output[key] = safe;
    }
    return output;
  }

  function remoteUiRequest(request: any): Record<string, unknown> | null {
    const method = typeof request?.method === "string" ? request.method : "";
    // These are fire-and-forget renderer UI updates, not remote approval
    // prompts. Forwarding setStatus/setWidget as a dialog makes the Android
    // client show an empty modal titled "setStatus" and blocks the thread.
    // The remote client currently supports only actionable responses.
    if (!(method === "confirm" || method === "select" || method === "input")) return null;
    const allowed = ["id", "method", "title", "message", "options", "placeholder", "prefill", "notifyType", "timeout"];
    const result: Record<string, unknown> = {};
    for (const key of allowed) {
      if (request[key] === undefined) continue;
      result[key] = remoteSafeEventValue(request[key]);
    }
    return result;
  }

  function remoteMessages(messages: any[], cwd: string): RemoteMessage[] {
    // Keep the initial history response well below the SCTP data-channel
    // message budget. `text` remains available for previews and compatibility,
    // while text blocks preserve the actual thinking/tool/reply order in the
    // mobile renderer.
    let imageBudget = 400_000;
    const source = (messages || []).slice(-80);
    const artifactsByMessage = remoteArtifactsByMessage(source, cwd);
    type RemoteBlock = NonNullable<RemoteMessage["blocks"]>[number];
    const toolResults = new Map<string, { text: string; isError: boolean }>();
    const toolCallIds = new Set<string>();
    for (const message of source) {
      if (message?.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === "toolCall" && typeof block.id === "string") toolCallIds.add(block.id);
        }
      }
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        toolResults.set(message.toolCallId, {
          text: remoteText(message.content).slice(0, 12_000),
          isError: !!message.isError,
        });
      }
    }

    const blocksFor = (message: any): RemoteBlock[] => {
      if (typeof message?.content === "string") {
        const text = message.content.slice(0, 12_000);
        return text ? [{ type: "text", text }] : [];
      }
      if (!Array.isArray(message?.content)) return [];
      return message.content.slice(0, 24).map((block: any): RemoteBlock | null => {
        if (block?.type === "text") return { type: "text", text: String(block.text || "").slice(0, 12_000) };
        if (block?.type === "thinking") return { type: "thinking", text: String(block.thinking || "").slice(0, 12_000) };
        if (block?.type === "toolCall") {
          const result = typeof block.id === "string" ? toolResults.get(block.id) : undefined;
          return {
            type: "tool",
            name: String(block.name || "tool"),
            running: result == null,
            result: result?.text || undefined,
          };
        }
        if (block?.type === "image" && typeof block.data === "string" && block.data.length <= 400_000 && imageBudget >= block.data.length) {
          imageBudget -= block.data.length;
          const mimeType = typeof block.mimeType === "string" && /^image\/(jpeg|png|webp|gif)$/.test(block.mimeType)
            ? block.mimeType
            : "image/jpeg";
          return { type: "image", data: block.data, mimeType };
        }
        return null;
      }).filter((block: RemoteBlock | null): block is RemoteBlock => block !== null);
    };

    const textFor = (message: any): string | undefined => remoteText(message?.content).slice(0, 12_000) || undefined;
    const mergeArtifacts = (current: RemoteFileArtifact[] | undefined, next: RemoteFileArtifact[] | undefined): RemoteFileArtifact[] | undefined => {
      const merged = [...(current || [])];
      const seen = new Set(merged.map((artifact) => artifact.path.toLowerCase()));
      for (const artifact of next || []) {
        if (seen.has(artifact.path.toLowerCase())) continue;
        seen.add(artifact.path.toLowerCase());
        merged.push(artifact);
      }
      return merged.length ? merged : undefined;
    };

    const output: RemoteMessage[] = [];
    let assistantRound: RemoteMessage | null = null;
    let unmatchedToolOutputs: string[] = [];
    const flushAssistantRound = () => {
      if (!assistantRound) return;
      if (unmatchedToolOutputs.length) {
        assistantRound = {
          ...assistantRound,
          blocks: [...(assistantRound.blocks || []), ...unmatchedToolOutputs.map((result): RemoteBlock => ({
            type: "tool",
            name: "Tool output",
            running: false,
            result: result || undefined,
          }))],
        };
        unmatchedToolOutputs = [];
      }
      output.push(assistantRound);
      assistantRound = null;
    };

    const appendAssistant = (message: any, index: number) => {
      const text = textFor(message);
      const blocks = blocksFor(message);
      const artifacts = artifactsByMessage.get(index);
      if (!assistantRound) {
        assistantRound = {
          id: String(message?.id || `assistant-${index}`),
          role: "assistant",
          text,
          blocks: blocks.length ? blocks : undefined,
          artifacts: artifacts?.length ? artifacts : undefined,
          timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
          provider: typeof message?.provider === "string" ? message.provider : undefined,
          model: typeof message?.model === "string" ? message.model : undefined,
          stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
        };
        return;
      }
      assistantRound = {
        ...assistantRound,
        text: [assistantRound.text, text].filter(Boolean).join("\n\n") || undefined,
        blocks: [...(assistantRound.blocks || []), ...blocks].slice(0, 80),
        artifacts: mergeArtifacts(assistantRound.artifacts, artifacts),
        timestamp: assistantRound.timestamp ?? (typeof message?.timestamp === "number" ? message.timestamp : undefined),
        provider: assistantRound.provider || (typeof message?.provider === "string" ? message.provider : undefined),
        model: assistantRound.model || (typeof message?.model === "string" ? message.model : undefined),
        stopReason: typeof message?.stopReason === "string" ? message.stopReason : assistantRound.stopReason,
      };
    };

    source.forEach((message: any, index) => {
      if (message?.role === "assistant") {
        appendAssistant(message, index);
        return;
      }
      if (message?.role === "toolResult") {
        // Tool results belonging to a known call are rendered inside that
        // assistant round by blocksFor(). Keep an unmatched result visible
        // without creating a second avatar for the same round.
        const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
        if (!id || !toolCallIds.has(id)) {
          const result = remoteText(message.content).slice(0, 12_000);
          if (assistantRound) {
            unmatchedToolOutputs.push(result);
          } else if (result) {
            output.push({ id: String(message?.id || `tool-${index}`), role: "tool", text: result });
          }
        }
        return;
      }

      flushAssistantRound();
      const role = message?.role === "user" || message?.role === "system" ? message.role : "system";
      const blocks = blocksFor(message);
      const artifacts = artifactsByMessage.get(index);
      output.push({
        id: String(message?.id || `${role}-${index}`),
        role,
        text: textFor(message),
        blocks: blocks.length ? blocks : undefined,
        artifacts: artifacts?.length ? artifacts : undefined,
        timestamp: typeof message?.timestamp === "number" ? message.timestamp : undefined,
        provider: typeof message?.provider === "string" ? message.provider : undefined,
        model: typeof message?.model === "string" ? message.model : undefined,
        stopReason: typeof message?.stopReason === "string" ? message.stopReason : undefined,
      });
    });
    flushAssistantRound();
    return output;
  }

  async function remoteVisibleProjects(): Promise<ProjectSummary[]> {
    const now = Date.now();
    if (remoteProjectsCache && remoteProjectsCache.expiresAt > now) return remoteProjectsCache.value;
    if (remoteProjectsLoad) return remoteProjectsLoad;
    remoteProjectsLoad = (async () => {
      const scanned = await scanProjects();
      const pinned = getConfig().pinnedProjects || [];
      const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
      const archivedThreads = new Set((getConfig().archivedThreads || []).map((thread) => thread.file.toLowerCase()));
      const visible = scanned
        .filter((project) => !archived.has(project.cwd.toLowerCase()))
        .map((project) => ({ ...project, threads: project.threads.filter((thread) => !archivedThreads.has(thread.file.toLowerCase())) }));
      const byCwd = new Map(visible.map((project) => [project.cwd, project]));
      for (const cwd of pinned) {
        if (archived.has(cwd.toLowerCase()) || byCwd.has(cwd)) continue;
        visible.push({ cwd, name: basename(cwd) || cwd, threads: [] });
      }
      visible.sort((a, b) => (b.threads[0]?.updatedAt || 0) - (a.threads[0]?.updatedAt || 0));
      // The projects screen already fetched this index. Keep it warm while
      // the user moves between threads; writes explicitly invalidate it.
      remoteProjectsCache = { expiresAt: Date.now() + 30_000, value: visible };
      return visible;
    })();
    try {
      return await remoteProjectsLoad;
    } finally {
      remoteProjectsLoad = null;
    }
  }

  async function remoteProject(projectId: string): Promise<ProjectSummary> {
    const project = (await remoteVisibleProjects()).find((candidate) => remoteProjectId(candidate.cwd) === projectId);
    if (!project) throw new RemoteProtocolError("NOT_FOUND", "Project not found");
    return project;
  }

  async function remoteThread(threadId: string): Promise<{ id: string; projectId: string; cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel; localId?: string }> {
    const draft = remoteDrafts.get(threadId);
    if (draft) return { id: threadId, projectId: draft.projectId, cwd: draft.cwd, sessionFile: draft.sessionFile, name: draft.name, permission: draft.permission, localId: draft.localId };
    for (const project of await remoteVisibleProjects()) {
      for (const thread of project.threads) {
        if (remoteThreadId(thread.file) === threadId) {
          remoteLocalToId.set(thread.file, threadId);
          return {
            id: threadId,
            projectId: remoteProjectId(project.cwd),
            cwd: project.cwd,
            sessionFile: thread.file,
            permission: resolvePermission(thread.file, undefined),
            localId: thread.file,
          };
        }
      }
    }
    throw new RemoteProtocolError("NOT_FOUND", "Thread not found");
  }

  function remoteDraftIdForSessionFile(file: string): string | undefined {
    const normalized = resolve(file).toLowerCase();
    for (const [id, draft] of remoteDrafts) {
      if (draft.sessionFile && resolve(draft.sessionFile).toLowerCase() === normalized) return id;
    }
    return undefined;
  }

  function remoteState(isStreaming: boolean, hasMessages: boolean, error?: string): RemoteThreadState {
    if (error) return "error";
    if (isStreaming) return "running";
    return hasMessages ? "idle" : "draft";
  }

  async function remoteSnapshot(threadId: string, options: { live?: boolean } = {}): Promise<RemoteThreadSnapshot> {
    const ref = await remoteThread(threadId);
    const configuredModels = configuredRemoteModelOptions();
    const permission = ref.sessionFile ? resolvePermission(ref.sessionFile, ref.permission) : (ref.permission || "sandbox");
    let live = options.live && ref.localId ? bridges.get(ref.localId) : undefined;
    if (options.live && !live) {
      try {
        live = await ensureRemoteBridge(ref);
      } catch {
        live = undefined;
      }
    }
    if (!ref.sessionFile && !live) {
      return {
        id: threadId,
        projectId: ref.projectId,
        title: ref.name || "New thread",
        preview: "",
        updatedAt: Date.now(),
        messageCount: 0,
        state: "draft",
        permission,
        cwdName: basename(ref.cwd) || ref.cwd,
        model: null,
        availableModels: configuredModels,
        skills: [],
        thinkingLevel: "off",
        messages: [],
        nextSeq: 0,
      };
    }
    if (live) {
      const gathered: any = await gatherThread(live.bridge, live.getId(), live.permission);
      const messages = remoteMessages(gathered.messages, ref.cwd);
      return {
        id: threadId,
        projectId: ref.projectId,
        title: gathered.sessionName || messages.find((message) => message.role === "user")?.text?.slice(0, 80) || "Thread",
        preview: messages.find((message) => message.role === "user")?.text?.slice(0, 160) || "",
        updatedAt: Date.now(),
        messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
        state: remoteState(!!gathered.isStreaming, messages.length > 0),
        permission: live.permission,
        cwdName: basename(ref.cwd) || ref.cwd,
        model: gathered.model || null,
        availableModels: remoteModelOptions([...modelArray(gathered.models), ...configuredModels]),
        skills: remoteSkills(gathered.commands, ref.cwd),
        thinkingLevel: gathered.thinkingLevel || "off",
        messages,
        nextSeq: 0,
      };
    }
    if (!ref.sessionFile) throw new RemoteProtocolError("NOT_FOUND", "Thread history is not available");
    const history = await readThreadHistory(ref.sessionFile);
    const messages = remoteMessages(history.messages, ref.cwd);
    return {
      id: threadId,
      projectId: ref.projectId,
      title: history.sessionName || messages.find((message) => message.role === "user")?.text?.slice(0, 80) || "Thread",
      preview: messages.find((message) => message.role === "user")?.text?.slice(0, 160) || "",
      updatedAt: Date.now(),
      messageCount: messages.filter((message) => message.role === "user" || message.role === "assistant").length,
      state: remoteState(false, messages.length > 0),
      permission,
      cwdName: basename(ref.cwd) || ref.cwd,
      model: history.model,
      availableModels: configuredModels,
      skills: [],
      thinkingLevel: history.thinkingLevel || "off",
      messages,
      nextSeq: 0,
    };
  }

  function assertRemotePath(cwd: string, relativePath: string): string {
    if (!relativePath || relativePath.startsWith("/") || relativePath.startsWith("\\") || relativePath.split(/[\\/]/).includes("..")) {
      throw new RemoteProtocolError("FORBIDDEN", "Only project-relative paths are allowed");
    }
    const root = realpathSync(resolve(cwd));
    const target = resolve(root, relativePath);
    let existingParent = target;
    while (!existsSync(existingParent) && existingParent !== root) existingParent = dirname(existingParent);
    const realParent = realpathSync(existingParent);
    if (realParent !== root && !realParent.startsWith(root + sep)) throw new RemoteProtocolError("FORBIDDEN", "Path escapes project root");
    const realTarget = existsSync(target) ? realpathSync(target) : target;
    if (realTarget !== root && !realTarget.startsWith(root + sep)) throw new RemoteProtocolError("FORBIDDEN", "Path escapes project root");
    return target;
  }

  function assertRemotePreviewName(relativePath: string): void {
    const lower = relativePath.toLowerCase();
    if (/(^|[\\/])(?:\.env|credentials|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(lower)) {
      throw new RemoteProtocolError("FORBIDDEN", "Sensitive files are not available remotely");
    }
  }

  async function ensureRemoteBridge(ref: { id: string; cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel; localId?: string }): Promise<BridgeHandle> {
    const permission = ref.sessionFile ? resolvePermission(ref.sessionFile, ref.permission) : (ref.permission || "sandbox");
    const existingId = ref.localId || ref.sessionFile;
    if (existingId && bridges.has(existingId)) {
      const existing = bridges.get(existingId)!;
      if (existing.permission !== permission) {
        existing.permission = permission;
        writeGateMode(existing.gateModeFile, permission);
      }
      return existing;
    }
    const handle = createHandle(ref.cwd, ref.sessionFile, ref.name, permission, send);
    const localId = handle.getId();
    bridges.set(localId, handle);
    remoteLocalToId.set(localId, ref.id);
    if (ref.sessionFile) remoteLocalToId.set(ref.sessionFile, ref.id);
    try {
      await handle.bridge.start();
    } catch (error) {
      if (bridges.get(localId) === handle) bridges.delete(localId);
      remoteLocalToId.delete(localId);
      if (ref.sessionFile) remoteLocalToId.delete(ref.sessionFile);
      removeGateModeFile(handle.gateModeFile);
      handle.bridge.stop();
      throw error;
    }
    if (ref.sessionFile) {
      ref.localId = handle.getId();
    } else {
      const draft = remoteDrafts.get(ref.id);
      if (draft) draft.localId = handle.getId();
    }
    return handle;
  }

  const projectService = new ProjectService(
    async (): Promise<RemoteProject[]> => {
      const projects = await remoteVisibleProjects();
      return projects.map((project) => ({
        id: remoteProjectId(project.cwd),
        name: project.name,
        threadCount: project.threads.length,
        updatedAt: remoteTimestamp(project.threads[0]?.updatedAt),
      }));
    },
    async (projectId: string) => remoteProject(projectId),
    async (projectId: string) => {
      const project = await remoteProject(projectId);
      return Promise.all(project.threads.map(async (thread) => {
        // Keep the id returned by thread.create stable after its in-memory
        // draft is promoted to a real session file.
        let state: RemoteThreadState = thread.messageCount === 0 ? "draft" : "idle";
        const live = bridges.get(thread.file);
        if (live) {
          try {
            const liveState: any = await live.bridge.getState();
            if (liveState?.isStreaming) state = "running";
          } catch {
            // A thread can finish or close while the list is being read; the
            // persisted summary remains a valid idle/draft fallback.
          }
        }
        return {
          id: remoteDraftIdForSessionFile(thread.file) || remoteThreadId(thread.file),
          projectId,
          title: thread.title,
          preview: thread.preview,
          updatedAt: remoteTimestamp(thread.updatedAt),
          messageCount: thread.messageCount,
          state,
          permission: resolvePermission(thread.file, undefined),
        };
      }));
    },
  );

  const threadService = new ThreadService(
    (threadId) => remoteSnapshot(threadId),
    async (projectId, name, permission = "sandbox") => {
      const project = await remoteProject(projectId);
      const id = `draft-${randomUUID()}`;
      const draft: { cwd: string; projectId: string; name?: string; permission: PermissionLevel; sessionFile?: string; localId?: string } = {
        cwd: project.cwd,
        projectId,
        name,
        permission,
      };
      remoteDrafts.set(id, draft);
      try {
        // A remote-created thread must be a real session immediately. The
        // desktop sidebar is backed by scanProjects(), which only sees Pi's
        // persisted JSONL sessions; leaving this as an in-memory draft made
        // the thread invisible until the first prompt was sent.
        const bridge = await ensureRemoteBridge({ id, ...draft });
        let state: any = await bridge.bridge.getState();
        if (!state?.sessionFile) {
          await bridge.bridge.newSession();
          state = await bridge.bridge.getState();
        }
        if (!state?.sessionFile) throw new Error("Pi did not create a session for the new thread");

        const previousLocalId = bridge.getId();
        draft.sessionFile = state.sessionFile;
        draft.localId = state.sessionFile;
        remoteLocalToId.delete(previousLocalId);
        remoteLocalToId.set(state.sessionFile, id);
        bridge.setId(state.sessionFile);
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== permission) {
          updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: permission } });
        }
        invalidateRemoteProjects();
        // The renderer's project index is disk-backed too. Notify it as soon
        // as the session file exists so an already-open sidebar updates.
        send("pi:projects-changed", { cwd: project.cwd, sessionFile: state.sessionFile });
        return remoteSnapshot(id, { live: true });
      } catch (error) {
        remoteDrafts.delete(id);
        const localId = draft.localId;
        const handle = localId ? bridges.get(localId) : undefined;
        if (localId && handle) {
          bridges.delete(localId);
          remoteLocalToId.delete(localId);
          removeGateModeFile(handle.gateModeFile);
          handle.bridge.stop();
        }
        throw error;
      }
    },
    async (threadId, text, images) => {
      const ref = await remoteThread(threadId);
      const bridge = await ensureRemoteBridge(ref);
      await bridge.bridge.prompt(text, images);
      const state: any = await bridge.bridge.getState();
      if (state?.sessionFile) {
        const draft = remoteDrafts.get(threadId);
        if (draft) {
          draft.sessionFile = state.sessionFile;
          draft.localId = state.sessionFile;
        }
        remoteLocalToId.set(state.sessionFile, threadId);
        bridge.setId(state.sessionFile);
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== bridge.permission) {
          updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: bridge.permission } });
        }
        if (!ref.sessionFile) send("pi:projects-changed", { cwd: ref.cwd, sessionFile: state.sessionFile });
      }
      invalidateRemoteProjects();
      return { ok: true };
    },
    async (threadId, text, images) => {
      const bridge = await ensureRemoteBridge(await remoteThread(threadId));
      await bridge.bridge.steer(text, images);
      return { ok: true };
    },
    async (threadId, text, images) => {
      const bridge = await ensureRemoteBridge(await remoteThread(threadId));
      await bridge.bridge.followUp(text, images);
      return { ok: true };
    },
    async (threadId) => {
      const ref = await remoteThread(threadId);
      const bridge = [ref.localId, ref.sessionFile]
        .filter((id): id is string => Boolean(id))
        .map((id) => bridges.get(id))
        .find(Boolean);
      if (!bridge) return { ok: true, alreadyStopped: true };
      await bridge.bridge.abort();
      return { ok: true };
    },
  );

  const filePreviewService = new FilePreviewService(
    async (projectId, relativePath) => {
      const project = await remoteProject(projectId);
      const target = relativePath ? assertRemotePath(project.cwd, relativePath) : project.cwd;
      const rel = relativePath || undefined;
      return listDir(project.cwd, rel)
        .filter((node) => !/(^|[\\/])(?:\.env|credentials|secrets?|id_rsa|id_ed25519)(?:\.|$)/i.test(node.rel))
        .map((node) => ({ name: node.name, rel: node.rel, isDir: node.isDir, ext: node.ext, size: node.size }));
    },
    async (projectId, relativePath) => {
      const project = await remoteProject(projectId);
      assertRemotePreviewName(relativePath);
      const target = assertRemotePath(project.cwd, relativePath);
      const preview = readRemotePreview(target);
      if (!["text", "markdown", "html", "image", "xlsx"].includes(preview.kind)) throw new RemoteProtocolError("UNSUPPORTED", "Only text, Markdown, HTML, image and Excel previews are available remotely");
      const maxRemoteTextChars = preview.kind === "xlsx" ? 1_200_000 : 524_288;
      if (preview.text && preview.text.length > maxRemoteTextChars) {
        if (preview.kind === "xlsx") throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Spreadsheet preview is too large");
        preview.text = preview.text.slice(0, maxRemoteTextChars);
      }
      if (preview.base64 && preview.base64.length > 2_800_000) throw new RemoteProtocolError("PAYLOAD_TOO_LARGE", "Preview is too large");
      if (preview.message) preview.message = remoteSafeString(preview.message);
      delete preview.previewUrl;
      return preview;
    },
  );

  const remoteBackend: RemoteBackend = {
    listProjects: () => projectService.list(),
    listThreads: (projectId) => projectService.listThreads(projectId),
    getThread: (threadId, options) => remoteSnapshot(threadId, options),
    createThread: (projectId, name, permission) => threadService.create(projectId, name, permission),
    setPermission: async (threadId, permission) => {
      const ref = await remoteThread(threadId);
      const draft = remoteDrafts.get(threadId);
      if (draft) draft.permission = permission;
      if (ref.sessionFile) {
        const perms = getConfig().threadPermissions;
        updateConfig({ threadPermissions: { ...perms, [ref.sessionFile]: permission } });
      }
      const existingId = ref.localId || ref.sessionFile;
      const handle = existingId ? bridges.get(existingId) : undefined;
      if (handle) {
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
      }
      return remoteSnapshot(threadId, { live: true });
    },
    setModel: async (threadId, provider, modelId) => {
      const ref = await remoteThread(threadId);
      const handle = await ensureRemoteBridge(ref);
      let available: any = await handle.bridge.getAvailableModels();
      let models = remoteModelOptions([...modelArray(available), ...configuredRemoteModelOptions()]);
      if (!models.some((model) => model.provider === provider && model.id === modelId)) {
        try {
          available = await handle.bridge.refreshModels();
          models = remoteModelOptions([...modelArray(available), ...configuredRemoteModelOptions()]);
        } catch {
          // The configured models fallback remains usable when the host's
          // optional refresh command is unavailable on an older Pi runtime.
        }
      }
      const allowed = models.some((model) => model.provider === provider && model.id === modelId);
      if (!allowed) throw new RemoteProtocolError("MODEL_UNAVAILABLE", "That model is not available on the Pi Studio host");
      await handle.bridge.setModel(provider, modelId);
      return remoteSnapshot(threadId, { live: true });
    },
    prompt: (threadId, text, images) => threadService.prompt(threadId, text, images),
    steer: (threadId, text, images) => threadService.steer(threadId, text, images),
    followUp: (threadId, text, images) => threadService.followUp(threadId, text, images),
    abort: (threadId) => threadService.abort(threadId),
    fileTree: (projectId, relativePath) => filePreviewService.tree(projectId, relativePath),
    filePreview: (projectId, relativePath) => filePreviewService.preview(projectId, relativePath),
    respondUi: async (threadId, requestId, payload) => {
      const pending = remoteUiRequests.get(requestId);
      if (!pending || pending.threadId !== threadId) throw new RemoteProtocolError("NOT_FOUND", "UI request is no longer pending");
      const bridge = bridges.get(pending.localId);
      if (!bridge) throw new RemoteProtocolError("DISCONNECTED", "Thread is no longer connected");
      bridge.bridge.respondExtUi(requestId, payload);
      remoteUiRequests.delete(requestId);
      return { ok: true };
    },
    subscribeThread: (threadId, listener) => {
      return remoteEventHub.subscribe(threadId, listener);
    },
  };

  const remoteService = new RemoteService(remoteBackend);
  const remoteHost = new RemoteHost({
    userDataDir: getConfigDir(),
    signalingUrl: process.env.PI_STUDIO_REMOTE_SIGNALING_URL || getConfig().remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL,
    stunUrls: [...BUILT_IN_REMOTE_STUN_URLS],
    sendToRenderer: send,
    service: remoteService,
  });
  activeRemoteHost = remoteHost;
  remoteHost.start();
  if (getConfig().remoteSignalingEnabled) remoteHost.enableSignaling(true);

  remotePublish = (channel, payload) => {
    if (!payload || typeof payload !== "object") return;
    const rawThreadId = typeof (payload as any).threadId === "string" ? (payload as any).threadId : "";
    const threadId = remoteLocalToId.get(rawThreadId) || (rawThreadId.includes("\\") || rawThreadId.includes("/") ? remoteThreadId(rawThreadId) : "");
    if (!threadId) return;
    let event: RemoteThreadEventPayload;
    if (channel === "pi:event") {
      const piEvent = (payload as any).event || {};
      event = { kind: String(piEvent.type || "agent.event"), data: { event: remoteSafeEventValue(piEvent) as Record<string, unknown> } };
    } else if (channel === "pi:extui") {
      const request = (payload as any).request || {};
      const safeRequest = remoteUiRequest(request);
      if (!safeRequest) return;
      remoteUiRequests.set(String(request.id || ""), { threadId, localId: rawThreadId });
      event = { kind: "ui.request", data: { request: safeRequest } };
    } else if (channel === "pi:exit") {
      event = { kind: "thread.exit", data: { code: (payload as any).code, stderr: remoteSafeString(String((payload as any).stderr || "").slice(-2000)) } };
    } else if (channel === "pi:error") {
      event = { kind: "thread.error", data: { message: remoteSafeString(String((payload as any).message || "remote Pi error")) } };
    } else {
      return;
    }
    remoteEventHub.publish(threadId, event);
  };

  ipcMain.handle("remote:getStatus", () => remoteHost.getStatus());
  ipcMain.handle("remote:createPairing", () => remoteHost.createPairingTicket());
  ipcMain.handle("remote:enableSignaling", (_e, args?: { manual?: boolean }) => {
    const manual = args?.manual === true;
    const enabled = remoteHost.enableSignaling(manual);
    if (manual) updateConfig({ remoteSignalingEnabled: enabled });
    return enabled;
  });
  ipcMain.handle("remote:disableSignaling", () => {
    remoteHost.disableSignaling();
    updateConfig({ remoteSignalingEnabled: false });
    return { ok: true };
  });
  ipcMain.handle("remote:approvePairing", (_e, connectionId: string) => remoteHost.approvePairing(connectionId));
  ipcMain.handle("remote:rejectPairing", (_e, connectionId: string) => remoteHost.rejectPairing(connectionId));
  ipcMain.handle("remote:revokeDevice", (_e, deviceId: string) => remoteHost.revokeDevice(deviceId));
  ipcMain.handle("remote:transportOpen", (_e, args: { connectionId: string; sessionId?: string }) => remoteHost.transportOpened(args.connectionId, args.sessionId));
  ipcMain.handle("remote:transportClose", (_e, args: { connectionId: string; reason?: string }) => remoteHost.transportClosed(args.connectionId, args.reason));
  ipcMain.handle("remote:transportStatus", (_e, args: { connectionId: string; state?: string; candidateType?: string; localCandidateType?: string; remoteCandidateType?: string }) => {
    remoteHost.transportStatus(args.connectionId, args);
    return { ok: true };
  });
  ipcMain.handle("remote:transportFrame", (_e, args: { connectionId: string; frame: string }) => remoteHost.handleTransportFrame(args.connectionId, args.frame));
  ipcMain.handle("remote:sendSignal", (_e, args: { connectionId: string; payload: Record<string, unknown> }) => remoteHost.sendSignal(args.connectionId, args.payload));
  ipcMain.handle("remote:getTransportConfig", () => ({ stunUrls: [...BUILT_IN_REMOTE_STUN_URLS], directOnly: true }));
  ipcMain.handle("remote:setConfig", (_e, patch: { signalingUrl?: string }) => {
    const signalingUrl = patch.signalingUrl?.trim() || DEFAULT_REMOTE_SIGNALING_URL;
    const next = updateConfig({ remoteSignalingUrl: signalingUrl });
    remoteHost.configure(next.remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL, [...BUILT_IN_REMOTE_STUN_URLS]);
    return { remoteSignalingUrl: next.remoteSignalingUrl };
  });


  // ---- app / config -------------------------------------------------------
  ipcMain.handle("app:getVersion", () => app.getVersion());
  ipcMain.handle("app:getConfig", () => getConfig());
  ipcMain.handle("app:setConfig", (_e, patch) => {
    const prev = getConfig().piCliPath;
    const next = updateConfig(patch || {});
    if (patch && ("remoteSignalingUrl" in patch || "remoteStunUrls" in patch)) {
      remoteHost.configure(next.remoteSignalingUrl || DEFAULT_REMOTE_SIGNALING_URL, [...BUILT_IN_REMOTE_STUN_URLS]);
    }
    if ((next.piCliPath || "") !== (prev || "")) {
      resetPiRuntime();
      dropWarmBridge(); // standby was booted from the old runtime
      ensureWarmBridge();
    }
    return next;
  });
  ipcMain.handle("app:resolveRuntime", async () => {
    try {
      const rt = await resolvePiRuntime(getConfig().piCliPath);
      // eslint-disable-next-line no-console
      console.log("[pi] runtime resolved ->", "node:", rt.node, "| cli:", rt.cli);
      return { ok: true, node: rt.node, cli: rt.cli };
    } catch (e: any) {
      // eslint-disable-next-line no-console
      console.error("[pi] runtime resolve failed:", e?.message || String(e));
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // ---- projects / sessions ------------------------------------------------
  ipcMain.handle("app:getProjects", async (): Promise<ProjectSummary[]> => {
    const scanned = await scanProjects();
    const cfg = getConfig();
    const pinned = cfg.pinnedProjects || [];
    const pinnedThreads = cfg.pinnedThreads || [];
    const pinnedProjectSet = new Set(pinned.map((cwd) => cwd.toLowerCase()));
    const pinnedThreadSet = new Set(pinnedThreads.map((file) => file.toLowerCase()));
    const pinnedThreadRank = new Map(pinnedThreads.map((file, index) => [file.toLowerCase(), index]));
    const archived = new Set((cfg.archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((cfg.archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    const visibleScanned = scanned
      .filter((project) => !archived.has(project.cwd.toLowerCase()))
      .map((project) => {
        const threads = project.threads
          .filter((thread) => !archivedThreads.has(thread.file.toLowerCase()))
          .map((thread) => ({
            ...thread,
            pinned: pinnedThreadSet.has(thread.file.toLowerCase()),
          }))
          .sort((a, b) => {
            const aPinned = a.pinned ? 0 : 1;
            const bPinned = b.pinned ? 0 : 1;
            if (aPinned !== bPinned) return aPinned - bPinned;
            if (a.pinned && b.pinned) {
              return (
                (pinnedThreadRank.get(a.file.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
                (pinnedThreadRank.get(b.file.toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
              );
            }
            return b.updatedAt - a.updatedAt;
          });
        return {
          ...project,
          pinned: pinnedProjectSet.has(project.cwd.toLowerCase()),
          openedAt: openedProjects.get(project.cwd.toLowerCase())?.openedAt,
          threads,
        };
      });
    const visibleOpened = Array.from(openedProjects.values())
      .filter((project) => !archived.has(project.cwd.toLowerCase()))
      .filter((project) => !visibleScanned.some((scannedProject) => sameDir(scannedProject.cwd, project.cwd)))
      .filter((project) => !pinnedProjectSet.has(project.cwd.toLowerCase()))
      .map((project) => ({ ...project, pinned: false, threads: [] }));
    const visiblePinned = pinned.filter((cwd) => !archived.has(cwd.toLowerCase()));
    const byCwd = new Map(visibleScanned.map((p) => [p.cwd.toLowerCase(), p]));
    const result: ProjectSummary[] = [];
    for (const cwd of visiblePinned) {
      const existing = byCwd.get(cwd.toLowerCase());
      if (existing) result.push(existing);
      else result.push({ cwd, name: cwd.split(/[\\/]/).filter(Boolean).pop() || cwd, threads: [], pinned: true });
    }
    const unpinned = [
      ...visibleScanned.filter((project) => !pinnedProjectSet.has(project.cwd.toLowerCase())),
      ...visibleOpened,
    ];
    const openedRank = new Map(openedProjectOrder.map((cwd, index) => [cwd, index]));
    unpinned.sort((a, b) => {
      const aRank = openedRank.get(a.cwd.toLowerCase());
      const bRank = openedRank.get(b.cwd.toLowerCase());
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return 0;
    });
    result.push(...unpinned);
    return result;
  });

  ipcMain.handle("app:searchThreads", async (_e, query: string): Promise<ThreadSearchHit[]> => {
    const archived = new Set((getConfig().archivedProjects || []).map((cwd) => cwd.toLowerCase()));
    const archivedThreads = new Set((getConfig().archivedThreads || []).map((thread) => thread.file.toLowerCase()));
    return (await searchThreads(query)).filter(
      (hit) => !archived.has(hit.cwd.toLowerCase()) && !archivedThreads.has(hit.file.toLowerCase()),
    );
  });

  ipcMain.handle("app:getTotalUsage", () => getTotalUsage());

  ipcMain.handle("app:openProject", async (_e, absPath: string) => {
    if (!absPath || !existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new Error("Not a directory: " + absPath);
    }
    const name = absPath.split(/[\\/]/).filter(Boolean).pop() || absPath;
    const key = absPath.toLowerCase();
    lastOpenCwd = absPath;
    openedProjects.set(key, { cwd: absPath, name, threads: [], pinned: false, openedAt: Date.now() });
    openedProjectOrder = [key, ...openedProjectOrder.filter((cwd) => cwd !== key)];
    return { cwd: absPath, name };
  });

  ipcMain.handle("app:unpinProject", (_e, absPath: string) => {
    const cfg = getConfig();
    const target = typeof absPath === "string" ? absPath.toLowerCase() : "";
    updateConfig({ pinnedProjects: (cfg.pinnedProjects || []).filter((p) => p.toLowerCase() !== target) });
    return true;
  });

  ipcMain.handle("app:setProjectPinned", (_e, args: { cwd?: string; pinned?: boolean }) => {
    const cwd = typeof args?.cwd === "string" ? args.cwd.trim() : "";
    if (!cwd) throw new Error("Project path is required");
    const cfg = getConfig();
    const target = cwd.toLowerCase();
    const next = (cfg.pinnedProjects || []).filter((path) => path.toLowerCase() !== target);
    if (args?.pinned) next.unshift(cwd);
    return updateConfig({ pinnedProjects: next });
  });

  ipcMain.handle("app:setThreadPinned", (_e, args: { file?: string; pinned?: boolean }) => {
    const file = typeof args?.file === "string" ? args.file.trim() : "";
    if (!file) throw new Error("Thread file is required");
    const cfg = getConfig();
    const target = file.toLowerCase();
    const next = (cfg.pinnedThreads || []).filter((path) => path.toLowerCase() !== target);
    if (args?.pinned) next.unshift(file);
    return updateConfig({ pinnedThreads: next });
  });

  // Pre-warm the standby pi process for the project the user is looking at, so
  // a subsequent "new task" adopts an already-booted process (~0.5s) instead of
  // cold-starting (~5s). Re-targets the spare when the active project changes.
  ipcMain.handle("app:prewarm", (_e, cwd: string) => {
    if (!cwd || typeof cwd !== "string") return { ok: false };
    lastOpenCwd = cwd;
    if (warmHandle && !sameDir(warmHandle.bridge.cwd, cwd)) dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });

  ipcMain.handle("app:showOpenDialog", async (_e, kind: "folder" | "file" | "files") => {
    const w = getWin();
    const properties: any[] =
      kind === "folder"
        ? ["openDirectory", "createDirectory"]
        : kind === "files"
          ? ["openFile", "multiSelections"]
          : ["openFile"];
    const language = getConfig().language;
    const res = await dialog.showOpenDialog(w!, {
      properties,
      title: kind === "folder"
        ? language === "zh" ? "打开项目文件夹" : "Open project folder"
        : language === "zh" ? "添加文件" : "Attach files",
    });
    if (res.canceled) return null;
    return kind === "folder" ? res.filePaths[0] : res.filePaths;
  });

  // ---- files / preview ----------------------------------------------------
  ipcMain.handle("app:getFileTree", (_e, cwd: string, rel?: string) => listDir(cwd, rel));
  ipcMain.handle("app:fileExists", (_e, absPath: string) => {
    try {
      return !!absPath && statSync(absPath).isFile();
    } catch {
      return false;
    }
  });
  ipcMain.handle("app:readPreview", (_e, absPath: string, projectRoot?: string) => {
    const payload = readPreview(absPath);
    return payload.kind === "html"
      ? { ...payload, previewUrl: createHtmlPreviewUrl(absPath, projectRoot) }
      : payload;
  });
  ipcMain.handle("app:stageClipboardFile", (_e, args: { name?: string; mimeType?: string; data?: string }) => {
    return stageClipboardFile(args || {});
  });
  ipcMain.handle("app:savePreviewHtml", (_e, args: { absPath?: string; projectRoot?: string; html?: string }) => {
    return writePreviewHtml(args?.absPath || "", args?.projectRoot, args?.html || "");
  });
  ipcMain.handle("app:showFileContextMenu", (event, absPath: string) => {
    if (!absPath || !existsSync(absPath)) return { ok: false, error: "File not found" };
    const language = getConfig().language;
    const menu = Menu.buildFromTemplate([
      {
        label: language === "zh" ? "在资源管理器中显示" : "Show in File Explorer",
        click: () => shell.showItemInFolder(absPath),
      },
      {
        label: language === "zh" ? "使用默认应用打开" : "Open with Default App",
        click: () => void shell.openPath(absPath),
      },
    ]);
    menu.popup({ window: BrowserWindow.fromWebContents(event.sender) || undefined });
    return { ok: true };
  });

  // ---- settings: models.json / settings.json / diagnostics ----------------
  ipcMain.handle("settings:getModels", () => readModelsFile());
  ipcMain.handle(
    "settings:testModel",
    (_e, args: { providerId: string; provider: Record<string, unknown>; modelId: string }) =>
      testModelAvailability(args.providerId, args.provider as any, args.modelId),
  );
  ipcMain.handle("settings:saveModels", (_e, providers: Record<string, unknown>) => {
    writeModelsProviders(providers as any);
    // The standby process also caches its model registry. Recreate it now so a
    // new task opened after saving does not adopt a stale pre-save process.
    dropWarmBridge();
    ensureWarmBridge();
    // Return the user-facing form so the Settings panel immediately reflects
    // the canonical `/v1` convention after saving (runtime storage may differ
    // for Anthropic).
    return { ok: true, models: readModelsFile() };
  });
  ipcMain.handle("settings:getThinking", () => readThinking());
  ipcMain.handle("settings:saveThinking", (_e, patch: Record<string, unknown>) => writeThinking(patch as any));
  ipcMain.handle("settings:getDiagnostics", () => getDiagnostics());
  ipcMain.handle("settings:openPath", async (_e, abs: string) => {
    try {
      const err = await shell.openPath(abs);
      return err ? { ok: false, error: err } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:showItem", (_e, abs: string) => {
    try {
      shell.showItemInFolder(abs);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });
  ipcMain.handle("settings:openAgentDir", async () => {
    const err = await shell.openPath(getAgentDir());
    return err ? { ok: false, error: err } : { ok: true };
  });
  // expose resolved paths so the renderer can label buttons without guessing
  ipcMain.handle("settings:getPaths", () => ({
    agentDir: getAgentDir(),
    models: getModelsPath(),
    settings: getSettingsPath(),
    auth: getAuthPath(),
  }));

  // ---- threads (pi bridges) ----------------------------------------------
  /**
   * Instant thread load for the UI. Reading the transcript from the .jsonl on
   * disk takes milliseconds, so a clicked thread renders immediately instead of
   * waiting ~5s for a pi process to boot. When a live bridge already backs the
   * session we return its live state instead (connected:true); otherwise we
   * return disk data with connected:false and the renderer connects lazily/in
   * the background via thread:open.
   */
  ipcMain.handle("thread:loadHistory", async (_e, args: { cwd: string; sessionFile: string }) => {
    const { cwd, sessionFile } = args;
    const permission = resolvePermission(sessionFile, undefined);
    const existing = bridges.get(sessionFile);
    if (existing) return { connected: true, ...(await gatherThread(existing.bridge, sessionFile, existing.permission)) };
    const hist = await readThreadHistory(sessionFile);
    return {
      connected: false,
      threadId: sessionFile,
      cwd: hist.cwd || cwd,
      sessionFile,
      sessionName: hist.sessionName,
      model: hist.model,
      thinkingLevel: hist.thinkingLevel || "off",
      isStreaming: false,
      messages: hist.messages,
      branchMessages: hist.branchMessages,
      models: [],
      commands: getSkillCommands(hist.cwd || cwd),
      permission,
    };
  });

  ipcMain.handle("thread:open", async (_e, args: { cwd: string; sessionFile?: string; name?: string; permission?: PermissionLevel }) => {
    const { cwd, sessionFile, name } = args;
    if (sessionFile && bridges.has(sessionFile)) {
      const existing = bridges.get(sessionFile)!;
      return gatherThread(existing.bridge, sessionFile, existing.permission);
    }
    lastOpenCwd = cwd;
    if ((getConfig().lastThreadCwd || "") !== cwd) updateConfig({ lastThreadCwd: cwd });
    const permission = resolvePermission(sessionFile, args.permission);
    let handle: BridgeHandle | null = null;
    let adopted = false;
    const spareAtEntry = !!warmHandle;
    // Try to adopt the warm spare: switching a booted process is ~0.5s vs
    // ~5s for a cold start. A dead spare is dropped, a spare booted for
    // another project is replaced so the standby converges on the project
    // actually in use.
    if (!name && warmHandle) {
      if (!warmHandle.bridge.running) {
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open dropping dead warm spare -> cold start");
        dropWarmBridge();
      } else if (!sameDir(warmHandle.bridge.cwd, cwd)) {
        // eslint-disable-next-line no-console
        console.log(`[pi] thread:open cwd mismatch (warm="${warmHandle.bridge.cwd}" requested="${cwd}") -> cold start, spare respawns for new cwd`);
        dropWarmBridge();
      } else {
        handle = warmHandle;
        warmHandle = null;
        adopted = true;
        warmFailures = 0;
        handle.permission = permission;
        writeGateMode(handle.gateModeFile, permission);
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open adopting warm spare" + (sessionFile ? " (switch_session)" : " (fresh)"));
      }
    }
    if (!handle) {
      if (!spareAtEntry && !name) {
        // eslint-disable-next-line no-console
        console.log("[pi] thread:open cold start (no spare available yet)");
      }
      handle = createHandle(cwd, sessionFile, name, permission, send);
    }
    bridges.set(handle.getId(), handle);
    try {
      await handle.bridge.start(); // no-op for the already-running spare
      if (adopted) {
        if (sessionFile) {
          await handle.bridge.switchSession(sessionFile);
        } else {
          // A warm spare may have opened pi's current session while it was
          // idle. A new task must never inherit that session or its name.
          await handle.bridge.newSession();
        }
      }
      const state: any = await handle.bridge.getState();
      const finalId = state.sessionFile || handle.getId();
      handle.setId(finalId);
      // Persist the chosen level keyed by the real session file so reopening resumes it.
      if (state.sessionFile) {
        const perms = getConfig().threadPermissions;
        if (perms[state.sessionFile] !== permission) updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: permission } });
      }
      const gathered = await gatherThread(handle.bridge, finalId, permission);
      if (!sessionFile) {
        // Opening without a session file is the explicit "New thread" flow.
        // The process may have been a warm spare whose previous session name
        // is still visible in its state; never let that metadata or transcript
        // cross the new-thread boundary.
        return {
          ...gathered,
          sessionName: null,
          messages: [],
          branchMessages: [],
          isStreaming: false,
          isNewSession: true,
        };
      }
      return gathered;
    } catch (e) {
      bridges.delete(handle.getId());
      removeGateModeFile(handle.gateModeFile);
      handle.bridge.stop();
      throw e;
    } finally {
      ensureWarmBridge(); // keep exactly one spare booted for the next open
    }
  });

  ipcMain.handle("thread:setPermission", async (_e, args: { threadId: string; permission: PermissionLevel }) => {
    const perms = getConfig().threadPermissions;
    updateConfig({ threadPermissions: { ...perms, [args.threadId]: args.permission } });
    // Flip the running thread's gate mode live; the pi process keeps running.
    const h = bridges.get(args.threadId);
    if (h) {
      h.permission = args.permission;
      writeGateMode(h.gateModeFile, args.permission);
    }
    return { ok: true };
  });

  ipcMain.handle("thread:delete", async (_e, file: string) => {
    const target = assertDeletableSessionFile(typeof file === "string" ? file : "");

    // Stop every local bridge that points at this session before unlinking it;
    // otherwise a live Pi process can recreate or continue writing the file.
    for (const [id, handle] of Array.from(bridges.entries())) {
      if (!sameSessionFile(id, target) && !sameSessionFile(handle.getId(), target)) continue;
      bridges.delete(id);
      handle.bridge.stop();
    }
    if (warmHandle && sameSessionFile(warmHandle.getId(), target)) dropWarmBridge();

    await unlinkSessionWithRetry(target);

    const current = getConfig();
    const threadPermissions = Object.fromEntries(
      Object.entries(current.threadPermissions || {}).filter(([path]) => !sameSessionFile(path, target)),
    );
    const config = updateConfig({
      pinnedThreads: (current.pinnedThreads || []).filter((path) => !sameSessionFile(path, target)),
      archivedThreads: (current.archivedThreads || []).filter((thread) => !sameSessionFile(thread.file, target)),
      threadPermissions,
    });

    for (const [localId] of Array.from(remoteLocalToId.entries())) {
      if (sameSessionFile(localId, target)) remoteLocalToId.delete(localId);
    }
    for (const [remoteId, draft] of Array.from(remoteDrafts.entries())) {
      if (draft.sessionFile && sameSessionFile(draft.sessionFile, target)) remoteDrafts.delete(remoteId);
    }
    invalidateRemoteProjects();
    send("pi:projects-changed", { sessionFile: target });
    return { ok: true, config };
  });

  ipcMain.handle("thread:close", (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) {
      h.bridge.stop();
      bridges.delete(threadId);
    }
    return true;
  });

  ipcMain.handle("thread:prompt", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.prompt(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:steer", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.steer(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:followUp", async (_e, args: { threadId: string; text: string; images?: unknown[]; attachments?: Attachment[] }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open: " + args.threadId);
    const { text, images } = processAttachments(args.attachments, args.text || "");
    const merged = [...(args.images || []), ...images];
    await h.bridge.followUp(text, merged.length ? merged : undefined);
    return { ok: true };
  });

  ipcMain.handle("thread:abort", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (h) await h.bridge.abort();
    return true;
  });

  ipcMain.handle("thread:setModel", async (_e, args: { threadId: string; provider: string; modelId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const model = await h.bridge.setModel(args.provider, args.modelId);
    // Pi clamps the current thinking level when the selected model exposes a
    // narrower thinkingLevelMap. Return the effective value so the renderer's
    // badge stays in sync with the live session instead of showing stale max.
    const state: any = await h.bridge.getState();
    return { model, thinkingLevel: state?.thinkingLevel ?? null };
  });

  ipcMain.handle("thread:getModels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { models: [] };
    return h.bridge.getAvailableModels();
  });

  ipcMain.handle("thread:refreshModels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { models: [] };
    return h.bridge.refreshModels();
  });

  ipcMain.handle("thread:setThinking", async (_e, args: { threadId: string; level: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    await h.bridge.setThinkingLevel(args.level);
    const state: any = await h.bridge.getState();
    return { thinkingLevel: state?.thinkingLevel ?? args.level };
  });

  ipcMain.handle("thread:getThinkingLevels", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { levels: ["off"] };
    return h.bridge.getAvailableThinkingLevels();
  });

  ipcMain.handle("thread:newSession", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) throw new Error("Thread not open");
    const res: any = await h.bridge.newSession();
    if (res?.cancelled) return { cancelled: true };
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || threadId;
    h.setId(newId);
    return { cancelled: false, ...(await gatherThread(h.bridge, newId, h.permission)) };
  });

  ipcMain.handle("thread:getBranchMessages", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { messages: [] };
    const entries = await h.bridge.getEntries();
    return { messages: activeBranchMessages(entries) };
  });

  const finishBranch = async (h: BridgeHandle, oldId: string, selectedText?: string) => {
    const state: any = await h.bridge.getState();
    const newId = state.sessionFile || oldId;
    h.setId(newId);
    const perms = getConfig().threadPermissions;
    if (state.sessionFile && perms[state.sessionFile] !== h.permission) {
      updateConfig({ threadPermissions: { ...perms, [state.sessionFile]: h.permission } });
    }
    return { ...(await gatherThread(h.bridge, newId, h.permission)), selectedText };
  };

  ipcMain.handle("thread:fork", async (_e, args: { threadId: string; entryId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    await h.bridge.branchAt(args.entryId);
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Fork did not create a new session");
    return { cancelled: false, ...(await finishBranch(h, args.threadId)) };
  });

  ipcMain.handle("thread:clone", async (_e, args: { threadId: string; entryId: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    const previousFile = (await h.bridge.getState() as any)?.sessionFile;
    await h.bridge.branchAt(args.entryId);
    const currentFile = (await h.bridge.getState() as any)?.sessionFile;
    if (!currentFile || currentFile === previousFile) throw new Error("Clone did not create a new session");
    return { cancelled: false, ...(await finishBranch(h, args.threadId)) };
  });

  ipcMain.handle("thread:setName", async (_e, args: { threadId: string; name: string }) => {
    const h = bridges.get(args.threadId);
    if (!h) throw new Error("Thread not open");
    return h.bridge.setSessionName(args.name);
  });

  ipcMain.handle("thread:getStats", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return null;
    return h.bridge.getSessionStats();
  });

  ipcMain.handle("thread:getCommands", async (_e, threadId: string) => {
    const h = bridges.get(threadId);
    if (!h) return { commands: [] };
    const response: any = await h.bridge.getCommands();
    return { ...response, commands: synchronizedCommands(response?.commands, h.bridge.cwd) };
  });

  ipcMain.handle("thread:extuiResponse", (_e, args: { threadId: string; id: string; payload: Record<string, unknown> }) => {
    const h = bridges.get(args.threadId);
    if (h) h.bridge.respondExtUi(args.id, args.payload || {});
    return true;
  });

  // ---- plugins (pi packages + standalone skills) -------------------------
  ipcMain.handle("plugins:getPackages", () => listPackages());
  ipcMain.handle("plugins:setPackageEnabled", (_e, args: { source: string; enabled: boolean }) => {
    setPackageEnabled(args.source, args.enabled);
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  ipcMain.handle("plugins:installPackage", async (_e, source: string) => {
    const res = await runPiCli(["install", source]);
    const installOutput = (res.stdout + res.stderr).trim();
    if (res.code !== 0) {
      // Never add a failed/partial install to settings: Pi loads configured
      // packages before RPC starts, so one bad entry can brick every thread.
      return { ok: false, output: installOutput || `pi install exited with code ${res.code}` };
    }
    const probe = await probePiStartup();
    if (!probe.ok) {
      // Keep the package installed but disable autoload. This is reversible in
      // Settings and immediately restores thread startup.
      setPackageEnabled(source, false);
      dropWarmBridge();
      ensureWarmBridge();
      return {
        ok: false,
        output: [installOutput, "Installed, but Pi could not load the extension. It was disabled automatically.", probe.output]
          .filter(Boolean)
          .join("\n"),
      };
    }
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: installOutput };
  });
  ipcMain.handle("plugins:removePackage", async (_e, source: string) => {
    const res = await runPiCli(["remove", source]);
    removePackageEntry(source); // ensure it is gone from settings regardless of CLI result
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true, output: (res.stdout + res.stderr).trim() };
  });
  ipcMain.handle("plugins:getSkills", () => listManagedSkills());
  ipcMain.handle("plugins:setSkillEnabled", (_e, args: { path: string; enabled: boolean }) => {
    setSkillEnabled(args.path, args.enabled);
    // A skill is loaded during pi startup. Recreate the warm spare so newly
    // opened tasks immediately observe enable/disable changes.
    dropWarmBridge();
    ensureWarmBridge();
    return { ok: true };
  });
  // Update installed extension packages. With no source, updates all of them
  // (`pi update --extensions`); with a source, updates just that package. pi
  // checks installed vs latest internally and only touches outdated packages.
  ipcMain.handle("plugins:updatePackages", async (_e, source?: string) => {
    const args = source ? ["update", source] : ["update", "--extensions"];
    const res = await runPiCli(args);
    if (res.code === 0) {
      dropWarmBridge();
      ensureWarmBridge();
    }
    return { ok: res.code === 0, code: res.code, output: (res.stdout + res.stderr).trim() };
  });
  ipcMain.handle("skillsHub:leaderboard", () => getSkillsHubLeaderboard());
  ipcMain.handle("skillsHub:search", (_e, query: string) => searchSkillsHub(typeof query === "string" ? query : ""));
  ipcMain.handle("skillsHub:detail", (_e, skill: Parameters<typeof getSkillDetails>[0]) => getSkillDetails(skill));
  ipcMain.handle("skillsHub:install", async (_e, args: { source: string; skillId: string }) => {
    const result = await installSkillFromHub(args.source, args.skillId);
    if (result.ok) {
      // The official CLI writes to ~/.pi/agent/skills. Recreate the warm
      // bridge so a newly opened task can discover the skill immediately.
      dropWarmBridge();
      ensureWarmBridge();
    }
    return result;
  });

  // ---- automation (scheduled tasks) --------------------------------------
  ipcMain.handle("automation:getTasks", () => reloadConfig().automationTasks);
  ipcMain.handle("automation:saveTask", (_e, task: AutomationTask) => {
    const tasks = reloadConfig().automationTasks;
    const idx = tasks.findIndex((t) => t.id === task.id);
    const next = idx >= 0 ? tasks.map((t) => (t.id === task.id ? { ...t, ...task } : t)) : [...tasks, task];
    updateConfig({ automationTasks: next });
    return { ok: true };
  });
  ipcMain.handle("automation:deleteTask", (_e, id: string) => {
    removeAutomationTask(typeof id === "string" ? id : "");
    return { ok: true };
  });
  ipcMain.handle("automation:runNow", async (_e, id: string) => {
    await runTaskNow(id);
    return { ok: true };
  });

  // ---- update pi core -----------------------------------------------------
  ipcMain.handle("app:checkAppUpdate", () => checkForAppUpdate());
  ipcMain.handle("app:downloadAppUpdate", async () => downloadAppUpdate((p) => send("pi:appUpdate", p)));
  ipcMain.handle("app:installAppUpdate", () => installAppUpdate());
  ipcMain.handle("app:checkCoreUpdate", () => checkForCoreUpdate());

  ipcMain.handle("app:updatePi", async () => {
    // Resolve first so the source is known for sure (the old guard consulted
    // a cache that was empty when no thread had been opened yet — a race).
    let managed = false;
    let kind = runtimeKind();
    try {
      await resolvePiRuntime(getConfig().piCliPath);
      managed = isAppManagedRuntime();
      kind = runtimeKind();
    } catch {
      managed = false; // fall through to the CLI path, which surfaces the same error
    }

    if (managed) {
      // App-managed runtime (bundled or a previous in-app update): pi's own
      // `update` refuses these installs, so run our updater instead. It
      // installs the new tree under userData/runtime/versions/<version> and
      // switches current.json; new threads pick it up without replacing files
      // held by the currently running app.
      const result = await installCoreUpdate((p) => send("pi:coreUpdate", p));
      if (result.updated) {
        dropWarmBridge(); // standby runs the old version; respawn from the new tree
        ensureWarmBridge();
      }
      return {
        ok: result.ok,
        managed: true,
        kind,
        updated: result.updated,
        from: result.from ?? null,
        to: result.to ?? null,
        output: result.message,
      };
    }

    // System-installed pi (npm/pnpm global): it can self-update.
    const res = await runPiCli(["update"]);
    resetPiRuntime(); // pick up the new version on next thread open
    return { ok: res.code === 0, managed: false, kind, code: res.code, output: (res.stdout + res.stderr).trim() };
  });

  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });

  // ---- edit menu (clipboard on the focused field) ------------------------
  ipcMain.handle("app:editAction", (_e, action: "copy" | "cut" | "paste" | "delete" | "selectAll") => {
    const wc = getWin()?.webContents;
    if (!wc) return { ok: false };
    if (action === "copy") wc.copy();
    else if (action === "cut") wc.cut();
    else if (action === "paste") wc.paste();
    else if (action === "delete") wc.delete();
    else if (action === "selectAll") wc.selectAll();
    return { ok: true };
  });

  // ---- window chrome (frameless) -----------------------------------------
  ipcMain.handle("window:minimize", () => getWin()?.minimize());
  ipcMain.handle("window:maximize", () => {
    const w = getWin();
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
  });
  ipcMain.handle("window:close", () => {
    const w = getWin();
    if (!w || w.isDestroyed()) return false;
    // The custom title-bar close button is a hide-to-tray action. The native
    // BrowserWindow close listener below still covers Alt+F4 and other native
    // close paths.
    w.hide();
    return true;
  });
  ipcMain.handle("window:isMaximized", () => !!getWin()?.isMaximized());

  // ---- background scheduler ----------------------------------------------
  startScheduler((p) => send("pi:automation", p));

  // ---- warm spare ----------------------------------------------------------
  // Boot one standby pi process so the first thread open is fast too.
  ensureWarmBridge();
}
