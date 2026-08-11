import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { getAgentDir } from "./session-store";

/**
 * Manage pi packages (extensions bundles) and standalone skills.
 *
 * Packages live in `~/.pi/agent/settings.json` under `packages`. pi supports a
 * per-package object form with `autoload: false` to keep a package installed
 * but load none of its resources — that is our enable/disable mechanism, and it
 * is native to pi (reversible and survives `pi list`).
 *
 * Standalone skills are auto-discovered from skills directories. pi has no
 * per-skill disable setting, so we toggle discovery by renaming the skill's
 * entry file (SKILL.md <-> SKILL.md.disabled, or foo.md <-> foo.md.disabled).
 * This is reversible and pi honours it on next start.
 */

export interface PluginPackage {
  source: string;
  name: string;
  kind: "npm" | "git" | "local";
  enabled: boolean;
}

export interface SkillInfo {
  name: string;
  path: string;
  root: string;
  enabled: boolean;
  /** The description Pi uses for the corresponding `/skill:<name>` command. */
  description?: string;
}

type PackageEntry = string | { source: string; autoload?: boolean; [k: string]: unknown };

function settingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(obj: Record<string, unknown>): void {
  const dir = getAgentDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), "utf8");
}

function entrySource(e: PackageEntry): string {
  return typeof e === "string" ? e : e.source;
}

function entryEnabled(e: PackageEntry): boolean {
  return typeof e === "string" ? true : e.autoload !== false;
}

function kindOf(source: string): "npm" | "git" | "local" {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:") || /^(https?|ssh|git):\/\//.test(source) || source.includes("github.com")) return "git";
  return "local";
}

function nameOf(source: string): string {
  let s = source.replace(/^(npm|git):/, "");
  s = s.replace(/^(https?|ssh|git):\/\//, "");
  s = s.split("@").slice(0, s.startsWith("@") ? 2 : 1).join("@") || s;
  const seg = s.split(/[\\/]/).filter(Boolean).pop() || s;
  return seg.replace(/\.git$/, "");
}

export function listPackages(): PluginPackage[] {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  return packages.map((e) => {
    const source = entrySource(e);
    return { source, name: nameOf(source), kind: kindOf(source), enabled: entryEnabled(e) };
  });
}

export function setPackageEnabled(source: string, enabled: boolean): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  const next = packages.map((e): PackageEntry => {
    if (entrySource(e) !== source) return e;
    if (enabled) {
      // Restore to full autoload. Keep any explicit filters the user had.
      if (typeof e === "string") return e;
      const o = { ...e, autoload: true };
      return o;
    }
    // Disable: keep installed, load nothing.
    if (typeof e === "string") return { source, autoload: false };
    return { ...e, autoload: false };
  });
  writeSettings({ ...settings, packages: next });
}

export function addPackage(source: string): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  if (packages.some((e) => entrySource(e) === source)) return;
  writeSettings({ ...settings, packages: [...packages, source] });
}

export function removePackageEntry(source: string): void {
  const settings = readSettings();
  const packages = (settings.packages as PackageEntry[] | undefined) || [];
  writeSettings({ ...settings, packages: packages.filter((e) => entrySource(e) !== source) });
}

/** Run a pi CLI command (install/remove/update/list) and capture its output. */
export function runPiCli(args: string[], onLine?: (line: string) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    let rt: { node: string; cli: string };
    try {
      rt = await resolvePiRuntime(getConfig().piCliPath);
    } catch (e) {
      reject(e);
      return;
    }
    const proc = spawn(rt.node, [rt.cli, ...args], { cwd: getAgentDir(), env: { ...process.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stdout += s;
      s.split(/\r?\n/).forEach((l) => l.trim() && onLine?.(l));
    });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      stderr += s;
      s.split(/\r?\n/).forEach((l) => l.trim() && onLine?.(l));
    });
    proc.on("error", reject);
    proc.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Verify that Pi can still boot and answer RPC requests after a package
 * mutation. `pi install` only proves that npm/git completed; a malformed or
 * incompatible extension may still make every subsequently opened thread
 * exit during extension discovery.
 */
