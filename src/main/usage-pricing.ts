import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./config";
import { getAgentDir } from "./session-store";
import { DEFAULT_PRICE_TABLE, DEFAULT_PROVIDER_PRICE_TABLE, DEFAULT_PEAK_WINDOWS, DEFAULT_PEAK_EFFECTIVE_AT,
  normalizePrice, providerPriceEntryFor, tierFor, costOf, isLocalOriginProviderOrModel } from "./vendor/dsh-pricing.mjs";

export type Rates = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type PriceOverride = Rates & { provider: string; model: string; billing?: "api" | "plan" | "local" };
export interface PricingConfig { overrides: PriceOverride[] }
export interface CostDetail {
  source: "reported" | "catalog" | "custom" | "unpriced" | "local";
  billing: "api" | "plan" | "local";
  cost: number; equivalentCost: number;
  rates?: Rates; breakdown?: Rates;
  sourceUrl?: string; checkedAt?: string; notes?: string;
}
export const PRICING_SNAPSHOT = "2026-09-30 / c9885dd";
const filePath = () => getConfigDir() ? join(getConfigDir(), "usage-pricing.json") : "";
export function validatePricingConfig(value: any): PricingConfig {
  if (!value || !Array.isArray(value.overrides) || value.overrides.length > 1000) throw new Error("Expected overrides array (maximum 1000 models)");
  const seen = new Set<string>();
  return { overrides: value.overrides.map((row: any) => {
    if (!row || typeof row.provider !== "string" || !row.provider.trim() || typeof row.model !== "string" || !row.model.trim()) throw new Error("Each price needs a provider and model");
    for (const key of ["input", "output", "cacheRead", "cacheWrite"]) if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0) throw new Error("Prices must be non-negative numbers in USD per million tokens");
    if (row.billing !== undefined && !["api", "plan", "local"].includes(row.billing)) throw new Error("billing must be api, plan or local");
    const key = JSON.stringify([row.provider.trim().toLowerCase(), row.model.trim()]);
    if (seen.has(key)) throw new Error("Duplicate provider/model price");
    seen.add(key);
    return { provider: row.provider.trim(), model: row.model.trim(), input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, billing: row.billing || "api" };
  }) };
}
export function readPricingConfig(file = filePath()): PricingConfig {
  if (!file || !existsSync(file)) return { overrides: [] };
  return validatePricingConfig(JSON.parse(readFileSync(file, "utf8")));
}
export function writePricingConfig(value: unknown, file = filePath()): PricingConfig {
  const config = validatePricingConfig(value);
  if (!file) throw new Error("Application configuration is unavailable");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file + ".tmp", JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(file + ".tmp", file);
  return config;
}
const tables = { ...DEFAULT_PRICE_TABLE, default: { unpriced: true }, providers: DEFAULT_PROVIDER_PRICE_TABLE, currency: "USD" };
const amount = (n: any) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
const aliases: Record<string, string> = { "google-vertex": "google", "google-generative-ai": "google", "zai": "z-ai", "zhipu": "z-ai", "moonshotai": "moonshot", "kimi-coding": "moonshot", "minimax-cn": "minimax", "dashscope": "alibaba", "qwen": "alibaba", "opencode": "opencode-zen" };
function providerInfo(provider: string) {
  const name = provider.toLowerCase().replace(/^llm-/, "");
  const plan = /^(opencode-go)(?:$|[-_])/.test(name) || ["openai-codex", "anthropic-oauth", "google-gemini-cli", "kimi-coding", "zai-coding-plan", "minimax-coding-plan"].includes(name);
  return { provider: /^opencode-go(?:$|[-_])/.test(name) ? "opencode-go" : aliases[name] || name, plan };
}
/** Pi uses mutually exclusive input/cache buckets; never subtract cache twice. */
export function calculateUsageCost(provider: string, model: string, usage: any, at: number, config: PricingConfig, subscription = false): CostDetail {
  const info = providerInfo(provider);
  const custom = config.overrides.find(row => row.provider.toLowerCase() === provider.toLowerCase() && row.model === model);
  const billing = custom?.billing || (info.plan || subscription ? "plan" : isLocalOriginProviderOrModel(info.provider, model) ? "local" : "api");
  if (billing === "local") return { source: "local", billing, cost: 0, equivalentCost: 0 };
  // Existing positive estimates retain their historical price. Explicit user prices take precedence.
  if (!custom && amount(usage?.cost?.total) > 0) {
    const components = { input: amount(usage.cost.input), output: amount(usage.cost.output), cacheRead: amount(usage.cost.cacheRead), cacheWrite: amount(usage.cost.cacheWrite) };
    const sum = Object.values(components).reduce((a, b) => a + b, 0);
    return { source: "reported", billing, breakdown: Math.abs(sum - usage.cost.total) <= Math.max(1e-10, usage.cost.total * 1e-8) ? components : undefined,
      cost: billing === "api" ? usage.cost.total : 0, equivalentCost: billing === "plan" ? usage.cost.total : 0 };
  }
  const matched = custom ? { entry: normalizePrice({ input: custom.input, output: custom.output, cachedInput: custom.cacheRead, cacheWrite: custom.cacheWrite }), priced: true, billingMode: "flat" }
    : providerPriceEntryFor(info.provider, model, tables);
  if (!matched.priced || !matched.entry) return { source: "unpriced", billing, cost: 0, equivalentCost: 0 };
  const peak = matched.billingMode === "deepseek-peak" ? { enabled: true, effectiveAtMs: Date.parse(DEFAULT_PEAK_EFFECTIVE_AT), windows: DEFAULT_PEAK_WINDOWS } : undefined;
  const tokens = { input: amount(usage.input), output: amount(usage.output), cacheRead: amount(usage.cacheRead), cacheWrite: amount(usage.cacheWrite) };
  let tier = tierFor(matched.entry, at, peak);
  if (tier.longContext && tokens.input + tokens.cacheRead + tokens.cacheWrite > tier.longContext.aboveInputTokens) tier = tier.longContext;
  const rates = { input: tier.cacheMiss, output: tier.output, cacheRead: tier.cacheHit, cacheWrite: tier.cacheWrite ?? tier.cacheHit };
  const breakdown = { input: tokens.input * rates.input / 1e6, output: tokens.output * rates.output / 1e6, cacheRead: tokens.cacheRead * rates.cacheRead / 1e6, cacheWrite: tokens.cacheWrite * rates.cacheWrite / 1e6 };
  const cost = costOf(tokens, matched.entry, at, peak);
  return { source: custom ? "custom" : "catalog", billing, cost: billing === "api" ? cost : 0, equivalentCost: billing === "plan" ? cost : 0,
    rates, breakdown, sourceUrl: matched.entry.sourceUrl || (matched.billingMode === "deepseek-peak" ? "https://api-docs.deepseek.com/quick_start/pricing" : undefined), checkedAt: matched.entry.checkedAt, notes: matched.entry.notes };
}
/** Recognize subscription routes even when the user has renamed the provider. */
export function subscriptionProviders(file = join(getAgentDir(), "models.json")): Set<string> {
  const result = new Set<string>();
  try {
    const config = JSON.parse(readFileSync(file, "utf8"));
    for (const [id, provider] of Object.entries(config.providers || {}) as [string, any][]) {
      try {
        const url = new URL(provider.baseUrl);
        if (url.protocol !== "https:") continue;
        if (url.hostname === "opencode.ai" && url.pathname.startsWith("/zen/go/") ||
          url.hostname === "api.kimi.com" && url.pathname.startsWith("/coding/") ||
          ["api.z.ai", "open.bigmodel.cn"].includes(url.hostname) && url.pathname.includes("/coding/") ||
          ["api.minimax.io", "api.minimax.chat", "api.minimax.cn"].includes(url.hostname) && url.pathname.includes("/coding/")) result.add(id);
      } catch { /* Invalid route cannot identify billing. */ }
    }
  } catch { /* No custom routes. */ }
  return result;
}
export function pricingCatalog() {
  return [ ...Object.entries(DEFAULT_PRICE_TABLE.models).map(([model, entry]) => ({ provider: "deepseek", model, entry })),
    ...Object.entries(DEFAULT_PROVIDER_PRICE_TABLE).flatMap(([provider, table]) => Object.entries(table.models).map(([model, entry]) => ({ provider, model, entry })))
  ].map(({ provider, model, entry }) => { const price = normalizePrice(entry); return { provider, model, price }; });
}
