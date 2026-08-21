/** Shared renderer-side types. Pi message shapes are kept loose (`any`) because
 *  the renderer intentionally has no dependency on the pi packages. */

export interface ThreadSummary {
  file: string;
  id: string;
  title: string;
  preview: string;
  updatedAt: number;
  messageCount: number;
  pinned?: boolean;
}

export interface ProjectSummary {
  cwd: string;
  name: string;
  threads: ThreadSummary[];
  pinned?: boolean;
  /** Set only for projects opened during the current desktop session. */
  openedAt?: number;
}

export interface ArchivedThread {
  file: string;
  cwd: string;
  title: string;
}

/** A full-text search hit across session transcripts. */
export interface ThreadSearchHit {
  file: string;
  cwd: string;
  title: string;
  projectName: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
  matchCount: number;
}

/** Thread permission level. Sandbox auto-allows low-risk explicit operations and gates destructive, sensitive, external-code, subagent, and unclassified actions; full is unrestricted. */
export type PermissionLevel = "sandbox" | "full";

/** An installed pi package (from settings.json `packages`). */
export interface PluginPackage {
  /** Raw source spec, e.g. "npm:foo", "git:host/repo@ref", or a local path. */
  source: string;
  /** Display name derived from the source. */
  name: string;
  kind: "npm" | "git" | "local";
  /** True when the package loads its resources; false when disabled via autoload=false. */
  enabled: boolean;
}

/** A standalone skill discovered in a skills directory. */
export interface SkillInfo {
  name: string;
  path: string;
  /** The root directory it was discovered under. */
  root: string;
  enabled: boolean;
  /** The description exposed by Pi for `/skill:<name>`. */
  description?: string;
}

/** A public skill returned by the skills.sh directory. */
export interface SkillHubSkill {
  /** Stable directory id, e.g. `vercel-labs/skills/find-skills`. */
  id: string;
  skillId: string;
  name: string;
  /** Repository or well-known source understood by the skills CLI. */
  source: string;
  installs: number;
  url: string;
}

/** Detail payload for one public skill. */
export interface SkillHubDetail extends SkillHubSkill {
  description: string;
  files: { path: string; contents?: string }[];
  hash: string | null;
  installCommand: string;
  markdown?: string;
}

export type ScheduleFrequency = "hourly" | "daily" | "weekly";

export interface TaskSchedule {
  frequency: ScheduleFrequency;
  /** hourly: minute of the hour (0-59). */
  minute?: number;
  /** daily/weekly: "HH:MM" (24h). */
  time?: string;
  /** weekly: days of week, 0=Sun .. 6=Sat. */
  days?: number[];
}

export interface AutomationTask {
  id: string;
  name: string;
  cwd: string;
  prompt: string;
  schedule: TaskSchedule;
  enabled: boolean;
  permission: PermissionLevel;
  lastRunAt?: number;
  lastRunSlot?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
  /** Maps the UI effort level to the provider-specific effort value. */
  thinkingLevelMap?: Record<string, string | null>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: any; contentIndex?: number };

/** A local file carried by a user message. The path is retained for matching
 * and future actions, but the chat bubble only needs to show the file name. */
export interface ViewAttachment {
  name: string;
  path?: string;
  note?: string;
  error?: string;
}

