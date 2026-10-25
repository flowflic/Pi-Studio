/**
 * Release notes are the only part of an app update the user reads before
 * installing, so their normalization is pinned: a Markdown body is passed
 * through, versioned note arrays keep only the offered version, and oversized
 * bodies are bounded instead of being handed to the renderer whole.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

const api = {};
const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main/app-updater.ts"), "utf8"), {
  compilerOptions: { target: 9, module: 1 },
}).outputText;
new Function("require", "exports", source)(
  (name) => {
    if (name === "electron") return { app: { getVersion: () => "0.4.11", isPackaged: false } };
    if (name === "electron-updater") return { autoUpdater: { on() {}, downloadUpdate: async () => [], quitAndInstall() {} } };
    return require(name);
  },
  api,
);

const note = (version, body) => ({ version, note: body });

assert.equal(api.normalizeReleaseNotes({ version: "0.5.0" }), null, "no notes yields null");
assert.equal(api.normalizeReleaseNotes({ version: "0.5.0", releaseNotes: "   " }), null, "blank notes yield null");

const body = "## 更新内容\n\n- 内置 Pi 1.4.0\n- 修复额度\r\n";
assert.equal(
  api.normalizeReleaseNotes({ version: "v0.5.0", releaseNotes: body }),
  "## 更新内容\n\n- 内置 Pi 1.4.0\n- 修复额度",
  "Markdown body is normalized to LF and trimmed",
);

assert.equal(
  api.normalizeReleaseNotes({
    version: "0.5.0",
    releaseNotes: [note("0.4.9", "old"), note("v0.5.0", "new"), note("", "unversioned")],
  }),
  "new\n\nunversioned",
  "only the offered version (plus unversioned notes) is shown",
);

const long = "x".repeat(25000);
const capped = api.normalizeReleaseNotes({ version: "0.5.0", releaseNotes: long });
assert.ok(capped.length < 20100, "oversized notes are capped");
assert.ok(capped.endsWith("…"), "capped notes stay visibly truncated");

console.log("App update release notes: body passthrough/versioned arrays/blank handling/length cap passed.");
