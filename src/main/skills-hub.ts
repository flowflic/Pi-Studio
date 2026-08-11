import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { getConfig } from "./config";
import { resolvePiRuntime } from "./pi-bridge";
import { getAgentDir } from "./session-store";
import type { SkillHubDetail, SkillHubSkill } from "../renderer/src/lib/types";

const SKILLS_HOME = "https://skills.sh";
const SEARCH_LIMIT = 60;
const REQUEST_TIMEOUT_MS = 12_000;
const INSTALL_TIMEOUT_MS = 180_000;
const appRequire = createRequire(__filename);

interface SearchPayload {
  skills?: unknown[];
}

interface DownloadPayload {
  files?: unknown[];
  hash?: unknown;
}

function withTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function encodeSkillPath(source: string, skillId: string): string {
  return [...source.split("/"), skillId].filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function normalizeSkill(raw: any): SkillHubSkill | null {
  const source = String(raw?.source || "").trim();
  const skillId = String(raw?.skillId || raw?.name || "").trim();
  if (!source || !skillId) return null;
  const id = String(raw?.id || `${source}/${skillId}`).trim();
  return {
    id,
    skillId,
    name: String(raw?.name || skillId).trim() || skillId,
    source,
    installs: Number.isFinite(Number(raw?.installs)) ? Number(raw.installs) : 0,
    url: `${SKILLS_HOME}/${encodeSkillPath(source, skillId)}`,
  };
}

async function readJson<T>(url: string): Promise<T> {
  const response = await withTimeout(url, { headers: { accept: "application/json" } });
  const text = await response.text();
  if (!response.ok) {
    let detail = "";
    try {
      const payload = JSON.parse(text) as { message?: string; error?: string };
      detail = payload.message || payload.error || "";
    } catch {
      detail = text.slice(0, 180);
    }
    throw new Error(`skills.sh request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return JSON.parse(text) as T;
}

/**
 * The public homepage embeds the all-time leaderboard in its server-rendered
 * RSC payload. The documented /api/v1/skills endpoint currently requires a
 * Vercel OIDC token, so parsing this public payload keeps the default view
 * useful without asking users to configure an unrelated credential.
 */
function parseLeaderboard(html: string): SkillHubSkill[] {
  const marker = html.search(/initialSkills/);
  if (marker < 0) return [];
  const arrayStart = html.indexOf("[", marker);
  if (arrayStart < 0) return [];

  const tail = html.slice(arrayStart);
  const endOffset = tail.search(/\],\\*"totalSkills/);
  if (endOffset < 0) return [];

  const encoded = tail.slice(0, endOffset + 1);
  // RSC strings escape the JSON quotes as `\"`; tolerate one or more slash
  // layers because the same payload can be observed before/after DOM parsing.
  const json = encoded.replace(/\\+"/g, '"');
  try {
    const parsed = JSON.parse(json) as unknown[];
    return parsed.map(normalizeSkill).filter((skill): skill is SkillHubSkill => !!skill);
  } catch {
    return [];
  }
}

/** Return the public all-time leaderboard, already sorted by downloads. */
export async function getSkillsHubLeaderboard(): Promise<SkillHubSkill[]> {
  const response = await withTimeout(SKILLS_HOME, { headers: { accept: "text/html" } });
  if (!response.ok) throw new Error(`skills.sh leaderboard failed (${response.status})`);
  const skills = parseLeaderboard(await response.text());
  if (skills.length === 0) throw new Error("skills.sh did not return a readable public leaderboard");
  return skills.sort((a, b) => b.installs - a.installs);
}

/** Search the public directory API. Results are normalized and sorted again on our side. */
export async function searchSkillsHub(query: string): Promise<SkillHubSkill[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ q, limit: String(SEARCH_LIMIT) });
  const payload = await readJson<SearchPayload>(`${SKILLS_HOME}/api/search?${params.toString()}`);
  return (Array.isArray(payload.skills) ? payload.skills : [])
    .map(normalizeSkill)
    .filter((skill): skill is SkillHubSkill => !!skill)
    .sort((a, b) => b.installs - a.installs);
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function pageDescription(html: string): string {
  const patterns = [
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i,
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]).trim();
  }
  return "";
}

function frontmatterValue(markdown: string, key: string): string {
  const block = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!block) return "";
  const line = block[1].split(/\r?\n/).find((entry) => new RegExp(`^${key}\\s*:`).test(entry));
  if (!line) return "";
  return line.slice(line.indexOf(":") + 1).trim().replace(/^['"]|['"]$/g, "");
}

function skillDownloadUrl(skill: SkillHubSkill): string {
  return `${SKILLS_HOME}/api/download/${encodeSkillPath(skill.source, skill.skillId)}`;
}

/** Fetch raw SKILL.md metadata where the public download endpoint supports it. */
export async function getSkillDetails(skill: SkillHubSkill): Promise<SkillHubDetail> {
  let files: { path: string; contents?: string }[] = [];
  let hash: string | null = null;
  let markdown = "";
  let description = "";

  try {
    const payload = await readJson<DownloadPayload>(skillDownloadUrl(skill));
    files = (Array.isArray(payload.files) ? payload.files : [])
      .map((file: any) => {
        const path = String(file?.path || "").trim();
        if (!path) return null;
        const contents = typeof file?.contents === "string" ? file.contents : undefined;
        return { path, ...(contents === undefined ? {} : { contents: contents.slice(0, 120_000) }) };
      })
      .filter((file): file is { path: string; contents?: string } => !!file);
    const skillFile = files.find((file) => file.path.toLowerCase() === "skill.md");
    markdown = skillFile?.contents || "";
    description = frontmatterValue(markdown, "description");
    hash = typeof payload.hash === "string" ? payload.hash : null;
  } catch {
    // Some well-known sources have a directory entry but no public download
    // route. The page metadata below still gives the user a useful detail view.
  }

  if (!description || !markdown) {
    try {
      const page = await withTimeout(skill.url, { headers: { accept: "text/html" } });
      if (page.ok) {
        const html = await page.text();
        description ||= pageDescription(html);
      }
    } catch {
      // Details remain installable even if the page preview is unavailable.
    }
  }

  return {
    ...skill,
    description: description || "No description was published for this skill.",
    files,
    hash,
    installCommand: `npx skills add ${skill.source}@${skill.skillId} --agent pi --global --yes --copy`,
    ...(markdown ? { markdown } : {}),
  };
}

function skillsCliPath(): string {
  try {
    return appRequire.resolve("skills/bin/cli.mjs");
  } catch {
    throw new Error("The bundled skills CLI is unavailable. Reinstall Pi Studio or its dependencies.");
  }
}

function safeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(normalized)) {
    throw new Error(`Invalid ${label} returned by skills.sh`);
  }
  return normalized;
}

function runSkillsCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(async (resolve, reject) => {
    let runtime: { node: string; cli: string };
    try {
      runtime = await resolvePiRuntime(getConfig().piCliPath);
    } catch (error) {
      reject(error);
      return;
    }

    const proc = spawn(runtime.node, [skillsCliPath(), ...args], {
      cwd: getAgentDir(),
      env: { ...process.env, DISABLE_TELEMETRY: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (proc.exitCode === null) proc.kill();
    }, INSTALL_TIMEOUT_MS);
    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      if (stdout.length > 64 * 1024) stdout = stdout.slice(-64 * 1024);
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) stderr += `\nInstallation timed out after ${Math.round(INSTALL_TIMEOUT_MS / 1000)} seconds.`;
      resolve({ code, stdout, stderr });
    });
  });
}

/** Install only the selected skill into Pi's global native skill directory. */
export async function installSkillFromHub(source: string, skillId: string): Promise<{ ok: boolean; output: string }> {
  const safeSource = safeSegment(source, "skill source");
  const safeSkillId = safeSegment(skillId, "skill name");
  const packageSpec = `${safeSource}@${safeSkillId}`;
  const result = await runSkillsCli(["add", packageSpec, "--agent", "pi", "--global", "--yes", "--copy"]);
  const output = `${result.stdout}\n${result.stderr}`.trim();
  return { ok: result.code === 0, output };
}
