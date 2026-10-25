/**
 * Renders the Settings → Update release-notes block in a real Electron window:
 * Markdown from the GitHub release must be readable, bounded, and linked, with
 * a clear fallback when a release has no notes.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-update-notes-ui-"));
const watchdog = setTimeout(() => { console.error("Update notes UI test timed out"); app.exit(1); }, 45000);
app.setPath("userData", path.join(temp, "user-data"));
app.whenReady().then(async () => {
  let win;
  try {
    const entry = path.join(temp, "entry.tsx");
    fs.writeFileSync(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppUpdateNotes } from '../src/renderer/src/components/AppUpdateNotes';
import { useStore } from '../src/renderer/src/store';
window.testStore = useStore;
const root = createRoot(document.getElementById('app'));
window.renderNotes = (props) => root.render(<div style={{ width: 760 }}><AppUpdateNotes {...props} /></div>);
`);
    await esbuild.build({
      entryPoints: [entry],
      outfile: path.join(temp, "test.js"),
      bundle: true,
      platform: "browser",
      loader: { ".png": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
    });
    fs.writeFileSync(
      path.join(temp, "index.html"),
      `<html><head><meta charset="utf-8"><link rel="stylesheet" href="../src/renderer/src/styles.css"><style>body{padding:24px;background:var(--bg)}</style></head><body><div id="app"></div><script src="test.js"></script></body></html>`,
    );
    win = new BrowserWindow({ width: 860, height: 760, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, "index.html"));

    const first = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      window.testStore.setState({ config: { language: "zh" } });

      const notes = [
        "## 本次更新",
        "",
        "### 新增",
        "",
        "- 内置 Pi 升级到 **1.4.0**，支持按模型输出上限生成压缩摘要。",
        "- 应用更新会显示新版本的更新说明。",
        "",
        "### 修复",
        "",
        "- 修复 OpenCode Go 额度在 Token Plan 页面不显示的问题。",
        "- 修复 models.json 环境变量引用未生效时的提示。",
        "",
        "```bash",
        "npm run build",
        "```",
        "",
        "详见 [发布页](https://github.com/flowflic/Pi-Studio/releases)。",
        "- 额外的说明行，用于让内容超过滚动区域高度。".repeat(6),
      ].join("\n");

      window.renderNotes({
        language: "zh",
        version: "0.4.12",
        releaseName: "Pi Studio 0.4.12",
        releaseDate: "2026-10-25T04:00:00Z",
        releaseUrl: "https://github.com/flowflic/Pi-Studio/releases/tag/v0.4.12",
        releaseNotes: notes,
      });
      await settle();

      const box = document.querySelector(".upd-notes");
      assert(box, "notes block renders");
      assert(box.getAttribute("data-update-notes") === "0.4.12", "block is tagged with the version");
      assert(box.textContent.includes("v0.4.12 更新内容"), "title names the version");
      assert(box.textContent.includes("Pi Studio 0.4.12"), "release name is shown when it adds information");
      assert(/\d{4}/.test(document.querySelector(".upd-notes-date").textContent), "release date is shown");

      const body = document.querySelector(".upd-notes-body");
      assert(body, "notes body renders markdown");
      assert(body.querySelector("h3"), "markdown headings render");
      assert(body.querySelector("li"), "markdown lists render");
      assert(body.querySelector(".code-block"), "fenced code renders as a code block");
      assert(body.clientHeight <= 241, "notes are height-bounded: " + body.clientHeight);
      assert(body.scrollHeight > body.clientHeight, "long notes scroll instead of pushing the panel");

      const link = document.querySelector(".upd-notes-link");
      assert(link && link.getAttribute("href").includes("/releases/tag/v0.4.12"), "release link points at the tag");
      assert(link.getAttribute("target") === "_blank", "release link opens outside the app");
      return body.clientHeight;
    }.toString()})()`);
    console.log("bounded notes height:", first);

    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, "qa-app-update-notes.png"), image.toPNG());
    console.log("screenshot: qa-app-update-notes.png");

    const fallback = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
      window.renderNotes({
        language: "en",
        version: "0.4.12",
        releaseNotes: "",
        releaseUrl: "https://github.com/flowflic/Pi-Studio/releases/latest",
      });
      await settle();
      const box = document.querySelector(".upd-notes");
      assert(box.textContent.includes("no notes attached"), "missing notes fall back to a hint");
      assert(!document.querySelector(".upd-notes-name"), "empty release name is omitted");
      assert(!document.querySelector(".upd-notes-body"), "no empty markdown area");
      assert(box.querySelector(".upd-notes-link"), "fallback still links to the release");
      return "Update notes: version/date/name, Markdown headings/lists/code, bounded scroll, tag link and empty-notes fallback passed.";
    }.toString()})()`);
    console.log(fallback);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    win?.destroy();
    // Chromium may still hold its user-data cache open; a leftover temp dir is
    // harmless, a crash during teardown is not.
    try {
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    } catch {
      /* best effort cleanup */
    }
    app.exit(process.exitCode || 0);
  }
});
