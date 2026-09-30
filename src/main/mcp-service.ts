import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./session-store";

export type McpConfig = { mcpServers: Record<string, Record<string, unknown>>; autoEnableCodemode?: boolean; [key: string]: unknown };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export function validateMcpConfig(value: unknown): asserts value is McpConfig {
  if (!object(value) || !object(value.mcpServers)) throw new Error("Expected an object with mcpServers");
  if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== "boolean") throw new Error("autoEnableCodemode must be a boolean");
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !object(server)) throw new Error(`Invalid MCP server: ${name}`);
    const command = typeof server.command === "string" && !!server.command.trim();
    const url = typeof server.url === "string" && !!server.url.trim();
    if (command === url) throw new Error(`${name}: provide either command or url`);
    if (server.type !== undefined && !["stdio", "http", "streamable-http"].includes(String(server.type))) throw new Error(`${name}: unsupported transport`);
    if (command && server.type && server.type !== "stdio" || url && server.type === "stdio") throw new Error(`${name}: transport does not match command/url`);
    if (url) { const parsed = new URL(String(server.url)); if (!["http:", "https:"].includes(parsed.protocol)) throw new Error(`${name}: URL must use HTTP(S)`); }
    if (server.args !== undefined && (!Array.isArray(server.args) || !server.args.every(a => typeof a === "string"))) throw new Error(`${name}: args must be a string array`);
    for (const key of ["env", "headers"]) if (server[key] !== undefined && (!object(server[key]) || !Object.values(server[key]).every(v => typeof v === "string"))) throw new Error(`${name}: ${key} must contain strings`);
    if (server.enabled !== undefined && typeof server.enabled !== "boolean") throw new Error(`${name}: enabled must be a boolean`);
    if (server.timeout !== undefined && (typeof server.timeout !== "number" || !Number.isFinite(server.timeout) || server.timeout <= 0)) throw new Error(`${name}: timeout must be positive`);
    const exposures = ["direct", "codemode", "codemode-deferred", "deferred", "hidden"];
    if (server.exposure !== undefined && !exposures.includes(String(server.exposure))) throw new Error(`${name}: invalid exposure`);
    if (server.toolExposure !== undefined && (!object(server.toolExposure) || !Object.values(server.toolExposure).every(v => exposures.includes(String(v))))) throw new Error(`${name}: invalid toolExposure`);
  }
}
export function readMcpConfig(path = join(getAgentDir(), "mcp.json")): { path: string; config: McpConfig } {
  const config = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { mcpServers: {} };
  validateMcpConfig(config);
  return { path, config };
}
export function writeMcpConfig(config: unknown, path = join(getAgentDir(), "mcp.json")) {
  validateMcpConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.pi-studio-${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
  return { path, config };
}
