const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(root, '.tmp-mcp-desktop-'));
function load(file, deps) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main', file + '.ts'), 'utf8'), { compilerOptions: { target: 9, module: 1 } }).outputText;
  new Function('require', 'exports', source)(name => deps[name] || require(name), exports);
  return exports;
}
(async () => {
  try {
    const api = load('mcp-service', { './session-store': { getAgentDir: () => temp } });
    const settings = path.join(temp, 'settings.json');
    for (const tools of [undefined, [], ['read', '-codemode'], ['-bash', '+powershell'], ['codemode', 'read']]) {
      const old = { defaultModel: 'fixture', packages: ['kept'], codemode: { inlineBudget: 1200 }, ...(tools === undefined ? {} : { defaultTools: tools }) };
      fs.writeFileSync(settings, JSON.stringify(old));
      assert.equal(api.writeCodemodeSettings({ mode: 'only' }).mode, 'only');
      const value = JSON.parse(fs.readFileSync(settings));
      assert.equal(value.defaultModel, 'fixture'); assert.deepEqual(value.packages, ['kept']); assert.equal(value.codemode.inlineBudget, 1200);
      assert.ok(!value.defaultTools.includes('-codemode'));
      if (tools?.length === 0) assert.deepEqual(value.defaultTools, ['codemode'], 'empty selection stays empty apart from Codemode');
      if (tools === undefined) assert.deepEqual(value.defaultTools, ['+codemode'], 'inherited tools stay inherited');
      const before = value.defaultTools;
      api.writeCodemodeSettings({ mode: 'on' });
      assert.deepEqual(JSON.parse(fs.readFileSync(settings)).defaultTools, before);
    }
    assert.throws(() => api.writeCodemodeSettings({ mode: 'invalid' }));
    const fixture = path.join(temp, 'cli.cjs');
    fs.writeFileSync(fixture, `console.log('https://fixture.invalid/authorize?state=test'); setInterval(()=>{},1000);`);
    let resolves = 0;
    const { runPiCli } = load('plugins', {
      './config': { getConfig: () => ({}) }, './session-store': { getAgentDir: () => temp },
      './pi-bridge': { resolvePiRuntime: async () => { resolves++; return { node: process.execPath, cli: fixture }; } },
    });
    const controller = new AbortController();
    let streamed = false;
    const result = await runPiCli([], undefined, 10000, { signal: controller.signal, onOutput: chunk => {
      assert.ok(chunk.includes('https://fixture.invalid/authorize'));
      streamed = true; controller.abort();
    } });
    assert.ok(streamed, 'authorization URL reaches the UI before process exit');
    assert.ok(result.cancelled, 'cancel settles the command');
    assert.ok(!result.timedOut);
    const timeout = await runPiCli([], undefined, 150);
    assert.ok(timeout.timedOut); assert.ok(!timeout.cancelled);
    const aborted = new AbortController(); aborted.abort();
    assert.ok((await runPiCli([], undefined, 10000, { signal: aborted.signal })).cancelled);
    assert.equal(resolves, 3);
    console.log('Codemode configuration preservation, live authorization output, cancellation and timeout passed');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
