const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-visibility-"));
const modelsPath = path.join(temp, "models.json");
function load(name, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main", name + ".ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)(name => dependencies[name] || require(name), exports);
  return exports;
}
const visibility = load("model-visibility");
const { PiBridge } = load("pi-bridge", {
  electron: { app: {} },
  "./runtime-package": {},
  "./session-store": { getAgentDir: () => temp },
  "./model-visibility": visibility,
});
const save = providers => fs.writeFileSync(modelsPath, JSON.stringify({ providers }));
(async () => {
  try {
    // Reproduce the upstream merge with the actual runtime composer: 93 built-in
    // OpenCode models, of which Settings explicitly configures only 43.
    const { composeModelProvider } = await import(pathToFileURL(path.join(root,
      ".runtime-source/node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js")));
    const builtins = Array.from({ length: 93 }, (_, i) => ({
      provider: "opencode", id: `model-${i}`, name: `Model ${i}`, api: "openai-completions",
      baseUrl: "https://example.invalid/v1", reasoning: true, input: ["text"],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const definition = { api: "openai-completions", baseUrl: "https://example.invalid/v1",
      apiKey: "fixture", models: builtins.slice(0, 43).map(m => ({ id: m.id })) };
    const provider = composeModelProvider("opencode", { id: "opencode", auth: {}, getModels: () => builtins },
      { getProvider: () => definition });
    const merged = provider.getModels();
    assert.equal(merged.length, 93, "upstream merge reproduces the excess catalog entries");
    const other = { ...builtins[0], provider: "openai" };
    let raw = { models: [...merged, other], marker: "preserved" };
    const bridge = Object.create(PiBridge.prototype);
    bridge.send = async type => { assert.equal(type, "get_available_models"); return raw; };
    let refreshes = 0;
    bridge.prompt = async command => {
      assert.equal(command, "/pi-studio-refresh-models"); refreshes++;
    };
    save({ opencode: definition });
    let response = await bridge.getAvailableModels();
    assert.equal(response.models.filter(m => m.provider === "opencode").length, 43);
    assert.equal(response.marker, "preserved");
    assert.ok(response.models.includes(other), "unconfigured providers retain their built-in catalog");
    assert.equal(response.models[0], merged[0], "runtime capability metadata is preserved");
    assert.equal(raw.models.length, 94, "runtime response is not mutated");

    save({ opencode: { ...definition, models: [{ id: "model-1" }, { id: "not-available" }] } });
    response = await bridge.refreshModels();
    assert.equal(refreshes, 1);
    assert.deepEqual(response.models.filter(m => m.provider === "opencode").map(m => m.id), ["model-1"],
      "saved removals apply immediately and unavailable models are not fabricated");
    save({ opencode: { ...definition, models: [] } });
    assert.deepEqual((await bridge.getAvailableModels()).models, [other], "explicit empty selection hides built-ins");
    save({ opencode: { apiKey: "fixture" } });
    assert.equal((await bridge.getAvailableModels()).models.length, 94, "auth-only provider retains built-ins");
    save({});
    assert.equal((await bridge.getAvailableModels()).models.length, 94, "removing override restores built-ins");
    fs.writeFileSync(modelsPath, "{broken");
    assert.equal((await bridge.getAvailableModels()).models.length, 94, "invalid file falls back safely");
    fs.unlinkSync(modelsPath);
    assert.equal((await bridge.getAvailableModels()).models.length, 94, "missing configuration retains built-ins");
    raw = { unexpected: true };
    assert.deepEqual(await bridge.getAvailableModels(), raw, "non-model responses remain intact");
    console.log("Model visibility regression passed: upstream 93 -> configured 43, saved removal/refresh, empty/auth-only providers, metadata and availability.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
