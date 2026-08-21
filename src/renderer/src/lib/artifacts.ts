import type { ToolRun, ViewMessage } from "./types";

export interface FileArtifact {
  path: string;
  name: string;
  displayPath: string;
  ext: string;
  action: "created" | "updated";
}

const FILE_TOOL = /(?:^|[_-])(write|edit|create|save|export)(?:[_-]|$)/i;
const COMMAND_TOOL = /(?:^|[_-])(bash|shell|exec|execute|command|run|python)(?:[_-]|$)/i;
const OUTPUT_HINT = /(?:已生成|已创建|已保存|已就绪|输出(?:文件|路径)?|生成(?:文件|路径)?|保存(?:为|到|路径)?|写入(?:到)?|产物|generated|created|saved|written|output|exported|ready at)/i;
const OUTPUT_EXTENSIONS =
  "html?|pdf|csv|xlsx?|docx|pptx|json|md|txt|xml|svg|png|jpe?g|gif|webp|zip|tar|gz|mp4|webm|py|js|jsx|ts|tsx|css";
const ABSOLUTE_OUTPUT_PATH = new RegExp(
  String.raw`(?:[a-zA-Z]:[\\/]|/[a-zA-Z]/)[^"'` + "`" + String.raw`<>\r\n|?*]+?\.(?:${OUTPUT_EXTENSIONS})`,
  "gi",
);
const QUOTED_OUTPUT_PATH = new RegExp(
  String.raw`["'` + "`" + String.raw`]([^"'` + "`" + String.raw`<>\r\n|?*]+?\.(?:${OUTPUT_EXTENSIONS}))["'` + "`" + String.raw`]`,
  "gi",
);
const SIMPLE_OUTPUT_PATH = new RegExp(
  String.raw`(?:^|[\s(（:：])((?:\.{0,2}[\\/])?[\w\u3400-\u9fff@()（）.+ -]+(?:[\\/][\w\u3400-\u9fff@()（）.+ -]+)*\.(?:${OUTPUT_EXTENSIONS}))(?=$|[\s,，。;；:：)）])`,
  "gi",
);
const WINDOWS_ABS = /^[a-zA-Z]:[\\/]/;
const UNC_ABS = /^\\\\/;
const MSYS_ABS = /^\/([a-zA-Z])\/(.+)$/;

function cleanPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/^["']|["']$/g, "");
  return path || null;
}

function pathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path", "filename", "file"]) {
    const path = cleanPath(record[key]);
    if (path) return path;
  }
  return null;
}

function normalizeSegments(path: string): string {
  const slash = path.replace(/\\/g, "/");
  const drive = slash.match(/^([a-zA-Z]:)(\/|$)/)?.[1] || "";
  const rooted = !!drive || slash.startsWith("/");
  const body = drive ? slash.slice(drive.length) : slash;
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!rooted) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const prefix = drive ? `${drive}/` : rooted ? "/" : "";
  return prefix + parts.join("/");
}

/** Resolve Pi tool paths without depending on Node's path module in the renderer. */
export function resolveArtifactPath(rawPath: string, cwd: string): string {
  const raw = rawPath.replace(/\\/g, "/");
  const msys = raw.match(MSYS_ABS);
  if (msys) return normalizeSegments(`${msys[1].toUpperCase()}:/${msys[2]}`);
  if (WINDOWS_ABS.test(rawPath) || UNC_ABS.test(rawPath) || raw.startsWith("/")) {
    return normalizeSegments(raw);
  }
  return normalizeSegments(`${cwd.replace(/\\/g, "/")}/${raw}`);
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

function relativeDisplayPath(path: string, cwd: string): string {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedCwd = normalizeSegments(cwd).replace(/\/+$/, "");
  if (normalizedPath.toLowerCase().startsWith(`${normalizedCwd.toLowerCase()}/`)) {
    return normalizedPath.slice(normalizedCwd.length + 1);
  }
  return normalizedPath;
}

function actionForTool(name: string): FileArtifact["action"] {
  return /edit|patch|replace|update/i.test(name) ? "updated" : "created";
}

function outputPathsFromText(text: string, requireHint: boolean): string[] {
  const found: string[] = [];
  const lines = text.split(/\r?\n/);
  let previousHint = false;
  for (const line of lines) {
    const currentHint = OUTPUT_HINT.test(line);
    const linePaths: string[] = [];
    if (!requireHint || currentHint || previousHint) {
      ABSOLUTE_OUTPUT_PATH.lastIndex = 0;
      QUOTED_OUTPUT_PATH.lastIndex = 0;
      SIMPLE_OUTPUT_PATH.lastIndex = 0;
      for (const match of line.matchAll(ABSOLUTE_OUTPUT_PATH)) linePaths.push(match[0]);
      if (!linePaths.length) {
        for (const match of line.matchAll(QUOTED_OUTPUT_PATH)) linePaths.push(match[1]);
      }
      if (!linePaths.length) {
        for (const match of line.matchAll(SIMPLE_OUTPUT_PATH)) linePaths.push(match[1]);
      }
      found.push(...linePaths);
    }
    previousHint = currentHint && linePaths.length === 0;
  }
  return found;
}

/**
 * Recover successful file outputs from the tool calls stored in a Pi assistant
 * round. Because tool calls are persisted in the session transcript, this also
 * works after reopening an older thread.
 */
export function collectFileArtifacts(
  messages: ViewMessage[],
  toolRuns: Record<string, ToolRun>,
  cwd: string,
): FileArtifact[] {
  const byPath = new Map<string, FileArtifact>();
  const roundToolIds = new Set<string>();

  const addArtifact = (rawPath: string, action: FileArtifact["action"]) => {
    const path = resolveArtifactPath(rawPath, cwd);
    const name = basename(path);
    const key = path.toLowerCase();
    const next: FileArtifact = {
      path,
      name,
      displayPath: relativeDisplayPath(path, cwd),
      ext: extension(name),
      action,
    };
    const previous = byPath.get(key);
    byPath.set(key, previous ? { ...next, action: previous.action === "created" ? "created" : next.action } : next);
  };

  for (const message of messages) {
    for (const block of message.blocks || []) {
      if (block.type === "toolCall") {
        roundToolIds.add(block.id);
        const run = toolRuns[block.id];
        const toolName = run?.name || block.name || "";
        if (!run?.completed || run.running || run.isError) continue;
        if (FILE_TOOL.test(toolName)) {
          const rawPath = pathFromArgs(run?.args) || pathFromArgs(block.arguments);
          if (rawPath) addArtifact(rawPath, actionForTool(toolName));
        }
        continue;
      }
    }
  }

  // A successful script or shell command can create files that never appear in
  // the command arguments (for example `python build_dashboard.py` writing an
  // HTML dashboard internally). Recover only paths printed with an explicit
  // output/create/save hint. Scanning every path in command output would turn
  // `dir`, `ls`, `git status`, and similar workspace inspections into false
  // artifacts for every historical file in the same folder.
  // Do not scan ordinary assistant prose: mentioning an older output file is
  // not evidence that the file changed in this round.
  for (const id of roundToolIds) {
    const run = toolRuns[id];
    if (!run?.completed || run.running || run.isError || !COMMAND_TOOL.test(run.name || "")) continue;
    for (const rawPath of outputPathsFromText(run.resultText || "", true)) {
      addArtifact(rawPath, "created");
    }
  }

  return [...byPath.values()];
}
