/**
 * Renders the chat choice menu in a real Electron window: options must be
 * clickable, the extra "Other" choice must reveal a free-form input, and the
 * composed reply must be what the composer would send.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");
const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(root, ".tmp-choice-ui-"));
const watchdog = setTimeout(() => { console.error("Choice UI test timed out"); app.exit(1); }, 45000);
app.setPath("userData", path.join(temp, "user-data"));
app.whenReady().then(async () => {
  let win;
  try {
    const entry = path.join(temp, "entry.tsx");
    fs.writeFileSync(entry, `import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChoicePrompt } from '../src/renderer/src/components/ChoicePrompt';
import { useStore } from '../src/renderer/src/store';
import { parseChoiceQuestions } from '../src/renderer/src/lib/choices';
window.testStore = useStore;
window.parseChoiceQuestions = parseChoiceQuestions;
const root = createRoot(document.getElementById('app'));
window.renderChoice = (questions) => root.render(<div className="msg assistant"><div className="msg-body"><ChoicePrompt threadId="qa" questions={questions} /></div></div>);
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
      `<html><head><meta charset="utf-8"><link rel="stylesheet" href="../src/renderer/src/styles.css"><style>body{padding:24px;background:var(--bg)}#app{max-width:860px;margin:auto}</style></head><body><div id="app"></div><script src="test.js"></script></body></html>`,
    );
    win = new BrowserWindow({ width: 1000, height: 780, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await win.loadFile(path.join(temp, "index.html"));

    const result = await win.webContents.executeJavaScript(`(${async function () {
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
      };

      const source = "**Questions/Choices**\n\n**Q1: 快速模式的抗锯齿用哪种方案?**\n\n**Details:** 两条路线都会把字形渲染从 MONO 单色改为灰阶抗锯齿。\n\n**Options:**\n\n1. **O1-1: 有序抖动（推荐）**。刷新仍走 DU 波形，速度完全不变。\n2. **O1-2: GRAY8 GL16 灰阶刷新**。边缘更平滑，但每页刷新约慢 50%。\n\n**Q2: 先做哪一个?**\n\n**Options:**\n\n1. **先做 O1-1**。风险最低。\n2. **先做 O1-2**。效果最好。";
      const parsed = window.parseChoiceQuestions(source);
      assert(parsed.questions.length === 2, "parser must find both questions");
      window.sent = null;
      window.testStore.setState({ config: { language: "zh" }, sendPrompt: async (threadId, text) => { window.sent = { threadId, text }; } });
      window.renderChoice(parsed.questions);
      await settle();

      const card = document.querySelector(".choice-card");
      assert(card, "choice card renders");
      assert(document.querySelectorAll(".choice-question").length === 2, "one block per question");
      const firstOptions = card.querySelectorAll(".choice-question")[0].querySelectorAll(".choice-option");
      assert(firstOptions.length === 3, "two proposals plus an Other option");
      assert(firstOptions[2].textContent.includes("其他（自定义方案）"), "Other is explicit");
      assert(card.textContent.includes("推荐"), "recommended option is tagged");
      assert(document.querySelector(".choice-card-actions button.primary").disabled, "send stays disabled until every question is answered");

      firstOptions[0].click();
      await settle();
      assert(firstOptions[0].getAttribute("aria-checked") === "true", "clicking an option selects it");
      assert(firstOptions[0].classList.contains("selected"), "selected option is styled");
      assert(document.querySelector(".choice-card-actions button.primary").disabled, "one answer is not enough");

      const secondOptions = card.querySelectorAll(".choice-question")[1].querySelectorAll(".choice-option");
      secondOptions[2].click();
      await settle();
      const custom = document.querySelector(".choice-custom-input");
      assert(custom, "Other reveals a custom input");
      assert(document.querySelector(".choice-card-actions button.primary").disabled, "empty custom answer cannot be sent");
      setValue(custom, "先做 O1-1，但把抖动矩阵换成 8×8");
      await settle();
      assert(!document.querySelector(".choice-card-actions button.primary").disabled, "custom answer enables send");

      document.querySelector(".choice-card-actions button.primary").click();
      await settle();
      assert(window.sent && window.sent.threadId === "qa", "reply is sent to the thread");
      const lines = window.sent.text.split("\n");
      assert(lines.length === 2, "one line per answered question: " + window.sent.text);
      assert(lines[0] === "Q1. 快速模式的抗锯齿用哪种方案? → O1-1: 有序抖动（推荐）", "option label is the answer: " + lines[0]);
      assert(lines[1].includes("8×8"), "custom plan text is the answer: " + lines[1]);
      assert(document.querySelector(".choice-sent"), "card confirms the choices were sent");
      return "Choice menu: 2 questions, 3 options each, recommended tag, custom Other, disabled/valid send states and reply composition passed.";
    }.toString()})()`);
    console.log(result);

    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(root, "qa-choice-menu.png"), image.toPNG());
    console.log("screenshot: qa-choice-menu.png");
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
