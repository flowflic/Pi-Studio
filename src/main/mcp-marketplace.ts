import { readMcpConfig, writeMcpConfig, type McpConfig } from "./mcp-service";

/**
 * MCP marketplace backed by the public Glama directory
 * (https://glama.ai/mcp/servers).
 *
 * Glama's documented JSON API requires a per-user API key, so Pi Studio reads
 * the same public directory pages a browser sees and extracts the embedded
 * schema.org data plus the install examples rendered from each server's README.
 * That keeps the marketplace usable without an account. In exchange:
 *  - every view credits Glama and links each record to its Glama listing
 *    (required by Glama's API Data License);
 *  - a listing page exposes the first 20 matches, so the UI narrows by query
 *    and attribute filters instead of promising infinite browsing;
 *  - the install command is always shown for review before it is written,
 *    because README examples can contain placeholder paths.
 *
 * Network access is restricted to glama.ai and every response is size-limited.
 */

const GLAMA_ORIGIN = "https://glama.ai";
const LISTING_PATH = "/mcp/servers";
const USER_AGENT = "Pi-Studio/0.4.6 (+https://github.com/flowflic/Pi-Studio)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const SEARCH_TTL_MS = 3 * 60_000;
const DETAIL_TTL_MS = 10 * 60_000;

export interface McpMarketplaceItem {
  /** `owner/repo` path from the Glama listing. */
  id: string;
  name: string;
  description: string;
  /** Glama listing URL; always shown next to the record. */
  url: string;
  author?: string;
  authorUrl?: string;
  operatingSystem?: string;
}

export interface McpMarketplaceFacet {
  /** e.g. `category:browser-automation`. */
  attribute: string;
  label: string;
  count?: number;
}

export interface McpMarketplaceSearchResult {
  items: McpMarketplaceItem[];
  facets: McpMarketplaceFacet[];
  query: string;
  attribute?: string;
  sourceUrl: string;
}

export interface McpInstallCandidate {
  /** Name suggested by the README example, sanitized for `mcp.json`. */
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Why this candidate was offered. */
  origin: "readme" | "none";
  /** Human-readable caveat shown with the candidate. */
  note?: string;
}

export interface McpMarketplaceDetail extends McpMarketplaceItem {
  license?: string;
  repositoryUrl?: string;
  candidates: McpInstallCandidate[];
  warnings: string[];
}

export interface McpMarketplaceSearchOptions {
  query?: string;
  attribute?: string;
}

const SEARCH_ALLOWED_ATTRIBUTE = /^(category|language|hosting|capability|author):[A-Za-z0-9._-]{1,100}$/;

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

function assertGlamaUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid Glama URL.");
  }
  if (url.protocol !== "https:" || url.hostname !== "glama.ai") throw new Error("Only glama.ai URLs are supported.");
  if (url.pathname !== LISTING_PATH && !url.pathname.startsWith(`${LISTING_PATH}/`)) {
    throw new Error("Only Glama MCP server pages are supported.");
  }
  return url;
}

