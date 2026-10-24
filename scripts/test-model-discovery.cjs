const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loadService(agentDir) {
  const source = ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/main/models-service.ts'), 'utf8'),
    { compilerOptions: { target: 9, module: 1 } },
  ).outputText;
  const exports = {};
  const deps = {
    './config': { getConfig: () => ({}) },
    './session-store': { getAgentDir: () => agentDir, getSessionsDir: () => path.join(agentDir, 'sessions') },
    './pi-bridge': { isAppManagedRuntime: () => false, resolvePiRuntime: async () => ({ node: process.execPath, cli: 'fixture' }), runtimeKind: () => 'system' },
    './model-url-compat': {
      toPiRuntimeProvider: (p) => p,
      toPiRuntimeProviders: (p) => p,
      toSettingsProviders: (p) => p,
    },
  };
  new Function('require', 'exports', 'module', source)((name) => deps[name] || require(name), exports, { exports });
  return exports;
}

(async () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-models-discovery-'));
  try {
    const service = loadService(agentDir);

    // No catalog on disk yet: a provider without an endpoint must say why.
    const missing = await service.discoverProviderModels({ apiKey: 'sk-test' }, 'opencode-go');
    assert.equal(missing.ok, false);
    assert.match(missing.message, /no cached model catalog/i, 'missing catalog should explain itself instead of "API URL is required."');

    // Pi's cached catalog is the model list for providers Studio only stores
    // credentials for (opencode-go, opencode, ...).
    fs.writeFileSync(
      path.join(agentDir, 'models-store.json'),
      JSON.stringify({
        'opencode-go': {
          models: [
            { id: 'beam-free', name: 'Beam Free', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/v1', reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 131072 },
            { id: 'qwen3-coder', name: 'Qwen3 Coder', api: 'openai-completions', baseUrl: 'https://opencode.ai/inference/go/v1' },
          ],
        },
      }),
    );

    const builtin = await service.discoverProviderModels({ apiKey: 'sk-test' }, 'opencode-go');
    assert.equal(builtin.ok, true);
    assert.deepEqual(builtin.models.map((m) => m.id), ['beam-free', 'qwen3-coder']);
    assert.equal(builtin.models[0].name, 'Beam Free');
    assert.equal(builtin.models[0].baseUrl, 'https://opencode.ai/inference/go/v1');

    // A provider with its own endpoint still goes to the network path, and an
    // unknown provider id stays an explicit error.
    const unknown = await service.discoverProviderModels({ apiKey: 'sk-test' }, 'not-in-catalog');
    assert.equal(unknown.ok, false);
    assert.match(unknown.message, /no cached model catalog/i);

    // Direct catalog lookup is exposed for the settings panel.
    assert.equal(service.builtinProviderModels('opencode-go').length, 2);
    assert.deepEqual(service.builtinProviderModels('unknown'), []);

    console.log('PASS built-in catalog fetch for providers without an API URL');
    console.log('PASS explicit error when neither URL nor catalog exists');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
