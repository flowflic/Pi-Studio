const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

/**
 * Electron UI test for the package market: listing, search, details, install,
 * update, and load-more against a mocked preload bridge.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-package-market-"));
const watchdog = setTimeout(() => {
  console.error("Package market UI test timed out");
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
      import { PackageMarket } from "../src/renderer/src/components/PackageMarket";
      const root = createRoot(document.getElementById("app"));
      window.renderMarket = (packages, language) => root.render(
        React.createElement("div", { className: "plugins-modal" }, React.createElement(PackageMarket, { packages, language })),
      );
      window.renderMarket(window.installedPackages, "zh");
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
      <style>body{margin:0;padding:32px;background:var(--bg);color:var(--text)}
      .plugins-modal{position:static;width:720px;height:640px;margin:auto;display:flex;flex-direction:column}</style>
      </head><body><div id="app"></div><script>
        window.marketCalls = { search: [], detail: [], install: [], update: [] };
        window.installedPackages = [
          { source: "npm:@scope/fast@2.0.0", name: "fast", kind: "npm", enabled: true, version: "2.0.0" },
        ];
        window.marketListing = {
          items: [
            { name: "@scope/fast", version: "2.1.0", description: "Fast package.", author: "bob", license: "MIT",
              updatedAt: "2026-01-02T03:04:05.000Z", monthlyDownloads: 9000, weeklyDownloads: 2000,
              repositoryUrl: "https://github.com/bob/fast", npmUrl: "https://www.npmjs.com/package/@scope/fast",
              piUrl: "https://pi.dev/packages/@scope/fast" },
            { name: "slow-pkg", version: "0.1.0", description: "Slow package.", author: "alice", license: "MIT",
              monthlyDownloads: 100, weeklyDownloads: 20, npmUrl: "https://www.npmjs.com/package/slow-pkg",
              piUrl: "https://pi.dev/packages/slow-pkg" },
          ],
          from: 0,
          exhausted: false,
        };
        window.marketDetail = {
          name: "slow-pkg", version: "0.1.0", description: "Slow package.", license: "MIT",
          homepage: "https://example.com", repositoryUrl: "https://github.com/alice/slow-pkg",
          types: ["extension", "skill"], unpackedSize: 2048, dependencies: ["alpha", "beta"], peerDependencies: ["gamma"],
        };
        window.pi = { plugins: {
          searchPackageMarket: async (args) => {
            window.marketCalls.search.push(args);
            if ((args.query || "").trim() === "web") {
              return { items: window.marketListing.items.slice(1), from: 0, exhausted: true };
            }
            return window.marketListing;
          },
          getPackageMarketDetail: async (name) => {
            window.marketCalls.detail.push(name);
            return { ...window.marketDetail, name };
          },
          installPackage: async (source) => {
            window.marketCalls.install.push(source);
            window.installedPackages = [...window.installedPackages, { source, name: "slow-pkg", kind: "npm", enabled: true, version: "0.1.0" }];
            return { ok: true, output: "installed" };
          },
          updatePackages: async (source) => {
            window.marketCalls.update.push(source);
            return { ok: true, output: "updated" };
          },
          getPackages: async () => window.installedPackages,
          getSkills: async () => [],
        }};
      </script><script src="test.js"></script></body></html>`,
    );

    win = new BrowserWindow({
      width: 900,
      height: 800,
      show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 2) console.log(`[renderer:${level}] ${message}`);
    });
    await win.loadFile(path.join(temp, "index.html"));

    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
      const click = (element) => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
      const setValue = (element, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await settle(500);

      // 1. Initial browse runs on mount and lists the catalog.
      const initial = window.marketCalls.search[0];
      assert(initial && initial.from === 0 && initial.size === 30, "initial browse runs with the first page");
      const cards = [...document.querySelectorAll(".skills-hub-card")];
      assert(cards.length === 2, "both packages render");
      assert(cards[0].querySelector(".skills-hub-card-name").textContent === "@scope/fast", "first package name renders");
      assert(cards[0].querySelector(".skills-hub-installed-label").textContent.includes("已安装 v2.0.0"), "installed version is shown");
      assert(cards[0].querySelector(".pkg-market-desc").textContent === "Fast package.", "description renders");
      const piLink = document.querySelector('.skills-hub-link[href="https://pi.dev/packages"]');
      assert(piLink, "catalog links to pi.dev/packages");

      // 2. Installing an uninstalled package sends the npm source.
      click(cards[1].querySelector(".skills-hub-install"));
      await settle(400);
      assert(window.marketCalls.install.length === 1 && window.marketCalls.install[0] === "npm:slow-pkg", "install sends npm:<name>");

      // 3. Detail pane shows catalog metadata.
      click(cards[1]);
      await settle(400);
      assert(window.marketCalls.detail[0] === "slow-pkg", "detail fetched for the selected package");
      const detail = document.querySelector(".skills-hub-detail");
      assert(detail.querySelector(".skills-hub-detail-title").textContent === "slow-pkg", "detail title renders");
      assert(detail.querySelector(".skills-hub-install-command code").textContent === "pi install npm:slow-pkg", "install command is shown");
      const types = [...detail.querySelectorAll(".pkg-market-type")].map((node) => node.textContent);
      assert(types.join(",") === "extension,skill", "manifest types are listed");
      assert(detail.textContent.includes("MIT"), "license is listed");
      assert(detail.textContent.includes("2.0 KB"), "package size is listed");
      assert(detail.textContent.includes("依赖") && detail.textContent.includes("2 个"), "dependency count is listed");
      assert(detail.querySelector('a[href="https://github.com/alice/slow-pkg"]'), "repository link is shown");

      // 4. Installed packages expose an update action.
      click(cards[0].querySelector(".pkg-market-update"));
      await settle(400);
      assert(window.marketCalls.update[0] === "npm:@scope/fast", "update sends npm:<name>");

      // 5. Searching debounces into one request.
      const searchInput = document.querySelector(".skills-hub-search input");
      setValue(searchInput, "web");
      await settle(700);
      const lastSearch = window.marketCalls.search.at(-1);
      assert(lastSearch.query === "web" && lastSearch.from === 0, "search sends the trimmed query");
      assert(document.querySelectorAll(".skills-hub-card").length === 1, "search results replace the list");

      // 6. Clearing restores the catalog and load-more pages forward.
      click(document.querySelector(".plugins-search-clear"));
      await settle(600);
      const more = document.querySelector(".pkg-market-more");
      assert(more, "load-more is offered when the catalog has more results");
      click(more);
      await settle(500);
      const paged = window.marketCalls.search.at(-1);
      assert(paged.from === 2 && paged.query === "", "load-more requests the next offset");

      return "Package market UI passed: browse, install, details, update, search, load more";
    }})()`);

    console.log(result);

    const english = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      window.renderMarket(window.installedPackages, "en");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert(document.body.textContent.includes("OFFICIAL PACKAGE CATALOG"), "English intro");
      assert(document.body.textContent.includes("Installed"), "English installed label");
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
      /* Electron may retain cache locks until the process exits on Windows. */
    }
  }
});