export function probePiStartup(timeoutMs = 20_000): Promise<{ ok: boolean; output: string }> {
  return new Promise(async (resolve) => {
    let rt: { node: string; cli: string };
    try {
      rt = await resolvePiRuntime(getConfig().piCliPath);
    } catch (e) {
      resolve({ ok: false, output: (e as Error)?.message || String(e) });
      return;
    }

    const proc = spawn(rt.node, [rt.cli, "--mode", "rpc", "--no-session", "--offline"], {
      cwd: getAgentDir(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const requestId = `pi-studio-plugin-probe-${Date.now()}`;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (ok: boolean, output: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (proc.exitCode === null) proc.kill();
      resolve({ ok, output: output.trim() });
    };

    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (msg?.type === "response" && msg?.id === requestId) {
            if (msg.success === false) finish(false, msg.error || "Pi startup probe failed");
            else finish(true, "");
          }
        } catch {
          // Ignore non-RPC startup output. PiBridge does the same.
        }
      }
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    proc.on("error", (err) => finish(false, err.message));
    proc.on("exit", (code, signal) => {
      if (!settled) {
        const detail = stderr.trim() || stdout.trim();
        finish(false, `Pi exited during extension loading (code=${code}, signal=${signal})${detail ? `\n${detail}` : ""}`);
      }
    });

    const timer = setTimeout(() => {
      finish(false, `Pi did not answer the startup check within ${Math.round(timeoutMs / 1000)}s${stderr.trim() ? `\n${stderr.trim()}` : ""}`);
    }, timeoutMs);

    proc.stdin.write(JSON.stringify({ id: requestId, type: "get_state" }) + "\n", (err) => {
      if (err) finish(false, err.message);
    });
  });
}

/* ----------------------------- skills ----------------------------- */

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Pi's native locations are `~/.pi/agent/skills` and `<project>/.pi/skills`.
 * Keep the singular `skill` variants for existing local installs, and include
 * the commonly used `~/.agents/skills` location. The order is intentional: it
 * mirrors Pi's native roots followed by the extra `--skill` roots, so a skill
 * name collision has the same winner in the Plugins panel and in `get_commands`.
 */
function skillRoots(cwd?: string): string[] {
  const roots = [join(getAgentDir(), "skills")];
  if (cwd) {
    roots.push(join(cwd, ".pi", "skills"));
  }
  roots.push(join(getAgentDir(), "skill"), join(homedir(), ".agents", "skills"), join(homedir(), ".agents", "skill"));
  if (cwd) {
    roots.push(join(cwd, ".pi", "skill"), join(cwd, ".pi", "agent", "skills"), join(cwd, ".pi", "agent", "skill"));
  }
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = pathKey(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Return every configured skill root that should be passed to `pi --skill`.
 * Pi also scans its native roots, but explicit paths make the desktop command
 * list and project skill loading deterministic; Pi deduplicates repeated files
 * when an explicit root is also a native root. */
export function getAdditionalSkillPaths(cwd?: string): string[] {
  return skillRoots(cwd).filter((root) => existsSync(root));
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Read the small part of SKILL.md frontmatter that determines its command.
 * Pi uses a YAML parser, but skill names are scalar values and descriptions
 * are either scalar or `>`/`|` blocks. Keeping this parser local avoids making
 * the Electron shell depend on the bundled Pi runtime's internal modules while
 * still matching the fields that control discovery.
 */
function readSkillFrontmatter(filePath: string): SkillFrontmatter | null {
  let markdown: string;
  try {
    markdown = readFileSync(filePath, "utf8").replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }

  if (!markdown.startsWith("---")) return {};
  const end = markdown.indexOf("\n---", 3);
  if (end < 0) return {};

  const lines = markdown.slice(4, end).split("\n");
  let name: string | undefined;
  let description: string | undefined;
  let blockMode: "fold" | "literal" | null = null;
  let blockLines: string[] = [];

  const unquote = (value: string): string => {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return trimmed.slice(1, -1).replace(/''/g, "'");
    }
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        return JSON.parse(trimmed) as string;
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed;
  };

  const flushDescription = () => {
    if (!blockMode) return;
    description = blockMode === "literal" ? blockLines.join("\n") : blockLines.join(" ");
    blockMode = null;
    blockLines = [];
  };

  for (const line of lines) {
    const field = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (field) {
      flushDescription();
      const key = field[1];
      const value = field[2].trim();
      if (key === "name") {
        name = unquote(value);
      } else if (key === "description") {
        if (/^[>|][+-]?\s*$/.test(value)) {
          blockMode = value.startsWith("|") ? "literal" : "fold";
          blockLines = [];
        } else {
          description = unquote(value);
        }
      }
      continue;
    }

    if (blockMode) {
      // YAML block scalars use indentation. Trim that indentation while
      // preserving blank lines for literal descriptions.
      blockLines.push(line.trim());
    }
  }
  flushDescription();
  return { name, description };
}

function listSkillsFromRoots(roots: string[]): SkillInfo[] {
  const candidates = new Map<string, SkillInfo>();
  const seenPaths = new Set<string>();

  const add = (metadataPath: string, displayPath: string, root: string, enabled: boolean, fallbackName: string) => {
    const pathId = pathKey(metadataPath);
    if (seenPaths.has(pathId)) return;
    seenPaths.add(pathId);

    const frontmatter = readSkillFrontmatter(metadataPath);
    const description = frontmatter?.description?.trim() || undefined;
    // Pi does not register an enabled skill without a non-empty description.
    // Disabled entries remain visible so the user can turn them back on.
    if (enabled && (!frontmatter || !description)) return;
    const name = frontmatter?.name?.trim() || fallbackName;
    if (!name) return;

    const skill: SkillInfo = { name, path: displayPath, root, enabled, ...(description ? { description } : {}) };
    const existing = candidates.get(name);
    // Pi keeps the first valid skill with a given frontmatter name. A disabled
    // copy is not loaded and therefore must not hide a later enabled copy.
    if (!existing || (!existing.enabled && enabled)) candidates.set(name, skill);
  };

  /** Match pi's recursive discovery: a directory containing SKILL.md is a
   * skill root and stops traversal; otherwise nested directories are scanned.
   * The metadata and name rules below intentionally match Pi 0.84.1. */
  const scan = (dir: string, root: string, includeRootFiles: boolean) => {
    if (!existsSync(dir)) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const isFile = (entry: import("node:fs").Dirent, path: string): boolean => {
      if (entry.isFile()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    };

    const enabledEntry = entries.find((entry) => entry.name === "SKILL.md" && isFile(entry, join(dir, entry.name)));
    const disabledEntry = entries.find((entry) => entry.name === "SKILL.md.disabled" && isFile(entry, join(dir, entry.name)));
    if (enabledEntry || disabledEntry) {
      const entry = enabledEntry || disabledEntry!;
      add(join(dir, entry.name), dir, root, !!enabledEntry, basename(dir));
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(abs).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (isDirectory) {
        scan(abs, root, false);
      } else if (includeRootFiles && isFile(entry, abs) && entry.name.endsWith(".md")) {
        // Pi falls back to the containing directory name for a root-level
        // markdown skill when frontmatter does not provide `name`.
        add(abs, abs, root, true, basename(dirname(abs)));
      } else if (includeRootFiles && isFile(entry, abs) && entry.name.endsWith(".md.disabled")) {
        add(abs, abs, root, false, basename(dirname(abs)));
      }
    }
  };

  for (const root of roots) scan(root, root, true);
  return Array.from(candidates.values());
}

/** All skill roots that Pi can load for a thread. */
export function listSkills(cwd?: string): SkillInfo[] {
  return listSkillsFromRoots(skillRoots(cwd));
}

/** Skills shown and managed by the Plugins panel. Keep the two global skill
 * directories, with Pi's own directory first so duplicate names resolve to
 * the Pi-owned copy. Project skill roots remain available to commands but are
 * not part of the global Plugins inventory. */
export function listManagedSkills(): SkillInfo[] {
  return listSkillsFromRoots([join(getAgentDir(), "skills"), join(homedir(), ".agents", "skills")]);
}

/** Build the same skill command entries returned by Pi's `get_commands`. */
export function getSkillCommands(cwd?: string): { name: string; description: string; source: "skill" }[] {
  return listSkills(cwd)
    .filter((skill): skill is SkillInfo & { description: string } => skill.enabled && !!skill.description)
    .map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill" as const }));
}

export function setSkillEnabled(path: string, enabled: boolean): void {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    throw new Error("Skill path not found: " + path);
  }
  if (isDir) {
    const on = join(path, "SKILL.md");
    const off = join(path, "SKILL.md.disabled");
    if (enabled && existsSync(off)) renameSync(off, on);
    else if (!enabled && existsSync(on)) renameSync(on, off);
  } else {
    // root .md file
    if (enabled && path.endsWith(".md.disabled")) renameSync(path, path.replace(/\.disabled$/, ""));
    else if (!enabled && path.endsWith(".md")) renameSync(path, path + ".disabled");
  }
}