/** Serialize marketplace requests so a burst of facet clicks cannot trip the WAF. */
let lastRequestAt = 0;
const MIN_REQUEST_GAP_MS = 800;
async function paceRequests(): Promise<void> {
  const wait = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
  lastRequestAt = Date.now() + wait;
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

class GlamaHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

async function requestGlama(url: URL): Promise<string> {
  await paceRequests();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "text/html", "user-agent": USER_AGENT, "accept-language": "en" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      throw new GlamaHttpError(
        (response.status === 429 || response.status === 503
          ? "Glama is rate-limiting requests (HTTP " + response.status + "). Try again shortly."
          : "Glama returned HTTP " + response.status + "."),
        response.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 8) * 1000 : 0,
      );
    }
    // A redirect must stay inside the directory host.
    if (new URL(response.url).hostname !== "glama.ai") throw new Error("Glama redirected outside its own domain.");
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_HTML_BYTES) throw new Error("Glama response is too large.");
    const html = await response.text();
    if (html.length > MAX_HTML_BYTES) throw new Error("Glama response is too large.");
    return html;
  } catch (error: any) {
    if (error?.name === "AbortError") throw new Error("Glama did not respond within 15 seconds.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One retry after a short pause covers Cloudflare's transient 503s and the
 * documented rate-limit response. Longer outages surface to the panel, which
 * keeps the manual editor usable.
 */
async function fetchGlamaHtml(url: URL): Promise<string> {
  try {
    return await requestGlama(url);
  } catch (error: any) {
    if (!(error instanceof GlamaHttpError) || (error.status !== 429 && error.status !== 503)) throw error;
    const wait = error.retryAfterMs || 1500;
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await requestGlama(url);
    } catch (retryError: any) {
      if (retryError instanceof GlamaHttpError && (retryError.status === 429 || retryError.status === 503)) {
        throw new Error("Glama is rate-limiting requests. Try again shortly, or use the manual configuration below.");
      }
      throw retryError;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Parsing helpers (pure, exported for tests)
 * ------------------------------------------------------------------ */

const HTML_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: "&",
  lt: "<",
  gt: ">",
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/** Decode the entity subset Glama emits inside code blocks and text. */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&#(\d+);/g, (_match, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    })
    .replace(/&([a-z]+|#39);/gi, (match, name) => HTML_ENTITIES[String(name).toLowerCase()] ?? match);
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function ldJsonBlocks(html: string): any[] {
  const blocks: any[] = [];
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      /* ignore malformed metadata */
    }
  }
  return blocks;
}

function flattenGraph(block: any): any[] {
  if (block && Array.isArray(block["@graph"])) return block["@graph"];
  return block ? [block] : [];
}

function pathId(url: string): string {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.replace(/^\/mcp\/servers\//, "")).replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/** Parse a Glama directory page into records and attribute facets. */
export function parseGlamaListing(html: string, sourceUrl: string): McpMarketplaceSearchResult {
  const items: McpMarketplaceItem[] = [];
  const seen = new Set<string>();
  for (const block of ldJsonBlocks(html)) {
    for (const node of flattenGraph(block)) {
      const list =
        node?.["@type"] === "SearchResultsPage" && node?.mainEntity?.["@type"] === "ItemList"
          ? node.mainEntity.itemListElement
          : node?.["@type"] === "ItemList"
            ? node.itemListElement
            : null;
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        const item = entry?.item || entry;
        const url = typeof item?.url === "string" ? item.url : "";
        // Only surface records that point back into the Glama directory.
        if (!/^https:\/\/glama\.ai\/mcp\/servers\/[^/]+\/[^/?#]+$/.test(url)) continue;
        const id = pathId(url);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        items.push({
          id,
          name: String(item?.name || id.split("/").pop() || id),
          description: String(item?.description || "").trim(),
          url,
          ...(item?.author?.name ? { author: String(item.author.name) } : {}),
          ...(typeof item?.author?.url === "string" ? { authorUrl: item.author.url } : {}),
          ...(typeof item?.operatingSystem === "string" ? { operatingSystem: item.operatingSystem } : {}),
        });
      }
    }
  }

  const facets: McpMarketplaceFacet[] = [];
  const seenFacets = new Set<string>();
  const facetPattern = /<a href="\/mcp\/servers\?attributes=([^"&]+)[^"]*"[^>]*aria-label="([^"]*)"[^>]*>[\s\S]{0,400}?<span class="[^"]*">([\d,]+)<\/span>/g;
  let facet: RegExpExecArray | null;
  while ((facet = facetPattern.exec(html))) {
    let attribute: string;
    try {
      attribute = decodeURIComponent(facet[1]);
    } catch {
      continue;
    }
    if (!SEARCH_ALLOWED_ATTRIBUTE.test(attribute) || seenFacets.has(attribute)) continue;
    seenFacets.add(attribute);
    facets.push({
      attribute,
      label: decodeHtmlEntities(facet[2]).trim(),
      count: Number(facet[3].replace(/,/g, "")) || undefined,
    });
  }

  const source = new URL(sourceUrl);
  const query = source.searchParams.get("query") || "";
  const attribute = source.searchParams.get("attributes") || "";
  return {
    items,
    facets: facets.slice(0, 14),
    query,
    ...(attribute ? { attribute } : {}),
    sourceUrl: source.toString(),
  };
}

const RUNNERS = new Set(["npx", "bunx", "uvx", "pnpm", "yarn", "deno", "docker", "pipx", "uv", "mcp"]);
const INTERPRETERS = new Set(["node", "python", "python3", "java", "go", "ruby", "dotnet"]);
const PACKAGE_ARG = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[^\s/]+)?$/i;
const PLACEHOLDER = /\/path\/to\b|path[\\/]to\b|<[^>]{2,}>|\{\{[^}]+\}\}|\byour[-_ ]|YOUR_|xxx|example\.com\/mcp/i;
const ALLOWED_EXPOSURES = new Set(["direct", "codemode", "codemode-deferred", "deferred", "hidden"]);

const SERVER_KEYS = new Set(["command", "args", "url", "env", "headers", "type", "enabled", "exposure", "timeout"]);

/** Normalize a README `mcpServers` entry into a reviewable candidate. */
function candidateFromEntry(rawName: string, raw: any, origin: "readme" | "none"): McpInstallCandidate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (Boolean(command) === Boolean(url)) return null;
  if (url && !/^https?:\/\//i.test(url)) return null;
  const args = Array.isArray(raw.args) ? raw.args.filter((arg: unknown) => typeof arg === "string").map((arg: string) => arg.trim()).filter(Boolean) : undefined;
  const stringMap = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][];
    return entries.length ? Object.fromEntries(entries) : undefined;
  };
  const env = stringMap(raw.env);
  const headers = stringMap(raw.headers);
  const name = sanitizeServerName(rawName) || "";
  return {
    name,
    transport: command ? "stdio" : "http",
    ...(command ? { command } : {}),
    ...(args?.length ? { args } : {}),
    ...(url ? { url } : {}),
    ...(env ? { env } : {}),
    ...(headers ? { headers } : {}),
    origin,
  };
}

function scoreCandidate(candidate: McpInstallCandidate): number {
  let score = 0;
  const command = (candidate.command || "").toLowerCase();
  if (candidate.transport === "http") score += 30;
  if (RUNNERS.has(command)) score += 40;
  else if (INTERPRETERS.has(command)) score += 15;
  else if (command) score += 5;
  const args = candidate.args || [];
  if (args.length) score += 5;
  if ((command === "npx" || command === "bunx" || command === "uvx" || command === "pnpm" || command === "yarn" || command === "uv" || command === "pipx") && args[0] && PACKAGE_ARG.test(args[0])) {
    score += 15;
  }
  // Non-interactive package runners are the only ones that work over stdio.
  if (args.some((arg) => arg === "-y" || arg === "--yes" || arg === "--non-interactive")) score += 4;
  const joined = [candidate.command, ...args, candidate.url].filter(Boolean).join(" ");
  if (PLACEHOLDER.test(joined)) score -= 30;
  if (candidate.env && Object.keys(candidate.env).length) score += 2;
  return score;
}

/** Extract reviewable install candidates from the README code blocks Glama renders. */
export function extractInstallCandidates(html: string, fallbackName: string): McpInstallCandidate[] {
  const configs: any[] = [];
  const codePattern = /<code class="raw-code">([\s\S]*?)<\/code>/g;
  let match: RegExpExecArray | null;
  while ((match = codePattern.exec(html))) {
    const text = decodeHtmlEntities(match[1]).trim();
    if (!text.includes("mcpServers")) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.mcpServers && typeof parsed.mcpServers === "object") configs.push(parsed.mcpServers);
    } catch {
      /* not a standalone JSON config */
    }
  }

  const bySignature = new Map<string, McpInstallCandidate>();
  for (const servers of configs) {
    for (const [name, raw] of Object.entries(servers as Record<string, any>)) {
      const candidate = candidateFromEntry(name, raw, "readme");
      if (!candidate) continue;
      const signature = JSON.stringify([candidate.command, candidate.args, candidate.url, Object.keys(candidate.env || {}).sort()]);
      const existing = bySignature.get(signature);
      // Prefer a candidate whose example name is usable, so the dialog starts with
      // the name the project documents.
      if (!existing || (!existing.name && candidate.name)) bySignature.set(signature, candidate);
    }
  }

  const candidates = [...bySignature.values()].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  for (const candidate of candidates) {
    const joined = [candidate.command, ...(candidate.args || []), candidate.url].filter(Boolean).join(" ");
    if (PLACEHOLDER.test(joined)) {
      candidate.note = "README 示例中包含占位路径或示例地址，安装前请替换为实际值。";
    }
    if (!candidate.name) candidate.name = fallbackName;
  }
  return candidates.slice(0, 6);
}

