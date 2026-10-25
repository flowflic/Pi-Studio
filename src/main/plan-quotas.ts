import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "./session-store";
import { parseAnthropicUsage, parseZaiUsage, parseMiniMaxRemains, parseKimiCodingUsage } from "./vendor/dsh-coding-plans.mjs";

export type PlanId = "opencode-go" | "kimi" | "minimax" | "zai" | "anthropic";
export interface QuotaWindow { name: string; usedPercent?: number; remainingPercent?: number; used?: number; remaining?: number; limit?: number; resetsAt?: string; unlimited?: boolean; text?: string }
export interface PlanQuota { id: PlanId; label: string; status: "ok" | "missing" | "error"; message?: string; fetchedAt?: number; windows: QuotaWindow[]; credentialSource?: string }
const specs = {
  "opencode-go": { label: "OpenCode Go", envs: ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"], urls: ["https://opencode.ai/inference/go/v1/usage", "https://opencode.ai/zen/go/v1/usage"] },
  kimi: { label: "Kimi Code", envs: ["KIMI_CODING_API_KEY"], urls: ["https://api.kimi.com/coding/v1/usages", "https://api.kimi.com/coding/v1/usage"] },
  minimax: { label: "MiniMax Token Plan", envs: ["MINIMAX_API_KEY"], urls: ["https://www.minimax.cn/v1/token_plan/remains", "https://www.minimax.io/v1/token_plan/remains", "https://www.minimaxi.com/v1/token_plan/remains"] },
  zai: { label: "GLM Coding Plan", envs: ["ZAI_API_KEY", "BIGMODEL_API_KEY"], urls: ["https://open.bigmodel.cn/api/monitor/usage/quota/limit", "https://api.z.ai/api/monitor/usage/quota/limit"] },
  anthropic: { label: "Claude Pro / Max", envs: ["ANTHROPIC_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"], urls: ["https://api.anthropic.com/api/oauth/usage"] },
} as const;
const json = (file: string): any => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
function literalOrEnv(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("!")) return;
  const name = value.replace(/^\$\{([A-Z0-9_]+)\}$/, "$1");
  if (process.env[name]) return process.env[name];
  if (/^[A-Z][A-Z0-9_]*$/.test(name) || value.startsWith("${")) return;
  return value;
}
/**
 * Bind a provider id to a subscription plan. The preset quick-setup stores only
 * an API key under the provider id, relying on Pi's built-in endpoint, so the
 * id is the only binding those entries have.
 */
function providerPlan(provider: string): PlanId | undefined {
  const id = provider.toLowerCase();
  if (/^opencode-go(?:$|[-_.])/.test(id)) return "opencode-go";
  if (/^kimi[-_.]?cod(?:e|ing)(?:$|[-_.])/.test(id)) return "kimi";
  if (/^minimax(?:$|[-_.])/.test(id)) return "minimax";
  if (/^(?:zai|z-ai|zhipu|glm-coding)(?:$|[-_.])/.test(id)) return "zai";
  return undefined;
}

function routePlan(baseUrl: unknown): PlanId | undefined {
  if (typeof baseUrl !== "string") return;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:") return;
    // OpenCode moved Go traffic to /inference/go; older configs still use /zen/go.
    if (url.hostname === "opencode.ai" && /^\/(?:zen|inference)\/go(?:\/v1)?\/?$/.test(url.pathname)) return "opencode-go";
    if (url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding")) return "kimi";
    if (["api.minimax.io", "api.minimax.chat", "api.minimax.cn"].includes(url.hostname)) return "minimax";
    if (["api.z.ai", "open.bigmodel.cn"].includes(url.hostname) && url.pathname.includes("/coding/")) return "zai";
  } catch { /* Invalid route has no credential binding. */ }
}

