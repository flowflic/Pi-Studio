const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

/**
 * Electron UI test for the provider quick-setup panel. It mounts the real
 * component against a mocked preload bridge and exercises the flows a user
 * takes: pick a plan, test, save, remove, and read the auth.json warning.
 */
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-quick-setup-"));
const watchdog = setTimeout(() => {
  console.error("Provider quick setup UI test timed out");
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
      import { ProviderPresets } from "../src/renderer/src/components/ProviderPresets";
      import { Settings } from "../src/renderer/src/components/Settings";
      import { useStore } from "../src/renderer/src/store";
      const root = createRoot(document.getElementById("app"));
      window.testStore = useStore;
      window.renderPanel = (language) => {
        window.events = [];
        root.render(
          React.createElement(ProviderPresets, {
            language,
            onProviderSaved: (provider, entry) => window.events.push({ type: "provider", provider, entry }),
            onModelsChanged: () => window.events.push({ type: "refresh" }),
          }),
        );
      };
      window.renderSettings = (tab) => {
        window.testStore.setState({ settingsOpen: true, settingsTab: tab || null, config: { language: "zh" } });
        root.render(React.createElement(Settings));
      };
      window.renderPanel("zh");
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
      <style>body{margin:0;padding:36px;background:var(--bg);color:var(--text)}#app{max-width:1040px;margin:auto}</style>
      </head><body><div id="app"></div><script>
        window.events = [];
        window.credentialBatches = [];
        window.savedKeys = [];
        window.removedKeys = [];
        window.testCalls = [];
        const fixture = [
          { provider: "zai", source: "models", detail: "…0001", resolved: true, stored: true, shadowed: false },
          { provider: "minimax", source: "env", detail: "MINIMAX_API_KEY", resolved: true, stored: false, shadowed: false },
          { provider: "zai-coding-cn", source: "models", detail: "…9f3a", resolved: true, stored: true, shadowed: true },
        ];
        window.pi = { settings: {
          getProviderCredentials: async (requests) => {
            window.credentialBatches.push(requests.map((request) => request.provider));
            return requests.map((request) => fixture.find((row) => row.provider === request.provider) || {
              provider: request.provider, source: "none", resolved: false, stored: false, shadowed: false,
            });
          },
          saveProviderKey: async ({ provider, apiKey }) => {
            window.savedKeys.push({ provider, apiKey });
            return { ok: true, provider: { apiKey }, credentials: { provider, source: "models", detail: "…qrst", resolved: true, stored: true, shadowed: false } };
          },
          removeProviderKey: async (provider) => {
            window.removedKeys.push(provider);
            return { ok: true, provider: null, credentials: { provider, source: "none", resolved: false, stored: false, shadowed: false } };
          },
          testProviderKey: async (args) => {
            window.testCalls.push(args);
            return { ok: true, latencyMs: 1234, message: "Model started responding successfully." };
          },
          // Settings panel reads
          getModels: async () => ({ providers: {} }),
          getThinking: async () => ({}),
          getDiagnostics: async () => ({ agentDir: "/fixture", sessionsDir: "/fixture/sessions", settingsPath: "/fixture/settings.json", authPath: "/fixture/auth.json", modelsPath: "/fixture/models.json", settingsExists: true, authExists: false, modelsExists: true, runtimeKind: "system", bundled: true, error: null, node: "node", cli: "pi", nodeVersion: "24", piVersion: "1.1.0" }),
          getPaths: async () => ({ agentDir: "/fixture", models: "/fixture/models.json", settings: "/fixture/settings.json", auth: "/fixture/auth.json" }),
          saveModels: async (providers) => ({ ok: true, models: { providers } }),
          saveThinking: async (patch) => patch,
          getMcp: async () => ({ config: { mcpServers: {} }, path: "/fixture/mcp.json" }),
          getCodemode: async () => ({ mode: "on" }),
          saveCodemode: async ({ mode }) => ({ mode }),
          saveMcp: async (config) => ({ config }),
          mcpAction: async () => ({ code: 0, stdout: "", stderr: "" }),
          cancelMcpAction: async () => ({ ok: true }),
          onMcpOutput: () => () => {},
          searchMcpMarketplace: async () => ({ items: [], facets: [], total: 0, sourceUrl: "https://glama.ai/mcp/servers", fetchedAt: 0 }),
        }, app: {
          getVersion: async () => "0.4.6",
          getConfig: async () => ({ language: "zh" }),
          setConfig: async (patch) => ({ language: "zh", ...patch }),
          checkCoreUpdate: async () => ({ available: false }),
          checkAppUpdate: async () => ({ available: false }),
          getProjects: async () => [],
        }, on: {
          coreUpdate: () => () => {},
          appUpdate: () => () => {},
          event: () => () => {},
          extui: () => () => {},
          exit: () => () => {},
          error: () => () => {},
          focusThread: () => () => {},
          automation: () => () => {},
          projectsChanged: () => () => {},
        }};
        window.confirm = () => true;
      </script><script src="test.js"></script></body></html>`,
    );

    win = new BrowserWindow({
      width: 1200,
      height: 1000,
      show: false,
      webPreferences: { offscreen: true, backgroundThrottling: false },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    await win.loadFile(path.join(temp, "index.html"));

    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
      const click = (element) => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
      const setInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      const item = (preset) => document.querySelector('[data-preset="' + preset + '"]');
      await settle();

      // 1. The whole catalog renders, grouped by region.
      assert(document.querySelectorAll(".set-quick-item").length === 14, "all 14 presets render");
      const groups = [...document.querySelectorAll(".set-quick-group-title")].map((node) => node.textContent);
      assert(groups.includes("国内直连") && groups.includes("国际站"), "regions are grouped");

      // 2. Credential status drives the pills.
      const zaiItem = item("zai-global");
      assert(zaiItem && zaiItem.classList.contains("on"), "a saved key marks the preset configured");
      assert(zaiItem.querySelector(".set-quick-meta").textContent.includes("已保存密钥"), "saved key status text");
      assert(item("minimax").querySelector(".set-quick-meta").textContent.includes("已设置环境变量"), "env var status text");
      assert(!item("deepseek").classList.contains("on"), "unconfigured provider stays inactive");
      assert(item("deepseek").querySelector(".set-quick-meta").textContent.includes("未配置"), "unconfigured status text");
      assert(window.credentialBatches.length === 1, "statuses load once on mount");

      // 3. Selecting a preset opens the panel directly under its card, with the
      //    provider's own endpoint (never a sibling provider's).
      click(zaiItem);
      await settle();
      let detail = document.querySelector('[data-preset-detail="zai-global"]');
      assert(detail, "selecting a preset opens its detail panel");
      assert(detail.textContent.includes("https://api.z.ai/api/coding/paas/v4"), "canonical endpoint shown read-only");
      assert(detail.previousElementSibling === zaiItem, "the panel opens directly under the selected card");
      assert(detail.parentElement.classList.contains("set-quick-grid"), "the panel lives inside the preset grid");
      assert(document.querySelectorAll("[data-preset-detail]").length === 1, "only one preset panel is open");
      assert(detail.textContent.includes("ZAI_API_KEY"), "env var shown");
      assert(detail.textContent.includes("glm-5.3"), "sample models shown");

      // Switching providers must re-render that provider's own facts in place.
      click(item("qwen-token-plan"));
      await settle();
      const qwenDetail = document.querySelector('[data-preset-detail="qwen-token-plan"]');
      assert(qwenDetail, "switching presets replaces the panel");
      assert(
        qwenDetail.textContent.includes("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"),
        "the Qwen panel shows the Qwen endpoint",
      );
      assert(!qwenDetail.textContent.includes("https://open.bigmodel.cn"), "a sibling provider's endpoint never leaks in");
      assert(
        qwenDetail.previousElementSibling === item("qwen-token-plan") && qwenDetail.parentElement.classList.contains("set-quick-grid"),
        "the panel follows the newly selected card",
      );
      assert(document.querySelectorAll("[data-preset-detail]").length === 1, "still exactly one open panel");

      // Collapsing and re-opening starts from a clean key draft.
      click(item("qwen-token-plan"));
      await settle();
      assert(!document.querySelector("[data-preset-detail]"), "clicking the active card collapses the panel");
      click(zaiItem);
      await settle();
      detail = document.querySelector('[data-preset-detail="zai-global"]');
      const saveButton = [...detail.querySelectorAll("button")].find((node) => node.textContent.includes("保存并启用"));
      assert(saveButton.disabled, "saving is disabled until a key is typed");

      // 4. The connectivity probe targets the preset's catalog model.
      const input = detail.querySelector('input[type="password"]');
      assert(input, "the key field is masked by default");
      setInput(input, "sk-live-abcdefghijklmnop");
      await settle();
      assert(!saveButton.disabled, "a typed key enables saving");
      click([...detail.querySelectorAll("button")].find((node) => node.textContent.includes("测试连接")));
      await settle();
      assert(window.testCalls.length === 1, "the test button calls the probe");
      assert(window.testCalls[0].provider === "zai" && window.testCalls[0].modelId === "glm-5.3", "probe uses the preset model");
      assert(window.testCalls[0].apiKey === "sk-live-abcdefghijklmnop", "probe checks the unsaved draft key");
      assert(detail.textContent.includes("密钥可用"), "a successful probe is reported");

      // 5. Saving writes the key, refreshes models and reports upward.
      click(saveButton);
      await settle();
      assert(window.savedKeys.length === 1, "save reaches the preload bridge once");
      assert(window.savedKeys[0].provider === "zai" && window.savedKeys[0].apiKey === "sk-live-abcdefghijklmnop", "save carries provider and key");
      assert(window.events.some((event) => event.type === "provider" && event.provider === "zai" && event.entry), "saved entry is merged into the Settings draft");
      assert(window.events.some((event) => event.type === "refresh"), "open threads are refreshed");
      assert(window.credentialBatches.length >= 2, "statuses reload after saving");
      assert(document.querySelector('[data-preset-detail="zai-global"] input[type="password"]').value === "", "the key draft is cleared after saving");

      // 6. Removing requires confirmation and clears the provider entry.
      click([...detail.querySelectorAll("button")].find((node) => node.textContent.includes("移除密钥")));
      await settle();
      assert(window.removedKeys.length === 1 && window.removedKeys[0] === "zai", "remove reaches the bridge");
      assert(window.events.some((event) => event.type === "provider" && event.provider === "zai" && event.entry === null), "removal clears the draft entry");

      // 7. A shadowing auth.json credential is explained on the panel.
      click(item("zai-cn"));
      await settle();
      const shadowDetail = document.querySelector('[data-preset-detail="zai-cn"]');
      assert(shadowDetail.querySelector(".set-quick-warn"), "auth.json shadowing is flagged");
      assert(shadowDetail.querySelector(".set-quick-warn").textContent.includes("auth.json"), "the warning names auth.json");

      return "Quick provider setup UI passed: 14 presets, status pills, draft probe, save/remove plumbing and auth.json warning";
    }})()`);

    console.log(result);
    fs.writeFileSync(path.join(root, "qa-provider-quick-setup.png"), (await win.webContents.capturePage()).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.dataset.theme='dark'");
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.writeFileSync(path.join(root, "qa-provider-quick-setup-dark.png"), (await win.webContents.capturePage()).toPNG());

    // 8. The panel follows the app language (checked after the screenshots so
    // the captures show the default Chinese UI).
    const english = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
      window.renderPanel("en");
      await settle();
      assert(document.querySelector(".set-quick-title").textContent === "Quick provider setup", "English title");
      assert([...document.querySelectorAll(".set-quick-group-title")].map((node) => node.textContent).includes("China mainland"), "English region label");
      assert(document.querySelector('[data-preset="opencode-go"]').textContent.includes("OpenCode Go"), "preset labels stay product names");
      return "English labels passed";
    }})()`);
    console.log(english);

    // 9. The panel is wired into the real Settings component: saving a preset
    // merges a provider card into the draft without flagging unsaved changes.
    const settingsCheck = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
      const click = (element) => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); };
      const setInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      window.renderSettings();
      await settle(500);
      assert(document.querySelector(".set-quick"), "the quick panel is mounted inside Settings");
      assert(document.body.textContent.includes("保存模型配置"), "the models tab rendered");

      const card = document.querySelector('[data-preset="deepseek"]');
      assert(card, "the deepseek preset is offered inside Settings");
      click(card);
      await settle();
      const detail = document.querySelector('[data-preset-detail="deepseek"]');
      setInput(detail.querySelector('input[type="password"]'), "sk-settings-integration");
      await settle();
      click([...detail.querySelectorAll("button")].find((node) => node.textContent.includes("保存并启用")));
      await settle(500);

      const providerIds = [...document.querySelectorAll(".set-prov-id")].map((node) => node.textContent);
      assert(providerIds.includes("deepseek"), "the saved provider appears as a provider card");
      const deepseekCard = [...document.querySelectorAll(".set-card")].find(
        (node) => node.querySelector(".set-prov-id")?.textContent === "deepseek",
      );
      assert(deepseekCard.textContent.includes("内置模型目录"), "the auth-only card explains it uses the built-in catalog");
      assert(!deepseekCard.textContent.includes("暂无模型"), "the auth-only card does not claim there are no models");
      const headerSave = document.querySelector(".set-head-actions .set-btn.primary");
      assert(headerSave && !headerSave.querySelector(".set-dot"), "quick setup does not mark the model draft as unsaved");
      // The sidebar shortcut opens Settings directly on the MCP tab, where the
      // Glama marketplace is the first card. Close first: the tab is chosen on
      // the open transition, exactly like a real sidebar click.
      window.testStore.setState({ settingsOpen: false });
      await settle();
      window.renderSettings("mcp");
      await settle(500);
      assert(document.body.textContent.includes("MCP marketplace") || document.body.textContent.includes("MCP 市场"), "the MCP shortcut opens the MCP tab");
      assert(document.body.textContent.includes("Glama"), "the marketplace is the first thing on that tab");
      return "Settings integration passed: quick panel mounted, provider card merged, no false dirty state, MCP shortcut opens the marketplace";
    }})()`);
    console.log(settingsCheck);
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
