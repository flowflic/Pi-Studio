const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ts = require("typescript");

/**
 * Regression tests for the Glama-backed MCP marketplace: HTML parsing, install
 * candidate extraction, the mcp.json write path, and URL/field validation.
 * Network calls are never made here; only the pure parsers and local writes.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mcp-market-"));

function load(name, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main", name + ".ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)((id) => dependencies[id] || require(id), exports);
  return exports;
}

let stored = {
  mcpServers: {
    existing: { command: "npx", args: ["-y", "keep-me"], enabled: true },
  },
};
const mcpService = {
  readMcpConfig: () => ({ path: path.join(temp, "mcp.json"), config: JSON.parse(JSON.stringify(stored)) }),
  writeMcpConfig: (config) => {
    stored = JSON.parse(JSON.stringify(config));
    return { path: path.join(temp, "mcp.json"), config: stored };
  },
};
const market = load("mcp-marketplace", { "./mcp-service": mcpService });

const listingHtml = `<!doctype html><html><body>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{"@type":"Organization","name":"Glama","url":"https://glama.ai/"},
{"@type":"SearchResultsPage","mainEntity":{"@type":"ItemList","itemListElement":[
{"@type":"ListItem","position":1,"item":{"@type":"SoftwareApplication","name":"playwright-mcp","description":"Drive a real browser &amp; test pages.","url":"https://glama.ai/mcp/servers/microsoft/playwright-mcp","operatingSystem":"Cross-platform","author":{"@type":"Organization","name":"microsoft","url":"https://glama.ai/mcp/servers?query=author%3Amicrosoft"}}},
{"@type":"ListItem","position":2,"item":{"@type":"SoftwareApplication","name":"filesystem","description":"Read and write files.","url":"https://glama.ai/mcp/servers/X1pheR/mcp-server-filesystem","author":{"@type":"Organization","name":"X1pheR"}}}
]}}]}</script>
<ul>
<li><a href="/mcp/servers?attributes=hosting%3Alocal-only" aria-label="Local" class="x"><svg></svg>Local<span class="coigcm">42,542</span></a></li>
<li><a href="/mcp/servers?attributes=category%3Abrowser-automation" aria-label="Browser Automation" class="x"><svg></svg>Browser Automation<span class="coigcm">2,427</span></a></li>
<li><a href="/mcp/servers?attributes=javascript%3Aalert(1)" aria-label="Injected" class="x"><svg></svg>Injected<span class="coigcm">1</span></a></li>
</ul></body></html>`;

const detailHtml = `<!doctype html><html><body>
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[
{"@type":"SoftwareApplication","applicationCategory":"ServerApplication","name":"Playwright MCP Server","description":"Browser automation for agents.","license":"Apache 2.0","operatingSystem":"Cross-platform","author":{"@type":"Organization","name":"microsoft"},"url":"https://glama.ai/mcp/servers/microsoft/playwright-mcp"}
]}</script>
<p><a href="https://github.com/microsoft/playwright-cli">unrelated</a></p>
<p><a href="https://github.com/microsoft/playwright-mcp">repo</a></p>
<pre><code class="raw-code">{
  &quot;mcpServers&quot;: {
    &quot;playwright&quot;: {
      &quot;command&quot;: &quot;npx&quot;,
      &quot;args&quot;: [&quot;-y&quot;, &quot;@playwright/mcp@latest&quot;],
      &quot;env&quot;: { &quot;API_KEY&quot;: &quot;your-key&quot; }
    }
  }
}</code></pre>
<pre><code class="raw-code">{
  &quot;mcpServers&quot;: {
    &quot;local&quot;: {
      &quot;command&quot;: &quot;node&quot;,
      &quot;args&quot;: [&quot;/path/to/dist/index.js&quot;]
    }
  }
}</code></pre>
<pre><code class="raw-code">{ not json }</code></pre>
</body></html>`;

try {
  /* ---------------- entity decoding ---------------- */
  assert.equal(
    market.decodeHtmlEntities("&quot;a&quot; &amp; &lt;b&gt; &#x27;c&#x27; &#39;d&#39;"),
    `"a" & <b> 'c' 'd'`,
  );

  /* ---------------- listing ---------------- */
  const listing = market.parseGlamaListing(listingHtml, "https://glama.ai/mcp/servers?query=playwright");
  assert.equal(listing.items.length, 2, "both records parsed");
  assert.deepEqual(listing.items[0], {
    id: "microsoft/playwright-mcp",
    name: "playwright-mcp",
    description: "Drive a real browser &amp; test pages.",
    url: "https://glama.ai/mcp/servers/microsoft/playwright-mcp",
    author: "microsoft",
    authorUrl: "https://glama.ai/mcp/servers?query=author%3Amicrosoft",
    operatingSystem: "Cross-platform",
  });
  assert.equal(listing.items[1].id, "X1pheR/mcp-server-filesystem");
  assert.equal(listing.query, "playwright");
  assert.deepEqual(listing.facets, [
    { attribute: "hosting:local-only", label: "Local", count: 42542 },
    { attribute: "category:browser-automation", label: "Browser Automation", count: 2427 },
  ], "facets decode attributes and drop unsupported attribute shapes");

  /* ---------------- detail + candidates ---------------- */
  const detail = market.parseGlamaDetail(detailHtml, "https://glama.ai/mcp/servers/microsoft/playwright-mcp");
  assert.equal(detail.name, "Playwright MCP Server");
  assert.equal(detail.license, "Apache 2.0");
  assert.equal(detail.operatingSystem, "Cross-platform");
  assert.equal(detail.author, "microsoft");
  assert.equal(detail.repositoryUrl, "https://github.com/microsoft/playwright-mcp", "matching repo link wins");
  assert.equal(detail.candidates.length, 2, "two usable README configs");
  const [best, second] = detail.candidates;
  assert.equal(best.command, "npx");
  assert.deepEqual(best.args, ["-y", "@playwright/mcp@latest"]);
  assert.deepEqual(best.env, { API_KEY: "your-key" });
  assert.equal(best.transport, "stdio");
  assert.equal(best.name, "playwright");
  assert.equal(second.command, "node");
  assert.match(second.note, /占位/, "placeholder path is flagged");
  assert.equal(detail.warnings.length, 0, "a usable example keeps the panel free of a blocking warning");

  const placeholderOnly = market.parseGlamaDetail(
    `<script type="application/ld+json">{"@type":"SoftwareApplication","name":"Local","url":"https://glama.ai/mcp/servers/a/b"}</script>
     <pre><code class="raw-code">{&quot;mcpServers&quot;:{&quot;local&quot;:{&quot;command&quot;:&quot;node&quot;,&quot;args&quot;:[&quot;/path/to/index.js&quot;]}}}</code></pre>`,
    "https://glama.ai/mcp/servers/a/b",
  );
  assert.match(placeholderOnly.warnings.join(" "), /占位/, "only-placeholder examples warn before install");

  const noConfig = market.parseGlamaDetail(
    `<script type="application/ld+json">{"@type":"SoftwareApplication","name":"Empty","url":"https://glama.ai/mcp/servers/a/b"}</script>`,
    "https://glama.ai/mcp/servers/a/b",
  );
  assert.equal(noConfig.candidates.length, 0);
  assert.match(noConfig.warnings[0], /未能/);

  /* ---------------- entry sanitizing ---------------- */
  const entry = market.sanitizeServerEntry({
    command: "npx",
    args: [" -y ", "", "pkg"],
    env: { API_KEY: "x" },
  });
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args, ["-y", "pkg"]);
  assert.deepEqual(entry.env, { API_KEY: "x" });
  assert.equal(entry.enabled, true, "installed servers start enabled");
  assert.equal(entry.exposure, "codemode", "Codemode is the default exposure");
  assert.throws(() => market.sanitizeServerEntry({ command: "npx", args: ["x"], env: { "bad key": "y" } }), /env/);
  assert.throws(() => market.sanitizeServerEntry({ command: "npx", url: "https://x.test/mcp" }), /either a command or a URL/);
  assert.throws(() => market.sanitizeServerEntry({ url: "file:///etc/passwd" }), /HTTP/);
  assert.throws(() => market.sanitizeServerEntry({}), /either a command or a URL/);
  const httpEntry = market.sanitizeServerEntry({ url: "https://example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" }, type: "streamable-http", timeout: 30, unknown: "dropped" });
  assert.deepEqual(httpEntry, {
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer ${TOKEN}" },
    type: "streamable-http",
    enabled: true,
    exposure: "codemode",
    timeout: 30,
  }, "unknown keys are dropped and headers preserved");

  /* ---------------- install write path ---------------- */
  const installed = market.installMcpServer({ name: "Playwright MCP", server: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } });
  assert.equal(installed.name, "playwright-mcp", "names are sanitized");
  assert.deepEqual(Object.keys(installed.config.mcpServers).sort(), ["existing", "playwright-mcp"]);
  assert.deepEqual(installed.config.mcpServers.existing, { command: "npx", args: ["-y", "keep-me"], enabled: true }, "other entries are untouched");
  assert.deepEqual(installed.config.mcpServers["playwright-mcp"], {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
    enabled: true,
    exposure: "codemode",
  });

  assert.throws(
    () => market.installMcpServer({ name: "existing", server: { command: "npx" } }),
    (error) => error.code === "NAME_EXISTS",
    "duplicate names are rejected without overwrite",
  );
  const replaced = market.installMcpServer({ name: "existing", server: { command: "uvx", args: ["fetch"] }, overwrite: true });
  assert.equal(replaced.config.mcpServers.existing.command, "uvx");
  assert.equal(Object.keys(replaced.config.mcpServers).length, 2);
  assert.throws(() => market.installMcpServer({ name: "!!", server: { command: "npx" } }), /Invalid MCP server name/);

  /* ---------------- URL allow-list ---------------- */
  for (const bad of [
    "https://evil.example/mcp/servers/a/b",
    "http://glama.ai/mcp/servers/a/b",
    "https://glama.ai/not-the-directory",
    "javascript:alert(1)",
  ]) {
    assert.rejects(() => market.getMcpMarketplaceDetail(bad), /Only glama\.ai URLs|Only Glama MCP|Invalid Glama URL/);
  }
  assert.rejects(() => market.getMcpMarketplaceDetail("https://glama.ai/mcp/servers/only-one"), /Invalid Glama server URL/);
  assert.rejects(() => market.searchMcpMarketplace({ attribute: "javascript:alert(1)" }), /Unsupported Glama filter/);

  console.log(
    "MCP marketplace regression passed: listing/detail parsing, candidate ranking, placeholder warnings, " +
      "entry sanitizing, mcp.json merge/overwrite and the glama.ai URL allow-list.",
  );
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