/** Parse one Glama server page: metadata, repository link and install examples. */
export function parseGlamaDetail(html: string, url: string): McpMarketplaceDetail {
  const id = pathId(url);
  const fallbackName = sanitizeServerName(id.split("/").pop() || "mcp-server") || "mcp-server";
  let name = id.split("/").pop() || id;
  let description = "";
  let license: string | undefined;
  let operatingSystem: string | undefined;
  let author: string | undefined;

  for (const block of ldJsonBlocks(html)) {
    for (const node of flattenGraph(block)) {
      if (node?.["@type"] !== "SoftwareApplication") continue;
      if (typeof node.name === "string" && node.name.trim()) name = node.name.trim();
      if (typeof node.description === "string") description = node.description.trim();
      if (typeof node.license === "string") license = node.license;
      if (typeof node.operatingSystem === "string") operatingSystem = node.operatingSystem;
      if (typeof node.author?.name === "string") author = node.author.name;
    }
  }

  // Prefer the GitHub link whose owner/repo matches the Glama slug; README links
  // point at unrelated projects, and the author profile is not the repository.
  const repository = [...html.matchAll(/href="(https:\/\/github\.com\/[^"?#]+)"/g)]
    .map((match) => match[1].replace(/\/+$/, ""))
    .find((candidate) => candidate.toLowerCase().endsWith(`/${id.toLowerCase()}`));

  const candidates = extractInstallCandidates(html, fallbackName);
  const warnings: string[] = [];
  if (!candidates.length) {
    warnings.push("未能从 Glama 页面解析出可执行配置，请手动填写启动命令或远程 URL。");
  } else if (candidates.every((candidate) => candidate.note)) {
    warnings.push("所有示例都包含占位值，请先改好命令再安装。");
  }

  return {
    id,
    name,
    description,
    url,
    ...(author ? { author } : {}),
    ...(operatingSystem ? { operatingSystem } : {}),
    ...(license ? { license } : {}),
    ...(repository ? { repositoryUrl: repository } : {}),
    candidates,
    warnings,
  };
}

/** `mcp.json` allows `[a-zA-Z0-9_-]` server names; normalize Glama names to match. */
export function sanitizeServerName(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

const searchCache = new Map<string, { at: number; value: McpMarketplaceSearchResult }>();
const detailCache = new Map<string, { at: number; value: McpMarketplaceDetail }>();

function remember<T>(cache: Map<string, { at: number; value: T }>, key: string, value: T, ttl: number, limit: number) {
  cache.set(key, { at: Date.now(), value });
  for (const [cacheKey, entry] of cache) if (Date.now() - entry.at > ttl) cache.delete(cacheKey);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Search or browse the public Glama directory. */
export async function searchMcpMarketplace(options: McpMarketplaceSearchOptions = {}): Promise<McpMarketplaceSearchResult> {
  const query = String(options.query || "").trim().slice(0, 120);
  const attribute = String(options.attribute || "").trim();
  if (attribute && !SEARCH_ALLOWED_ATTRIBUTE.test(attribute)) throw new Error("Unsupported Glama filter.");

  const url = new URL(`${GLAMA_ORIGIN}${LISTING_PATH}`);
  if (query) url.searchParams.set("query", query);
  if (attribute) url.searchParams.set("attributes", attribute);
  const cacheKey = url.toString();
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.value;

  const html = await fetchGlamaHtml(assertGlamaUrl(url.toString()));
  const result = parseGlamaListing(html, cacheKey);
  remember(searchCache, cacheKey, result, SEARCH_TTL_MS, 40);
  return result;
}

/** Load one Glama record and its install examples. */
export async function getMcpMarketplaceDetail(rawUrl: string): Promise<McpMarketplaceDetail> {
  const url = assertGlamaUrl(String(rawUrl || ""));
  if (pathId(url.toString()).split("/").length !== 2) throw new Error("Invalid Glama server URL.");
  const cacheKey = url.toString();
  const cached = detailCache.get(cacheKey);
  if (cached && Date.now() - cached.at < DETAIL_TTL_MS) return cached.value;

  const html = await fetchGlamaHtml(url);
  const detail = parseGlamaDetail(html, cacheKey);
  remember(detailCache, cacheKey, detail, DETAIL_TTL_MS, 30);
  return detail;
}

/** Keep only the fields Pi's `mcp.json` understands and validate their types. */
export function sanitizeServerEntry(raw: any): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid MCP server configuration.");
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (Boolean(command) === Boolean(url)) throw new Error("An MCP server needs either a command or a URL.");
  if (url && !/^https?:\/\//i.test(url)) throw new Error("MCP server URL must use HTTP(S).");
  if (command.length > 500 || url.length > 2000) throw new Error("MCP server command or URL is too long.");

  const entry: Record<string, unknown> = {};
  if (command) entry.command = command;
  if (url) entry.url = url;
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((arg: unknown) => typeof arg !== "string")) throw new Error("MCP args must be strings.");
    const args = raw.args.map((arg: string) => arg.trim()).filter(Boolean);
    if (args.length > 64) throw new Error("Too many MCP arguments.");
    if (args.length) entry.args = args;
  }
  const stringMap = (value: unknown, label: string): Record<string, string> | undefined => {
    if (value === undefined) return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`MCP ${label} must be an object.`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string")) {
      throw new Error(`MCP ${label} keys and values must be strings.`);
    }
    if (!entries.length) return undefined;
    return Object.fromEntries(entries.map(([key, item]) => [key, (item as string).trim()]));
  };
  const env = stringMap(raw.env, "env");
  const headers = stringMap(raw.headers, "headers");
  if (env) entry.env = env;
  if (headers) entry.headers = headers;
  if (raw.type !== undefined) {
    if (!["stdio", "http", "streamable-http"].includes(String(raw.type))) throw new Error("Unsupported MCP transport.");
    entry.type = String(raw.type);
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") throw new Error("MCP enabled must be a boolean.");
    entry.enabled = raw.enabled;
  } else {
    entry.enabled = true;
  }
  if (raw.exposure !== undefined) {
    if (!ALLOWED_EXPOSURES.has(String(raw.exposure))) throw new Error("Invalid MCP exposure.");
    entry.exposure = String(raw.exposure);
  } else {
    entry.exposure = "codemode";
  }
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) throw new Error("Invalid MCP timeout.");
    entry.timeout = raw.timeout;
  }
  // Guard against future fields leaking from the renderer.
  for (const key of Object.keys(entry)) if (!SERVER_KEYS.has(key)) delete entry[key];
  return entry;
}

export interface McpInstallRequest {
  name: string;
  server: Record<string, unknown>;
  overwrite?: boolean;
}

export interface McpInstallResult {
  path: string;
  config: McpConfig;
  name: string;
}

/** Write one marketplace server into `mcp.json`, preserving every other entry. */
export function installMcpServer(request: McpInstallRequest): McpInstallResult {
  const name = sanitizeServerName(String(request?.name || ""));
  if (!name) throw new Error("Invalid MCP server name.");
  if (name.length > 64) throw new Error("MCP server name is too long.");
  const entry = sanitizeServerEntry(request?.server);
  const current = readMcpConfig();
  if (current.config.mcpServers[name] && !request?.overwrite) {
    const error: any = new Error(`MCP server "${name}" already exists.`);
    error.code = "NAME_EXISTS";
    throw error;
  }
  const written = writeMcpConfig({
    ...current.config,
    mcpServers: { ...current.config.mcpServers, [name]: entry },
  });
  return { ...written, name };
}

export const MCP_MARKETPLACE_SOURCE = {
  label: "Glama",
  url: `${GLAMA_ORIGIN}${LISTING_PATH}`,
};
