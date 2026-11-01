const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

/**
 * Tests for the Pi package catalog: npm result normalization, manifest types,
 * search paging/caching with a stubbed registry, and installed npm versions.
 * No real network calls are made.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-market-"));

function load(name, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main", name + ".ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)((id) => dependencies[id] || require(id), exports);
  return exports;
}

const market = load("package-market");

const searchPayload = {
  objects: [
    {
      package: {
        name: "slow-pkg",
        version: "0.1.0",
        description: "  Slow   package. ",
        keywords: ["pi-package"],
        date: "2026-01-02T03:04:05.000Z",
        publisher: { username: "alice" },
        license: "MIT",
        links: { npm: "https://www.npmjs.com/package/slow-pkg", repository: "git+https://github.com/alice/slow-pkg.git" },
      },
      downloads: { monthly: 100, weekly: 20 },
    },
    {
      package: {
        name: "@scope/fast",
        version: "2.0.0",
        description: "Fast package.",
        keywords: ["pi-package", "extension"],
        maintainers: [{ username: "bob" }],
        license: { type: "Apache-2.0" },
        repository: "git@github.com:bob/fast.git",
      },
      downloads: { monthly: 9000, weekly: 2000 },
    },
    {
      package: {
        name: "not-a-pi-package",
        version: "1.0.0",
        description: "Unrelated.",
        keywords: ["cli"],
      },
      downloads: { monthly: 50000 },
    },
    { package: { name: "no-keywords", version: "1.0.0" }, downloads: { monthly: 7000 } },
  ],
};

const detailPayload = {
  name: "@scope/fast",
  version: "2.0.0",
  description: "Fast package.",
  license: { type: "MIT" },
  homepage: "https://example.com",
  repository: { type: "git", url: "git+https://github.com/bob/fast.git" },
  dist: { unpackedSize: 2048 },
  dependencies: { alpha: "^1.0.0", beta: "^2.0.0" },
  peerDependencies: { gamma: ">=1" },
  pi: { extensions: ["./ext.js"], skills: ["./skills"], themes: [] },
};

let fetchCalls = [];
let nextPayload = searchPayload;
global.fetch = async (url) => {
  fetchCalls.push(String(url));
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(nextPayload),
  };
};

async function main() {
  try {
  /* ---------------- name validation ---------------- */
  assert.equal(market.isPiPackageName("foo"), true);
  assert.equal(market.isPiPackageName("@scope/foo"), true);
  assert.equal(market.isPiPackageName("@scope/"), false);
  assert.equal(market.isPiPackageName("https://evil.example/x"), false);
  assert.equal(market.isPiPackageName("two words"), false);
  assert.equal(market.isPiPackageName(""), false);
  assert.equal(market.isPiPackageName("a".repeat(215)), false);

  /* ---------------- URLs ---------------- */
  assert.equal(market.piPackageUrl("@scope/fast"), "https://pi.dev/packages/@scope/fast");
  assert.equal(market.npmPackageUrl("plain"), "https://www.npmjs.com/package/plain");
  assert.equal(market.normalizeRepositoryUrl("git+https://github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(market.normalizeRepositoryUrl("git@github.com:a/b.git"), "https://github.com/a/b");
  assert.equal(market.normalizeRepositoryUrl("ssh://git@github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(market.normalizeRepositoryUrl("not a url"), undefined);

  /* ---------------- search result normalization ---------------- */
  const slow = market.normalizeSearchResult(searchPayload.objects[0]);
  assert.equal(slow.name, "slow-pkg");
  assert.equal(slow.description, "Slow package.");
  assert.equal(slow.author, "alice");
  assert.equal(slow.license, "MIT");
  assert.equal(slow.monthlyDownloads, 100);
  assert.equal(slow.weeklyDownloads, 20);
  assert.equal(slow.updatedAt, "2026-01-02T03:04:05.000Z");
  assert.equal(slow.repositoryUrl, "https://github.com/alice/slow-pkg");

  const fast = market.normalizeSearchResult(searchPayload.objects[1]);
  assert.equal(fast.name, "@scope/fast");
  assert.equal(fast.author, "bob");
  assert.equal(fast.license, "Apache-2.0");
  assert.equal(fast.repositoryUrl, "https://github.com/bob/fast");

  assert.equal(market.normalizeSearchResult(searchPayload.objects[2]), null, "packages without the pi-package keyword are excluded");
  assert.equal(market.normalizeSearchResult(searchPayload.objects[3]), null, "packages without keywords are excluded");
  assert.equal(market.normalizeSearchResult(null), null);

  const long = market.normalizeSearchResult({
    package: { name: "long-desc", version: "1.0.0", keywords: ["pi-package"], description: "x".repeat(600) },
  });
  assert.ok(long.description.length <= 400 && long.description.endsWith("…"));

  /* ---------------- manifest types ---------------- */
  assert.deepEqual(market.typesFromManifest({ extensions: ["./a.js"], skills: "./skills", prompts: [], themes: ["t"] }), [
    "extension",
    "skill",
    "theme",
  ]);
  assert.deepEqual(market.typesFromManifest(undefined), []);
  assert.deepEqual(market.typesFromManifest({ image: "preview.png" }), []);

  /* ---------------- detail normalization ---------------- */
  const detail = market.normalizePackageDetail("@scope/fast", detailPayload);
  assert.equal(detail.version, "2.0.0");
  assert.equal(detail.license, "MIT");
  assert.equal(detail.homepage, "https://example.com");
  assert.equal(detail.repositoryUrl, "https://github.com/bob/fast");
  assert.equal(detail.unpackedSize, 2048);
  assert.deepEqual(detail.types, ["extension", "skill"]);
  assert.deepEqual(detail.dependencies, ["alpha", "beta"]);
  assert.deepEqual(detail.peerDependencies, ["gamma"]);
  assert.equal(detail.deprecated, undefined);

  /* ---------------- search request and paging ---------------- */
  fetchCalls = [];
  const page = await market.searchPiMarketPackages({ query: "  web  ", from: 60, size: 10 });
  assert.equal(fetchCalls.length, 1);
  const requested = new URL(fetchCalls[0]);
  assert.equal(requested.origin + requested.pathname, "https://registry.npmjs.org/-/v1/search");
  assert.equal(requested.searchParams.get("text"), "keywords:pi-package web");
  assert.equal(requested.searchParams.get("from"), "60");
  assert.equal(requested.searchParams.get("size"), "10");
  assert.deepEqual(page.items.map((item) => item.name), ["@scope/fast", "slow-pkg"], "sorted by monthly downloads");
  assert.equal(page.from, 60);
  assert.equal(page.exhausted, true, "fewer raw results than the page size means the catalog is exhausted");

  fetchCalls = [];
  await market.searchPiMarketPackages({ query: "web", from: 60, size: 10 });
  assert.equal(fetchCalls.length, 0, "repeated searches use the cache");

  fetchCalls = [];
  nextPayload = { objects: Array.from({ length: 10 }, () => searchPayload.objects[0]) };
  const fullPage = await market.searchPiMarketPackages({ query: "cached", size: 10 });
  assert.equal(fullPage.items.length, 10);
  assert.equal(fullPage.exhausted, false, "a full page leaves room for more results");

  /* ---------------- detail request and caching ---------------- */
  fetchCalls = [];
  nextPayload = detailPayload;
  const fetched = await market.getPiMarketPackageDetail("@scope/fast");
  assert.equal(fetched.name, "@scope/fast");
  assert.equal(fetchCalls[0], "https://registry.npmjs.org/%40scope%2Ffast/latest");
  const cachedDetail = await market.getPiMarketPackageDetail("@scope/fast");
  assert.equal(cachedDetail, fetched, "repeated detail reads use the cache");
  assert.equal(fetchCalls.length, 1);

  fetchCalls = [];
  await assert.rejects(() => market.getPiMarketPackageDetail("../../etc/passwd"));
  assert.equal(fetchCalls.length, 0, "invalid names never reach the registry");

  /* ---------------- installed npm versions ---------------- */
  const agentDir = path.join(temp, "agent");
  fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "@scope", "fast"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "npm", "node_modules", "plain"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "npm", "node_modules", "@scope", "fast", "package.json"), JSON.stringify({ version: "2.0.0" }));
  fs.writeFileSync(path.join(agentDir, "npm", "node_modules", "plain", "package.json"), JSON.stringify({ version: "1.5.3" }));
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: ["npm:@scope/fast@2.0.0", { source: "npm:plain", autoload: false }, "git:github.com/user/repo"],
    }),
  );

  const plugins = load("plugins", {
    "./config": { getConfig: () => ({}) },
    "./pi-bridge": { resolvePiRuntime: () => ({}) },
    "./session-store": { getAgentDir: () => agentDir },
  });

  assert.equal(plugins.npmPackageName("npm:@scope/fast@2.0.0"), "@scope/fast");
  assert.equal(plugins.npmPackageName("npm:plain@1.5.3"), "plain");
  assert.equal(plugins.npmPackageName("npm:@scope/fast"), "@scope/fast");
  assert.equal(plugins.npmPackageName("git:github.com/user/repo"), null);
  assert.equal(plugins.npmPackageName("npm:"), null);

  const installed = plugins.listPackages();
  assert.deepEqual(
    installed.map((item) => ({ source: item.source, name: item.name, kind: item.kind, enabled: item.enabled, version: item.version })),
    [
      { source: "npm:@scope/fast@2.0.0", name: "fast", kind: "npm", enabled: true, version: "2.0.0" },
      { source: "npm:plain", name: "plain", kind: "npm", enabled: false, version: "1.5.3" },
      { source: "git:github.com/user/repo", name: "repo", kind: "git", enabled: true, version: undefined },
    ],
  );

  console.log("package market tests passed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
