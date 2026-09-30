export type PlanWindows = Record<string, { percent?: number; resetsAt?: string; unlimited?: boolean; text?: string }>;
export function parseAnthropicUsage(data: any): PlanWindows | null;
export function parseZaiUsage(data: any): PlanWindows | null;
export function parseMiniMaxRemains(data: any): PlanWindows | null;
export function parseKimiCodingUsage(data: any): PlanWindows | null;
