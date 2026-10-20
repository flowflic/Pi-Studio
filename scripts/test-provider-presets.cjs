const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

/**
 * Regression tests for the built-in provider quick setup: the credential store
 * (models.json apiKey), its precedence reporting against auth.json and the
 * environment, and the preset catalog against the bundled Pi runtime.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-presets-"));
const agentDir = path.join(temp, "agent");
fs.mkdirSync(agentDir, { recursive: true });
const modelsPath = path.join(agentDir, "models.json");
const authPath = path.join(agentDir, "auth.json");

function load(name, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main", name + ".ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)((id) => dependencies[id] || require(id), exports);
  return exports;
}

const compat = load("model-url-compat");
const service = load("models-service", {
  "./config": { getConfig: () => ({ piCliPath: "" }) },
  "./session-store": { getAgentDir: () => agentDir, getSessionsDir: () => path.join(agentDir, "sessions") },
  "./pi-bridge": {
    isAppManagedRuntime: () => false,
    resolvePiRuntime: async () => ({ node: process.execPath, cli: "cli.js" }),
    runtimeKind: () => "system",
  },
  "./model-url-compat": compat,
});

const presets = (() => {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/shared/provider-presets.ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)(require, exports);
  return exports;
})();

const readModels = () => JSON.parse(fs.readFileSync(modelsPath, "utf8"));
const writeModels = (value) => fs.writeFileSync(modelsPath, JSON.stringify(value, null, 2));
const writeAuth = (value) => fs.writeFileSync(authPath, JSON.stringify(value, null, 2));

try {
  /* ---------------- catalog invariants ---------------- */
  const catalog = presets.PROVIDER_PRESETS;
  assert.ok(catalog.length >= 12, "catalog lists the common coding plans");
  assert.equal(new Set(catalog.map((preset) => preset.id)).size, catalog.length, "preset ids are unique");
  assert.equal(new Set(catalog.map((preset) => preset.provider)).size, catalog.length, "each preset targets its own provider");
  for (const preset of catalog) {
    assert.match(preset.id, /^[a-z0-9-]+$/, `preset id is URL-safe: ${preset.id}`);
    assert.match(preset.provider, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, `provider id is valid: ${preset.provider}`);
    assert.match(preset.envVar, /^[A-Z][A-Z0-9_]*$/, `env var is a constant name: ${preset.envVar}`);
    assert.match(preset.baseUrl, /^https:\/\//, `endpoint is HTTPS: ${preset.id}`);
    assert.ok(preset.samples.length > 0, `preset lists sample models: ${preset.id}`);
    assert.ok(preset.testModel, `preset has a probe model: ${preset.id}`);
    assert.ok(preset.label.zh && preset.label.en, `preset is localized: ${preset.id}`);
    assert.ok(["cn", "global"].includes(preset.region), `preset has a region: ${preset.id}`);
  }
  for (const region of presets.PRESET_REGIONS) {
    assert.ok(presets.presetsForRegion(region.id).length > 0, `region ${region.id} has presets`);
  }
  assert.equal(presets.findProviderPreset("opencode-go").provider, "opencode-go");
  assert.equal(presets.findProviderPreset("missing"), undefined);

  // Match the presets against the runtime Pi actually ships: every provider id
  // and endpoint must exist in its built-in catalog, and the probe model must be
  // part of that catalog (the probe runs with --offline).
  const runtimeChunk = path.join(
    root,
    ".runtime-source/node_modules/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OIM2DMFI.js",
  );
  const providerDataDir = path.join(
    root,
    ".runtime-source/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data",
  );
  if (fs.existsSync(runtimeChunk)) {
    const bundle = fs.readFileSync(runtimeChunk, "utf8");
    for (const preset of catalog) {
      const escaped = preset.provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const providerPattern = new RegExp(`provider:"${escaped}"`, "g");
      assert.ok(bundle.match(providerPattern), `runtime catalog ships provider ${preset.provider}`);
      const modelPattern = new RegExp(
        `id:"${preset.testModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}",name:"[^"]+",api:"[^"]+",(?:baseUrl:"[^"]*",)?provider:"${escaped}"`,
      );
      assert.ok(modelPattern.test(bundle), `runtime catalog ships probe model ${preset.testModel} for ${preset.provider}`);

      // The provider data file is the authority for this provider's endpoint and
      // model ids. Checking it catches a preset copied from a sibling provider
      // (the panel would otherwise advertise another vendor's URL).
      const dataFile = path.join(providerDataDir, `${preset.provider}.json`);
      if (!fs.existsSync(dataFile)) continue;
      const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      const entries = Object.values(data).filter((entry) => entry && typeof entry === "object");
      const endpoints = new Set();
      const models = new Set();
      for (const entry of entries) {
        for (const model of Object.values(entry)) {
          if (!model || typeof model !== "object" || !model.id) continue;
          models.add(model.id);
          if (model.baseUrl) endpoints.add(model.baseUrl);
        }
      }
      assert.ok(
        endpoints.has(preset.baseUrl),
        `preset endpoint belongs to ${preset.provider}: expected one of ${[...endpoints].join(", ")}, got ${preset.baseUrl}`,
      );
      for (const sample of preset.samples) {
        assert.ok(models.has(sample), `sample model ${sample} ships with ${preset.provider}`);
      }
      assert.ok(models.has(preset.testModel), `probe model ${preset.testModel} ships with ${preset.provider}`);
    }
  } else {
    console.log("runtime catalog not installed; skipping provider/model cross-check");
  }

  /* ---------------- writing a key ---------------- */
  writeModels({
    marker: "preserved",
    providers: {
      opencode: { apiKey: "$OPENCODE_API_KEY", compat: { thinkingFormat: "openai" }, models: [{ id: "glm-5.3" }] },
    },
  });
  const written = service.writeProviderApiKey("zai", "sk-zai-fixture-0001");
  assert.equal(written.apiKey, "sk-zai-fixture-0001");
  let stored = readModels();
  assert.equal(stored.marker, "preserved", "unrelated top-level keys survive");
  assert.equal(stored.providers.opencode.apiKey, "$OPENCODE_API_KEY", "other providers are untouched");
  assert.deepEqual(stored.providers.opencode.models, [{ id: "glm-5.3" }], "existing model selections are untouched");
  assert.deepEqual(stored.providers.opencode.compat, { thinkingFormat: "openai" }, "existing compat is untouched");
  assert.deepEqual(stored.providers.zai, { apiKey: "sk-zai-fixture-0001" }, "the preset entry stores only the key");

  // Replacing the key keeps every other field of that provider.
  service.writeProviderApiKey("opencode", "sk-opencode-fixture-0002");
  stored = readModels();
  assert.equal(stored.providers.opencode.apiKey, "sk-opencode-fixture-0002");
  assert.deepEqual(stored.providers.opencode.models, [{ id: "glm-5.3" }]);

  /* ---------------- status reporting ---------------- */
  process.env.PI_PRESET_ENV_ONLY = "fixture-env-key";
  process.env.PI_PRESET_REFERENCE = "fixture-reference-key";
  service.writeProviderApiKey("zai-coding-cn", "$PI_PRESET_REFERENCE");
  service.writeProviderApiKey("qwen-token-plan-cn", "$PI_PRESET_MISSING");
  const statuses = service.readProviderCredentials([
    { provider: "zai", envVar: "ZAI_API_KEY" },
    { provider: "minimax", envVar: "PI_PRESET_ENV_ONLY" },
    { provider: "minimax-cn", envVar: "PI_PRESET_UNSET" },
    { provider: "zai-coding-cn", envVar: "ZAI_CODING_CN_API_KEY" },
    { provider: "qwen-token-plan-cn", envVar: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  ]);
  const byId = Object.fromEntries(statuses.map((status) => [status.provider, status]));

  assert.equal(byId.zai.source, "models");
  assert.equal(byId.zai.stored, true);
  assert.equal(byId.zai.resolved, true);
  assert.equal(byId.zai.detail, "…0001", "only the tail is previewed");
  assert.ok(!byId.zai.detail.includes("fixture"), "the stored key body is never returned");

  assert.equal(byId.minimax.source, "env", "an environment variable alone counts as configured");
  assert.equal(byId.minimax.detail, "PI_PRESET_ENV_ONLY");
  assert.equal(byId.minimax.stored, false);
  assert.equal(byId["minimax-cn"].source, "none");
  assert.equal(byId["minimax-cn"].resolved, false);

  assert.equal(byId["zai-coding-cn"].source, "models");
  assert.equal(byId["zai-coding-cn"].resolved, true, "a resolvable $VAR reference is usable");
  assert.equal(byId["zai-coding-cn"].detail, "$PI_PRESET_REFERENCE");

  assert.equal(byId["qwen-token-plan-cn"].source, "models");
  assert.equal(byId["qwen-token-plan-cn"].resolved, false, "an unset $VAR reference is flagged");

  // auth.json wins in Pi, so the panel must report the shadowing credential.
  writeAuth({ zai: { type: "api_key", key: "sk-auth-fixture-9999" } });
  const shadowed = service.readProviderCredentials([{ provider: "zai", envVar: "ZAI_API_KEY" }])[0];
  assert.equal(shadowed.source, "auth");
  assert.equal(shadowed.shadowed, true);
  assert.equal(shadowed.stored, true);
  assert.ok(!shadowed.detail.includes("auth-fixture"), "the auth.json key is masked as well");
  assert.ok(shadowed.detail.length <= 8, "the auth.json preview stays short");
  writeAuth({ zai: { type: "oauth", access: "token", expires: Date.now() - 1000 } });
  assert.equal(service.readProviderCredentials([{ provider: "zai" }])[0].resolved, false, "expired OAuth is not ready");
  writeAuth({ zai: { type: "oauth", access: "token" } });
  const oauth = service.readProviderCredentials([{ provider: "zai" }])[0];
  assert.equal(oauth.source, "auth");
  assert.equal(oauth.resolved, true, "an OAuth credential without an expiry stays usable");
  assert.equal(oauth.detail, "OAuth");
  writeAuth({ zai: {} });
  assert.equal(
    service.readProviderCredentials([{ provider: "zai" }])[0].source,
    "models",
    "an empty auth.json entry does not shadow the stored key",
  );

  /* ---------------- removing a key ---------------- */
  fs.unlinkSync(authPath);
  const remaining = service.deleteProviderApiKey("opencode");
  assert.deepEqual(remaining, { compat: { thinkingFormat: "openai" }, models: [{ id: "glm-5.3" }] }, "removal keeps the rest of the entry");
  assert.equal(readModels().providers.opencode.apiKey, undefined);
  assert.equal(service.deleteProviderApiKey("zai"), null, "an entry with nothing left is removed entirely");
  assert.equal(readModels().providers.zai, undefined);
  assert.equal(service.deleteProviderApiKey("never-configured"), null);
  assert.equal(readModels().marker, "preserved", "removal preserves unrelated content");

  /* ---------------- validation ---------------- */
  for (const [provider, key, message] of [
    ["../escape", "sk-test", "path-like provider ids are rejected"],
    ["", "sk-test", "an empty provider id is rejected"],
    ["zai", "   ", "an empty key is rejected"],
    ["zai", "line1\nline2", "a multi-line key is rejected"],
  ]) {
    assert.throws(() => service.writeProviderApiKey(provider, key), /Invalid provider id|API key/, message);
  }
  assert.equal(service.maskApiKey("short"), "••••");
  assert.equal(service.maskApiKey("sk-1234a"), "••••", "keys of eight characters or fewer reveal nothing");
  assert.equal(service.maskApiKey("sk-1234abcd"), "…abcd", "medium keys reveal only the tail");
  assert.equal(service.maskApiKey("sk-1234567890abcdef"), "…cdef", "medium keys reveal only the tail");
  assert.equal(service.maskApiKey("sk-1234567890abcdefghij"), "sk-…ghij", "long keys keep a short prefix");
  assert.ok(!service.maskApiKey("sk-1234567890abcdef").includes("1234567890"));
  assert.ok(!service.maskApiKey("sk-1234567890abcdefghij").includes("1234567890"));

  console.log(
    `Provider preset regression passed: ${catalog.length} presets verified against the bundled Pi catalog, ` +
      "credential write/remove keeps the rest of models.json, and auth.json/env precedence is reported correctly.",
  );
} finally {
  delete process.env.PI_PRESET_ENV_ONLY;
  delete process.env.PI_PRESET_REFERENCE;
  fs.rmSync(temp, { recursive: true, force: true });
}
