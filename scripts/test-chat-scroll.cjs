const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const ts = require("typescript");

const watchdog = setTimeout(() => { console.error("Scroll test timed out"); app.exit(1); }, 20000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, offscreen: true } });
  try {
    await win.loadURL("about:blank");
    const source = readFileSync(join(__dirname, "../src/renderer/src/lib/chat-scroll.ts"), "utf8");
    const script = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS });
    await win.webContents.executeJavaScript(`var exports = {}; ${script}; void 0;`);
    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))));
      document.body.innerHTML = '<div id="viewport" style="height:300px;width:500px;overflow:auto;overflow-anchor:none"><div id="content"><div id="text" style="white-space:pre-wrap"></div></div></div>';
      const viewport = document.getElementById("viewport");
      const content = document.getElementById("content");
      const text = document.getElementById("text");
      const positions = new Map();
      const atBottom = () => Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) < 2;
      text.textContent = "Initial reply\n".repeat(60);
      let detach = exports.attachChatScroll(viewport, content, "a", positions);
      await settle();
      assert(atBottom(), "New transcript should open at the bottom");
      for (let i = 0; i < 4; i++) {
        text.textContent += "Streaming delta\n".repeat(40);
        await settle();
        assert(atBottom(), `Same text block must follow growth larger than 140px: ${viewport.scrollTop}/${viewport.scrollHeight}/${viewport.clientHeight}, iteration ${i}`);
      }
      viewport.scrollTop = 200;
      await settle();
      text.textContent += "More output\n".repeat(40);
      await settle();
      assert(Math.abs(viewport.scrollTop - 200) < 1, "Reading history must not be interrupted");
      viewport.scrollTop = viewport.scrollHeight;
      await settle();
      const delayed = document.createElement("div");
      content.append(delayed);
      delayed.style.height = "600px";
      await settle();
      assert(atBottom(), "Follow must resume and handle async content growth");
      viewport.style.height = "180px";
      await settle();
      assert(atBottom(), "Composer or viewport resize must preserve following");
      viewport.scrollTop = 300;
      await settle();
      detach();
      text.textContent = "Other thread\n".repeat(50);
      delayed.remove();
      detach = exports.attachChatScroll(viewport, content, "b", positions);
      await settle();
      viewport.scrollTop = 100;
      await settle();
      detach();
      text.textContent = "Returned thread\n".repeat(200);
      detach = exports.attachChatScroll(viewport, content, "a", positions);
      await settle();
      assert(Math.abs(viewport.scrollTop - 300) < 1, "Thread A history position must be restored");
      text.textContent += "More output\n".repeat(40);
      await settle();
      assert(Math.abs(viewport.scrollTop - 300) < 1, "Restore must remain stable during streaming");
      assert(Math.abs(positions.get("b") - 100) < 1, "Thread B position must stay independent");
      detach();
      return "Passed: long streaming text, history reading, resumed following, async growth, viewport resize and thread restoration.";
    }.toString()})()`);
    console.log(result);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    clearTimeout(watchdog);
    win.destroy();
    app.exit(process.exitCode || 0);
  }
});
