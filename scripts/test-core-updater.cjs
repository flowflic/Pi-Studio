const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(root, '.tmp-core-updater-'));
const originalFetch = global.fetch;
const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar';
const integrity = bytes => 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64');
function archive(name, files) {
  const dir = path.join(temp, name);
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(dir, 'package', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  const target = path.join(temp, name + '.tgz');
  execFileSync(tar, ['-czf', target, '-C', dir, 'package']);
  return fs.readFileSync(target);
}
async function scenario({ shrinkwrap = false, broken = false, live = false } = {}) {
  const base = path.join(temp, `${shrinkwrap}-${broken}-${live}`);
  const versions = path.join(base, 'versions');
  let activated = false;
  let reset = false;
  const calls = [];
  const dependency = archive(`${shrinkwrap}-${broken}-${live}-dep`, { 'package.json': JSON.stringify({ name: 'fixture-dep', version: '1.0.0', main: 'index.js' }), 'index.js': 'module.exports = "ready";' });
  const lock = { lockfileVersion: 3, packages: { '': { version: '1.1.0' }, 'node_modules/fixture-dep': { version: '1.0.0', resolved: 'https://fixture/dep.tgz', integrity: broken ? 'sha512-invalid' : integrity(dependency) } } };
  const pkg = { name: '@earendil-works/pi-coding-agent', version: '1.1.0', engines: { node: '>=22.19.0' }, dependencies: { 'fixture-dep': '1.0.0' }, devDependencies: { 'must-not-install': '1.0.0' }, scripts: { install: 'must-not-run' } };
  const core = archive(`${shrinkwrap}-${broken}-${live}-core`, { 'package.json': JSON.stringify(pkg), 'dist/cli.js': 'if (require("fixture-dep") !== "ready") process.exit(1); console.log("1.1.0");', ...(shrinkwrap ? { 'npm-shrinkwrap.json': JSON.stringify(lock) } : {}) });
  const npm = archive(`${shrinkwrap}-${broken}-${live}-npm`, { 'bin/npm-cli.js': `const fs=require('node:fs'); const assert=require('node:assert/strict'); const pkg=JSON.parse(fs.readFileSync('package.json')); assert.equal(pkg.devDependencies,undefined); assert.equal(pkg.scripts,undefined); for(const flag of ['--ignore-scripts','--package-lock-only','--omit=dev']) assert.ok(process.argv.includes(flag)); fs.writeFileSync('package-lock.json',${JSON.stringify(JSON.stringify(lock))});` });
  global.fetch = async (url, options) => {
    calls.push(url);
    if (url === 'https://pi.dev/api/latest-version') return Response.json({ version: '1.1.0' });
    if (live) return originalFetch(url, options);
    if (url.includes('/pi-coding-agent/')) return Response.json({ dist: { tarball: 'https://fixture/core.tgz', integrity: integrity(core) } });
    if (url.includes('/npm/11.6.2')) return Response.json({ dist: { tarball: 'https://fixture/npm.tgz', integrity: integrity(npm) } });
    const bytes = { 'https://fixture/core.tgz': core, 'https://fixture/npm.tgz': npm, 'https://fixture/dep.tgz': dependency }[url];
    assert.ok(bytes, `unexpected request ${url}`);
    return new Response(bytes);
  };
  const api = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, 'src/main/core-updater.ts'), 'utf8'), { compilerOptions: { target: 9, module: 1 } }).outputText;
  new Function('require', 'exports', source)(name => {
    if (name === './pi-bridge') return { getBundledRuntime: () => null, runtimeKind: () => 'managed', resetPiRuntime: () => { reset = true; } };
    if (name === './runtime-package') return {
      runtimeBaseDir: () => base, runtimeVersionsDir: () => versions,
      getActiveRuntimeRoot: () => null, getActiveRuntimePaths: () => ({ node: process.execPath }),
      getRuntimePackageManifest: () => null, activateRuntimeRoot: (dir, version) => {
        assert.equal(version, '1.1.0');
        assert.equal(execFileSync(path.join(dir, 'node', process.platform === 'win32' ? 'node.exe' : 'node'), [path.join(dir, 'pi/dist/cli.js'), '--version'], { encoding: 'utf8' }).trim(), '1.1.0');
        activated = true;
      },
    };
    return require(name);
  }, api);
  const result = await api.installCoreUpdate();
  assert.equal(result.ok, !broken, result.message);
  assert.equal(activated, !broken, 'only activate a complete working runtime');
  assert.equal(reset, !broken);
  if (!live) assert.equal(calls.some(url => url.includes('/npm/')), !shrinkwrap, 'shipped lock bypasses resolver');
  assert.ok(!fs.readdirSync(base).some(name => name.startsWith('.staging-')), 'staging cleaned after success or failure');
  console.log(`PASS ${live ? 'official Pi 1.1.0' : shrinkwrap ? 'shipped lock' : broken ? 'integrity failure preserves active runtime' : 'missing shrinkwrap fallback'}`);
}
(async () => {
  try {
    await scenario();
    await scenario({ shrinkwrap: true });
    await scenario({ broken: true });
    if (process.env.PI_UPDATER_LIVE_TEST === '1') await scenario({ live: true });
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