export interface ViewMessage {
  /** stable key */
  key: string;
  /** Stable Pi session entry id used by message-level branching. */
  branchEntryId?: string;
  role: "user" | "assistant" | "system";
  timestamp?: number;
  /** user/system plain text (may include image blocks for user) */
  text?: string;
  images?: { dataUrl: string; mimeType: string }[];
  attachments?: ViewAttachment[];
  /** assistant structured blocks */
  blocks?: ContentBlock[];
  /** how a user message was submitted while the agent was working */
  sendKind?: "steer" | "followUp";
  /** provider/model for assistant footer */
  provider?: string;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ToolRun {
  id: string;
  name: string;
  args: any;
  running: boolean;
  /** Assistant content index used to reconcile provider calls before an ID exists. */
  contentIndex?: number;
  /** True after Pi emits a tool result, including an empty successful result. */
  completed?: boolean;
  isError?: boolean;
  resultText?: string;
  partialText?: string;
  argsStr?: string;
  startedAt?: number;
  endedAt?: number;
}

/** A follow-up the user queued (Enter) while the agent is streaming. Held in
 * the renderer so it can be re-edited or promoted to steering before delivery. */
export interface PendingFollowUp {
  text: string;
  images: PendingImage[];
  files: PendingFile[];
  htmlReferences?: HtmlElementReference[];
}

export interface ThreadState {
  cwd: string;
  sessionFile: string | null;
  sessionName: string | null;
  /** True while this view represents a fresh unnamed session. */
  isNewSession?: boolean;
  /** True while the new-session RPC is replacing the previous conversation. */
  creatingSession?: boolean;
  model: ModelInfo | null;
  models: ModelInfo[];
  thinking: string;
  levels: string[];
  commands: any[];
  /** True while the backing pi process is still booting (optimistic open). */
  loading?: boolean;
  /** True once a live pi process backs this thread. A thread can show its full
   *  transcript (read from disk) while still disconnected; interaction connects. */
  connected?: boolean;
  isStreaming: boolean;
  messages: ViewMessage[];
  streaming: ViewMessage | null;
  toolRuns: Record<string, ToolRun>;
  error?: string;
  /** Permission level the thread's pi process runs under. */
  permission: PermissionLevel;
  /** text injected by an extension via set_editor_text */
  pendingEditorText?: string;
  /** Follow-up queued via Enter while streaming; delivered when the agent settles. */
  pendingFollowUp?: PendingFollowUp | null;
}

export interface PreviewPayload {
  name: string;
  ext: string;
  size: number;
  kind: "text" | "markdown" | "html" | "image" | "docx" | "xlsx" | "pptx" | "unsupported" | "toobig" | "missing";
  mime?: string;
  text?: string;
  base64?: string;
  lang?: string;
  truncated?: boolean;
  message?: string;
  /** Isolated pi-preview:// URL used for HTML plus its local CSS/JS/assets. */
  previewUrl?: string;
}

export interface ExtUiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  text?: string;
  timeout?: number;
  [key: string]: unknown;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "warning" | "error";
  text: string;
}

export interface AppConfig {
  piCliPath: string;
  pinnedProjects: string[];
  pinnedThreads: string[];
  archivedProjects: string[];
  archivedThreads: ArchivedThread[];
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  theme: "dark" | "light" | "system";
  language: "en" | "zh";
  remoteSignalingUrl: string;
  remoteSignalingEnabled: boolean;
  remoteStunUrls: string[];
}

export interface AppRuntime {
  ok: boolean;
  node?: string;
  cli?: string;
  error?: string;
}

/** Read-only snapshot of the pi runtime + config locations, for the Settings panel. */
export interface Diagnostics {
  node: string | null;
  cli: string | null;
  nodeVersion: string | null;
  piVersion: string | null;
  agentDir: string;
  sessionsDir: string;
  settingsPath: string;
  authPath: string;
  modelsPath: string;
  settingsExists: boolean;
  authExists: boolean;
  modelsExists: boolean;
  /** Where the active pi runtime came from. */
  runtimeKind: "override" | "userData" | "bundled" | "system" | "unknown";
  /** True when the runtime is managed by the app (bundled or app-updated). */
  bundled: boolean;
  error: string | null;
}

export type ApiType = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";

/** A single model entry inside a provider's `models` array (models.json). */
export interface ModelDef {
  id: string;
  name?: string;
  api?: ApiType;
  /** Optional per-model endpoint override. The Settings UI displays it with `/v1`. */
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Record<string, unknown>;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
  /** preserve any unknown fields verbatim on round-trip */
  [key: string]: unknown;
}

/** A provider entry in models.json. */
export interface ProviderDef {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  compat?: Record<string, unknown>;
  models?: ModelDef[];
  modelOverrides?: Record<string, unknown>;
  oauth?: unknown;
  [key: string]: unknown;
}

/** Top-level shape of ~/.pi/agent/models.json. */
export interface ModelsFile {
  providers: Record<string, ProviderDef>;
  [key: string]: unknown;
}

/** The thinking-related slice of settings.json that the GUI edits. */
export interface ThinkingDefaults {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  hideThinkingBlock?: boolean;
}

export interface FileNode {
  name: string;
  rel: string;
  abs: string;
  isDir: boolean;
  ext: string;
  size: number;
}

/** A pasted/dropped image held in the composer before sending (base64). */
export interface PendingImage {
  id: string;
  dataUrl: string;
  base64: string;
  mimeType: string;
}

/** A local file attached in the composer (absolute path resolved by main). */
export interface PendingFile {
  abs: string;
  name: string;
}

/** A selected HTML element kept as a structured composer reference. */
export interface HtmlElementReference {
  id: string;
  reference: string;
  selector?: string;
  tagName?: string;
  text?: string;
  outerHTML?: string;
  styles?: Record<string, string | number>;
}
