const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const source = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", "module", source)(name => name.endsWith(".mjs") ? require(path.resolve(path.dirname(file), name)) : name.startsWith(".") ? load(path.resolve(path.dirname(file), name + ".ts")) : require(name), exports, { exports });
  return exports;
}
const { getUsageReport } = load(path.join(root, "src/main/usage-service.ts"));
const { readMcpConfig, writeMcpConfig, validateMcpConfig } = load(path.join(root, "src/main/mcp-service.ts"));
const temp = fs.mkdtempSync(path.join(root, ".tmp-usage-test-"));
(async () => {
  try {
    const dir = path.join(temp, "sessions", "project"); fs.mkdirSync(dir, { recursive: true });
    const start = +new Date(2026, 8, 29), end = +new Date(2026, 9, 1);
    const usage = { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.01 } };
    const message = (id, timestamp, extra = {}) => ({ type: "message", id, timestamp: new Date(timestamp).toISOString(), message: { role: "assistant", timestamp, provider: "p", model: "m", usage, ...extra } });
    const shared = message("shared", start);
    fs.writeFileSync(path.join(dir, "a.jsonl"), [message("before", start - 1), shared, message("last", end - 1, { responseModel: "physical" }), message("after", end), { type: "usage", id: "warm", timestamp: new Date(start).toISOString(), provider: "p", model: "m", usage }, { type: "compaction", id: "summary", timestamp: new Date(start).toISOString(), usage }, { type: "message", id: "classifier", message: { role: "toolResult", timestamp: start, usage } }].map(e => JSON.stringify(e)).join("\n") + "\n{broken\n");
    fs.writeFileSync(path.join(dir, "b.jsonl"), JSON.stringify(shared) + "\n");
    const result = await getUsageReport({ from: start, to: end }, path.join(temp, "sessions"));
    assert.equal(result.tokens, 100, "request boundaries, summaries, classifier usage and fork deduplication");
    assert.equal(result.input, 50); assert.equal(result.requests, 5); assert.equal(result.cost, 0.05);
    assert.equal(result.days.length, 2); assert.equal(result.models.find(m => m.model === "physical").tokens, 20);
    await assert.rejects(getUsageReport({ from: end, to: start }, dir));
    assert.equal((await getUsageReport({ from: start, to: end }, path.join(temp, "missing"))).tokens, 0);
    const config = { metadata: { retained: true }, autoEnableCodemode: false, mcpServers: { local: { command: "node", args: ["server.js"], enabled: false, exposure: "codemode", env: { KEY: "${MY_KEY}" } }, remote: { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, exposure: "direct" } } };
    const file = path.join(temp, "mcp.json"); writeMcpConfig(config, file);
    assert.deepEqual(readMcpConfig(file).config, config);
    for (const server of [{ command: "node", url: "https://example.com" }, { url: "file:///x" }, { command: "node", type: "sse" }, { command: "node", args: "x" }, { command: "node", env: { key: 1 } }, { command: "node", exposure: "bad" }]) assert.throws(() => validateMcpConfig({ mcpServers: { server } }));
    assert.throws(() => writeMcpConfig({ mcpServers: { "bad name": { command: "node" } } }, file));
    assert.deepEqual(readMcpConfig(file).config, config, "invalid edits must not overwrite valid config");
    console.log("Usage range/deduplication/auxiliary usage and MCP validation/persistence tests passed");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