/** Resolve a plan from the provider entry itself or any of its model routes. */
function entryPlan(provider: string, entry: any): PlanId | undefined {
  const fromProvider = providerPlan(provider);
  const fromEntry = routePlan(entry?.baseUrl);
  if (fromProvider && fromEntry && fromProvider !== fromEntry) return fromEntry;
  if (fromProvider) return fromProvider;
  if (fromEntry) return fromEntry;
  if (Array.isArray(entry?.models)) {
    for (const model of entry.models) {
      const id = routePlan(model?.baseUrl);
      if (id) return id;
    }
  }
  return undefined;
}
export function discoverPlanCredentials(agentDir = getAgentDir()): Partial<Record<PlanId, { key: string; source: string }>> {
  const found: Partial<Record<PlanId, { key: string; source: string }>> = {};
  const models = json(join(agentDir, "models.json"));
  const auth = json(join(agentDir, "auth.json"));
  for (const [provider, value] of Object.entries(models.providers || {}) as [string, any][]) {
    if (!value || typeof value !== "object") continue;
    const id = entryPlan(provider, value);
    if (!id) continue;
    const key = literalOrEnv(value.apiKey) || literalOrEnv(auth[provider]?.key);
    if (key) found[id] = { key, source: provider };
  }
  const authAliases: Record<PlanId, string[]> = { "opencode-go": ["opencode-go"], kimi: ["kimi-coding"], minimax: ["minimax", "minimax-cn"], zai: ["zai", "z-ai", "zhipu"], anthropic: ["anthropic"] };
  for (const id of Object.keys(specs) as PlanId[]) {
    if (!found[id]) for (const provider of authAliases[id]) {
      const item = auth[provider];
      // Claude subscription endpoints require OAuth, not a paid API key.
      const key = id === "anthropic" ? item?.type === "oauth" ? item.access : undefined : item?.key;
      if (typeof key === "string" && key && (id !== "anthropic" || !item.expires || item.expires > Date.now())) { found[id] = { key, source: provider }; break; }
    }
    if (!found[id]) for (const env of specs[id].envs) if (process.env[env]) { found[id] = { key: process.env[env]!, source: env }; break; }
  }
  if (!found["opencode-go"]) {
    for (const file of [join(homedir(), ".local/share/opencode/auth.json"), join(homedir(), ".config/opencode/auth.json"), ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, "opencode/auth.json")] : [])]) {
      const key = json(file)["opencode-go"]?.key;
      if (typeof key === "string" && key) { found["opencode-go"] = { key, source: "OpenCode login" }; break; }
    }
  }
  return found;
}
export function parsePlanQuota(id: PlanId, data: any): QuotaWindow[] {
  let windows: Record<string, any> | null;
  if (id === "opencode-go") windows = data?.usage && typeof data.usage === "object" ? data.usage : null;
  else windows = ({ kimi: parseKimiCodingUsage, minimax: parseMiniMaxRemains, zai: parseZaiUsage, anthropic: parseAnthropicUsage }[id])(data);
  if (!windows) return [];
  return Object.entries(windows).flatMap<QuotaWindow>(([name, value]) => {
    if (!value || typeof value !== "object") return [];
    const percent = typeof value.percent === "number" ? value.percent : typeof value.percent === "string" && value.percent.trim() ? Number(value.percent) : NaN;
    if (value.unlimited) return [{ name, unlimited: true, resetsAt: value.resetsAt }];
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return [];
    let raw: any = id === "opencode-go" ? data.usage[name] : undefined;
    if (id === "kimi") raw = name === "weekly" ? data.usage : data.limits?.find((row: any) => {
      const unit = String(row.window?.timeUnit || "").toLowerCase();
      return name === `${row.window?.duration}${unit.startsWith("hour") ? "h" : unit.startsWith("day") ? "d" : unit.startsWith("week") ? "w" : unit.startsWith("minute") ? "m" : unit.startsWith("month") ? "mo" : unit.slice(0, 4)}`;
    })?.detail;
    // Only display numeric absolute quotas when the API supplies a positive limit.
    const limit = raw?.limit, used = raw?.used, remaining = raw?.remaining;
    const absolute = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? {
      limit,
      used: typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 ? Math.max(0, limit - remaining) : undefined,
      remaining: typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 ? remaining : typeof used === "number" && Number.isFinite(used) && used >= 0 ? Math.max(0, limit - used) : undefined,
    } : {};
    return [{ name, usedPercent: percent, remainingPercent: Math.max(0, 100 - percent), ...absolute, resetsAt: typeof value.resetsAt === "string" ? value.resetsAt : undefined }];
  });
}
const previous = new Map<PlanId, PlanQuota>();
let inFlight: Promise<PlanQuota[]> | undefined;
let cache: { at: number; plans: PlanQuota[] } | undefined;
export async function queryPlanQuota(id: PlanId, credential: { key: string; source: string } | undefined, fetcher: typeof fetch = fetch): Promise<PlanQuota> {
  const base = { id, label: specs[id].label, windows: [] };
  if (!credential) return { ...base, status: "missing", message: specs[id].envs.join(" / ") };
  const signal = AbortSignal.timeout(18000);
  let failure = "network";
  for (const url of specs[id].urls) {
    try {
      const response = await fetcher(url, { signal, redirect: "error", headers: { authorization: `Bearer ${credential.key}`, "user-agent": id === "kimi" ? "KimiCLI/1.6" : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36", ...(id === "anthropic" ? { "anthropic-beta": "oauth-2025-04-20" } : {}) } });
      if (!response.ok) { failure = `HTTP ${response.status}`; await response.body?.cancel(); continue; }
      // Keep a bounded response and never return raw account data or credentials to the renderer.
      const reader = response.body?.getReader();
      if (!reader) { failure = "empty_response"; continue; }
      const decoder = new TextDecoder(); let text = "", size = 0;
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 * 1024) { await reader.cancel(); throw new Error("too_large"); } text += decoder.decode(part.value, { stream: true }); }
      text += decoder.decode();
      const windows = parsePlanQuota(id, JSON.parse(text));
      if (!windows.length) { failure = "no_quota"; continue; }
      const result: PlanQuota = { ...base, status: "ok", windows, fetchedAt: Date.now(), credentialSource: credential.source };
      previous.set(id, result); return result;
    } catch { failure = signal.aborted ? "timeout" : "network_or_invalid_response"; if (signal.aborted) break; }
  }
  return { ...base, ...previous.get(id), status: "error", message: failure, credentialSource: credential.source };
}
export function getPlanQuotas(force = false): Promise<PlanQuota[]> {
  if (inFlight) return inFlight;
  if (!force && cache && Date.now() - cache.at < 60000) return Promise.resolve(cache.plans);
  const credentials = discoverPlanCredentials();
  inFlight = Promise.all((Object.keys(specs) as PlanId[]).map(id => queryPlanQuota(id, credentials[id])))
    .then(plans => { cache = { at: Date.now(), plans }; return plans; }).finally(() => { inFlight = undefined; });
  return inFlight;
}
