import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { forEachLine, getSessionsDir } from "./session-store";
import { calculateUsageCost, readPricingConfig, subscriptionProviders, PRICING_SNAPSHOT, type CostDetail, type PricingConfig } from "./usage-pricing";

export interface UsageTotals {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  tokens: number; cost: number; requests: number;
  reportedCost: number; estimatedCost: number; equivalentCost: number; unpricedRequests: number;
}
export interface UsageReport extends UsageTotals {
  sessions: number; unreadableFiles: number;
  days: Array<UsageTotals & { date: string }>;
  models: Array<UsageTotals & { provider: string; model: string; pricing: Array<CostDetail & { requests: number; tokens: number }> }>;
  pricingSnapshot: string;
}
const empty = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, requests: 0, reportedCost: 0, estimatedCost: 0, equivalentCost: 0, unpricedRequests: 0 });
const amount = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
const add = (a: UsageTotals, b: UsageTotals) => {
  for (const key of Object.keys(b) as (keyof UsageTotals)[]) a[key] += b[key];
};

/** Match actual request timestamps, not file modification times. Forked entries count once. */
export async function getUsageReport(range: { from: number; to: number }, root = getSessionsDir(), pricing: PricingConfig = readPricingConfig()): Promise<UsageReport> {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.from >= range.to) throw new Error("Invalid usage date range");
  const report: UsageReport = { ...empty(), sessions: 0, unreadableFiles: 0, days: [], models: [], pricingSnapshot: PRICING_SNAPSHOT };
  const plans = subscriptionProviders();
  const files: string[] = [];
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(join(root, entry.name));
      if (entry.isDirectory()) {
        try { for (const name of await readdir(join(root, entry.name))) if (name.endsWith(".jsonl")) files.push(join(root, entry.name, name)); }
        catch { report.unreadableFiles++; }
      }
    }
  } catch (e: any) { if (e.code !== "ENOENT") report.unreadableFiles++; return report; }
  const seen = new Set<string>();
  const sessions = new Set<string>();
  const days = new Map<string, UsageTotals>();
  const models = new Map<string, UsageReport["models"][number]>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (cursor < files.length) {
      const file = files[cursor++];
      let lineNumber = 0;
      try {
        await forEachLine(file, line => {
          lineNumber++;
          let entry: any;
          try { entry = JSON.parse(line); } catch { return; }
          const msg = entry.message;
          const isMessageUsage = entry.type === "message" && ["assistant", "toolResult"].includes(msg?.role);
          const isEntryUsage = ["usage", "compaction", "branch_summary"].includes(entry.type);
          const u = isMessageUsage ? msg?.usage : isEntryUsage ? entry.usage : undefined;
          if (!u) return;
          const stamp = msg?.timestamp || entry.timestamp;
          const time = typeof stamp === "number" ? stamp : Date.parse(stamp);
          if (!Number.isFinite(time) || time < range.from || time >= range.to) return;
          const key = entry.id ? `${entry.id}:${time}:${entry.type}` : `${file}:${lineNumber}`;
          if (seen.has(key)) return;
          seen.add(key); sessions.add(file);
          const provider = String(msg?.provider || entry.provider || "Tools"), model = String(msg?.responseModel || msg?.model || entry.model || "summaries");
          const cost = calculateUsageCost(provider, model, u, time, pricing, plans.has(provider));
          const totals: UsageTotals = {
            input: amount(u.input), output: amount(u.output), cacheRead: amount(u.cacheRead), cacheWrite: amount(u.cacheWrite),
            tokens: amount(u.totalTokens) || amount(u.input) + amount(u.output) + amount(u.cacheRead) + amount(u.cacheWrite),
            cost: cost.cost, requests: 1, reportedCost: cost.source === "reported" ? cost.cost : 0,
            estimatedCost: ["catalog", "custom"].includes(cost.source) ? cost.cost : 0,
            equivalentCost: cost.equivalentCost, unpricedRequests: cost.source === "unpriced" ? 1 : 0,
          };
          add(report, totals);
          const d = new Date(time);
          const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const day = days.get(date) || empty(); add(day, totals); days.set(date, day);
          const modelKey = JSON.stringify([provider, model]);
          const modelTotals = models.get(modelKey) || { ...empty(), provider, model, pricing: [] };
          // Add only numeric fields; preserve the model identifiers.
          for (const k of Object.keys(totals) as (keyof UsageTotals)[]) modelTotals[k] += totals[k];
          const detailKey = (item: CostDetail) => JSON.stringify([item.source, item.billing, item.rates, item.sourceUrl, item.checkedAt]);
          const previous = modelTotals.pricing.find(item => detailKey(item) === detailKey(cost));
          if (previous) {
            previous.requests++; previous.tokens += totals.tokens; previous.cost += cost.cost; previous.equivalentCost += cost.equivalentCost;
            if (previous.breakdown && cost.breakdown) for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) previous.breakdown[k] += cost.breakdown[k];
            else previous.breakdown = undefined;
          } else modelTotals.pricing.push({ ...cost, requests: 1, tokens: totals.tokens });
          models.set(modelKey, modelTotals);
        });
      } catch { report.unreadableFiles++; }
    }
  }));
  report.sessions = sessions.size;
  report.days = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, totals]) => ({ date, ...totals }));
  report.models = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  return report;
}
