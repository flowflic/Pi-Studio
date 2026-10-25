/**
 * Pins the chat question parser: only explicit "Q<n>: ... / Options:" blocks
 * become menus, everything else stays Markdown. A false positive would turn
 * ordinary prose into buttons, so the negative cases matter as much as the
 * positive ones.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");

const api = {};
const source = ts.transpileModule(fs.readFileSync(path.join(root, "src/renderer/src/lib/choices.ts"), "utf8"), {
  compilerOptions: { target: 9, module: 1 },
}).outputText;
new Function("require", "exports", source)(require, api);

const zhBlock = `**Questions/Choices**

**Q1: 快速模式的抗锯齿用哪种方案?**

**Details:** 两条路线都会把快速模式的字形渲染从 MONO 单色改为灰阶抗锯齿。

**Options:**

1. **O1-1: 有序抖动（推荐）**。打包时用 4×4 Bayer 抖动矩阵，速度完全不变。
2. **O1-2: GRAY8 GL16 灰阶刷新**。边缘真正平滑无噪点，代价是每页慢约 50%。`;

const zh = api.parseChoiceQuestions(zhBlock);
assert.equal(zh.questions.length, 1, "one question detected");
assert.equal(zh.questions[0].title, "快速模式的抗锯齿用哪种方案?");
assert.match(zh.questions[0].details, /MONO 单色/);
assert.equal(zh.questions[0].details, "两条路线都会把快速模式的字形渲染从 MONO 单色改为灰阶抗锯齿。", "bold Details label leaves no markers behind");
assert.deepEqual(
  zh.questions[0].options.map((option) => option.label),
  ["O1-1: 有序抖动（推荐）", "O1-2: GRAY8 GL16 灰阶刷新"],
);
assert.equal(zh.questions[0].options[0].recommended, true);
assert.match(zh.questions[0].options[1].description, /平滑无噪点/);
assert.equal(zh.remainder, "**Questions/Choices**", "the heading survives, question lines are consumed");

const enBlock = `### Question 1: Which storage?

Details: pick one.

### Options

- **SQLite** — local, fast, single file.
- **Postgres** — shared, needs a server.

### Q2: How should I roll it out?

Options:
1. Behind a flag
2. All at once`;
const en = api.parseChoiceQuestions(enBlock);
assert.equal(en.questions.length, 2, "multiple questions detected");
assert.equal(en.questions[0].options.length, 2);
assert.equal(en.questions[0].options[0].label, "SQLite");
assert.match(en.questions[0].options[0].description, /local, fast/);
assert.equal(en.questions[1].options.length, 2, "unbolded numbered options parse");
assert.equal(en.remainder, "", "a message made only of questions has no remainder");

const prose = `Here are my notes.

Options:
1. Ship it
2. Wait

Nothing is being asked here.`;
const none = api.parseChoiceQuestions(prose);
assert.equal(none.questions.length, 0, "an Options: list without a question is prose");
assert.equal(none.remainder, prose, "unmatched text is returned unchanged");

const single = `**Q1: Pick one?**

**Options:**

1. Only choice`;
assert.equal(api.parseChoiceQuestions(single).questions.length, 0, "one option is not a choice");

assert.equal(api.parseChoiceQuestions("").questions.length, 0);
assert.equal(api.parseChoiceQuestions(undefined).questions.length, 0, "missing text never throws");

const reply = api.formatChoiceReply(zh.questions, { 0: { index: 0 } });
assert.equal(reply, "Q1. 快速模式的抗锯齿用哪种方案? → O1-1: 有序抖动（推荐）");
const custom = api.formatChoiceReply(zh.questions, { 0: { index: "other", text: "用 Scribe 灰度抖动" } });
assert.equal(custom, "Q1. 快速模式的抗锯齿用哪种方案? → 用 Scribe 灰度抖动", "custom plan replaces the option label");

console.log("Choice parser: Chinese/English blocks, multiple questions, custom replies, prose and single-option negatives passed.");
