const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/**
 * Native notification tests: prompt classification and copy, and the center's
 * focus gate, click-to-focus behaviour, and unsupported-platform fallback.
 * The Electron module is stubbed, so no real OS notification is shown.
 */
const root = path.resolve(__dirname, "..");

function load(name, dependencies = {}) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/main", name + ".ts"), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", source)((id) => dependencies[id] || require(id), exports);
  return exports;
}

let supported = true;
class FakeNotification {
  static instances = [];
  static isSupported() {
    return supported;
  }
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.shown = false;
    FakeNotification.instances.push(this);
  }
  once(event, callback) {
    this.handlers[event] = callback;
    return this;
  }
  show() {
    this.shown = true;
  }
}

const notifications = load("system-notifications", {
  electron: { BrowserWindow: class {}, Notification: FakeNotification },
});

const state = { focused: false, minimized: false, visible: true, destroyed: false, loading: false };
const calls = [];
const win = {
  isDestroyed: () => state.destroyed,
  isFocused: () => state.focused,
  isMinimized: () => state.minimized,
  isVisible: () => state.visible,
  restore: () => calls.push("restore"),
  show: () => calls.push("show"),
  focus: () => calls.push("focus"),
  webContents: {
    isLoading: () => state.loading,
    send: (channel, payload) => calls.push([channel, payload]),
    once: (event) => calls.push(event),
  },
};

function reset() {
  FakeNotification.instances = [];
  calls.length = 0;
  state.focused = false;
  state.minimized = false;
  state.visible = true;
  state.destroyed = false;
  state.loading = false;
  supported = true;
}

// --- prompt classification -------------------------------------------------
for (const method of ["select", "confirm", "input", "editor"]) {
  assert.equal(notifications.isBlockingPrompt({ method }), true, `${method} blocks the agent`);
}
for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text", ""]) {
  assert.equal(notifications.isBlockingPrompt({ method }), false, `${method} does not block`);
}
assert.equal(notifications.isBlockingPrompt(null), false);
assert.equal(notifications.isBlockingPrompt("select"), false);

// --- copy ------------------------------------------------------------------
const zhSelect = notifications.promptNotificationText(
  { method: "select", title: "选择部署环境\n第二行忽略", message: " 需要先选择  环境 " },
  "zh",
);
assert.equal(zhSelect.title, "Pi Studio · 需要你选择");
assert.equal(zhSelect.subtitle, "选择部署环境");
assert.equal(zhSelect.body, "需要先选择 环境");

const enConfirm = notifications.promptNotificationText({ method: "confirm", title: "Run rm -rf build?" }, "en");
assert.equal(enConfirm.title, "Pi Studio · Confirmation required");
assert.equal(enConfirm.body, "Click this notification to return to Pi Studio.");

const zhInput = notifications.promptNotificationText({ method: "input", options: ["Allow once", "Deny"] }, "zh");
assert.equal(zhInput.title, "Pi Studio · 需要你的输入");
assert.equal(zhInput.subtitle, undefined);
assert.equal(zhInput.body, "Allow once · Deny");

const longTitle = notifications.promptNotificationText({ method: "select", title: "x".repeat(120) }, "en").subtitle;
assert.equal(longTitle.length, 80);
assert.ok(longTitle.endsWith("…"));

const shotOptions = notifications.promptNotificationText({ method: "select", options: ["a", "b", "c", "d"] }, "en");
assert.equal(shotOptions.body, "a · b · c");

// --- center ----------------------------------------------------------------
reset();
const center = notifications.createSystemNotificationCenter(() => win);
state.focused = true;
center.notifyPrompt("t1", "zh", { method: "select", title: "选一个", message: "请选择" });
assert.equal(FakeNotification.instances.length, 0, "no banner while the window is focused");

state.focused = false;
center.notifyPrompt("t1", "zh", { method: "confirm", title: "允许执行？" });
assert.equal(FakeNotification.instances.length, 1);
const banner = FakeNotification.instances[0];
assert.equal(banner.shown, true);
assert.equal(banner.options.title, "Pi Studio · 需要确认");
assert.equal(banner.options.subtitle, "允许执行？");
assert.equal(banner.options.timeoutType, "never");
assert.equal(banner.options.silent, false);

state.minimized = true;
state.visible = false;
banner.handlers.click();
assert.deepEqual(calls, ["restore", "show", "focus", ["app:focus-thread", { threadId: "t1" }]]);

reset();
FakeNotification.instances = [];
center.notifyPrompt("t2", "en", { method: "input", title: "API key" });
state.loading = true;
FakeNotification.instances[0].handlers.click();
assert.deepEqual(calls, ["focus", "did-finish-load"], "waits for the window to finish loading");

reset();
center.notifyTaskComplete("t3", { language: "en", prompt: "Refactor", reply: "Done" });
assert.equal(FakeNotification.instances[0].options.title, "Pi Studio · Task completed");
assert.equal(FakeNotification.instances[0].options.timeoutType, "default");

reset();
center.notifySandboxApproval("t4", "en", "npm install");
assert.equal(FakeNotification.instances[0].options.title, "Pi Studio · Approval required");
assert.equal(FakeNotification.instances[0].options.timeoutType, "never");

reset();
supported = false;
center.notifyPrompt("t5", "en", { method: "select", title: "Choose" });
assert.equal(FakeNotification.instances.length, 0, "unsupported platforms are skipped");

reset();
state.destroyed = true;
center.notifyPrompt("t6", "en", { method: "select", title: "Choose" });
assert.equal(FakeNotification.instances.length, 1, "no window still allows the banner");

console.log("system notification tests passed");
