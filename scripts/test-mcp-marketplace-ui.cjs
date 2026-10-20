const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

/**
 * Electron UI test for the Glama-backed MCP marketplace mounted inside
 * Settings. It exercises browsing, filtering, the install review panel, the
 * overwrite guard, and the install write path against a mocked preload bridge.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-mcp-market-"));
const watchdog = setTimeout(() => {
  console.error("MCP marketplace UI test timed out");
  app.exit(1);
}, 60000);

app.setPath("userData", path.join(temp, "user-data"));

app.whenReady().then(async () => {
  let win;
  try {
    const entry = path.join(temp, "entry.tsx");
    fs.writeFileSync(
      entry,
      `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { McpSettings } from "../src/renderer/src/components/McpSettings";
      const root = createRoot(document.getElementById("app"));
      window.renderMcp = (language) => root.render(React.createElement(McpSettings, { language }));
      window.renderMcp("zh");
      `,
    );
    await esbuild.build({
      entryPoints: [entry],
      outfile: path.join(temp, "test.js"),
      bundle: true,
      platform: "browser",
      loader: { ".png": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
      jsx: "automatic",
    });

    fs.writeFileSync(
      path.join(temp, "index.html"),
      `<!doctype html><html><head>
      <link rel="stylesheet" href="../src/renderer/src/styles.css">
      <link rel="stylesheet" href="test.css">
      <style>body{margin:0;padding:36px;background:var(--bg);color:var(--text)}#app{max-width:1080px;margin:auto}.set-card{padding:20px}</style>
      </head><body><div id="app"></div><script>
        window.marketCalls = { search: [], detail: [], install: [] };
        window.mcpConfig = { mcpServers: { existing: { command: "npx", args: ["-y", "keep-me"], enabled: true } } };
        window.marketListing = {
          items: [
            { id: "microsoft/playwright-mcp", name: "playwright-mcp", description: "Drive a real browser from an agent.", url: "https://glama.ai/mcp/servers/microsoft/playwright-mcp", author: "microsoft", operatingSystem: "Cross-platform" },
            { id: "X1pheR/mcp-server-filesystem", name: "filesystem", description: "Read and write files within a sandbox.", url: "https://glama.ai/mcp/servers/X1pheR/mcp-server-filesystem", author: "X1pheR" },
          ],
          facets: [
            { attribute: "category:browser-automation", label: "Browser Automation", count: 2427 },
            { attribute: "hosting:local-only", label: "Local", count: 42542 },
          ],
          query: "",
          sourceUrl: "https://glama.ai/mcp/servers",
        };
        window.marketDetail = {
          id: "microsoft/playwright-mcp",
          name: "Playwright MCP Server",
          description: "Drive a real browser from an agent.",
          url: "https://glama.ai/mcp/servers/microsoft/playwright-mcp",
          author: "microsoft",
          license: "Apache 2.0",
          repositoryUrl: "https://github.com/microsoft/playwright-mcp",
          warnings: [],
          candidates: [
            { name: "playwright", transport: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"], env: { API_KEY: "your-key" }, origin: "readme" },
            { name: "local", transport: "stdio", command: "node", args: ["/path/to/dist/index.js"], origin: "readme", note: "README 示例中包含占位路径或示例地址，安装前请替换为实际值。" },
            { name: "remote", transport: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer \${TOKEN}" }, origin: "readme" },
          ],
        };
        window.pi = { settings: {
          getMcp: async () => ({ path: ".pi/agent/mcp.json", config: window.mcpConfig }),
          saveMcp: async (config) => { window.mcpConfig = config; return { path: ".pi/agent/mcp.json", config }; },
          getCodemode: async () => ({ mode: "on" }),
          saveCodemode: async (value) => value,
          mcpAction: async () => ({ code: 0, stdout: "", stderr: "" }),
          cancelMcpAction: async () => {},
          onMcpOutput: () => () => {},
          searchMcpMarketplace: async (options) => {
            window.marketCalls.search.push(options || {});
            return window.marketListing;
          },
          getMcpMarketplaceDetail: async (url) => {
            window.marketCalls.detail.push(url);
            return window.marketDetail;
          },
          installMcpServer: async (request) => {
            window.marketCalls.install.push(request);
            const servers = { ...window.mcpConfig.mcpServers };
            if (servers[request.name] && !request.overwrite) {
              const error = new Error("已存在同名 MCP 服务器：" + request.name);
              error.code = "NAME_EXISTS";
              throw error;
            }
            servers[request.name] = request.server;
            window.mcpConfig = { mcpServers: servers };
            return { path: ".pi/agent/mcp.json", config: window.mcpConfig, name: request.name };
          },
        }};
      </script><script src="test.js"></script></body></html>`,
    );

    win = new BrowserWindow({
      width: 1200,
      height: 1100,
      show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message}`);
    });
    await win.loadFile(path.join(temp, "index.html"));

    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));
      const click = (element) => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
      const setValue = (element, value) => {
        const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const setSelect = (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(element, value);
        element.dispatchEvent(new Event("change", { bubbles: true }));
      };
      await settle(400);

      // 1. The marketplace is part of the MCP settings and credits Glama.
      const market = document.querySelector(".mcp-market");
      assert(market, "marketplace card renders inside MCP settings");
      const credit = market.querySelector('.mcp-market-credit a[href="https://glama.ai"]');
      assert(credit && credit.textContent.includes("Glama"), "visible Glama credit links to glama.ai");
      const initialSearch = window.marketCalls.search[0];
      assert(
        window.marketCalls.search.length === 1 && initialSearch.query === undefined && initialSearch.attribute === undefined,
        "initial browse runs on mount",
      );

      // 2. Results and their Glama record links.
      const items = [...market.querySelectorAll(".mcp-market-item")];
      assert(items.length === 2, "both records render");
      const recordLink = items[0].querySelector('a[href="https://glama.ai/mcp/servers/microsoft/playwright-mcp"]');
      assert(recordLink && recordLink.textContent.includes("Glama"), "each record links back to its Glama listing");

      // 3. Facet filtering.
      const chips = [...market.querySelectorAll(".mcp-market-chip")];
      assert(chips.length === 2 && chips[0].textContent.includes("Browser Automation"), "facets render with labels");
      click(chips[0]);
      await settle();
      assert(chips[0].classList.contains("active"), "selected facet is highlighted");
      const filtered = window.marketCalls.search.at(-1);
      assert(filtered.attribute === "category:browser-automation", "facet search sends the attribute filter");
      click(chips[0]);
      await settle();
      assert(!window.marketCalls.search.at(-1).attribute, "clicking the active facet clears the filter");

      // 4. The install panel previews the README command.
      click(market.querySelector('[data-market-install="microsoft/playwright-mcp"]'));
      await settle(400);
      assert(window.marketCalls.detail.length === 1 && window.marketCalls.detail[0].endsWith("/microsoft/playwright-mcp"), "detail fetched for the chosen record");
      const panel = market.querySelector("[data-market-detail]");
      assert(panel, "install panel opens");
      assert(panel.querySelector("[data-market-command]").value === "npx", "command prefilled from the example");
      assert(
        panel.querySelector("[data-market-args]").value === ["-y", "@playwright/mcp@latest"].join(String.fromCharCode(10)),
        "arguments prefilled line by line",
      );
      assert(panel.querySelector('[aria-label="env name"]').value === "API_KEY", "env keys are lifted from the example");
      const preview = panel.querySelector("[data-market-preview]");
      preview.open = true;
      await settle();
      assert(preview.querySelector("pre").textContent.includes("@playwright/mcp@latest"), "generated entry is previewed");
      assert(preview.querySelector("pre").textContent.includes('"exposure": "codemode"'), "preview shows Studio defaults");

      // 5. Switching examples updates the form and surfaces placeholder warnings.
      const candidateSelect = panel.querySelector("[data-market-candidate]");
      setSelect(candidateSelect, "1");
      await settle();
      assert(panel.querySelector("[data-market-command]").value === "node", "second example replaces the command");
      assert(panel.textContent.includes("占位路径"), "placeholder warning visible for the selected example");
      setSelect(candidateSelect, "2");
      await settle();
      assert(panel.querySelector('[placeholder="https://example.com/mcp"]').value === "https://example.com/mcp", "remote example switches to HTTP");
      assert(panel.querySelector('[aria-label="header name"]').value === "Authorization", "headers lifted from the remote example");
      setSelect(candidateSelect, "0");
      await settle();

      // 6. Duplicate names require an explicit overwrite.
      setValue(panel.querySelector("[data-market-name]"), "existing");
      await settle();
      assert(panel.querySelector("[data-market-overwrite]"), "overwrite checkbox appears for an existing name");
      click(panel.querySelector("[data-market-submit]"));
      await settle();
      assert(window.marketCalls.install.length === 0, "install is blocked without overwrite");
      assert(panel.querySelector('[role="alert"]'), "the collision is explained");

      // 7. Installing writes the reviewed entry and refreshes the server list.
      panel.querySelector("[data-market-overwrite]").click();
      await settle();
      click(panel.querySelector("[data-market-submit]"));
      await settle(400);
      assert(window.marketCalls.install.length === 1, "install reaches the bridge once");
      const request = window.marketCalls.install[0];
      assert(request.name === "existing" && request.overwrite === true, "overwrite intent is forwarded");
      assert(request.server.command === "npx", "installed entry keeps the command");
      assert(Array.isArray(request.server.args) && request.server.args[0] === "-y", "installed entry keeps the args");
      assert(request.server.env.API_KEY === "your-key", "installed entry keeps the env map");
      assert(request.server.enabled === true && request.server.exposure === "codemode", "Studio defaults are written");
      assert(!market.querySelector("[data-market-detail]"), "install panel closes after writing");
      assert(document.body.textContent.includes("已安装"), "success is reported");
      assert(document.querySelector(".mcp-row .set-hint").textContent.includes("npx"), "server list reflects the new entry");

      return "MCP marketplace UI passed: browse, filter, preview, placeholder warning, overwrite guard and install";
    }})()`);

    console.log(result);
    fs.writeFileSync(path.join(root, "qa-mcp-marketplace.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
    await new Promise((resolve) => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(root, "qa-mcp-marketplace-dark.png"), (await win.webContents.capturePage()).toPNG());

    // 8. English UI (checked after the captures so the screenshots show Chinese).
    const english = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
      window.renderMcp("en");
      await settle();
      assert(document.querySelector(".mcp-market h3").textContent === "MCP marketplace", "English title");
      assert(document.body.textContent.includes("Install"), "English install labels");
      return "English labels passed";
    }})()`);
    console.log(english);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    clearTimeout(watchdog);
    if (win && !win.isDestroyed()) win.destroy();
    try {
      fs.rmSync(temp, { recursive: true, force: true });
    } catch {
      /* Electron may retain shader cache locks until the process exits on Windows. */
    }
  }
});
